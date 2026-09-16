mod chrome;
mod cli_shim;
mod desktop_settings;
mod i18n;
mod notify;
mod overlay;
mod runtime;
mod tray;
mod updater;
mod webview_security;
mod window_layout;

use desktop_settings::AgentEnvironment;
use i18n::Msg;
use runtime::boot_log;
use runtime::config::BUNDLED_HARNESS_DIR;
use runtime::io_fallback::is_recoverable_io;
use runtime::provision::{
    ensure_runtime, invalidate_provisioned_tree, read_bundle_hash, try_recover_paths, RuntimePaths,
};
use runtime::supervisor::{is_missing_dependency_failure, spawn_wsl_web_host, HostOverlay};
use runtime::user_home::resolve_user_home;
use runtime::wsl::{
    ensure_wsl_runtime, parse_wsl_list, select_distro, SystemWslRunner, WslRunner, WslSelectError,
};
use runtime::{app_data_root, boot_kind, DesktopRuntime, ProvisionEvent};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent};

const SPLASH_BG: Color = Color(0, 0, 0, 0);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if cli_shim::should_run_as_cli() {
        std::process::exit(cli_shim::run());
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            chrome::show_main(app);
        }))
        .invoke_handler(tauri::generate_handler![
            chrome::set_close_action,
            chrome::dismiss_close_prompt,
            chrome::restart_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("default window icon is missing")?;
            if let Some(splash) = app.get_webview_window("splash") {
                splash.set_icon(icon)?;
                let _ = splash.set_background_color(Some(SPLASH_BG));
                let _ = splash.center();
                let locale = match i18n::current() {
                    i18n::Locale::Zh => "zh",
                    i18n::Locale::En => "en",
                };
                let _ = splash.eval(&format!(
                    "window.__DSH_LOCALE__={};window.DSH_I18N&&window.DSH_I18N.apply();",
                    json_string(locale)
                ));
            }
            tray::install(&handle)?;
            let bundled = resolve_bundled_source(&handle);
            tauri::async_runtime::spawn(async move {
                if let Err(err) = boot_app(handle.clone(), bundled).await {
                    boot_log::error(&err);
                    let script = format!("window.__DSH_SPLASH__?.setError({});", json_string(&err));
                    let _ = splash_eval(&handle, &script);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => chrome::show_main(app),
            RunEvent::ExitRequested { code, api, .. } => {
                if code.is_none() && !chrome::quit_requested() {
                    api.prevent_exit();
                } else {
                    chrome::stop_host(app);
                }
            }
            RunEvent::Exit => chrome::stop_host(app),
            _ => {}
        });
}

fn resolve_bundled_source(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    #[cfg(target_os = "linux")]
    {
        let bundled = resolve_linux_bundled_source(&resource_dir);
        #[cfg(debug_assertions)]
        let bundled = bundled.or_else(|| {
            // Tauri dev does not copy the Linux package-specific files mappings.
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bundled/harness");
            source
                .join(".bundle-manifest.json")
                .is_file()
                .then_some(source)
        });
        bundled
    }
    #[cfg(not(target_os = "linux"))]
    {
        let source = resource_dir.join(BUNDLED_HARNESS_DIR);
        source
            .join(".bundle-manifest.json")
            .is_file()
            .then_some(source)
    }
}

/// Linux packages keep the immutable runtime outside linuxdeploy's ELF scan of usr/lib.
#[cfg(any(target_os = "linux", test))]
fn resolve_linux_bundled_source(resource_dir: &std::path::Path) -> Option<PathBuf> {
    let lib_dir = resource_dir.parent()?;
    if lib_dir.file_name()? != "lib" {
        return None;
    }
    let source = lib_dir
        .parent()?
        .join("share/ClawMaster")
        .join(BUNDLED_HARNESS_DIR);
    source
        .join(".bundle-manifest.json")
        .is_file()
        .then_some(source)
}

#[cfg(test)]
mod linux_payload_tests {
    use super::resolve_linux_bundled_source;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "clawmaster-linux-layout-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn payload(&self, prefix: &str) -> PathBuf {
            let source = self
                .0
                .join(prefix)
                .join("usr/share/ClawMaster/harness-source");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join(".bundle-manifest.json"), "{}").unwrap();
            source
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn linux_payload_resolves_deb_and_appimage_prefixes() {
        let fixture = Fixture::new();
        for prefix in ["", ".mount ClawMaster"] {
            let expected = fixture.payload(prefix);
            let resources = fixture.0.join(prefix).join("usr/lib/ClawMaster");
            assert_eq!(resolve_linux_bundled_source(&resources), Some(expected));
        }
    }

    #[test]
    fn linux_payload_rejects_missing_manifest_and_legacy_lib_copy() {
        let fixture = Fixture::new();
        let resources = fixture.0.join("usr/lib/ClawMaster");
        let legacy = resources.join("harness-source");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(".bundle-manifest.json"), "{}").unwrap();
        assert_eq!(resolve_linux_bundled_source(&resources), None);
        fixture.payload("");
        assert_eq!(
            resolve_linux_bundled_source(&fixture.0.join("target/debug")),
            None
        );
    }

    #[test]
    fn linux_payload_config_removes_only_the_scanned_resource_mapping() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let (config, _) =
            tauri::utils::config::parse::read_from(tauri::utils::platform::Target::Linux, root)
                .unwrap();
        let resources = config["bundle"]["resources"].as_object().unwrap();
        assert!(!resources.contains_key("../bundled/harness"));
        assert_eq!(resources["../overlay/desktop-notify"], "desktop-overlay");
        assert_eq!(resources["../sounds/complete.wav"], "complete.wav");
        for package in ["appimage", "deb"] {
            assert_eq!(
                config["bundle"]["linux"][package]["files"]["/usr/share/ClawMaster/harness-source"],
                "../bundled/harness"
            );
        }
        let _: tauri::utils::config::Config = serde_json::from_value(config).unwrap();
    }
}

async fn boot_app(app: AppHandle, bundled: Option<PathBuf>) -> Result<(), String> {
    boot_log::init()?;
    boot_log::info(&format!(
        "boot start bundled={}",
        bundled
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "none".into())
    ));

    let app_for_progress = app.clone();
    let progress: Arc<dyn Fn(ProvisionEvent) + Send + Sync> =
        Arc::new(move |event: ProvisionEvent| {
            let app = app_for_progress.clone();
            tauri::async_runtime::spawn(async move {
                let script = match event {
                    ProvisionEvent::Status(text) => {
                        boot_log::info(&format!("status: {text}"));
                        format!("window.__DSH_SPLASH__?.setStatus({});", json_string(&text))
                    }
                    ProvisionEvent::Progress(pct) => {
                        format!("window.__DSH_SPLASH__?.setProgress({pct});", pct = pct)
                    }
                };
                let _ = splash_eval(&app, &script);
            });
        });

    let notify = match notify::start(app.clone()) {
        Ok(notify) => Some(notify),
        Err(error) => {
            boot_log::info(&format!("notify disabled, overlay skipped: {error}"));
            None
        }
    };

    let settings = desktop_settings::load();
    let runtime = match boot_kind(&settings) {
        AgentEnvironment::Windows => {
            boot_windows_runtime(app.clone(), bundled, notify.as_ref(), Arc::clone(&progress))
                .await?
        }
        AgentEnvironment::Wsl => {
            boot_wsl_runtime(
                app.clone(),
                bundled,
                &settings,
                notify.as_ref(),
                Arc::clone(&progress),
            )
            .await?
        }
    };

    let web_url = runtime.web_url.clone();
    if !runtime.host.disabled_plugins.is_empty() {
        let names = runtime.host.disabled_plugins.join("、");
        boot_log::error(&format!("plugins disabled by rescue patch: {names}"));
        notify::toast(&app, "ClawMaster", &i18n::tf(Msg::PluginsDisabled, &names));
    }
    app.manage(runtime);
    if let Some(notify) = notify {
        app.manage(notify);
    }
    boot_log::info("opening main window");
    chrome::open_main_window(&app, &web_url)?;
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    boot_log::info("boot complete");
    let app_for_update = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = updater::install_available(&app_for_update, Arc::new(|_| {})).await {
            boot_log::info(&format!("desktop update skipped: {error}"));
        }
    });
    Ok(())
}

async fn boot_windows_runtime(
    app: AppHandle,
    bundled: Option<PathBuf>,
    notify: Option<&notify::NotifyHandle>,
    progress: Arc<dyn Fn(ProvisionEvent) + Send + Sync>,
) -> Result<DesktopRuntime, String> {
    let overlay_src = overlay::resolve_overlay_source(app.path().resource_dir().ok().as_deref());
    let mut paths = ensure_or_recover(bundled.clone(), &progress).await?;

    // A Host that dies naming an unresolvable dependency points at store
    // damage the on-disk gates cannot see (e.g. a package removed after a
    // completed install), so the first such failure invalidates the tree and
    // re-provisions once before giving up. The overlay patch file lives
    // inside the harness tree and is re-implanted with each attempt.
    let mut repaired = false;
    loop {
        let host_overlay = notify.and_then(|notify| {
            match overlay::install_overlay(&paths, &overlay_src, &notify.url) {
                Ok(implanted) => Some(HostOverlay {
                    patch_file: implanted.patch_file,
                    notify_url: notify.url.clone(),
                }),
                Err(error) => {
                    boot_log::info(&format!("overlay skipped: {error}"));
                    None
                }
            }
        });

        match DesktopRuntime::start(paths.clone(), host_overlay.as_ref(), Arc::clone(&progress))
            .await
        {
            Ok(runtime) => return Ok(runtime),
            Err(error) if !repaired && is_missing_dependency_failure(&error) => {
                boot_log::error(&format!(
                    "host missing a provisioned dependency; re-provisioning: {error}"
                ));
                invalidate_provisioned_tree(&paths)?;
                paths = ensure_or_recover(bundled.clone(), &progress).await?;
                repaired = true;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Provision the runtime, falling back to whatever Node / CLI already exists
/// on disk when provisioning fails.
async fn ensure_or_recover(
    bundled: Option<PathBuf>,
    progress: &Arc<dyn Fn(ProvisionEvent) + Send + Sync>,
) -> Result<RuntimePaths, String> {
    match ensure_runtime(bundled.clone(), {
        let progress = Arc::clone(progress);
        move |event| progress(event)
    })
    .await
    {
        Ok(paths) => Ok(paths),
        Err(error) => {
            boot_log::error(&format!("provision failed: {error}"));
            if let Some(paths) = try_recover_paths(bundled.as_deref()) {
                progress(ProvisionEvent::Status(if is_recoverable_io(&error) {
                    i18n::t(Msg::BootRecoverIo).into()
                } else {
                    i18n::t(Msg::BootRecoverGeneric).into()
                }));
                Ok(paths)
            } else if is_recoverable_io(&error) {
                Err(i18n::t(Msg::BootRecoverFailed).into())
            } else {
                Err(error)
            }
        }
    }
}

async fn boot_wsl_runtime(
    app: AppHandle,
    bundled: Option<PathBuf>,
    settings: &desktop_settings::DesktopSettings,
    notify: Option<&notify::NotifyHandle>,
    progress: Arc<dyn Fn(ProvisionEvent) + Send + Sync>,
) -> Result<DesktopRuntime, String> {
    progress(ProvisionEvent::Status(i18n::t(Msg::StatusDetectWsl).into()));
    let runner = SystemWslRunner;
    let list_out = runner
        .run(&["-l", "-v"])
        .map_err(|_| WslSelectError::missing_wsl().splash_message().to_string())?;
    let list_text = String::from_utf8_lossy(&list_out.stdout);
    let distros = parse_wsl_list(&list_text);
    let distro = select_distro(&distros, settings.wsl_distro.as_deref())
        .map_err(|error| error.splash_message().to_string())?;

    let bundled = bundled.ok_or_else(|| i18n::t(Msg::BootMissingBundle).to_string())?;
    let bundle_hash = read_bundle_hash(&bundled)?;
    let isolated_home = app_data_root()?.join("dsh-home");
    let windows_dsh_home = resolve_user_home(&isolated_home).path;
    let overlay_src = overlay::resolve_overlay_source(app.path().resource_dir().ok().as_deref());
    let overlay_for_provision = notify.map(|_| overlay_src.as_path());
    let notify_url = notify.map(|server| server.url.as_str());

    let wsl_paths = ensure_wsl_runtime(
        &runner,
        &distro.name,
        &bundled,
        &bundle_hash,
        &windows_dsh_home,
        overlay_for_provision,
        notify_url,
        {
            let progress = Arc::clone(&progress);
            move |event| progress(event)
        },
    )
    .await?;

    let host_overlay = notify.map(|server| HostOverlay {
        // Linux patch path is already on `wsl_paths.linux_patch`; Windows
        // `patch_file` is unused by `spawn_wsl_web_host`.
        patch_file: PathBuf::new(),
        notify_url: server.url.clone(),
    });

    progress(ProvisionEvent::Status(i18n::t(Msg::StatusStartWeb).into()));
    let host = spawn_wsl_web_host(&wsl_paths, host_overlay.as_ref(), &runner).await?;
    Ok(DesktopRuntime::start_wsl(host, wsl_paths))
}

fn splash_eval(app: &AppHandle, script: &str) -> Result<(), String> {
    if let Some(splash) = app.get_webview_window("splash") {
        splash.eval(script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}
