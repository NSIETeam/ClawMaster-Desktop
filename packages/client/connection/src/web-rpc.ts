/** Unary HTTP RPC for browser and Node consumers; the caller owns origin selection and authentication. */

export { createWebConnectionRpc } from './client/rpc.ts'
export type { RpcFetch, RpcStreamOpen } from './client/rpc.ts'
export type { ClientConnectionRpc, ConnectionRpcResult, ConnectionRpcFailure } from './rpc.ts'
