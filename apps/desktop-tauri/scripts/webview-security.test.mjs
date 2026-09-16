import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const native = new URL('../src-tauri/', import.meta.url)

/** Reject accidentally reintroduced remote or window-wide native grants. */
function assertShellCapabilities(capabilities) {
  for (const capability of capabilities) {
    assert.equal(capability.remote, undefined, 'Remote web content cannot hold native permissions')
    assert.equal(capability.windows, undefined, 'Window grants also match child WebViews')
    assert.deepEqual(capability.webviews, ['splash', 'main'])
    assert.deepEqual(capability.permissions, [
      'core:window:allow-start-dragging', 'allow-set-close-action', 'allow-dismiss-close-prompt', 'allow-restart-app',
    ])
  }
  assert.equal(capabilities.length, 1)
}

test('only the packaged shell owns native controls and application commands', () => {
  const directory = new URL('capabilities/', native)
  const capabilities = readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(new URL(name, directory), 'utf8')))
  assertShellCapabilities(capabilities)
  assert.throws(() => assertShellCapabilities([{ ...capabilities[0], windows: ['main'] }]), /Window grants/)
  assert.throws(() => assertShellCapabilities([{ ...capabilities[0], remote: { urls: ['http://127.0.0.1:*'] } }]), /Remote web content/)
  assert.throws(() => assertShellCapabilities([{ ...capabilities[0], permissions: [...capabilities[0].permissions, 'core:webview:allow-create-webview-window'] }]))
  const build = readFileSync(new URL('build.rs', native), 'utf8')
  for (const command of ['set_close_action', 'dismiss_close_prompt', 'restart_app']) assert.ok(build.includes(`"${command}"`))
  assert.match(build, /AppManifest::new\(\)\.commands/)
})

test('packaged pages limit scripts, network, frames and navigation without broad origins', () => {
  const csp = JSON.parse(readFileSync(new URL('tauri.conf.json', native), 'utf8')).app.security.csp
  assert.equal(csp['default-src'], "'none'")
  assert.equal(csp['script-src'], "'self'")
  assert.equal(csp['connect-src'], 'ipc: http://ipc.localhost')
  for (const name of ['object-src', 'frame-src', 'base-uri', 'form-action']) assert.equal(csp[name], "'none'")
  assert.ok(!Object.values(csp).some(value => value.includes('*') || value.includes('unsafe-eval')))
})
