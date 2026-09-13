# Agent Note: Windows installed desktop validation

Status: implemented

English | [中文](2026-09-14-windows-installed-desktop-validation.zh.md)

## Problem

A copied production Host can start while the Windows installer, native window or normal exit remains broken. Native acceptance also risks adopting existing Harness data because Windows known-folder resolution does not follow an APPDATA environment override.

## Decision

The [native acceptance script](../../../../apps/desktop-tauri/scripts/verify-windows-native.ps1) runs only on disposable GitHub-hosted Windows runners. It refuses existing desktop processes, installed ClawMaster registrations and Harness known-folder data. It owns a unique installation directory and DSH home, configures an isolated Notes vault through the supported home patch, and removes only its acquired directories and processes. Its shell preferences use the real, initially absent application-data directory; changing APPDATA cannot establish isolation.

The script checks the installed executable version, a visible main window, authenticated Host readiness and process parentage. Normal window close must stop both the desktop and Host before another native launch publishes a different run identity. [Evidence validation](../../../../apps/desktop-tauri/scripts/windows-native-evidence.mjs) compares both observations with the published payload provenance and rejects stale or foreign state.

The dispatch-only validation workflow downloads the existing beta.6 installer and manifest from the official public release, checks their SHA-256 values and pins the checksums asset digest. It does not build, publish or replace a release.

## Alternatives considered

**Reuse the copied Host smoke as native evidence.** It does not execute the installer or exercise native window lifetime.

**Redirect only APPDATA.** The Rust directory provider resolves Windows known folders, so the environment override does not isolate shell storage or stale-Host recovery.

## Consequences

An unavailable interactive desktop fails acceptance explicitly. No model requests or Office editing are part of this test. Cross-platform evidence tests establish rejection behavior; only a successful Windows job establishes installed native lifecycle behavior.
