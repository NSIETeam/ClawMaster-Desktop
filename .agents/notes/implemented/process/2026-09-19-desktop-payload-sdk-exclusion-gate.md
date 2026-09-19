# Agent Note: Release check for the shipped core's dependency exclusion

Status: implemented

English | [中文](2026-09-19-desktop-payload-sdk-exclusion-gate.zh.md)

## Problem

A released desktop installer must not carry the external subagent backends `@openai/codex` and `@anthropic-ai/claude-agent-sdk`. `apps/desktop-tauri/scripts/bundle-harness-source.mjs` performed that removal through `pruneInstalledCore`, whose scope list was a function-local array. The function was not exported and no test referenced it: `bundle-harness-source.test.mjs` contained no mention of `pruneInstalledCore`, `@openai`, or `@anthropic-ai`, and no other desktop script test resolved those scopes.

The consequence is a silent regression path in both directions. Deleting a scope from the list, or renaming the function that consumes it, would ship an installer carrying a backend the product does not support, and every existing gate would stay green. Adding a scope by mistake is equally silent: over-pruning removes a package the payload imports, and the failure surfaces only on an installed machine.

## Decision

Export the scope list as `PRUNED_DEPENDENCY_PACKAGES` and export `pruneInstalledCore`, then assert both the exclusion and the condition that keeps it safe from the test file that `test:bundle` already runs. No payload byte changes and no change to which packages are pruned.

This note owns the desktop payload's dependency exclusion and the check that pins it. The [production exclusion decision](../../archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md) owns the separate profile-level decision that `@deepseek-ai/dsh-base` does not depend on or mount either product provider, and the [subagent backends note](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md) owns the providers' protocols. Neither is superseded: this change removes nothing from the payload and reverses no placement decision.

- `PRUNED_DEPENDENCY_PACKAGES` is the single home for the exclusion decision, frozen so a consumer cannot extend it at runtime.
- `pruneInstalledCore` reads that constant instead of a local literal, so the list and the removal cannot drift apart.
- The keep-list is asserted as directly as the prune-list. The test fails if `@earendil-works/pi-ai` (the LLM provider layer) is absent from a synthetic core after pruning, or if a kept scope such as `sherpa-onnx`, `@img`, `pdf-lib`, `node-pty`, or `@earendil-works` appears in the prune list.

Both product providers load their runtime as a hard module-level dependency, so pruning it leaves a provider package in the payload that cannot be imported, not a provider that degrades gracefully:

| Provider | Load-time dependency |
|---|---|
| `@deepseek-ai/dsh-subagent-claude-code` | `import … from '@anthropic-ai/claude-agent-sdk'` in `src/process.ts` and `src/run.ts` |
| `@deepseek-ai/dsh-subagent-codex` | `createRequire(import.meta.url).resolve('@openai/codex/package.json')` at module top level in `src/run.ts` |

Pruning runs before the dangling-symlink sweep in `installBundledCore`. Pruning deletes packages that `node_modules/.bin` shims point at, so sweeping first leaves those shims dangling and the Tauri resource walk refuses the whole payload directory (`resource path ../bundled/harness/node_modules/.bin/tsserver doesn't exist`), which failed every desktop release build. Reversing the two calls is what lets a payload that excludes `typescript` bundle at all.

Pruning is therefore safe exactly while no desktop bundle mounts either provider. `DESKTOP_BUNDLES` in `scripts/desktop-defaults.mjs` mounts neither, which matches the production-exclusion decision above; the added test asserts that coupling directly, so adding a product provider to the desktop bundle list without restoring its runtime fails the suite instead of shipping an installer whose profile cannot start.

## Consequences

The exclusion and the keep-list can no longer drift without failing `test:bundle`, and neither can the bundle coupling that makes the exclusion safe.

The payload still contains the two provider packages as workspace sources: a user who enables either bundle against the bundled offline core hits a missing-module failure from the provider rather than a message naming the absent backend. Restoring the product runtime to the payload, or removing the provider sources from it, is a payload decision this note does not make. An installed payload does not change size or content as a result of this change.

## Alternatives considered

**Assert only the prune-list, without the keep-list.** Rejected: the keep-list is what protects the LLM provider layer, and an over-pruning edit is exactly as silent as an under-pruning one.

**Test `pruneInstalledCore` through a new package-level export surface.** Rejected: a desktop build script is consumed by its own `test:bundle` run, and adding a second entry point would duplicate the ownership of a payload decision that has one home.

**Add a parameter so a test can inject the scope list instead of mutating the constant.** Rejected: a test-only parameter on a build script is not a capability the product needs, and the constant is already the single home; the acceptance paths were instead proven to fail against real mutations of that constant.

## Testing

A test that cannot fail would not have closed this gap, so each acceptance path was checked against a real mutation before being committed. `node --test scripts/bundle-harness-source.test.mjs` was run after each single-scope edit to the source, restoring the file between runs:

| Mutation to `PRUNED_DEPENDENCY_PACKAGES` | Tests failed |
|---|---|
| none (control) | 0 |
| `@anthropic-ai` removed | 2 |
| `@openai` removed | 2 |
| `openai` removed | 2 |
| `@earendil-works` added | 2 |

Two tests fail per mutation because one asserts the removal from an installed tree and the other asserts the list itself; both are intended to reject the same regression.

`node --test apps/desktop-tauri/scripts/bundle-harness-source.test.mjs` reports 16 passed, 0 failed, including the two added tests. The other files in `test:bundle` pass. `build-provenance.test.mjs` fails in this branch's worktree only because the worktree has no `frontends/dsh/node_modules` for `esbuild` to resolve; the same file reports 6 passed, 0 failed in the main checkout, which is unmodified.
