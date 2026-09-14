# Agent Note: Restore the governed RPA control plane as a DSH component

Status: implemented

English | [中文](2026-09-14-clawmaster-rpa-recovery.zh.md)

## Problem

ClawMaster needs a strong RPA component. The DSH desktop adoption dropped the one it already had: branch `codex/clawmaster-before-dsh` (checkpoint `7f7616c3e4`, "chore: checkpoint ClawMaster before DSH desktop adoption") carries a governed RPA — a TypeScript control plane plus a Rust native control plane — and the current branch contains none of it. Nothing recorded the loss, so the capability looked absent rather than misplaced, and the first response to the request was to design a replacement from scratch.

## Decision

The recovered implementation is the authority and is restored rather than redesigned. It already satisfies the properties a new design was reaching for, and in places exceeds them: the model never supplies a PID or a coordinate but selects a window reference (`@wN`) and an element reference (`@eN`) from an encrypted artifact the control plane produced; an interrupted action that had already begun an external side effect becomes `unknown_outcome` and is never replayed automatically; a rejected approval is durably receipted without freezing the run; editable values are redacted from semantic snapshots.

The component is `frontends/rpa` (`@clawmaster/dsh-rpa`) with three parts. `seam/` is the recovered TypeScript control plane restored verbatim — contracts, ports, a policy-gated runner, revision-checked file stores and a run-scoped web driver. `src/` is the DSH host half: three model-facing tools plus a process bridge. `native/` is the recovered Rust control plane as an independent crate.

The Rust control plane needed no adaptation: it referenced `tauri::` zero times and declared no Tauri command, so it was already a control plane that merely lived under `src-tauri/`. The pre-DSH `main.rs` answered `--native-tool <name>` on the command line and otherwise started the GUI, so the helper transport — a separate process, JSON on stdout, errors on stderr with exit code 2 — is also the recovered contract rather than a new choice. This binary keeps only that command-line role.

Two gaps had to be filled, and both are additions rather than rewrites. The recovered dispatch answers `capabilities`, `desktop-snapshot`, `input` and the document writers, but exposes none of the sixteen semantic `rpa_*` tools, which the pre-DSH application called in-process; `native/src/rpa_cli.rs` builds a `ModelToolCall` from a JSON request and runs the same `NativeRpa::execute` dispatcher the application used. And `serde_json`-encoded tool catalogues were not reachable from the command line, so `main.rs` answers `--native-tool definitions` itself, leaving the recovered `native_tools.rs` byte-identical.

Governance needed repair, not just wiring. `native_rpa::is_write` classifies eight tools as touching the outside world, but `NativeRpa::execute` only enforces an approval binding for some of them: `rpa_start` reaches `launch` with no check of its own, which was measured rather than assumed — an unapproved `rpa_start` created a run, a real browser profile directory and a state store, and reported `state: "running"`. The recovered design put that decision in the caller, which the pre-DSH application was; the caller is now this adapter, so `rpa_cli.rs` performs the recovered gate: `is_write_call` decides whether approval is required, `approval_summary` composes the request the operator would have seen, and `record_rejection` receipts the refusal through the recovered path. The same call after the change creates no profile and yields a receipt with `state: "rejected"`, `idempotencyKey: "rejected:launch"` and the approval prompt as its reason.

The host half therefore always sends `approvalId: null` and never invents an approval, and it does not duplicate the write classification in TypeScript, because the adapter enforces it in the same process and language as the classification itself. `rpa_native` additionally restricts the command line to the read-only set, so the raw-coordinate `input` subcommand is unreachable from the model.

The host half declares its tool definitions literally instead of calling the harness factory, so its bundle imports nothing but Node built-ins. That matches the other built-in components and keeps this one testable from a clean checkout: it carries no `node_modules` of its own, yet `node scripts/build.mjs` and `node --import tsx/esm --test tests/*.test.mjs` both run. A raw definition owns its own input validation, so the handlers validate the action, subcommand and tool name explicitly rather than relying on a schema wrapper.

## Alternatives considered

Designing a new component from scratch was the starting plan and was discarded once the branch was found; the replacement was weaker on exactly the points that matter, including artifact-scoped references and unknown-outcome handling. Copying the recovered Rust closure wholesale was rejected after measuring it: a `crate::`-based closure computation reported 11,393 lines across 13 modules, but the true closure by `use` statement is 6,341 lines across 6 modules, and the apparent coupling to `native_agent_tools` occurs only inside a `#[test]`. Reusing one of the published macOS WeChat MCP servers was rejected because this machine has neither `uv` nor `bun`, which would make an unrelated runtime a prerequisite. Adding an N-API addon under `native/system` was rejected because its build ladder knows two kinds and darwin-x64 ships no binary. Keeping the recovered dispatcher reachable only in-process was rejected because the DSH harness is a separate Node process.

## Consequences

`native_tools.rs` is a mixed module: it holds the RPA operating-system adapter and the document writers (docx, pptx, pdf, chart) together, so the crate carries `lopdf` and `zip` for code the RPA path does not exercise. Splitting it is deferred, and the recovered file stays untouched until then.

A desktop action still cannot run: no approval bridge is wired, so every write step is refused and receipted. Delivering that requires the harness approval capability on the host half and a decision about which actions may be pre-authorized.

The shipped application is ad-hoc signed with no entitlements, so the macOS Accessibility and Screen Recording grants do not survive a reinstall. That is a distribution task, not a component task, and it is unaffected by the `updater` endpoints being empty today.

Recording this recovery does not restore the evidence the pre-DSH work was still missing: its own document states release gate #21 remains open until installed Windows x64 and macOS ARM64 builds demonstrate a visible real click, a cancellation that leaves no owned browser descendants, Safari passing its system WebDriver contract, and screenshots, approval, audit and receipts on one run. One part of that gate is now measured on this host instead of pending. `rpa_browser_support` discovers Google Chrome and `/usr/bin/safaridriver`, marking the latter as holding a WebDriver contract, and `rpa_webdriver_probe` answers for the `safari-webdriver` adapter with the Safari release that supplies it; neither call needs a run or an approval. The visible click, cancellation residue, screenshot, approval, audit and receipt parts still need an installed build.

## Verification

`cargo check --lib` and `cargo build --bin clawmaster-rpa-native` both exit 0 in `frontends/rpa/native` (one dead-code warning for `write_docx_content`, which the recovered dispatch reaches but the RPA path does not), and the workspace pins the recovered crate versions including `xa11y = "=0.13.0"`.

The built helper answers `--native-tool capabilities` with a seven-entry manifest whose `desktop.input` entry declares the `rust:xa11y-input` provider and the `rpa_click` tool, answers `--native-tool definitions` with all sixteen recovered tools, and refuses `--native-tool desktop-snapshot` with exit code 2 and the message naming the exact System Settings pane, which independently reproduces the permission state measured separately on this machine.

The recovered seam's own suite passes inside the component (13 passed, 1 e2e skipped without `RUN_RPA_BROWSER_E2E=1`). The host half and the bridge pass 22 tests together. The host tests cover the durable run loop, revision-checked persistence across handler instances, external-side-effect denial, tool registration and that `approve` is not model-reachable. The bridge tests cover JSON parsing, non-zero exit reason propagation, non-JSON output, timeout, cancellation, a missing binary, the read-only subcommand allowlist, an unbuilt helper reporting unavailability, the exact request the host half sends for a semantic call, and two real-helper cases.

The first real-helper case asserts the approval gate directly: a read-only `rpa_status` returns `{"run": null}`, while `rpa_start` returns an empty `profilePath` and a receipt with `state: "rejected"`, `externalSideEffect: true`, `approvalId: null` and the approval prompt as its reason. The second accepts either a successful desktop snapshot or the permission refusal, but not a silent empty one, and checks that the browser half reports entries carrying `id`, `installed` and `webdriverContract` flags. On this macOS ARM64 host that browser half answers with Chrome installed and `/usr/bin/safaridriver` installed holding a WebDriver contract, and `rpa_webdriver_probe` answers for the `safari-webdriver` adapter with `Included with Safari 26.5 (21624.2.5.11.4)`. `node scripts/build.mjs --check` matches `dist/`.
