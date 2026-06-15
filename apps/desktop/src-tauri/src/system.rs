use sha2::{Digest, Sha256};
use std::{
    process::{Command, Stdio},
    time::Duration,
};
use wait_timeout::ChildExt;

use crate::{
    error::{AppError, AppResult},
    models::{SystemInfo, ToolStatus},
};

pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "unsupported",
    }
}

pub fn architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => "unsupported",
    }
}

pub fn machine_fingerprint() -> AppResult<String> {
    let machine_id = platform_machine_id()?;
    let mut hasher = Sha256::new();
    hasher.update(b"ai-tool-deploy-assistant:machine:v1:");
    hasher.update(platform().as_bytes());
    hasher.update(b":");
    hasher.update(machine_id.trim().as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(target_os = "macos")]
fn platform_machine_id() -> AppResult<String> {
    let output = command_text(
        "/usr/sbin/ioreg",
        &["-rd1", "-c", "IOPlatformExpertDevice"],
        Duration::from_secs(5),
    )?;
    output
        .lines()
        .find_map(|line| {
            let (_, value) = line.split_once("\"IOPlatformUUID\" = ")?;
            Some(value.trim().trim_matches('"').to_string())
        })
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Message("无法读取 macOS 设备标识".to_string()))
}

#[cfg(target_os = "windows")]
fn platform_machine_id() -> AppResult<String> {
    use winreg::{
        enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
        RegKey,
    };
    let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Cryptography",
        KEY_READ | KEY_WOW64_64KEY,
    )?;
    let value: String = key.get_value("MachineGuid")?;
    if value.trim().is_empty() {
        return Err(AppError::Message("无法读取 Windows 设备标识".to_string()));
    }
    Ok(value)
}

#[cfg(target_os = "linux")]
fn platform_machine_id() -> AppResult<String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(value) = std::fs::read_to_string(path) {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }
    }
    Err(AppError::Message("无法读取 Linux 设备标识".to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_machine_id() -> AppResult<String> {
    Err(AppError::Message("当前系统不支持安全设备绑定".to_string()))
}

#[tauri::command]
pub fn get_system_info() -> AppResult<SystemInfo> {
    Ok(SystemInfo {
        platform: platform().to_string(),
        architecture: architecture().to_string(),
        os_version: os_version(),
        total_memory_mb: total_memory_mb(),
        git_version: which::which("git")
            .ok()
            .and_then(|path| command_text(&path, &["--version"], Duration::from_secs(5)).ok()),
        tools: [
            ("claude-code", "Claude Code", "claude"),
            ("openclaw", "OpenClaw", "openclaw"),
            ("hermes-agent", "Hermes Agent", "hermes"),
        ]
        .into_iter()
        .map(|(product_id, product_name, executable)| {
            tool_status(product_id, product_name, executable, &["--version"])
        })
        .collect(),
    })
}

pub fn resolve_product(executable: &str) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let candidates = if executable.contains('.') {
        vec![executable.to_string()]
    } else {
        vec![
            executable.to_string(),
            format!("{executable}.exe"),
            format!("{executable}.cmd"),
            format!("{executable}.bat"),
        ]
    };
    #[cfg(not(windows))]
    let candidates = [executable.to_string()];

    candidates
        .iter()
        .find_map(|candidate| which::which(candidate).ok())
        .or_else(|| {
            candidates.iter().find_map(|candidate| {
                let path = managed_bin_dir().join(candidate);
                path.exists().then_some(path)
            })
        })
}

pub fn managed_bin_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ai-tool-deploy-assistant")
        .join("bin")
}

pub fn command_text(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<String> {
    let program = program.as_ref();
    #[cfg(windows)]
    let mut command = {
        let extension = std::path::Path::new(program)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/C"]).arg(program);
            command
        } else {
            Command::new(program)
        }
    };
    #[cfg(not(windows))]
    let mut command = {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(program);
        command.process_group(0);
        command
    };
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    match child.wait_timeout(timeout)? {
        Some(status) => {
            let output = child.wait_with_output()?;
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_string();
            if status.success() {
                Ok(text)
            } else {
                Err(AppError::Command(if text.is_empty() {
                    format!("退出码 {status}")
                } else {
                    truncate(&text, 8_000)
                }))
            }
        }
        None => {
            terminate_child_tree(&mut child);
            let _ = child.wait();
            Err(AppError::Command("命令执行超时".to_string()))
        }
    }
}

#[cfg(unix)]
fn terminate_child_tree(child: &mut std::process::Child) {
    let process_group = format!("-{}", child.id());
    let _ = Command::new("kill")
        .args(["-KILL", process_group.as_str()])
        .status();
    let _ = child.kill();
}

#[cfg(windows)]
fn terminate_child_tree(child: &mut std::process::Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .status();
    let _ = child.kill();
}

fn tool_status(
    product_id: &str,
    product_name: &str,
    executable: &str,
    version_args: &[&str],
) -> ToolStatus {
    let path = resolve_product(executable);
    let version = path
        .as_ref()
        .and_then(|path| command_text(path, version_args, Duration::from_secs(8)).ok());
    ToolStatus {
        product_id: product_id.to_string(),
        product_name: product_name.to_string(),
        executable: executable.to_string(),
        path: path.map(|path| path.to_string_lossy().into_owned()),
        version,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, thread};

    #[test]
    fn command_timeout_terminates_background_children() {
        let temporary = tempfile::tempdir().unwrap();
        let pid_path = temporary.path().join("child.pid");
        let script = format!(
            "sleep 60 & echo $! > '{}'; wait",
            pid_path.to_string_lossy().replace('\'', "'\\''")
        );

        let started = std::time::Instant::now();
        let error =
            command_text("/bin/sh", &["-c", &script], Duration::from_millis(150)).unwrap_err();
        assert!(error.to_string().contains("执行超时"));
        assert!(started.elapsed() < Duration::from_secs(3));

        let child_pid = fs::read_to_string(pid_path).unwrap();
        thread::sleep(Duration::from_millis(100));
        let status = Command::new("kill")
            .args(["-0", child_pid.trim()])
            .status()
            .unwrap();
        assert!(!status.success(), "background child survived timeout");
    }
}

pub fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        return command_text(
            "/usr/bin/sw_vers",
            &["-productVersion"],
            Duration::from_secs(3),
        )
        .unwrap_or_else(|_| "macOS".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|content| {
                content
                    .lines()
                    .find_map(|line| line.strip_prefix("PRETTY_NAME="))
                    .map(|value| value.trim_matches('"').to_string())
            })
            .unwrap_or_else(|| "Linux".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        return command_text("cmd.exe", &["/C", "ver"], Duration::from_secs(3))
            .unwrap_or_else(|_| "Windows".to_string());
    }
    #[allow(unreachable_code)]
    "Unknown".to_string()
}

fn total_memory_mb() -> u64 {
    #[cfg(target_os = "macos")]
    {
        return command_text(
            "/usr/sbin/sysctl",
            &["-n", "hw.memsize"],
            Duration::from_secs(3),
        )
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|bytes| bytes / 1024 / 1024)
        .unwrap_or(0);
    }
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|content| {
                content.lines().find_map(|line| {
                    line.strip_prefix("MemTotal:")
                        .and_then(|value| value.split_whitespace().next())
                        .and_then(|value| value.parse::<u64>().ok())
                })
            })
            .map(|kilobytes| kilobytes / 1024)
            .unwrap_or(0);
    }
    #[cfg(target_os = "windows")]
    {
        return command_text(
            "powershell.exe",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ],
            Duration::from_secs(8),
        )
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|bytes| bytes / 1024 / 1024)
        .unwrap_or(0);
    }
    #[allow(unreachable_code)]
    0
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
