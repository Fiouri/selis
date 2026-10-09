const APP_COMMANDS: &[&str] = &[
    "import_document",
    "list_documents",
    "read_document",
    "record_document_info",
    "get_settings",
    "update_settings",
];

fn main() {
    // Declaring the app commands makes them deny-by-default: each one must be
    // granted explicitly in `capabilities/*.json`.
    let attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if let Err(err) = tauri_build::try_build(attrs) {
        panic!("tauri build script failed: {err:#}");
    }
}
