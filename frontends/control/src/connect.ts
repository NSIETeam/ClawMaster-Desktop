/** Attach to the current desktop through its ordinary login and Connection RPC. */
import { createHash } from 'node:crypto';
import { createWebConnectionRpc, type ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/web-rpc';
import { ControlConnectionError, readConnectionRecord, readCurrentRuntime } from './connection-record.ts';
import type { SafeDesktopRuntime } from './connection-record.ts';

export { ControlConnectionError } from './connection-record.ts';

/** Authenticated RPC retains its cookie privately; the visible metadata has no secret. */
export interface DesktopConnection {
  record: { origin: string; hostPid: number; instanceId: string };
  runtime: SafeDesktopRuntime;
  rpc: ClientConnectionRpc;
}

/**
 * Attach to the desktop whose private record matches its current runtime authority.
 * @param home Harness home selected by the normal DSH launcher.
 * @param signal Caller-owned lifetime; omitted callers receive a ten-second request budget.
 * @returns Public identity plus an RPC caller bound to the authenticated loopback origin.
 */
export async function connectDesktop(home: string, signal?: AbortSignal): Promise<DesktopConnection> {
  signal?.throwIfAborted();
  const record = await readConnectionRecord(home);
  const runtime = await readCurrentRuntime(home, record);
  const loginSignal = signal ?? AbortSignal.timeout(10_000);
  let cookie: string;
  try {
    const response = await fetch(record.authenticatedUrl, { redirect: 'manual', signal: loginSignal });
    try {
      const cookies = response.headers.getSetCookie();
      const name = `dsh-auth-${createHash('sha256').update(new URL(record.origin).host).digest('base64url')}`;
      const pair = cookies[0]?.split(';', 1)[0];
      if (response.status !== 303 || response.headers.get('location') !== '/' || cookies.length !== 1
        || !pair || !pair.startsWith(`${name}=`) || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pair.slice(name.length + 1))) {
        throw new ControlConnectionError('authentication-failed');
      }
      cookie = pair;
    } finally { await response.body?.cancel(); }
  } catch { throw new ControlConnectionError('authentication-failed'); }
  const assertCurrent = async (): Promise<void> => {
    const latest = await readConnectionRecord(home);
    if (latest.instanceId !== record.instanceId) throw new ControlConnectionError('stale-runtime');
    await readCurrentRuntime(home, record);
  };
  await assertCurrent();
  const rpc = createWebConnectionRpc(async (input, init) => {
    await assertCurrent();
    if (!input.pathname.startsWith('/api/') || input.search !== '' || input.hash !== '' || init.method !== 'POST') {
      throw new ControlConnectionError('transport-failed');
    }
    const requestSignal = init.signal ?? signal ?? AbortSignal.timeout(10_000);
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    try {
      return await fetch(new URL(input.pathname, record.origin), { ...init, headers, redirect: 'manual', signal: requestSignal });
    } catch { throw new ControlConnectionError('transport-failed'); }
  });
  return { record: { origin: record.origin, hostPid: record.hostPid, instanceId: record.instanceId }, runtime, rpc };
}
