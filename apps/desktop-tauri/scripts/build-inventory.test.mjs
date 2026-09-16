import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assertReleaseCommit, captureBuildInventory } from './build-inventory.mjs'

test('captures component versions, emitted bytes, lockfiles and plugin patch provenance', t => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-build-inventory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  write('frontends/notes/package.json', JSON.stringify({ name: '@clawmaster/dsh-notes', version: '0.1.0' }))
  write('frontends/notes/dist/index.js', 'export const answer = 20\n')
  write('frontends/notes/package-lock.json', '{"lockfileVersion":3}\n')
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write('apps/desktop-tauri/patches/plugin.patch', '+ verified change\n')
  write('apps/desktop-tauri/patches/plugin.provenance.json', '{"source":"fixture"}\n')
  const first = captureBuildInventory(root)
  assert.equal(first.components[0].version, '0.1.0')
  assert.equal(first.components[0].artifacts[0].path, 'frontends/notes/dist/index.js')
  assert.match(first.components[0].manifest.sha256, /^[a-f0-9]{64}$/)
  assert.equal(first.locks.length, 2)
  assert.equal(first.patches.length, 2)
  assert.deepEqual(captureBuildInventory(root), first)
  write('frontends/notes/dist/index.js', 'export const answer = 21\n')
  assert.notEqual(captureBuildInventory(root).components[0].artifacts[0].sha256, first.components[0].artifacts[0].sha256)
  write('frontends/notes/package.json', '{"name":"missing-version"}')
  assert.throws(() => captureBuildInventory(root), /component identity is invalid/)
})

test('refuses stale or abbreviated candidate commits while allowing an explicit local build', () => {
  const source = { gitCommit: 'a'.repeat(40) }
  assert.doesNotThrow(() => assertReleaseCommit(source, source.gitCommit))
  assert.doesNotThrow(() => assertReleaseCommit(source, undefined))
  assert.throws(() => assertReleaseCommit(source, 'b'.repeat(40)), /differs from the expected candidate/)
  assert.throws(() => assertReleaseCommit(source, 'aaaaaaa'), /full Git commit SHA/)
})

test('the release entrypoint rejects a different candidate before a build is admitted', t => {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster-candidate-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scripts = join(root, 'apps/desktop-tauri/scripts')
  mkdirSync(scripts, { recursive: true })
  for (const name of ['build-provenance.mjs', 'build-inventory.mjs']) copyFileSync(new URL(name, import.meta.url), join(scripts, name))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.name=Build fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'candidate'])
  const commit = git(['rev-parse', 'HEAD']).trim()
  const run = expected => spawnSync(process.execPath, [join(scripts, 'build-provenance.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DSH_DESKTOP_BUILD_MODE: 'release', DSH_DESKTOP_RELEASE_COMMIT: expected },
  })
  const accepted = run(commit)
  assert.ifError(accepted.error)
  assert.equal(accepted.signal, null)
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).source.gitCommit, commit)
  const denied = run('b'.repeat(40))
  assert.ifError(denied.error)
  assert.equal(denied.signal, null)
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /differs from the expected candidate/)
})
