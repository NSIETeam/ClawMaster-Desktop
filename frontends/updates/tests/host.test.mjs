import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { Header } from 'tar'

const moduleUrl = process.env.CLAWMASTER_UPDATES_ARTIFACT
  ? pathToFileURL(resolve(process.env.CLAWMASTER_UPDATES_ARTIFACT)).href : new URL('../src/host.ts', import.meta.url).href
const { apply } = await import(moduleUrl)
const { activateComponent, installComponent, readComponentPatchRevision } = await import(process.env.CLAWMASTER_UPDATES_ARTIFACT ? moduleUrl : new URL('../src/components.ts', import.meta.url).href)
const suffixes = { 'windows-x86_64': 'windows-x64-setup.exe', 'darwin-x86_64': 'macos-x64.app.tar.gz', 'darwin-aarch64': 'macos-arm64.app.tar.gz', 'linux-x86_64': 'linux-x64.AppImage', 'linux-x86_64-deb': 'linux-x64.deb' }
const publicKey = `untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
`
const nativeSignature = `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==
`

function archive(packageName, version) {
  const blocks = []
  for (const [path, content] of [
    ['package/package.json', JSON.stringify({ name: packageName, version, type: 'module' })],
    ['package/dist/index.js', 'export const name = "fixture"; export function apply() {}\n'],
  ]) {
    const bytes = Buffer.from(content)
    const header = new Header({ path, type: 'File', size: bytes.length, mode: 0o644 })
    header.encode()
    blocks.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-updates-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { privateKey, publicKey: catalogKey } = generateKeyPairSync('ed25519')
  const bytes = archive('@clawmaster/fixture', '1.0.0')
  const item = { id: 'fixture', packageName: '@clawmaster/fixture', kind: 'component', version: '1.0.0', entry: './dist/index.js', activation: 'hot', requiresDshVersion: '0.1.5-rc.2', url: 'https://updates.test/updates/clawmaster/components/artifacts/fixture-1.0.0.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const catalog = { schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', components: [item] }
  const native = { version: '0.2.1', notes: '', pub_date: '2026-09-15T00:00:00Z', platforms: Object.fromEntries(Object.entries(suffixes).map(([target, suffix]) => [target, { url: `https://updates.test/updates/clawmaster/versions/0.2.1/clawmaster-0.2.1-${suffix}`, signature: Buffer.from(nativeSignature).toString('base64') }])) }
  const config = { dshHome: join(root, 'home'), catalogUrl: 'https://updates.test/updates/clawmaster/components/catalog.json', nativeManifestUrl: 'https://updates.test/updates/clawmaster/latest.json', publicKeyPem: catalogKey.export({ format: 'pem', type: 'spki' }), nativePublicKey: Buffer.from(publicKey).toString('base64'), checkIntervalMs: 0, ...overrides }
  const facts = { observedAt: '2026-09-15T00:00:00Z', hostPid: 42, runId: 'this-host', source: 'desktop-runtime', dshVersion: '0.1.5-rc.2', desktopVersion: '0.2.1', nativeTarget: 'darwin-aarch64', providedPackages: {} }
  const requests = []
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error')
    requests.push(url)
    const encoded = Buffer.from(JSON.stringify(catalog))
    if (url === config.catalogUrl) return new Response(encoded)
    if (url === `${config.catalogUrl}.sig`) return new Response(sign(null, encoded, privateKey).toString('base64'))
    if (url === config.nativeManifestUrl) return new Response(JSON.stringify(native))
    if (url === item.url) return new Response(bytes)
    if (url.startsWith('https://updates.test/updates/clawmaster/versions/')) return new Response('test')
    throw new Error('Unexpected fixture URL')
  }
  return { root, config, item, catalog, native, facts, requests, bytes, fetchImpl }
}

async function mount(t, f, approve = async () => 'allowed-once', dependencies = {}) {
  const tools = new Map()
  const commands = new Map()
  let dispose
  const approvals = []
  await apply({
    commands: { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    approval: { request(request) { approvals.push(request); return approve(request) } },
    effect: async start => { dispose = await start() },
  }, f.config, { fetchImpl: f.fetchImpl, facts: async () => structuredClone(f.facts), ...dependencies })
  t.after(() => dispose())
  const execute = (name, args, extra = {}) => tools.get(name).execute(args, { name, callId: 'call-fixture', agent: {}, signal: new AbortController().signal, ...extra })
  return { execute, commands, tools, approvals, dispose: () => dispose() }
}

test('read-only slash command and discovery tool perform no filesystem writes or artifact downloads', async t => {
  const f = await fixture(t)
  const host = await mount(t, f)
  const status = await host.execute('clawmaster_updates', {})
  assert.equal(status.components.status, 'available')
  assert.equal(status.components.items[0].compatible, true)
  assert.equal(status.native.updateAvailable, false)
  const count = f.requests.length
  assert.deepEqual(await host.execute('clawmaster_updates', { refresh: false }), status)
  assert.equal(f.requests.length, count)
  const command = await host.commands.get('updates').handler({ rawInput: '', signal: new AbortController().signal })
  assert.equal(command.kind, 'success')
  assert.match(command.text, /当前 DSH: 0\.1\.5-rc\.2/)
  assert.match(command.text, /fixture 1\.0\.0/)
  assert.equal((await host.commands.get('updates').handler({ rawInput: ' install', signal: new AbortController().signal })).kind, 'error')
  assert.equal(host.approvals.length, 0)
  assert.deepEqual(await readdir(f.root), [])
  assert.ok(f.requests.every(url => !url.includes('/artifacts/') && !url.includes('/versions/')))
})

test('user rollback requires an owning agent and one approval bound to the selected updater operation', async t => {
  const f = await fixture(t)
  const descriptor = { ...f.item, id: 'updates', packageName: '@clawmaster/dsh-updates', activation: 'restart' }
  const archivePath = join(f.root, 'updater.tgz')
  await writeFile(archivePath, archive(descriptor.packageName, descriptor.version))
  await installComponent({ archivePath, descriptor, dshHome: f.config.dshHome, dshVersion: f.facts.dshVersion })
  const staged = await activateComponent({ dshHome: f.config.dshHome, id: 'updates', version: descriptor.version,
    expectedPatchRevision: await readComponentPatchRevision(f.config.dshHome), confirmed: true })
  const journal = join(f.config.dshHome, 'clawmaster-updates/operations', `${staged.rollbackToken}.json`)
  const before = await readFile(journal, 'utf8')
  let outcome = 'denied'
  const host = await mount(t, f, async () => outcome)
  await assert.rejects(host.execute('clawmaster_update_rollback', { operation: staged.rollbackToken }, { agent: undefined }), /agent|会话/)
  assert.equal(host.approvals.length, 0)
  await assert.rejects(host.execute('clawmaster_update_rollback', { operation: staged.rollbackToken }), /not approved/)
  assert.equal(await readFile(journal, 'utf8'), before)
  outcome = 'allowed-once'
  assert.equal((await host.execute('clawmaster_update_rollback', { operation: staged.rollbackToken })).status, 'restart-required')
  assert.equal(host.approvals.length, 2)
  assert.ok(host.approvals.every(request => request.reason.includes(staged.rollbackToken)))
  await assert.rejects(readFile(journal), { code: 'ENOENT' })
})

test('rejected, cancelled and unavailable approvals create no update directory or profile', async t => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const f = await fixture(t)
    const host = await mount(t, f, async () => outcome)
    await assert.rejects(host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' }), new RegExp(`approval_${outcome}`))
    assert.equal(host.approvals.length, 1)
    assert.match(host.approvals[0].reason, new RegExp(f.item.sha256))
    assert.equal(host.approvals[0].toolName, 'clawmaster_update')
    assert.equal(host.approvals[0].callId, 'call-fixture')
    assert.deepEqual(await readdir(f.root), [])
    assert.ok(!f.requests.includes(f.item.url))
  }
})

test('confirmed component writes use the signed candidate fixed before approval and report pending activation', async t => {
  const f = await fixture(t)
  const host = await mount(t, f, async () => {
    f.catalog.components = [{ ...f.item, version: '2.0.0', url: f.item.url.replace('1.0.0', '2.0.0') }]
    return 'allowed-once'
  })
  const result = await host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' })
  assert.equal(result.version, '1.0.0')
  assert.equal(result.status, 'activation-pending')
  const patch = await readFile(join(f.config.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /clawmaster-update-component-fixture/)
  assert.ok(f.requests.includes(f.item.url))
  assert.equal(f.requests.filter(url => url === f.config.catalogUrl).length, 1)
  assert.match(result.rollbackToken, /^[a-f0-9-]{36}$/)
})

test('profile or process changes during approval reject before downloads and owned-state writes', async t => {
  for (const drift of ['profile', 'host']) {
    const f = await fixture(t)
    const host = await mount(t, f, async () => {
      if (drift === 'host') f.facts.runId = 'successor'
      else {
        await mkdir(join(f.config.dshHome, 'profiles', 'web'), { recursive: true })
        await writeFile(join(f.config.dshHome, 'profiles', 'web', 'cordis.patch.yml'), '- id: changed-by-user\n  disabled: true\n')
      }
      return 'allowed-once'
    })
    await assert.rejects(host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' }), /changed during approval/)
    await assert.rejects(readFile(join(f.config.dshHome, 'clawmaster-updates')), { code: 'ENOENT' })
    assert.ok(!f.requests.includes(f.item.url))
  }
})

test('an older signed component cannot downgrade an installed version, including one installed during approval', async t => {
  for (const timing of ['before', 'during']) {
    const f = await fixture(t)
    const higher = { ...f.item, version: '2.0.0' }
    const path = join(f.root, 'newer.tgz')
    await writeFile(path, archive(higher.packageName, higher.version))
    await mkdir(f.config.dshHome)
    const install = () => installComponent({ archivePath: path, descriptor: higher, dshHome: f.config.dshHome, dshVersion: f.facts.dshVersion })
    if (timing === 'before') await install()
    const host = await mount(t, f, async () => { await install(); return 'allowed-once' })
    await assert.rejects(host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' }), /would downgrade/)
    assert.equal(host.approvals.length, timing === 'before' ? 0 : 1)
    assert.ok(!f.requests.includes(f.item.url))
    assert.deepEqual(await readdir(join(f.config.dshHome, 'clawmaster-updates', 'components', 'fixture')), ['2.0.0'])
    await assert.rejects(readFile(join(f.config.dshHome, 'profiles')), { code: 'ENOENT' })
  }
})

test('restart components remain staged and approval explicitly says restarting does not apply them', async t => {
  const f = await fixture(t)
  f.item.activation = 'restart'
  const host = await mount(t, f)
  const result = await host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' })
  assert.equal(result.status, 'restart-required')
  assert.match(host.approvals[0].reason, /重启不会自动应用/)
  await assert.rejects(readFile(join(f.config.dshHome, 'profiles', 'web', 'cordis.patch.yml')), { code: 'ENOENT' })
})

test('runtime archives and real Minisign native files are downloads with explicit unsupported activation states', async t => {
  const f = await fixture(t)
  const runtime = { ...f.item, kind: 'runtime', activation: 'desktop-required' }
  delete runtime.entry
  f.catalog.components = [runtime]
  const host = await mount(t, f)
  const runtimeResult = await host.execute('clawmaster_update', { kind: 'runtime', id: runtime.id, version: runtime.version })
  assert.equal(runtimeResult.status, 'requires-desktop-support')
  assert.deepEqual(await readFile(runtimeResult.path), f.bytes)
  const nativeResult = await host.execute('clawmaster_update', { kind: 'native', version: '0.2.1' })
  assert.equal(nativeResult.status, 'requires-native-installer')
  assert.equal(await readFile(nativeResult.path, 'utf8'), 'test')
  assert.equal(host.approvals.length, 2)
  await assert.rejects(readFile(join(f.config.dshHome, 'profiles')), { code: 'ENOENT' })
})

test('four-target native releases remain available on Apple Silicon and refuse Intel before approval or writes', async t => {
  for (const target of ['darwin-aarch64', 'darwin-x86_64']) {
    const f = await fixture(t)
    delete f.native.platforms['darwin-x86_64']
    f.facts.nativeTarget = target
    const host = await mount(t, f)
    const status = await host.execute('clawmaster_updates', {})
    assert.equal(status.components.status, 'available')
    if (target === 'darwin-x86_64') {
      assert.equal(status.native.status, 'unavailable')
      assert.match(status.native.error, /No native installer for darwin-x86_64/)
      await assert.rejects(host.execute('clawmaster_update', { kind: 'native', version: '0.2.1' }), /No native installer for darwin-x86_64/)
      assert.equal(host.approvals.length, 0)
      assert.deepEqual(await readdir(f.root), [])
      assert.ok(f.requests.every(url => !url.includes('/versions/')))
    } else {
      assert.equal(status.native.status, 'available')
      assert.equal(status.native.target, target)
      const result = await host.execute('clawmaster_update', { kind: 'native', version: '0.2.1' })
      assert.equal(result.status, 'requires-native-installer')
      assert.equal(result.target, target)
      assert.equal(host.approvals.length, 1)
      assert.equal(await readFile(result.path, 'utf8'), 'test')
    }
  }
})

test('untrusted input, incompatible facts and absent owning agents fail before approval or writes', async t => {
  const f = await fixture(t)
  const host = await mount(t, f)
  for (const request of [
    { kind: 'component', id: 'fixture', version: '0.9.0' },
    { kind: 'component', id: 'fixture', version: '1.0.0', url: 'https://attacker.test/evil' },
    { kind: 'native', version: '0.2.2' },
  ]) await assert.rejects(host.execute('clawmaster_update', request))
  await assert.rejects(host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' }, { agent: undefined }), /DSH agent/)
  f.facts.dshVersion = null
  await assert.rejects(host.execute('clawmaster_update', { kind: 'component', id: 'fixture', version: '1.0.0' }), /unverified DSH/)
  f.facts.desktopVersion = '0.2.2'
  await assert.rejects(host.execute('clawmaster_update', { kind: 'native', version: '0.2.1' }), /downgrade/)
  assert.equal(host.approvals.length, 0)
  assert.deepEqual(await readdir(f.root), [])
})

test('unloading cancels and joins background metadata work before removing the plugin', async t => {
  const f = await fixture(t, { checkIntervalMs: 60_000 })
  let started
  const ready = new Promise(resolve => { started = resolve })
  let requests = 0
  let cancelled = 0
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    requests += 1
    signal.addEventListener('abort', () => { cancelled += 1; reject(signal.reason) }, { once: true })
    if (requests === 2) started()
  })
  const host = await mount(t, f, async () => 'allowed-once', { fetchImpl })
  await ready
  await host.dispose()
  assert.equal(requests, 2)
  assert.equal(cancelled, 2)
  assert.equal(host.tools.size, 0)
  assert.equal(host.commands.size, 0)
  assert.deepEqual(await readdir(f.root), [])
})
