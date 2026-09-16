fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "set_close_action",
            "dismiss_close_prompt",
            "restart_app",
        ]),
    ))
    .expect("failed to build desktop permission manifest")
}
