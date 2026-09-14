use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use url::Url;

const MAX_PROBE_OUTPUT_BYTES: usize = 4 * 1024;

#[derive(Clone)]
pub struct Candidate {
    pub id: &'static str,
    pub label: &'static str,
    pub executable: PathBuf,
    pub webdriver_contract: bool,
}

pub struct OwnedBrowser {
    child: Box<dyn process_wrap::std::ChildWrapper>,
}

impl OwnedBrowser {
    pub fn terminate(&mut self) -> Result<(), String> {
        if self
            .child
            .try_wait()
            .map_err(|error| format!("检查 owned browser 进程树失败: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        self.child
            .kill()
            .map_err(|error| format!("终止 owned browser 进程树失败: {error}"))?;
        self.child
            .wait()
            .map(|_| ())
            .map_err(|error| format!("等待 owned browser 进程树退出失败: {error}"))
    }

    #[cfg(all(test, unix))]
    pub(super) fn id(&self) -> u32 {
        self.child.id()
    }

    #[cfg(all(test, unix))]
    fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout().take()
    }
}

impl Drop for OwnedBrowser {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

pub fn candidates() -> Vec<Candidate> {
    #[cfg(target_os = "macos")]
    {
        vec![
            Candidate {
                id: "chrome",
                label: "Google Chrome",
                executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
                webdriver_contract: false,
            },
            Candidate {
                id: "edge",
                label: "Microsoft Edge",
                executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
                webdriver_contract: false,
            },
            Candidate {
                id: "safari-webdriver",
                label: "Safari WebDriver",
                executable: "/usr/bin/safaridriver".into(),
                webdriver_contract: true,
            },
        ]
    }
    #[cfg(target_os = "windows")]
    {
        let mut roots = ["PROGRAMFILES", "PROGRAMFILES(X86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        if let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(root);
        }
        vec![
            Candidate {
                id: "edge",
                label: "Microsoft Edge",
                executable: first_existing(&roots, "Microsoft/Edge/Application/msedge.exe"),
                webdriver_contract: false,
            },
            Candidate {
                id: "chrome",
                label: "Google Chrome",
                executable: first_existing(&roots, "Google/Chrome/Application/chrome.exe"),
                webdriver_contract: false,
            },
        ]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn first_existing(roots: &[PathBuf], suffix: &str) -> PathBuf {
    roots
        .iter()
        .map(|root| root.join(suffix))
        .find(|path| path.is_file())
        .or_else(|| roots.first().map(|root| root.join(suffix)))
        .unwrap_or_else(|| PathBuf::from(suffix))
}

pub fn select(id: Option<&str>) -> Result<Candidate, String> {
    let available = candidates();
    if let Some(id) = id {
        return available
            .into_iter()
            .find(|candidate| candidate.id == id && candidate.executable.is_file())
            .ok_or_else(|| format!("系统浏览器 {id} 未安装"));
    }
    available
        .into_iter()
        .find(|candidate| !candidate.webdriver_contract && candidate.executable.is_file())
        .ok_or_else(|| "未找到受支持的系统 Chrome 或 Edge，请先安装浏览器".into())
}

pub fn probe_webdriver(id: &str) -> Result<String, String> {
    let candidate = candidates()
        .into_iter()
        .find(|candidate| candidate.id == id && candidate.webdriver_contract)
        .ok_or_else(|| format!("未知系统 WebDriver adapter: {id}"))?;
    if !candidate.executable.is_file() {
        return Err(format!("系统 WebDriver {id} 未安装"));
    }
    let output = Command::new(&candidate.executable)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法探测系统 WebDriver {id}: {error}"))?;
    if !output.status.success() {
        return Err(format!("系统 WebDriver {id} 契约探针失败"));
    }
    let bytes = if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    };
    let bounded = &bytes[..bytes.len().min(MAX_PROBE_OUTPUT_BYTES)];
    let version = String::from_utf8_lossy(bounded).trim().to_string();
    if version.is_empty() {
        return Err(format!("系统 WebDriver {id} 未返回版本"));
    }
    Ok(version)
}

pub fn validate_navigation_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "RPA URL 无效".to_string())?;
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("RPA 仅允许 HTTPS 或 loopback 测试地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("RPA URL 不得包含凭据".into());
    }
    Ok(())
}

pub fn profile_path(root: &Path, tenant_id: &str, platform_id: &str, browser: &str) -> PathBuf {
    root.join(safe_segment(tenant_id))
        .join(safe_segment(platform_id))
        .join(browser)
}

pub fn ensure_profile_path(
    root: &Path,
    tenant_id: &str,
    platform_id: &str,
    browser: &str,
) -> Result<PathBuf, String> {
    validate_directory(root, root, "RPA profile 根")?;
    let profile = profile_path(root, tenant_id, platform_id, browser);
    let platform = profile
        .parent()
        .ok_or_else(|| "RPA browser profile 缺少父目录".to_string())?
        .to_path_buf();
    let tenant = platform
        .parent()
        .ok_or_else(|| "RPA platform profile 缺少父目录".to_string())?
        .to_path_buf();
    ensure_direct_child(root, &tenant, "RPA tenant profile")?;
    ensure_direct_child(&tenant, &platform, "RPA platform profile")?;
    ensure_direct_child(&platform, &profile, "RPA browser profile")?;
    Ok(profile)
}

fn ensure_direct_child(parent: &Path, path: &Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|error| format!("无法创建{label}: {error}"))?;
        }
        Err(error) => return Err(format!("无法检查{label}: {error}")),
    }
    validate_directory(parent, path, label)
}

fn validate_directory(parent: &Path, path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("无法检查{label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}必须是非符号链接目录"));
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("无法解析{label}父目录: {error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("无法解析{label}: {error}"))?;
    if path != parent && canonical_path.parent() != Some(canonical_parent.as_path()) {
        return Err(format!("{label}逃逸 profile 根目录"));
    }
    Ok(())
}

pub fn spawn(candidate: &Candidate, profile: &Path, url: &str) -> Result<OwnedBrowser, String> {
    let mut command = Command::new(&candidate.executable);
    configure_browser_command(&mut command, profile, url);
    spawn_owned(command).map_err(|error| format!("无法启动系统浏览器 {}: {error}", candidate.label))
}

fn configure_browser_command(command: &mut Command, profile: &Path, url: &str) {
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-mode")
        .arg("--force-renderer-accessibility=complete")
        .arg("--new-window")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}

fn spawn_owned(command: Command) -> Result<OwnedBrowser, std::io::Error> {
    use process_wrap::std::CommandWrap;

    let mut wrapped = CommandWrap::from(command);
    #[cfg(unix)]
    wrapped.wrap(process_wrap::std::ProcessGroup::leader());
    #[cfg(windows)]
    wrapped.wrap(process_wrap::std::JobObject);
    wrapped.spawn().map(|child| OwnedBrowser { child })
}

#[cfg(all(test, unix))]
pub(super) fn spawn_test_browser() -> OwnedBrowser {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("sleep 30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    spawn_owned(command).expect("spawn owned test browser")
}

fn safe_segment(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_browser_enables_the_complete_accessibility_tree() {
        let mut command = Command::new("browser");
        configure_browser_command(&mut command, Path::new("profile"), "https://example.com");
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(arguments.contains(&"--force-renderer-accessibility=complete".to_string()));
    }

    #[test]
    fn profiles_are_tenant_and_platform_isolated_without_plaintext_names() {
        let first = safe_segment("tenant-a");
        let second = safe_segment("tenant-b");
        assert_ne!(first, second);
        assert!(!first.contains("tenant"));
        assert!(validate_navigation_url("https://example.com/path").is_ok());
        assert!(validate_navigation_url("http://example.com/path").is_err());
        assert!(validate_navigation_url("https://user:secret@example.com/").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn profile_creation_rejects_symlinked_roots_and_components() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let real_root = temporary.path().join("real");
        std::fs::create_dir(&real_root).unwrap();
        let linked_root = temporary.path().join("linked");
        symlink(&real_root, &linked_root).unwrap();
        assert!(ensure_profile_path(&linked_root, "tenant", "platform", "chrome").is_err());

        let tenant = real_root.join(safe_segment("tenant"));
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, &tenant).unwrap();
        assert!(ensure_profile_path(&real_root, "tenant", "platform", "chrome").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn safari_webdriver_contract_reports_the_system_version() {
        let version = probe_webdriver("safari-webdriver").unwrap();
        assert!(version.contains("Safari"));
    }

    #[cfg(unix)]
    #[test]
    fn terminating_owned_process_kills_its_descendant_group() {
        use std::io::{BufRead, BufReader};

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut owned = spawn_owned(command).unwrap();
        let parent = owned.id();
        let mut child_line = String::new();
        BufReader::new(owned.take_stdout().unwrap())
            .read_line(&mut child_line)
            .unwrap();
        let child = child_line.trim().parse::<u32>().unwrap();
        owned.terminate().unwrap();
        assert!(!pid_exists(parent));
        assert!(!pid_exists(child));
    }

    #[cfg(unix)]
    fn pid_exists(pid: u32) -> bool {
        Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }
}
