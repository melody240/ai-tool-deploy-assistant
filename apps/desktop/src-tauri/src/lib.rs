mod config_files;
mod error;
mod installer;
mod license;
mod models;
mod security;
mod system;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            system::get_system_info,
            license::get_license_status,
            license::get_license_request_context,
            license::accept_license_response,
            license::activate_license,
            license::renew_license,
            installer::fetch_manifest_summary,
            installer::install_source,
            installer::uninstall_managed,
            installer::run_product_diagnostics,
            terminal::open_product_terminal,
            config_files::preview_config,
            config_files::apply_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Tool Deploy Assistant");
}
