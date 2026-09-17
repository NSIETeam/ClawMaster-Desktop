# Agent Note: Host the ClawMaster desktop DSH product on Android

Status: proposed

English | [中文](2026-09-18-clawmaster-android-dsh-host.zh.md)

## Problem

The shipped Android app runs a separate Java agent with its own chat, notes, files, tasks, and settings screens. ClawMaster Desktop runs the DSH Web client with pinned community plugins and ClawMaster product bundles. Reusing the icon alone does not make the Android app the same product, and a Node process smoke test does not prove DSH parity.

## Proposal

Run the same DSH Web client and ordered ClawMaster desktop profile on the Android device. The launcher Activity hosts the shared Web frontend in Android WebView; an Android-owned runtime supervisor starts the on-device Node process, waits for its authenticated loopback URL, and loads that URL without writing its token to logs or persistent preferences. Keep DSH home and provisioned generations in app-private storage. Package the verified desktop harness and a Node runtime built for each Android ABI in the APK; install any additional dependency only from the pinned desktop lock and record its provenance.

Use the desktop profile's exact default bundle list and plugin versions. Before enabling that list on Android, resolve every platform-specific dependency. Implement Android providers for capabilities with mobile equivalents and preserve their approval and data rules. A desktop-only capability remains incomplete until an Android implementation is accepted; the profile must not silently drop it or report it as available when its native operation cannot run.

Keep the ClawMaster SVG as the single launcher and in-product icon source. Use a narrow cleartext exception for the loopback Web server only, reject navigation away from the local DSH origin except for explicit Android-owned file or external-app handoffs, and keep local host authentication in WebView memory. The Android runtime supervisor owns process start, readiness, stop, and relaunch; Activity recreation must not start duplicate hosts.

Implement and validate the transition in GitHub Actions only. Hosted jobs build the desktop DSH payload and Android Node ABIs, assemble the validation APK without publishing it, and exercise it on cloud Android emulators. Cover Android 8/API 26 and Android 16/API 36, both supported ABIs, cold start, Activity recreation, host stop/restart, WebView authentication, and actual ClawMaster workflows. Screenshots and DOM assertions must identify the shared desktop frontend; Node version output or a successful Activity launch is insufficient evidence.

## Alternatives considered

**Keep the separate Java agent and make its screens resemble desktop.** This avoids moving DSH and its profile to Android, but maintains two applications with different settings, sessions, tools, and future behavior. It does not meet the requested product parity.

**Connect Android to a DSH host on a server or computer.** A remote host avoids Android Node and native-provider work, but the user selected DSH running on the Android device. It also changes where workspace data and credentials live.

**Build a second native UI over DSH APIs.** This can use Android widgets and APIs, but it still duplicates the desktop client and its navigation and feature presentation. The shared Web frontend is the product UI to host.

## Acceptance criteria

- The installed Android app uses the ClawMaster icon generated from the same SVG and renders the same DSH Web client, navigation, product branding, and desktop default profile.
- Android Node starts from the installed APK on each supported ABI and runs `dsh web` locally with a private DSH home. Cold start, app backgrounding, Activity recreation, stop, and relaunch do not leak the authenticated URL or create duplicate hosts.
- Every user-facing desktop feature reachable from the default profile is accounted for. Android-equivalent actions complete on device with the same approval and data-protection rules; unavailable native actions are not exposed as successful capabilities.
- Cloud emulator tests exercise configuration, chat/session persistence, tool approval and rejection, file selection and edits, product bundles, Android-specific permissions, and restart recovery on API 26 and API 36.
- The tested APK is signed with the Android release key, its package version and ABI contents are checked, and its checksum and signing certificate are verified before an authorized server upload. A CI validation APK is never distributed.

## Risks

Node's Android port is experimental. The desktop harness may contain native packages or assumptions that do not support Android, including terminal and computer-control integrations. Those require Android-specific implementations and cloud tests before the corresponding feature can be considered available. Android foreground-service rules, WebView cleartext policy, file-picker callbacks, Accessibility permissions, and background process limits may also change lifecycle and first-run behavior. The APK will be substantially larger than the existing standalone app, and first-run dependency provisioning must not block the interface or bypass lockfile, hash, or approval checks.
