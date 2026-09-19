# Agent Note: Android validation on a GitHub-hosted emulator

Status: proposed

English | [中文](2026-09-17-android-validation-on-github-emulator.zh.md)

## Problem

Android builds and device tests should not consume resources on the user's computer, and the repository has no Android workflow despite its Android README describing emulator validation.

## Proposal

Use GitHub-hosted Linux runners with hardware-accelerated Android Emulator for Android release builds and instrumentation tests on API 26 and API 36. Generate a disposable CI signing key, verify the APK signature and checksum, and retain the APK and evidence briefly as a validation artifact. The artifact is not a public release and cannot replace signing with the retained release key.

The same workflow cross-compiles the pinned Node.js 22.19.0 source for Android arm64 and x86_64 with NDK r28.2, using the runner's host compiler for build-time tools. It checks 16 KB ELF segment alignment and launches the x86_64 binary on an Android 16 16 KB emulator. The source build applies a small patch that disables V8's `execinfo` native stack traces on Android, where the NDK does not provide that glibc API. This is a feasibility gate for a future on-device DSH Host. Node.js does not support Android upstream; a successful runtime smoke does not mean the Android app embeds DSH, supports its native add-ons, or passes the Node.js suite.

The workflow covers the current standalone Android implementation. Desktop feature parity remains a separate product requirement and must not be inferred from a successful build or emulator run.

## Alternatives considered

**Run the emulator on the user's computer.** This consumes local memory and CPU and conflicts with the requirement to keep Android emulator work in GitHub.

**Publish every successful workflow APK.** The CI key is disposable, so its signature cannot support an in-place upgrade or establish a distributable release.

## Acceptance criteria

- The workflow runs Android build and instrumentation checks on a GitHub-hosted Android emulator without starting a local emulator.
- The workflow cross-builds both Android 64-bit Node targets, checks load-segment alignment, and runs Node child-process smoke coverage on the 16 KB Android emulator.
- It records the CI APK checksum and signer certificate and retains a clearly labeled validation artifact for seven days.
- The Android documentation describes only checks the workflow actually performs and says that validation does not establish desktop feature parity or release signing.

## Risks

GitHub runner availability, SDK downloads, or emulator boot may fail independently of product behavior. The current native Android app lacks desktop DSH features, so cloud validation alone does not meet the requested parity goal.
