/** Isolated profile provisioning through the shipped app-boot artifact. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { CONTROL_BUNDLE, DESKTOP_BUNDLES, DESKTOP_PLUGIN_VERSIONS, prepareControlProfile, prepareDesktopProfile } from './desktop-defaults.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(repository, 'apps/cli/package.json'))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clawmaster defaults 空 #%-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
  const cli = join(root, 'apps/cli')
  const modules = join(cli, 'node_modules')
  const home = join(root, 'home')
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  writeFileSync(join(cli, 'package.json'), '{"type":"module"}\n')
  symlinkSync(dirname(dirname(require.resolve('@deepseek-ai/dsh-app-boot'))), join(modules, '@deepseek-ai/dsh-app-boot'), 'junction')
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const path = join(modules, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), name === '@deepseek-ai/dsh-base'
      ? '- insert:\n    - id: system-prompt\n      name: "@deepseek-ai/dsh-system-prompt"\n'
      : '[]\n')
  }
  for (const name of [...DESKTOP_BUNDLES, CONTROL_BUNDLE]) {
    const path = join(modules, name)
    mkdirSync(path, { recursive: true })
    const hostOnly = name === '@openviking/dsh-memory-plugin' || name === CONTROL_BUNDLE
    const policy = name === '@clawmaster/dsh-desktop-policy'
    writeFileSync(join(path, 'package.json'), JSON.stringify({
      name, type: 'module', version: DESKTOP_PLUGIN_VERSIONS[name] ?? '0.3.1',
      exports: policy ? undefined : hostOnly ? { '.': './index.js' } : { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' },
        ...(!hostOnly && !policy ? { client: { platform: 'web' } } : {}),
        ...(name === 'dsh-routing-suite' ? { desktop: { presets: [{ id: 'routing-suite', path: './preset/routing-suite' }] } } : {}),
      },
    }))
    writeFileSync(join(path, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(path, 'index.js'), 'export const name = "fixture"\n')
    writeFileSync(join(path, 'client.js'), 'export const name = "fixture-client"\n')
    if (name === CONTROL_BUNDLE) {
      mkdirSync(join(path, 'dist'))
      writeFileSync(join(path, 'dist/cli.js'), 'export const name = "control-cli-fixture"\n')
      writeFileSync(join(path, 'dist/host.js'), 'export const name = "control-host-fixture"\n')
    }
    if (name === '@openviking/dsh-memory-plugin') writeFileSync(join(path, 'cordis.patch.yml'), '- insert:\n    - id: openviking-memory\n      name: cordis:group\n      group: true\n      config:\n        - id: openviking-memory-runtime\n          name: "@openviking/dsh-memory-plugin"\n')
    if (name === '@xmanrui/dsh-im') writeFileSync(join(path, 'cordis.patch.yml'), '- insert:\n    - id: xmanrui-dsh-im\n      name: "@xmanrui/dsh-im"\n')
    if (policy) cpSync(fileURLToPath(new URL('../defaults/cordis.patch.yml', import.meta.url)), join(path, 'cordis.patch.yml'))
    if (name === 'dsh-routing-suite') {
      mkdirSync(join(path, 'preset/routing-suite'), { recursive: true })
      writeFileSync(join(path, 'preset/routing-suite/preset.yml'), 'name: Routing fixture\n')
      writeFileSync(join(path, 'preset/routing-suite/agent.cordis.yml'), '[]\n')
    }
  }
  return { root, cli, modules, home, profile: join(home, 'profiles/web') }
}

test('fresh home gets every desktop bundle through the DSH profile format', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const manifest = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...DESKTOP_BUNDLES])
  assert.deepEqual(manifest.dependencies, {})
  const patch = readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')
  const edited = { ...manifest, dependencies: { custom: '1.2.3' } }
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify(edited))
  await prepareDesktopProfile(f.root, f.home)
  assert.deepEqual(JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')), edited)
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
})

test('IM channel defaults resolve under the selected home and preserve user overrides without selecting a Workspace', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const workspace = join(f.home, 'watchdog-workspaces', 'im')
  assert.equal(lstatSync(workspace).isDirectory(), true)
  if (process.platform !== 'win32') assert.equal(lstatSync(workspace).mode & 0o777, 0o700)
  writeFileSync(join(workspace, 'existing.txt'), 'preserved\n')
  const evaluate = () => {
    const script = `
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(${JSON.stringify(join(repository, 'apps/cli/package.json'))});
      const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      const { applyEntryPatches } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
      const { interpolate } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href);
      const { dshHomePath } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href);
      const profile = boot.loadProfile('ClawMaster', 'web', ${JSON.stringify(join(f.cli, 'package.json'))}, process.env.DSH_HOME);
      const entries = [...profile.layers.map(layer => layer.patches), profile.patches]
        .reduce((entries, patches) => applyEntryPatches(entries, patches, (message, ...args) => { throw new Error([message, ...args].join(" ")) }), []);
      const config = entries.find(entry => entry.id === 'xmanrui-dsh-im').config;
      process.stdout.write(JSON.stringify(interpolate({ dshHomePath }, config)));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: f.root, env: { ...process.env, DSH_HOME: f.home }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    })
    assert.equal(child.error, undefined)
    assert.equal(child.signal, null)
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  }
  const defaults = evaluate()
  for (const channel of ['weixin', 'feishu', 'dingtalk', 'wecom']) assert.equal(defaults[channel].workspace, workspace)
  assert.equal(defaults.workspace, undefined)
  const custom = join(f.home, 'custom-weixin')
  const patch = `- id: xmanrui-dsh-im\n  config:\n    weixin:\n      workspace: ${JSON.stringify(custom)}\n`
  writeFileSync(join(f.profile, 'cordis.patch.yml'), patch)
  await prepareDesktopProfile(f.root, f.home)
  const overridden = evaluate()
  assert.deepEqual(overridden, { weixin: { workspace: custom } })
  assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), 'preserved\n')
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(existsSync(custom), false)
  assert.equal(existsSync(join(f.home, 'storages', 'workspace.json')), false)
})

test('IM directory provisioning rejects a link and preserves its target', async t => {
  const f = fixture(t)
  const outside = join(f.root, 'user-directory')
  const managed = join(f.home, 'watchdog-workspaces')
  mkdirSync(outside)
  writeFileSync(join(outside, 'kept.txt'), 'user data\n')
  mkdirSync(managed, { recursive: true })
  symlinkSync(outside, join(managed, 'im'), 'junction')
  await assert.rejects(prepareDesktopProfile(f.root, f.home), /Desktop IM workspace is not a directory/)
  assert.equal(lstatSync(join(managed, 'im')).isSymbolicLink(), true)
  assert.equal(readFileSync(join(outside, 'kept.txt'), 'utf8'), 'user data\n')
})

test('missing or different bundled releases reject before touching the home', async t => {
  const f = fixture(t)
  const manifestPath = join(f.modules, '@xmanrui/dsh-im/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '4.19.0' }))
  await assert.rejects(prepareDesktopProfile(f.root, f.home), /requires @xmanrui\/dsh-im@4.20.0/)
  assert.equal(existsSync(f.home), false)
  rmSync(manifestPath)
  await assert.rejects(prepareDesktopProfile(f.root, f.home), /cannot resolve profile bundle/)
  assert.equal(existsSync(f.home), false)
})

test('host-only OpenViking remains visible but disabled until a user patch enables it', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { applyEntryPatches } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href)
  const composition = () => {
    const profile = boot.loadProfile('ClawMaster', 'web', join(f.cli, 'package.json'), f.home)
    return [...profile.layers.map(layer => layer.patches), profile.patches]
      .reduce((entries, patches) => applyEntryPatches(entries, patches, (message, ...args) => { throw new Error([message, ...args].join(" ")) }), [])
  }
  const runtime = () => composition().find(entry => entry.id === 'openviking-memory').config[0]
  assert.equal(runtime().name, '@openviking/dsh-memory-plugin')
  assert.equal(runtime().disabled, true)
  const patch = '- id: openviking-memory-runtime\n  disabled: false\n  config:\n    endpoint: http://localhost:1933\n'
  writeFileSync(join(f.profile, 'cordis.patch.yml'), patch)
  await prepareDesktopProfile(f.root, f.home)
  assert.equal(runtime().disabled, false)
  assert.equal(runtime().config.endpoint, 'http://localhost:1933')
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
})

test('routing preset provisioning fills missing files and preserves user edits', async t => {
  const f = fixture(t)
  await prepareDesktopProfile(f.root, f.home)
  const preset = join(f.home, '.agent-presets/routing-suite')
  assert.equal(readFileSync(join(preset, 'preset.yml'), 'utf8'), 'name: Routing fixture\n')
  writeFileSync(join(preset, 'preset.yml'), 'name: User routing\n')
  rmSync(join(preset, 'agent.cordis.yml'))
  await prepareDesktopProfile(f.root, f.home)
  assert.equal(readFileSync(join(preset, 'preset.yml'), 'utf8'), 'name: User routing\n')
  assert.equal(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8'), '[]\n')
})

test('Node preload prepares the profile once and consumes its inherited activation flag', t => {
  const f = fixture(t)
  const preload = join(f.root, 'desktop-defaults.mjs')
  cpSync(fileURLToPath(new URL('./desktop-defaults.mjs', import.meta.url)), preload)
  mkdirSync(join(f.cli, 'lib'))
  const entry = join(f.cli, 'lib/bin.js')
  writeFileSync(entry, 'if (process.env.DSH_DESKTOP_DEFAULTS !== undefined) throw new Error("activation flag leaked")\n')
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, entry], {
    env: { ...process.env, DSH_HOME: f.home, DSH_DESKTOP_DEFAULTS: '1' },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(f.profile, 'package.json')), true)
})

test('control profile contains only its client and leaves the Web profile absent', async t => {
  const f = fixture(t)
  await prepareControlProfile(f.root, f.home)
  assert.equal(existsSync(f.profile), false)
  const dir = join(f.home, 'profiles/clawmaster-control')
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(manifest.dsh.profile, { bundles: [CONTROL_BUNDLE], patchReload: 'startup' })
  writeFileSync(join(dir, 'cordis.patch.yml'), '# User patch\n[]\n')
  await prepareControlProfile(f.root, f.home)
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), '# User patch\n[]\n')
  manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-base')
  writeFileSync(file, JSON.stringify(manifest))
  await assert.rejects(prepareControlProfile(f.root, f.home), /only the command client/)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), manifest)
})

test('missing control artifacts reject desktop preparation before Web configuration is changed', async t => {
  const f = fixture(t)
  rmSync(join(f.modules, CONTROL_BUNDLE, 'dist/cli.js'))
  await assert.rejects(prepareDesktopProfile(f.root, f.home), /ENOENT/)
  assert.equal(existsSync(f.home), false)
})
