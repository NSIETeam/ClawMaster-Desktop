//! Apply approved updater selections while the desktop owns the stopped Host lifecycle.

use std::process::Stdio;
use std::time::Duration;

use super::provision::RuntimePaths;

/// The helper is part of the provisioned, verified desktop bundle, never the candidate component.
pub async fn before_host_start(paths: &RuntimePaths) -> Result<(), String> {
    let helper = paths.harness_root.join("frontends/updates/dist/maintenance.mjs");
    if !helper.is_file() {
        return Err("The installed runtime is missing the component maintenance helper; repair this desktop installation".into());
    }
    let mut command = tokio::process::Command::new(&paths.node_binary);
    command.arg(&helper).arg("--dsh-home").arg(&paths.dsh_home)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| format!("Cannot start component maintenance: {error}"))?;
    let status = match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
        Ok(result) => result.map_err(|error| format!("Cannot collect component maintenance result: {error}"))?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err("Component maintenance timed out; the Host was not started".into());
        }
    };
    if !status.success() {
        return Err(format!("Component maintenance failed ({status}); the Host was not started. Review the desktop boot log before retrying."));
    }
    Ok(())
}
