use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::de::DeserializeOwned;
use url::Url;

use crate::{
    error::{AppError, AppResult},
    models::SignedEnvelope,
};

pub const MANIFEST_PUBLIC_KEY: &str = include_str!("../resources/manifest-public-key.b64");
pub const LICENSE_PUBLIC_KEY: &str = include_str!("../resources/license-public-key.b64");

pub fn verify_envelope<T: DeserializeOwned>(
    envelope: &SignedEnvelope,
    public_key_base64: &str,
) -> AppResult<T> {
    if envelope.algorithm != "Ed25519" {
        return Err(AppError::Verification("不支持的签名算法".to_string()));
    }
    let key_bytes = STANDARD
        .decode(public_key_base64.trim())
        .map_err(|error| AppError::Verification(error.to_string()))?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| AppError::Verification("公钥长度错误".to_string()))?;
    let verifying_key = VerifyingKey::from_bytes(&key_array)
        .map_err(|error| AppError::Verification(error.to_string()))?;
    let payload = STANDARD
        .decode(&envelope.payload)
        .map_err(|error| AppError::Verification(error.to_string()))?;
    let signature_bytes = STANDARD
        .decode(&envelope.signature)
        .map_err(|error| AppError::Verification(error.to_string()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| AppError::Verification(error.to_string()))?;
    verifying_key
        .verify_strict(&payload, &signature)
        .map_err(|_| AppError::Verification("Ed25519 签名无效".to_string()))?;
    Ok(serde_json::from_slice(&payload)?)
}

pub fn validate_remote_url(value: &str) -> AppResult<Url> {
    let url =
        Url::parse(value).map_err(|error| AppError::Message(format!("URL 格式错误：{error}")))?;
    if url.scheme() == "https" {
        return Ok(url);
    }
    #[cfg(debug_assertions)]
    if url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")) {
        return Ok(url);
    }
    Err(AppError::InsecureUrl)
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize)]
    struct TestPayload {
        revision: u64,
    }

    #[test]
    fn rejects_plain_http_in_production_logic() {
        let result = validate_remote_url("http://example.com/file");
        assert!(result.is_err());
    }

    #[test]
    fn verifies_exact_payload_bytes_and_rejects_tampering() {
        let secret =
            hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .unwrap();
        let signing_key = SigningKey::from_bytes(&secret.try_into().unwrap());
        let public_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
        let payload = br#"{"revision":7}"#;
        let envelope = SignedEnvelope {
            algorithm: "Ed25519".to_string(),
            key_id: "test".to_string(),
            payload: STANDARD.encode(payload),
            signature: STANDARD.encode(signing_key.sign(payload).to_bytes()),
        };
        let decoded: TestPayload = verify_envelope(&envelope, &public_key).unwrap();
        assert_eq!(decoded.revision, 7);

        let mut tampered = envelope;
        tampered.payload = STANDARD.encode(br#"{"revision":8}"#);
        assert!(verify_envelope::<TestPayload>(&tampered, &public_key).is_err());
    }
}
