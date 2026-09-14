/** Synthetic local Host credentials never leave their private test home. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { BrowserAuth } from '../../../packages/client/connection/src/browser-auth.ts';
import { connectDesktop } from '../src/connect.ts';
import * as host from '../src/host.ts';
import { ControlConnectionError, parseConnectionRecord, publishConnectionRecord,
  readConnectionRecord, readCurrentRuntime } from '../src/connection-record.ts';

async function homeFixture(t) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'clawmaster-control-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function record(origin = 'http://127.0.0.1:17890') {
  return { schemaVersion: 1, instanceId: randomUUID(), hostPid: process.pid,
    runId: randomUUID(), origin, authenticatedUrl: `${origin}/?token=${randomBytes(32).toString('base64url')}` };
}

async function authority(home, connection, changes = {}) {
  const directory = join(home, 'desktop');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const value = { schemaVersion: 1, status: 'ready', runId: connection.runId,
    observedAtUnixMs: Date.now(), desktopVersion: 'test', harnessVersion: 'test',
    desktopPid: process.pid, hostPid: connection.hostPid, port: Number(new URL(connection.origin).port),
    contentSha256: 'a'.repeat(64), harnessRoot: '/not-public', credentials: 'not-public', ...changes };
  await writeFile(join(directory, 'current-runtime.json'), JSON.stringify(value), { mode: 0o600 });
}

function rejects(code) {
  return error => error instanceof ControlConnectionError && error.code === code
    && !error.message.includes('token=') && !error.message.includes('dsh-auth-');
}

test('accepts only a canonical loopback origin and one process login token', () => {
  const original = record();
  assert.deepEqual(parseConnectionRecord(original), original);
  for (const replacement of [
    { origin: 'http://localhost:17890' }, { origin: 'https://127.0.0.1:17890' },
    { origin: 'http://127.0.0.1:17890/' }, { origin: 'http://example.com' },
    { authenticatedUrl: original.authenticatedUrl + '&extra=1' },
    { authenticatedUrl: original.authenticatedUrl + '#leak' },
    { authenticatedUrl: original.authenticatedUrl.replace('17890', '17891') },
    { authenticatedUrl: 'http://user@127.0.0.1:17890/?token=' + 'a'.repeat(43) },
    { instanceId: 'not-an-instance' }, { hostPid: 0 }, { extra: true },
  ]) assert.throws(() => parseConnectionRecord({ ...original, ...replacement }), rejects('invalid-record'));
});

test('publishes private records and an old disposer cannot remove its successor', async t => {
  const home = await homeFixture(t);
  const first = record();
  const closeFirst = await publishConnectionRecord(home, first);
  assert.deepEqual(await readConnectionRecord(home), first);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(join(home, 'control'))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(home, 'control', 'connection.json'))).mode & 0o777, 0o600);
  }
  const second = record();
  const closeSecond = await publishConnectionRecord(home, second);
  await closeFirst();
  assert.deepEqual(await readConnectionRecord(home), second);
  await closeSecond();
  await assert.rejects(readConnectionRecord(home), rejects('not-running'));
  await closeSecond();
});

test('rejects symlinked home and control directories before publishing a capability', async t => {
  const root = await homeFixture(t);
  const realHome = join(root, 'real-home');
  await mkdir(realHome, { mode: 0o700 });
  const linkedHome = join(root, 'linked-home');
  await symlink(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishConnectionRecord(linkedHome, record()), rejects('insecure-record'));
  await symlink(realHome, join(root, 'control'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishConnectionRecord(root, record()), rejects('insecure-record'));
  await assert.rejects(readFile(join(realHome, 'connection.json')), { code: 'ENOENT' });
});

test('rejects a symlinked connection file without touching its target', { skip: process.platform === 'win32' ? 'Creating file symlinks requires Windows developer privileges; directory junctions run on every platform.' : false }, async t => {
  const home = await homeFixture(t);
  await mkdir(join(home, 'control'), { mode: 0o700 });
  const sentinel = join(home, 'sentinel');
  await writeFile(sentinel, 'sentinel', { mode: 0o600 });
  await symlink(sentinel, join(home, 'control', 'connection.json'));
  await assert.rejects(readConnectionRecord(home), rejects('insecure-record'));
  await assert.rejects(publishConnectionRecord(home, record()), rejects('insecure-record'));
  assert.equal(await readFile(sentinel, 'utf8'), 'sentinel');
});

test('refuses broadly readable files and directories instead of silently repairing them', { skip: process.platform === 'win32' ? 'POSIX mode checks; Windows uses DACL verification.' : false }, async t => {
  const home = await homeFixture(t);
  await publishConnectionRecord(home, record());
  const path = join(home, 'control', 'connection.json');
  await chmod(path, 0o644);
  await assert.rejects(readConnectionRecord(home), rejects('insecure-record'));
  await assert.rejects(publishConnectionRecord(home, record()), rejects('insecure-record'));
  await chmod(path, 0o600);
  await chmod(join(home, 'control'), 0o755);
  await assert.rejects(readConnectionRecord(home), rejects('insecure-record'));
  await chmod(join(home, 'control'), 0o700);
  await chmod(home, 0o777);
  await assert.rejects(readConnectionRecord(home), rejects('insecure-record'));
});

test('Windows rejects an Everyone-readable capability through its actual DACL', { skip: process.platform === 'win32' ? false : 'Windows DACL behavior requires the Windows runner.', timeout: 60_000 }, async t => {
  const home = await homeFixture(t);
  await publishConnectionRecord(home, record());
  await readConnectionRecord(home);
  const systemRoot = process.env.SystemRoot;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:CLAWMASTER_TEST_ACL_PATH
$acl = Get-Acl -LiteralPath $path
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
  await promisify(execFile)(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, CLAWMASTER_TEST_ACL_PATH: join(home, 'control', 'connection.json') },
      timeout: 30_000, windowsHide: true, maxBuffer: 1024,
    });
  await assert.rejects(readConnectionRecord(home), rejects('insecure-record'));
});

test('the actual Cordis Host effect publishes before SSOT readiness and awaits owned cleanup', async t => {
  const home = await homeFixture(t);
  const savedEnv = new Map(['DSH_HOME', 'CLAWMASTER_RUNTIME_RUN_ID', 'CLAWMASTER_RUNTIME_STATE'].map(key => [key, process.env[key]]));
  const context = new Context();
  try {
    process.env.DSH_HOME = home;
    process.env.CLAWMASTER_RUNTIME_RUN_ID = randomUUID();
    process.env.CLAWMASTER_RUNTIME_STATE = join(home, 'desktop', 'current-runtime.json');
    context.provide('webServer', { host: '127.0.0.1', port: 17890 });
    context.provide('connection', { authenticatedUrl: origin => `${origin}/?token=${'a'.repeat(43)}` });
    const owner = context.plugin(host);
    await owner.await();
    const published = await readConnectionRecord(home);
    assert.equal(published.hostPid, process.pid);
    assert.equal(published.origin, 'http://127.0.0.1:17890');
    assert.equal(published.runId, process.env.CLAWMASTER_RUNTIME_RUN_ID);
    await assert.rejects(readCurrentRuntime(home, published), rejects('not-running'));
    await owner.dispose();
    await assert.rejects(readConnectionRecord(home), rejects('not-running'));
  } finally {
    await context.fiber.dispose();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('ordinary Web profiles publish nothing and incomplete desktop identity fails explicitly', async t => {
  const home = await homeFixture(t);
  const savedEnv = new Map(['DSH_HOME', 'CLAWMASTER_RUNTIME_RUN_ID', 'CLAWMASTER_RUNTIME_STATE'].map(key => [key, process.env[key]]));
  try {
    process.env.DSH_HOME = home;
    delete process.env.CLAWMASTER_RUNTIME_RUN_ID;
    delete process.env.CLAWMASTER_RUNTIME_STATE;
    await host.apply({});
    await assert.rejects(readConnectionRecord(home), rejects('not-running'));
    process.env.CLAWMASTER_RUNTIME_RUN_ID = randomUUID();
    await assert.rejects(host.apply({}), /desktop runtime identity/);
    process.env.CLAWMASTER_RUNTIME_STATE = join(home, 'desktop', 'current-runtime.json');
    await assert.rejects(host.apply({ webServer: { host: '0.0.0.0' } }), /loopback/);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('bounds JSON reads and does not expose malformed record content in errors', async t => {
  const home = await homeFixture(t);
  await publishConnectionRecord(home, record());
  const path = join(home, 'control', 'connection.json');
  await writeFile(path, 's'.repeat(65 * 1024));
  await assert.rejects(readConnectionRecord(home), rejects('invalid-record'));
  await writeFile(path, '{"token":"synthetic"');
  await assert.rejects(readConnectionRecord(home), rejects('invalid-record'));
});

test('cross-checks the ready Host identity and returns a safe runtime projection', async t => {
  const home = await homeFixture(t);
  const connection = record();
  await publishConnectionRecord(home, connection);
  await authority(home, connection);
  const runtime = await readCurrentRuntime(home, connection);
  assert.equal(runtime.runId, connection.runId);
  assert.equal(Object.hasOwn(runtime, 'harnessRoot'), false);
  assert.equal(Object.hasOwn(runtime, 'credentials'), false);
  for (const changes of [{ status: 'stopped' }, { runId: randomUUID() }, { hostPid: process.pid + 1 }, { port: 17891 }]) {
    await authority(home, connection, changes);
    await assert.rejects(readCurrentRuntime(home, connection), rejects('stale-runtime'));
  }
});

async function serverFixture(t, loginOverride) {
  const home = await homeFixture(t);
  let credential;
  const auth = await BrowserAuth.create({}, {
    async modifyRecord(_key, update) { credential = await update(credential) ?? credential; return credential; },
  }, 30);
  const requests = [];
  const server = createServer((req, res) => {
    void (async () => {
      requests.push({ method: req.method, path: new URL(req.url, 'http://test').pathname });
      if (new URL(req.url, 'http://test').pathname === '/') {
        if (loginOverride) { await loginOverride(req, res); return; }
        auth.authorizeIndex(req, res);
        return;
      }
      if (!auth.isAuthenticated(req)) { res.writeHead(401); res.end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.method, 'session/list');
      assert.deepEqual(body.payload, { args: { _request: {} } });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
        result: { ok: true, value: { items: [{ sessionId: 'synthetic', running: false }] } } }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const connection = record(`http://127.0.0.1:${server.address().port}`);
  connection.authenticatedUrl = auth.authenticatedUrl(connection.origin);
  await publishConnectionRecord(home, connection);
  await authority(home, connection);
  return { home, connection, requests };
}

test('exchanges the actual BrowserAuth cookie and reuses Connection RPC without exposing credentials', async t => {
  const fixture = await serverFixture(t);
  const connected = await connectDesktop(fixture.home);
  assert.equal(connected.record.instanceId, fixture.connection.instanceId);
  assert.equal(JSON.stringify(connected).includes('token='), false);
  assert.equal(JSON.stringify(connected).includes('dsh-auth-'), false);
  const result = await connected.rpc.call('/api', 'session/list', { args: { _request: {} } });
  assert.deepEqual(result, { ok: true, value: { items: [{ sessionId: 'synthetic', running: false }] } });
  assert.deepEqual(fixture.requests, [{ method: 'GET', path: '/' }, { method: 'POST', path: '/api/session/list' }]);
  const successor = { ...fixture.connection, instanceId: randomUUID() };
  await publishConnectionRecord(fixture.home, successor);
  await assert.rejects(connected.rpc.call('/api', 'session/list', { args: { _request: {} } }), rejects('stale-runtime'));
  assert.equal(fixture.requests.length, 2);
});

test('rejects a stale runtime before sending its token to the port', async t => {
  const fixture = await serverFixture(t);
  await authority(fixture.home, fixture.connection, { status: 'stopped' });
  await assert.rejects(connectDesktop(fixture.home), rejects('stale-runtime'));
  assert.equal(fixture.requests.length, 0);
});

test('refuses redirects and malformed cookies without following an authentication URL', async t => {
  const fixture = await serverFixture(t, (_req, res) => {
    res.writeHead(303, { location: 'http://example.invalid/', 'set-cookie': 'not-dsh=bad' });
    res.end();
  });
  await assert.rejects(connectDesktop(fixture.home), rejects('authentication-failed'));
  assert.equal(fixture.requests.length, 1);
});

test('cancels an in-progress login without exposing its URL in the failure', { timeout: 60_000 }, async t => {
  const entered = Promise.withResolvers();
  const fixture = await serverFixture(t, () => { entered.resolve(); });
  const abort = new AbortController();
  const pending = connectDesktop(fixture.home, abort.signal);
  const failed = assert.rejects(pending, rejects('authentication-failed'));
  await entered.promise;
  abort.abort();
  await failed;
});
