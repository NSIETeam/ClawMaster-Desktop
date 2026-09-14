# Agent Note: ClawMaster control CLI for the running Host

Status: implemented

English | [中文](2026-09-14-clawmaster-control-cli.zh.md)

## Problem

Terminal automation needs to inspect and submit work to the desktop's existing sessions while retaining their model configuration, credentials and permissions. A second agent runtime would own different live state, and the subprocess SDK does not provide a connection to the desktop Web Host. Access to that Host also carries the operating-system user's tool authority, so a local discovery file cannot honestly be described as a read-only credential.

## Decision

The [control component](../../../../frontends/control/README.md) connects to the existing Host through its authenticated Connection and Session Remote operations. Its `clawmaster-control` profile runs a short-lived client without `dsh-base`. The repository's `pnpm clawmaster` convenience command dispatches this profile; it does not introduce another application launcher or start an agent Host.

When the source installation carries the selected control bundle only as a development dependency, the existing [profile module fallback](../../../../packages/boot/app-boot/README.md) exposes that bundle itself to the profile's plugin loader. Installation dependencies and existing pnpm-owned entries retain precedence. This keeps source and installed launches on the same profile resolver without a control-specific import patch.

The Host entry publishes its process login URL in a private, owner-controlled `$DSH_HOME/control/connection.json` record. The client validates discovery before exchanging that URL for the ordinary Host cookie. This is full Host authentication for the same operating-system user. Restricting the command vocabulary does not scope the credential; possession of the record permits the same authentication as the desktop browser. Diagnostics and normal command output exclude the login material.

The client exposes only `status`, `sessions`, `send` and `cancel`. Listing uses the cold-safe Session list operation. Sending requires an existing session and standard input, and leaves prompt admission, steering and tool approval with the Host. An acceptance receipt reports admission rather than model completion. Cancellation targets the active turn and retains the pending inbox. The interface has no generic RPC escape or automatic approval response.

## Alternatives considered

**Use the TypeScript subprocess SDK.** Its client creates a new `dsh --profile sdk` process with stdio JSON-RPC. That process cannot inspect or control the existing desktop's live agents.

**Infer identity from a loopback port or open a second unauthenticated endpoint.** Loopback reachability does not identify the user. Reusing Connection retains the existing cookie exchange and request trust checks.

**Treat the connection record as read-only or expose arbitrary Remote calls.** The Host cookie grants full application access. A fixed command set keeps the supported CLI auditable but cannot reduce the underlying credential's authority.

**Use Session `follow` for queries.** Its opening snapshot can promote a cold session to a live agent. Session listing provides the needed summaries and running state without that activation.

## Consequences

Terminal tasks share the desktop's session and permission owners without duplicating model configuration. The private connection record increases the places where process login material exists; it requires owner-only storage and must remain outside shared files and diagnostic output. The [browser authentication decision](../architecture/2026-08-24-browser-token-authentication.md) remains the authority for cookie validation and process-token rotation; this product-level handoff extends its token-storage policy for a concrete same-user client.

A Host must load the bridge before the CLI can connect. Building the CLI does not change an installed desktop or authorize interrupting its active work. The interface returns admission and cancellation acknowledgements, not completed-task guarantees or delegated, narrowly scoped service credentials.
