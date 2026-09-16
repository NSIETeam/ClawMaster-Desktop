/** Explicit component and dependency identities carried by the desktop build record. */
import { createHash } from 'node:crypto'
import { globSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Record source manifests, dependency locks, frontend artifacts and local plugin patches.
 * @param {string} root Repository root at the recorded build commit.
 * @returns {{components:object[], locks:object[], patches:object[]}} Deterministically sorted byte identities.
 */
export function captureBuildInventory(root) {
  const paths = patterns => [...new Set(globSync(patterns, { cwd: root }))]
    .map(path => path.replaceAll('\\', '/')).sort()
  const digest = path => {
    const absolute = join(root, path)
    if (!lstatSync(absolute).isFile()) throw new Error(`Build inventory entry must be a regular file: ${path}`)
    const bytes = readFileSync(absolute)
    return { path, bytes: bytes.length, sha256: sha256(bytes) }
  }
  const components = paths(['frontends/*/package.json', 'apps/cli/package.json', 'apps/desktop-tauri/package.json']).map(path => {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'))
    if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version) {
      throw new Error(`Build component identity is invalid: ${path}`)
    }
    const directory = path.slice(0, -'package.json'.length)
    const artifacts = paths([`${directory}dist/**/*`, `${directory}lib/**/*`])
      .filter(artifact => lstatSync(join(root, artifact)).isFile()).map(digest)
    return { name: manifest.name, version: manifest.version, manifest: digest(path), artifacts }
  })
  const locks = paths(['pnpm-lock.yaml', 'apps/desktop-tauri/pnpm-desktop-lock.yaml', 'frontends/*/package-lock.json']).map(digest)
  const patches = paths(['apps/desktop-tauri/patches/*.patch', 'apps/desktop-tauri/patches/*.provenance.json']).map(digest)
  return { components, locks, patches }
}

/**
 * Refuse a release candidate whose expected commit differs from the checked-out source.
 * @param {{gitCommit:string}} source Observed source record.
 * @param {string|undefined} expectedCommit The exact candidate commit supplied by the release workflow.
 * @returns {void}
 */
export function assertReleaseCommit(source, expectedCommit) {
  if (expectedCommit === undefined) return
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error('Release candidate must be a full Git commit SHA')
  if (source.gitCommit !== expectedCommit) throw new Error('Release source differs from the expected candidate commit')
}
