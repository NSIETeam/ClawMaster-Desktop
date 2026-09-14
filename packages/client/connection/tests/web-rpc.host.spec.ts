/** The public HTTP caller runs in Node without mounting browser services. */
import { describe, expect, it } from 'vitest'
import { createWebConnectionRpc, type RpcFetch } from '../src/web-rpc.ts'

describe('Node unary RPC entry', () => {
  it('keeps envelope correlation while the injected transport owns origin and authentication', async () => {
    const calls: { url: URL; init: RequestInit }[] = []
    const send: RpcFetch = async (url, init) => {
      calls.push({ url, init })
      const request = JSON.parse(init.body as string) as { rpcId: string; method: string; payload: unknown }
      expect(request.method).toBe('session/list')
      expect(request.payload).toEqual({ args: { _request: {} } })
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } })
    }
    const rpc = createWebConnectionRpc(send)
    const signal = new AbortController().signal
    await expect(rpc.call('/api', 'session/list', { args: { _request: {} } }, signal))
      .resolves.toEqual({ ok: true, value: { items: [] } })
    expect(calls[0]?.url.pathname).toBe('/api/session/list')
    expect(calls[0]?.init.signal).toBe(signal)
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(typeof globalThis.window).toBe('undefined')
  })

  it('refuses an unrelated response identity', async () => {
    const rpc = createWebConnectionRpc(async () => Response.json({
      type: 'server-response', rpcId: 'unrelated', result: { ok: true, value: {} },
    }))
    await expect(rpc.call('/api', 'session/list', { args: { _request: {} } })).rejects.toThrow('rpcId mismatch')
  })

  it('reports HTTP failure without reading or exposing its body', async () => {
    const rpc = createWebConnectionRpc(async () => new Response('token=private-fixture', { status: 401 }))
    await expect(rpc.call('/api', 'session/list', { args: { _request: {} } }))
      .rejects.toThrow('transport failure for /api/session/list: HTTP 401')
  })

  it('forwards cancellation to the in-flight transport without retrying', async () => {
    const started = Promise.withResolvers<boolean>()
    let calls = 0
    const rpc = createWebConnectionRpc(async (_url, init) => {
      calls += 1
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason
          reject(reason instanceof Error ? reason : new Error('cancelled fixture'))
        }, { once: true })
        started.resolve(true)
      })
    })
    const abort = new AbortController()
    const pending = rpc.call('/api', 'session/cancel', { args: { request: { sessionId: 'fixture' } } }, abort.signal)
    await started.promise
    abort.abort(new Error('cancelled fixture'))
    await expect(pending).rejects.toThrow('cancelled fixture')
    expect(calls).toBe(1)
  })
})
