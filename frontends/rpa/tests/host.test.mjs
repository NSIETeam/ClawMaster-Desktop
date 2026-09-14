/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

// Host-half tests for the recovered RPA control plane. They run against a
// stand-in DSH context, so they prove the harness wiring and the durable run
// loop without a browser, a desktop driver or any macOS permission.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RPA_ACTIONS, apply, createRpaHandlers, inject, name } from '../dist/index.js';

function standInContext() {
  const registrations = [];
  const effects = [];
  return {
    ctx: {
      tools: {
        register(tool) {
          registrations.push(tool);
          return () => {};
        },
      },
      effect(factory, label) {
        effects.push(label);
        return factory();
      },
    },
    registrations,
    effects,
  };
}

async function withStateDir(body) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'clawmaster-rpa-'));
  try {
    return await body(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

const checkpointWorkflow = {
  id: 'checkpoint-smoke',
  version: 1,
  steps: [
    { id: 'first', action: 'checkpoint', args: {}, sideEffect: 'none' },
    { id: 'second', action: 'checkpoint', args: {}, sideEffect: 'none' },
  ],
};

test('the plugin declares its identity and consumes only the tool registry', () => {
  assert.equal(name, 'clawmaster-rpa');
  assert.deepEqual(inject, ['tools']);
});

test('apply registers every tool inside its own effect', async () => {
  await withStateDir(async (stateDir) => {
    const standIn = standInContext();
    apply(standIn.ctx, { stateDir, workflows: [checkpointWorkflow] });

    assert.deepEqual(
      standIn.registrations.map((tool) => tool.name),
      ['rpa_run', 'rpa_native', 'rpa_call'],
    );
    assert.deepEqual(standIn.effects, [
      'clawmaster: governed RPA control plane',
      'clawmaster: native RPA helper inspection',
      'clawmaster: recovered native RPA tools',
    ]);
  });
});

test('a checkpoint workflow runs to completion with a durable receipt per step', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    assert.deepEqual(handlers.workflowIds, ['checkpoint-smoke']);

    const started = await handlers.run({ action: 'start', workflowId: 'checkpoint-smoke' });
    assert.equal(started.kind, 'run');
    assert.equal(started.run.state, 'pending');
    const { runId } = started.run;

    // The recovered runner advances one step per call and only settles the run
    // on a following call that finds no pending step, so a two-step workflow
    // needs three calls. This mirrors the seam's own contract.
    let current = started;
    for (let step = 0; step < checkpointWorkflow.steps.length; step += 1) {
      current = await handlers.run({ action: 'run_next', runId });
      assert.equal(current.run.state, 'pending');
    }
    current = await handlers.run({ action: 'run_next', runId });

    assert.equal(current.run.state, 'succeeded');
    assert.deepEqual(
      current.run.receipts.map((receipt) => receipt.state),
      ['succeeded', 'succeeded'],
    );
    assert.deepEqual(
      current.run.receipts.map((receipt) => receipt.attempt),
      [1, 1],
    );
    assert.equal(current.run.receipts[0].idempotencyKey, `${runId}:first:1`);
  });
});

test('a run survives a fresh handler over the same state directory', async () => {
  await withStateDir(async (stateDir) => {
    const first = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    const started = await first.run({ action: 'start', workflowId: 'checkpoint-smoke' });
    const advanced = await first.run({ action: 'run_next', runId: started.run.runId });

    const second = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    const reloaded = await second.run({ action: 'status', runId: started.run.runId });
    assert.equal(reloaded.kind, 'run');
    assert.equal(reloaded.run.revision, advanced.run.revision);
    assert.equal(reloaded.run.receipts[0].state, 'succeeded');
  });
});

test('an external side effect is denied rather than queued', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({
      stateDir,
      workflows: [
        {
          id: 'external-denied',
          version: 1,
          steps: [{ id: 'click', action: 'web.click', args: { selector: '#submit' }, sideEffect: 'external' }],
        },
      ],
    });

    const started = await handlers.run({ action: 'start', workflowId: 'external-denied' });
    const denied = await handlers.run({ action: 'run_next', runId: started.run.runId });

    assert.equal(denied.run.state, 'failed');
    assert.match(denied.run.receipts[0].error, /external side effect/u);
    assert.match(denied.run.receipts[0].error, /refused rather than queued/u);
  });
});

test('a real action fails loudly instead of reporting a false success', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({
      stateDir,
      workflows: [
        {
          id: 'extract-undriven',
          version: 1,
          steps: [{ id: 'read', action: 'web.extract', args: { selector: '#value' }, sideEffect: 'none' }],
        },
      ],
    });

    const started = await handlers.run({ action: 'start', workflowId: 'extract-undriven' });
    const failed = await handlers.run({ action: 'run_next', runId: started.run.runId });

    assert.equal(failed.run.state, 'failed');
    assert.match(failed.run.receipts[0].error, /no browser or desktop driver/u);
  });
});

test('status without a run id lists the installed workflows', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    const catalog = await handlers.run({ action: 'status' });

    assert.equal(catalog.kind, 'catalog');
    assert.deepEqual(catalog.workflowIds, ['checkpoint-smoke']);
    assert.equal(catalog.stateDir, path.resolve(stateDir));
  });
});

test('an unknown run id is reported as missing rather than throwing', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    const outcome = await handlers.run({ action: 'status', runId: 'rpa-00000000-0000-4000-8000-000000000000' });
    assert.equal(outcome.kind, 'missing');
  });
});

test('take_over only accepts a run whose external outcome is unknown', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    const started = await handlers.run({ action: 'start', workflowId: 'checkpoint-smoke' });
    await assert.rejects(
      () => handlers.run({ action: 'take_over', runId: started.run.runId, note: 'taking over' }),
      /unknown external outcome/u,
    );
  });
});

test('operations validate their identifiers and approve is not model-reachable', async () => {
  await withStateDir(async (stateDir) => {
    const handlers = createRpaHandlers({ stateDir, workflows: [checkpointWorkflow] });
    await assert.rejects(() => handlers.run({ action: 'start' }), /requires workflowId/u);
    await assert.rejects(() => handlers.run({ action: 'run_next' }), /requires runId/u);
    assert.equal(RPA_ACTIONS.includes('approve'), false);
  });
});
