/** Bind a CI validation APK to source bytes; its disposable signer is not a release key. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const apk = process.argv[2]
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('APK source is not clean')
const record = {
  schemaVersion: 1,
  product: 'ClawMaster standalone Android',
  version: '0.2.2',
  versionCode: 202,
  gitCommit: git('rev-parse', 'HEAD'),
  gitTree: git('rev-parse', 'HEAD^{tree}'),
  sha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
  signingPurpose: 'disposable-ci-validation-only',
}
writeFileSync(apk + '.build.json', JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record))
