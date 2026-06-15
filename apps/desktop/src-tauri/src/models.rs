use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedEnvelope {
    pub algorithm: String,
    pub key_id: String,
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceManifest {
    pub schema_version: u32,
    pub revision: u64,
    pub generated_at: String,
    pub active_release_ids: std::collections::HashMap<String, String>,
    pub releases: Vec<SourceArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArtifact {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub product_description: String,
    pub homepage_url: String,
    pub origin_url: String,
    pub executable: String,
    #[serde(default)]
    pub version_args: Vec<String>,
    pub doctor_args: Option<Vec<String>>,
    #[serde(default)]
    pub terminal_args: Vec<String>,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub min_os_version: Option<String>,
    pub install_type: String,
    pub url: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub requires_elevation: bool,
    pub enabled: bool,
    pub published_at: String,
    pub script_interpreter: Option<String>,
    pub archive_format: Option<String>,
    pub archive_executable_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSummary {
    pub revision: u64,
    pub products: Vec<ProductInstallOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInstallOption {
    pub product_id: String,
    pub product_name: String,
    pub product_description: String,
    pub homepage_url: String,
    pub installed_path: Option<String>,
    pub installed_version: Option<String>,
    pub recommendation_reason: String,
    pub selected: SourceArtifact,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub product_id: String,
    pub product_name: String,
    pub executable: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub platform: String,
    pub architecture: String,
    pub os_version: String,
    pub total_memory_mb: u64,
    pub git_version: Option<String>,
    pub tools: Vec<ToolStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub active: bool,
    pub mode: String,
    pub device_id: String,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub can_renew: bool,
    pub renewal_recommended: bool,
    pub days_remaining: Option<i64>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseRequestContext {
    pub device_id: String,
    pub device_fingerprint: String,
    pub app_version: String,
    pub license: Option<SignedEnvelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub schema_version: u32,
    pub license_id: String,
    pub code_id: String,
    pub device_id: String,
    pub device_fingerprint: String,
    pub product: String,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ActivationResponse {
    pub license: SignedEnvelope,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticResult {
    pub name: String,
    pub status: String,
    pub summary: String,
    pub details: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: String,
    pub percent: u8,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInput {
    pub project_dir: String,
    pub claude_md: String,
    pub settings: serde_json::Value,
    pub mcp: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPreview {
    pub path: String,
    pub before: String,
    pub after: String,
    pub changed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    pub product_id: String,
    pub product_name: String,
    pub executable: String,
    pub install_type: String,
    pub binary_path: Option<String>,
    #[serde(default)]
    pub install_dir: Option<String>,
    pub profile_path: Option<String>,
    pub installed_at: String,
    pub source_id: String,
}
