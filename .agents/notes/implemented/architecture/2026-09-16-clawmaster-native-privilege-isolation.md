# Agent Note: ClawMaster native privileges belong to packaged WebViews

Status: implemented

English | [中文](2026-09-16-clawmaster-native-privilege-isolation.zh.md)

## Problem

A desktop window contains both a packaged shell and a separate authenticated Host WebView. Window-wide permissions include child WebViews, while a localhost wildcard also identifies unrelated listeners. Document content must not inherit native commands through either rule.

## Decision

The [capability](../../../../apps/desktop-tauri/src-tauri/capabilities/default.json) matches only packaged `main` and `splash` WebViews. The application build manifest registers its three shell commands for Tauri ACL enforcement. Host content and preview frames receive no native permissions. The [navigation validator](../../../../apps/desktop-tauri/src-tauri/src/webview_security.rs) requires a numeric loopback HTTP address with an explicit port, allows only that exact origin, rejects credentials, and denies new windows.

The packaged shell's deny-by-default CSP allows local scripts and images, Tauri IPC and inline styles for progress updates. Tauri hashes packaged inline scripts; arbitrary inline JavaScript and `eval` are not granted. This policy does not replace the separate Host's web-resource policy or DSH tool permissions. The [runtime-governance decision](2026-09-13-clawmaster-runtime-governance.md) retains execution-policy ownership; plugins remain trusted code with Host-process authority.

## Alternatives considered

**Grant permissions to the parent window or localhost wildcard.** These rules authorize child views or unrelated listeners. The [native-window decision](../feature/2026-09-13-clawmaster-native-window-titlebar.md) already assigns dragging and controls to native decorations.

**Block inline styles as well as scripts.** The existing progress renderer updates style properties. This narrow style exception grants neither script execution nor remote resource access.

## Consequences

Host content cannot invoke shell lifecycle commands or create native windows. External links requesting new native windows are refused; the ordinary embedded browser remains separate. Future native actions need explicitly reviewed capabilities. An arbitrary malicious Host plugin is not isolated by WebView ACL.

Rust URL tests reject wrong ports, origins, credentials and non-HTTP targets. The actual application ACL compiles, and policy tests reject window-wide or remote grants. These source checks do not establish installed WebView behavior across platforms; packaged native interaction remains a separate acceptance requirement.
