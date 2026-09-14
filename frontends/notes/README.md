---
description: "ClawMaster notes: local Markdown editing, wiki links, search, diff-reviewed agent proposals and approval-gated writes."
kind: "package-bundle"
---

# ClawMaster Notes

English | [中文](README.zh.md)

## Summary

ClawMaster includes a local notebook with formatted document editing, Markdown source, wiki links, backlinks, tags and text search. You can ask the agent to record finished work as notes, or to propose an edit and store a reviewable draft without changing the source note; note changes made by the agent require approval. The product creates its own vault without requiring Obsidian. Saved notes remain ordinary files; unsaved drafts remain in memory for the current application session.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Verification](#verification)
- [Further Exploration](#further-exploration)

<a id="use-this-package"></a>
## Use this package

This private component is included in the ClawMaster desktop profile through its [bundle patch](cordis.patch.yml). Open **Notes** from the sidebar tab selector. The host creates the configured vault when the plugin loads and seeds a welcome note when it contains no supported notes.

Selecting a note collapses the directory to give the editor the panel's available height. Use **Note list** in the toolbar to show or hide it. On a wide panel the directory opens beside the editor; on a narrow panel it overlays the editor until you choose a note or close it. For more space, use the host sidebar's fullscreen control.

Open a note and edit its formatted document directly. After you stop typing briefly, Notes saves your changes automatically; source edits use the same saving process. The status shows **Saving…** or **Saved**. Before exiting the application, confirm that your changes are saved.

Edit the **File name** above the document to rename the file. Enter or leaving the field submits the name; Escape restores it. Renaming keeps the parent folder and Markdown extension, and changes neither a heading in the document nor its YAML frontmatter. Those are separate parts of the note's content.

Open **More note actions → Show formatting tools** when you need paragraphs, headings, quotes, bold, italic, inline code, lists, checklists, links, tables, separators or code blocks. **Markdown source** in the same menu opens the complete source, including frontmatter; **Back to document** returns to formatted editing when supported. **Delete** requires confirmation and does not use the trash. **Today's note** opens the dated diary note, creating it once.

Opening a note or switching views without editing retains its original source and does not save it. An actual document edit preserves raw frontmatter and the whitespace around the body, but serializes the body as conventional Markdown. Use source editing when exact body formatting matters. Unsupported constructs, including wiki links outside code, embedded images, raw HTML and leading indented code, retain the draft in source view with a notice. Falling back does not convert or save it; your subsequent source edits save automatically.

A failed save or revision conflict pauses automatic retries and retains the draft; a conflict does not overwrite the newer file. Correct the cause and choose **More note actions → Retry saving**. For a conflict, compare the latest content with your draft; **Reload** asks before discarding the draft. More typing does not bypass a paused save.

Selecting another note waits for the current save attempt. You can leave after a failure; the same Session retains the draft and failure. Closing the Notes tab starts a background save attempt, and reopening reconnects to pending saves and retained errors while the plugin remains loaded. Creating, renaming or deleting a note and applying a proposal require the current draft to save successfully first.

**Linked notes** in **Note details** lists wiki-link targets from the loaded or saved note. Open a target there; when several notes match you choose, and when none matches you are offered its creation. Backlinks remain available in the same section. A `.canvas` file opens read-only with editing and renaming disabled, because this component has no canvas editor.

**Note details** starts collapsed and opens the tags, backlinks and **Proposals**. The pending proposal count remains visible when the section is collapsed. Expand it to review a proposal's diff, then explicitly choose **Apply** or **Discard**; opening the section does not apply changes. Applying is revision-guarded: if the note moved since the proposal was drafted, the apply is refused and the proposal stays for a retry. A failed or conflicting save keeps the draft and prevents application of the proposal.

While the tab is visible the panel polls every four seconds for a version covering both notes and pending proposals, so external edits and proposal creation or discard appear without a manual refresh. An unsaved draft is never discarded by that refresh: the panel reports the external change and offers a reload. Note, tag and proposal refreshes settle independently. A failed proposal listing retains its error and retry action while successfully loaded notes and tags remain usable.

<a id="configuration"></a>
## Configuration

The [host configuration](src/host.ts) accepts an absolute `vaultRoot`. Its default is `~/Documents/ClawMaster 笔记` on macOS and `~/ClawMasterNotes` elsewhere, outside the desktop runtime directories. Reads, writes, listings, search, tags and backlinks share these limits. Every note write checks final UTF-8 bytes, including daily headers and appended content, before changing a file; rejection preserves existing bytes and revisions.

| Field | Default | Meaning |
|---|---|---|
| `limits.maxReadBytes` | 262144 | Maximum final UTF-8 bytes per note read/write, aggregate stored proposal JSON, or combined before/after diff inputs. |
| `limits.maxTreeEntries` | 5000 | Maximum entries in a note or proposal listing; proposal creation enforces the stored proposal count. |
| `limits.maxSearchResults` | 50 | Default and maximum search hits; configurable up to 200. |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The [host](src/host.ts) registers eight routes on the existing authenticated DSH Fetch carrier: GET `tree`, `note`, `search`, `tags`, `backlinks`, `proposals` and `revision`, plus POST `command`, under `/api/clawmaster/notes/`. The carrier owns authentication and origin checks; the browser uses same-origin credentials. No additional server is started. Tool definitions, execution contexts and approvals use the public DSH types. Disposal removes registrations, cancels pending approvals and waits for active tools, requests and revision scans. Host and Client must ship together: a client-only update cannot supply missing API routes.

The [vault](src/vault.ts) rejects linked files and linked directories below its canonical root. Cooperative writers share a cross-process file lock; revision checks and mutation receipts are calculated while holding it. Saves publish complete temporary files through atomic replacement. Creation and renaming use hard links that refuse an occupied destination. The browser renders parsed Markdown data rather than raw HTML, and [shared text parsing](src/note-format.ts) does not rewrite frontmatter.

The [proposal store](src/proposals.ts) persists drafts and base revisions as JSON under `.clawmaster/proposals`, excluded from the note index but readable through external filesystem access. Metadata reuses checked vault paths, bounded reads, the write lock and atomic no-replace publication. Proposal creation checks the stored entry count and aggregate JSON bytes under the vault writer lock. Listings use the same limits; proposal texts and source texts share a second aggregate diff-input budget. Unsafe paths, corrupt metadata and excess bytes fail explicitly. The [line diff](src/diff.ts) uses whole-file replacement above 2000 lines per side and marks truncated output.

The [revision scanner](src/watcher.ts) fingerprints note paths, sizes and modification times on request, sharing concurrent scans. The `revision` route combines that fingerprint with a bounded proposal-content digest, so metadata-only changes also refresh the panel. Scan failures reach the request; teardown waits for active scans. No native filesystem watch or background scan is started.

The [panel](src/client.tsx) retains each note's complete Markdown draft and read revision in a [Session-owned save queue](src/autosave.ts). Both editors use a 600 ms idle delay; the queue serializes requests across notes. Successful saves advance only the submitted snapshot; later typing remains queued. A failure pauses automatic retries for that note until an explicit retry or confirmed reload. The [document adapter](src/rich-editor.tsx) separates raw frontmatter and surrounding whitespace from the editable body, ignores initialization normalization, and returns unsupported input to source mode. MDXEditor 4.2.5 is bundled into the minified browser artifact with its MIT license banner; CodeMirror language-support autoloading is disabled. [Tree](src/tree.ts) derives nested folders from note ids using the host explorer's row spacing, and [icons](src/icons.tsx) use inline SVG.

</details>

<a id="model-experience"></a>
## Model Experience

`notes_query` reads the configured vault without a write approval, including the pending proposals. `notes_propose` drafts a change and returns its line diff **without writing any note**, while persisting local proposal JSON without an additional approval. `notes_write` creates, saves, appends, renames, deletes, adds a dated diary entry, or applies and discards a stored proposal. `notes_digest` composes one dated work entry from what was done plus optional decisions, evidence and next steps, links a matching project note, and appends it to the daily note; that is the primitive for turning finished work into notes.

Note mutations through `notes_write` and `notes_digest` require an owning DSH agent Session and an `allowed-once` approval; denial, cancellation or plugin unloading prevents a pending approval from committing. A save supplies the revision obtained from a read and returns a conflict when it differs. Applying a proposal supplies the revision the draft was based on and is refused on drift. Receipts report the previous and resulting revisions, not a recoverable copy of deleted or replaced content. Direct authenticated UI commands are user edits and do not request an additional agent approval.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Unsupported document constructs remain editable as [Markdown source](#use-this-package). This component does not implement Obsidian plugins or a canvas editor. Search scans files rather than a persistent index, and listing reads one head per note for its title.
- Live refresh uses polling and may be delayed by failed requests or a hidden tab. The note fingerprint cannot detect edits that preserve both size and modification time.
- Drafts and pending save queues are not persisted across process exit or crashes. Closing a tab starts a save attempt, not a guarantee that saving finishes before process exit. The browser receives an unload warning when drafts exist; native application quit protection is not verified.
- File locks coordinate cooperating writers; they do not isolate hostile or uncooperative processes replacing ancestors or racing the final filesystem operation. Writes do not promise crash durability through `fsync`.
- Creation and renaming require hard-link support. A failed rename cleanup can leave both paths, with an explicit error. A lock left by abnormal exit requires manual verification and recovery; the component does not remove it automatically.

<a id="verification"></a>
## Verification

From the repository root with development dependencies installed, run the storage/host tests, the compiled-client tests, the type check and the artifact freshness check. The client runner builds the bundle first, because it drives the shipped artifact rather than the source:

```sh
npm --prefix frontends/notes test
npm run test:notes-client
npm --prefix frontends/notes run typecheck
node frontends/notes/scripts/build.mjs --check
```

These checks exercise synthetic files and controlled browser responses. They do not establish acceptance of the final installed Notes UI.

<a id="further-exploration"></a>
## Further Exploration

The [Agent Note](../../.agents/notes/implemented/feature/2026-09-13-clawmaster-notes-vault.md) records why the module exists, the decisions behind the storage and review model, and what was verified.
