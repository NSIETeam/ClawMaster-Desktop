import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { create } from 'tar'
import { activateComponent, confirmComponentHealth, installComponent, listComponentOperations, maintainRestartComponents, mountFirstUpdaterComponent, readComponentPatchRevision, rollbackComponent } from '../src/components.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-maintenance-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'home')
  await mkdir(dshHome)
  const packageRoot = join(root, 'package')
  await mkdir(packageRoot)
  const archivePath = join(root, 'updater.tgz')
  const descriptor = { id: 'updates', packageName: '@clawmaster/dsh-updates', version: '0.1.2', entry: './index.js', kind: 'component', activation: 'restart', requiresDshVersion: '0.1.5-rc.2' }
  async function install(version) {
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: descriptor.packageName, version, type: 'module' }))
    await writeFile(join(packageRoot, 'index.js'), `export const version = ${JSON.stringify(version)};\n`)
    await create({ gzip: true, file: archivePath, cwd: root }, ['package'])
    return installComponent({ dshHome, archivePath, descriptor: { ...descriptor, version }, dshVersion: '0.1.5-rc.2' })
  }
  const first = await install('0.1.2')
  await mountFirstUpdaterComponent({ dshHome, version: '0.1.2', confirmed: true, expectedPatchRevision: await readComponentPatchRevision(dshHome) })
  const patch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const before = await readFile(patch, 'utf8')
  const second = await install('0.1.3')
  const operation = await activateComponent({ dshHome, id: 'updates', version: '0.1.3', confirmed: true, expectedPatchRevision: await readComponentPatchRevision(dshHome) })
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const deadPid = child.pid
  assert.ok(deadPid)
  const [code, signal] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.equal(signal, null)
  await mkdir(join(dshHome, 'desktop'))
  const state = join(dshHome, 'desktop/current-runtime.json')
  await writeFile(state, JSON.stringify({ schemaVersion: 1, hostPid: deadPid, runId: 'previous-host', status: 'ready' }))
  return { root, dshHome, first, second, patch, before, operation, state,
    journal: join(dshHome, 'clawmaster-updates/operations', `${operation.rollbackToken}.json`) }
}

async function confirm(t, f, entryUrl) {
  const saved = process.env.CLAWMASTER_RUNTIME_RUN_ID
  process.env.CLAWMASTER_RUNTIME_RUN_ID = 'test-loaded-host'
  try { return await confirmComponentHealth({ dshHome: f.dshHome, entryUrl, hostPid: process.pid, runId: 'test-loaded-host' }) }
  finally {
    if (saved === undefined) delete process.env.CLAWMASTER_RUNTIME_RUN_ID
    else process.env.CLAWMASTER_RUNTIME_RUN_ID = saved
  }
}

test('an approved updater is selected only with a stopped Host and succeeds only after the exact entry loads', async t => {
  const f = await fixture(t)
  assert.equal(await readFile(f.patch, 'utf8'), f.before)
  const switched = await maintainRestartComponents(f.dshHome)
  assert.equal(switched[0].state, 'awaiting-health')
  assert.match(await readFile(f.patch, 'utf8'), /0\.1\.3/)
  assert.deepEqual(await confirm(t, f, f.first.entryUrl), [])
  assert.equal((await listComponentOperations(f.dshHome)).find(row => row.token === f.operation.rollbackToken).state, 'awaiting-health')
  assert.deepEqual(await confirm(t, f, f.second.entryUrl), [f.operation.rollbackToken])
  const recorded = (await listComponentOperations(f.dshHome)).find(row => row.token === f.operation.rollbackToken)
  assert.equal(recorded.state, 'completed')
  assert.equal(recorded.observedHostPid, process.pid)
  assert.equal(recorded.observedRunId, 'test-loaded-host')
  assert.deepEqual(await maintainRestartComponents(f.dshHome), [])
})

test('an unconfirmed startup is restored on the next maintenance pass and never retries itself', async t => {
  const f = await fixture(t)
  await maintainRestartComponents(f.dshHome)
  assert.equal((await maintainRestartComponents(f.dshHome))[0].state, 'rolled-back')
  assert.equal(await readFile(f.patch, 'utf8'), f.before)
  assert.deepEqual(await maintainRestartComponents(f.dshHome), [])
})

test('crashes on either side of the profile replacement restore the last approved working selection', async t => {
  for (const afterReplacement of [false, true]) {
    const f = await fixture(t)
    const record = JSON.parse(await readFile(f.journal, 'utf8'))
    await writeFile(f.journal, JSON.stringify({ ...record, state: 'switching' }))
    if (afterReplacement) await writeFile(f.patch, record.after)
    assert.equal((await maintainRestartComponents(f.dshHome))[0].state, 'rolled-back')
    assert.equal(await readFile(f.patch, 'utf8'), f.before)
  }
})

test('completed updater rollback is staged, preserves the live version, then confirms the previous loaded version', async t => {
  const f = await fixture(t)
  await maintainRestartComponents(f.dshHome)
  await confirm(t, f, f.second.entryUrl)
  const current = await readFile(f.patch, 'utf8')
  const rollback = await rollbackComponent({ dshHome: f.dshHome, rollbackToken: f.operation.rollbackToken,
    expectedPatchRevision: await readComponentPatchRevision(f.dshHome), confirmed: true })
  assert.equal(rollback.status, 'restart-required')
  assert.equal(await readFile(f.patch, 'utf8'), current)
  await maintainRestartComponents(f.dshHome)
  assert.equal(await readFile(f.patch, 'utf8'), f.before)
  assert.deepEqual(await confirm(t, f, f.first.entryUrl), [f.operation.rollbackToken])
})

test('a live Host, modified candidate, and a newer user edit all prevent maintenance writes', async t => {
  const running = await fixture(t)
  await writeFile(running.state, JSON.stringify({ schemaVersion: 1, hostPid: process.pid, runId: 'running', status: 'stopped' }))
  await assert.rejects(maintainRestartComponents(running.dshHome), /still running/)
  assert.equal(await readFile(running.patch, 'utf8'), running.before)
  const tampered = await fixture(t)
  await writeFile(new URL(tampered.second.entryUrl), 'tampered')
  const tamperedResult = await maintainRestartComponents(tampered.dshHome)
  assert.equal(tamperedResult[0].state, 'blocked')
  assert.match(tamperedResult[0].failure, /digest differs/)
  assert.equal(await readFile(tampered.patch, 'utf8'), tampered.before)
  const edited = await fixture(t)
  const edit = `${edited.before}# a newer user edit\n`
  await writeFile(edited.patch, edit)
  const editedResult = await maintainRestartComponents(edited.dshHome)
  assert.equal(editedResult[0].state, 'blocked')
  assert.match(editedResult[0].failure, /newer profile changes/)
  assert.equal(await readFile(edited.patch, 'utf8'), edit)
})

test('unconfirmed recovery does not overwrite a profile changed after the attempted upgrade', async t => {
  const f = await fixture(t)
  await maintainRestartComponents(f.dshHome)
  const edited = `${await readFile(f.patch, 'utf8')}# concurrent user edit\n`
  await writeFile(f.patch, edited)
  await assert.rejects(maintainRestartComponents(f.dshHome), /manual recovery/)
  assert.equal(await readFile(f.patch, 'utf8'), edited)
})
