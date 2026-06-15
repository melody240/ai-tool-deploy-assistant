use std::{fs, io::Write, path::PathBuf};

use chrono::{DateTime, Utc};
use serde_json::json;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        ActivationResponse, LicensePayload, LicenseRequestContext, LicenseStatus, SignedEnvelope,
    },
    security::{validate_remote_url, verify_envelope, LICENSE_PUBLIC_KEY},
    system::machine_fingerprint,
};

const RENEWAL_WINDOW_DAYS: i64 = 7;

fn app_data_dir() -> AppResult<PathBuf> {
    let path = dirs::data_local_dir()
        .ok_or_else(|| AppError::Message("无法确定应用数据目录".to_string()))?
        .join("ai-tool-deploy-assistant");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn device_id_path() -> AppResult<PathBuf> {
    Ok(app_data_dir()?.join("device-id"))
}

fn license_path() -> AppResult<PathBuf> {
    Ok(app_data_dir()?.join("license.json"))
}

fn load_or_create_device_id() -> AppResult<String> {
    let path = device_id_path()?;
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim();
        if Uuid::parse_str(value).is_ok() {
            return Ok(value.to_string());
        }
    }
    let device_id = Uuid::new_v4().to_string();
    write_private(&path, device_id.as_bytes())?;
    Ok(device_id)
}

fn load_local_license() -> AppResult<(SignedEnvelope, LicensePayload)> {
    let device_id = load_or_create_device_id()?;
    let device_fingerprint = machine_fingerprint()?;
    let envelope: SignedEnvelope = serde_json::from_slice(&fs::read(license_path()?)?)?;
    let payload: LicensePayload = verify_envelope(&envelope, LICENSE_PUBLIC_KEY)?;
    validate_license_identity(&payload, &device_id, &device_fingerprint)?;
    Ok((envelope, payload))
}

#[cfg(not(debug_assertions))]
fn validated_license() -> AppResult<LicensePayload> {
    let (_, payload) = load_local_license()?;
    validate_license_expiry(&payload, Utc::now())?;
    Ok(payload)
}

fn validate_license_identity(
    payload: &LicensePayload,
    device_id: &str,
    device_fingerprint: &str,
) -> AppResult<()> {
    if payload.schema_version != 2
        || payload.product != "ai-tool-deploy-assistant"
        || payload.device_id != device_id
        || payload.device_fingerprint != device_fingerprint
    {
        return Err(AppError::Verification("许可证与当前设备不匹配".to_string()));
    }
    payload
        .expires_at
        .parse::<DateTime<Utc>>()
        .map_err(|_| AppError::Verification("许可证到期时间无效".to_string()))?;
    Ok(())
}

fn validate_license_expiry(payload: &LicensePayload, now: DateTime<Utc>) -> AppResult<()> {
    let expires_at = payload
        .expires_at
        .parse::<DateTime<Utc>>()
        .map_err(|_| AppError::Verification("许可证到期时间无效".to_string()))?;
    if expires_at <= now {
        return Err(AppError::Verification(
            "许可证已到期，正在等待联网续期".to_string(),
        ));
    }
    Ok(())
}

fn status_from_payload(payload: LicensePayload, now: DateTime<Utc>) -> LicenseStatus {
    let expires_at = payload
        .expires_at
        .parse::<DateTime<Utc>>()
        .expect("validated license expiry");
    let seconds = (expires_at - now).num_seconds();
    let active = seconds > 0;
    let days_remaining = if active {
        Some((seconds + 86_399) / 86_400)
    } else {
        Some(0)
    };
    LicenseStatus {
        active,
        mode: if active { "licensed" } else { "inactive" }.to_string(),
        device_id: payload.device_id,
        issued_at: Some(payload.issued_at),
        expires_at: Some(payload.expires_at),
        can_renew: true,
        renewal_recommended: seconds <= RENEWAL_WINDOW_DAYS * 86_400,
        days_remaining,
        message: if active {
            format!("设备许可证有效，剩余 {} 天", days_remaining.unwrap_or(0))
        } else {
            "许可证已到期，联网后可自动续期".to_string()
        },
    }
}

pub fn ensure_active() -> AppResult<()> {
    #[cfg(debug_assertions)]
    {
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        validated_license().map(|_| ())
    }
}

#[tauri::command]
pub fn get_license_status() -> AppResult<LicenseStatus> {
    let device_id = load_or_create_device_id()?;
    #[cfg(debug_assertions)]
    {
        Ok(LicenseStatus {
            active: true,
            mode: "development".to_string(),
            device_id,
            issued_at: None,
            expires_at: None,
            can_renew: false,
            renewal_recommended: false,
            days_remaining: None,
            message: "Debug 构建已进入测试模式，正式版仍需要兑换码".to_string(),
        })
    }
    #[cfg(not(debug_assertions))]
    {
        match load_local_license() {
            Ok((_, payload)) => Ok(status_from_payload(payload, Utc::now())),
            Err(_) => Ok(LicenseStatus {
                active: false,
                mode: "inactive".to_string(),
                device_id,
                issued_at: None,
                expires_at: None,
                can_renew: false,
                renewal_recommended: false,
                days_remaining: None,
                message: "请输入有效兑换码".to_string(),
            }),
        }
    }
}

#[tauri::command]
pub fn get_license_request_context(include_license: bool) -> AppResult<LicenseRequestContext> {
    Ok(LicenseRequestContext {
        device_id: load_or_create_device_id()?,
        device_fingerprint: machine_fingerprint()?,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        license: if include_license {
            Some(load_local_license()?.0)
        } else {
            None
        },
    })
}

#[tauri::command]
pub fn accept_license_response(license: SignedEnvelope) -> AppResult<LicenseStatus> {
    let device_id = load_or_create_device_id()?;
    let device_fingerprint = machine_fingerprint()?;
    persist_and_describe(
        ActivationResponse { license },
        &device_id,
        &device_fingerprint,
    )
}

#[tauri::command]
pub async fn activate_license(api_url: String, code: String) -> AppResult<LicenseStatus> {
    let device_id = load_or_create_device_id()?;
    let device_fingerprint = machine_fingerprint()?;
    let response = post_license_request(
        &api_url,
        "/v1/activate",
        json!({
            "code": code,
            "deviceId": device_id,
            "deviceFingerprint": device_fingerprint,
            "appVersion": env!("CARGO_PKG_VERSION")
        }),
    )
    .await?;
    persist_and_describe(response, &device_id, &device_fingerprint)
}

#[tauri::command]
pub async fn renew_license(api_url: String) -> AppResult<LicenseStatus> {
    let device_id = load_or_create_device_id()?;
    let device_fingerprint = machine_fingerprint()?;
    let (license, _) = load_local_license()?;
    let response = post_license_request(
        &api_url,
        "/v1/renew",
        json!({
            "license": license,
            "appVersion": env!("CARGO_PKG_VERSION")
        }),
    )
    .await?;
    persist_and_describe(response, &device_id, &device_fingerprint)
}

async fn post_license_request(
    api_url: &str,
    path: &str,
    body: serde_json::Value,
) -> AppResult<ActivationResponse> {
    let mut endpoint = validate_remote_url(api_url)?;
    endpoint.set_path(path);
    endpoint.set_query(None);
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?
        .post(endpoint)
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(AppError::Message(format!(
            "许可证请求失败（HTTP {status}）：{}",
            friendly_license_error(&detail)
        )));
    }
    Ok(response.json().await?)
}

fn persist_and_describe(
    activation: ActivationResponse,
    device_id: &str,
    device_fingerprint: &str,
) -> AppResult<LicenseStatus> {
    let payload: LicensePayload = verify_envelope(&activation.license, LICENSE_PUBLIC_KEY)?;
    validate_license_identity(&payload, device_id, device_fingerprint)?;
    validate_license_expiry(&payload, Utc::now())?;
    write_private(
        &license_path()?,
        serde_json::to_vec_pretty(&activation.license)?.as_slice(),
    )?;
    Ok(status_from_payload(payload, Utc::now()))
}

fn friendly_license_error(body: &str) -> &str {
    if body.contains("CODE_ALREADY_BOUND") || body.contains("LICENSE_DEVICE_MISMATCH") {
        "兑换码已绑定其他设备"
    } else if body.contains("CODE_DISABLED") {
        "兑换码已停用"
    } else if body.contains("CODE_EXPIRED") {
        "兑换码授权期限已结束"
    } else if body.contains("INVALID_CODE") {
        "兑换码无效"
    } else if body.contains("INVALID_LICENSE") {
        "本机许可证无效，请重新输入兑换码"
    } else {
        "请检查网络后重试"
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Message("许可证路径无效".to_string()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
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

#[cfg(all(test, debug_assertions))]
mod tests {
    use chrono::{DateTime, Duration, TimeZone, Utc};

    use crate::models::LicensePayload;

    fn payload(now: DateTime<Utc>) -> LicensePayload {
        LicensePayload {
            schema_version: 2,
            license_id: uuid::Uuid::new_v4().to_string(),
            code_id: uuid::Uuid::new_v4().to_string(),
            device_id: uuid::Uuid::new_v4().to_string(),
            device_fingerprint: "a".repeat(64),
            product: "ai-tool-deploy-assistant".to_string(),
            issued_at: now.to_rfc3339(),
            expires_at: (now + Duration::days(30)).to_rfc3339(),
        }
    }

    #[test]
    fn debug_build_allows_testing_without_a_license() {
        assert!(super::ensure_active().is_ok());
    }

    #[test]
    fn rejects_expired_or_copied_license_payloads() {
        let now = Utc.with_ymd_and_hms(2026, 6, 11, 0, 0, 0).unwrap();
        let mut value = payload(now);
        assert!(super::validate_license_identity(
            &value,
            &value.device_id,
            &value.device_fingerprint
        )
        .is_ok());
        assert!(
            super::validate_license_identity(&value, &value.device_id, &"b".repeat(64)).is_err()
        );
        value.expires_at = (now - Duration::seconds(1)).to_rfc3339();
        assert!(super::validate_license_expiry(&value, now).is_err());
    }

    #[test]
    fn recommends_renewal_during_the_final_week() {
        let now = Utc.with_ymd_and_hms(2026, 6, 11, 0, 0, 0).unwrap();
        let mut value = payload(now);
        value.expires_at = (now + Duration::days(5)).to_rfc3339();
        let status = super::status_from_payload(value, now);
        assert!(status.active);
        assert!(status.can_renew);
        assert!(status.renewal_recommended);
        assert_eq!(status.days_remaining, Some(5));
    }
}
