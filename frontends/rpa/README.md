---
description: "The governed ClawMaster RPA control plane recovered from the pre-DSH line: durable runs, a native accessibility driver, and no model-supplied coordinates."
kind: "package-reference"
---

# @clawmaster/dsh-rpa

English | [中文](README.zh.md)

## Summary

ClawMaster's automation component is the pre-DSH native control plane restored as a DSH component. The
pre-DSH branch `codex/clawmaster-before-dsh` held a governed RPA that the DSH desktop migration dropped;
this component brings it back without redesigning what already worked.

Two properties make it worth restoring rather than rewriting. The model never supplies a PID or a
coordinate: it selects a window reference and an element reference from an artifact this component
produced, and the native side resolves the element centre and issues the input event. And an action that
touches the desktop is never replayed automatically after an interruption — it becomes `unknown_outcome`
and waits for a human.

## What is here

| Part | What it is |
| --- | --- |
| `seam/` | The recovered TypeScript control plane, restored verbatim: contracts, ports, a policy-gated runner, revision-checked file stores and a run-scoped web driver. |
| `src/` | The DSH host half: three model-facing tools, the process bridge to the native helper, and a fail-closed policy port. |
| `native/` | The recovered Rust control plane: accessibility snapshots, physical input, isolated browser profiles and encrypted artifact storage. |
| `tests/` | Host-half tests against a stand-in DSH context, and bridge tests that drive a stand-in process plus the real helper when it is built. |

## Tools

| Tool | Reads or writes | What it does |
| --- | --- | --- |
| `rpa_run` | Writes only inert steps | Drives an operator-installed workflow run through a durable store. |
| `rpa_native` | Read-only | Reports the helper capability manifest, the recovered tool catalog, or a bounded desktop snapshot. |
| `rpa_call` | Depends on the tool | Forwards one recovered `rpa_*` call, for example `rpa_windows`, `rpa_snapshot` or `rpa_extract`. |

## Governance boundaries

- Workflows are operator-declared. A model can start an installed workflow but cannot invent steps.
- The helper's `input` subcommand is not exposed, so this build cannot type or click at raw coordinates.
- A step with an external side effect is denied rather than queued while no approval bridge is wired.
- `approve` is not a model action, so nothing can approve its own external action.
- An interrupted external action becomes `unknown_outcome` and is never retried automatically.

## Verification

```sh
node scripts/build.mjs --check
node --import tsx/esm --test tests/*.test.mjs
(cd native && cargo build --bin clawmaster-rpa-native)
```

- Without macOS Accessibility the helper refuses a desktop snapshot and names the exact setting to change.
- The bridge reports a helper that is not built as unavailable instead of throwing.
- The recovered seam's own suite still passes inside this component.
