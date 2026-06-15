fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("ALLOW_DEVELOPMENT_KEYS").as_deref() != Ok("1")
    {
        let manifest_key = std::fs::read_to_string("resources/manifest-public-key.b64")
            .expect("manifest public key is required");
        let license_key = std::fs::read_to_string("resources/license-public-key.b64")
            .expect("license public key is required");
        if manifest_key.trim() == "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
            || license_key.trim() == "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="
        {
            panic!(
                "replace the development manifest and license public keys before a release build"
            );
        }
    }
    tauri_build::build()
}
