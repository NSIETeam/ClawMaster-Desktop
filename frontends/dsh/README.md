---
description: "ClawMaster WatchDog desktop workspace, local data processing, CRM and inventory orders for users and maintainers of the Tauri frontend bundle."
kind: "package-bundle"
---

# ClawMaster WatchDog frontend

English | [中文](README.zh.md)

## Summary

ClawMaster brings tasks, document editing, browsing, terminals and local business records into one Tauri desktop workspace. Its slogan is “开启AI时代的企业协作”. The desktop includes this bundle and uses DSH for conversations, models, tools, approvals, plugins and session recovery. AI uses DSH tools to process CSV and query or prepare customer and order records. The panels support reviewing results, approvals and manual takeover. AI tasks use the configured DSH provider; manual actions require no model call.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the ClawMaster Tauri desktop application. Its provisioner includes this frontend and the plugins listed in the [desktop defaults](../../apps/desktop-tauri/README.md#architecture). The [desktop guide](../../apps/desktop-tauri/README.md) owns installer, runtime provisioning and launch instructions; this frontend package alone is not a desktop installer.

<a id="first-run-tutorial"></a>
### First-run tutorial

With no Session or Workspace history, WatchDog teaches a five-step management workflow using this week's customer follow-ups and delivery risks: define scope, write responsibilities and acceptance criteria, inspect CRM/ERP records and supplied documents, choose a review frequency and check approvals, then verify findings and follow up on corrective action. Owners and deadlines are instructions in the task description. The primary action opens WatchDog management; model and IM settings are auxiliary destinations at the end. Reading, skipping or replaying creates no task and sends no prompt or external message. Existing users can open Settings → WatchDog tutorial at any time.

Skip and finish record a versioned acknowledgement through DSH settings. The desktop keeps it across restarts and local port changes; newer acknowledgement versions are preserved. A refused write keeps the guide open with a retry message. Remote browsers retain acknowledgement only for the current settings-shell lifetime. Tutorial completion does not verify an API key, create a task, schedule a reminder or connect an IM account.

### Start a task or open a tool

Application startup creates no default workspace. With no session or workspace history, the first entry opens WatchDog; existing selections and subsequent navigation take precedence. Starting a WatchDog task allocates a directory under `$DSH_HOME/watchdog-workspaces/tasks/<uuid>` and uses the ordinary DSH session flow. Opening an editor, browser or terminal uses the current, unarchived session when available; otherwise the first tool request allocates `$DSH_HOME/watchdog-workspaces/desk` and creates or reuses its session. These directories and their files survive application restarts.

To choose a workspace directory manually, use **Add workspace** in the workspace header. The directory browser opens inside ClawMaster. Browse folders, enter a path or create a folder, then choose **Open** to use the selected directory.

WatchDog occupies the main panel. Better Sidebar opens document editing, browsing, CRM and ERP in tabs beside the conversation, and terminals at the bottom. Manage CRM and ERP with the other components in Settings → Side Cards; each component's feature settings opens its right-side tab. Components are enabled by default but open only on request. Opening an existing component selects its tab.

Visiting a global panel such as WatchDog preserves the current Session's right-side editor and browser instances, including unsaved text and iframe documents. Hidden docked and floating content takes no frame width or keyboard focus. Save before switching Sessions, closing tabs or quitting. The [desktop compatibility patch](../../apps/desktop-tauri/README.md#architecture) also retains browser navigation per native Session and tab identity; it does not persist editor drafts.

| Module | Use |
| --- | --- |
| Documents | Edit text and code, and preview files in the session workspace. |
| Browser | Open websites in Better Sidebar's sandboxed browser panel. |
| Terminal | Use a terminal associated with the session workspace. |
| CRM | Maintain contacts, companies, stages, next actions and follow-up dates. |
| ERP | Maintain SKUs, stock, reorder thresholds, suppliers and purchase/sale orders. |

### Give AI a business task

Describe the goal in a task and place its input files in that task's workspace. For example: “Trim and deduplicate customers.csv, save customers-clean.csv, then query CRM and organize contacts needing follow-up.” AI calls the built-in business tools directly. CRM and ERP components provide review and manual controls; the file editor opens CSV results. Data processing has no separate panel or navigation entry.

### Prepare CSV or TSV data

Ask AI to process a workspace file with explicit delimiter, header, trim, duplicate removal, blank-record removal, substring filter and sort rules. Parsing preserves cell text, including leading zeros. Invalid quoting or inconsistent column counts block processing and output until the source is corrected.

The tool's default input limit is 16 MiB and its result preview contains at most 10 rows. Saved CSV includes every processed row with a UTF-8 BOM. Spreadsheet formula protection is enabled by default and prefixes formula-active cells with a single quote. DSH records the tool's result and saved file path in the conversation.

### Save contacts, stock and orders

CRM and ERP start with an empty database at `$DSH_HOME/watchdog/enterprise.sqlite`. Saved records are independent of the browser origin, random Host port and selected session. Contact and SKU edits and deletions are audited. Existing browser `localStorage` records are neither deleted nor automatically imported into SQLite.

Save purchase or sale orders as drafts with quantities and unit prices. Submitting a purchase adds stock; submitting a sale subtracts stock. All lines, order status, the revision and before/after audit facts commit together. Insufficient stock rolls back the entire submission. Submitted orders cannot be edited, deleted or applied twice.

Stock and quantities use safe integers; monetary values use integer CNY minor units. A SKU referenced by an order cannot be deleted. If another view changes the records, a stale save returns a revision conflict: refresh the records, review the current values, and save again. Unsupported, foreign or damaged databases fail without an automatic reset.

The schema 3 migration adds responsibility history outside business snapshots. Business writes and restore success records commit in the same transaction; audit failure blocks the write. Restoring an old backup preserves responsibility records for changes made after that backup. Records contain Host-derived actor, carrier, Session/call, approval reference, policy version, revisions, outcome and backup digest, without contact or order contents. Historical receipts imported from schema 1/2 explicitly have an unknown actor. The authenticated `/api/clawmaster/enterprise/responsibility` route provides pages of up to 500 entries filtered by actor, command, entity or operation. Supplying `commandId` with a restore makes an identical retry idempotent. Append-only triggers and a verified hash chain detect local inconsistency; a machine administrator can replace the database, so enterprise retention requires a separate trusted archive. Responsibility history has no automatic retention deletion and is not included in portable business backups.

### Use reminders and IM connections

The bundle enables DSH's official Schedule, time context and reminder catalog. Reminder delivery needs the application running and a live root agent in the owning session; closing the application does not create an operating-system background scheduler. Due reminders return to the same conversation when that session can accept them. See the [Schedule guide](../../docs/user/guide/schedule.md) for supported timing and recovery behavior.

IM account setup and platform login flows belong to the bundled IM plugin. Including the plugin does not establish a live Feishu, WeChat, WeCom or DingTalk connection; each platform's account conditions and connection result must be verified in its settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation and contributor checks — click to expand</summary>

The sidebar and conversation hero render the transparent [light SVG](src/clawmaster.svg) or [dark SVG](src/clawmaster-dark.svg) through the client bundle's SVG data URL loader. CSS follows DSH's resolved `body[data-ds-dark-theme]` state, including manual theme choices and system-following mode. The [desktop asset guide](../../apps/desktop-tauri/README.md#release) owns splash, favicon and native icon distribution; [the PNG](src/clawmaster.png) is retained only as a visual reference.

The [profile patch](cordis.patch.yml) disables the official brand and adaptive directory-picker rows, inserts this frontend and DSH's browse directory-picker backend and surface, enables Schedule and time context, and enables the reminder UI. The DSH Web bundle already supplies both browse packages. The [client entry](src/client.tsx) uses DSH's existing slots, theme, sessions, workspaces and panel services. The [Host entry](src/host.ts) registers lazy workspace allocation and enterprise routes on the existing authenticated DSH Fetch carrier; it starts no second server.

[PapaParse processing](src/business.ts) owns CSV syntax and serialization. [Enterprise storage](src/enterprise-host.ts) uses Node's SQLite and transactions; the HTTP routes and [AI tools](src/enterprise-tools.ts) share one store, command validation and revision checks. DSH's settings store remains configuration storage. Enterprise data does not enter the model automatically.

The Host plugin accepts these optional settings through its Cordis configuration. Storage paths must be absolute.

| Setting | Default |
| --- | --- |
| `managedRoot` | `$DSH_HOME/watchdog-workspaces` |
| `databasePath` | `$DSH_HOME/watchdog/enterprise.sqlite` |
| `busyTimeoutMs` | `5000`; SQLite writer-lock wait, from `0` to `60000` ms |
| `dataTools.maxInputBytes` | `16777216` |
| `dataTools.previewRows` / `previewColumns` / `previewCellChars` / `maxDiagnostics` | `10` / `8` / `120` / `10` |
| `enterpriseTools.maxQueryRows` / `maxQueryBytes` | `100` / `262144` |

With the repository's supported Node runtime and this package's dependencies installed, run these commands from this directory:

```sh
npm run typecheck
npm test
npm pack
```

The test command builds the client factory and Host bundle before running the package's focused tests. Packing runs the same build and produces a local `.tgz`; the package is private. React and React DOM come from DSH's shared client runtime. Tool navigation commits the session view before opening a panel, so the panel's DSH seat is bound. The [desktop build](../../apps/desktop-tauri/README.md) includes the frontend artifacts in its runtime payload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop installation and runtime](../../apps/desktop-tauri/README.md) — Tauri packaging, startup and platform behavior.
- [Profile composition](../../packages/boot/app-boot/README.md) — DSH bundle ordering and configuration.
- [Official Schedule](../../packages/schedule/schedule/README.md) — durable reminders and live-session delivery.
- [Enterprise records and commands](src/enterprise-types.ts) — the shared client/Host data definitions.

-----

<a id="model-experience"></a>
## Model Experience

The frontend registers `csv_process`, `enterprise_query` and `enterprise_command` through DSH's ordinary tool pipeline. CSV processing reads complete files inside the current Session workspace, returns bounded previews and counts, and optionally saves the full result. Existing outputs require a prior read and DSH's file-version guard. Write escalation uses normal single-use DSH approval and does not permit paths outside the workspace.

Enterprise queries return bounded pages with a revision and continuation offset. AI can save contacts and order drafts; inventory writes, record deletions and order submission require explicit DSH approval. Rejected, cancelled or unavailable approval leaves records unchanged. Revision conflicts require rereading; identical committed command IDs return their original receipt. UI and AI operations use the same local database.

Tool calls and returned data enter the Session log and subsequent model requests through DSH. The database is not automatically copied into prompts. The recorded owner-local [business flow](tests/business-tool-flow.test.mjs) covers CSV-to-CRM tool results, persisted replay and unavailable ERP approval with a synthetic model. Schedule owns its reminder tools and follow-up messages.

The ClawMaster profile selects DSH `read-only` file access with `ask` approval for new Sessions. Workspace file writes require explicit single-use escalation; `never` approval denies requests requiring a decision rather than approving them. Saved user settings take precedence over profile defaults. Delegated Sessions intersect their captured file access with live ancestor permissions before model steps and tools; missing or cyclic ancestry permits only reads, and child approval remains `never`. DSH's canonical setters append any restriction to the Session log. Agent Teams defaults to three members with one delegation level; its existing service owns roster validation, including the Web planning route.

#### KV Cache effect

`runtime_status` reads desktop identity and source provenance with an observation time; it returns unavailable when the shell record does not identify this Host. Logged runtime context refreshes these facts at request assembly and treats remembered versions, paths, ports and permissions as historical. `runtimeGovernance` on the frontend Host row configures `maxRssMiB` (default: the smaller of 2048 MiB and one quarter of physical memory, with a 256 MiB floor), `maxConcurrentHeavyTools` (2), and `heavyToolPatterns` (shell, subagent, team, workflow and CSV tool names). DSH's monotonic guard rejects new matching tools at the Host RSS budget; dispatch rejects excess overlapping bodies and releases capacity after success, failure or cancellation. Status reads remain available. These limits do not cap external process memory, background work after a tool returns, Office WebViews or other applications.

The frontend adds tool schemas, logged tool results and timestamped runtime context, without a separate model provider or system-prompt prefix. Changed observations and results affect the request suffix. DSH owns request assembly and cache handling.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The constraints below apply to this frontend and its local records.

- The integration baseline is DSH `0.1.5-rc.2` with Cordis `4.0.2`. Compatibility covers the public services consumed here and the plugin combinations that are actually tested; it does not certify every DSH plugin.

- CRM and ERP are local single-user records, not a shared multi-tenant enterprise system or an external ERP/CRM connector. Audit history is retained in full. Browser reads and internal storage reads use full snapshots; model queries paginate their output. Large-database capacity is not established. The data processor supports delimited text, not an XLSX workbook or a persistent spreadsheet service.

- This package has no standalone installer-size commitment. The Tauri shell, DSH, Node runtime and third-party components have separate packaging and license obligations; this package uses Apache-2.0.

- OpenViking Memory is installed but disabled by desktop defaults until connected. The [local service guide](../../apps/desktop-tauri/README.md#optional-local-openviking-service) owns macOS preparation, USER credentials and the external AGPL-3.0 server; the integration plugin uses Apache-2.0. Service health alone does not verify desktop memory capture or cross-Session recall.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Development verification context — click to expand</summary>

This checkout is undergoing desktop integration. Source tests and package builds are development evidence; they do not establish acceptance of a newly installed desktop, every module interaction, real model reminders or platform QR login. The desktop integration task owns those live checks before release.

</details>
