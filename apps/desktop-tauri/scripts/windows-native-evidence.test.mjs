import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyWindowsNativeEvidence } from './windows-native-evidence.mjs'

function fixture() {
  const bundle = { contentSha256: 'a'.repeat(64), buildProvenance: {
    mode: 'release', source: { dirty: false, dirtyFiles: [], gitCommit: 'b'.repeat(40) },
  } }
  const run = (pid, stamp) => ({
    desktopPid: pid, hostPid: pid + 1, hostParentPid: pid,
    desktopPath: 'C:\\CI\\install\\dsh-desktop.exe', startedAtUnixMs: stamp,
    windowHandle: 501, windowVisible: true, windowWidth: 1280, windowHeight: 860,
    httpStatus: 401, closeMainWindow: true, desktopExited: true, hostExited: true,
    settingsMarkerPreserved: true, stopped: { status: 'stopped', runId: `${pid}-${stamp}` },
    runtime: { schemaVersion: 1, status: 'ready', runId: `${pid}-${stamp}`, desktopVersion: '0.2.0',
      desktopPid: pid, hostPid: pid + 1, observedAtUnixMs: stamp + 1,
      harnessRoot: 'C:\\CI\\appdata\\runtime\\harness-abc', disabledPlugins: [], ...bundle },
  })
  return { bundle, evidence: { schemaVersion: 1, platform: 'win32', installedProductVersion: '0.2.0',
    installRoot: 'C:\\CI\\install', appDataRoot: 'C:\\CI\\appdata', runs: [run(100, 10), run(200, 30)] } }
}

test('two installed native launches retain the source build and close their owned Hosts', () => {
  const { evidence, bundle } = fixture()
  assert.equal(verifyWindowsNativeEvidence(evidence, bundle, '0.2.0'), evidence)
})

test('stale, foreign and abandoned processes cannot satisfy native acceptance', () => {
  for (const mutate of [
    e => { e.runs[1].runtime.runId = e.runs[0].runtime.runId },
    e => { e.runs[0].runtime.desktopPid++ },
    e => { e.runs[0].hostParentPid++ },
    e => { e.runs[0].runtime.observedAtUnixMs = 1 },
    e => { e.runs[0].desktopPath = 'C:\\other\\dsh-desktop.exe' },
    e => { e.runs[0].runtime.harnessRoot = 'C:\\CI\\appdata-neighbour\\harness' },
    e => { e.runs[0].hostExited = false },
    e => { e.runs[0].stopped.runId = 'other' },
    e => { e.runs[0].closeMainWindow = false },
  ]) {
    const { evidence, bundle } = fixture()
    mutate(evidence)
    assert.throws(() => verifyWindowsNativeEvidence(evidence, bundle, '0.2.0'))
  }
})

test('a splash, unprotected Host, rescue boot or different build cannot pass', () => {
  for (const mutate of [
    e => { e.runs[0].windowHandle = 0 },
    e => { e.runs[0].windowWidth = 520 },
    e => { e.runs[0].windowVisible = false },
    e => { e.runs[0].httpStatus = 200 },
    e => { e.runs[0].runtime.disabledPlugins = ['failed-plugin'] },
    e => { e.runs[0].runtime.contentSha256 = 'c'.repeat(64) },
    e => { e.runs[0].runtime.buildProvenance = { mode: 'development' } },
    e => { e.installedProductVersion = '0.2.0-beta.6' },
    e => { e.runs[0].settingsMarkerPreserved = false },
  ]) {
    const { evidence, bundle } = fixture()
    mutate(evidence)
    assert.throws(() => verifyWindowsNativeEvidence(evidence, bundle, '0.2.0'))
  }
})
