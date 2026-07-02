use std::process::Command;

use crate::{
    error::{AppError, AppResult},
    installer::verified_source,
    license,
    system::resolve_product,
};

#[tauri::command]
pub async fn open_product_terminal(manifest_url: String, source_id: String) -> AppResult<()> {
    license::ensure_active()?;
    let source = verified_source(&manifest_url, &source_id).await?;
    let executable = resolve_product(&source.executable)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| source.executable.clone());
    let command = terminal_command(&executable, &source.terminal_args);
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\" to do script {}",
            apple_script_string(&command)
        );
        Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd.exe")
            .args(["/C", "start", "", "cmd.exe", "/K", &command])
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let terminal_command = format!("{command}; exec $SHELL");
        let candidates: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e", "sh", "-lc"]),
            ("gnome-terminal", &["--", "sh", "-lc"]),
            ("konsole", &["-e", "sh", "-lc"]),
        ];
        for (program, args) in candidates {
            if which::which(program).is_ok() {
                Command::new(program)
                    .args(*args)
                    .arg(&terminal_command)
                    .spawn()?;
                return Ok(());
            }
        }
        return Err(AppError::Message(format!(
            "未找到支持的终端模拟器，请手动打开终端并运行 {}",
            source.executable
        )));
    }
    #[allow(unreachable_code)]
    Err(AppError::Message("当前系统不支持自动打开终端".to_string()))
}

fn terminal_command(executable: &str, args: &[String]) -> String {
    #[cfg(target_os = "windows")]
    {
        let mut values = vec![windows_command_quote(executable)];
        values.extend(args.iter().map(|arg| windows_command_quote(arg)));
        values.join(" ")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut values = vec![shell_escape::escape(executable.into()).into_owned()];
        values.extend(
            args.iter()
                .map(|arg| shell_escape::escape(arg.into()).into_owned()),
        );
        values.join(" ")
    }
}

#[cfg(target_os = "windows")]
fn windows_command_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(target_os = "macos")]
fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
