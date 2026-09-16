# Agent Note: ClawMaster 0.2.3 delivery plan

Status: proposed

English | [中文](2026-09-15-clawmaster-0.2.3-delivery-plan.zh.md)

## Problem

ClawMaster needs predictable upgrades, recoverable editing and verifiable work outcomes. The desktop and Android 0.2.2 release lines provide different capabilities and have separate source commits. A published installer, an idle Session and a staged component each describe a different result; none alone proves that a user's work is complete or safe to resume.

This note is the implementation and acceptance plan for the proposed 0.2.3 iteration. Every unchecked item is pending work, not a report of a shipped feature or passed test. The plan does not authorize publication, access to private chats, paid model runs or changes to the user's installed application. Future package documentation must describe only behavior that actually ships.

## Proposal

Keep Tauri as the desktop shell and reuse DSH models, credentials, Sessions, tools, approvals, Goal and projections. Deliver five work packages: component activation and recovery, drafts and backups, WatchDog acceptance, Android updates, and coordinated release verification. Finish the P0 work before expanding the P1 features; set a release date only after candidate evidence is available.

The desktop target is provisionally 0.2.3. Android has an independent version and tag; bump it only when its own changes and acceptance are complete. A release plan explicitly records every supported platform as either updating to a named version or retaining a named release with a reason. Matching version numbers are not an acceptance requirement.

### Navigation

- [Baseline and ownership](#baseline)
- [Work packages and dependencies](#work-packages)
- [A: Update activation](#updates)
- [B: Drafts and backups](#data)
- [C: WatchDog work acceptance](#watchdog)
- [D: Android updates](#android)
- [E: Release verification](#release)
- [Execution and evidence](#execution)
- [Acceptance criteria](#acceptance)
- [Risks and deferred scope](#risks)

<a id="baseline"></a>
## Baseline and ownership

These pinned references describe the planning baseline, not a new verification run. Before implementation, the owner compares the selected branch with these sources and records intervening changes.

| Area | Baseline | Existing behavior to preserve |
| --- | --- | --- |
| Desktop | [desktop-v0.2.2](https://github.com/NSIETeam/ClawMaster-Desktop/releases/tag/desktop-v0.2.2), commit `f377d489eb30b0f904a2e3c8db26ddff0ae4e9c1` | Tauri, DSH `0.1.5-rc.2`, native updates and bundled components |
| Android | [android-v0.2.2](https://github.com/NSIETeam/ClawMaster-Desktop/releases/tag/android-v0.2.2), commit `d720f8cee6c140beb29d2c6566977cab12877007` | Independent Agent, Office text operations, approvals and system tasks |
| Product website | [ClawMaster](https://github.com/NSIETeam/ClawMaster), commit `51c0082b7bac99d571ceccac03621c105e234804` | Separate desktop/Android release records and public-asset verification |
| Updates | [Component reference](../../../../frontends/updates/README.md) | Signed metadata, checked archives, immutable directories, scoped profile edits and rollback receipts; restart-only changes remain staged |
| Work | [WatchDog reference](../../../../frontends/dsh/README.md) | Session activity and attention projection; CRM/ERP queries, one-time write approval and revision/generation protection |
| Editing | [Notes](../../../../frontends/notes/README.md), [Office](../../../../frontends/office/README.md) | Save-conflict protection; unsaved drafts are not durably recoverable after process exit |
| Scheduling | [Schedule](../../../../packages/schedule/schedule/README.md), [Jobs](../../../../packages/jobs/jobs/README.md), [Goal](../../../../packages/goal/goal/README.md) | Schedule delivery needs a live root Agent; local Jobs do not survive Host exit; persistent Goal state does not itself schedule execution |

The desktop checkout does not own the Android release branch or the product website. Use explicit repository and ref names for each task. Do not merge unrelated Android history into the desktop branch merely to place all work in one checkout. Existing update, storage and permission decisions remain authoritative until a separately reviewed implementation changes them.

This delivery proposal does not supersede the implemented decisions for [installed component updates](../../implemented/architecture/2026-09-15-installed-dsh-component-updates.md), [Notes storage](../../implemented/feature/2026-09-13-clawmaster-notes-vault.md), [Office editing](../../implemented/feature/2026-09-13-clawmaster-local-office-editing.md), [enterprise snapshots](../../implemented/feature/2026-09-14-enterprise-snapshot-backup.md) or [WatchDog admission](../../implemented/bug-fix/2026-09-13-watchdog-task-admission-and-attention.md). They retain their mechanism and safety rationale; this note owns only the next iteration's scope, order and required evidence.

<a id="work-packages"></a>
## Work packages and dependencies

Each row is independently reviewable. IDs identify pending work and its acceptance evidence; they are not new runtime identifiers or Issue numbers. Assign a named implementer and reviewer when execution begins.

| ID | Priority | Deliverable | Dependency |
| --- | --- | --- | --- |
| PREP | P0 | Baseline comparison, selected refs, release-platform plan and evidence location | None |
| A1 | P0 | Persistent update operation and actual active-version observation | PREP |
| A2 | P0 | Apply restart-only components after Host shutdown | A1, B1 exit protection |
| A3 | P0 | Recovery and old standalone-updater migration | A2 |
| B1 | P0 | Persistent WatchDog and Notes drafts, shared exit protection | PREP |
| B2 | P0 | Office recovery for explicitly supported formats | B1, SDK capability check |
| B3 | P0 | Declared-scope consistent backup and tested restore | B1, storage inventory |
| C1 | P1 | Durable work metadata and human acceptance record | B1 |
| C2 | P1 | Workbench attention and evidence presentation | C1 |
| C3 | P1 | Business workflow and reminder acceptance | C2 |
| D1 | P1 | Android update discovery, verification and system install handoff | PREP, E1 |
| D2 | P0 | Final signed APK upgrade and real-device verification | D1 when included, E1 and a signed candidate |
| E1 | P0 | Per-platform release plan and official Android publication path | PREP |
| E2 | P0 | Final-artifact installation and regression matrix | Relevant implementation packages |
| E3 | P0 | Public download, update-server and website consistency | E2, publication authorization |

A1, B1 and E1 can proceed independently. A2 must use B1's exit protection instead of adding a second editor-exit implementation. Android development uses its own checkout. Freeze feature scope before E2; fix and repeat only the affected checks when a candidate changes.

<a id="updates"></a>
## A: Update activation and recovery

User outcome: the existing settings or update entry explains whether a component is available, downloaded, staged, active or failed. Restarting applies supported staged changes and confirms the running version. Reuse [component installation](../../../../frontends/updates/src/components.ts), [update operations](../../../../frontends/updates/src/service.ts), [bootstrap](../../../../frontends/updates/src/bootstrap.ts) and the [desktop shell](../../../../apps/desktop-tauri/README.md).

### Implementation sequence

1. A1 records one operation identity with candidate version/digest, current profile revision, previous component reference, intended activation mode and observed result. Keep existing authenticated download and archive checks; do not introduce arbitrary URL or path parameters.
2. A1 separates a profile edit from Loader success. Bind the health result to the actual Host and component instance/version; a healthy process running the previous component cannot acknowledge a new activation.
3. A2 lets the shell wait for editors and active work to reach an agreed stop point, stop its owned Host tree, recheck candidate bytes and profile revision, apply the staged change and relaunch. Cancelling exit leaves the current application usable and the operation staged.
4. A3 upgrades existing standalone updater 0.1.0/0.1.1 without replacing unrelated settings or disabled choices. The upgrade enables the newer native manifest channel; the existing component catalog address remains unchanged.
5. A3 restores the previous compatible component on failed activation when the recorded profile revision still matches. If the user changed configuration, stop and preserve both versions instead of overwriting those edits. Bound recovery attempts so a bad component cannot create a restart loop.

### Required cases

| Case | Setup and action | Required observation |
| --- | --- | --- |
| U-01 | Upgrade one supported hot component while a Session remains open | Real call uses the new version; Session and credentials remain usable |
| U-02 | Upgrade a restart-only component and the updater itself | Staging is reported first; only stopped-Host application plus new-version observation reports active |
| U-03 | Cancel shutdown while an editor contains changes | Application remains usable; no component replacement or lost edit |
| U-04 | Interrupt download, corrupt bytes, use a bad signature or exhaust disk space | Current runtime remains usable; no unverified candidate is activated |
| U-05 | Modify profile after approval or fail new-component loading | Conflict preserves user edits; compatible recovery is observed, or the failure gives a concrete recovery path |
| U-06 | Upgrade an old standalone updater with custom/disabled configuration | No duplicate registration; unrelated values and disabled choice remain unchanged |

DSH core and native binary changes continue through the verified desktop installer. Component rollback is not permission to downgrade a database or released Session format. An old candidate's approval does not authorize replacement bytes or a new configuration revision.

<a id="data"></a>
## B: Drafts, exit protection and backups

User outcome: interrupted work is recoverable without replacing newer files. Extend the [Notes client](../../../../frontends/notes/src/client.tsx), [Notes storage](../../../../frontends/notes/src/vault.ts), [Office state](../../../../frontends/office/src/services.ts), [Office client](../../../../frontends/office/src/client.tsx), [WatchDog admission](../../../../frontends/dsh/src/navigation.ts) and [enterprise backup/restore](../../../../frontends/dsh/src/enterprise-host.ts).

### Draft design and sequence

1. B1 defines product-owned draft storage outside immutable runtime/version directories. A record identifies the workspace/Session/document, base file revision, draft revision, save time and draft format version. Do not persist model credentials in draft metadata.
2. B1 persists WatchDog input before admission and Notes edits separately from committed content. A debounce interval and retention/size limits are validated settings. Show the last successful draft-save time; document the measured final-keystroke loss window.
3. B1 restores a draft as a proposal to the user. A changed, deleted or moved original cannot be silently overwritten. Saving uses the existing revision checks; successful commit retires only the matching draft revision.
4. B2 first tests whether the pinned Office SDK can export a usable recovery copy for each supported format. Store those copies through the same authenticated Host, then verify opening and saving them in the actual Tauri WebView. Formats without verified recovery retain explicit export and exit protection, with no recovery claim.
5. B1/B2 use one exit decision for tab closure, application quit and updater restart. A cancellation preserves the editor; a failed draft write reports the error before shutdown can be described as protected.

### Backup scope and restore sequence

| Data | Planned handling | Required limit |
| --- | --- | --- |
| Notes, proposals, annotations and managed drafts | Include with source paths, revisions and checksums | External Vault location remains independent of runtime storage |
| CRM/ERP and command receipts | Reuse the consistent enterprise snapshot/restore path | Preserve monotonic recovery generation and reject expired approvals |
| Sessions, profiles, settings and managed attachments | Inventory their owners; coordinate write pause or owner-provided snapshots | Copying live files is not accepted as a consistent backup |
| Arbitrary external workspaces | Explicit selection or explicit exclusion in the backup manifest | No implied backup of the whole computer |
| External OpenViking service | Separate service-owned export, or mark excluded | Service health is not a recoverable backup |
| Credentials and OS-bound keys | Keep secrets out of logs and ordinary archives; require an explicit protected mechanism or reauthorization | Cross-machine decryption is not promised |

B3 validates the complete backup before modifying data, shows included/excluded sources, and restores first into an isolated destination. Restoring an existing profile requires a current-revision check and a recoverable pre-restore state. Never reactivate old one-time approvals, resume unknown writes automatically or describe an archive listing as a successful restore.

### Required cases

| Case | Setup and action | Required observation |
| --- | --- | --- |
| S-01 | Edit WatchDog input/Notes, change Session, close tab, quit and reopen | Draft identity and text survive within the declared save window |
| S-02 | Force-stop after a confirmed draft write, then reopen | Recovery is offered; no empty-file replacement or automatic business write |
| S-03 | Change the original file externally before recovery | Both contents remain available; revision conflict prevents silent replacement |
| S-04 | Edit DOCX/XLSX/PPTX in installed Tauri, cancel close, save and reopen | Each supported format preserves the tested content; recovery limitations are explicit |
| S-05 | Restore a backup into an empty isolated data directory | Compare every declared source, record, attachment and exclusion; reauthorization needs are visible |
| S-06 | Reuse an old approval, revision or committed command after restore | No duplicate write; existing generation/idempotency protections remain effective |

<a id="watchdog"></a>
## C: WatchDog work items and human acceptance

User outcome: the main page answers what needs attention and what result is ready to inspect. Extend [Workbench](../../../../frontends/dsh/src/Workbench.tsx), [Session presentation](../../../../frontends/dsh/src/services.ts), [business tools](../../../../frontends/dsh/src/enterprise-tools.ts) and the localized frontend dictionaries. Preserve writing space and collapsed reasoning, memory-injection and terminal details.

### Proposed metadata and behavior

| Concept | Proposed owner and behavior |
| --- | --- |
| Work identity | A stable plugin-owned reference to the existing DSH Session; reuse admission request identity for uncertain retries |
| Goal and scope | Objective, selected evidence/data range and acceptance conditions; use DSH Goal only for a suitable long-running objective |
| Responsibility and time | A local owner label and explicit due time/timezone; neither creates an account, tenant or role permission |
| Execution | Derive running, attention, failure and blocked information from DSH events/projections; do not create a second execution loop |
| Results | Versioned links to files, business records and recorded tool/approval results; missing or changed evidence is visible |
| Human acceptance | Pending review, accepted or changes requested, with actor/time and a reference to the reviewed result version |

C1 persists only the product metadata and acceptance decision that DSH does not already own. Define schema/version, expected revision, event replay and fork/archive behavior before implementation. New model-visible state must be reconstructable from the Session log. DSH Goal completion and human business acceptance remain distinct.

C2 presents pending approval, blocked, overdue and pending review in the existing main work area. AI submits a result for review; the authenticated user accepts it or requests changes in the original work item. Changed results invalidate acceptance of the old result for the new version. User-facing actions must be enforced by the Host, not merely hidden from the model UI.

C3 uses Schedule's actual receipt and due time. A fixed interval is not a business-calendar schedule. A closed/cold Session shows waiting for Session restoration; the UI does not claim that an exited application continues to inspect business data. Unknown write results require checking receipts before retrying.

### Required cases

| Case | Setup and action | Required observation |
| --- | --- | --- |
| W-01 | Create a synthetic customer-follow-up task with owner, due time and criteria; restart | Metadata and original Session remain linked; no duplicate task |
| W-02 | Read CSV and CRM/ERP, produce findings and request an approved change | Evidence links identify source revisions; rejected/cancelled writes leave records unchanged |
| W-03 | AI ends execution; user rejects the proposed result, then reviews a revision | Idle/Goal-complete never means accepted; revision-specific acceptance is enforced |
| W-04 | Lose the admission response or double-click submit | Reuse the original request to determine acceptance; do not create another Session or command |
| W-05 | Let a reminder expire while its Session is cold; restore it | Waiting/overdue is accurate; delivery is evidenced separately from successful work |

<a id="android"></a>
## D: Android discovery and system-confirmed updates

User outcome: Android can discover its next release and hand a verified APK to the system installer. Work from the [Android release source](https://github.com/NSIETeam/ClawMaster-Desktop/tree/android-v0.2.2/apps/android), not the desktop-only checkout. Preserve its existing Office, approval and system-task behavior.

1. D1 adds an update entry to settings with current/latest version and release notes. Bind discovery to the independent Android channel; never use the desktop Latest tag as the Android version authority.
2. After user confirmation, download to bounded private storage with cancellation. Verify manifest authenticity under the selected trust design, APK identity, versionCode, package digest and the trusted release certificate; a server-provided hash alone is insufficient.
3. Hand the verified APK to Android's system confirmation flow. Check again when the app returns whether the installed version changed. Missing install-source permission, user cancellation or a failed install cannot be reported as success.
4. D2 installs the final release-signed candidate over the public 0.2.2 APK on a real device without uninstalling. Keep CI emulator checks but update the upgrade starting version; do not substitute disposable-CI signatures for final-artifact acceptance.

| Case | Setup and action | Required observation |
| --- | --- | --- |
| M-01 | Check, download and accept a valid higher version | Android channel selected; system asks to install; observed installed version confirms success |
| M-02 | Wrong package/certificate, corrupt APK, downgrade, cancellation or denied permission | Current app and data remain intact; no silent installation |
| M-03 | Cover-install final signed APK over public 0.2.2 and cold-start | Notes, chats, keys, documents, tasks and pending approvals remain usable; no duplicate write |
| M-04 | Use an authorized real model and synthetic Office file, approve/reject edits, export and open externally | Real replies and exported contents are verified; record device/OS and exact APK hash |
| M-05 | Leave the UI, cancel work, lose network and let a scheduled task occur naturally | Observe actual continuation/delay/failure and retained results; do not promise exact background timing |

Installed 0.2.2 clients need one manual cover-install to obtain this feature. This plan does not promise desktop DSH plugin compatibility, remote desktop control or cross-device synchronization on Android.

<a id="release"></a>
## E: Release and installation verification

User outcome: each advertised download is an accessible, verified installer for the named version. Extend the [desktop workflow](../../../../.github/workflows/desktop-release.yml), the [Android workflow](https://github.com/NSIETeam/ClawMaster-Desktop/blob/android-v0.2.2/.github/workflows/android-validation.yml), and the website's existing [asset verifier](https://github.com/NSIETeam/ClawMaster/blob/51c0082b7bac99d571ceccac03621c105e234804/scripts/verify-product-site.mjs) and [Pages workflow](https://github.com/NSIETeam/ClawMaster/blob/51c0082b7bac99d571ceccac03621c105e234804/.github/workflows/pages.yml).

E1 defines one release-plan artifact with per-platform version, source commit, CI run, expected filename, digest/signature evidence and update-or-retain decision. Keep Android and desktop tags independent. Official Android signing/publication is a separate job from emulator validation; private signing material stays outside logs and public artifacts.

E2 verifies the final artifacts before publication. E3 switches server/website pointers only after intended public files exist and can be downloaded completely. Use the existing online verifier in the delivery flow; a temporary metadata failure leaves the previous known-good site/pointer in place. Never silently use old assets to satisfy a new platform row.

| Platform/path | Required next-candidate acceptance |
| --- | --- |
| macOS Apple Silicon | Installed Tauri start, actual Office edit/save/reopen/conflict/recovery, approval, cancellation, normal exit and second launch |
| Windows x64 | The same user path in clean Windows Sandbox; hosted runner installation remains separate evidence |
| Linux x64 AppImage and DEB | Native desktop installation/launch and product interaction; extraction/Host checks alone do not suffice |
| Android | Final-certificate device cover-install, real-model Office workflow and Android 8/16 emulator regressions |
| Update server | Exact signed version files precede pointer changes; legacy updater clients remain supported; candidate failure preserves old channel |
| Website | Planned releases are public; names, versions, sizes, hashes and links agree; deployed HTML/manifest match the reviewed website commit |

Test first-run dependency preparation on a clean machine, including connection loss and recovery. Freeze a candidate for at least 48 hours of mixed usage, using recorded models for most workload and separately authorized real-model checks. Record memory peaks, subprocesses, task/draft recovery, failures and observation gaps. Host RSS alone is not total memory usage; do not label a partial observation as a passed soak.

The historical [Issue #21](https://github.com/NSIETeam/ClawMaster/issues/21) includes a pre-DSH Rust execution path and old size objectives. PREP maps still-applicable installation, model, data and permission requirements into the current release plan. Do not close unmet requirements merely because architecture changed, or apply obsolete runtime assumptions to new DSH work.

<a id="execution"></a>
## Execution and evidence

Start with isolated branches from the selected desktop, Android and website refs. Preserve unrelated dirty files, existing credentials and running user work. The integrator owns cross-repository sequencing; each package owner records its dependencies and review result. Use separate commits for independent packages and maintain complete bilingual documentation alongside affected code.

The following are candidate check entry points, not commands run by this planning change. The implementer reads the selected ref's package scripts and [testing policy](../../../../docs/testing.md), then chooses focused behavior tests, built-artifact tests, necessary recorded-session snapshots and native checks. Never run actual updater or backup-restore commands against user data to validate documentation.

| Work | Existing check owner to extend |
| --- | --- |
| A | [Update scripts/tests](../../../../frontends/updates/package.json) and [desktop scripts](../../../../apps/desktop-tauri/package.json); cover stopped-Host application as new acceptance |
| B | [Notes tests](../../../../frontends/notes/package.json), [Office tests](../../../../frontends/office/package.json), [frontend tests](../../../../frontends/dsh/package.json); add crash recovery and isolated restore |
| C | Frontend admission/business tests and keyless Session output cases; add acceptance-state persistence and stale-result rejection |
| D | Android unit/device tests and workflow at its pinned release source; add final-signed upgrade and installer handoff |
| E | Desktop matrix, Android matrix and website verifier; add planned-platform completeness and public download checks |

Store one evidence record per acceptance case: work ID, case ID, source commit, command or manual steps, actual result, test data, OS/device, artifact hash, observed running version, log/screenshot location and remaining limitation. Keep private logs and secrets outside public evidence. Blank fields and unchecked cases mean pending, not passed.

Use this handoff structure for every work package:

| Field | Required content |
| --- | --- |
| Scope | Work IDs, entry files, exact refs and explicit exclusions |
| Preconditions | Completed dependencies, test account/device availability and data backup needed for the test |
| Result | Changed behavior, persisted-data changes, migration and cancellation semantics |
| Verification | Case-by-case pass/fail/blocked, exact evidence and distinction between fixture, installed app and real service |
| Recovery | Candidate disable/recovery procedure and data-format compatibility limits |
| Delivery | Local changes, commit, push, merge, published artifact and installed verification recorded separately |

### Existing integrations and product limits

Validate one already authorized Feishu integration from incoming message through task, approval and result delivery, without promising new platform support. Validate the macOS WeChat reader only on an authorized selected test chat; QR login, bot authorization and personal visible-message reading are distinct paths. Unverified integrations remain explicitly unverified or experimental.

Keep OpenViking/Graph Memory work to existing retrieval behavior, understandable enablement, source attribution and measured cost. Do not enable external services by default or create another memory engine. Read-only checks and hidden tool details do not weaken server-side authorization.

## Alternatives considered

**A broad feature release:** adding multi-tenant permissions, synchronization, an always-on server executor and all IM channels would combine new security/storage systems with the current recovery work. Defer those capabilities so this iteration has bounded acceptance.

**Rebuild the Agent runtime:** a second model loop, task scheduler or plugin manager would duplicate DSH and increase upgrade work. Extend existing public services and product plugins; new durable metadata covers only the business concepts those services do not own.

**Version labels and restart as evidence:** matching platform version strings or restarting after staging cannot prove a component applied, an APK was released or work was accepted. Require observed versions, final artifacts and explicit human acceptance.

<a id="acceptance"></a>
## Acceptance criteria

The release owner records each result below against the selected candidate. A failed mandatory case blocks that promised deliverable; a consciously deferred feature must be removed from its release claims before publication.

- [ ] PREP records refs, platform decisions, owners and the mapped current release requirements.
- [ ] A1–A3 pass U-01 through U-06 with real activation and bounded recovery evidence.
- [ ] B1–B3 pass S-01 through S-06 with declared recovery windows and backup inclusions/exclusions.
- [ ] C1–C3 pass W-01 through W-05; the user can follow evidence and accept a result independently of Agent execution state.
- [ ] D1 passes M-01/M-02 when Android updates are included; D2 passes M-03 through M-05 for a claimed Android release.
- [ ] E1/E2 complete the final-artifact matrix and the full candidate observation period, or explicitly retain an earlier platform release.
- [ ] E3 verifies complete public downloads, update channels, desktop Latest preservation and the deployed product website.
- [ ] Documentation, provenance and public release notes describe only demonstrated capabilities and disclose unverified real-service/platform paths.

<a id="risks"></a>
## Risks

Office recovery depends on the pinned SDK and actual WebView behavior. Limit support to verified recovery paths; never replace a failed recovery with a success message. Consistent backups need storage-owner coordination and bounded disk use. Credentials bound to an OS may require reauthorization after migration.

Updater recovery must preserve concurrent profile edits and respect released data formats. No automatic schema downgrade or replay of uncertain writes is allowed. Schedule and Android system jobs have different execution guarantees; document each rather than implying continuous server operation.

Final-device, Windows Sandbox, Linux desktop and real-model verification require the corresponding environment and explicit access. Record unavailable prerequisites as blocked evidence. macOS notarization and Windows publisher signing remain separate identity/certificate work; keep the actual signing status visible until those paths are completed.

Multi-user/tenant authorization, remote approvals, phone-to-desktop control, cross-device synchronization, unattended server execution, installer-free DSH core replacement, full Office/Obsidian compatibility, additional memory engines and expanded personal-chat collection are outside this iteration. Intel Mac installers remain outside the published support scope. This note stays proposed until its delivery scope is implemented and its evidence is reviewed.
