use crate::native_models::{ModelToolCall, ModelToolDefinition};
use crate::native_state_store::{
    ArtifactMetadata, ArtifactRef, NativeStateStore, TREE_ARTIFACT_METADATA, TREE_EVENTS,
    TREE_INDEX,
};
use crate::native_tools;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

mod browser;
mod semantic;

const RPA_INDEX_ID: &str = "native-rpa-index-v1";
const MAX_TARGET_SUMMARY_CHARS: usize = 500;

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "opencli".into(),
            description: "EasyCode OpenCLI compatibility surface backed only by ClawMaster's Rust-native, approval-gated system-browser RPA. Supports help, doctor, version, and browser session open/state/close; use the returned typed rpa_* tools for semantic page actions. External Node binaries and Chrome extensions are never launched.".into(),
            parameters: json!({"type":"object","properties":{
                "args":{"type":"array","items":{"type":"string"},"minItems":1},
                "timeout":{"type":"number","minimum":5,"maximum":120},
                "binaryPath":{"type":"string"}
            },"required":["args"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_browser_support".into(),
            description: "List installed system browsers supported by the Rust RPA driver. ClawMaster never downloads or bundles Chromium.".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_webdriver_probe".into(),
            description: "Run a bounded read-only version contract probe against an installed system WebDriver adapter such as Safari WebDriver.".into(),
            parameters: json!({"type":"object","properties":{
                "adapter":{"type":"string","enum":["safari-webdriver"]}
            },"required":["adapter"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_start".into(),
            description: "Start a visible system Chrome or Edge window with a ClawMaster-owned tenant/platform-isolated profile. Requires approval.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"tenantId":{"type":"string"},"platformId":{"type":"string"},
                "browser":{"type":"string","enum":["chrome","edge"]},"url":{"type":"string"}
            },"required":["runId","tenantId","platformId","url"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_windows".into(),
            description: "List system windows as bounded semantic references and bind the inventory to an encrypted artifact. The model selects a window reference, never a process ID or coordinate.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"}
            },"required":["runId","stepId"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_snapshot".into(),
            description: "Capture one selected system window as a bounded semantic accessibility snapshot. The window reference must come from a bound encrypted rpa_windows artifact.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},
                "windowsArtifactId":{"type":"string"},"windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"}
            },"required":["runId","stepId","windowsArtifactId","windowRef"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_screenshot".into(),
            description: "Capture one selected system window as PNG and store it only as an encrypted artifact. The model receives an artifact reference, not inline pixels.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},
                "windowsArtifactId":{"type":"string"},"windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"}
            },"required":["runId","stepId","windowsArtifactId","windowRef"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_focus".into(),
            description: "Focus one bound system window through its accessibility element without accepting a process ID or coordinate. Requires approval.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"windowsArtifactId":{"type":"string"},
                "windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"},"targetSummary":{"type":"string","maxLength":500}
            },"required":["runId","stepId","windowsArtifactId","windowRef","targetSummary"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_click".into(),
            description: "Perform a real OS mouse click bound to a prior semantic snapshot artifact. External submit/publish/delete actions require approval and are never blindly replayed.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "elementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"},"targetSummary":{"type":"string","maxLength":500},
                "externalSideEffect":{"type":"boolean"}
            },"required":["runId","stepId","snapshotArtifactId","elementRef","targetSummary","externalSideEffect"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_extract".into(),
            description: "Extract one bounded element record from a bound semantic snapshot. This is deterministic and never queries the live desktop by coordinates.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "elementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"}
            },"required":["runId","stepId","snapshotArtifactId","elementRef"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_drag".into(),
            description: "Perform a real OS drag between two visible elements from the same bound encrypted semantic snapshot. The model never supplies coordinates. Requires approval.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "fromElementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"},"toElementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"},
                "targetSummary":{"type":"string","maxLength":500}
            },"required":["runId","stepId","snapshotArtifactId","fromElementRef","toElementRef","targetSummary"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_fill".into(),
            description: "Focus a semantic text element with a real OS mouse click, select its current value, and type non-secret text through native keyboard input. Secrets must use a future keychain reference and are rejected here.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "elementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"},"text":{"type":"string","maxLength":2000},
                "targetSummary":{"type":"string","maxLength":500},"sensitive":{"type":"boolean","const":false}
            },"required":["runId","stepId","snapshotArtifactId","elementRef","text","targetSummary","sensitive"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_scroll".into(),
            description: "Scroll inside one bound system window through native input without accepting model-provided coordinates. Requires approval and a window reference from an encrypted rpa_windows artifact.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"windowsArtifactId":{"type":"string"},
                "windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"},"amount":{"type":"integer","minimum":-100,"maximum":100,"description":"Signed wheel ticks: negative moves the viewport down; positive moves it up."},
                "targetSummary":{"type":"string","maxLength":500}
            },"required":["runId","stepId","windowsArtifactId","windowRef","amount","targetSummary"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_wait".into(),
            description: "Wait up to 10 seconds for bounded text to appear in one selected window. It is cancellation-aware and returns a fresh encrypted semantic snapshot on success.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"windowsArtifactId":{"type":"string"},
                "windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"},"matchText":{"type":"string","minLength":1,"maxLength":200},
                "timeoutMs":{"type":"integer","minimum":100,"maximum":10000}
            },"required":["runId","stepId","windowsArtifactId","windowRef","matchText","timeoutMs"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_status".into(),
            description: "Read one durable RPA run and its receipts.".into(),
            parameters: json!({"type":"object","properties":{"runId":{"type":"string"}},"required":["runId"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_cancel".into(),
            description: "Cancel one ClawMaster-owned browser session without closing user-owned browsers. Requires approval.".into(),
            parameters: json!({"type":"object","properties":{"runId":{"type":"string"}},"required":["runId"],"additionalProperties":false}),
        },
    ]
}

pub fn contains(name: &str) -> bool {
    matches!(
        name,
        "opencli"
            | "rpa_browser_support"
            | "rpa_webdriver_probe"
            | "rpa_start"
            | "rpa_windows"
            | "rpa_snapshot"
            | "rpa_screenshot"
            | "rpa_focus"
            | "rpa_click"
            | "rpa_extract"
            | "rpa_drag"
            | "rpa_fill"
            | "rpa_scroll"
            | "rpa_wait"
            | "rpa_status"
            | "rpa_cancel"
    )
}

pub fn is_write(name: &str) -> bool {
    matches!(
        name,
        "rpa_start"
            | "rpa_screenshot"
            | "rpa_focus"
            | "rpa_click"
            | "rpa_drag"
            | "rpa_fill"
            | "rpa_scroll"
            | "rpa_cancel"
    )
}

pub fn is_write_call(call: &ModelToolCall) -> bool {
    if call.name != "opencli" {
        return is_write(&call.name);
    }
    let args = call
        .arguments
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        return false;
    }
    match args.first().map(String::as_str) {
        Some("help" | "doctor" | "version" | "--version" | "-v") => false,
        Some("browser") => !matches!(args.get(2).map(String::as_str), Some("state")),
        _ => true,
    }
}

pub fn approval_summary(call: &ModelToolCall) -> String {
    let target = call
        .arguments
        .get("targetSummary")
        .and_then(Value::as_str)
        .or_else(|| call.arguments.get("url").and_then(Value::as_str))
        .or_else(|| call.arguments.get("runId").and_then(Value::as_str))
        .unwrap_or("未提供目标");
    format!(
        "允许 RPA 执行 {}？目标：{}",
        call.name,
        target
            .chars()
            .take(MAX_TARGET_SUMMARY_CHARS)
            .collect::<String>()
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpaRunState {
    Pending,
    Running,
    AwaitingApproval,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    UnknownOutcome,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpaStepState {
    Pending,
    Started,
    Succeeded,
    Failed,
    Rejected,
    UnknownOutcome,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaReceipt {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub state: RpaStepState,
    pub idempotency_key: String,
    pub action: String,
    pub target_summary: String,
    pub external_side_effect: bool,
    pub approval_id: Option<String>,
    pub artifact_ids: Vec<String>,
    pub error: Option<String>,
    pub started_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaRun {
    pub id: String,
    pub tenant_id: String,
    pub platform_id: String,
    pub browser: String,
    pub profile_path: String,
    pub state: RpaRunState,
    pub current_step_id: Option<String>,
    pub receipts: Vec<RpaReceipt>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaSnapshotResult {
    pub run: RpaRun,
    pub artifact: ArtifactRef,
    pub snapshot: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaWindowInventoryResult {
    pub run: RpaRun,
    pub artifact: ArtifactRef,
    pub inventory: semantic::WindowInventory,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaScreenshotResult {
    pub run: RpaRun,
    pub artifact: ArtifactRef,
    pub media_type: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct RpaIndex {
    run_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSupport {
    pub id: String,
    pub label: String,
    pub executable: Option<String>,
    pub installed: bool,
    pub webdriver_contract: bool,
}

pub struct NativeRpa {
    root: PathBuf,
    store: NativeStateStore,
    owned_browsers: Mutex<BTreeMap<String, browser::OwnedBrowser>>,
}

impl NativeRpa {
    pub fn open(root: &Path, store: NativeStateStore) -> Result<Self, String> {
        std::fs::create_dir_all(root)
            .map_err(|error| format!("无法创建 RPA profile 目录: {error}"))?;
        let metadata = std::fs::symlink_metadata(root)
            .map_err(|error| format!("无法检查 RPA profile 目录: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("RPA profile 根必须是非符号链接目录".into());
        }
        let root = root
            .canonicalize()
            .map_err(|error| format!("无法解析 RPA profile 目录: {error}"))?;
        let controller = Self {
            root,
            store,
            owned_browsers: Mutex::new(BTreeMap::new()),
        };
        controller.recover_interrupted()?;
        Ok(controller)
    }

    pub fn browser_support(&self) -> Vec<BrowserSupport> {
        browser::candidates()
            .into_iter()
            .map(|candidate| BrowserSupport {
                id: candidate.id.into(),
                label: candidate.label.into(),
                installed: candidate.executable.is_file(),
                executable: candidate
                    .executable
                    .is_file()
                    .then(|| candidate.executable.to_string_lossy().into_owned()),
                webdriver_contract: candidate.webdriver_contract,
            })
            .collect()
    }

    pub fn launch(
        &self,
        run_id: &str,
        tenant_id: &str,
        platform_id: &str,
        browser: Option<&str>,
        url: &str,
    ) -> Result<RpaRun, String> {
        validate_id(run_id, "run")?;
        validate_id(tenant_id, "tenant")?;
        validate_id(platform_id, "platform")?;
        browser::validate_navigation_url(url)?;
        let rejected_placeholder = reusable_rejected_placeholder(self.load(run_id)?)?;
        let candidate = browser::select(browser)?;
        if candidate.webdriver_contract {
            return Err(
                "Safari 只提供系统 WebDriver adapter，不能作为 xa11y owned Chrome 会话启动".into(),
            );
        }
        let profile =
            browser::ensure_profile_path(&self.root, tenant_id, platform_id, candidate.id)?;
        let child = browser::spawn(&candidate, &profile, url)?;
        let timestamp = now_ms();
        let run = RpaRun {
            id: run_id.into(),
            tenant_id: tenant_id.into(),
            platform_id: platform_id.into(),
            browser: candidate.id.into(),
            profile_path: profile.to_string_lossy().into_owned(),
            state: RpaRunState::Running,
            current_step_id: None,
            receipts: rejected_placeholder
                .as_ref()
                .map_or_else(Vec::new, |run| run.receipts.clone()),
            created_at: rejected_placeholder
                .as_ref()
                .map_or(timestamp, |run| run.created_at),
            updated_at: timestamp,
        };
        self.save(&run)?;
        self.owned_browsers
            .lock()
            .map_err(|_| "RPA owned browser 锁已损坏".to_string())?
            .insert(run.id.clone(), child);
        Ok(run)
    }

    pub fn windows(&self, run_id: &str, step_id: &str) -> Result<RpaWindowInventoryResult, String> {
        let mut run = self.required_run(run_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.windows",
            "系统窗口清单",
            false,
            None,
        )?;
        let inventory = match semantic::inventory() {
            Ok(inventory) => inventory,
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
        };
        let bytes = serde_json::to_vec(&inventory).map_err(|error| error.to_string())?;
        let artifact = self
            .store
            .put_artifact(&format!("rpa-windows-{run_id}-{step_id}"), &bytes)
            .map_err(|error| error.to_string())?;
        complete_receipt(&mut run, receipt_index, Some(&artifact));
        self.save(&run)?;
        Ok(RpaWindowInventoryResult {
            run,
            artifact,
            inventory,
        })
    }

    pub fn snapshot(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
    ) -> Result<RpaSnapshotResult, String> {
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.snapshot",
            window_ref,
            false,
            None,
        )?;
        let snapshot = match semantic::snapshot(&inventory, window_ref) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
        };
        let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
        let artifact = self
            .store
            .put_artifact(&format!("rpa-snapshot-{run_id}-{step_id}"), &bytes)
            .map_err(|error| error.to_string())?;
        complete_receipt(&mut run, receipt_index, Some(&artifact));
        self.save(&run)?;
        Ok(RpaSnapshotResult {
            run,
            artifact,
            snapshot,
        })
    }

    pub fn screenshot(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
    ) -> Result<RpaScreenshotResult, String> {
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.screenshot",
            window_ref,
            false,
            None,
        )?;
        let bytes = match semantic::screenshot_png(&inventory, window_ref) {
            Ok(bytes) => bytes,
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
        };
        let artifact = self
            .store
            .put_artifact(&format!("rpa-screenshot-{run_id}-{step_id}.png"), &bytes)
            .map_err(|error| error.to_string())?;
        complete_receipt(&mut run, receipt_index, Some(&artifact));
        self.save(&run)?;
        Ok(RpaScreenshotResult {
            run,
            artifact,
            media_type: "image/png".into(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn focus(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
        target_summary: &str,
        approval_id: Option<&str>,
    ) -> Result<RpaRun, String> {
        let mut run = self.required_run(run_id)?;
        if approval_id.is_none() {
            return self.reject_step(
                run,
                step_id,
                "desktop.focus",
                target_summary,
                "窗口聚焦缺少 approval binding",
            );
        }
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.focus",
            target_summary,
            false,
            approval_id,
        )?;
        let result = semantic::focus_window(&inventory, window_ref);
        self.persist_input_result(run, receipt_index, result, false)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn click(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        element_ref: &str,
        target_summary: &str,
        approval_id: Option<&str>,
        external_side_effect: bool,
    ) -> Result<RpaRun, String> {
        let mut run = self.required_run(run_id)?;
        if external_side_effect && approval_id.is_none() {
            return self.reject_step(
                run,
                step_id,
                "desktop.click",
                target_summary,
                "外部点击缺少 approval binding",
            );
        }
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let (x, y) = self.resolve_element(snapshot_artifact_id, element_ref)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.click",
            target_summary,
            external_side_effect,
            approval_id,
        )?;
        let result = native_tools::input_tool(&[
            "click".into(),
            x.to_string(),
            y.to_string(),
            "left".into(),
            "single".into(),
        ]);
        self.persist_input_result(run, receipt_index, result, external_side_effect)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn drag(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        from_element_ref: &str,
        to_element_ref: &str,
        target_summary: &str,
        approval_id: Option<&str>,
    ) -> Result<RpaRun, String> {
        let mut run = self.required_run(run_id)?;
        if approval_id.is_none() {
            return self.reject_step(
                run,
                step_id,
                "desktop.drag",
                target_summary,
                "原生拖拽缺少 approval binding",
            );
        }
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let (from_x, from_y) = self.resolve_element(snapshot_artifact_id, from_element_ref)?;
        let (to_x, to_y) = self.resolve_element(snapshot_artifact_id, to_element_ref)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.drag",
            target_summary,
            true,
            approval_id,
        )?;
        let result = native_tools::input_tool(&[
            "drag".into(),
            from_x.to_string(),
            from_y.to_string(),
            to_x.to_string(),
            to_y.to_string(),
        ]);
        self.persist_input_result(run, receipt_index, result, true)
    }

    pub fn extract(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        element_ref: &str,
    ) -> Result<Value, String> {
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.extract",
            element_ref,
            false,
            None,
        )?;
        let element = self.resolve_element_record(snapshot_artifact_id, element_ref)?;
        complete_receipt(&mut run, receipt_index, None);
        self.save(&run)?;
        Ok(json!({"run":run,"element":element}))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        element_ref: &str,
        text: &str,
        target_summary: &str,
        sensitive: bool,
        approval_id: Option<&str>,
    ) -> Result<RpaRun, String> {
        if sensitive {
            return Err(
                "RPA 不允许把 secret 明文放入模型工具参数；请使用系统 Keychain 引用".into(),
            );
        }
        if text.chars().count() > 2_000 {
            return Err("RPA 输入文本超过 2000 字符上限".into());
        }
        let mut run = self.required_run(run_id)?;
        if approval_id.is_none() {
            return self.reject_step(
                run,
                step_id,
                "desktop.fill",
                target_summary,
                "原生文本输入缺少 approval binding",
            );
        }
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let (x, y) = self.resolve_element(snapshot_artifact_id, element_ref)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.fill",
            target_summary,
            true,
            approval_id,
        )?;
        let select_all = if cfg!(target_os = "macos") {
            "meta+a"
        } else {
            "ctrl+a"
        };
        let result = native_tools::input_tool(&[
            "click".into(),
            x.to_string(),
            y.to_string(),
            "left".into(),
            "single".into(),
        ])
        .and_then(|_| native_tools::input_tool(&["hotkey".into(), select_all.into()]))
        .and_then(|_| native_tools::input_tool(&["type".into(), text.into()]));
        self.persist_input_result(run, receipt_index, result, true)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn scroll(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
        amount: i64,
        target_summary: &str,
        approval_id: Option<&str>,
    ) -> Result<RpaRun, String> {
        if amount == 0 || !(-100..=100).contains(&amount) {
            return Err("RPA scroll amount 必须为 -100 到 100 之间的非零滚轮刻度".into());
        }
        let mut run = self.required_run(run_id)?;
        if approval_id.is_none() {
            return self.reject_step(
                run,
                step_id,
                "desktop.scroll",
                target_summary,
                "原生滚动缺少 approval binding",
            );
        }
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let (x, y) = semantic::window_center(&inventory, window_ref)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.scroll",
            target_summary,
            false,
            approval_id,
        )?;
        let result = native_tools::input_tool(&[
            "scroll".into(),
            amount.to_string(),
            x.to_string(),
            y.to_string(),
        ]);
        self.persist_input_result(run, receipt_index, result, false)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn wait(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
        match_text: &str,
        timeout_ms: u64,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<RpaSnapshotResult, String> {
        if match_text.trim().is_empty() || match_text.chars().count() > 200 {
            return Err("RPA wait matchText 必须为 1-200 个字符".into());
        }
        if !(100..=10_000).contains(&timeout_ms) {
            return Err("RPA wait timeoutMs 必须为 100-10000".into());
        }
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let receipt_index =
            self.start_step(&mut run, step_id, "desktop.wait", match_text, false, None)?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if *cancel.borrow() {
                cancel_receipt(&mut run, receipt_index, "用户取消了 RPA wait");
                self.save(&run)?;
                return Err("用户取消了 RPA wait".into());
            }
            let snapshot = match semantic::snapshot(&inventory, window_ref) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    fail_receipt(&mut run, receipt_index, &error, false);
                    self.save(&run)?;
                    return Err(error);
                }
            };
            if semantic::contains_text(&snapshot, match_text) {
                let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
                let artifact = self
                    .store
                    .put_artifact(&format!("rpa-wait-{run_id}-{step_id}"), &bytes)
                    .map_err(|error| error.to_string())?;
                complete_receipt(&mut run, receipt_index, Some(&artifact));
                self.save(&run)?;
                return Ok(RpaSnapshotResult {
                    run,
                    artifact,
                    snapshot,
                });
            }
            if Instant::now() >= deadline {
                let error = format!("等待窗口文本超时: {match_text}");
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                changed = cancel.changed() => {
                    if changed.is_ok() && *cancel.borrow() {
                        cancel_receipt(&mut run, receipt_index, "用户取消了 RPA wait");
                        self.save(&run)?;
                        return Err("用户取消了 RPA wait".into());
                    }
                }
            }
        }
    }

    pub fn cancel(&self, run_id: &str, approval_id: Option<&str>) -> Result<RpaRun, String> {
        let mut run = self.required_run(run_id)?;
        if approval_id.is_none() {
            return self.reject_step(
                run,
                "cancel",
                "browser.cancel",
                "owned browser session",
                "取消 owned browser 缺少 approval binding",
            );
        }
        if run.state == RpaRunState::Cancelled
            && !self
                .owned_browsers
                .lock()
                .map_err(|_| "RPA owned browser 锁已损坏".to_string())?
                .contains_key(run_id)
        {
            return Ok(run);
        }
        let mut had_unknown_outcome = false;
        if let Some(current) = run.current_step_id.take() {
            if let Some(receipt) = run
                .receipts
                .iter_mut()
                .rev()
                .find(|item| item.step_id == current && item.state == RpaStepState::Started)
            {
                receipt.state = if receipt.external_side_effect {
                    had_unknown_outcome = true;
                    RpaStepState::UnknownOutcome
                } else {
                    RpaStepState::Failed
                };
                receipt.error = Some("用户取消了 owned browser session".into());
                receipt.completed_at = Some(now_ms());
            }
        }
        // Cleanup must remain possible after a failed or uncertain step. The
        // prior state is retained through had_unknown_outcome below.
        if !matches!(run.state, RpaRunState::Running | RpaRunState::Pending) {
            had_unknown_outcome |= run.state == RpaRunState::UnknownOutcome;
            run.state = RpaRunState::Running;
        }
        let receipt_index = self.start_step(
            &mut run,
            "cancel",
            "browser.cancel",
            "owned browser session",
            true,
            approval_id,
        )?;
        if let Some(mut child) = self
            .owned_browsers
            .lock()
            .map_err(|_| "RPA owned browser 锁已损坏".to_string())?
            .remove(run_id)
        {
            if let Err(error) = child.terminate() {
                fail_receipt(&mut run, receipt_index, &error, true);
                self.save(&run)?;
                return Err(error);
            }
        }
        complete_receipt(&mut run, receipt_index, None);
        run.state = if had_unknown_outcome
            || run
                .receipts
                .iter()
                .any(|receipt| receipt.state == RpaStepState::UnknownOutcome)
        {
            RpaRunState::UnknownOutcome
        } else {
            RpaRunState::Cancelled
        };
        run.current_step_id = None;
        self.save(&run)?;
        Ok(run)
    }

    pub fn cleanup_failed_run(&self, run_id: &str) -> Result<(), String> {
        let child = self
            .owned_browsers
            .lock()
            .map_err(|_| "RPA owned browser 锁已损坏".to_string())?
            .remove(run_id);
        if let Some(mut child) = child {
            child.terminate()?;
        }
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let children = {
            let mut children = self
                .owned_browsers
                .lock()
                .map_err(|_| "RPA owned browser 锁已损坏".to_string())?;
            std::mem::take(&mut *children)
        };
        let mut failures = Vec::new();
        for (run_id, mut child) in children {
            let outcome = child.terminate();
            if let Err(error) = self.record_shutdown(&run_id, outcome.as_ref().err()) {
                failures.push(error);
            }
            if let Err(error) = outcome {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    pub fn get(&self, run_id: &str) -> Result<Option<RpaRun>, String> {
        self.load(run_id)
    }

    fn resolve_element(&self, artifact_id: &str, element_ref: &str) -> Result<(i32, i32), String> {
        let snapshot: Value = self.read_artifact(artifact_id)?;
        let element = snapshot
            .get("elements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|element| element.get("ref").and_then(Value::as_str) == Some(element_ref))
            .ok_or_else(|| "RPA 元素引用不属于绑定快照".to_string())?;
        let bounds = element
            .get("bounds")
            .ok_or_else(|| "RPA 元素没有可点击边界".to_string())?;
        let center = (
            bounded_coordinate(bounds, "centerX")?,
            bounded_coordinate(bounds, "centerY")?,
        );
        let element_width = bounded_coordinate(bounds, "width")?;
        let element_height = bounded_coordinate(bounds, "height")?;
        if element_width <= 0 || element_height <= 0 {
            return Err("RPA 元素没有可点击的可视面积，请滚动并重新获取快照".into());
        }
        let window = snapshot
            .pointer("/activeWindow/bounds")
            .ok_or_else(|| "RPA 快照缺少绑定窗口边界".to_string())?;
        let left = i64::from(bounded_coordinate(window, "x")?);
        let top = i64::from(bounded_coordinate(window, "y")?);
        let window_width = bounded_coordinate(window, "width")?;
        let window_height = bounded_coordinate(window, "height")?;
        if window_width <= 0 || window_height <= 0 {
            return Err("RPA 快照中的绑定窗口没有可用面积".into());
        }
        let right = left + i64::from(window_width);
        let bottom = top + i64::from(window_height);
        if !(left..right).contains(&i64::from(center.0))
            || !(top..bottom).contains(&i64::from(center.1))
        {
            return Err("RPA 元素位于绑定窗口可视边界之外，请滚动并重新获取快照".into());
        }
        Ok(center)
    }

    fn resolve_element_record(
        &self,
        artifact_id: &str,
        element_ref: &str,
    ) -> Result<Value, String> {
        let snapshot: Value = self.read_artifact(artifact_id)?;
        snapshot
            .get("elements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|element| element.get("ref").and_then(Value::as_str) == Some(element_ref))
            .cloned()
            .ok_or_else(|| "RPA 元素引用不属于绑定快照".to_string())
    }

    fn read_artifact<T: for<'de> Deserialize<'de>>(&self, artifact_id: &str) -> Result<T, String> {
        let metadata = self
            .store
            .get::<ArtifactMetadata>(TREE_ARTIFACT_METADATA, artifact_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "RPA 快照 artifact 不存在".to_string())?;
        let bytes = self
            .store
            .read_artifact(&ArtifactRef {
                sha256: metadata.payload.sha256,
                byte_length: metadata.payload.byte_length,
            })
            .map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "RPA 加密 artifact 已损坏".to_string())
    }

    fn require_bound_artifact(
        &self,
        run: &RpaRun,
        artifact_id: &str,
        label: &str,
    ) -> Result<(), String> {
        if artifact_id.len() == 64
            && run
                .receipts
                .iter()
                .any(|receipt| receipt.artifact_ids.iter().any(|id| id == artifact_id))
        {
            Ok(())
        } else {
            Err(format!("RPA {label} artifact 未绑定当前 run"))
        }
    }

    pub async fn execute(
        &self,
        call: &ModelToolCall,
        approval_id: Option<&str>,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, String> {
        let text = |name: &str| {
            call.arguments
                .get(name)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("RPA 参数 {name} 缺失"))
        };
        match call.name.as_str() {
            "opencli" => self.execute_opencli(call, approval_id),
            "rpa_browser_support" => {
                serde_json::to_value(self.browser_support()).map_err(|error| error.to_string())
            }
            "rpa_webdriver_probe" => Ok(json!({
                "adapter":text("adapter")?,
                "version":browser::probe_webdriver(text("adapter")?)?
            })),
            "rpa_start" => serde_json::to_value(self.launch(
                text("runId")?,
                text("tenantId")?,
                text("platformId")?,
                call.arguments.get("browser").and_then(Value::as_str),
                text("url")?,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_windows" => serde_json::to_value(self.windows(text("runId")?, text("stepId")?)?)
                .map_err(|error| error.to_string()),
            "rpa_snapshot" => serde_json::to_value(self.snapshot(
                text("runId")?,
                text("stepId")?,
                text("windowsArtifactId")?,
                text("windowRef")?,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_screenshot" => serde_json::to_value(self.screenshot(
                text("runId")?,
                text("stepId")?,
                text("windowsArtifactId")?,
                text("windowRef")?,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_focus" => serde_json::to_value(self.focus(
                text("runId")?,
                text("stepId")?,
                text("windowsArtifactId")?,
                text("windowRef")?,
                text("targetSummary")?,
                approval_id,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_click" => serde_json::to_value(
                self.click(
                    text("runId")?,
                    text("stepId")?,
                    text("snapshotArtifactId")?,
                    text("elementRef")?,
                    text("targetSummary")?,
                    approval_id,
                    call.arguments
                        .get("externalSideEffect")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?,
            )
            .map_err(|error| error.to_string()),
            "rpa_extract" => self.extract(
                text("runId")?,
                text("stepId")?,
                text("snapshotArtifactId")?,
                text("elementRef")?,
            ),
            "rpa_drag" => serde_json::to_value(self.drag(
                text("runId")?,
                text("stepId")?,
                text("snapshotArtifactId")?,
                text("fromElementRef")?,
                text("toElementRef")?,
                text("targetSummary")?,
                approval_id,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_fill" => serde_json::to_value(
                self.fill(
                    text("runId")?,
                    text("stepId")?,
                    text("snapshotArtifactId")?,
                    text("elementRef")?,
                    text("text")?,
                    text("targetSummary")?,
                    call.arguments
                        .get("sensitive")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    approval_id,
                )?,
            )
            .map_err(|error| error.to_string()),
            "rpa_scroll" => serde_json::to_value(
                self.scroll(
                    text("runId")?,
                    text("stepId")?,
                    text("windowsArtifactId")?,
                    text("windowRef")?,
                    call.arguments
                        .get("amount")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    text("targetSummary")?,
                    approval_id,
                )?,
            )
            .map_err(|error| error.to_string()),
            "rpa_wait" => serde_json::to_value(
                self.wait(
                    text("runId")?,
                    text("stepId")?,
                    text("windowsArtifactId")?,
                    text("windowRef")?,
                    text("matchText")?,
                    call.arguments
                        .get("timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    cancel,
                )
                .await?,
            )
            .map_err(|error| error.to_string()),
            "rpa_status" => Ok(json!({"run":self.get(text("runId")?)?})),
            "rpa_cancel" => serde_json::to_value(self.cancel(text("runId")?, approval_id)?)
                .map_err(|error| error.to_string()),
            _ => Err("未知 RPA 工具".into()),
        }
    }

    fn execute_opencli(
        &self,
        call: &ModelToolCall,
        approval_id: Option<&str>,
    ) -> Result<Value, String> {
        if call.arguments.get("binaryPath").is_some() {
            return Err("Rust 迁移版 opencli 不启动外部 Node/CLI binaryPath".into());
        }
        if let Some(timeout) = call.arguments.get("timeout").and_then(Value::as_f64) {
            if !(5.0..=120.0).contains(&timeout) {
                return Err("opencli timeout 必须在 5 到 120 秒之间".into());
            }
        }
        let args = call
            .arguments
            .get("args")
            .and_then(Value::as_array)
            .ok_or_else(|| "opencli args 必须是非空字符串数组".to_string())?;
        let args = args
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.is_empty() && value.len() <= 2_000)
                    .ok_or_else(|| "opencli args 必须是非空且有界的字符串".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if args.is_empty() || args.len() > 64 {
            return Err("opencli args 必须包含 1 到 64 个参数".into());
        }
        if args.iter().any(|arg| matches!(*arg, "--help" | "-h")) || matches!(args[0], "help") {
            return Ok(opencli_help());
        }
        match args[0].to_ascii_lowercase().as_str() {
            "doctor" => Ok(json!({
                "status":"success",
                "runtime":"rust-native-rpa",
                "browsers":self.browser_support(),
                "nodeCli":false,
                "chromeExtension":false
            })),
            "version" | "--version" | "-v" => Ok(json!({
                "status":"success","name":"clawmaster-rust-opencli-compat","version":1
            })),
            "browser" => self.execute_opencli_browser(&args, approval_id),
            _ => Err("该 EasyCode OpenCLI 适配器命令尚未迁移；请使用 Rust 原生 web、飞书或 rpa_* 类型化工具".into()),
        }
    }

    fn execute_opencli_browser(
        &self,
        args: &[&str],
        approval_id: Option<&str>,
    ) -> Result<Value, String> {
        if args.len() < 3 {
            return Err("opencli browser 需要 session 和 verb".into());
        }
        let run_id = opencli_run_id(args[1])?;
        match args[2].to_ascii_lowercase().as_str() {
            "open" => {
                let url = args.get(3).ok_or_else(|| "open 需要 URL".to_string())?;
                if approval_id.is_none() {
                    return Err("opencli browser open 缺少审批绑定".into());
                }
                let run = self.launch(&run_id, "local", "opencli", None, url)?;
                Ok(json!({"status":"success","run":run,"nextTools":["rpa_windows","rpa_snapshot"]}))
            }
            "state" => Ok(json!({
                "status":"success",
                "run":self.get(&run_id)?,
                "nextTools":["rpa_windows","rpa_snapshot"],
                "note":"Use bounded semantic artifacts instead of stale OpenCLI numeric refs."
            })),
            "close" | "unbind" => {
                let run = self.cancel(&run_id, approval_id)?;
                Ok(json!({"status":"success","run":run}))
            }
            _ => Err("该 browser verb 已由 Rust rpa_snapshot/rpa_extract/rpa_click/rpa_fill/rpa_scroll/rpa_wait 替代；请按 state 返回的 nextTools 继续".into()),
        }
    }

    pub fn record_rejection(&self, call: &ModelToolCall, reason: &str) -> Result<Value, String> {
        if call.name == "opencli" {
            return Ok(json!({"status":"rejected","tool":"opencli","reason":reason}));
        }
        let run_id = call
            .arguments
            .get("runId")
            .and_then(Value::as_str)
            .ok_or_else(|| "RPA 拒绝记录缺少 runId".to_string())?;
        if call.name == "rpa_start" && self.load(run_id)?.is_none() {
            let timestamp = now_ms();
            let run = RpaRun {
                id: run_id.into(),
                tenant_id: call
                    .arguments
                    .get("tenantId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .chars()
                    .take(120)
                    .collect(),
                platform_id: call
                    .arguments
                    .get("platformId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .chars()
                    .take(120)
                    .collect(),
                browser: call
                    .arguments
                    .get("browser")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .into(),
                profile_path: String::new(),
                state: RpaRunState::Pending,
                current_step_id: None,
                receipts: Vec::new(),
                created_at: timestamp,
                updated_at: timestamp,
            };
            let rejected = self.reject_step(
                run,
                "launch",
                &call.name,
                call.arguments
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("system browser"),
                reason,
            )?;
            return serde_json::to_value(rejected).map_err(|error| error.to_string());
        }
        let run = self.required_run(run_id)?;
        let step_id = call
            .arguments
            .get("stepId")
            .and_then(Value::as_str)
            .unwrap_or(&call.name);
        serde_json::to_value(
            self.reject_step(
                run,
                step_id,
                &call.name,
                call.arguments
                    .get("targetSummary")
                    .and_then(Value::as_str)
                    .unwrap_or(run_id),
                reason,
            )?,
        )
        .map_err(|error| error.to_string())
    }

    fn start_step(
        &self,
        run: &mut RpaRun,
        step_id: &str,
        action: &str,
        target_summary: &str,
        external_side_effect: bool,
        approval_id: Option<&str>,
    ) -> Result<usize, String> {
        validate_id(step_id, "step")?;
        if !matches!(run.state, RpaRunState::Running | RpaRunState::Pending) {
            return Err("RPA run 当前不可执行步骤".into());
        }
        if run.receipts.iter().any(|receipt| {
            receipt.step_id == step_id
                && matches!(
                    receipt.state,
                    RpaStepState::Succeeded | RpaStepState::Started
                )
        }) {
            return Err("RPA step 已执行或结果未确认，拒绝重复副作用".into());
        }
        let attempt = run
            .receipts
            .iter()
            .filter(|receipt| receipt.step_id == step_id)
            .count() as u32
            + 1;
        let idempotency_key = format!(
            "rpa:{:x}",
            Sha256::digest(format!("{}:{step_id}:{attempt}", run.id).as_bytes())
        );
        run.receipts.push(RpaReceipt {
            run_id: run.id.clone(),
            step_id: step_id.into(),
            attempt,
            state: RpaStepState::Started,
            idempotency_key,
            action: action.into(),
            target_summary: target_summary
                .chars()
                .take(MAX_TARGET_SUMMARY_CHARS)
                .collect(),
            external_side_effect,
            approval_id: approval_id.map(str::to_owned),
            artifact_ids: Vec::new(),
            error: None,
            started_at: now_ms(),
            completed_at: None,
        });
        run.current_step_id = Some(step_id.into());
        run.updated_at = now_ms();
        self.save(run)?;
        Ok(run.receipts.len() - 1)
    }

    fn persist_input_result(
        &self,
        mut run: RpaRun,
        receipt_index: usize,
        result: Result<(), String>,
        outcome_uncertain: bool,
    ) -> Result<RpaRun, String> {
        match result {
            Ok(()) => {
                complete_receipt(&mut run, receipt_index, None);
                self.save(&run)?;
                Ok(run)
            }
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, outcome_uncertain);
                self.save(&run)?;
                Err(error)
            }
        }
    }

    fn reject_step(
        &self,
        mut run: RpaRun,
        step_id: &str,
        action: &str,
        target_summary: &str,
        reason: &str,
    ) -> Result<RpaRun, String> {
        validate_id(step_id, "step")?;
        run.receipts.push(RpaReceipt {
            run_id: run.id.clone(),
            step_id: step_id.into(),
            attempt: 0,
            state: RpaStepState::Rejected,
            idempotency_key: format!("rejected:{step_id}"),
            action: action.into(),
            target_summary: target_summary
                .chars()
                .take(MAX_TARGET_SUMMARY_CHARS)
                .collect(),
            external_side_effect: true,
            approval_id: None,
            artifact_ids: Vec::new(),
            error: Some(reason.into()),
            started_at: now_ms(),
            completed_at: Some(now_ms()),
        });
        self.save(&run)?;
        Ok(run)
    }

    fn recover_interrupted(&self) -> Result<(), String> {
        let index = self.index()?;
        for run_id in index.run_ids {
            let Some(mut run) = self.load(&run_id)? else {
                continue;
            };
            let Some(step_id) = run.current_step_id.clone() else {
                continue;
            };
            let Some(receipt) = run.receipts.iter_mut().rev().find(|receipt| {
                receipt.step_id == step_id && receipt.state == RpaStepState::Started
            }) else {
                continue;
            };
            if receipt.external_side_effect {
                receipt.state = RpaStepState::UnknownOutcome;
                receipt.error = Some("应用中断后外部动作结果未知，禁止自动重试".into());
                run.state = RpaRunState::UnknownOutcome;
            } else {
                receipt.state = RpaStepState::Pending;
                receipt.error = Some("只读步骤在应用中断后可安全恢复".into());
                run.state = RpaRunState::Pending;
            }
            receipt.completed_at = Some(now_ms());
            run.current_step_id = None;
            self.save(&run)?;
        }
        Ok(())
    }

    fn record_shutdown(&self, run_id: &str, error: Option<&String>) -> Result<(), String> {
        let Some(mut run) = self.load(run_id)? else {
            return Ok(());
        };
        let timestamp = now_ms();
        let attempt = run
            .receipts
            .iter()
            .filter(|receipt| receipt.step_id == "shutdown")
            .count() as u32
            + 1;
        run.receipts.push(RpaReceipt {
            run_id: run.id.clone(),
            step_id: "shutdown".into(),
            attempt,
            state: if error.is_some() {
                RpaStepState::UnknownOutcome
            } else {
                RpaStepState::Succeeded
            },
            idempotency_key: format!("rpa-shutdown:{}:{attempt}", run.id),
            action: "browser.shutdown".into(),
            target_summary: "owned browser session".into(),
            external_side_effect: true,
            approval_id: None,
            artifact_ids: Vec::new(),
            error: error.map(|message| message.chars().take(1_000).collect()),
            started_at: timestamp,
            completed_at: Some(timestamp),
        });
        run.current_step_id = None;
        run.state = if error.is_some() {
            RpaRunState::UnknownOutcome
        } else {
            RpaRunState::Cancelled
        };
        run.updated_at = timestamp;
        self.save(&run)
    }

    fn required_run(&self, run_id: &str) -> Result<RpaRun, String> {
        self.load(run_id)?
            .ok_or_else(|| "RPA run 不存在".to_string())
    }

    fn load(&self, run_id: &str) -> Result<Option<RpaRun>, String> {
        validate_id(run_id, "run")?;
        self.store
            .get::<RpaRun>(TREE_EVENTS, &format!("rpa-run-{run_id}"))
            .map(|record| record.map(|record| record.payload))
            .map_err(|error| error.to_string())
    }

    fn save(&self, run: &RpaRun) -> Result<(), String> {
        self.store
            .put_latest(
                TREE_EVENTS,
                &format!("rpa-run-{}", run.id),
                "native-rpa",
                run.clone(),
            )
            .map_err(|error| error.to_string())?;
        let mut index = self.index()?;
        index.run_ids.insert(run.id.clone());
        self.store
            .put_latest(TREE_INDEX, RPA_INDEX_ID, "native-rpa", index)
            .map_err(|error| error.to_string())?;
        self.store.flush().map_err(|error| error.to_string())
    }

    fn index(&self) -> Result<RpaIndex, String> {
        self.store
            .get::<RpaIndex>(TREE_INDEX, RPA_INDEX_ID)
            .map(|record| record.map_or_else(RpaIndex::default, |record| record.payload))
            .map_err(|error| error.to_string())
    }
}

fn opencli_run_id(session: &str) -> Result<String, String> {
    let session = session.trim();
    if session.is_empty() || session.len() > 200 || session.chars().any(char::is_control) {
        return Err("opencli session 无效".into());
    }
    let digest = Sha256::digest(session.as_bytes());
    Ok(format!("opencli-{digest:x}"))
}

fn opencli_help() -> Value {
    json!({
        "status":"success",
        "runtime":"rust-native-rpa",
        "commands":["doctor","version","browser <session> open <url>","browser <session> state","browser <session> close"],
        "typedActions":["rpa_windows","rpa_snapshot","rpa_extract","rpa_click","rpa_fill","rpa_scroll","rpa_wait","rpa_screenshot"],
        "security":"No external binary, Node runtime, browser extension, shell, or model-provided coordinates."
    })
}

impl Drop for NativeRpa {
    fn drop(&mut self) {
        if let Ok(children) = self.owned_browsers.get_mut() {
            for child in children.values_mut() {
                let _ = child.terminate();
            }
        }
    }
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("RPA {label} ID 无效"));
    }
    Ok(())
}

fn reusable_rejected_placeholder(existing: Option<RpaRun>) -> Result<Option<RpaRun>, String> {
    match existing {
        Some(run)
            if run.profile_path.is_empty()
                && !run.receipts.is_empty()
                && run.receipts.iter().all(|receipt| {
                    receipt.state == RpaStepState::Rejected && receipt.attempt == 0
                }) =>
        {
            Ok(Some(run))
        }
        Some(_) => Err("RPA run ID 已存在".into()),
        None => Ok(None),
    }
}

fn bounded_coordinate(arguments: &Value, name: &str) -> Result<i32, String> {
    let value = arguments
        .get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("RPA 参数 {name} 缺失"))?;
    i32::try_from(value).map_err(|_| format!("RPA 参数 {name} 超出桌面坐标范围"))
}

fn complete_receipt(run: &mut RpaRun, index: usize, artifact: Option<&ArtifactRef>) {
    let receipt = &mut run.receipts[index];
    receipt.state = RpaStepState::Succeeded;
    receipt.completed_at = Some(now_ms());
    if let Some(artifact) = artifact {
        receipt.artifact_ids.push(artifact.sha256.clone());
    }
    run.current_step_id = None;
    run.state = RpaRunState::Running;
    run.updated_at = now_ms();
}

fn fail_receipt(run: &mut RpaRun, index: usize, error: &str, outcome_uncertain: bool) {
    let receipt = &mut run.receipts[index];
    receipt.state = if outcome_uncertain {
        RpaStepState::UnknownOutcome
    } else {
        RpaStepState::Failed
    };
    receipt.error = Some(error.chars().take(1_000).collect());
    receipt.completed_at = Some(now_ms());
    run.current_step_id = Some(receipt.step_id.clone());
    run.state = if receipt.state == RpaStepState::UnknownOutcome {
        RpaRunState::UnknownOutcome
    } else {
        RpaRunState::Failed
    };
    run.updated_at = now_ms();
}

fn cancel_receipt(run: &mut RpaRun, index: usize, reason: &str) {
    let receipt = &mut run.receipts[index];
    receipt.state = RpaStepState::Failed;
    receipt.error = Some(reason.into());
    receipt.completed_at = Some(now_ms());
    run.current_step_id = None;
    run.state = RpaRunState::Cancelled;
    run.updated_at = now_ms();
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    struct AcceptancePage {
        url: String,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl AcceptancePage {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop);
            let worker = thread::spawn(move || {
                let body = br#"<!doctype html><html><head><title>ClawMaster RPA Acceptance</title></head><body><main><h1>ClawMaster RPA Acceptance</h1><label>Acceptance text <input aria-label="ClawMaster RPA input" oninput="document.getElementById('status').textContent='ClawMaster RPA typed'"></label><p id="status">Waiting for native input</p><div style="height:1200px"></div><button onclick="this.textContent='ClawMaster RPA clicked'">Run ClawMaster RPA click</button><button id="drag-source">ClawMaster drag source</button><button id="drag-target">ClawMaster drag target</button></main><script>let dragging=false;document.getElementById('drag-source').addEventListener('mousedown',()=>dragging=true);document.getElementById('drag-target').addEventListener('mouseup',()=>{if(dragging)document.getElementById('status').textContent='ClawMaster RPA dragged';dragging=false});</script></body></html>"#;
                while !worker_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut request = [0_u8; 2048];
                            let _ = stream.read(&mut request);
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(header.as_bytes());
                            let _ = stream.write_all(body);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                url: format!("http://{address}/"),
                stop,
                worker: Some(worker),
            }
        }
    }

    impl Drop for AcceptancePage {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn controller() -> (tempfile::TempDir, NativeRpa) {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(&root.path().join("state"), [77; 32]).unwrap();
        let controller = NativeRpa::open(&root.path().join("profiles"), store).unwrap();
        (root, controller)
    }

    fn run(id: &str, external: bool) -> RpaRun {
        let now = now_ms();
        RpaRun {
            id: id.into(),
            tenant_id: "tenant-a".into(),
            platform_id: "platform-a".into(),
            browser: "chrome".into(),
            profile_path: "/isolated".into(),
            state: RpaRunState::Running,
            current_step_id: Some("submit".into()),
            receipts: vec![RpaReceipt {
                run_id: id.into(),
                step_id: "submit".into(),
                attempt: 1,
                state: RpaStepState::Started,
                idempotency_key: "idempotency".into(),
                action: "desktop.click".into(),
                target_summary: "submit order".into(),
                external_side_effect: external,
                approval_id: external.then(|| "approval-1".into()),
                artifact_ids: Vec::new(),
                error: None,
                started_at: now,
                completed_at: None,
            }],
            created_at: now,
            updated_at: now,
        }
    }

    fn named_element_ref(snapshot: &Value, expected: &str) -> String {
        snapshot["elements"]
            .as_array()
            .and_then(|elements| {
                elements.iter().find(|element| {
                    ["name", "description"].into_iter().any(|field| {
                        element[field]
                            .as_str()
                            .is_some_and(|value| value.contains(expected))
                    })
                })
            })
            .and_then(|element| element["ref"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let elements = snapshot["elements"].as_array().cloned().unwrap_or_default();
                let summary = elements
                    .iter()
                    .take(30)
                    .map(|element| {
                        format!(
                            "{}:{:?}:{:?}",
                            element["role"].as_str().unwrap_or("unknown"),
                            element["name"].as_str().unwrap_or(""),
                            element["description"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                panic!(
                    "find bounded element {expected:?} (elements={}, truncated={}, summary={summary})",
                    elements.len(),
                    snapshot["truncated"].as_bool().unwrap_or(false)
                )
            })
    }

    #[test]
    fn opencli_contract_is_rust_only_and_call_risk_is_argument_aware() {
        assert!(definitions().iter().any(|tool| tool.name == "opencli"));
        let help = ModelToolCall {
            id: "help".into(),
            name: "opencli".into(),
            arguments: json!({"args":["--help"]}),
        };
        let open = ModelToolCall {
            id: "open".into(),
            name: "opencli".into(),
            arguments: json!({"args":["browser","work","open","https://example.com"]}),
        };
        assert!(!is_write_call(&help));
        assert!(is_write_call(&open));
        let (_root, controller) = controller();
        let help_result = controller.execute_opencli(&help, None).unwrap();
        assert_eq!(help_result["runtime"], "rust-native-rpa");
        assert_eq!(
            help_result["security"].as_str().unwrap().contains("Node"),
            true
        );

        let external = ModelToolCall {
            arguments: json!({"args":["doctor"],"binaryPath":"/tmp/opencli"}),
            ..help
        };
        assert!(controller.execute_opencli(&external, None).is_err());
        assert_eq!(
            opencli_run_id("work").unwrap(),
            opencli_run_id("work").unwrap()
        );
    }

    #[test]
    fn recovery_retries_readonly_but_never_replays_external_steps() {
        let (root, controller) = controller();
        controller.save(&run("readonly", false)).unwrap();
        controller.save(&run("external", true)).unwrap();
        drop(controller);
        let store = NativeStateStore::open_for_test(&root.path().join("state"), [77; 32]).unwrap();
        let recovered = NativeRpa::open(&root.path().join("profiles"), store).unwrap();
        assert_eq!(
            recovered.get("readonly").unwrap().unwrap().state,
            RpaRunState::Pending
        );
        assert_eq!(
            recovered.get("external").unwrap().unwrap().state,
            RpaRunState::UnknownOutcome
        );
    }

    #[test]
    fn rejected_external_click_is_receipted_without_mouse_action() {
        let (_root, controller) = controller();
        let mut current = run("rejected", false);
        current.current_step_id = None;
        current.receipts.clear();
        controller.save(&current).unwrap();
        let rejected = controller
            .click(
                "rejected",
                "submit",
                &"0".repeat(64),
                "@e1",
                "submit order",
                None,
                true,
            )
            .unwrap();
        assert_eq!(rejected.state, RpaRunState::Running);
        assert_eq!(rejected.current_step_id, None);
        assert_eq!(rejected.receipts[0].state, RpaStepState::Rejected);
        assert!(rejected.receipts[0]
            .idempotency_key
            .starts_with("rejected:"));
    }

    #[test]
    fn computer_use_writes_require_approval_before_native_input() {
        let (_root, controller) = controller();
        for run_id in [
            "fill-rejected",
            "scroll-rejected",
            "focus-rejected",
            "drag-rejected",
        ] {
            let mut current = run(run_id, false);
            current.current_step_id = None;
            current.receipts.clear();
            controller.save(&current).unwrap();
        }

        let fill = controller
            .fill(
                "fill-rejected",
                "fill",
                &"0".repeat(64),
                "@e1",
                "safe text",
                "acceptance field",
                false,
                None,
            )
            .unwrap();
        let scroll = controller
            .scroll(
                "scroll-rejected",
                "scroll",
                &"0".repeat(64),
                "@w1",
                -30,
                "acceptance page",
                None,
            )
            .unwrap();
        let focus = controller
            .focus(
                "focus-rejected",
                "focus",
                &"0".repeat(64),
                "@w1",
                "acceptance window",
                None,
            )
            .unwrap();
        let drag = controller
            .drag(
                "drag-rejected",
                "drag",
                &"0".repeat(64),
                "@e1",
                "@e2",
                "acceptance drag",
                None,
            )
            .unwrap();

        assert_eq!(fill.receipts[0].state, RpaStepState::Rejected);
        assert_eq!(scroll.receipts[0].state, RpaStepState::Rejected);
        assert_eq!(focus.receipts[0].state, RpaStepState::Rejected);
        assert_eq!(drag.receipts[0].state, RpaStepState::Rejected);
        assert!(fill.receipts[0]
            .error
            .as_deref()
            .unwrap()
            .contains("approval"));
        assert!(scroll.receipts[0]
            .error
            .as_deref()
            .unwrap()
            .contains("approval"));
        assert!(focus.receipts[0]
            .error
            .as_deref()
            .unwrap()
            .contains("approval"));
        assert!(drag.receipts[0]
            .error
            .as_deref()
            .unwrap()
            .contains("approval"));
    }

    #[test]
    fn semantic_observation_is_readonly_but_native_actions_stay_gated() {
        for name in [
            "rpa_browser_support",
            "rpa_webdriver_probe",
            "rpa_windows",
            "rpa_snapshot",
            "rpa_extract",
            "rpa_wait",
            "rpa_status",
        ] {
            assert!(!is_write(name), "{name} should not request write approval");
        }
        for name in [
            "rpa_start",
            "rpa_screenshot",
            "rpa_focus",
            "rpa_click",
            "rpa_drag",
            "rpa_fill",
            "rpa_scroll",
            "rpa_cancel",
        ] {
            assert!(is_write(name), "{name} must remain approval gated");
        }
    }

    #[test]
    fn rejected_start_placeholder_can_be_reused_after_later_approval() {
        let (_root, controller) = controller();
        let call = ModelToolCall {
            id: "call-start".into(),
            name: "rpa_start".into(),
            arguments: json!({
                "runId":"retry-start",
                "tenantId":"tenant-a",
                "platformId":"platform-a",
                "url":"https://example.com"
            }),
        };
        controller.record_rejection(&call, "user rejected").unwrap();
        let placeholder = controller.get("retry-start").unwrap().unwrap();
        assert_eq!(placeholder.state, RpaRunState::Pending);
        assert_eq!(placeholder.receipts[0].state, RpaStepState::Rejected);
        assert!(placeholder.profile_path.is_empty());

        let reusable = reusable_rejected_placeholder(Some(placeholder))
            .unwrap()
            .unwrap();
        assert_eq!(reusable.id, "retry-start");
        let mut non_reusable = reusable;
        non_reusable.profile_path = "/owned/profile".into();
        assert!(reusable_rejected_placeholder(Some(non_reusable)).is_err());
    }

    #[test]
    fn cancel_requires_approval_and_records_the_terminal_receipt() {
        let (_root, controller) = controller();
        let mut current = run("cancel-approval", false);
        current.current_step_id = None;
        current.receipts.clear();
        controller.save(&current).unwrap();

        let rejected = controller.cancel("cancel-approval", None).unwrap();
        assert_eq!(rejected.state, RpaRunState::Running);
        assert_eq!(
            rejected.receipts.last().unwrap().state,
            RpaStepState::Rejected
        );

        let cancelled = controller
            .cancel("cancel-approval", Some("approval-cancel"))
            .unwrap();
        assert_eq!(cancelled.state, RpaRunState::Cancelled);
        let receipt = cancelled.receipts.last().unwrap();
        assert_eq!(receipt.action, "browser.cancel");
        assert_eq!(receipt.state, RpaStepState::Succeeded);
        assert_eq!(receipt.approval_id.as_deref(), Some("approval-cancel"));
    }

    #[test]
    fn cancel_remains_available_after_a_failed_step() {
        let (_root, controller) = controller();
        let mut current = run("cancel-failed", false);
        current.state = RpaRunState::Failed;
        current.receipts[0].state = RpaStepState::Failed;
        current.receipts[0].completed_at = Some(now_ms());
        controller.save(&current).unwrap();

        let cancelled = controller
            .cancel("cancel-failed", Some("approval-cancel-failed"))
            .unwrap();
        assert_eq!(cancelled.state, RpaRunState::Cancelled);
        assert_eq!(cancelled.current_step_id, None);
        assert_eq!(cancelled.receipts.last().unwrap().action, "browser.cancel");
    }

    #[cfg(unix)]
    #[test]
    fn failed_run_cleanup_terminates_the_owned_process_group() {
        let (_root, controller) = controller();
        let child = browser::spawn_test_browser();
        let pid = child.id();
        controller
            .owned_browsers
            .lock()
            .unwrap()
            .insert("failed-owned".into(), child);

        controller.cleanup_failed_run("failed-owned").unwrap();

        assert!(controller.owned_browsers.lock().unwrap().is_empty());
        assert!(!std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success()));
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_terminates_owned_browser_and_persists_terminal_state() {
        let (_root, controller) = controller();
        let mut current = run("shutdown-owned", false);
        current.current_step_id = None;
        current.receipts.clear();
        controller.save(&current).unwrap();
        let child = browser::spawn_test_browser();
        let pid = child.id();
        controller
            .owned_browsers
            .lock()
            .unwrap()
            .insert(current.id.clone(), child);

        controller.shutdown().unwrap();

        assert!(controller.owned_browsers.lock().unwrap().is_empty());
        assert!(!std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success()));
        let persisted = controller.get("shutdown-owned").unwrap().unwrap();
        assert_eq!(persisted.state, RpaRunState::Cancelled);
        assert_eq!(persisted.current_step_id, None);
        assert_eq!(
            persisted.receipts.last().unwrap().action,
            "browser.shutdown"
        );
    }

    #[test]
    fn uncertain_native_input_failure_is_persisted_and_returned_as_error() {
        let (_root, controller) = controller();
        let mut current = run("input-failure", true);
        current.receipts[0].external_side_effect = true;
        controller.save(&current).unwrap();

        let error = controller
            .persist_input_result(
                current,
                0,
                Err("native input transport failed".into()),
                true,
            )
            .unwrap_err();
        assert_eq!(error, "native input transport failed");
        let persisted = controller.get("input-failure").unwrap().unwrap();
        assert_eq!(persisted.state, RpaRunState::UnknownOutcome);
        assert_eq!(persisted.receipts[0].state, RpaStepState::UnknownOutcome);
    }

    #[test]
    fn resolves_coordinates_only_from_the_bound_semantic_snapshot() {
        let (_root, controller) = controller();
        let snapshot = json!({"activeWindow":{"bounds":{"x":0,"y":0,"width":500,"height":500}},"elements":[
            {"ref":"@e1","name":"提交","bounds":{"centerX":120,"centerY":240,"width":80,"height":30}},
            {"ref":"@e2","name":"纯文本","bounds":null},
            {"ref":"@e3","name":"裁剪按钮","bounds":{"centerX":120,"centerY":500,"width":100,"height":0}}
        ]});
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        let artifact = controller
            .store
            .put_artifact("rpa-semantic-snapshot", &bytes)
            .unwrap();
        assert_eq!(
            controller.resolve_element(&artifact.sha256, "@e1").unwrap(),
            (120, 240)
        );
        assert!(controller
            .resolve_element(&artifact.sha256, "@e999")
            .is_err());
        assert!(controller.resolve_element(&artifact.sha256, "@e2").is_err());
        assert!(controller.resolve_element(&artifact.sha256, "@e3").is_err());
        assert!(controller.resolve_element(&"0".repeat(64), "@e1").is_err());
    }

    #[test]
    fn sensitive_fill_is_rejected_before_any_native_input() {
        let (_root, controller) = controller();
        let error = controller
            .fill(
                "missing-run",
                "fill-secret",
                &"0".repeat(64),
                "@e1",
                "secret-value",
                "password field",
                true,
                Some("approval-1"),
            )
            .unwrap_err();
        assert!(error.contains("secret"));
        assert!(controller.get("missing-run").unwrap().is_none());
    }

    #[tokio::test]
    async fn wait_cancellation_is_persisted_before_desktop_access() {
        let (_root, controller) = controller();
        let artifact = controller
            .store
            .put_artifact(
                "empty-window-inventory",
                br#"{"provider":"test","referenceScope":"this-inventory-only","windows":[],"truncated":false}"#,
            )
            .unwrap();
        let mut current = run("cancel-wait", false);
        current.current_step_id = None;
        current.receipts[0].state = RpaStepState::Succeeded;
        current.receipts[0].artifact_ids = vec![artifact.sha256.clone()];
        controller.save(&current).unwrap();
        let (_sender, receiver) = watch::channel(true);
        let error = controller
            .wait(
                "cancel-wait",
                "wait-ready",
                &artifact.sha256,
                "@w1",
                "Ready",
                1_000,
                receiver,
            )
            .await
            .unwrap_err();
        assert!(error.contains("取消"));
        let persisted = controller.get("cancel-wait").unwrap().unwrap();
        assert_eq!(persisted.state, RpaRunState::Cancelled);
        assert_eq!(persisted.current_step_id, None);
        assert_eq!(
            persisted.receipts.last().unwrap().state,
            RpaStepState::Failed
        );
    }

    #[tokio::test]
    #[ignore = "requires explicit opt-in, an installed Chrome/Edge, desktop accessibility, and screen-capture permission"]
    async fn completes_real_browser_computer_use_with_encrypted_receipts() {
        assert_eq!(
            std::env::var("CLAWMASTER_REAL_RPA_SMOKE").as_deref(),
            Ok("1"),
            "set CLAWMASTER_REAL_RPA_SMOKE=1 only on an authorized acceptance host"
        );
        let page = AcceptancePage::start();
        let (_root, controller) = controller();
        let browser = std::env::var("CLAWMASTER_REAL_RPA_BROWSER")
            .ok()
            .or_else(|| {
                controller
                    .browser_support()
                    .into_iter()
                    .find(|candidate| candidate.installed && !candidate.webdriver_contract)
                    .map(|candidate| candidate.id)
            })
            .expect("install Chrome or Edge before running the real RPA smoke");
        controller
            .launch(
                "real-browser-click",
                "release-acceptance",
                "loopback",
                Some(&browser),
                &page.url,
            )
            .expect("launch isolated owned browser");

        let deadline = Instant::now() + Duration::from_secs(20);
        let (windows, window_ref) = loop {
            let attempt = now_ms();
            let windows = controller
                .windows("real-browser-click", &format!("windows-{attempt}"))
                .expect("read bounded system windows");
            let value = serde_json::to_value(&windows.inventory).unwrap();
            let selected = value["windows"].as_array().and_then(|entries| {
                entries.iter().find(|entry| {
                    entry["title"]
                        .as_str()
                        .is_some_and(|title| title.contains("ClawMaster RPA Acceptance"))
                })
            });
            if let Some(selected) = selected {
                break (windows, selected["ref"].as_str().unwrap().to_string());
            }
            assert!(
                Instant::now() < deadline,
                "owned browser window did not appear"
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        };

        let focused = controller
            .focus(
                "real-browser-click",
                "approved-focus",
                &windows.artifact.sha256,
                &window_ref,
                "loopback acceptance window",
                Some("approval-real-rpa-focus"),
            )
            .expect("focus the approved bounded browser window");
        assert_eq!(
            focused.receipts.last().unwrap().approval_id.as_deref(),
            Some("approval-real-rpa-focus")
        );

        let snapshot = controller
            .snapshot(
                "real-browser-click",
                "snapshot-before-input",
                &windows.artifact.sha256,
                &window_ref,
            )
            .expect("capture encrypted semantic snapshot");
        let input_ref = named_element_ref(&snapshot.snapshot, "ClawMaster RPA input");
        let filled = controller
            .fill(
                "real-browser-click",
                "approved-input",
                &snapshot.artifact.sha256,
                &input_ref,
                "native input accepted",
                "loopback acceptance field",
                false,
                Some("approval-real-rpa-input"),
            )
            .expect("perform approved native text input");
        assert_eq!(
            filled.receipts.last().unwrap().approval_id.as_deref(),
            Some("approval-real-rpa-input")
        );

        let (_input_cancel_sender, input_cancel_receiver) = watch::channel(false);
        controller
            .wait(
                "real-browser-click",
                "wait-input-result",
                &windows.artifact.sha256,
                &window_ref,
                "ClawMaster RPA typed",
                10_000,
                input_cancel_receiver,
            )
            .await
            .expect("observe native text input through a fresh semantic snapshot");
        let scrolled = controller
            .scroll(
                "real-browser-click",
                "approved-scroll",
                &windows.artifact.sha256,
                &window_ref,
                -30,
                "loopback acceptance page",
                Some("approval-real-rpa-scroll"),
            )
            .expect("perform approved native window scroll");
        assert_eq!(
            scrolled.receipts.last().unwrap().approval_id.as_deref(),
            Some("approval-real-rpa-scroll")
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
        let click_snapshot = controller
            .snapshot(
                "real-browser-click",
                "snapshot-before-click",
                &windows.artifact.sha256,
                &window_ref,
            )
            .expect("capture post-scroll encrypted semantic snapshot");
        let element_ref = named_element_ref(&click_snapshot.snapshot, "Run ClawMaster RPA click");
        let clicked = controller
            .click(
                "real-browser-click",
                "approved-click",
                &click_snapshot.artifact.sha256,
                &element_ref,
                "loopback acceptance button",
                Some("approval-real-rpa-smoke"),
                true,
            )
            .expect("perform approved physical mouse click");
        assert_eq!(
            clicked.receipts.last().unwrap().approval_id.as_deref(),
            Some("approval-real-rpa-smoke")
        );

        let (_cancel_sender, cancel_receiver) = watch::channel(false);
        let changed = controller
            .wait(
                "real-browser-click",
                "wait-click-result",
                &windows.artifact.sha256,
                &window_ref,
                "ClawMaster RPA clicked",
                10_000,
                cancel_receiver,
            )
            .await
            .expect("observe the click result through a fresh semantic snapshot");
        let drag_from_ref = named_element_ref(&changed.snapshot, "ClawMaster drag source");
        let drag_to_ref = named_element_ref(&changed.snapshot, "ClawMaster drag target");
        let dragged = controller
            .drag(
                "real-browser-click",
                "approved-drag",
                &changed.artifact.sha256,
                &drag_from_ref,
                &drag_to_ref,
                "loopback acceptance drag",
                Some("approval-real-rpa-drag"),
            )
            .expect("perform approved semantic drag");
        assert_eq!(
            dragged.receipts.last().unwrap().approval_id.as_deref(),
            Some("approval-real-rpa-drag")
        );
        let (_drag_cancel_sender, drag_cancel_receiver) = watch::channel(false);
        let drag_result = controller
            .wait(
                "real-browser-click",
                "wait-drag-result",
                &windows.artifact.sha256,
                &window_ref,
                "ClawMaster RPA dragged",
                10_000,
                drag_cancel_receiver,
            )
            .await
            .expect("observe semantic drag through a fresh semantic snapshot");
        let screenshot = controller
            .screenshot(
                "real-browser-click",
                "screenshot-click-result",
                &windows.artifact.sha256,
                &window_ref,
            )
            .expect("capture encrypted screenshot evidence");
        let cancelled = controller
            .cancel("real-browser-click", Some("approval-real-rpa-cancel"))
            .unwrap();
        assert_eq!(cancelled.state, RpaRunState::Cancelled);
        assert!(controller.owned_browsers.lock().unwrap().is_empty());

        let evidence = json!({
            "schemaVersion": 1,
            "platform": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "browser": browser,
            "windowRef": window_ref,
            "inputRef": input_ref,
            "elementRef": element_ref,
            "dragFromRef": drag_from_ref,
            "dragToRef": drag_to_ref,
            "semanticArtifact": drag_result.artifact.sha256,
            "screenshotArtifact": screenshot.artifact.sha256,
            "approvedFocus": true,
            "approvedClick": true,
            "approvedInput": true,
            "approvedScroll": true,
            "approvedDrag": true,
            "cancelled": true,
            "receiptCount": cancelled.receipts.len()
        });
        println!("CLAWMASTER_REAL_RPA_EVIDENCE={evidence}");
        if let Some(path) = std::env::var_os("CLAWMASTER_REAL_RPA_SMOKE_EVIDENCE") {
            let path = PathBuf::from(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
        }
    }
}
