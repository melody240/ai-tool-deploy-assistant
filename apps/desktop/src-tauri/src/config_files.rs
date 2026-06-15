use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde_json::{Map, Value};

use crate::{
    error::{AppError, AppResult},
    models::{ConfigInput, ConfigPreview},
};

const START_MARKER: &str = "<!-- ai-tool-deploy-assistant:start -->";
const END_MARKER: &str = "<!-- ai-tool-deploy-assistant:end -->";

#[tauri::command]
pub fn preview_config(input: ConfigInput) -> AppResult<Vec<ConfigPreview>> {
    build_previews(&input)
}

#[tauri::command]
pub fn apply_config(input: ConfigInput) -> AppResult<Vec<ConfigPreview>> {
    let previews = build_previews(&input)?;
    for preview in &previews {
        if !preview.changed {
            continue;
        }
        let path = PathBuf::from(&preview.path);
        if path.exists() {
            let timestamp = Utc::now().format("%Y%m%d%H%M%S");
            let backup = path.with_extension(format!(
                "{}.backup-{timestamp}",
                path.extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("file")
            ));
            fs::copy(&path, backup)?;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        atomic_write(&path, preview.after.as_bytes())?;
    }
    Ok(previews)
}

fn build_previews(input: &ConfigInput) -> AppResult<Vec<ConfigPreview>> {
    let project = fs::canonicalize(&input.project_dir)
        .map_err(|_| AppError::Message("项目目录不存在或不可访问".to_string()))?;
    if !project.is_dir() {
        return Err(AppError::Message("选择的路径不是目录".to_string()));
    }
    validate_settings(&input.settings)?;
    validate_mcp(&input.mcp)?;

    let claude_path = project.join("CLAUDE.md");
    let settings_path = project.join(".claude").join("settings.json");
    let mcp_path = project.join(".mcp.json");

    let claude_before = read_optional(&claude_path)?;
    let claude_after = merge_claude_md(&claude_before, &input.claude_md);
    let settings_before = read_optional(&settings_path)?;
    let settings_after = merge_json_text(&settings_before, &input.settings)?;
    let mcp_before = read_optional(&mcp_path)?;
    let mcp_after = merge_json_text(&mcp_before, &input.mcp)?;

    Ok(vec![
        preview(claude_path, claude_before, claude_after),
        preview(settings_path, settings_before, settings_after),
        preview(mcp_path, mcp_before, mcp_after),
    ])
}

fn preview(path: PathBuf, before: String, after: String) -> ConfigPreview {
    ConfigPreview {
        path: path.to_string_lossy().into_owned(),
        changed: before != after,
        before,
        after,
    }
}

fn merge_claude_md(existing: &str, desired: &str) -> String {
    let managed = format!("{START_MARKER}\n{}\n{END_MARKER}", desired.trim());
    if let (Some(start), Some(end)) = (existing.find(START_MARKER), existing.find(END_MARKER)) {
        let end = end + END_MARKER.len();
        let mut output = existing.to_string();
        output.replace_range(start..end, &managed);
        return ensure_trailing_newline(output);
    }
    if existing.trim().is_empty() {
        ensure_trailing_newline(managed)
    } else {
        ensure_trailing_newline(format!("{}\n\n{}", existing.trim_end(), managed))
    }
}

fn merge_json_text(existing: &str, desired: &Value) -> AppResult<String> {
    let mut target = if existing.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(existing)?
    };
    if !target.is_object() || !desired.is_object() {
        return Err(AppError::Message(
            "配置文件根节点必须是 JSON 对象".to_string(),
        ));
    }
    deep_merge(&mut target, desired.clone());
    Ok(format!("{}\n", serde_json::to_string_pretty(&target)?))
}

fn deep_merge(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                deep_merge(target.entry(key).or_insert(Value::Null), value);
            }
        }
        (target, source) => *target = source,
    }
}

fn validate_settings(settings: &Value) -> AppResult<()> {
    if !settings.is_object() {
        return Err(AppError::UnsafeConfig(
            "settings.json 根节点必须是对象".to_string(),
        ));
    }
    let default_mode = settings
        .pointer("/permissions/defaultMode")
        .and_then(Value::as_str);
    if default_mode == Some("bypassPermissions") {
        return Err(AppError::UnsafeConfig(
            "不能通过向导启用 bypassPermissions".to_string(),
        ));
    }
    Ok(())
}

fn validate_mcp(mcp: &Value) -> AppResult<()> {
    if !mcp.is_object() {
        return Err(AppError::UnsafeConfig(
            ".mcp.json 根节点必须是对象".to_string(),
        ));
    }
    validate_env_placeholders(mcp)
}

fn validate_env_placeholders(value: &Value) -> AppResult<()> {
    if let Value::Object(object) = value {
        if let Some(Value::Object(environment)) = object.get("env") {
            for (name, value) in environment {
                let Some(text) = value.as_str() else {
                    return Err(AppError::UnsafeConfig(format!(
                        "MCP 环境变量 {name} 必须使用字符串占位符"
                    )));
                };
                if !(text.is_empty() || text.starts_with("${") && text.ends_with('}')) {
                    return Err(AppError::UnsafeConfig(format!(
                        "MCP 环境变量 {name} 只能使用 ${{变量名}} 占位符，不能写入真实密钥"
                    )));
                }
            }
        }
        for child in object.values() {
            validate_env_placeholders(child)?;
        }
    } else if let Value::Array(values) = value {
        for child in values {
            validate_env_placeholders(child)?;
        }
    }
    Ok(())
}

fn read_optional(path: &Path) -> AppResult<String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Message("配置路径无效".to_string()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn ensure_trailing_newline(mut value: String) -> String {
    if !value.ends_with('\n') {
        value.push('\n');
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_only_the_managed_claude_section() {
        let existing = "# User text\n\n<!-- ai-tool-deploy-assistant:start -->\nold\n<!-- ai-tool-deploy-assistant:end -->\n";
        let output = merge_claude_md(existing, "new");
        assert!(output.contains("# User text"));
        assert!(output.contains("\nnew\n"));
        assert!(!output.contains("\nold\n"));
    }

    #[test]
    fn rejects_permission_bypass() {
        let settings = serde_json::json!({
            "permissions": { "defaultMode": "bypassPermissions" }
        });
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn rejects_literal_mcp_secrets() {
        let mcp = serde_json::json!({
            "mcpServers": { "example": { "env": { "TOKEN": "secret" } } }
        });
        assert!(validate_mcp(&mcp).is_err());
    }
}
