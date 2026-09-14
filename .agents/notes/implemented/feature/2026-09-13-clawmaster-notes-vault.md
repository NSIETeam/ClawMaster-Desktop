# Agent Note: Durable ClawMaster notes with explicit writes

Status: implemented

English | [中文](2026-09-13-clawmaster-notes-vault.zh.md)

## Problem

A built-in notebook must preserve drafts, share portable files with external editors, and separate an agent's proposed changes from approved note mutations.

## Decision

The [Notes component](../../../../frontends/notes/README.md) uses DSH authentication, tool types, approval and sidebar registration. Host and Client ship together with eight JSON routes. `notes_write` and `notes_digest` require an owning agent and one-shot approval. Every tool joins plugin lifetime tracking; unloading cancels pending approvals and waits for active operations and revision scans.

Cooperative writers serialize revision checks through the existing cross-process lock. Every note content write checks its final UTF-8 byte count against the read budget, including headers and append results, so a successful write remains readable. Rejection leaves existing bytes and revisions unchanged. Atomic replacement protects saves; no-replace publication protects occupied destinations. Checked paths reject linked descendants. Proposal JSON under `.clawmaster/proposals` uses the same storage protections. Creation checks cumulative JSON bytes and entry count under the writer lock; reads enforce the same budgets. It remains accessible externally while excluded from the note index. Drafting persists metadata without another approval; source Markdown changes only on application.

The visible panel polls a version covering notes and bounded proposal contents. Revision requests own filesystem scans; native watches are unnecessary for this refresh path and expose Windows short-path roots to [libuv event failures](https://github.com/libuv/libuv/pull/5152). Drafts and failed saves remain in Session-scoped plugin memory across concurrent refresh and navigation. Note, tag and proposal refreshes settle independently; a failed proposal listing retains its error and retry without hiding successful note queries. Conflicts preserve drafts and disk contents; explicit reload and deletion require confirmation. Nested folders and inline SVG icons reuse the host's visual conventions.

Reading and writing take the panel's available height. The directory collapses on note selection and reopens beside the editor at wide widths or over it at narrow widths. Collapsed note details keep the pending proposal count visible, so prioritizing the editor does not hide the need for review. Applying a proposal remains an explicit action. The host sidebar owns fullscreen display; Notes adds no fullscreen API or separate draft owner.

The [document editor](../../../../frontends/notes/src/rich-editor.tsx) uses bundled MDXEditor for formatted editing, optional toolbar commands and undo history. One complete Markdown draft remains the persistence authority across formatted and source editing. The adapter preserves raw frontmatter and surrounding body whitespace; initialization and unedited view changes do not publish normalized text. Actual document edits serialize the body as conventional Markdown. Unsupported constructs fall back to source with the original draft intact, including wiki syntax whose escaping would change the vault's link graph. Linked-note navigation uses the loaded or saved note's link index in the details section. CodeMirror language-support autoloading is disabled. The browser artifact carries the editor's MIT license.

Human edits enter a [Session-owned save queue](../../../../frontends/notes/src/autosave.ts) after a short idle delay; requests run serially across notes. A successful response advances the submitted snapshot and revision without replacing later typing. A failure pauses automatic retries for that note until the user retries or confirms a reload. Navigation waits for a save attempt but can leave a failed draft in its Session; tab unmount starts a background flush rather than owning an exit guarantee. Creating, renaming, deleting and applying a proposal require a successful flush. Editing the displayed file name changes only the basename, preserving its directory, document headings and frontmatter. Agent mutations keep their one-shot approval requirement.

## Alternatives considered

Requiring Obsidian excludes fresh installations. A second server duplicates authentication. Blind overwrite and automatic draft replacement lose user intent. A durable draft database introduces another content owner. Reserving a vertical directory strip reduces writing height even after a note is selected; a collapsible directory keeps navigation available without that fixed cost. Reusing the preview block model for editing loses source details; the maintained editor owns formatted editing while unsupported syntax retains a source-editing path. Requiring a separate save action interrupts writing, but retrying with an unreviewed fresh revision could overwrite an external change.

## Consequences

Unsaved drafts and pending queues do not survive process exit or crashes. A tab's background flush does not establish application-exit durability. Filesystem isolation, crash durability, hard-link requirements and fingerprint limitations remain explicit [limitations](../../../../frontends/notes/README.md#known-limitations-and-deferred-work).

## Verification

Storage, lifecycle and built-Host tests exercise synthetic files, late approval after unload, final note write budgets, cumulative proposal budgets, external edits and metadata-only revision changes. Scan barriers verify concurrent request sharing and quiescent unload; native-watch rejection verifies the built routes remain usable. Compiled-client verification uses synthetic files and controlled responses for formatted editing, unchanged source bytes, unsupported syntax, delayed saves, later typing during a save, tab remounts, paused failures and explicit recovery. Rename and proposal cases check that a failed flush prevents the subsequent mutation. These checks do not establish native IME behavior or final installed-UI acceptance.
