const APP_COMMANDS: &[&str] = &[
    "import_document",
    "list_documents",
    "read_document",
    "record_document_info",
    "get_settings",
    "update_settings",
    "device_memory",
    "pick_pdf",
    "take_pick_result",
];

fn main() {
    // Declaring the app commands makes them deny-by-default: each one must be
    // granted explicitly in `capabilities/*.json`.
    let mut attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));

    // On Windows the Common-Controls v6 manifest is embedded through the linker
    // instead of the resource file, so it also reaches the test binaries
    // (otherwise they abort with STATUS_ENTRYPOINT_NOT_FOUND).
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attrs =
            attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        println!("cargo:rustc-link-arg=/WX");
    }

    if let Err(err) = tauri_build::try_build(attrs) {
        panic!("tauri build script failed: {err:#}");
    }
}
