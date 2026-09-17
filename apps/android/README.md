---
description: ClawMaster Android runs the desktop DSH client and local host.
---

# ClawMaster for Android

English | [中文](README.zh.md)

## Summary

ClawMaster for Android starts the DSH host on the device and displays the shared ClawMaster Web client in Android WebView. Its launcher artwork comes from the same SVG as desktop. The Android app uses the desktop default profile; it does not connect to a separate desktop host. Android 8.0 or later is required.

## Contents

- [Use](#use)
- [Data and permissions](#data-and-permissions)
- [Development](#development)
- [Distribution](#distribution)

<a id="use"></a>
## Use

Launch the app while connected to the internet. On first launch, it verifies and extracts its DSH payload, installs locked production dependencies into app-private storage, and starts the local host. First launch can take several minutes. Keep the app open until the desktop client appears; retry startup if the host reports an error.

The shared Web client provides the desktop product interface and desktop profile. Android parity still depends on each profile capability working on Android. Features that require desktop-native process, device, or window integration need an Android implementation and cloud-device acceptance before they can be considered available.

The Android app currently targets arm64-v8a and x86_64. Its Node.js 22.19.0 runtime is experimental because Node.js upstream does not support Android. The DSH home, runtime payloads, and installed dependencies are kept in the app's private files directory. The app requires a network connection for initial dependency installation and for configured remote services.

<a id="data-and-permissions"></a>
## Data and permissions

The app declares Internet and network-state access, a data-sync foreground service, and notification access needed while the local DSH host runs. It limits WebView navigation to its loopback host and handles file selection through Android. DSH configuration, sessions, workspace data, runtime files, and installed dependencies live in app-private storage. Android removes them when the app is uninstalled. Do not put API keys in shared URLs or logs.

<a id="development"></a>
## Development

Android builds and emulator checks run in GitHub Actions. Do not build or run an Android emulator locally for this project. The cloud workflow builds checksum-pinned Node.js 22.19.0 runtimes for arm64 and x86_64, packages the built desktop DSH harness and locked dependencies, and validates the release APK on Android API 26 and API 36 emulators for both ABIs. Tests check the installed icon, local DSH startup, the shared ClawMaster workbench, Activity recreation, and host stop/restart. Cloud DOM checks identify the shared frontend but do not establish acceptance of every desktop capability.

The release APK task is run by the cloud workflow after it installs the matching Android Node runtime and DSH payload. The workflow signs test builds with a disposable validation certificate, records the APK checksum and signer, and keeps the APK on the runner. Never use that certificate for distribution.

<a id="distribution"></a>
## Distribution

Distribution requires the tested APK to be signed with the retained Android release key. Verify the APK signature, package version, version code, ABI contents, checksum, and certificate fingerprint before an authorized upload. Updates must use the same release key and a higher version code. A cloud validation APK signed with a temporary certificate is not distributable.

An APK build is not a Google Play publication or Android developer-account verification. Node.js on Android is experimental, and desktop feature parity remains incomplete until Android-specific capability workflows are accepted.
