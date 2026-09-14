/** Publish the desktop Host's existing login exchange for an owner-local CLI. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { publishConnectionRecord } from './connection-record.ts';

export const name = 'clawmaster-control-host';
export const inject = ['connection', 'webServer'];

/**
 * Publish after injected services activate; teardown removes only this instance.
 * Ordinary Web profiles without desktop identity do not publish a capability.
 * @param ctx Existing Web Host services and the owning plugin lifetime.
 */
export async function apply(ctx: Context): Promise<void> {
  const runId = process.env.CLAWMASTER_RUNTIME_RUN_ID;
  const statePath = process.env.CLAWMASTER_RUNTIME_STATE;
  if (runId === undefined && statePath === undefined) return;
  const home = resolveDshHome();
  if (!runId || statePath !== join(home, 'desktop', 'current-runtime.json')) {
    throw new Error('ClawMaster control requires the desktop runtime identity for its Harness home.');
  }
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('ClawMaster control requires a loopback Web Host.');
  const origin = new URL(`http://127.0.0.1:${ctx.webServer.port}`).origin;
  await ctx.effect(() => publishConnectionRecord(home, {
    schemaVersion: 1, instanceId: randomUUID(), hostPid: process.pid, runId, origin,
    authenticatedUrl: ctx.connection.authenticatedUrl(origin),
  }), 'clawmaster: private CLI login capability');
}
