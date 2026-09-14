# Agent Note: Durable ClawMaster notes with explicit writes

Status: implemented

English | [中文](2026-09-13-clawmaster-notes-vault.zh.md)

## Problem

A built-in notebook must preserve drafts, share portable files with external editors, and separate an agent's proposed changes from approved note mutations.

## Decision

The [Notes component](../../../../frontends/notes/README.md) uses DSH authentication, tool types, approval and sidebar registration. Host and Client ship together with eight JSON routes. `notes_write` and `notes_digest` require an owning agent and one-shot approval. Every tool joins plugin lifetime tracking; unloading cancels pending approvals and waits for active operations and revision scans.

Cooperative writers serialize revision checks through the existing cross-process lock. Every note content write checks its final UTF-8 byte count against the read budget, including headers and append results, so a successful write remains readable. Rejection leaves existing bytes and revisions unchanged. Atomic replacement protects saves; no-replace publication protects occupied destinations. Checked paths reject linked descendants. Proposal JSON under `.clawmaster/proposals` uses the same storage protections. Creation checks cumulative JSON bytes and entry count under the writer lock; reads enforce the same budgets. It remains accessible externally while excluded from the note index. Drafting persists metadata without another approval; source Markdown changes only on application.

The visible panel polls a version covering notes and bounded proposal contents. Revision requests own filesystem scans; native watches are unnecessary for this refresh path and expose Windows short-path roots to [libuv event failures](https://github.com/libuv/libuv/pull/5152). Drafts survive concurrent refresh, navigation, rename and proposal application in Session-scoped plugin memory. Note, tag and proposal refreshes settle independently; a failed proposal listing retains its error and retry without hiding successful note queries. Conflicts preserve drafts and disk contents; explicit reload and deletion require confirmation. Nested folders and inline SVG icons reuse the host's visual conventions.

Reading and writing take the panel's available height with a 15px textarea. The directory collapses on note selection and reopens beside the editor at wide widths or over it at narrow widths. Collapsed note details keep the pending proposal count visible, so prioritizing the editor does not hide the need for review. Applying a proposal remains an explicit action. The host sidebar owns fullscreen display; Notes adds no fullscreen API or separate draft owner.

## Alternatives considered

Requiring Obsidian excludes fresh installations. A second server duplicates authentication. Blind overwrite and automatic draft replacement lose user intent. A durable draft database introduces another content owner. Reserving a vertical directory strip reduces writing height even after a note is selected; a collapsible directory keeps navigation available without that fixed cost.

## Consequences

Unsaved drafts do not survive process exit. Filesystem isolation, crash durability, hard-link requirements and fingerprint limitations remain explicit [limitations](../../../../frontends/notes/README.md#known-limitations-and-deferred-work).

## Verification

Storage, lifecycle and built-Host tests exercise synthetic files, late approval after unload, final note write budgets, cumulative proposal budgets, external edits and metadata-only revision changes. Scan barriers verify concurrent request sharing and quiescent unload; native-watch rejection verifies the built routes remain usable. Compiled-client tests cover draft races, automatic proposal refresh and confirmation flows. Type checking and artifact freshness checks pass. These checks do not establish final installed-UI acceptance.
