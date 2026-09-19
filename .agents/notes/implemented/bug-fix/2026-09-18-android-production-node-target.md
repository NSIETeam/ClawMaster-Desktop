# Agent Note: build only the Android production Node target

Status: implemented

English | [中文](2026-09-18-android-production-node-target.zh.md)

## Problem

The Android runtime workflow used the default Node.js make target, which also compiled `cctest` sources that are not part of the shipped runtime and fail with the selected Android NDK.

## Decision

After `android-configure` generates the output tree, the workflow invokes the `node` target under `out` with the Release configuration. It retains the executable check, 16 KB ELF alignment check, and emulator smoke test for the produced Node binary.

## Alternatives considered

Building the default target and patching Android-only C++ test code would add test-only compatibility work to the shipped runtime build. The release artifact needs the production executable, while Android behavior remains covered by the device smoke test.

## Consequences

The runtime lane no longer builds Node's test executables. Its result proves that the production Node binary builds and runs on the selected Android emulator; it does not claim that Node's C++ test suite runs on Android.

## Verification

The workflow regression test requires the explicit `node` target, rejects the default parallel `make` invocation, and keeps the ELF and emulator checks present. The workflow's two ABI builds remain the platform verification for the compiler change.
