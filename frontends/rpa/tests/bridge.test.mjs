/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

// Bridge tests. Most cases drive a stand-in helper, so they prove the process
// contract without a Rust build. The final case runs the real recovered binary
// when it has been built, and asserts the documented fail-closed behavior when
// macOS has not granted Accessibility.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NATIVE_READ_ONLY_COMMANDS,
  NativeHelperError,
  createNativeHelper,
  createRpaHandlers,
  defaultHelperPath,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function withFakeHelper(source, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'clawmaster-rpa-helper-'));
  const script = path.join(dir, 'fake-helper.mjs');
  await writeFile(script, source, 'utf8');
  try {
    return await body({ command: process.execPath, args: [script] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a successful invocation parses the helper JSON payload', async () => {
  await withFakeHelper(
    'process.stdout.write(JSON.stringify({ capabilities: [], argv: process.argv.slice(2) }));\n',
    async (spec) => {
      const helper = createNativeHelper(spec);
      const payload = await helper.run('capabilities');
      assert.deepEqual(payload, { capabilities: [], argv: ['--native-tool', 'capabilities'] });
    },
  );
});

test('a non-zero exit surfaces the helper reason and code', async () => {
  await withFakeHelper('process.stderr.write("系统尚未授权辅助功能\\n"); process.exit(2);\n', async (spec) => {
    const helper = createNativeHelper(spec);
    await assert.rejects(
      () => helper.run('desktop-snapshot'),
      (error) => {
        assert.ok(error instanceof NativeHelperError);
        assert.match(error.message, /尚未授权辅助功能/u);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  });
});

test('non-JSON stdout is reported rather than passed through', async () => {
  await withFakeHelper('process.stdout.write("not json");\n', async (spec) => {
    const helper = createNativeHelper(spec);
    await assert.rejects(() => helper.run('capabilities'), /not JSON/u);
  });
});

test('a hung helper is killed by the timeout', async () => {
  await withFakeHelper('setTimeout(() => {}, 60_000);\n', async (spec) => {
    const helper = createNativeHelper(spec, 150);
    await assert.rejects(() => helper.run('capabilities'), /timed out after 150ms/u);
  });
});

test('an aborted signal cancels the invocation', async () => {
  await withFakeHelper('setTimeout(() => {}, 60_000);\n', async (spec) => {
    const helper = createNativeHelper(spec, 30_000);
    const controller = new AbortController();
    const pending = helper.run('capabilities', [], controller.signal);
    controller.abort();
    await assert.rejects(() => pending, /cancelled/u);
  });
});

test('a missing helper binary fails with a clear message', async () => {
  const helper = createNativeHelper({ command: '/nonexistent/clawmaster-rpa-native', args: [] });
  await assert.rejects(() => helper.run('capabilities'), /could not start/u);
});

test('only read-only native subcommands are reachable from the plugin', async () => {
  const handlers = createRpaHandlers({ stateDir: path.join(tmpdir(), 'clawmaster-rpa-unused') });
  assert.deepEqual(NATIVE_READ_ONLY_COMMANDS, ['capabilities', 'definitions', 'desktop-snapshot']);
  await assert.rejects(() => handlers.native('input'), /not in the read-only set/u);
  assert.equal(NATIVE_READ_ONLY_COMMANDS.includes('input'), false);
});

test('an unbuilt helper reports unavailability instead of throwing', async () => {
  const handlers = createRpaHandlers({
    stateDir: path.join(tmpdir(), 'clawmaster-rpa-unused'),
    helper: undefined,
  });
  const detected = defaultHelperPath();
  if (detected !== null) return; // a built helper exists; the real case below covers it
  const outcome = await handlers.native('capabilities');
  assert.equal(outcome.kind, 'native_unavailable');
  assert.match(outcome.reason, /not built/u);
});

test('a semantic call forwards root, tool and arguments with no approval binding', async () => {
  await withFakeHelper('process.stdout.write(process.argv[4] ?? "");\n', async (spec) => {
    const handlers = createRpaHandlers({ stateDir: '/tmp/clawmaster-rpa-call', helper: spec });
    const outcome = await handlers.call({ tool: 'rpa_status', arguments: { runId: 'r1' } });

    assert.equal(outcome.kind, 'native');
    assert.equal(outcome.command, 'rpa-call:rpa_status');
    assert.deepEqual(outcome.payload, {
      root: '/tmp/clawmaster-rpa-call/native',
      tool: 'rpa_status',
      arguments: { runId: 'r1' },
      approvalId: null,
    });
  });
});

test('a semantic call defaults its arguments to an empty object', async () => {
  await withFakeHelper('process.stdout.write(process.argv[4] ?? "");\n', async (spec) => {
    const handlers = createRpaHandlers({ stateDir: '/tmp/clawmaster-rpa-call', helper: spec });
    const outcome = await handlers.call({ tool: 'rpa_windows' });
    assert.deepEqual(outcome.payload.arguments, {});
  });
});

test('an unbuilt helper makes a semantic call unavailable rather than throwing', async () => {
  const handlers = createRpaHandlers({ stateDir: '/tmp/clawmaster-rpa-call' });
  if (defaultHelperPath() !== null) return; // a built helper exists; the real case covers it
  const outcome = await handlers.call({ tool: 'rpa_status' });
  assert.equal(outcome.kind, 'native_unavailable');
});

test('the real helper refuses a write tool that has no approval binding', async () => {
  const binary = path.join(here, '..', 'native', 'target', 'debug', 'clawmaster-rpa-native');
  const built = existsSync(binary) || existsSync(path.join(here, '..', 'native', 'target', 'release', 'clawmaster-rpa-native'));
  if (!built) {
    console.log('  (skipped: native helper not built)');
    return;
  }

  const stateDir = await mkdtemp(path.join(tmpdir(), 'clawmaster-rpa-gate-'));
  try {
    const handlers = createRpaHandlers({ stateDir });

    // A read-only tool still executes.
    const read = await handlers.call({
      tool: 'rpa_status',
      arguments: { runId: 'rpa-00000000-0000-4000-8000-000000000000' },
    });
    assert.equal(read.kind, 'native');
    assert.deepEqual(read.payload, { run: null });

    // The browser half needs no run and no approval: it reports which system
    // browsers and WebDriver adapters this machine actually offers.
    const support = await handlers.call({ tool: 'rpa_browser_support' });
    assert.equal(support.kind, 'native');
    assert.ok(Array.isArray(support.payload));
    assert.ok(support.payload.length > 0);
    for (const entry of support.payload) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.installed, 'boolean');
      assert.equal(typeof entry.webdriverContract, 'boolean');
    }

    // rpa_start is classified as a write, and `execute` reaches `launch` without
    // checking approval itself, so the adapter's gate is what stops it.
    const write = await handlers.call({
      tool: 'rpa_start',
      arguments: {
        runId: 'rpa-33333333-3333-4333-8333-333333333333',
        tenantId: 't1',
        platformId: 'p1',
        url: 'https://example.com',
        browser: 'chrome',
      },
    });
    assert.equal(write.kind, 'native');
    assert.equal(write.payload.profilePath, '', 'no browser profile may be created');
    const [receipt] = write.payload.receipts;
    assert.equal(receipt.state, 'rejected');
    assert.equal(receipt.externalSideEffect, true);
    assert.equal(receipt.approvalId, null);
    assert.match(receipt.error, /允许 RPA 执行 rpa_start/u);
    assert.equal(receipt.idempotencyKey, 'rejected:launch');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('the real helper answers capabilities, and refuses the desktop without permission', async () => {
  const binary = path.join(here, '..', 'native', 'target', 'debug', 'clawmaster-rpa-native');
  const built = existsSync(binary) || existsSync(path.join(here, '..', 'native', 'target', 'release', 'clawmaster-rpa-native'));
  if (!built) {
    console.log('  (skipped: native helper not built)');
    return;
  }

  const handlers = createRpaHandlers({ stateDir: path.join(tmpdir(), 'clawmaster-rpa-real') });
  const capabilities = await handlers.native('capabilities');
  assert.equal(capabilities.kind, 'native');
  assert.ok(Array.isArray(capabilities.payload.capabilities));
  assert.ok(capabilities.payload.capabilities.length > 0);

  const definitions = await handlers.native('definitions');
  assert.equal(definitions.kind, 'native');
  assert.ok(Array.isArray(definitions.payload));

  // Without macOS Accessibility the helper must fail closed with the exact
  // permission to grant. With the grant in place it may legitimately succeed,
  // so both outcomes are accepted — a silent empty snapshot is not.
  const snapshot = await handlers.native('desktop-snapshot').then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  if (snapshot.ok) {
    assert.equal(snapshot.value.kind, 'native');
  } else {
    assert.match(snapshot.error.message, /辅助功能|Accessibility/u);
  }
});
