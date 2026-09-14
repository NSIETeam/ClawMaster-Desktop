/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

// ClawMaster RPA host half.
//
// The control plane under `./seam` is the pre-DSH implementation restored
// verbatim: durable runs, revision-checked receipts, an approval state machine
// and `unknown_outcome` recovery for an interrupted external action. This module
// only adapts it to the harness — one model-facing tool, one fail-closed policy
// port, and the local persistence roots.
//
// Two deliberate restrictions in this build:
//
// 1. Workflows are operator-declared. A model may only start a workflow already
//    installed through `config.workflows`, so it cannot invent navigation, fill
//    or click steps at request time.
// 2. Every step carrying an external side effect is denied rather than queued.
//    No approval bridge is wired yet, and `approve` is intentionally not offered
//    as a model action, so nothing can approve its own external action.

import { homedir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { RpaRun, RpaStepDefinition, RpaWorkflowV1 } from '../seam/contracts.ts';
import { FileRpaArtifactStore } from '../seam/file-artifact-store.ts';
import { FileRpaRunStore } from '../seam/file-run-store.ts';
import type { RpaAuthorization, RpaDriver, RpaPolicyPort } from '../seam/ports.ts';
import { RpaRunner } from '../seam/runner.ts';
import { createNativeHelper, resolveHelperSpec, type NativeHelperSpec } from './native-helper.ts';

/**
 * Declare one model-facing tool.
 *
 * The host half builds the definition literally instead of calling the harness
 * factory, so its bundle imports nothing from the harness at runtime. That keeps
 * the component testable from a plain checkout, where the frontend has no
 * `node_modules` of its own, and it matches the other built-in components, whose
 * bundles are equally self-contained. A raw definition owns its own input
 * validation, which the callers below therefore do explicitly.
 *
 * @param definition The literal tool definition.
 * @returns The same definition, typed for the registry.
 */
function defineRpaTool(definition: ToolDefinition): ToolDefinition {
  return definition;
}

export const name = 'clawmaster-rpa';

export {
  createNativeHelper,
  defaultHelperPath,
  NativeHelperError,
  resolveHelperSpec,
  type NativeHelper,
  type NativeHelperSpec,
} from './native-helper.ts';

/** The tool registry is the only service this component consumes. */
export const inject = ['tools'];

/** Operations a model may request. `approve` is deliberately absent. */
export const RPA_ACTIONS = ['start', 'run_next', 'recover', 'status', 'take_over'] as const;
export type RpaAction = (typeof RPA_ACTIONS)[number];

/**
 * Native subcommands a model may request.
 *
 * Every entry only reads: capabilities, the recovered tool catalog, or the
 * accessibility tree. The helper's `input` subcommand is a write and is
 * deliberately absent, so this build cannot drive the desktop until an approval
 * bridge exists.
 */
export const NATIVE_READ_ONLY_COMMANDS = ['capabilities', 'definitions', 'desktop-snapshot'] as const;
export type NativeReadOnlyCommand = (typeof NATIVE_READ_ONLY_COMMANDS)[number];

export interface RpaConfig {
  /** Root for run records and artifacts. Defaults to `~/.clawmaster/rpa`. */
  stateDir?: string;
  /** Workflows the operator has installed. A model cannot add one. */
  workflows?: readonly RpaWorkflowV1[];
  /** Overrides how the native helper is launched. Defaults to a built sibling binary. */
  helper?: NativeHelperSpec;
  /** Wall-clock bound for one native invocation. Defaults to 30000. */
  nativeTimeoutMs?: number;
}

export interface RpaInvocation {
  action: RpaAction;
  workflowId?: string;
  runId?: string;
  note?: string;
}

/** One recovered semantic tool call, forwarded unchanged to the native helper. */
export interface RpaCallRequest {
  /** Recovered tool name, for example `rpa_windows` or `rpa_click`. */
  tool: string;
  /** Tool arguments exactly as the model supplied them. */
  arguments?: Record<string, unknown>;
}

export interface RpaRunSummary {
  runId: string;
  workflowId: string;
  state: RpaRun['state'];
  revision: number;
  currentStepId: string | null;
  approvalId: string | null;
  takeoverNote: string | null;
  receipts: ReadonlyArray<{
    stepId: string;
    attempt: number;
    state: RpaRun['receipts'][number]['state'];
    idempotencyKey: string;
    artifactIds: readonly string[];
    error: string | null;
  }>;
}

export type RpaOutcome =
  | { kind: 'run'; run: RpaRunSummary }
  | { kind: 'catalog'; stateDir: string; workflowIds: readonly string[] }
  | { kind: 'missing'; runId: string }
  | { kind: 'native'; command: string; payload: unknown }
  | { kind: 'native_unavailable'; reason: string };

/** Denies every step that can touch anything outside the run. */
export class DenyExternalPolicy implements RpaPolicyPort {
  /**
   * @param input The run and step under review.
   * @returns An allow for an inert step, otherwise a denial naming the step.
   */
  async authorize(input: { run: RpaRun; step: RpaStepDefinition }): Promise<RpaAuthorization> {
    if (input.step.sideEffect === 'external' || input.step.requiresApproval === true) {
      return {
        decision: 'deny',
        reason:
          `RPA step ${input.step.id} (${input.step.action}) has an external side effect and no approval bridge is wired; ` +
          'it is refused rather than queued, and the run is not retried automatically.',
      };
    }
    return { decision: 'allow' };
  }
}

/**
 * A driver that executes only inert checkpoints.
 *
 * It exists so the durable run loop can be exercised end to end before any
 * browser or desktop driver is ported. Every real action fails loudly instead of
 * silently succeeding, and because a failure is not an external side effect the
 * run is left failed rather than `unknown_outcome`.
 *
 * @returns A driver that refuses every action except `checkpoint`.
 */
export function createCheckpointOnlyDriver(): RpaDriver {
  return {
    async execute(input) {
      if (input.step.action === 'checkpoint') {
        return { output: { checkpoint: input.idempotencyKey } };
      }
      throw new Error(
        `RPA action ${input.step.action} cannot execute: no browser or desktop driver is installed in this build.`,
      );
    },
  };
}

/**
 * Resolve the persistence root.
 *
 * @param configured Operator-configured directory, if any.
 * @returns An absolute path; `~/.clawmaster/rpa` when nothing is configured.
 */
export function resolveStateDir(configured?: string): string {
  const value = configured?.trim();
  return path.resolve(value && value.length > 0 ? value : path.join(homedir(), '.clawmaster', 'rpa'));
}

function summarize(run: RpaRun): RpaRunSummary {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    state: run.state,
    revision: run.revision,
    currentStepId: run.currentStepId,
    approvalId: run.approvalId ?? null,
    takeoverNote: run.takeoverNote ?? null,
    receipts: run.receipts.map((receipt) => ({
      stepId: receipt.stepId,
      attempt: receipt.attempt,
      state: receipt.state,
      idempotencyKey: receipt.idempotencyKey,
      artifactIds: receipt.artifactIds,
      error: receipt.error ?? null,
    })),
  };
}

export interface RpaHandlers {
  stateDir: string;
  workflowIds: readonly string[];
  /**
   * Apply one invocation against the durable control plane.
   *
   * @param invocation The requested operation and its identifiers.
   * @returns A run summary, the installed catalog, or a miss for an unknown run.
   */
  run(invocation: RpaInvocation): Promise<RpaOutcome>;
  /**
   * Invoke one read-only native subcommand through the helper.
   *
   * @param command The subcommand name; anything outside the read-only set throws.
   * @param signal Cancels the in-flight helper invocation.
   * @returns The helper's JSON payload, or an unavailable marker when it is not built.
   */
  native(command: string, signal?: AbortSignal): Promise<RpaOutcome>;
  /**
   * Forward one recovered semantic tool call to the dispatcher.
   *
   * The approval binding is always absent, so a write step is refused (and
   * receipted) by the dispatcher itself rather than executed. Governance has one
   * authority — the recovered Rust dispatcher — and this method never grants it.
   *
   * @param request The recovered tool name and its arguments.
   * @param signal Cancels the in-flight helper invocation.
   * @returns The dispatcher's canonical JSON result.
   */
  call(request: RpaCallRequest, signal?: AbortSignal): Promise<RpaOutcome>;
}

/**
 * Build the control plane over a configured state directory.
 *
 * @param config Operator configuration; workflows are never model-supplied.
 * @returns Handlers plus the state directory and installed workflow ids.
 */
export function createRpaHandlers(config: RpaConfig = {}): RpaHandlers {
  const stateDir = resolveStateDir(config.stateDir);
  const workflows = (config.workflows ?? []).map((workflow) => structuredClone(workflow));
  const store = new FileRpaRunStore(path.join(stateDir, 'runs'));
  const runner = new RpaRunner(
    workflows,
    store,
    new DenyExternalPolicy(),
    createCheckpointOnlyDriver(),
    new FileRpaArtifactStore(path.join(stateDir, 'artifacts')),
  );

  async function run(invocation: RpaInvocation): Promise<RpaOutcome> {
    switch (invocation.action) {
      case 'start': {
        if (!invocation.workflowId) throw new Error('rpa_run start requires workflowId.');
        return { kind: 'run', run: summarize(await runner.start(invocation.workflowId)) };
      }
      case 'run_next': {
        const target = await runner.runNext(requireRunId(invocation));
        return target ? { kind: 'run', run: summarize(target) } : { kind: 'missing', runId: requireRunId(invocation) };
      }
      case 'recover': {
        const target = await runner.recover(requireRunId(invocation));
        return target ? { kind: 'run', run: summarize(target) } : { kind: 'missing', runId: requireRunId(invocation) };
      }
      case 'take_over': {
        const runId = requireRunId(invocation);
        const target = await runner.takeOver(runId, invocation.note ?? '');
        return target ? { kind: 'run', run: summarize(target) } : { kind: 'missing', runId };
      }
      case 'status': {
        if (!invocation.runId) {
          return { kind: 'catalog', stateDir, workflowIds: workflows.map((workflow) => workflow.id) };
        }
        const target = await store.get(invocation.runId);
        return target ? { kind: 'run', run: summarize(target) } : { kind: 'missing', runId: invocation.runId };
      }
      default:
        throw new Error(`Unsupported rpa_run action: ${String(invocation.action)}`);
    }
  }

  async function native(command: string, signal?: AbortSignal): Promise<RpaOutcome> {
    if (!(NATIVE_READ_ONLY_COMMANDS as readonly string[]).includes(command)) {
      throw new Error(
        `Native subcommand ${command} is not in the read-only set (${NATIVE_READ_ONLY_COMMANDS.join(', ')}); ` +
          'it is refused rather than queued.',
      );
    }
    const spec = resolveHelperSpec(config.helper);
    if (!spec) {
      return {
        kind: 'native_unavailable',
        reason:
          'The native helper is not built. Build it with `cargo build --release` in frontends/rpa/native, ' +
          'or set config.helper to an existing binary.',
      };
    }
    const helper = createNativeHelper(spec, config.nativeTimeoutMs ?? 30_000);
    return { kind: 'native', command, payload: await helper.run(command, [], signal) };
  }

  async function call(request: RpaCallRequest, signal?: AbortSignal): Promise<RpaOutcome> {
    if (typeof request.tool !== 'string' || request.tool.trim().length === 0) {
      throw new Error('rpa_call requires a non-empty tool name.');
    }
    const spec = resolveHelperSpec(config.helper);
    if (!spec) {
      return {
        kind: 'native_unavailable',
        reason:
          'The native helper is not built. Build it with `cargo build --release` in frontends/rpa/native, ' +
          'or set config.helper to an existing binary.',
      };
    }
    const helper = createNativeHelper(spec, config.nativeTimeoutMs ?? 30_000);
    const payload = await helper.run(
      'rpa-call',
      [
        JSON.stringify({
          root: path.join(stateDir, 'native'),
          tool: request.tool,
          arguments: request.arguments ?? {},
          approvalId: null,
        }),
      ],
      signal,
    );
    return { kind: 'native', command: `rpa-call:${request.tool}`, payload };
  }

  return { stateDir, workflowIds: workflows.map((workflow) => workflow.id), run, native, call };
}

function requireRunId(invocation: RpaInvocation): string {
  if (!invocation.runId) throw new Error(`rpa_run ${invocation.action} requires runId.`);
  return invocation.runId;
}

/**
 * Mount the RPA control plane on the harness.
 *
 * @param ctx The Cordis plugin context; the tool registration is an effect.
 * @param config Operator configuration, usually supplied from cordis.yml.
 */
export function apply(ctx: Context, config: RpaConfig = {}): void {
  const handlers = createRpaHandlers(config);

  ctx.effect(
    () =>
      ctx.tools.register(
        defineRpaTool({
          name: 'rpa_run',
          description:
            'Drive a governed RPA workflow run. Workflows are operator-installed; a model can start one and advance it ' +
            'step by step but cannot define steps. Steps with an external side effect are refused while no approval ' +
            'bridge is wired, and an interrupted external action is never replayed automatically.',
          parameters: {
            action: { type: 'string', required: true, description: RPA_ACTIONS.join(' | ') },
            workflowId: { type: 'string', description: 'Installed workflow id, for action=start' },
            runId: { type: 'string', description: 'Run id returned by a previous call' },
            note: { type: 'string', description: 'Human takeover note, for action=take_over' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args, exec) {
            if (exec.signal.aborted) throw new Error('RPA invocation was cancelled before it started.');
            const outcome = await handlers.run(args as RpaInvocation);
            return JSON.stringify(outcome, null, 2);
          },
        }),
      ),
    'clawmaster: governed RPA control plane',
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineRpaTool({
          name: 'rpa_native',
          description:
            'Inspect the ClawMaster native RPA helper. Read-only: it reports the helper capability manifest, the ' +
            'recovered native tool catalog, or a bounded accessibility snapshot of the desktop. It cannot click, ' +
            'type or otherwise act, and it reports the exact macOS permission to grant when access is missing.',
          parameters: {
            command: { type: 'string', required: true, description: NATIVE_READ_ONLY_COMMANDS.join(' | ') },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args, exec) {
            const outcome = await handlers.native((args as { command: string }).command, exec.signal);
            return JSON.stringify(outcome, null, 2);
          },
        }),
      ),
    'clawmaster: native RPA helper inspection',
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineRpaTool({
          name: 'rpa_call',
          description:
            'Run a recovered ClawMaster native RPA tool, for example rpa_windows, rpa_snapshot, rpa_extract, ' +
            'rpa_wait, rpa_status or rpa_cancel. Use rpa_native with command=definitions to list the exact tool ' +
            'names and their arguments. Window and element references come from a prior snapshot artifact; no ' +
            'coordinate is ever supplied. A step that acts on the desktop needs an approval binding, and none is ' +
            'wired yet, so such a step is refused and receipted instead of executed.',
          parameters: {
            tool: { type: 'string', required: true, description: 'Recovered tool name, for example rpa_windows' },
            arguments: {
              type: 'object',
              additionalProperties: true,
              description: 'Tool arguments exactly as the definitions catalog documents them',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args, exec) {
            const request = args as { tool: string; arguments?: Record<string, unknown> };
            const outcome = await handlers.call(request, exec.signal);
            return JSON.stringify(outcome, null, 2);
          },
        }),
      ),
    'clawmaster: recovered native RPA tools',
  );
}
