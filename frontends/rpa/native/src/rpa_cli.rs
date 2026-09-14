//! Command-line adapter for the recovered RPA tool dispatcher.
//!
//! The recovered control plane exposes its semantic tools through
//! `NativeRpa::execute`, which the pre-DSH application called in-process. A
//! standalone helper needs a command-line way in, and this module adds exactly
//! two things: it builds a `ModelToolCall` from a JSON request, and it performs
//! the approval gate the application used to perform.
//!
//! That gate is load-bearing. `is_write` classifies a tool as touching the
//! outside world, but `execute` only enforces an approval binding for some of
//! those tools — `rpa_start` reaches `launch` with no check of its own. The
//! recovered contract is that the caller asks for approval first, using
//! `approval_summary`, and records a rejection when it is not granted. This
//! adapter is now that caller, so it refuses rather than forwarding.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use crate::native_models::ModelToolCall;
use crate::native_rpa::{is_write_call, approval_summary, NativeRpa};
use crate::native_state_store::NativeStateStore;

/// One semantic tool invocation, as the host half sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpaCallRequest {
    /// Profile root: browser profiles and the state database live under it.
    root: PathBuf,
    /// Recovered tool name, for example `rpa_windows` or `rpa_click`.
    tool: String,
    /// Tool arguments exactly as the model supplied them.
    #[serde(default)]
    arguments: Value,
    /// Approval binding for a write step, when the host half has one.
    #[serde(default)]
    approval_id: Option<String>,
}

/// Run one `rpa_*` tool call against a profile root.
///
/// @param request_json A JSON object with `root`, `tool`, optional `arguments`
///   and optional `approvalId`.
/// @returns The canonical JSON result of the recovered dispatcher.
pub fn run_blocking(request_json: &str) -> Result<Value, String> {
    let request: RpaCallRequest =
        serde_json::from_str(request_json).map_err(|error| format!("RPA 请求 JSON 无效: {error}"))?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("无法启动 RPA 运行时: {error}"))?;

    runtime.block_on(async move {
        let store = NativeStateStore::open(&request.root.join("state"))
            .map_err(|error| format!("无法打开 RPA 状态库: {error}"))?;
        let rpa = NativeRpa::open(&request.root, store)?;

        let call = ModelToolCall {
            id: call_id(),
            name: request.tool,
            arguments: request.arguments,
        };

        // The approval gate the application used to perform. A tool classified
        // as touching the outside world executes only with an approval binding;
        // otherwise the refusal is receipted through the recovered path, so an
        // unattended call leaves evidence instead of an action.
        if is_write_call(&call) && request.approval_id.is_none() {
            return rpa.record_rejection(&call, &approval_summary(&call));
        }

        // A one-shot process is the unit of work, so the cancellation channel is
        // created and never signalled; process termination is the cancel.
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        let result = rpa.execute(&call, request.approval_id.as_deref(), receiver).await;
        let _ = rpa.shutdown();
        result
    })
}

fn call_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    format!("cli-{}-{millis}", std::process::id())
}
