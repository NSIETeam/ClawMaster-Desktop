---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Compact display folds running and completed Turn processes while keeping the current answer and actionable notices visible; packed historical Assistant runs remain collapsed. Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Completed-turn footer](#completed-turn-footer)
- [Turn Process Folding](#turn-process-folding)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Sent file references and skills confirmed by the message’s logged invocation open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## System prompt row

Each nonempty appended `system/message` owns a collapsed prompt row, including a complete prompt at the start of a headerless window; the same-step header does not duplicate it. Chat also shows a collapsed `System prompt` row for a non-empty initial request, explicit message-series start, or `system/message` surface node replacement whose text differs, reading the last nonempty surviving system node in surface order at the `request/header`; a non-initial request whose preceding header is outside the loaded history window also shows one. A resume repeats the row even when its system text is unchanged, including after pagination supplies the preceding header and system node; same-series config-only or tool-only changes, tool steps, and retries create no repetition, and a `system/message` event is never rendered as a transcript message. The row retains its request position in the Session log; Chat places an initial prompt behind the opening human message inside the Turn process. It expands to the exact model-visible text with its original line breaks. A request whose system node is empty or outside the loaded window creates no row until the page holding the node arrives.

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

<a id="completed-turn-footer"></a>
## Completed-turn footer

The completed-turn action footer starts 20px below the preceding prose or extension content.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

ClawMaster builds initially collapse reasoning and context bodies and omit their header previews. Headers retain the content kind and context producer, with product labels for the known system-prompt and time-context plugins; expanded source fields retain their recorded package identifiers. Other producers and user-controlled paths are not renamed. Manual expansion survives streamed updates to the same row; Session events remain intact. The [presentation decision](../../../.agents/notes/implemented/feature/2026-09-13-clawmaster-process-disclosures.md) owns the product scope.

Settings → General exposes a persisted, localized `Normal` / `Compact` conversation-display preference in the `ui-chat` namespace; `Compact` is the default. Normal leaves process rows visible and renders no Turn-process control. Compact groups the initial System prompt, injected context, reasoning, earlier Assistant material, and Tool rows behind the opening human message. An open Turn shows a collapsed `Working` row with its latest folded activity. The current Step's answer stays visible while streaming; opening or closing the process does not duplicate it. Live Retry, Compaction, and extension rows remain outside the running fold, as do user and steering messages, error, max-token, and turn-tail rows. Approval controls keep their independent composer ownership.

At `turn/end`, the latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block and no Tool-call block. Earlier process rows, including Retry rows, collapse by default. A closed Turn without a final answer keeps its evidence visible. A process containing only the initial prompt still has an expand control. The summary reports durable non-subagent Tool calls, reply-bearing Assistant messages before the final answer, and subagent delegation calls; zero-valued segments are omitted. Tool and subagent counts are mutually exclusive, and System prompt and Context injection add no count. A zero-count summary reads `Thought for a while`.

A divider separates the summary from its answer or expanded process. Opening human input precedes the control and process rows from their first projection. While Load earlier can fetch more history, no process control appears and no member is hidden; complete history enables the same running and completed-Turn rules. Stable Chat Node Seats preserve mounted renderers, and hidden members add no flow spacing. A closed control sits 8px above its answer when no independent input intervenes. Collapse can reflow a transcript even when its reader is away from the tail. If automatic collapse would hide keyboard focus, the group stays open; manual close focuses its control first. The Session-scoped store records manually expanded Turn-and-answer-Step generations, with a separate key before an answer Step is finalized; a new generation starts collapsed.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. Pinned scroll deliveries without reader movement update follow ownership immediately, before subsequent layout changes can invalidate their floor. Reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
