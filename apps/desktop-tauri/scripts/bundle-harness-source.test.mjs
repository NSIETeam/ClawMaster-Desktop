import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { assertDesktopLockfile, assertPreparedBundle, copyTree, stripDevDependencies, buildTrimmedWorkspaceYaml, DESKTOP_PATCHED_DEPENDENCIES, hashBundledContent, withDesktopDependencies, desktopWorkspaceOverrides } from './bundle-harness-source.mjs'
import { DESKTOP_BUNDLES, DESKTOP_PLUGIN_VERSIONS, withDesktopBundles } from './desktop-defaults.mjs'

test('workspace trimming preserves the immutable Office source manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-manifest-trim-'))
  try {
    const files = ['frontends/office/package.json', 'frontends/office/runtime/source/package.json', 'packages/core/session/package.json']
    const content = JSON.stringify({ name: 'fixture', devDependencies: { compiler: '1.0.0' } })
    for (const file of files) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), content)
    }
    stripDevDependencies(root)
    assert.equal(readFileSync(join(root, files[1]), 'utf8'), content)
    for (const file of [files[0], files[2]]) assert.equal(JSON.parse(readFileSync(join(root, file), 'utf8')).devDependencies, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('package-group dependency directories never enter a distributable tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-copy-filter-'))
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    mkdirSync(join(source, 'node_modules', 'dependency'), { recursive: true })
    writeFileSync(join(source, 'node_modules', 'dependency', 'index.js'), 'development dependency')
    writeFileSync(join(source, 'index.js'), 'product')
    copyTree(source, target)
    copyTree(join(source, 'node_modules'), join(target, 'node_modules'))
    assert.equal(existsSync(join(target, 'index.js')), true)
    assert.equal(existsSync(join(target, 'node_modules')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('installer packaging rejects stale bytes and injected dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-payload-verify-'))
  try {
    writeFileSync(join(root, 'index.js'), 'product')
    const buildProvenance = { schemaVersion: 1, mode: 'development', buildId: 'development-fixture', source: { dirty: true } }
    writeFileSync(join(root, '.build-provenance.json'), JSON.stringify(buildProvenance))
    const manifest = () => writeFileSync(join(root, '.bundle-manifest.json'), JSON.stringify({ contentSha256: hashBundledContent(root), buildProvenance }))
    manifest()
    assert.doesNotThrow(() => assertPreparedBundle(root, 'development'))
    assert.throws(() => assertPreparedBundle(root, 'release'), /clean release build/)
    writeFileSync(join(root, '.bundle-manifest.json'), JSON.stringify({ contentSha256: hashBundledContent(root), buildProvenance: { ...buildProvenance, buildId: 'another-source' } }))
    assert.throws(() => assertPreparedBundle(root, 'development'), /provenance differs/)
    manifest()
    writeFileSync(join(root, 'index.js'), 'changed after preparation')
    assert.throws(() => assertPreparedBundle(root, 'development'), /digest does not match/)
    manifest()
    mkdirSync(join(root, 'node_modules'))
    assert.throws(() => assertPreparedBundle(root, 'development'), /excluded directory/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('buildTrimmedWorkspaceYaml keeps upstream patch and build declarations verbatim', () => {
  const source = `packages:
  - vendor/*
  - packages/*/*
  - apps/*
  - examples
  - python/sdk-runtime

linkWorkspacePackages: true

overrides:
  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'

allowBuilds:
  esbuild: true
  node-pty: true

patchedDependencies:
  node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch
`
  const trimmed = buildTrimmedWorkspaceYaml(source)

  assert.match(trimmed, /^packages:\n(?:  - .*\n)+/)
  for (const name of ['vendor/*', 'packages/*/*', 'native/system', 'native/system/packages/*', 'apps/cli', 'apps/web', 'apps/desktop-defaults', 'frontends/dsh', 'frontends/guard', 'frontends/notes', 'frontends/office']) {
    assert.ok(trimmed.includes(`  - ${name}\n`), `trimmed packages must include ${name}`)
  }
  assert.ok(!trimmed.includes('apps/*'))
  assert.ok(!trimmed.includes('native/landlock-run'))
  assert.ok(!trimmed.includes('examples'))

  assert.ok(
    trimmed.includes('  node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch\n'),
    'patchedDependencies must be copied from the source workspace, not hardcoded',
  )
  assert.ok(trimmed.includes('allowBuilds:\n  esbuild: true\n  node-pty: true\n'))
  assert.ok(trimmed.includes('linkWorkspacePackages: true\n'))
  assert.ok(trimmed.includes('allowUnusedPatches: true\n'))
  assert.ok(trimmed.includes("  - '@xmanrui/dsh-im@4.20.0'\n"))
  assert.ok(trimmed.includes("  - 'dsh-better-sidebar@0.19.1'\n"))
})

test('buildTrimmedWorkspaceYaml preserves comments after the packages block', () => {
  const source = `# workspace header
packages:
  - apps/*

# Why linkWorkspacePackages is on.
linkWorkspacePackages: true
`
  const trimmed = buildTrimmedWorkspaceYaml(source)

  assert.ok(trimmed.startsWith('# workspace header\n'))
  assert.ok(trimmed.includes('# Why linkWorkspacePackages is on.\n'))
})

test('buildTrimmedWorkspaceYaml rejects a workspace without a packages block', () => {
  assert.throws(() => buildTrimmedWorkspaceYaml('linkWorkspacePackages: true\n'), /packages/)
})

test('desktop release exceptions extend the existing supply-chain policy', () => {
  const trimmed = buildTrimmedWorkspaceYaml("packages:\n  - apps/*\n\nminimumReleaseAgeExclude:\n  - kept@1.0.0\n")
  assert.equal(trimmed.match(/^minimumReleaseAgeExclude:/gm).length, 1)
  assert.ok(trimmed.includes('  - kept@1.0.0\n'))
  assert.ok(trimmed.includes("  - '@xmanrui/dsh-im@4.20.0'\n"))
})

test('desktop dependencies resolve the built frontend and exact reviewed plugin releases', () => {
  const source = { name: '@deepseek-ai/dsh', dependencies: { kept: 'workspace:^' } }
  const bundled = withDesktopDependencies(source)
  assert.deepEqual(bundled.dependencies, {
    kept: 'workspace:^', ...DESKTOP_PLUGIN_VERSIONS,
    '@clawmaster/dsh-desktop-policy': 'workspace:*',
    '@clawmaster/dsh-frontend': 'workspace:*',
    '@clawmaster/dsh-guard': 'workspace:*',
    '@clawmaster/dsh-notes': 'workspace:*',
    '@clawmaster/dsh-office': 'workspace:*',
    '@clawmaster/dsh-rpa': 'workspace:*',
  })
  assert.deepEqual(source.dependencies, { kept: 'workspace:^' })
})

test('desktop profile preserves installed layers and user policy across repeated boots', () => {
  const source = {
    dependencies: { custom: '1.0.0' },
    dsh: { profile: { patchReload: 'startup', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'custom', '@xmanrui/dsh-im'] } },
  }
  const result = withDesktopBundles(source)
  assert.deepEqual(result.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'custom', '@xmanrui/dsh-im',
    ...DESKTOP_BUNDLES.filter(name => name !== '@xmanrui/dsh-im'),
  ])
  assert.deepEqual(result.dependencies, source.dependencies)
  assert.equal(result.dsh.profile.patchReload, 'startup')
  assert.deepEqual(withDesktopBundles(result), result)
  assert.equal(source.dsh.profile.bundles.length, 4)
})

test('desktop profile rejects malformed or incompatible profiles', () => {
  assert.throws(() => withDesktopBundles({}), /dsh.profile.bundles/)
  assert.throws(() => withDesktopBundles({ dsh: { profile: { bundles: [1] } } }), /package names/)
  assert.throws(() => withDesktopBundles({ dsh: { profile: { bundles: ['custom'] } } }), /dsh-web-app/)
})

test('bundle generation changes for frontend, default versions, and preload bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-payload-hash-'))
  try {
    mkdirSync(join(root, 'frontends/dsh/dist'), { recursive: true })
    writeFileSync(join(root, 'frontends/dsh/dist/client.js'), 'export const version = 1\n')
    writeFileSync(join(root, 'desktop-defaults.mjs'), 'export const version = 1\n')
    const before = hashBundledContent(root)
    writeFileSync(join(root, 'frontends/dsh/dist/client.js'), 'export const version = 2\n')
    const client = hashBundledContent(root)
    assert.notEqual(client, before)
    writeFileSync(join(root, 'desktop-defaults.mjs'), 'export const version = 2\n')
    const preload = hashBundledContent(root)
    assert.notEqual(preload, client)
    writeFileSync(join(root, '.bundle-manifest.json'), '{}\n')
    assert.equal(hashBundledContent(root), preload)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('desktop patches, runtime extensions and DSH workspace overrides stay installation-local', () => {
  const source = 'packages:\n  - apps/*\noverrides:\n  kept: 1.0.0\n';
  const trimmed = buildTrimmedWorkspaceYaml(source, { '@deepseek-ai/dsh-session': 'link:packages/core/session' });
  assert.ok(trimmed.includes('"@deepseek-ai/dsh-session": "link:packages/core/session"'));
  assert.ok(trimmed.includes('  kept: 1.0.0\n'));
  assert.ok(trimmed.includes('"@xmanrui/dsh-im@4.20.0": "desktop-patches/@xmanrui__dsh-im@4.20.0.patch"'));
  assert.ok(trimmed.includes('"dsh-better-sidebar@0.19.1": "desktop-patches/dsh-better-sidebar@0.19.1.patch"'));
  assert.ok(trimmed.includes('"@openviking/dsh-memory-plugin@0.3.0": "desktop-patches/@openviking__dsh-memory-plugin@0.3.0.patch"'));
  assert.ok(trimmed.includes('"dsh-routing-suite@0.1.2": "desktop-patches/dsh-routing-suite@0.1.2.patch"'));
  assert.ok(trimmed.includes('"dependencies":{"zod":"4.4.3"}'));
  assert.equal(trimmed.includes('legacy-peer-deps'), false);
  assert.equal(source.includes('patchedDependencies'), false);
});

test('DSH peer overrides resolve to the exact packaged workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-peer-policy-'));
  try {
    mkdirSync(join(root, 'packages/core/session'), { recursive: true });
    writeFileSync(join(root, 'packages/core/session/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.5-rc.2' }));
    assert.deepEqual(desktopWorkspaceOverrides(root), { '@deepseek-ai/dsh-session': 'link:packages/core/session' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('desktop lock validation rejects drifted releases, patches and nested DSH copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-lock-validation-'));
  try {
    const patches = Object.fromEntries(Object.entries(DESKTOP_PATCHED_DEPENDENCIES).map(([name, path]) => {
      const bytes = `fixture patch for ${name}\n`;
      writeFileSync(join(root, path.slice('desktop-patches/'.length)), bytes);
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }));
    const lock = {
      importers: { 'apps/cli': { dependencies: Object.fromEntries(Object.entries(DESKTOP_PLUGIN_VERSIONS).map(([name, specifier]) => [name, { specifier }])) } },
      patchedDependencies: patches, packages: {},
    };
    assert.doesNotThrow(() => assertDesktopLockfile(JSON.stringify(lock), root));
    const oldVersion = structuredClone(lock);
    oldVersion.importers['apps/cli'].dependencies['@nanmicoder/dsh-agent-teams'].specifier = '0.1.16';
    assert.throws(() => assertDesktopLockfile(JSON.stringify(oldVersion), root), /must pin/);
    for (const [name, version] of Object.entries(DESKTOP_PLUGIN_VERSIONS)) {
      const upgraded = structuredClone(lock);
      const [major, minor, patch] = version.split('.').map(Number);
      upgraded.importers['apps/cli'].dependencies[name].specifier = `${major}.${minor}.${patch + 1}`;
      assert.throws(() => assertDesktopLockfile(JSON.stringify(upgraded), root), /must pin/, `${name} upgrade requires review`);
    }
    for (const name of Object.keys(DESKTOP_PATCHED_DEPENDENCIES)) {
      const oldPatch = structuredClone(lock);
      oldPatch.patchedDependencies[name] = 'stale';
      assert.throws(() => assertDesktopLockfile(JSON.stringify(oldPatch), root), /stale compatibility patch/);
    }
    assert.throws(() => assertDesktopLockfile(JSON.stringify({ ...lock, packages: { '@deepseek-ai/dsh-session@0.1.5-rc.1': {} } }), root), /not registry copies/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
