/** Header and artifact checks reject misplaced, truncated or modified native helpers. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertRpaExecutable, RPA_TARGETS, verifyRpaNative } from './prepare-rpa-native.mjs'

function binary(target) {
  const { platform, arch } = RPA_TARGETS[target]
  const bytes = Buffer.alloc(128)
  if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(2, 12)
  } else if (platform === 'linux') {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18); bytes.writeUInt16LE(3, 16)
  } else {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88)
  }
  return bytes
}

test('every release target rejects executable headers for the other platform or architecture', () => {
  for (const target of Object.keys(RPA_TARGETS)) {
    const bytes = binary(target)
    assert.doesNotThrow(() => assertRpaExecutable(bytes, target))
    assert.throws(() => assertRpaExecutable(bytes.subarray(0, 63), target), /does not match/)
    for (const wrong of Object.keys(RPA_TARGETS).filter(value => value !== target)) assert.throws(() => assertRpaExecutable(bytes, wrong), /does not match/)
  }
  assert.throws(() => assertRpaExecutable(Buffer.alloc(128), 'riscv64-unknown-linux-gnu'), /Unsupported/)
})

test('packaged helper requires a matching version, digest and executable mode', t => {
  const root = mkdtempSync(join(tmpdir(), 'ClawMaster RPA 校验 '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = 'x86_64-unknown-linux-gnu'
  const directory = join(root, 'frontends/rpa/dist/native/linux-x64')
  mkdirSync(directory, { recursive: true })
  const filename = 'clawmaster-rpa-native'
  const path = join(directory, filename)
  const bytes = binary(target)
  writeFileSync(join(root, 'frontends/rpa/package.json'), '{"version":"0.1.1"}')
  writeFileSync(path, bytes); chmodSync(path, 0o755)
  const manifest = { schemaVersion: 1, target, version: '0.1.1', sourceSha256: 'a'.repeat(64), filename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const manifestPath = join(directory, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.equal(verifyRpaNative(root, target), path)
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.1.0' }))
  assert.throws(() => verifyRpaNative(root, target), /differs/)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  bytes[127] = 1; writeFileSync(path, bytes)
  assert.throws(() => verifyRpaNative(root, target), /differs/)
  writeFileSync(path, binary(target))
  const native = join(root, 'frontends/rpa/native')
  mkdirSync(native)
  writeFileSync(join(native, 'Cargo.toml'), 'source')
  writeFileSync(join(native, 'Cargo.lock'), 'lock')
  assert.throws(() => verifyRpaNative(root, target), /differs/)
  rmSync(native, { recursive: true })
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644)
    assert.throws(() => verifyRpaNative(root, target), /not executable/)
  }
  rmSync(path)
  assert.throws(() => verifyRpaNative(root, target), /ENOENT/)
})

test('CI builds native helpers before packaging and validates the distributed executable', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('prepare-rpa-native.mjs --target') < workflow.indexOf('name: Build desktop bundles'))
  assert.ok(workflow.indexOf('name: Build and verify native RPA helper') < workflow.indexOf('name: Verify RPA control plane and distributed native bridge'))
  assert.match(workflow, /CLAWMASTER_REQUIRE_NATIVE: '1'/)
  assert.match(workflow, /prepare-rpa-native\.mjs --root "\$task_smoke".*--check --smoke/)
  assert.match(workflow, /prepare-rpa-native\.mjs --root \$smokeRoot.*--check --smoke/)
})
