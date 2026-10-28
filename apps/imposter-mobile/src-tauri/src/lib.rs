// This is intentionally only a WebView shell. No Holochain app websocket,
// keystore capability, or arbitrary command bridge is exposed to web content.
// The H2HC conductor adapter will be added and tested separately.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Failed to run Imposter mobile");
}
