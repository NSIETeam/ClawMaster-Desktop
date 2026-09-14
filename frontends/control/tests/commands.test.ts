/** Command acceptance, request identity, and input cancellation without a real Host. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createControlProgram, readCommandInput } from '../src/cli.ts';
import { controlFailure, executeControlCommand, type ControlCommand, type ControlCommandDependencies } from '../src/client.ts';
import { ControlConnectionError, type DesktopConnection } from '../src/connect.ts';

const requestId = '8bbe2f8e-40eb-400d-a9bd-6f71b11fb2dd';
const send: ControlCommand = { kind: 'send', sessionId: 'session-fixture', steer: false, requestId, json: true };
const runtime: DesktopConnection['runtime'] = {
  schemaVersion: 1, status: 'ready', runId: 'run-fixture', desktopVersion: '0.2.0', harnessVersion: '0.1.5-rc.2',
  desktopPid: 11, hostPid: 12, port: 1234, observedAtUnixMs: 1, contentSha256: 'a'.repeat(64),
};

function fixture(response: unknown = { accepted: true }) {
  const calls: Array<{ endpoint: string; payload: unknown; signal: AbortSignal | undefined }> = [];
  let connections = 0;
  const desktop: DesktopConnection = {
    record: { origin: 'http://127.0.0.1:1234', hostPid: 12, instanceId: 'instance-fixture' }, runtime,
    rpc: { call: async (_channel, endpoint, payload, signal) => {
      calls.push({ endpoint, payload, signal });
      return { ok: true, value: response };
    } },
  };
  const dependencies: ControlCommandDependencies = {
    requestTimeoutMs: 30_000,
    connect: async () => { connections += 1; return desktop; },
    readInput: async () => '请检查状态。\n',
  };
  return { calls, desktop, dependencies, connections: () => connections };
}

function parse(args: string[]): ControlCommand | undefined {
  let selected: ControlCommand | undefined;
  const program = createControlProgram(command => { selected = command; }, () => requestId);
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  }
  program.parse(args, { from: 'user' });
  return selected;
}

test('grammar selects the four supported commands without starting work', () => {
  assert.deepEqual(parse(['status']), { kind: 'status', json: false });
  assert.deepEqual(parse(['sessions', '--running', '--json']), { kind: 'sessions', running: true, json: true });
  assert.deepEqual(parse(['send', 'session-fixture', '--stdin', '--json']), send);
  assert.deepEqual(parse(['cancel', 'session-fixture', '--json']), { kind: 'cancel', sessionId: 'session-fixture', json: true });
});

test('grammar keeps an explicit retry identity and steer delivery', () => {
  assert.deepEqual(parse(['send', 'session-fixture', '--stdin', '--steer', '--request-id', requestId, '--json']), { ...send, steer: true });
});

test('grammar rejects missing stdin, invalid identity, extra arguments, and unsupported commands', () => {
  for (const args of [['send', 'session-fixture'], ['send', 's', '--stdin', '--request-id', 'invalid'], ['status', 'extra'], ['rpc']]) {
    assert.throws(() => parse(args));
  }
});

test('status emits only the connector-projected runtime, without calling a Session method', async () => {
  const f = fixture();
  const result = await executeControlCommand({ kind: 'status', json: true }, f.dependencies, new AbortController().signal);
  assert.deepEqual(result.value, { connected: true, runtime });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(result.value).includes('http:'), false);
});

test('sessions uses the cold list endpoint and filters running rows after validation', async () => {
  const f = fixture({ items: [
    { sessionId: 'one', running: true, updatedAt: 1, cwd: '/project', projections: { private: 'omit' } },
    { sessionId: 'two', running: false, updatedAt: 2 },
  ] });
  const result = await executeControlCommand({ kind: 'sessions', running: true, json: true }, f.dependencies, new AbortController().signal);
  assert.deepEqual(f.calls.map(({ endpoint, payload }) => ({ endpoint, payload })), [{ endpoint: 'session/list', payload: { args: { _request: {} } } }]);
  assert.deepEqual(result.value, { items: [{ sessionId: 'one', running: true, updatedAt: 1, cwd: '/project' }] });
  assert.match(result.text, /运行中/);
});

test('sessions refuses malformed fields and strips terminal control characters from human output', async () => {
  const f = fixture({ items: [{ sessionId: 'bad', running: 'yes', updatedAt: 0 }] });
  await assert.rejects(executeControlCommand({ kind: 'sessions', running: false, json: false }, f.dependencies, new AbortController().signal), /会话列表无效/);
  const good = fixture({ items: [{ sessionId: 'one\u001b[2J', running: false, updatedAt: 1 }] });
  const result = await executeControlCommand({ kind: 'sessions', running: false, json: false }, good.dependencies, new AbortController().signal);
  assert.equal(result.text.includes('\u001b'), false);
});

test('send preserves input and sends one stable request identity without claiming completion', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await executeControlCommand(send, f.dependencies, signal);
  assert.deepEqual(f.calls.map(({ endpoint, payload }) => ({ endpoint, payload })), [{ endpoint: 'session/prompt', payload: { args: { request: {
    requestId, sessionId: send.sessionId, mode: 'queue', content: [{ type: 'text', text: '请检查状态。\n' }],
  } } } }]);
  assert.deepEqual(result.value, { accepted: true, sessionId: send.sessionId, requestId, mode: 'queue' });
  assert.match(result.text, /尚未确认任务完成/);
  assert.equal(result.text.includes('请检查状态'), false);
});

test('steer is explicit and cancel retains the pending inbox', async () => {
  const f = fixture();
  const result = await executeControlCommand({ ...send, steer: true }, f.dependencies, new AbortController().signal);
  assert.equal((result.value as { mode: string }).mode, 'steer');
  const cancelled = await executeControlCommand({ kind: 'cancel', sessionId: 'one', json: true }, f.dependencies, new AbortController().signal);
  assert.deepEqual(cancelled.value, { accepted: true, sessionId: 'one', pendingInbox: 'retained' });
  assert.match(cancelled.text, /尚未确认中断完成/);
  assert.deepEqual(f.calls[1]?.payload, { args: { request: { sessionId: 'one' } } });
});

test('empty input fails before connecting and malformed admission receipts are rejected', async () => {
  const f = fixture({ accepted: false });
  await assert.rejects(executeControlCommand(send, { ...f.dependencies, readInput: async () => ' \n' }, new AbortController().signal), /不能为空/);
  assert.equal(f.connections(), 0);
  await assert.rejects(executeControlCommand(send, f.dependencies, new AbortController().signal), /有效接收凭证/);
});

test('unknown and remote errors expose neither URL nor token, and preserve send identity', async () => {
  const secret = 'http://127.0.0.1:1/?token=never-print';
  const failure = controlFailure(new Error(secret), send);
  assert.equal(failure.requestId, requestId);
  assert.equal(JSON.stringify(failure).includes('never-print'), false);
  const f = fixture();
  f.desktop.rpc.call = async () => ({ ok: false, error: { code: 'secret-code', message: secret, details: { token: 'never-print' } } });
  try { await executeControlCommand(send, f.dependencies, new AbortController().signal); assert.fail('must reject'); }
  catch (error) { assert.equal(controlFailure(error, send).code, 'remote-rejected'); }
});

test('connection failure is localized without exposing its internals', () => {
  const failure = controlFailure(new ControlConnectionError('authentication-failed'), { kind: 'status', json: true });
  assert.equal(failure.code, 'authentication-failed');
  assert.match(failure.message, /认证失败/);
});

test('a late transport completion after cancellation cannot publish a receipt or trigger a retry', async () => {
  const f = fixture();
  const arrived = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ ok: true; value: { accepted: true } }>();
  let calls = 0;
  f.desktop.rpc.call = async () => { calls += 1; arrived.resolve(); return response.promise; };
  const abort = new AbortController();
  const pending = executeControlCommand(send, f.dependencies, abort.signal);
  await arrived.promise;
  abort.abort(new Error('cancelled-fixture'));
  response.resolve({ ok: true, value: { accepted: true } });
  await assert.rejects(pending, /cancelled-fixture/);
  assert.equal(calls, 1);
});

test('the configured deadline cancels authentication and retains the retry identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = fixture();
    const arrived = Promise.withResolvers<void>();
    f.dependencies.connect = signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      arrived.resolve();
    });
    const pending = executeControlCommand(send, { ...f.dependencies, requestTimeoutMs: 123 }, new AbortController().signal);
    await arrived.promise;
    t.mock.timers.tick(123);
    await assert.rejects(pending, error => {
      const failure = controlFailure(error, send);
      assert.equal(failure.code, 'request-timeout');
      assert.equal(failure.requestId, requestId);
      return true;
    });
    assert.equal(f.calls.length, 0);
  } finally { t.mock.timers.reset(); }
});

test('stdin preserves multibyte UTF-8 across chunks and exact byte limits', async () => {
  const input = new PassThrough();
  const bytes = Buffer.from('中文\n');
  const pending = readCommandInput(input, bytes.length, new AbortController().signal);
  input.write(bytes.subarray(0, 1));
  input.end(bytes.subarray(1));
  assert.equal(await pending, '中文\n');
  assert.equal(input.listenerCount('data'), 0);
});

test('stdin rejects terminal, oversize, malformed UTF-8, and interrupted streams', async () => {
  const terminal = Object.assign(new PassThrough(), { isTTY: true });
  await assert.rejects(readCommandInput(terminal, 10, new AbortController().signal), /管道/);
  terminal.destroy();
  const input = new PassThrough();
  const pending = readCommandInput(input, 2, new AbortController().signal);
  input.end('中');
  await assert.rejects(pending, /超过/);
  input.destroy();
  const malformed = new PassThrough();
  const invalid = readCommandInput(malformed, 10, new AbortController().signal);
  malformed.end(Buffer.from([0xff]));
  await assert.rejects(invalid, /UTF-8/);
  const closed = new PassThrough();
  const closing = readCommandInput(closed, 10, new AbortController().signal);
  closed.destroy();
  await assert.rejects(closing, /结束前关闭/);
});

test('stdin cancellation removes every owned listener and does not destroy caller input', async () => {
  const input = new PassThrough();
  const abort = new AbortController();
  const pending = readCommandInput(input, 10, abort.signal);
  abort.abort(new Error('stop-input'));
  await assert.rejects(pending, /stop-input/);
  for (const event of ['data', 'end', 'error', 'close']) assert.equal(input.listenerCount(event), 0);
  assert.equal(input.destroyed, false);
  assert.equal(input.isPaused(), true);
  input.destroy();
});

test('human and JSON command output matches the owner-local recording', async () => {
  const outputs: Record<string, { human: string; json: string }> = {};
  const success = async (label: string, command: ControlCommand, response?: unknown): Promise<void> => {
    const f = fixture(response);
    const result = await executeControlCommand(command, f.dependencies, new AbortController().signal);
    outputs[label] = { human: `${result.text}\n`, json: `${JSON.stringify(result.value)}\n` };
  };
  await success('status', { kind: 'status', json: true });
  await success('sessions', { kind: 'sessions', running: false, json: true }, { items: [
    { sessionId: 'one', running: true, updatedAt: 1, cwd: '/project' },
    { sessionId: 'two', running: false, updatedAt: 2 },
  ] });
  await success('emptySessions', { kind: 'sessions', running: false, json: true }, { items: [] });
  await success('send', send);
  await success('steer', { ...send, steer: true });
  await success('cancel', { kind: 'cancel', sessionId: 'one', json: true });
  for (const [label, error, command] of [
    ['sendFailure', new Error('private transport detail'), send],
    ['authenticationFailure', new ControlConnectionError('authentication-failed'), { kind: 'status', json: true }],
  ] as const) {
    const failure = controlFailure(error, command);
    outputs[label] = {
      human: `${failure.message}${failure.requestId === undefined ? '' : `\n重试请使用同一请求 ID：${failure.requestId}`}\n`,
      json: `${JSON.stringify({ error: failure })}\n`,
    };
  }
  const expected = JSON.parse(readFileSync(new URL('./expected/commands.output.json', import.meta.url), 'utf8')) as unknown;
  assert.deepEqual(outputs, expected);
});
