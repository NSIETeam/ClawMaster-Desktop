/** Build and verify the platform-specific RPA executable carried by the desktop payload. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, globSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
/** Release matrix mapping; the destination uses Node platform and architecture names. */
export const RPA_TARGETS = Object.freeze({
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' },
})
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function nativeSourceDigest(root) {
  const native = join(root, 'frontends/rpa/native')
  const hash = createHash('sha256')
  for (const file of ['Cargo.toml', 'Cargo.lock', ...globSync('src/**/*.rs', { cwd: native }).sort()]) {
    hash.update(file.replaceAll('\\', '/')); hash.update('\0'); hash.update(readFileSync(join(native, file))); hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Reject binaries for a different OS or architecture before copying them into an installer.
 * @param {Buffer} bytes - Complete executable bytes.
 * @param {string} target - Supported Rust release target.
 * @returns {void} Throws for malformed or mismatched executable headers.
 */
export function assertRpaExecutable(bytes, target) {
  const expected = RPA_TARGETS[target]
  if (!expected) throw new Error(`Unsupported RPA release target: ${target}`)
  let matches = false
  if (bytes.length >= 64 && expected.platform === 'darwin') {
    matches = bytes.readUInt32LE(0) === 0xfeedfacf
      && bytes.readUInt32LE(4) === (expected.arch === 'arm64' ? 0x0100000c : 0x01000007)
      && bytes.readUInt32LE(12) === 2
  } else if (bytes.length >= 64 && expected.platform === 'linux') {
    matches = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === (expected.arch === 'arm64' ? 183 : 62)
      && [2, 3].includes(bytes.readUInt16LE(16))
  } else if (bytes.length >= 64 && expected.platform === 'win32' && bytes.toString('ascii', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c)
    matches = pe >= 64 && pe + 26 <= bytes.length && bytes.toString('ascii', pe, pe + 4) === 'PE\u0000\u0000'
      && bytes.readUInt16LE(pe + 4) === 0x8664 && bytes.readUInt16LE(pe + 24) === 0x20b
  }
  if (!matches) throw new Error(`RPA executable does not match ${target}`)
}

/**
 * Verify the distributed helper's bytes against its recorded build target and digest.
 * @param {string} root - Repository or trimmed runtime root.
 * @param {string} target - Supported Rust release target.
 * @returns {string} Verified executable path.
 */
export function verifyRpaNative(root, target) {
  const spec = RPA_TARGETS[target]
  if (!spec) throw new Error(`Unsupported RPA release target: ${target}`)
  const directory = join(root, 'frontends/rpa/dist/native', `${spec.platform}-${spec.arch}`)
  const filename = `clawmaster-rpa-native${spec.platform === 'win32' ? '.exe' : ''}`
  const executable = join(directory, filename)
  const info = lstatSync(executable)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('RPA helper must be a regular executable file')
  if (process.platform !== 'win32' && spec.platform !== 'win32' && !(info.mode & 0o111)) throw new Error('RPA helper is not executable')
  const bytes = readFileSync(executable)
  assertRpaExecutable(bytes, target)
  const record = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const version = JSON.parse(readFileSync(join(root, 'frontends/rpa/package.json'), 'utf8')).version
  if (record.schemaVersion !== 1 || record.target !== target || record.filename !== filename
    || !/^[a-f0-9]{64}$/.test(record.sourceSha256)
    || (existsSync(join(root, 'frontends/rpa/native/Cargo.toml')) && record.sourceSha256 !== nativeSourceDigest(root))
    || record.version !== version || record.size !== bytes.length || record.sha256 !== digest(bytes)) {
    throw new Error('RPA helper differs from its build manifest')
  }
  return executable
}

/**
 * Compile the original Rust helper and copy its executable into the packaged frontend.
 * @param {string} root - Source repository root.
 * @param {string} target - Supported Rust release target.
 * @returns {string} Verified executable path.
 */
export function prepareRpaNative(root, target) {
  const spec = RPA_TARGETS[target]
  if (!spec) throw new Error(`Unsupported RPA release target: ${target}`)
  const native = join(root, 'frontends/rpa/native')
  const filename = `clawmaster-rpa-native${spec.platform === 'win32' ? '.exe' : ''}`
  const sourceSha256 = nativeSourceDigest(root)
  execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', join(native, 'Cargo.toml'), '--target', target,
    '--target-dir', join(native, 'target')], { cwd: root, stdio: 'inherit', timeout: 45 * 60 * 1000 })
  if (sourceSha256 !== nativeSourceDigest(root)) throw new Error('RPA source changed during native compilation')
  const source = join(native, 'target', target, 'release', filename)
  const bytes = readFileSync(source)
  assertRpaExecutable(bytes, target)
  const directory = join(root, 'frontends/rpa/dist/native', `${spec.platform}-${spec.arch}`)
  mkdirSync(directory, { recursive: true })
  copyFileSync(source, join(directory, filename))
  if (spec.platform !== 'win32') chmodSync(join(directory, filename), 0o755)
  const version = JSON.parse(readFileSync(join(root, 'frontends/rpa/package.json'), 'utf8')).version
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, target, version, sourceSha256, filename, size: bytes.length, sha256: digest(bytes) }, null, 2)}\n`)
  return verifyRpaNative(root, target)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const options = new Map()
  let check = false
  let smoke = false
  while (args.length) {
    const key = args.shift()
    if (key === '--check') check = true
    else if (key === '--smoke') smoke = true
    else if (['--target', '--root'].includes(key) && args[0] && !args[0].startsWith('--') && !options.has(key)) options.set(key, args.shift())
    else throw new Error('Usage: prepare-rpa-native.mjs [--target <Rust target>] [--root <runtime root>] [--check] [--smoke]')
  }
  const root = resolve(options.get('--root') ?? repository)
  const target = options.get('--target') ?? Object.keys(RPA_TARGETS).find(key => RPA_TARGETS[key].platform === process.platform && RPA_TARGETS[key].arch === process.arch)
  const executable = check ? verifyRpaNative(root, target) : prepareRpaNative(root, target)
  if (smoke) {
    const spec = RPA_TARGETS[target]
    if (spec.platform !== process.platform || spec.arch !== process.arch) throw new Error('RPA capabilities smoke must run on its native architecture')
    const output = JSON.parse(execFileSync(executable, ['--native-tool', 'capabilities'], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }))
    if (!Array.isArray(output.capabilities) || output.capabilities.length === 0) throw new Error('Native helper returned an empty capabilities catalog')
  }
  console.log(`RPA helper verified: ${executable}`)
}
