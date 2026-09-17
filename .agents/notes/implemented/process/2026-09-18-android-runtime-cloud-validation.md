# Agent Note: Build the Android Node runtime and app checks in one workflow

Status: implemented

English | [中文](2026-09-18-android-runtime-cloud-validation.zh.md)

## Problem

The app-process Node check needs an Android runtime built from the same source revision. Requiring a separate completed build run makes manual cloud validation depend on an earlier workflow and prevents one run from showing the build-to-emulator result. The default Node make target also compiles host test programs that are not part of the Android runtime.

## Decision

The [Android cloud workflow](../../../../.github/workflows/android-cloud-validation.yml) builds only the Node runtime target with `make node`, then uploads each ABI runtime as a short-lived workflow artifact. A manual run without a prior run ID performs that build in the same workflow and packages the runtime for cloud-emulator tests. A manual run with a run ID verifies that run's x86_64 runtime job completed successfully before downloading its artifact. Runtime libraries are added only to the runner's temporary validation APK; the workflow does not upload that APK.

## Alternatives considered

**Keep the default make target.** It also builds Node's host-side test programs. The Android NDK build fails in an unrelated test source that refers to `aligned_alloc`, so those targets add failure without strengthening the runtime check.

**Require two workflow runs for every app-process check.** This preserves reusable runtime artifacts but makes the ordinary validation path depend on a separate run and a manually copied run ID. The optional run ID keeps reuse available while allowing one-run build-to-emulator validation.

## Consequences

The hosted build still compiles each requested ABI from Node source and can take a long time; the workflow retains its bounded job timeout. The artifact proves that the Android Node binary ran under the app UID. It does not prove that DSH starts, that desktop features work on Android, or that the distributed Android app contains DSH.

## Verification

The workflow YAML parses, its Node-runtime and emulator jobs remain present, and `git diff --check` passes. GitHub Actions must complete the runtime build and app-process instrumentation on the cloud emulator before this workflow change is accepted.
