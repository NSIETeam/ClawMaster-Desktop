const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

assert.equal(process.version, 'v22.19.0')
assert.equal(process.arch, 'x64')

const child = spawnSync(process.execPath, ['-p', 'process.version'], { encoding: 'utf8' })
assert.equal(child.status, 0, `Node child failed through process.execPath=${process.execPath}: ${child.error ?? child.stderr}`)
assert.equal(child.stdout.trim(), process.version)

console.log(JSON.stringify({ version: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath, childNode: child.stdout.trim() }))
