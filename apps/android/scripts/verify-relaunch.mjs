/** Verify the native home screen after force-stop and an ordinary launcher restart. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const xml = readFileSync(process.argv[2], 'utf8')
assert.ok(xml.includes('package="team.nsi.clawmaster.android"'), 'Expected the installed Android app')
assert.ok(xml.includes('resource-id="team.nsi.clawmaster.android:id/tab_chat"'), 'Native chat navigation did not return')
assert.ok(xml.includes('resource-id="team.nsi.clawmaster.android:id/tab_notes"'), 'Native notes navigation did not return')
assert.ok(xml.includes('resource-id="team.nsi.clawmaster.android:id/tab_settings"'), 'Native settings navigation did not return')
console.log('Standalone Android ordinary relaunch passed')
