/** Finite desktop-owned maintenance; it never starts a DSH application or a package manager. */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { maintainRestartComponents } from './components.ts'

const { values } = parseArgs({ options: { 'dsh-home': { type: 'string' } } })
if (!values['dsh-home']) throw new Error('Component maintenance requires the desktop-selected --dsh-home')
const result = await maintainRestartComponents(resolve(values['dsh-home']))
process.stdout.write(`${JSON.stringify(result)}\n`)
