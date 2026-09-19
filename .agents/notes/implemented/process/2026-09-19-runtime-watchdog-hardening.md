# Agent Note: Runtime watchdog for the local DSH install

Status: implemented

English | [中文](2026-09-19-runtime-watchdog-hardening.zh.md)

## Problem

The runtime problems that make the local install unusable are not source defects. Across 89 recorded boots in the local `boot.log`, 13 ended in `ERROR dsh web 进程已退出 (code 1)`, from three outside-the-tree causes:

| Class | Recorded failure | Count |
|---|---|---|
| A | `cannot resolve profile bundle …` | 9 |
| B | `patches ~/.dsh/cordis.patch.yml must be a top-level YAML array` | 2 |
| C | `corrupt session log … header id and cwd identify …` | 1 |

Two further classes do not crash the boot but degrade it silently: a missing CSP patch (blank window, misaligned sidebar) and an unavailable local memory service. None of these surfaces is covered by the repository's own gates, because all of them live outside the checkout: profile bundles, `~/.dsh` configuration, session logs, and the frozen harness tree.

The harness tree is also modified in place on this machine. A recorded incident changed `packages/core/agent-loop/lib/index.js` to append to `/tmp/cm-sched-diag.log`; the file was restored from a snapshot, but the running process kept executing the modified module.

## Decision

Ship the watchdog as shell and Node tooling under `scripts/runtime-watchdog/`, with no changes to `packages/`, `apps/`, or any published surface. It has four entry points:

- `doctor.sh` — one read-only entry point: core integrity, out-of-tree boot inputs, services, resident-doctor liveness, and an optional baseline×snapshot cross-check.
- `preflight.mjs` — calls the real DSH loader (`loadProfile`, `loadOptionalPatches`, `generationLogPath`) instead of reimplementing its rules, so a check and a boot agree by construction. No write path is invoked.
- `heal.sh` / `repair-core.sh` — repair, with a protected core list that automated removal can never touch.
- `resident-doctor.sh` — a LaunchAgent-driven repair loop, plus a heartbeat that makes its own absence detectable.

### Verify the recovery assets instead of trusting them

The detection path reads a hash baseline; the repair path reads a tarball snapshot. Both are inputs, and for several iterations only the baseline was checked. Three separate defects were found by checking the second one:

1. `tar` exits non-zero when it cannot restore symlink metadata (3669 symlinks in this tree, `EBADF` on macOS). 1675 metadata warnings, one exit code 1 — content complete. Extraction therefore passes `-o` and classifies stderr, rather than keying on the exit code.
2. The snapshot stores directories read-only, so an extraction cannot be deleted or overwritten by a later run. `repair-core.sh` could not repair the same file twice. Fixed by raising the write bit before deleting the working copy and extracting with `-o`.
3. `drill-real-snapshot.sh` selected samples from `core-manifest.sha256`, which is machine-specific and `.gitignore`d, so a fresh clone failed instead of skipping.

`crosscheck-core.sh` compares the two artefacts directly (set and content, both directions). On this machine they agree: 49028 files, identical in both directions.

### State that must not enter the repository

`core-manifest.sha256` is a byte-level description of one machine at one moment, and it is 8 MB. Committing it would make the baseline describe someone else's tree, which is worse than having none. It and the other generated artefacts are excluded by a `.gitignore` in the tool directory; each machine builds its own with `doctor.sh --build-manifest`.

### The watchdog does not act on other services

`com.clawmaster.openviking` crash-loops under `KeepAlive` because `~/.dsh/.credentials.yaml` no longer exists. The watchdog reports the loop, the recorded error, and the exact commands to stop or restore it, and stops there. Disabling another actor's service is not a decision a repair tool should take.

## Consequences

The tooling adds no dependency to `packages/`, `apps/`, or any published surface, and the core tree is unchanged by it: the snapshot, the hash baseline, and the heartbeat are generated per machine and excluded from the repository, so a fresh clone runs the watchdog without them and `doctor.sh` reports each absent artefact rather than failing.

The guarantee is bounded and stated as such. Detection plus restoration produces a clean next start; it does not make a running process immutable, and a process that has already loaded a modified module keeps executing it until the Host restarts. The `--quick` repair path also has a proven blind spot — a file whose mtime was backdated and whose read-only bit was restored is not detected — which the periodic `--deep` pass closes rather than the fast path.

One operational decision is left open by design: `com.clawmaster.openviking` stays in its crash loop until a human stops it, so the loop keeps producing log growth and restart load that the watchdog reports but does not remove.

## Alternatives considered

- **File permissions as immutability.** `chmod -R a-w` raises the bar and nothing more: a same-user process can restore the write bit. The measured limit is detection and restoration of the next start, not a guarantee about a running process. Process isolation (a separate user, or a read-only mount) is the mechanism that would close it, and it is not reachable from outside the application.
- **Polling instead of event-driven repair.** The desktop app's own retry after a crash was measured at 9.6 s to 20982 s. The repair loop is woken by `WatchPaths` on `boot.log` instead, which fires in one to four seconds.
- **Treating a clean hash as sufficient.** A full-tree match says nothing about whether the snapshot can still restore the tree. The resident doctor now checks restore capability before deciding whether a restore is needed, and reports an unusable snapshot as a failure with no automatic remedy.

## Verification

`self-test.sh` runs four suites: `fixture-test.sh`, `resident-doctor-test.sh`, `repair-core-test.sh`, `drill-real-snapshot.sh`. On the author's machine they report 31, 47, 42, and 8 passing assertions respectively, and the drill exercises the real 439 MB snapshot against a fixture core so that the production tree is never modified.

Several assertions exist because a test previously passed for the wrong reason. `resident-doctor-test.sh` asserts the rendered heartbeat line rather than its prefix, after a `${…}` substitution error passed a prefix-only check. `repair-core-test.sh` makes its fixture snapshot read-only, matching the production snapshot, after a second-repair defect stayed invisible behind a writable fixture.
