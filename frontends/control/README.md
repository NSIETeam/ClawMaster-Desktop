---
description: "Connect a terminal to a running ClawMaster Host to inspect sessions, submit messages and cancel the current turn using the same operating-system user's private login."
kind: "package-bundle"
---

# ClawMaster Control

English | [中文](README.zh.md)

## Summary

ClawMaster Control lets you check the running desktop Host, list its sessions, send a message to an existing session and cancel its active turn from a terminal. It connects to that Host and uses its configured models, credentials and permissions. The Host must include the control bridge, and both processes must select the same Harness home. The connection record grants the same operating-system user full Host authentication; it is not a read-only credential.

## Table of Contents

- [Use the CLI](#use-the-cli)
- [Commands and results](#commands-and-results)
- [Connection and recovery](#connection-and-recovery)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-the-cli"></a>
## Use the CLI

Keep a compatible ClawMaster Host running with the control bridge enabled by the [desktop policy layer](../../apps/desktop-tauri/defaults/cordis.patch.yml). Use the same operating-system account and `DSH_HOME` as that Host. Desktop preparation and the repository convenience command initialize the dedicated client profile from this private bundle's [patch](cordis.patch.yml). Building or invoking this CLI does not update, restart or install the desktop application.

The supported entry is the named `dsh` profile:

```sh
dsh --profile clawmaster-control status --json
dsh --profile clawmaster-control sessions --running --json
```

From this repository, `pnpm clawmaster status --json` selects the same profile. This convenience command starts the short-lived control client, not another agent Host.

To send work, first find the existing session with `sessions`, then replace `SESSION` below with its ID. Prepare the message in a local UTF-8 text file so it does not appear as a command-line argument. `--stdin` requires a pipe or file redirection; empty, whitespace-only and invalid UTF-8 input are rejected. The default input limit is 1 MiB:

```sh
dsh --profile clawmaster-control send SESSION --stdin --json < message.txt
```

Check the acknowledgement, then return to that session in ClawMaster to follow the answer or resolve an approval. An accepted message is queued work, not a completed result.

-----

<a id="commands-and-results"></a>
## Commands and results

Every command accepts `--json` for structured output. The available operations are deliberately limited:

| Command | Result and effect |
|---|---|
| `status [--json]` | Check connection to the selected running Host. JSON contains `connected` and safe `runtime` metadata. |
| `sessions [--running] [--json]` | Return `items` with IDs, running state, activity time and optional workspace paths; no message content is returned. `--running` filters current activity. Listing persisted sessions does not activate their agents. |
| `send SESSION --stdin [--steer] [--request-id UUID] [--json]` | Submit standard input to an existing session. `--steer` selects steering delivery; `--request-id` supplies the request's UUID. The receipt contains `accepted`, `sessionId`, `requestId` and `mode`. Host admission and session permissions still apply. |
| `cancel SESSION [--json]` | Request cancellation of the active turn. The receipt contains `accepted`, `sessionId` and `pendingInbox: "retained"`. |

The CLI does not approve tool requests, answer interaction prompts or expose arbitrary RPC calls. A queued message can still wait for the Host, model provider or a user decision. Cancelling a turn does not delete its session, clear its inbox or promise to undo completed tool actions.

-----

<a id="connection-and-recovery"></a>
## Connection and recovery

The bridge publishes a private connection record at `$DSH_HOME/control/connection.json`. Treat this file as a login credential: do not attach it to issues, copy it into a shared workspace or print it in diagnostics. It enables full authenticated access to the Host, even when the CLI command being used only lists sessions. The CLI exchanges the process launch URL for the Host's ordinary login cookie.

If the record is missing, check that the running Host includes the bridge and that both processes use the same home. If authentication or connection fails, confirm that the intended Host is still running. Do not replace the record with a guessed port, reuse another user's record or start a second agent Host merely to make a query succeed.

If a send response is lost, inspect the target session before sending the message again. The CLI does not retry automatically. For a retry of the same message, retain its request ID with `--request-id`; the ID identifies the submitted request and does not establish model completion. Command-operation failures exit unsuccessfully and write an `error` object containing `code`, `message` and an optional `requestId` to standard error in JSON mode. Successful output goes to standard output; neither form echoes the submitted text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The private `@clawmaster/dsh-control` package has two plugin entries: `.` runs the control profile and `/host` publishes connection information from the running Host. The control profile does not load `dsh-base`. It uses existing authenticated Connection and Session Remote operations; it does not attach through the subprocess SDK or own a second model configuration.

The bundle patch mounts the command plugin; the desktop policy layer separately mounts the Host entry. The command plugin accepts these deployment limits:

| Field | Default | Meaning |
|---|---|---|
| `maxInputBytes` | `1048576` | Positive UTF-8 input byte limit. |
| `requestTimeoutMs` | `30000` | Connection, authentication and RPC time limit from `1` to `2147483647` milliseconds, starting after standard input ends. A timeout reports `request-timeout`; it does not establish whether a send was admitted. |

The [Host Session controller](../../packages/api/session-controller/README.md) owns admission, status and cancellation semantics. Its `list` operation reads cold sessions without activation. Its streaming `follow` operation can activate a cold agent, so it is not the CLI's list implementation.

</details>

-----

<a id="model-experience"></a>
## Model Experience

The control client adds no model tools or system prompt. A message submitted with `send` enters the target Host session through its existing prompt admission path; that session owns the model conversation, tool permissions and approvals.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

This interface controls an existing local Host and has the following limits:

- It does not create sessions, stream complete answers, manage approvals or provide general RPC access.
- The connection record is an operating-system-user credential, not a scoped service account or a read-only token. CLI command restrictions do not reduce the authority of the stored login material.
- An installed desktop without the bridge cannot be controlled through this entry. Source changes and isolated command tests do not establish installed-app or cross-platform acceptance.
- Discovery requires the native desktop's matching, ready runtime identity. Ordinary source Web and WSL launches do not publish that identity. Connection files with unsafe ownership, permissions or symbolic-link paths are rejected.

<a id="further-exploration"></a>
## Further Exploration

- [Desktop setup](../../apps/desktop-tauri/README.md) — the running application and selected home.
- [Connection](../../packages/client/connection/README.md) — the existing HTTP authentication and RPC carrier.
- [Control decision](../../.agents/notes/implemented/feature/2026-09-14-clawmaster-control-cli.md) — same-user access and alternatives.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
