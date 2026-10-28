mod native;
#[cfg(feature = "h2hc-runtime")]
mod h2hc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(native::NativeConductorState::default());
    #[cfg(feature = "h2hc-runtime")]
    let builder = builder
        .manage(h2hc::BootState::default())
        .setup(|app| {
            h2hc::start_debug(app);
            Ok(())
        });
    builder
        .invoke_handler(tauri::generate_handler![
            native::mobile_status,
            native::mobile_app_info,
            native::mobile_create_clone,
            native::mobile_disable_clone,
            native::mobile_call_zome,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run Imposter mobile");
}
