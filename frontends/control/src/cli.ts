/** DSH profile application that controls an already-running ClawMaster desktop. */
import type { Context } from '@deepseek-ai/cordis';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { Command, InvalidArgumentError } from 'commander';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { connectDesktop } from './connect.ts';
import { ControlCommandError, controlFailure, executeControlCommand, type ControlCommand } from './client.ts';

/** Cordis application name. */
export const name = 'clawmaster-control';
/** Launcher-owned arguments and successful-startup notification. */
export const inject = ['cmdlineArgs', 'appReady'];

/** Deployment limits for the command client's buffered standard input. */
export interface Config {
  /** Maximum UTF-8 input bytes; defaults to 1 MiB. */
  readonly maxInputBytes?: number;
  /** Authentication and request deadline after stdin EOF; defaults to 30 seconds. */
  readonly requestTimeoutMs?: number;
}

const configSchema = z.object({
  maxInputBytes: z.number().int().positive().default(1024 * 1024),
  requestTimeoutMs: z.number().int().positive().max(2_147_483_647).default(30_000),
}).strict();

function requestIdentity(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new InvalidArgumentError('请求 ID 必须是 UUID。');
  return value;
}

/**
 * Build the grammar without starting input, authentication, or requests.
 * @param select - receives the one selected command after successful parsing.
 * @param newIdentity - UUID allocator for sends without an explicit retry identity.
 * @returns Commander program consumed by the supported DSH command-line adapter.
 */
export function createControlProgram(
  select: (command: ControlCommand) => void,
  newIdentity: () => string = randomUUID,
): Command {
  const program = new Command('clawmaster-control')
    .description('查询并控制正在运行的 ClawMaster 桌面会话。')
    .showSuggestionAfterError(false);
  program.command('status').description('检查桌面连接和运行版本。')
    .option('--json', '输出 JSON。')
    .action((options: { json?: boolean }) => select({ kind: 'status', json: options.json === true }));
  program.command('sessions').description('列出会话，不恢复 Agent。')
    .option('--running', '只列出运行中的会话。')
    .option('--json', '输出 JSON。')
    .action((options: { running?: boolean; json?: boolean }) => select({
      kind: 'sessions', running: options.running === true, json: options.json === true,
    }));
  program.command('send <session-id>').description('发送文本；接收凭证不代表任务完成。')
    .requiredOption('--stdin', '从管道或重定向读取 UTF-8 文本。')
    .option('--steer', '引导当前轮；默认加入待处理队列。')
    .option('--request-id <uuid>', '重试时使用原请求 ID。', requestIdentity)
    .option('--json', '输出 JSON。')
    .action((sessionId: string, options: { steer?: boolean; requestId?: string; json?: boolean }) => select({
      kind: 'send', sessionId, steer: options.steer === true,
      requestId: options.requestId ?? newIdentity(), json: options.json === true,
    }));
  program.command('cancel <session-id>').description('请求中断当前轮，保留待处理队列。')
    .option('--json', '输出 JSON。')
    .action((sessionId: string, options: { json?: boolean }) => select({
      kind: 'cancel', sessionId, json: options.json === true,
    }));
  return program;
}

/**
 * Read redirected UTF-8 input with a byte limit and immediate cancellation.
 * @param input - command-owned input stream; terminal input is rejected.
 * @param maxBytes - validated positive byte limit.
 * @param signal - lifetime that detaches listeners and pauses input on cancellation.
 * @returns the complete UTF-8 input after EOF; rejects partial or invalid input.
 */
export function readCommandInput(input: Readable & { isTTY?: boolean }, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (input.isTTY) return Promise.reject(new ControlCommandError('terminal-input', '请通过管道或文件重定向提供 --stdin 文本。'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      input.pause();
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => { cleanup(); reject(error); };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        fail(new ControlCommandError('input-too-large', `输入超过 ${maxBytes} 字节上限。`));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      cleanup();
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new ControlCommandError('invalid-input', '输入必须是有效的 UTF-8 文本。')); }
    };
    const onError = (): void => { fail(new ControlCommandError('input-failed', '无法读取输入文本。')); };
    const onClose = (): void => { fail(new ControlCommandError('input-closed', '输入在结束前关闭，未发送文本。')); };
    const onAbort = (): void => { fail(signal.reason); };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (input.readableEnded) onEnd();
    else if (input.destroyed) onClose();
    else input.resume();
  });
}

/**
 * Mount the one-shot command application under the DSH launcher.
 * @param ctx - launcher-owned arguments, readiness, exit, and plugin lifetime.
 * @param config - optional standard-input byte limit.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { maxInputBytes, requestTimeoutMs } = configSchema.parse(config);
  let selected: ControlCommand | undefined;
  parseCmdline(ctx, createControlProgram(command => { selected = command; }));
  if (selected === undefined) return;
  const command = selected;
  const exit = ctx.get('appExit');
  const ready = ctx.get('appReady');
  if (exit === undefined || ready === undefined) throw new Error('clawmaster-control requires the DSH launcher');
  ctx.effect(() => {
    const abort = new AbortController();
    let task: Promise<void> | undefined;
    const remove = ready.onReady(() => {
      task = (async () => {
        let code = 0;
        try {
          const result = await executeControlCommand(command, {
            requestTimeoutMs,
            connect: signal => connectDesktop(resolveDshHome(), signal),
            readInput: signal => readCommandInput(process.stdin, maxInputBytes, signal),
          }, abort.signal);
          if (!abort.signal.aborted) process.stdout.write(`${command.json ? JSON.stringify(result.value) : result.text}\n`);
        } catch (error) {
          code = 1;
          if (!abort.signal.aborted) {
            const failure = controlFailure(error, command);
            process.stderr.write(command.json ? `${JSON.stringify({ error: failure })}\n`
              : `${failure.message}${failure.requestId === undefined ? '' : `\n重试请使用同一请求 ID：${failure.requestId}`}\n`);
          }
        }
        if (!abort.signal.aborted) exit(code);
      })();
    });
    return async () => {
      remove();
      abort.abort();
      await task;
    };
  }, 'clawmaster-control: command lifetime');
}
