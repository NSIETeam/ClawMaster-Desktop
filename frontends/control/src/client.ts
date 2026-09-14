/** Command projection over the desktop's existing Session Remote API. */
import type {
  SessionCancelRequest, SessionListRequest, SessionListValue, SessionPromptRequest, SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types';
import { brandString } from '@deepseek-ai/dsh-brand';
import { assertNever } from '@deepseek-ai/dsh-util-values';
import { z } from 'zod';
import { ControlConnectionError, type DesktopConnection } from './connect.ts';

/** Parsed commands; send identity remains stable across caller-requested retries. */
export type ControlCommand =
  | { kind: 'status'; json: boolean }
  | { kind: 'sessions'; running: boolean; json: boolean }
  | { kind: 'send'; sessionId: string; steer: boolean; requestId: string; json: boolean }
  | { kind: 'cancel'; sessionId: string; json: boolean };

type PreparedCommand = Exclude<ControlCommand, { kind: 'send' }>
  | (Extract<ControlCommand, { kind: 'send' }> & { request: SessionPromptRequest });
type SessionListItem = Pick<SessionListValue['items'][number], 'sessionId' | 'running' | 'updatedAt' | 'cwd'>;

/** External effects supplied to one command without modifying process globals. */
export interface ControlCommandDependencies {
  /** Deadline for authentication and the selected Remote call, after standard input is read. */
  readonly requestTimeoutMs: number;
  /** Authenticate the current desktop; rejects instead of starting a Host. */
  connect(signal: AbortSignal): Promise<DesktopConnection>;
  /** Read bounded UTF-8 input; terminal input is rejected. */
  readInput(signal: AbortSignal): Promise<string>;
}

/** Selected output for a successful command; acknowledgement never asserts completion. */
export interface ControlCommandResult {
  readonly value: unknown;
  readonly text: string;
}

/** Safe diagnostic fields; raw transport errors and request contents are excluded. */
export interface ControlFailure {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

/** Fixed command failure suitable for terminal and JSON output. */
export class ControlCommandError extends Error {
  /**
   * @param code - stable command error code.
   * @param message - safe product-owned diagnostic.
   */
  constructor(readonly code: string, message: string) { super(message); }
}

const sessionList = z.object({ items: z.array(z.object({
  sessionId: z.string().min(1),
  running: z.boolean(),
  updatedAt: z.number().finite(),
  cwd: z.string().optional(),
})) });
const accepted = z.object({ accepted: z.literal(true) });

function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

async function invoke(
  desktop: DesktopConnection,
  endpoint: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await desktop.rpc.call('/api', endpoint, { args }, signal);
  signal.throwIfAborted();
  if (!response.ok) {
    const known = ['session/not-found', 'session/agent-busy', 'session/model-unavailable', 'gateway/bad-request'];
    const code = known.includes(response.error.code) ? response.error.code : 'remote-rejected';
    throw new ControlCommandError(code, '桌面未接受此请求，请检查会话状态。');
  }
  return response.value;
}

/**
 * Execute one explicit command against the existing desktop, without automatic retries.
 * @param command - validated command and stable send request identity.
 * @param dependencies - connection and bounded input owners.
 * @param signal - command lifetime; aborting a request does not undo Host admission.
 * @returns safe JSON and terminal projections after the response is validated.
 */
export async function executeControlCommand(
  command: ControlCommand,
  dependencies: ControlCommandDependencies,
  signal: AbortSignal,
): Promise<ControlCommandResult> {
  signal.throwIfAborted();
  let prepared: PreparedCommand;
  if (command.kind === 'send') {
    const text = await dependencies.readInput(signal);
    if (text.trim().length === 0) throw new ControlCommandError('empty-input', '输入内容不能为空。');
    prepared = { ...command, request: {
      requestId: brandString<SessionRequestId>(command.requestId),
      sessionId: brandString<SessionPromptRequest['sessionId']>(command.sessionId),
      mode: command.steer ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    } satisfies SessionPromptRequest };
  } else {
    prepared = command;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ControlCommandError('request-timeout', '桌面请求超时，操作可能已接收；请先核对状态。')), dependencies.requestTimeoutMs);
  timer.unref();
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    return await executeConnectedCommand(prepared, dependencies, requestSignal);
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason;
    throw error;
  } finally { clearTimeout(timer); }
}

async function executeConnectedCommand(
  command: PreparedCommand,
  dependencies: ControlCommandDependencies,
  signal: AbortSignal,
): Promise<ControlCommandResult> {
  const desktop = await dependencies.connect(signal);
  signal.throwIfAborted();
  switch (command.kind) {
    case 'status':
      return {
        value: { connected: true, runtime: desktop.runtime },
        text: `ClawMaster 已连接 · 桌面 ${printable(desktop.runtime.desktopVersion)} · Host ${desktop.record.hostPid}`,
      };
    case 'sessions': {
      const result = sessionList.safeParse(await invoke(desktop, 'session/list', { _request: {} satisfies SessionListRequest }, signal));
      if (!result.success) throw new ControlCommandError('invalid-response', '桌面返回的会话列表无效。');
      const items = result.data.items.filter(item => !command.running || item.running).map(item => ({
        sessionId: brandString<SessionListItem['sessionId']>(item.sessionId),
        running: item.running, updatedAt: item.updatedAt,
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      } satisfies SessionListItem));
      return {
        value: { items },
        text: items.length === 0 ? '没有匹配的会话。' : items.map(item =>
          `${printable(item.sessionId)}\t${item.running ? '运行中' : '空闲'}${item.cwd === undefined ? '' : `\t${printable(item.cwd)}`}`,
        ).join('\n'),
      };
    }
    case 'send': {
      const { mode } = command.request;
      const result = accepted.safeParse(await invoke(desktop, 'session/prompt', { request: command.request }, signal));
      if (!result.success) throw new ControlCommandError('invalid-response', '未取得有效接收凭证，请使用同一请求 ID 核对或重试。');
      return {
        value: { accepted: true, sessionId: command.sessionId, requestId: command.requestId, mode },
        text: `桌面已接收${command.steer ? '引导' : '排队'}请求，尚未确认任务完成。\n请求 ID：${command.requestId}`,
      };
    }
    case 'cancel': {
      const request = { sessionId: brandString<SessionCancelRequest['sessionId']>(command.sessionId) } satisfies SessionCancelRequest;
      const result = accepted.safeParse(await invoke(desktop, 'session/cancel', { request }, signal));
      if (!result.success) throw new ControlCommandError('invalid-response', '未取得有效的中断请求凭证。');
      return {
        value: { accepted: true, sessionId: command.sessionId, pendingInbox: 'retained' },
        text: '已请求中断当前轮；待处理队列保留，尚未确认中断完成。',
      };
    }
    default: return assertNever(command);
  }
}

/**
 * Project only owned diagnostics; transport messages may contain authentication URLs.
 * @param error - command, connection, or unknown failure.
 * @param command - selected command whose send identity is needed for safe retries.
 * @returns fixed diagnostic and the original send request identity when applicable.
 */
export function controlFailure(error: unknown, command: ControlCommand): ControlFailure {
  let code = 'request-failed';
  let message = '请求失败；桌面可能已接收操作，请先核对状态。';
  if (error instanceof ControlCommandError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof ControlConnectionError) {
    code = error.code;
    const messages: Record<ControlConnectionError['code'], string> = {
      'not-running': '未找到运行中的 ClawMaster，请先打开桌面应用。',
      'insecure-record': '桌面连接记录的访问权限不安全，连接已停止。',
      'invalid-record': '桌面连接记录无效，请重新打开桌面应用。',
      'stale-runtime': '桌面运行状态已变化，请重新连接。',
      'authentication-failed': '桌面认证失败，请重新打开桌面应用后连接。',
      'transport-failed': '无法连接桌面，请检查应用是否仍在运行。',
    };
    message = messages[error.code];
  }
  return {
    code, message,
    ...(command.kind === 'send' ? { requestId: command.requestId } : {}),
  };
}
