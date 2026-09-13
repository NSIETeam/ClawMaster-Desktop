/** Validate observations collected from the installed Windows desktop and its owned Host. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { win32, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Reject stale manifests, foreign processes and a different installed build.
 * @param {object} evidence - Live process/window observations from verify-windows-native.ps1.
 * @param {object} bundle - Prepared release payload manifest.
 * @param {string} version - Expected installed program version.
 * @returns {object} Verified, credential-free evidence suitable for a CI artifact.
 */
export function verifyWindowsNativeEvidence(evidence, bundle, version) {
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.platform, 'win32')
  assert.equal(evidence.installedProductVersion, version, 'Installed executable version differs')
  assert.equal(bundle.buildProvenance.mode, 'release')
  assert.equal(bundle.buildProvenance.source.dirty, false)
  assert.deepEqual(bundle.buildProvenance.source.dirtyFiles, [])
  assert.equal(evidence.runs.length, 2, 'Both native launches must finish')
  const inside = (root, path) => {
    const relative = win32.relative(root, path)
    return relative !== '' && !relative.startsWith('..') && !win32.isAbsolute(relative)
  }
  const [first, second] = evidence.runs
  assert.notEqual(first.runtime.runId, second.runtime.runId, 'Relaunch must publish a new run')
  for (const run of evidence.runs) {
    const runtime = run.runtime
    assert.equal(runtime.schemaVersion, 1)
    assert.equal(runtime.status, 'ready')
    assert.equal(runtime.desktopVersion, version)
    assert.equal(runtime.desktopPid, run.desktopPid, 'Manifest belongs to another desktop')
    assert.equal(runtime.hostPid, run.hostPid, 'Manifest belongs to another Host')
    assert.equal(run.hostParentPid, run.desktopPid, 'Host must be a direct child of this desktop')
    assert.equal(run.desktopPath.toLowerCase(), win32.join(evidence.installRoot, 'dsh-desktop.exe').toLowerCase())
    assert.ok(inside(evidence.appDataRoot, runtime.harnessRoot), 'Runtime must be provisioned inside the owned data directory')
    assert.ok(runtime.observedAtUnixMs >= run.startedAtUnixMs, 'Ready manifest predates this launch')
    assert.ok(Number.isSafeInteger(run.windowHandle) && run.windowHandle !== 0, 'Native main window is absent')
    assert.equal(run.windowVisible, true)
    assert.ok(run.windowWidth >= 800 && run.windowHeight >= 600, 'Splash cannot substitute for the main window')
    assert.equal(run.httpStatus, 401, 'Installed Host must require authentication')
    assert.deepEqual(runtime.disabledPlugins, [], 'Rescue mode cannot pass acceptance')
    assert.equal(runtime.contentSha256, bundle.contentSha256, 'Running payload differs from the packaged build')
    assert.deepEqual(runtime.buildProvenance, bundle.buildProvenance)
    assert.equal(run.closeMainWindow, true, 'Normal window close was not delivered')
    assert.equal(run.desktopExited, true)
    assert.equal(run.hostExited, true, 'Normal desktop exit left its Host running')
    assert.equal(run.stopped.status, 'stopped')
    assert.equal(run.stopped.runId, runtime.runId, 'Exit must stop its own runtime record')
    assert.equal(run.settingsMarkerPreserved, true)
  }
  return evidence
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, manifest, version, output] = process.argv.slice(2)
  assert.ok(input && manifest && version && output, 'Required: <observations.json> <bundle-manifest.json> <version> <output.json>')
  const verified = verifyWindowsNativeEvidence(JSON.parse(readFileSync(input, 'utf8')), JSON.parse(readFileSync(manifest, 'utf8')), version)
  writeFileSync(output, `${JSON.stringify({ ...verified, verified: true }, null, 2)}\n`)
  console.log('Installed Windows desktop: launch, normal close and relaunch verified')
}
