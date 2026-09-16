# Agent Note: Native desktop decorations and window reopening

Status: implemented

English | [中文](2026-09-13-clawmaster-native-window-titlebar.zh.md)

## Problem

An in-window title bar duplicates the platform's controls and product branding while requiring its own geometry and theme handling. A macOS window hidden by the saved close preference must also remain reachable through Dock and Finder reopening without launching another Host.

## Decision

The main window uses native decorations and macOS hides title text. The platform owns window appearance; the embedded DSH client owns its Web theme. They may differ. A custom themed title row, private AppKit masking, and the frameless-only Tauri feature are unnecessary.

The [native content-rectangle decision](../architecture/2026-09-15-macos-native-content-rectangle.md) owns macOS control separation and supersedes the overlay reservation. The [native-privilege decision](../architecture/2026-09-16-clawmaster-native-privilege-isolation.md) confines commands to packaged shell WebViews; Host content receives no native permissions.

`shell.html` owns the close-confirmation dialog, using the system color scheme. It hides the content WebView while the dialog is open. The saved minimize preference hides the main window and keeps the Host running; explicit Quit stops the Host process tree. macOS `RunEvent::Reopen` calls `show_main`, which shows, unminimizes and focuses the existing main or startup window. It creates no window, Host, Session or Workspace. Existing `ExitRequested` prevention still protects the running app until Quit is requested.

`window_layout.rs` retains button-layout parsing for the local chrome bootstrap and adds no in-content title-bar offset. The [ClawMaster shell decision](2026-09-12-clawmaster-shell-over-dsh.md) owns the product identity, runtime and release configuration.

## Alternatives considered

**Keep a custom themed title bar.** A second control implementation must track platform geometry, colors and traffic-light behavior independently.

**Hide only the product mark.** That leaves the duplicated row and its separately maintained palette and controls.

**Round a transparent borderless window with an AppKit mask.** Native decorations already own the system radius and shadow, so a private mask adds platform maintenance without a required behavior.

**Start a Host when macOS reopens the app.** Reopening can target a live process with a hidden window; starting another Host would duplicate runtime ownership and compete for the same user data.

## Consequences

Native decorations own window geometry and appearance. Matching a user-selected Web theme is not a native-window guarantee. The content-rectangle decision owns the packaged macOS geometry check independently of sidebar markup.

Rust layout and close-preference tests cover existing mechanical behavior. Packaged desktop acceptance must additionally check close-to-hide followed by Dock or Finder reopening, retained Host identity, close-dialog visibility, and native controls in both system appearances. Restoring a custom title row requires coordinating its markup, content height and permissions; it is not a theme setting.
