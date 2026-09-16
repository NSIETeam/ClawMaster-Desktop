/** DSH Host-only update discovery and user-approved preparation; every registration is an owned effect. */
import type { Context } from '@deepseek-ai/cordis'
import type CommandRuntime from '@deepseek-ai/dsh-commands'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type ApprovalService from '@deepseek-ai/dsh-user-approval'
import { z } from 'zod'
import { resolveConfig, type UpdatesConfig } from './config.ts'
import { UpdatesService, type UpdatesDependencies, type UpdatesStatus } from './service.ts'
import { confirmComponentHealth } from './components.ts'

export { Config, resolveConfig } from './config.ts'
export type { UpdatesConfig, ResolvedUpdatesConfig } from './config.ts'

/** Stable DSH Loader plugin identity. */
export const name = 'clawmaster-updates'
/** Missing approval service prevents the updater from loading. */
export const inject = ['commands', 'tools', 'approval']

/** Public DSH services consumed by the Host plugin. */
export interface UpdatesHostContext {
  commands: Pick<CommandRuntime, 'register'>
  tools: Pick<ToolRuntime, 'register'>
  approval: Pick<ApprovalService, 'request'>
  effect: Context['effect']
  logger?: { warn(message: string): void }
}

const querySchema = z.strictObject({ refresh: z.boolean().default(true) })
const copy = {
  'zh-CN': {
    check: '检查 ClawMaster 更新', change: '准备 ClawMaster 更新',
    checkDescription: '只读检查服务器更新和当前运行版本。不会下载更新包或更改配置。',
    changeDescription: '准备已签名目录中的指定版本，写入前须获得一次用户批准。热更新组件等待 Loader 激活；更新器由支持维护的桌面在下次启动前应用，并等待实际加载确认。运行时与桌面安装包只下载验签。',
    rollback: '恢复上一版更新器', rollbackDescription: '恢复指定更新操作之前的更新器版本，需要一次用户批准；下次启动前应用，不回退业务数据库。',
    commandInput: '/updates 只接受无参数的只读检查。', unavailable: '不可用', unknown: '未确认',
    runtime: '当前 DSH', desktop: '当前桌面', components: '组件与运行时目录', native: '桌面安装包',
    compatible: '兼容', incompatible: '与当前 DSH 不兼容', pending: '需要后续原生安装',
    empty: '暂无组件版本', guidance: '需要准备某个版本时，告诉 ClawMaster 要更新的组件和版本；写入前会请求确认。',
    owner: '更新写入必须在 DSH agent 会话中发起。', closed: '更新插件已卸载。', polling: '更新服务器检查未完成；可稍后使用 /updates 重试。',
  },
  'en-US': {
    check: 'Check ClawMaster updates', change: 'Prepare ClawMaster update',
    checkDescription: 'Read server update metadata and current running versions. Does not download update artifacts or change configuration.',
    changeDescription: 'Prepare an exact signed candidate after one user approval. Hot components await Loader activation; a maintenance-capable desktop applies staged updater changes before its next Host starts, then waits for actual load confirmation. Runtime and native files are verified downloads only.',
    rollback: 'Restore the previous updater', rollbackDescription: 'Restore the updater version before a selected operation after one user approval; apply before the next Host starts without downgrading business databases.',
    commandInput: '/updates accepts no arguments and only checks metadata.', unavailable: 'unavailable', unknown: 'unverified',
    runtime: 'Running DSH', desktop: 'Running desktop', components: 'Component and runtime catalog', native: 'Native installer',
    compatible: 'compatible', incompatible: 'incompatible with running DSH', pending: 'native installation required',
    empty: 'No component versions published', guidance: 'Ask ClawMaster to prepare a component and version. It will request confirmation before writing.',
    owner: 'Update writes require an owning DSH agent session.', closed: 'Updates plugin was unloaded.', polling: 'Update server check did not complete; retry with /updates.',
  },
} as const

function commandText(status: UpdatesStatus, locale: 'zh-CN' | 'en-US'): string {
  const text = copy[locale]
  const rows = [`${text.runtime}: ${status.facts.dshVersion ?? text.unknown}`, `${text.desktop}: ${status.facts.desktopVersion ?? text.unknown}`]
  if (status.components.status === 'unavailable') rows.push(`${text.components}: ${text.unavailable} (${status.components.error})`)
  else if (status.components.items.length === 0) rows.push(text.empty)
  else for (const item of status.components.items) rows.push(`${item.id} ${item.version}: ${item.compatible === null ? text.unknown : item.compatible ? text.compatible : text.incompatible} (${item.activation})`)
  rows.push(status.native.status === 'available' ? `${text.native}: ${status.native.version} (${text.pending})` : `${text.native}: ${text.unavailable} (${status.native.error})`)
  for (const operation of status.operations) rows.push(`${operation.id} ${operation.version}: ${operation.state} (${operation.token})`)
  rows.push(text.guidance)
  return rows.join('\n')
}

/** Register read-only discovery and approval-gated tools for the plugin lifetime.
 * @param ctx DSH command, tool and one-shot approval services.
 * @param input Deployment settings; tool callers cannot override them.
 * @param dependencies Explicit HTTP and process-fact providers used by Host integration tests.
 */
export async function apply(ctx: UpdatesHostContext, input: UpdatesConfig = {}, dependencies: UpdatesDependencies = {}): Promise<void> {
  const config = resolveConfig(input)
  const text = copy[config.locale]
  await ctx.effect(async () => {
    const service = new UpdatesService(config, dependencies)
    const lifetime = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const removals: Array<() => void> = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposing: Promise<void> | undefined

    function track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    }

    function run<T>(caller: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const signal = AbortSignal.any([lifetime.signal, caller])
      return track(Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal) }))
    }

    function dispose(): Promise<void> {
      if (disposing) return disposing
      if (timer !== undefined) clearTimeout(timer)
      lifetime.abort(new Error(text.closed))
      disposing = (async () => {
        const removed = await Promise.allSettled(removals.map(async remove => remove()))
        await Promise.allSettled(pending)
        const failed = removed.filter(result => result.status === 'rejected')
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Update registrations could not be removed')
      })()
      return disposing
    }

    function poll(): void {
      if (lifetime.signal.aborted) return
      void run(lifetime.signal, signal => service.check(signal)).catch(() => {
        if (!lifetime.signal.aborted) ctx.logger?.warn(text.polling)
      }).finally(() => {
        if (!lifetime.signal.aborted) {
          timer = setTimeout(poll, config.checkIntervalMs)
          timer.unref()
        }
      })
    }

    const output: ToolDefinition['output'] = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    }
    const presentation = (title: string, kind: 'search' | 'edit'): Pick<ToolDefinition, 'presentCall' | 'presentResult'> => ({
      presentCall: args => ({ card: 'generic', title, kind, rawInput: JSON.stringify(args) }),
      presentResult: (_args, result) => ({ card: 'generic', title, content: result.content }),
    })

    try {
      removals.push(ctx.commands.register({ name: 'updates', description: text.checkDescription,
        handler: invocation => run(invocation.signal, async signal => invocation.rawInput.trim()
          ? { kind: 'error' as const, text: text.commandInput }
          : { kind: 'success' as const, text: commandText(await service.check(signal), config.locale) }),
      }))
      removals.push(ctx.tools.register({
        name: 'clawmaster_updates', description: text.checkDescription,
        parameters: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Fetch current metadata (default true); false reuses the last in-memory check when available.' } }, additionalProperties: false },
        output, ...presentation(text.check, 'search'),
        execute: (args, exec) => run(exec.signal, async signal => {
          const request = querySchema.parse(args)
          return (!request.refresh && service.cached()) || service.check(signal)
        }),
      }))
      removals.push(ctx.tools.register({
        name: 'clawmaster_update', description: text.changeDescription,
        parameters: {
          type: 'object', properties: { kind: { type: 'string', enum: ['component', 'runtime', 'native'] }, id: { type: 'string' }, version: { type: 'string' } },
          required: ['kind', 'version'], additionalProperties: false,
        },
        output, ...presentation(text.change, 'edit'),
        execute: (args, exec: ToolRunContext) => run(exec.signal, async signal => {
          const agent = exec.agent
          if (agent === undefined) throw new Error(text.owner)
          return service.change(args, reason => ctx.approval.request({ agent, callId: exec.callId, toolName: exec.name, reason, signal }), signal)
        }),
      }))
      removals.push(ctx.tools.register({
        name: 'clawmaster_update_rollback', description: text.rollbackDescription,
        parameters: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false },
        output, ...presentation(text.rollback, 'edit'),
        execute: (args, exec: ToolRunContext) => run(exec.signal, async signal => {
          const { operation } = z.strictObject({ operation: z.string().uuid() }).parse(args)
          const agent = exec.agent
          if (agent === undefined) throw new Error(text.owner)
          return service.rollback(operation, reason => ctx.approval.request({ agent, callId: exec.callId, toolName: exec.name, reason, signal }), signal)
        }),
      }))
      if (process.env.CLAWMASTER_RUNTIME_RUN_ID) await confirmComponentHealth({ dshHome: config.dshHome,
        entryUrl: import.meta.url, hostPid: process.pid, runId: process.env.CLAWMASTER_RUNTIME_RUN_ID })
      if (config.checkIntervalMs > 0) poll()
      return dispose
    } catch (error) { await dispose(); throw error }
  })
}
