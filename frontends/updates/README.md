---
description: "Check signed ClawMaster component releases, approve component activation, and prepare verified desktop update files in an existing DSH profile."
kind: "package-reference"
---

# ClawMaster Updates

English | [中文](README.zh.md)

## Summary

ClawMaster can check a server for signed component releases without replacing its desktop application. You can approve a selected update and activate eligible components in an existing DSH web profile. Background checks only read update information. Updates to the updater itself require a stopped-Host installation; native application and DSH core updates still require a desktop installer.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This plugin mounts into an existing DSH web profile. It does not declare a `dsh.bundle.patch`; installing it as a package dependency does not activate it. The finite [first-install utility](src/install.ts) selects one DSH home and runtime root, verifies the component catalog, and shows a plan before it can change that profile.

An operator uses `install.mjs` from the verified updater distribution with `--dsh-home` and `--runtime-root`. Without `--yes`, the utility reads runtime information and the signed catalog, then returns the selected version, digest, size and profile revision without downloading the component or changing files. To confirm that plan, add `--yes --expected-sha256 <plan.sha256> --expected-patch-revision <plan.expectedPatchRevision>`. A changed candidate digest or profile revision rejects installation before writing files. The utility refuses to replace an existing updater row or declared updater dependency.

The confirmed installation adds an updater-owned row to the selected profile's `cordis.patch.yml`. A running Host that watches that profile can load the row without restarting the desktop. The result is `activation-pending`, not proof that loading succeeded: check that `/updates` is available in that Host before treating installation as complete. The utility neither starts another DSH application nor changes the native updater endpoint compiled into an installed `0.2.1` desktop.

Use `/updates` or ask the agent to use `clawmaster_updates` to inspect current update information. Neither entry point downloads an artifact or changes files. To prepare a selected update, the agent uses `clawmaster_update` with its kind and version, plus a component id when applicable. One approval covers the concrete operation shown: a hot component is downloaded, verified, installed and submitted to the Loader; a restart-only component is downloaded, verified and staged. The selected bytes and profile revision are pinned before approval.

For an eligible hot component, activation changes only its updater-owned profile row and returns a rollback token. Loader observation establishes whether the component actually loaded. A changed profile revision rejects activation or rollback rather than replacing intervening edits. Updates to `updates` are staged without editing the watched profile; a desktop containing the maintenance helper applies the approved selection before its next Host starts. The loaded updater confirms its exact entry URL and executing Host identity after its registrations succeed. Other restart-only components remain staged for a separate stopped-Host installation.

Discovery includes durable operation progress. `staged` means approved and waiting for a supported desktop restart; `awaiting-health` means selected but not confirmed loaded; `completed` includes the observing Host identity. An unconfirmed switch is restored at the next startup, preserving its `rolled-back` record. Candidate verification failures and intervening edits produce `blocked` without replacing the profile. Ask the agent to use `clawmaster_update_rollback` with an operation token to request one approval for a previous verified updater version. This tool is limited to the updater, restores no business database, and refuses first-install removal because no previous updater version exists.

Updater `0.1.2` reads the native v2 channel. Separately installed updaters `0.1.0` and `0.1.1`, and the published access kit `0.1.0`, retain their versions and legacy channel until separately upgraded. The kit's first-install operation cannot replace an existing updater. Changing the endpoint alone does not teach an older parser to accept a release without Intel Mac files.

-----

<a id="configuration"></a>
## Configuration

The [configuration schema](src/config.ts) owns the accepted fields and defaults. The [first-install utility](src/installer.ts) pins the production component endpoint and public key. Runtime compatibility uses the selected Host's DSH version; a signed archive must also contain its declared dependencies and match the shared Host package versions.

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `DSH_HOME`, otherwise `~/.dsh` | Existing selected Host home; update requests cannot override it. |
| `catalogUrl` | `https://8.140.52.117/updates/clawmaster/components/catalog.json` | Signed component metadata. |
| `nativeManifestUrl` | `https://8.140.52.117/updates/clawmaster/v2/latest.json` | Native desktop release metadata. |
| `publicKeyPem`, `nativePublicKey` | Shipped component and Tauri public keys | Independent trust anchors for the two kinds of artifact. |
| `checkIntervalMs` | `60000` | Automatic metadata check interval; `0` disables automatic checks. |
| `nativeTarget` | Observed platform and installation type | Explicit selection is required when the Host cannot establish the installer type. |
| `locale` | `zh-CN` | Command and approval language; also accepts `en-US`. |

Polling reads metadata only. Network failures appear as unavailable channel information, and the other channel can still be checked. Plugin disposal cancels and waits for its checks and update operations. Request, download and archive limits are configurable in the same schema; profile patches have a fixed 2 MiB safety limit.

Native manifests require Windows x64, Apple Silicon, Linux x64 AppImage and Linux x64 DEB targets. Intel Mac is optional for reading earlier releases; unknown targets and missing required targets are rejected. When the selected machine has no installer in a valid release, discovery reports that native update as unavailable and preparation stops before approval, downloading or writing files. The component catalog remains usable. Native file URLs must match the manifest directory’s `versions/<version>/` subtree and exact target filename; legacy and v2 channels cannot borrow each other’s files.

Updater-owned files live below `DSH_HOME/clawmaster-updates/`. Version directories are immutable; download digests identify cached bytes. The profile edit is confined to `DSH_HOME/profiles/web/cordis.patch.yml`. Existing sessions, credentials and unrelated profile rows are not update targets.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [catalog reader](src/catalog.ts) verifies a detached Ed25519 signature over the exact catalog bytes before accepting their schema. It pins the public key, requires HTTPS, rejects redirects and restricts component artifact URLs to the configured origin and component artifact path. The signed descriptor identifies each version, compatible DSH version, activation mode, byte count and SHA-256 digest. The [download helper](src/download.ts) enforces request and byte limits before publishing verified cached files. Concurrent or repeated downloads reuse an occupied cache directory only after checking that its regular payload has the same size and digest. Links and changed bytes are rejected; a rename failure without a matching verified cache remains an error.

The [component installer](src/components.ts) validates the archive before extraction, accepts regular package files and directories, and rejects unsafe paths, links, duplicate paths and incomplete dependency closures. It checks original archive paths before Windows separator conversion, including paths supplied by extended headers. It does not run npm lifecycle scripts. Installation records file hashes; activation rechecks those hashes and uses a file lock plus the reviewed profile revision. Rollback restores the recorded prior profile only when the successor revision still matches.

The [bootstrap](src/bootstrap.ts) permits the updater's first mount while a Host runs; it cannot replace an updater that is already present. The desktop invokes its bundled [finite maintenance helper](src/maintenance.ts) after reclaiming its prior Host and before spawning its next one. The helper rejects a still-live recorded Host, rechecks installed bytes and the approved profile, and journals `switching` before the atomic replacement. A restart during either side of replacement restores the prior verified profile. Recovery refuses to overwrite a later user edit. Maintenance is desktop-owned; it does not launch DSH or unload the updater from its own call.

The [native download helper](src/native.ts) verifies desktop payloads with the existing Tauri Minisign public key in an abortable worker. It returns `requires-native-installer` and never launches an installer. Serving a native manifest, downloading an authenticated file, and installing that file are separate outcomes.

Component publication uses the [build](scripts/build.mjs), [pack](scripts/pack.mjs), [offline signer](scripts/sign-catalog.mjs) and [server publisher](scripts/publish-catalog.mjs). The signer authenticates the catalog and separately signs the finite installer after comparing it with the archived installer. Installer signatures include a domain identifier and the versioned filename, preventing reuse under another version's name. The publisher needs only the pinned public key and a caller-held publication lock. It verifies inputs, refuses version rollback or changed immutable versions, and publishes complete files before switching the active catalog pointer. Private signing material stays off the distribution server.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DSH profiles](../../packages/boot/app-boot/README.md): profile composition and loading.
- [User approval](../../packages/interaction/user-approval/README.md): one-shot decisions for agent operations.
- [Server update publication](../../apps/desktop-tauri/server-updates/README.md): distribution and operational recovery.
- [Installed DSH update decision](../../.agents/notes/implemented/architecture/2026-09-15-installed-dsh-component-updates.md): ownership and rejected alternatives.
- [Desktop releases](../../apps/desktop-tauri/README.md#release): native installation and restart behavior.

-----

<a id="model-experience"></a>
## Model Experience

`clawmaster_updates` checks update metadata and recorded operation states without write approval. `clawmaster_update` selects a component, runtime or native release; `clawmaster_update_rollback` selects an observed updater operation token. Their arguments cannot supply an arbitrary URL, trust key, local path or profile row. Mutations require an owning agent Session and an `allowed-once` decision; rejection or cancellation does not authorize a write. Results distinguish pending Loader activation, staged restart-only changes, observed loaded updater versions, runtime files requiring desktop support and files requiring native installation. The model must report those states accurately rather than describe a staged or downloaded update as active.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Available operations depend on the catalog and the selected Host.

- The initial component catalog contains only `updates` version `0.1.0`; it does not establish that a new DSH runtime or other component is available.
- No separate update page or sidebar is provided. The existing command and agent tool are the user entry points.
- Updater apply-on-restart requires a desktop containing the maintenance helper and a candidate containing load confirmation. Older desktops, WSL Hosts, and other restart-only components need a separate upgrade path; native cross-platform installation acceptance remains required.
- DSH core and native application files cannot be hot-replaced. Verified native downloads still require the desktop installation path.
- Updater health confirms its registrations and executing version; it does not prove every business integration is healthy. Non-updater rollback requires a reviewed data-compatibility procedure and remains a maintainer API. No database downgrade is performed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
