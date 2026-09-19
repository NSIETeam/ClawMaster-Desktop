---
description: Standalone Android agent, phone-local data, approval rules, and APK verification.
---

# ClawMaster for Android

English | [中文](README.zh.md)

## Summary

ClawMaster Android runs a native Java agent loop on the phone. It calls the user's HTTPS Chat Completions-compatible model directly; it does not connect to a desktop ClawMaster Host. Android 8.0 or later is required.

## Contents

- [Use](#use)
- [Data and permissions](#data-and-permissions)
- [Development](#development)
- [Distribution](#distribution)

<a id="use"></a>
## Use

Open Settings, enter a model API base URL, model ID and API key, then save. The base URL excludes `/chat/completions`. Messages and requested note/document content go to that configured provider; a network connection and the provider's quota are required.

The agent can search, read and propose writes to phone-local notes. Every agent write opens a native approval dialog. Existing-note writes require the revision that was read; edits made while approval is pending cause a conflict. Manual note editing uses the same revision checks.

Conversation history, notes and pending write approvals persist across restarts. User-initiated tasks use a visible foreground service and can continue after leaving the screen. A run stops after eight minutes or when Android stops its service/job. An interrupted tool with no durable receipt has an unknown outcome and is never retried automatically.

### Documents

Use Files to import a private copy of DOCX, XLSX, PPTX, TXT, Markdown or CSV, up to 8 MiB. Ask the agent to inspect the document or propose changes, review the exact arguments and revision, then approve or reject. The file list provides a text preview and explicit export to the system document picker. Imported originals and earlier revisions remain in private storage; the agent does not overwrite the external source.

Office tools read body paragraphs and top-level tables in Word, existing spreadsheet cells, and top-level slide text shapes. Edits replace addressed text; mixed formatting within that text may flatten. Spreadsheet replacements are literal strings, not formulas. New documents accept paragraphs, tab-separated spreadsheet cells, or form-feed-separated slides. Complex layout, headers, drawings, embedded objects, formula evaluation, macros and digitally signed documents are not supported.

### Tasks

Use Tasks to schedule a prompt, a start delay and an optional interval of at least 15 minutes. Android JobScheduler persists schedules and requires a network; battery restrictions, force-stop and system quotas can delay or stop execution. Scheduling can incur model charges and does not preapprove any write. Enable task notifications in Settings to receive completion or approval prompts.

A write pauses execution and persists its proposal. Open its conversation to review it; only that proposal is authorized and the current revision is checked again. Successful recurring runs schedule their successor; failed, stopped and interrupted runs do not. Inspect the previous result before choosing Run again, because completed writes may already exist. Stop cancels the selected schedule; task records remain available.

This mobile runtime does not include the desktop DSH plugin system, terminal, computer-control RPA, browser automation, Graph Memory, CRM/ERP or cross-device synchronization. It is not an offline on-device language model.

<a id="data-and-permissions"></a>
## Data and permissions

The app declares Internet/network-state, foreground-service, task-notification and reboot-persistence permissions. Shared files are selected through the system picker, without broad storage access. Notes, documents, task records and versioned JSON conversations stay in app-private storage. The model key uses AES-GCM with Android Keystore; it is excluded from model transcripts, logs and APK resources. Cleartext model endpoints and credential-bearing URLs are rejected; authorization headers do not follow redirects.

Removing the API key leaves notes and conversations intact. Uninstalling the app removes its local data; cloud backup and device transfer are disabled. Keep needed content elsewhere before uninstalling. The agent cannot read arbitrary shared storage or execute a shell.

<a id="development"></a>
## Development

Use JDK 17, Gradle 8.13, Android SDK 36 and Build Tools 35.0.0. The Android project is independent of the desktop pnpm build.

The launcher and notification icon use the desktop artwork in `frontends/dsh/src/clawmaster.svg`. Run `node apps/android/scripts/generate-icons.mjs` after editing that artwork; Android builds use Node.js to reject a stale drawable before compilation.

```sh
gradle -p apps/android :core:test :app:lintRelease :app:assembleRelease
```

Core tests replay recorded model exchanges against the shipped loop and file stores, including Office round trips, revision conflicts, persisted approvals and schedule recovery. The [Android Cloud Validation workflow](../../.github/workflows/android-cloud-validation.yml) builds and tests the release variant on GitHub-hosted Android 8 and Android 16 emulators. Its instrumentation checks native approvals, Activity recreation, Keystore operations, Office containers, foreground continuation and system-scheduled execution. A separate feasibility job cross-compiles only the Node.js 22.19.0 production executable for arm64 and x86_64, checks 16 KB ELF alignment, and tries the x86_64 runtime on an Android 16 16 KB emulator. The pinned Node source patch disables V8's unavailable `execinfo` stack traces and adds Android to V8's POSIX trap-handler and ARM64 simulator source mappings needed to link the host `mksnapshot` tool. Node.js does not support Android upstream, so this remains an experimental prerequisite check; the Android app does not bundle or launch DSH yet. The workflow creates a disposable CI signing key, records the APK checksum and signer certificate, and retains validation artifacts for seven days. It does not test upgrades from the released 0.2.1 APK, ordinary launcher relaunch or separate-process cold start. Recorded providers prove local execution, not live provider availability.

The Android emulator build and instrumentation checks run in GitHub Actions. Keep the validation keystore temporary; never use its certificate for a distributed APK or commit a keystore or password.

<a id="distribution"></a>
## Distribution

The Android Cloud Validation workflow builds a non-debuggable APK and runs instrumentation checks on a GitHub-hosted emulator. The artifact is signed with an ephemeral certificate and expires after seven days; it is for validation only. Public distribution requires signing the verified APK with the retained release key, checking it with Android's `apksigner verify`, and recording its SHA-256 and certificate fingerprint. Updates require the same release key and a higher version code.

An APK build is not a Google Play publication or Android developer-account verification. Cloud validation covers the current standalone Android implementation; it does not establish feature parity with the desktop app. The Office build downloads checksum-pinned compatibility source and Maven dependencies; licenses remain in the shaded runtime.
