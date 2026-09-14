/** Real DSH profile exits without starting an agent Host or rewriting the Web profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareControlProfile } from '../../../apps/desktop-tauri/scripts/desktop-defaults.mjs'
import { BrowserAuth } from '../../../packages/client/connection/src/browser-auth.ts'
import { publishConnectionRecord } from '../src/connection-record.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(root, 'apps/cli/package.json'))
const { resolveExampleLaunch } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-loader-smoke')).href)
const webManifest = '{"name":"private-web-fixture","dsh":{"profile":{"bundles":[]}}}\n'
const webPatch = '# Existing Web settings stay untouched.\n[]\n'

function isolatedEnv(home) {
  const environment = { DSH_HOME: home, NO_COLOR: '1' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

async function fixture(t, beforeCleanup = async () => {}) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'clawmaster-control-profile-'))
  t.after(async () => {
    try { await beforeCleanup() }
    finally { await rm(home, { recursive: true, force: true, maxRetries: 3 }) }
  })
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(join(home, 'profiles/web/package.json'), webManifest)
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), webPatch)
  return home
}

async function runChild(command, args, environment, input) {
  const child = spawn(command, args, { cwd: root, env: environment, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let spawnError
  let inputError
  let forceKill
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', error => { spawnError = error })
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  if (child.stdin) {
    child.stdin.on('error', error => { inputError = error })
    child.stdin.end(input)
  }
  // Profile initialization and module loading own this deadline; close confirms all pipes settled.
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
  }, 30_000)
  let result
  try {
    result = await finished
  } finally {
    clearTimeout(deadline)
    clearTimeout(forceKill)
  }
  assert.equal(timedOut, false, `control child timed out\n${stderr}`)
  assert.equal(result.signal, null, `control child was signalled\n${stderr}`)
  if (spawnError) throw spawnError
  if (inputError) throw inputError
  return { ...result, stdout, stderr }
}

async function runProfile(home, args, input) {
  const launch = resolveExampleLaunch({
    srcBin: join(root, 'apps/cli/src/bin.ts'),
    configArgs: ['--profile', 'clawmaster-control', ...args],
    mode: 'lib',
    env: isolatedEnv(home),
  })
  return runChild(launch.command, launch.args, launch.env, input)
}

async function assertWebUntouched(home) {
  assert.equal(await readFile(join(home, 'profiles/web/package.json'), 'utf8'), webManifest)
  assert.equal(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8'), webPatch)
  assert.deepEqual((await readdir(join(home, 'profiles/web'))).sort(), ['cordis.patch.yml', 'package.json'])
  const profile = JSON.parse(await readFile(join(home, 'profiles/clawmaster-control/package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, ['@clawmaster/dsh-control'])
  for (const forbidden of ['sessions', '.credentials.yaml', 'control', 'desktop']) {
    await assert.rejects(readdir(join(home, forbidden)), { code: 'ENOENT' })
  }
}

test('built control profile prints help and leaves the Web profile and agent state untouched', { timeout: 45_000 }, async t => {
  const home = await fixture(t)
  await prepareControlProfile(root, home)
  const result = await runProfile(home, ['--help'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  for (const command of ['status', 'sessions', 'send', 'cancel']) assert.match(result.stdout, new RegExp(`\\b${command}\\b`))
  await assertWebUntouched(home)
})

test('built control profile returns only a JSON error when no desktop record exists', { timeout: 45_000 }, async t => {
  const home = await fixture(t)
  await prepareControlProfile(root, home)
  const result = await runProfile(home, ['status', '--json'])
  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), {
    error: { code: 'not-running', message: '未找到运行中的 ClawMaster，请先打开桌面应用。' },
  })
  await assertWebUntouched(home)
})

test('repository convenience command initializes only control and dispatches its help', { timeout: 45_000 }, async t => {
  const home = await fixture(t)
  // Source dispatch is this wrapper's public contract; the direct profile cases above use built DSH.
  const result = await runChild(process.execPath, [join(root, 'scripts/clawmaster.mjs'), '--help'], isolatedEnv(home))
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /ClawMaster/)
  assert.match(result.stdout, /\bsend\b/)
  await assertWebUntouched(home)
})

async function authenticatedHost(home, ownCleanup) {
  let credential
  const auth = await BrowserAuth.create({}, {
    async modifyRecord(_key, update) { credential = await update(credential) ?? credential; return credential },
  }, 30)
  const requests = []
  const failures = []
  const active = new Set()
  const server = createServer((request, response) => {
    const task = (async () => {
      const path = new URL(request.url, 'http://fixture.invalid').pathname
      if (path === '/') { auth.authorizeIndex(request, response); return }
      if (!auth.isAuthenticated(request)) { response.writeHead(401); response.end(); return }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(request.method, 'POST')
      assert.equal(body.type, 'client-request')
      assert.equal(path, `/api/${body.method}`)
      assert.match(body.rpcId, /^[0-9a-f-]{36}$/)
      requests.push({ method: body.method, payload: body.payload })
      let value
      if (body.method === 'session/list') {
        value = { items: [
          { sessionId: 'active-fixture', running: true, updatedAt: 10, cwd: '/synthetic/work', content: 'private-message-fixture' },
          { sessionId: 'cold-fixture', running: false, updatedAt: 5 },
        ] }
      } else if (body.method === 'session/prompt' || body.method === 'session/cancel') {
        value = { accepted: true }
      } else throw new Error('Unexpected fixture business endpoint')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }))
    })()
    active.add(task)
    void task.catch(error => {
      failures.push(error)
      response.writeHead(500)
      response.end()
    }).finally(() => active.delete(task))
  })
  ownCleanup(async () => {
    if (server.listening) {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    }
    await Promise.allSettled([...active])
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const origin = `http://127.0.0.1:${server.address().port}`
  const connection = {
    schemaVersion: 1, instanceId: randomUUID(), hostPid: process.pid,
    runId: randomUUID(), origin, authenticatedUrl: auth.authenticatedUrl(origin),
  }
  await publishConnectionRecord(home, connection)
  await mkdir(join(home, 'desktop'), { mode: 0o700 })
  await writeFile(join(home, 'desktop/current-runtime.json'), JSON.stringify({
    schemaVersion: 1, status: 'ready', runId: connection.runId,
    observedAtUnixMs: 1, desktopVersion: 'fixture', harnessVersion: 'fixture',
    desktopPid: process.pid, hostPid: process.pid, port: server.address().port,
    contentSha256: 'a'.repeat(64), credentials: 'private-runtime-fixture',
  }), { mode: 0o600 })
  return { origin, requests, failures }
}

// Five short-lived command processes share one owned HTTP fixture; no Agent or LLM is mounted.
test('built profile authenticates and routes filtered sessions, stdin sends and cancellation', { timeout: 180_000 }, async t => {
  let stopHost = async () => {}
  const home = await fixture(t, () => stopHost())
  await prepareControlProfile(root, home)
  const host = await authenticatedHost(home, close => { stopHost = close })
  const unauthorized = await fetch(`${host.origin}/api/session/list`, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(5_000),
  })
  assert.equal(unauthorized.status, 401)
  await unauthorized.body?.cancel()
  assert.deepEqual(host.requests, [])

  const successful = async (args, input) => {
    const result = await runProfile(home, [...args, '--json'], input)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.doesNotMatch(result.stdout, /token=|dsh-auth-|authenticatedUrl|private-runtime-fixture|private-message-fixture/)
    return JSON.parse(result.stdout)
  }
  const status = await successful(['status'])
  assert.equal(status.connected, true)
  assert.equal(status.runtime.hostPid, process.pid)
  assert.equal(status.runtime.desktopVersion, 'fixture')
  assert.equal(Object.hasOwn(status.runtime, 'credentials'), false)
  assert.deepEqual(await successful(['sessions', '--running']), {
    items: [{ sessionId: 'active-fixture', running: true, updatedAt: 10, cwd: '/synthetic/work' }],
  })
  const queuedId = '12345678-1234-4234-8234-123456789abc'
  const steeredId = '12345678-1234-4234-8234-123456789abd'
  const text = '请核对合成记录：8 + 12 = 20。\n仅用于控制路由验收。\n'
  assert.deepEqual(await successful(['send', 'active-fixture', '--stdin', '--request-id', queuedId], text), {
    accepted: true, sessionId: 'active-fixture', requestId: queuedId, mode: 'queue',
  })
  assert.deepEqual(await successful(['send', 'active-fixture', '--stdin', '--steer', '--request-id', steeredId], text), {
    accepted: true, sessionId: 'active-fixture', requestId: steeredId, mode: 'steer',
  })
  assert.deepEqual(await successful(['cancel', 'active-fixture']), {
    accepted: true, sessionId: 'active-fixture', pendingInbox: 'retained',
  })
  assert.deepEqual(host.failures, [])
  assert.deepEqual(host.requests, [
    { method: 'session/list', payload: { args: { _request: {} } } },
    { method: 'session/prompt', payload: { args: { request: {
      requestId: queuedId, sessionId: 'active-fixture', mode: 'queue', content: [{ type: 'text', text }],
    } } } },
    { method: 'session/prompt', payload: { args: { request: {
      requestId: steeredId, sessionId: 'active-fixture', mode: 'steer', content: [{ type: 'text', text }],
    } } } },
    { method: 'session/cancel', payload: { args: { request: { sessionId: 'active-fixture' } } } },
  ])
  assert.equal(await readFile(join(home, 'profiles/web/package.json'), 'utf8'), webManifest)
  assert.equal(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8'), webPatch)
})
