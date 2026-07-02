use std::{
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use chrono::Utc;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;

use crate::{
    error::{AppError, AppResult},
    license,
    models::{
        DiagnosticResult, InstallProgress, InstallReceipt, ManifestSummary, ProductInstallOption,
        SignedEnvelope, SourceArtifact, SourceManifest,
    },
    security::{validate_remote_url, verify_envelope, MANIFEST_PUBLIC_KEY},
    system::{architecture, command_text, managed_bin_dir, os_version, platform, resolve_product},
};

const MAX_MANIFEST_BYTES: usize = 5 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[tauri::command]
pub async fn fetch_manifest_summary(manifest_url: String) -> AppResult<ManifestSummary> {
    license::ensure_active()?;
    let manifest = fetch_manifest(&manifest_url).await?;
    let current_os_version = os_version();
    let products = select_sources(&manifest, &current_os_version)
        .into_iter()
        .map(|selected| {
            let installed_path = resolve_product(&selected.executable);
            let installed_version = installed_path.as_ref().and_then(|path| {
                let args = selected
                    .version_args
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>();
                command_text(path, &args, Duration::from_secs(8)).ok()
            });
            ProductInstallOption {
                product_id: selected.product_id.clone(),
                product_name: selected.product_name.clone(),
                product_description: selected.product_description.clone(),
                homepage_url: selected.homepage_url.clone(),
                installed_path: installed_path.map(|path| path.to_string_lossy().into_owned()),
                installed_version,
                recommendation_reason: recommendation_reason(&selected, &current_os_version),
                selected,
            }
        })
        .collect();
    Ok(ManifestSummary {
        revision: manifest.revision,
        products,
    })
}

#[tauri::command]
pub async fn install_source(
    app: AppHandle,
    manifest_url: String,
    source_id: String,
) -> AppResult<String> {
    license::ensure_active()?;
    emit(
        &app,
        "manifest",
        3,
        "正在验证安装清单",
        Some(1),
        Some(4),
        Some("steps"),
    )?;
    let manifest = fetch_manifest(&manifest_url).await?;
    let current_os_version = os_version();
    let source = manifest
        .releases
        .into_iter()
        .find(|item| {
            item.id == source_id
                && item.enabled
                && item.platform == platform()
                && item.arch == architecture()
                && source_supports_os(item, &current_os_version)
        })
        .ok_or(AppError::SourceUnavailable)?;
    validate_source(&source)?;

    emit(
        &app,
        "download",
        6,
        "正在下载安装资源",
        Some(0),
        Some(source.size),
        Some("bytes"),
    )?;
    let temporary = tempfile::tempdir()?;
    let download_path = temporary.path().join(&source.file_name);
    download_verified(&app, &source, &download_path).await?;

    emit(
        &app,
        "install",
        84,
        "校验通过，正在安装",
        Some(3),
        Some(4),
        Some("steps"),
    )?;
    let message = install_verified_source(&source, &download_path)?;
    verify_managed_install(&source)?;
    emit(
        &app,
        "complete",
        100,
        &message,
        Some(4),
        Some(4),
        Some("steps"),
    )?;
    Ok(message)
}

#[tauri::command]
pub fn uninstall_managed(app: AppHandle, product_id: String) -> AppResult<String> {
    license::ensure_active()?;
    validate_product_id(&product_id)?;
    emit(
        &app,
        "uninstall",
        12,
        "正在核对本地安装记录",
        Some(1),
        Some(5),
        Some("steps"),
    )?;
    let path = receipt_path(&product_id)?;
    let receipt: InstallReceipt = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok("没有发现由助手管理的独立二进制安装".to_string())
        }
        Err(error) => return Err(error.into()),
    };
    validate_receipt(&product_id, &receipt)?;
    let message = match receipt.install_type.as_str() {
        "standalone_binary" | "archive_bundle" => {
            emit(
                &app,
                "uninstall",
                30,
                "正在移除启动入口",
                Some(2),
                Some(5),
                Some("steps"),
            )?;
            if let Some(binary_path) = &receipt.binary_path {
                let binary = PathBuf::from(binary_path);
                if binary.exists() || binary.is_symlink() {
                    fs::remove_file(binary)?;
                }
            }
            emit(
                &app,
                "uninstall",
                56,
                "正在移除已下载的工具文件",
                Some(3),
                Some(5),
                Some("steps"),
            )?;
            if let Some(install_dir) = &receipt.install_dir {
                let directory = PathBuf::from(install_dir);
                if directory.exists() {
                    if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
                        return Err(AppError::Verification(
                            "安装目录不能是符号链接".to_string(),
                        ));
                    }
                    fs::remove_dir_all(directory)?;
                }
            }
            format!("已卸载助手管理的 {}，用户配置已保留", receipt.product_name)
        }
        "script" => uninstall_script_product(&app, &receipt)?,
        "native_installer" => {
            return Err(AppError::Message(
                "该版本由系统安装器管理，部署助手无法安全确认其文件边界，请通过操作系统的软件管理功能卸载"
                    .to_string(),
            ))
        }
        _ => return Err(AppError::SourceUnavailable),
    };
    if managed_bin_dir()
        .read_dir()
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true)
    {
        if let Some(profile_path) = &receipt.profile_path {
            emit(
                &app,
                "uninstall",
                82,
                "正在清理终端环境入口",
                Some(4),
                Some(5),
                Some("steps"),
            )?;
            remove_path_marker(Path::new(profile_path))?;
        }
    }
    emit(
        &app,
        "uninstall",
        96,
        "正在清理部署记录",
        Some(5),
        Some(5),
        Some("steps"),
    )?;
    fs::remove_file(path)?;
    emit(
        &app,
        "uninstall",
        100,
        &message,
        Some(5),
        Some(5),
        Some("steps"),
    )?;
    Ok(message)
}

fn uninstall_script_product(app: &AppHandle, receipt: &InstallReceipt) -> AppResult<String> {
    match receipt.product_id.as_str() {
        "openclaw" => uninstall_openclaw_script(app, receipt),
        "hermes-agent" => uninstall_hermes_script(app, receipt),
        _ => Err(AppError::Message(format!(
            "{} 缺少经过验证的脚本卸载策略，未执行任何删除",
            receipt.product_name
        ))),
    }
}

fn uninstall_openclaw_script(app: &AppHandle, receipt: &InstallReceipt) -> AppResult<String> {
    let Some(executable) = resolve_product(&receipt.executable) else {
        return Ok("OpenClaw 已不存在，已清理部署助手中的安装记录".to_string());
    };
    let npm = which::which("npm")
        .map_err(|_| AppError::Message("未找到 npm，无法安全卸载 OpenClaw".to_string()))?;
    let npm_root_output = command_text(&npm, &["root", "-g"], Duration::from_secs(15))?;
    let npm_prefix_output = command_text(&npm, &["prefix", "-g"], Duration::from_secs(15))?;
    let npm_root = command_output_path(&npm_root_output)
        .ok_or_else(|| AppError::Verification("无法确认 npm 全局模块目录".to_string()))?;
    let npm_prefix = command_output_path(&npm_prefix_output)
        .ok_or_else(|| AppError::Verification("无法确认 npm 全局安装前缀".to_string()))?;
    let package_dir = npm_root.join("openclaw");
    if !npm_install_owns_executable(&executable, &package_dir, &npm_prefix, &receipt.executable) {
        return Err(AppError::Verification(format!(
            "检测到的 OpenClaw 不属于本次 npm 脚本安装：{}。为避免误删，已停止卸载",
            executable.display()
        )));
    }

    emit(
        app,
        "uninstall",
        34,
        "正在移除 OpenClaw 网关服务",
        Some(2),
        Some(5),
        Some("steps"),
    )?;
    // Remove only the gateway service. State, config, and workspaces are preserved.
    let _ = command_text(
        &executable,
        &["uninstall", "--service", "--yes", "--non-interactive"],
        Duration::from_secs(90),
    );
    emit(
        app,
        "uninstall",
        66,
        "正在卸载 OpenClaw 程序包",
        Some(3),
        Some(5),
        Some("steps"),
    )?;
    command_text(
        &npm,
        &["uninstall", "-g", "openclaw"],
        Duration::from_secs(5 * 60),
    )?;

    if package_dir.exists() {
        return Err(AppError::Verification(
            "npm 已返回成功，但 OpenClaw 包目录仍然存在".to_string(),
        ));
    }
    Ok("已卸载 OpenClaw 及其网关服务，配置、状态和工作区已保留".to_string())
}

fn uninstall_hermes_script(app: &AppHandle, receipt: &InstallReceipt) -> AppResult<String> {
    let Some(executable) = resolve_product(&receipt.executable) else {
        return Ok("Hermes Agent 已不存在，已清理部署助手中的安装记录".to_string());
    };
    emit(
        app,
        "uninstall",
        38,
        "正在执行 Hermes 官方卸载命令",
        Some(2),
        Some(5),
        Some("steps"),
    )?;
    command_text(
        &executable,
        &["uninstall", "--yes"],
        Duration::from_secs(5 * 60),
    )?;
    emit(
        app,
        "uninstall",
        68,
        "正在确认 Hermes 启动入口已移除",
        Some(3),
        Some(5),
        Some("steps"),
    )?;
    if executable.exists() || executable.is_symlink() {
        return Err(AppError::Verification(
            "Hermes 卸载命令已结束，但启动入口仍然存在".to_string(),
        ));
    }
    Ok("已卸载 Hermes Agent，配置、会话和日志已保留".to_string())
}

fn command_output_path(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_absolute())
}

fn npm_install_owns_executable(
    executable: &Path,
    package_dir: &Path,
    npm_prefix: &Path,
    executable_name: &str,
) -> bool {
    if !package_dir.exists() {
        return false;
    }
    let canonical_package = package_dir
        .canonicalize()
        .unwrap_or_else(|_| package_dir.to_path_buf());
    let canonical_executable = executable
        .canonicalize()
        .unwrap_or_else(|_| executable.to_path_buf());
    if canonical_executable.starts_with(&canonical_package) {
        return true;
    }

    let valid_names = [
        executable_name.to_string(),
        format!("{executable_name}.cmd"),
        format!("{executable_name}.exe"),
        format!("{executable_name}.ps1"),
    ];
    let executable_name_matches = executable
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| valid_names.iter().any(|name| name == value));
    let parent = executable.parent();
    executable_name_matches
        && (parent == Some(npm_prefix) || parent == Some(npm_prefix.join("bin").as_path()))
}

#[tauri::command]
pub fn run_product_diagnostics(product_id: String) -> AppResult<Vec<DiagnosticResult>> {
    license::ensure_active()?;
    let (product_name, executable, doctor_args) = diagnostic_spec(&product_id)?;
    let mut results = vec![DiagnosticResult {
        name: "系统兼容性".to_string(),
        status: if platform() == "unsupported" || architecture() == "unsupported" {
            "error"
        } else {
            "ok"
        }
        .to_string(),
        summary: format!("{} / {}", platform(), architecture()),
        details: None,
    }];
    let Some(path) = resolve_product(executable) else {
        results.push(DiagnosticResult {
            name: format!("{product_name} 路径"),
            status: "error".to_string(),
            summary: format!("未找到 {executable}"),
            details: None,
        });
        return Ok(results);
    };
    results.push(DiagnosticResult {
        name: format!("{product_name} 路径"),
        status: "ok".to_string(),
        summary: path.to_string_lossy().into_owned(),
        details: None,
    });
    if !doctor_args.is_empty() {
        match command_text(&path, doctor_args, Duration::from_secs(15)) {
            Ok(output) => results.push(DiagnosticResult {
                name: format!("{executable} doctor"),
                status: "ok".to_string(),
                summary: "诊断命令执行完成".to_string(),
                details: Some(output.chars().take(8_000).collect()),
            }),
            Err(error) => {
                let message = error.to_string();
                let timed_out = message.contains("执行超时");
                results.push(DiagnosticResult {
                    name: format!("{executable} doctor"),
                    status: "warning".to_string(),
                    summary: if timed_out {
                        "诊断命令等待超时".to_string()
                    } else {
                        "诊断命令未成功完成".to_string()
                    },
                    details: Some(if timed_out {
                        "该命令可能正在等待登录、授权或网络响应；这不代表工具安装失败。".to_string()
                    } else {
                        message
                    }),
                })
            }
        }
    }
    Ok(results)
}

fn diagnostic_spec(
    product_id: &str,
) -> AppResult<(&'static str, &'static str, &'static [&'static str])> {
    match product_id {
        "claude-code" => Ok(("Claude Code", "claude", &["doctor"])),
        "openclaw" => Ok(("OpenClaw", "openclaw", &["doctor"])),
        "hermes-agent" => Ok(("Hermes Agent", "hermes", &[])),
        _ => Err(AppError::Verification("未知产品，无法运行诊断".to_string())),
    }
}

async fn fetch_manifest(manifest_url: &str) -> AppResult<SourceManifest> {
    let url = validate_remote_url(manifest_url)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    if response.content_length().unwrap_or(0) > MAX_MANIFEST_BYTES as u64 {
        return Err(AppError::Verification("清单文件过大".to_string()));
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(AppError::Verification("清单文件过大".to_string()));
    }
    let envelope: SignedEnvelope = serde_json::from_slice(&bytes)?;
    let manifest: SourceManifest = verify_envelope(&envelope, MANIFEST_PUBLIC_KEY)?;
    if manifest.schema_version != 3 {
        return Err(AppError::Verification("不支持的清单版本".to_string()));
    }
    accept_manifest_revision(manifest.revision)?;
    Ok(manifest)
}

fn accept_manifest_revision(revision: u64) -> AppResult<()> {
    accept_manifest_revision_at(&managed_data_dir().join("manifest-revision"), revision)
}

fn accept_manifest_revision_at(path: &Path, revision: u64) -> AppResult<()> {
    let highest = fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if revision < highest {
        return Err(AppError::Verification(format!(
            "拒绝旧版安装清单：已见版本 {highest}，收到版本 {revision}"
        )));
    }
    if revision == highest {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Message("清单版本记录路径无效".to_string()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    writeln!(temporary, "{revision}")?;
    temporary.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary
        .persist(path)
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn select_sources(manifest: &SourceManifest, current_os_version: &str) -> Vec<SourceArtifact> {
    let mut product_ids = manifest
        .releases
        .iter()
        .filter(|source| {
            source.enabled
                && source.platform == platform()
                && source.arch == architecture()
                && source_supports_os(source, current_os_version)
        })
        .map(|source| source.product_id.clone())
        .collect::<Vec<_>>();
    product_ids.sort();
    product_ids.dedup();
    product_ids
        .into_iter()
        .filter_map(|product_id| {
            let target_key = format!("{}:{}:{}", product_id, platform(), architecture());
            manifest
                .active_release_ids
                .get(&target_key)
                .and_then(|active| {
                    manifest.releases.iter().find(|source| {
                        &source.id == active
                            && source.enabled
                            && source.product_id == product_id
                            && source.platform == platform()
                            && source.arch == architecture()
                            && source_supports_os(source, current_os_version)
                    })
                })
                .or_else(|| {
                    manifest
                        .releases
                        .iter()
                        .filter(|source| {
                            source.enabled
                                && source.product_id == product_id
                                && source.platform == platform()
                                && source.arch == architecture()
                                && source_supports_os(source, current_os_version)
                        })
                        .max_by(|left, right| left.published_at.cmp(&right.published_at))
                })
                .cloned()
        })
        .collect()
}

fn validate_source(source: &SourceArtifact) -> AppResult<()> {
    validate_remote_url(&source.url)?;
    if source.sha256.len() != 64 || !source.sha256.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err(AppError::Verification("SHA-256 格式错误".to_string()));
    }
    if Path::new(&source.file_name).file_name() != Some(OsStr::new(&source.file_name)) {
        return Err(AppError::Verification("安装文件名包含非法路径".to_string()));
    }
    validate_product_id(&source.product_id)?;
    if let Some(minimum) = &source.min_os_version {
        parse_os_version(minimum)
            .ok_or_else(|| AppError::Verification("最低系统版本格式错误".to_string()))?;
    }
    if source.executable.contains(['/', '\\'])
        || source.executable == "."
        || source.executable == ".."
    {
        return Err(AppError::Verification("可执行文件名不安全".to_string()));
    }
    match source.install_type.as_str() {
        "standalone_binary" | "native_installer" | "script" | "archive_bundle" => {}
        _ => return Err(AppError::Verification("未知安装类型".to_string())),
    }
    if source.install_type == "script" && source.script_interpreter.is_none() {
        return Err(AppError::Verification("脚本来源缺少固定解释器".to_string()));
    }
    if source.install_type == "archive_bundle" {
        let archive_format = source
            .archive_format
            .as_deref()
            .ok_or_else(|| AppError::Verification("离线包缺少归档格式".to_string()))?;
        let executable_path = source
            .archive_executable_path
            .as_deref()
            .ok_or_else(|| AppError::Verification("离线包缺少入口路径".to_string()))?;
        safe_archive_relative_path(executable_path)?;
        match (source.platform.as_str(), archive_format) {
            ("windows", "zip") | ("macos", "tar_gz") | ("linux", "zip" | "tar_gz") => {}
            _ => {
                return Err(AppError::Verification(
                    "离线包格式与目标系统不兼容".to_string(),
                ))
            }
        }
    } else if source.archive_format.is_some() || source.archive_executable_path.is_some() {
        return Err(AppError::Verification(
            "非离线包来源包含归档元数据".to_string(),
        ));
    }
    Ok(())
}

async fn download_verified(
    app: &AppHandle,
    source: &SourceArtifact,
    destination: &Path,
) -> AppResult<()> {
    let url = validate_remote_url(&source.url)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    if let Some(content_length) = response.content_length() {
        if content_length != source.size {
            return Err(AppError::Verification(format!(
                "服务端文件大小与清单不一致：期望 {}，实际 {}",
                source.size, content_length
            )));
        }
    }
    let mut file = fs::File::create(destination)?;
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| AppError::Verification("文件大小溢出".to_string()))?;
        if received > source.size {
            return Err(AppError::Verification(
                "下载文件超过清单声明大小".to_string(),
            ));
        }
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        let percent = received
            .saturating_mul(74)
            .checked_div(source.size)
            .map(|value| 6 + value.min(74) as u8)
            .unwrap_or(80);
        emit(
            app,
            "download",
            percent,
            "正在下载安装资源",
            Some(received),
            Some(source.size),
            Some("bytes"),
        )?;
    }
    file.sync_all()?;
    if received != source.size {
        let _ = fs::remove_file(destination);
        return Err(AppError::Verification(format!(
            "下载不完整：期望 {} 字节，实际 {} 字节",
            source.size, received
        )));
    }
    let digest = hex::encode(hasher.finalize());
    if !digest.eq_ignore_ascii_case(&source.sha256) {
        let _ = fs::remove_file(destination);
        return Err(AppError::Verification(
            "SHA-256 不匹配，文件已删除".to_string(),
        ));
    }
    Ok(())
}

fn install_verified_source(source: &SourceArtifact, download_path: &Path) -> AppResult<String> {
    match source.install_type.as_str() {
        "standalone_binary" => install_standalone(source, download_path),
        "native_installer" => install_native(source, download_path),
        "script" => install_script(source, download_path),
        "archive_bundle" => install_archive_bundle(source, download_path),
        _ => Err(AppError::SourceUnavailable),
    }
}

fn verify_managed_install(source: &SourceArtifact) -> AppResult<()> {
    if !matches!(
        source.install_type.as_str(),
        "standalone_binary" | "archive_bundle"
    ) {
        return Ok(());
    }
    let executable = resolve_product(&source.executable).ok_or_else(|| {
        AppError::Command(format!(
            "安装文件已写入，但未找到 {} 的启动入口",
            source.product_name
        ))
    })?;
    if !source.version_args.is_empty() {
        let args = source
            .version_args
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        command_text(&executable, &args, Duration::from_secs(15)).map_err(|error| {
            AppError::Command(format!(
                "{} 已安装，但版本验证失败：{error}",
                source.product_name
            ))
        })?;
    }
    Ok(())
}

fn install_standalone(source: &SourceArtifact, download_path: &Path) -> AppResult<String> {
    let directory = managed_bin_dir();
    fs::create_dir_all(&directory)?;
    let binary = directory.join(if cfg!(windows) && !source.executable.ends_with(".exe") {
        format!("{}.exe", source.executable)
    } else {
        source.executable.clone()
    });
    fs::copy(download_path, &binary)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))?;
    }
    let profile_path = ensure_managed_bin_on_path(&directory)?;
    write_receipt(&InstallReceipt {
        product_id: source.product_id.clone(),
        product_name: source.product_name.clone(),
        executable: source.executable.clone(),
        install_type: source.install_type.clone(),
        binary_path: Some(binary.to_string_lossy().into_owned()),
        install_dir: None,
        profile_path: profile_path.map(|path| path.to_string_lossy().into_owned()),
        installed_at: Utc::now().to_rfc3339(),
        source_id: source.id.clone(),
    })?;
    Ok(format!(
        "{} 安装完成。新终端会自动加载工具路径",
        source.product_name
    ))
}

fn install_native(source: &SourceArtifact, download_path: &Path) -> AppResult<String> {
    let extension = download_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (program, mut args): (OsString, Vec<OsString>) = match (platform(), extension.as_str()) {
        ("windows", "msi") => (
            OsString::from("msiexec.exe"),
            vec![OsString::from("/i"), download_path.as_os_str().to_owned()],
        ),
        ("windows", "exe") => (download_path.as_os_str().to_owned(), Vec::new()),
        ("macos", "pkg") => (
            OsString::from("/usr/sbin/installer"),
            vec![
                OsString::from("-pkg"),
                download_path.as_os_str().to_owned(),
                OsString::from("-target"),
                OsString::from("CurrentUserHomeDirectory"),
            ],
        ),
        ("linux", "deb") => (
            OsString::from("dpkg"),
            vec![OsString::from("-i"), download_path.as_os_str().to_owned()],
        ),
        ("linux", "rpm") => (
            OsString::from("rpm"),
            vec![OsString::from("-U"), download_path.as_os_str().to_owned()],
        ),
        _ => {
            return Err(AppError::Message(format!(
                "当前系统不支持 .{extension} 原生安装包"
            )))
        }
    };
    args.extend(source.args.iter().map(OsString::from));
    run_installer(&program, &args, source.requires_elevation)?;
    write_receipt(&InstallReceipt {
        product_id: source.product_id.clone(),
        product_name: source.product_name.clone(),
        executable: source.executable.clone(),
        install_type: source.install_type.clone(),
        binary_path: None,
        install_dir: None,
        profile_path: None,
        installed_at: Utc::now().to_rfc3339(),
        source_id: source.id.clone(),
    })?;
    Ok("系统安装器执行完成。若系统仍在处理安装，请稍候再运行诊断".to_string())
}

fn install_script(source: &SourceArtifact, download_path: &Path) -> AppResult<String> {
    let interpreter = source
        .script_interpreter
        .as_deref()
        .ok_or_else(|| AppError::Verification("脚本解释器缺失".to_string()))?;
    let (program, mut args): (OsString, Vec<OsString>) = match (platform(), interpreter) {
        ("windows", "powershell") => (
            OsString::from("powershell.exe"),
            vec![
                OsString::from("-NoProfile"),
                OsString::from("-ExecutionPolicy"),
                OsString::from("RemoteSigned"),
                OsString::from("-File"),
                download_path.as_os_str().to_owned(),
            ],
        ),
        ("windows", "cmd") => (
            OsString::from("cmd.exe"),
            vec![OsString::from("/C"), download_path.as_os_str().to_owned()],
        ),
        ("macos" | "linux", "bash") => (
            OsString::from("/bin/bash"),
            vec![download_path.as_os_str().to_owned()],
        ),
        ("macos" | "linux", "sh") => (
            OsString::from("/bin/sh"),
            vec![download_path.as_os_str().to_owned()],
        ),
        _ => {
            return Err(AppError::Verification(
                "脚本解释器与当前系统不兼容".to_string(),
            ))
        }
    };
    args.extend(source.args.iter().map(OsString::from));
    run_installer(&program, &args, source.requires_elevation)?;
    write_receipt(&InstallReceipt {
        product_id: source.product_id.clone(),
        product_name: source.product_name.clone(),
        executable: source.executable.clone(),
        install_type: source.install_type.clone(),
        binary_path: None,
        install_dir: None,
        profile_path: None,
        installed_at: Utc::now().to_rfc3339(),
        source_id: source.id.clone(),
    })?;
    Ok("签名脚本执行完成，请运行诊断确认安装状态".to_string())
}

fn install_archive_bundle(source: &SourceArtifact, download_path: &Path) -> AppResult<String> {
    let archive_format = source
        .archive_format
        .as_deref()
        .ok_or_else(|| AppError::Verification("离线包缺少归档格式".to_string()))?;
    let executable_relative = safe_archive_relative_path(
        source
            .archive_executable_path
            .as_deref()
            .ok_or_else(|| AppError::Verification("离线包缺少入口路径".to_string()))?,
    )?;
    let bundles_root = managed_data_dir().join("bundles");
    fs::create_dir_all(&bundles_root)?;
    let staging = bundles_root.join(format!(".{}-{}", source.product_id, uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let extract_result = match archive_format {
        "zip" => extract_zip(download_path, &staging),
        "tar_gz" => extract_tar_gz(download_path, &staging),
        _ => Err(AppError::Verification("不支持的离线包归档格式".to_string())),
    };
    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let staged_executable = staging.join(&executable_relative);
    if !staged_executable.is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err(AppError::Verification(format!(
            "离线包内未找到入口文件：{}",
            executable_relative.to_string_lossy()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged_executable, fs::Permissions::from_mode(0o755))?;
    }

    let install_dir = bundles_root.join(&source.product_id);
    let backup = bundles_root.join(format!(
        ".{}-backup-{}",
        source.product_id,
        uuid::Uuid::new_v4()
    ));
    if install_dir.exists() {
        fs::rename(&install_dir, &backup)?;
    }
    if let Err(error) = fs::rename(&staging, &install_dir) {
        if backup.exists() {
            let _ = fs::rename(&backup, &install_dir);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(error.into());
    }

    let executable = install_dir.join(&executable_relative);
    let launcher_result = create_archive_launcher(&source.executable, &executable);
    let launcher = match launcher_result {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(&install_dir);
            if backup.exists() {
                let _ = fs::rename(&backup, &install_dir);
            }
            return Err(error);
        }
    };
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    let profile_path = ensure_managed_bin_on_path(&managed_bin_dir())?;
    write_receipt(&InstallReceipt {
        product_id: source.product_id.clone(),
        product_name: source.product_name.clone(),
        executable: source.executable.clone(),
        install_type: source.install_type.clone(),
        binary_path: Some(launcher.to_string_lossy().into_owned()),
        install_dir: Some(install_dir.to_string_lossy().into_owned()),
        profile_path: profile_path.map(|path| path.to_string_lossy().into_owned()),
        installed_at: Utc::now().to_rfc3339(),
        source_id: source.id.clone(),
    })?;
    Ok(format!(
        "{} 离线包安装完成。安装过程未访问产品官网",
        source.product_name
    ))
}

fn extract_zip(archive_path: &Path, destination: &Path) -> AppResult<()> {
    let file = fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::Verification(format!("ZIP 格式错误：{error}")))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::Verification("ZIP 文件条目过多".to_string()));
    }
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::Verification(format!("ZIP 条目错误：{error}")))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::Verification("ZIP 包含非法路径".to_string()))?
            .to_path_buf();
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(AppError::Verification(
                    "ZIP 包含不允许的符号链接".to_string(),
                ));
            }
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| AppError::Verification("解压大小溢出".to_string()))?;
        if total_size > MAX_EXTRACTED_BYTES {
            return Err(AppError::Verification(
                "离线包解压后超过 8 GB 限制".to_string(),
            ));
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(output)?;
            continue;
        }
        if !entry.is_file() {
            return Err(AppError::Verification(
                "ZIP 包含不支持的条目类型".to_string(),
            ));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output_file = fs::File::create(output)?;
        std::io::copy(&mut entry, &mut output_file)?;
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> AppResult<()> {
    let file = fs::File::open(archive_path)?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut entry_count = 0_usize;
    let mut total_size = 0_u64;
    for entry in archive
        .entries()
        .map_err(|error| AppError::Verification(format!("TAR 格式错误：{error}")))?
    {
        let mut entry =
            entry.map_err(|error| AppError::Verification(format!("TAR 条目错误：{error}")))?;
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(AppError::Verification("TAR 文件条目过多".to_string()));
        }
        let entry_type = entry.header().entry_type();
        if !(entry_type.is_file() || entry_type.is_dir()) {
            return Err(AppError::Verification(
                "TAR 包含不允许的链接或设备条目".to_string(),
            ));
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| AppError::Verification("解压大小溢出".to_string()))?;
        if total_size > MAX_EXTRACTED_BYTES {
            return Err(AppError::Verification(
                "离线包解压后超过 8 GB 限制".to_string(),
            ));
        }
        let unpacked = entry
            .unpack_in(destination)
            .map_err(|error| AppError::Verification(format!("TAR 解压失败：{error}")))?;
        if !unpacked {
            return Err(AppError::Verification("TAR 包含越界路径".to_string()));
        }
    }
    Ok(())
}

fn safe_archive_relative_path(value: &str) -> AppResult<PathBuf> {
    if value.is_empty()
        || value.contains('\\')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(AppError::Verification(
            "归档入口必须使用安全的相对路径".to_string(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(AppError::Verification("归档入口包含非法路径".to_string()));
    }
    Ok(path.to_path_buf())
}

fn managed_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ai-tool-deploy-assistant")
}

fn validate_receipt(product_id: &str, receipt: &InstallReceipt) -> AppResult<()> {
    let home = dirs::home_dir();
    validate_receipt_at(product_id, receipt, &managed_data_dir(), home.as_deref())
}

fn validate_receipt_at(
    product_id: &str,
    receipt: &InstallReceipt,
    data_root: &Path,
    home: Option<&Path>,
) -> AppResult<()> {
    if receipt.product_id != product_id {
        return Err(AppError::Verification(
            "安装收据的产品标识不匹配".to_string(),
        ));
    }
    validate_product_id(&receipt.product_id)?;
    if receipt.executable.is_empty()
        || receipt.executable.len() > 80
        || !receipt
            .executable
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
    {
        return Err(AppError::Verification(
            "安装收据的入口名称不安全".to_string(),
        ));
    }

    if let Some(binary_path) = receipt.binary_path.as_deref() {
        let binary = Path::new(binary_path);
        let expected_parent = data_root.join("bin");
        let valid_names = [
            receipt.executable.clone(),
            format!("{}.exe", receipt.executable),
            format!("{}.cmd", receipt.executable),
        ];
        let valid_name = binary
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| valid_names.iter().any(|name| name == value));
        if binary.parent() != Some(expected_parent.as_path()) || !valid_name {
            return Err(AppError::Verification(
                "安装收据中的启动器路径不属于本助手".to_string(),
            ));
        }
    }

    if let Some(install_dir) = receipt.install_dir.as_deref() {
        let expected = data_root.join("bundles").join(product_id);
        if Path::new(install_dir) != expected {
            return Err(AppError::Verification(
                "安装收据中的目录不属于本助手".to_string(),
            ));
        }
    }

    if let Some(profile_path) = receipt.profile_path.as_deref() {
        let Some(home) = home else {
            return Err(AppError::Verification(
                "无法验证 shell 配置文件路径".to_string(),
            ));
        };
        let profile = Path::new(profile_path);
        if profile != home.join(".zshrc") && profile != home.join(".bashrc") {
            return Err(AppError::Verification(
                "安装收据中的 shell 配置路径不安全".to_string(),
            ));
        }
    }

    Ok(())
}

#[cfg(unix)]
fn create_archive_launcher(executable_name: &str, target: &Path) -> AppResult<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let directory = managed_bin_dir();
    fs::create_dir_all(&directory)?;
    let launcher = directory.join(executable_name);
    if launcher.exists() || launcher.is_symlink() {
        fs::remove_file(&launcher)?;
    }
    let target = shell_escape::escape(target.to_string_lossy()).into_owned();
    fs::write(&launcher, format!("#!/bin/sh\nexec {target} \"$@\"\n"))?;
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))?;
    Ok(launcher)
}

#[cfg(windows)]
fn create_archive_launcher(executable_name: &str, target: &Path) -> AppResult<PathBuf> {
    let directory = managed_bin_dir();
    fs::create_dir_all(&directory)?;
    let launcher = directory.join(format!("{executable_name}.cmd"));
    let escaped_target = target.to_string_lossy().replace('%', "%%");
    fs::write(
        &launcher,
        format!("@echo off\r\ncall \"{escaped_target}\" %*\r\n"),
    )?;
    Ok(launcher)
}

fn run_installer(program: &OsStr, args: &[OsString], elevated: bool) -> AppResult<()> {
    if elevated {
        return run_elevated(program, args);
    }
    run_command(program, args, Duration::from_secs(15 * 60))
}

fn run_command(program: &OsStr, args: &[OsString], timeout: Duration) -> AppResult<()> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    match child.wait_timeout(timeout)? {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(AppError::Command(format!("安装器退出状态：{status}"))),
        None => {
            child.kill()?;
            let _ = child.wait();
            Err(AppError::Command("安装命令执行超时".to_string()))
        }
    }
}

#[cfg(target_os = "linux")]
fn run_elevated(program: &OsStr, args: &[OsString]) -> AppResult<()> {
    let mut elevated_args = vec![program.to_owned()];
    elevated_args.extend_from_slice(args);
    run_command(
        OsStr::new("pkexec"),
        &elevated_args,
        Duration::from_secs(15 * 60),
    )
}

#[cfg(target_os = "macos")]
fn run_elevated(program: &OsStr, args: &[OsString]) -> AppResult<()> {
    let mut pieces = vec![shell_escape::escape(program.to_string_lossy())];
    pieces.extend(
        args.iter()
            .map(|arg| shell_escape::escape(arg.to_string_lossy())),
    );
    let shell_command = pieces
        .into_iter()
        .map(|piece| piece.into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "do shell script {} with administrator privileges",
        apple_script_string(&shell_command)
    );
    run_command(
        OsStr::new("/usr/bin/osascript"),
        &[OsString::from("-e"), OsString::from(script)],
        Duration::from_secs(15 * 60),
    )
}

#[cfg(target_os = "windows")]
fn run_elevated(program: &OsStr, args: &[OsString]) -> AppResult<()> {
    let program = powershell_quote(&program.to_string_lossy());
    let argument_list = args
        .iter()
        .map(|arg| powershell_quote(&arg.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$p=Start-Process -FilePath {program} -ArgumentList @({argument_list}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    );
    run_command(
        OsStr::new("powershell.exe"),
        &[
            OsString::from("-NoProfile"),
            OsString::from("-Command"),
            OsString::from(script),
        ],
        Duration::from_secs(15 * 60),
    )
}

fn ensure_managed_bin_on_path(directory: &Path) -> AppResult<Option<PathBuf>> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let environment = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            "Environment",
            winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
        )?;
        let current: String = environment.get_value("Path").unwrap_or_default();
        let directory_text = directory.to_string_lossy();
        if !current
            .split(';')
            .any(|part| part.eq_ignore_ascii_case(&directory_text))
        {
            let updated = if current.trim().is_empty() {
                directory_text.into_owned()
            } else {
                format!("{current};{directory_text}")
            };
            environment.set_value("Path", &updated)?;
        }
        return Ok(None);
    }
    #[cfg(unix)]
    {
        let home =
            dirs::home_dir().ok_or_else(|| AppError::Message("无法确定用户主目录".to_string()))?;
        let shell = std::env::var("SHELL").unwrap_or_default();
        let profile = if shell.ends_with("zsh") {
            home.join(".zshrc")
        } else {
            home.join(".bashrc")
        };
        let mut content = fs::read_to_string(&profile).unwrap_or_default();
        if !content.contains("# ai-tool-deploy-assistant:path:start") {
            content.push_str(&format!(
                "\n# ai-tool-deploy-assistant:path:start\nexport PATH=\"{}:$PATH\"\n# ai-tool-deploy-assistant:path:end\n",
                directory.to_string_lossy()
            ));
            fs::write(&profile, content)?;
        }
        Ok(Some(profile))
    }
}

fn remove_path_marker(profile: &Path) -> AppResult<()> {
    if !profile.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(profile)?;
    let start_marker = "# ai-tool-deploy-assistant:path:start";
    let end_marker = "# ai-tool-deploy-assistant:path:end";
    if let (Some(start), Some(end)) = (content.find(start_marker), content.find(end_marker)) {
        let end = end + end_marker.len();
        let mut updated = content;
        updated.replace_range(start..end, "");
        fs::write(profile, updated)?;
    }
    Ok(())
}

fn receipt_path(product_id: &str) -> AppResult<PathBuf> {
    let directory = dirs::data_local_dir()
        .ok_or_else(|| AppError::Message("无法确定应用数据目录".to_string()))?
        .join("ai-tool-deploy-assistant");
    fs::create_dir_all(&directory)?;
    let receipts = directory.join("receipts");
    fs::create_dir_all(&receipts)?;
    Ok(receipts.join(format!("{product_id}.json")))
}

fn write_receipt(receipt: &InstallReceipt) -> AppResult<()> {
    fs::write(
        receipt_path(&receipt.product_id)?,
        serde_json::to_vec_pretty(receipt)?,
    )?;
    Ok(())
}

pub(crate) async fn verified_source(
    manifest_url: &str,
    source_id: &str,
) -> AppResult<SourceArtifact> {
    let current_os_version = os_version();
    let source = fetch_manifest(manifest_url)
        .await?
        .releases
        .into_iter()
        .find(|source| {
            source.id == source_id
                && source.enabled
                && source.platform == platform()
                && source.arch == architecture()
                && source_supports_os(source, &current_os_version)
        })
        .ok_or(AppError::SourceUnavailable)?;
    validate_source(&source)?;
    Ok(source)
}

fn recommendation_reason(source: &SourceArtifact, current_os_version: &str) -> String {
    let architecture_label = match architecture() {
        "aarch64" => "ARM64",
        "x86_64" => "x64",
        value => value,
    };
    let platform_label = match platform() {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        value => value,
    };
    let requirement = source
        .min_os_version
        .as_deref()
        .map(|minimum| format!("，满足最低 {platform_label} {minimum}"))
        .unwrap_or_default();
    format!("已检测 {platform_label} {current_os_version} / {architecture_label}{requirement}")
}

fn source_supports_os(source: &SourceArtifact, current_os_version: &str) -> bool {
    let Some(minimum) = source.min_os_version.as_deref() else {
        return true;
    };
    let Some(current) = parse_os_version(current_os_version) else {
        return false;
    };
    let Some(required) = parse_os_version(minimum) else {
        return false;
    };
    current >= required
}

fn parse_os_version(value: &str) -> Option<[u64; 4]> {
    let candidate = value
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .find(|part| {
            !part.is_empty()
                && part
                    .split('.')
                    .all(|component| !component.is_empty() && component.parse::<u64>().is_ok())
        })?;
    let mut parsed = [0_u64; 4];
    let mut count = 0_usize;
    for (index, component) in candidate.split('.').enumerate() {
        if index >= parsed.len() {
            return None;
        }
        parsed[index] = component.parse().ok()?;
        count += 1;
    }
    (count > 0).then_some(parsed)
}

fn validate_product_id(product_id: &str) -> AppResult<()> {
    if product_id.is_empty()
        || product_id.len() > 64
        || !product_id
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
    {
        return Err(AppError::Verification("产品标识不安全".to_string()));
    }
    Ok(())
}

fn emit(
    app: &AppHandle,
    stage: &str,
    percent: u8,
    message: &str,
    current: Option<u64>,
    total: Option<u64>,
    unit: Option<&str>,
) -> AppResult<()> {
    app.emit(
        "install-progress",
        InstallProgress {
            stage: stage.to_string(),
            percent,
            message: message.to_string(),
            current,
            total,
            unit: unit.map(str::to_string),
        },
    )
    .map_err(|error| AppError::Message(error.to_string()))
}

#[cfg(target_os = "macos")]
fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "windows")]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact() -> SourceArtifact {
        SourceArtifact {
            id: "source-1".to_string(),
            product_id: "claude-code".to_string(),
            product_name: "Claude Code".to_string(),
            product_description: "Anthropic 官方终端编码代理".to_string(),
            homepage_url: "https://code.claude.com/docs/en/setup".to_string(),
            origin_url: "https://claude.ai/install.sh".to_string(),
            executable: "claude".to_string(),
            version_args: vec!["--version".to_string()],
            doctor_args: Some(vec!["doctor".to_string()]),
            terminal_args: vec![],
            version: "1.0.0".to_string(),
            platform: platform().to_string(),
            arch: architecture().to_string(),
            min_os_version: None,
            install_type: "standalone_binary".to_string(),
            url: "https://downloads.example.test/claude".to_string(),
            file_name: "claude".to_string(),
            size: 10,
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            args: vec![],
            requires_elevation: false,
            enabled: true,
            published_at: "2026-01-01T00:00:00Z".to_string(),
            script_interpreter: None,
            archive_format: None,
            archive_executable_path: None,
        }
    }

    #[test]
    fn rejects_path_traversal_in_signed_file_name() {
        let mut source = artifact();
        source.file_name = "../claude".to_string();
        assert!(validate_source(&source).is_err());
    }

    #[test]
    fn selects_the_active_compatible_source() {
        let source = artifact();
        let manifest = SourceManifest {
            schema_version: 3,
            revision: 1,
            generated_at: "2026-01-01T00:00:00Z".to_string(),
            active_release_ids: [(
                format!("{}:{}:{}", source.product_id, source.platform, source.arch),
                source.id.clone(),
            )]
            .into_iter()
            .collect(),
            releases: vec![source.clone()],
        };
        assert_eq!(select_sources(&manifest, "15.5")[0].id, source.id);
    }

    #[test]
    fn selects_only_sources_supported_by_the_current_os_version() {
        let mut compatible = artifact();
        compatible.id = "compatible".to_string();
        compatible.min_os_version = Some("13.0".to_string());
        compatible.published_at = "2026-01-01T00:00:00Z".to_string();

        let mut too_new = compatible.clone();
        too_new.id = "too-new".to_string();
        too_new.min_os_version = Some("16.0".to_string());
        too_new.published_at = "2026-02-01T00:00:00Z".to_string();

        let manifest = SourceManifest {
            schema_version: 3,
            revision: 2,
            generated_at: "2026-02-01T00:00:00Z".to_string(),
            active_release_ids: [(
                format!(
                    "{}:{}:{}",
                    too_new.product_id, too_new.platform, too_new.arch
                ),
                too_new.id.clone(),
            )]
            .into_iter()
            .collect(),
            releases: vec![compatible.clone(), too_new],
        };

        let selected = select_sources(&manifest, "macOS 15.5");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, compatible.id);
    }

    #[test]
    fn compares_windows_and_macos_version_text_numerically() {
        assert_eq!(parse_os_version("15.5"), Some([15, 5, 0, 0]));
        assert_eq!(
            parse_os_version("Microsoft Windows [Version 10.0.26100.4061]"),
            Some([10, 0, 26100, 4061])
        );
        assert!(parse_os_version("unknown").is_none());
    }

    #[test]
    fn rejects_replayed_manifest_revisions() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("manifest-revision");
        accept_manifest_revision_at(&path, 7).unwrap();
        accept_manifest_revision_at(&path, 7).unwrap();
        assert!(accept_manifest_revision_at(&path, 6).is_err());
        accept_manifest_revision_at(&path, 8).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap().trim(), "8");
    }

    #[test]
    fn rejects_unsafe_archive_executable_paths() {
        for value in ["../bin/tool", "/bin/tool", r"bin\tool", "bin//tool"] {
            assert!(safe_archive_relative_path(value).is_err(), "{value}");
        }
        assert_eq!(
            safe_archive_relative_path("bin/tool").unwrap(),
            PathBuf::from("bin/tool")
        );
    }

    fn receipt_for(root: &Path) -> InstallReceipt {
        InstallReceipt {
            product_id: "claude-code".to_string(),
            product_name: "Claude Code".to_string(),
            executable: "claude".to_string(),
            install_type: "archive_bundle".to_string(),
            binary_path: Some(root.join("bin/claude").to_string_lossy().into_owned()),
            install_dir: Some(
                root.join("bundles/claude-code")
                    .to_string_lossy()
                    .into_owned(),
            ),
            profile_path: Some("/Users/tester/.zshrc".to_string()),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            source_id: "source-1".to_string(),
        }
    }

    #[test]
    fn accepts_receipt_paths_owned_by_the_assistant() {
        let root = Path::new("/tmp/ai-tool-deploy-assistant");
        let home = Path::new("/Users/tester");
        assert!(validate_receipt_at("claude-code", &receipt_for(root), root, Some(home)).is_ok());
    }

    #[test]
    fn rejects_receipt_paths_outside_the_assistant_directory() {
        let root = Path::new("/tmp/ai-tool-deploy-assistant");
        let home = Path::new("/Users/tester");
        let mut receipt = receipt_for(root);
        receipt.install_dir = Some("/Users/tester/Documents".to_string());
        assert!(validate_receipt_at("claude-code", &receipt, root, Some(home)).is_err());

        let mut receipt = receipt_for(root);
        receipt.binary_path = Some("/usr/local/bin/claude".to_string());
        assert!(validate_receipt_at("claude-code", &receipt, root, Some(home)).is_err());

        let mut receipt = receipt_for(root);
        receipt.profile_path = Some("/Users/tester/.ssh/config".to_string());
        assert!(validate_receipt_at("claude-code", &receipt, root, Some(home)).is_err());
    }

    #[test]
    fn recognizes_npm_owned_executable_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let prefix = temporary.path().join("npm-prefix");
        let package = prefix.join("lib/node_modules/openclaw");
        fs::create_dir_all(&package).unwrap();
        let executable = package.join("openclaw.mjs");
        fs::write(&executable, "#!/usr/bin/env node\n").unwrap();

        assert!(npm_install_owns_executable(
            &executable,
            &package,
            &prefix,
            "openclaw"
        ));
        assert!(!npm_install_owns_executable(
            &temporary.path().join("other/openclaw"),
            &package,
            &prefix,
            "openclaw"
        ));
    }

    #[test]
    fn parses_absolute_paths_from_command_output() {
        assert_eq!(
            command_output_path("npm notice update available\n/opt/homebrew\n"),
            Some(PathBuf::from("/opt/homebrew"))
        );
        assert_eq!(command_output_path("npm warning only"), None);
    }

    #[test]
    fn extracts_a_zip_bundle() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("bundle.zip");
        let file = fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("bin/tool.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"offline tool").unwrap();
        archive.finish().unwrap();

        let destination = temporary.path().join("output");
        fs::create_dir(&destination).unwrap();
        extract_zip(&archive_path, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("bin/tool.exe")).unwrap(),
            b"offline tool"
        );
    }

    #[test]
    fn extracts_a_tar_gz_bundle() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("bundle.tar.gz");
        let file = fs::File::create(&archive_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let bytes = b"#!/bin/sh\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive
            .append_data(&mut header, "bin/tool", &bytes[..])
            .unwrap();
        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap();

        let destination = temporary.path().join("output");
        fs::create_dir(&destination).unwrap();
        extract_tar_gz(&archive_path, &destination).unwrap();
        assert_eq!(fs::read(destination.join("bin/tool")).unwrap(), bytes);
    }
}
