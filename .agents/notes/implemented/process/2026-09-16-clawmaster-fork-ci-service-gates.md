# Agent Note: CI service gates in the ClawMaster repository

Status: implemented

English | [中文](2026-09-16-clawmaster-fork-ci-service-gates.zh.md)

## Problem

ClawMaster-Desktop carries DSH workflow sources but does not own the DeepSeek Harness Issue Project, its GitHub App, Cloudflare preview project, or custom 16-core runner labels. Those jobs failed for missing credentials or remained queued on runners that this repository cannot allocate. The installed-wheel Python matrix also failed at its real-API preflight even though its keyless black-box checks passed.

## Decision

The [Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) and [Issue policy](../../../../.github/workflows/issue-policy.yml) jobs run only in their owning DeepSeek Harness repository. The [preview workflow](../../../../.github/workflows/build-preview-cloudflare.yml) continues to build the page on every PR, but deploys and probes Cloudflare only for that repository. ClawMaster-Desktop therefore reports no Cloudflare deployment or upstream Project validation.

The [PR CI](../../../../.github/workflows/ci.yml) keeps the upstream 16-core labels in the upstream repository and selects GitHub's standard `ubuntu-24.04` and `windows-2025` runners for ClawMaster-Desktop. The four-core consumer lane limits concurrent gates and expected-output workers through [the expected-output configuration](../../../../vitest.expected.config.ts), preserving assertions and timeouts while the upstream lane keeps its larger pool. Linux and Windows coverage still measure every owned source file, but the ClawMaster lanes run two partitions with two workers each and one gate at a time; the upstream lanes retain four partitions, six workers and three gates. Before the root consumer lint gate, ClawMaster CI installs the separately locked DSH and Office frontend dev dependencies; it does not exclude their TypeScript from the lint scope. The reusable [Python runtime builder](../../../../.github/workflows/build-exe-for-python-sdk.yml) still runs clean-install and keyless installed-wheel checks in both repositories. Its authenticated steps require the `real_api` input; upstream CI and release callers retain the default `true`, while ClawMaster PR CI passes `false` and shows those steps as skipped. No absent key is represented as a successful model call.

## Verification

The [workflow specification](../../../../scripts/ci-workflow.spec.ts) evaluates both repository runner selectors and consumer budgets, pins service ownership, and confirms that all four authenticated Python steps share the explicit input. GitHub-hosted execution and a real-model response remain separate remote evidence.

## Alternatives considered

**Copy upstream credentials:** ClawMaster-Desktop has no authority over the DeepSeek Harness Project or Cloudflare preview; adding their secrets would couple unrelated repositories and grant unnecessary access.

**Mark missing-key preflight successful:** That would turn an unrun model test into a green result. An explicit skipped step preserves the missing evidence.

## Consequences

PRs in ClawMaster-Desktop can run the DSH keyless and build checks without waiting for unavailable custom pools. Standard runners have fewer resources than the upstream 16-core lanes, so their full matrix must be observed before claiming CI parity. The upstream Project and preview checks remain unchanged where their services exist.
