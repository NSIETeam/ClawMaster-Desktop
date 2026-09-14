// src/cli.ts
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { Command, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { z as z3 } from "zod";

// src/connect.ts
import { createHash } from "node:crypto";
import { createWebConnectionRpc } from "@deepseek-ai/dsh-client-connection/web-rpc";

// src/connection-record.ts
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";
import { spawn } from "node:child_process";
import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { z } from "zod";
var MESSAGES = {
  "not-running": "No current ClawMaster desktop connection is available.",
  "insecure-record": "The desktop connection files do not have private ownership and permissions.",
  "invalid-record": "The desktop connection record is invalid.",
  "stale-runtime": "The desktop connection belongs to a stopped or replaced Host.",
  "authentication-failed": "The desktop Host did not accept the login exchange.",
  "transport-failed": "The desktop Host request could not be completed."
};
var ControlConnectionError = class extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.code = code;
    this.name = "ControlConnectionError";
  }
};
var ConnectionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string().uuid(),
  hostPid: z.number().int().positive(),
  runId: z.string().min(1).max(128),
  origin: z.string().max(128),
  authenticatedUrl: z.string().max(1024)
}).strict();
var SafeRuntimeSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("ready"),
  runId: z.string(),
  observedAtUnixMs: z.number().int().nonnegative(),
  desktopVersion: z.string(),
  harnessVersion: z.string(),
  desktopPid: z.number().int().positive(),
  hostPid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/)
});
var MAX_RECORD_BYTES = 64 * 1024;
function errorCode(error) {
  return error?.code;
}
function recordPath(home) {
  return join(home, "control", "connection.json");
}
function parseConnectionRecord(value) {
  const result = ConnectionRecordSchema.safeParse(value);
  if (!result.success) throw new ControlConnectionError("invalid-record");
  try {
    const record = result.data;
    const origin = new URL(record.origin);
    const login = new URL(record.authenticatedUrl);
    const pairs = [...login.searchParams];
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || record.origin !== origin.origin || origin.username !== "" || origin.password !== "" || login.origin !== origin.origin || login.username !== "" || login.password !== "" || login.pathname !== "/" || login.hash !== "" || pairs.length !== 1 || pairs[0]?.[0] !== "token" || !/^[A-Za-z0-9_-]{43}$/.test(pairs[0][1])) {
      throw new ControlConnectionError("invalid-record");
    }
    return record;
  } catch {
    throw new ControlConnectionError("invalid-record");
  }
}
var WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $path = $env:CLAWMASTER_CONTROL_ACL_PATH
  $mode = $env:CLAWMASTER_CONTROL_ACL_MODE
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link' }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
  if ($mode -eq 'protect') {
    if (-not $item.PSIsContainer) { throw 'directory required' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowed) {
      $identity = New-Object Security.Principal.SecurityIdentifier($sid)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'owner' }
  if ($item.PSIsContainer -and -not $acl.AreAccessRulesProtected) { throw 'inheritance' }
  $ownGrant = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'public access' }
    if ($rule.IdentityReference.Value -eq $user.Value -and
      ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read) { $ownGrant = $true }
  }
  if (-not $ownGrant) { throw 'missing owner access' }
  exit 0
} catch { exit 1 }
`;
async function windowsAcl(path, mode) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new ControlConnectionError("insecure-record");
  const command = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    CLAWMASTER_CONTROL_ACL_PATH: path,
    CLAWMASTER_CONTROL_ACL_MODE: mode
  };
  await new Promise((done, reject) => {
    const child = spawn(command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64")
    ], {
      env,
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 15e3);
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!failed && code === 0) done();
      else reject(new ControlConnectionError("insecure-record"));
    });
  });
}
async function checkedDirectories(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new ControlConnectionError("insecure-record");
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ControlConnectionError("insecure-record");
  }
}
async function privatePath(path, kind) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) {
    throw new ControlConnectionError("insecure-record");
  }
  if (process.platform === "win32") await windowsAcl(path, "verify");
  else if (info.uid !== process.getuid?.() || (info.mode & 63) !== 0) {
    throw new ControlConnectionError("insecure-record");
  }
}
async function controlDirectory(home, create) {
  await checkedDirectories(home);
  const homeInfo = await lstat(home);
  if (process.platform !== "win32" && (homeInfo.uid !== process.getuid?.() || (homeInfo.mode & 18) !== 0)) {
    throw new ControlConnectionError("insecure-record");
  }
  const directory = join(home, "control");
  if (create) {
    let created = false;
    try {
      await mkdir(directory, { mode: 448 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (created && process.platform === "win32") await windowsAcl(directory, "protect");
  }
  await privatePath(directory, "directory");
  return directory;
}
async function privateJson(path) {
  await checkedDirectories(dirname(path));
  await privatePath(path, "file");
  const before = await lstat(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > MAX_RECORD_BYTES) throw new ControlConnectionError("invalid-record");
    if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 63) !== 0)) {
      throw new ControlConnectionError("insecure-record");
    }
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_RECORD_BYTES) throw new ControlConnectionError("invalid-record");
    try {
      return JSON.parse(bytes.subarray(0, used).toString("utf8"));
    } catch {
      throw new ControlConnectionError("invalid-record");
    }
  } finally {
    await file.close();
  }
}
function safeFileFailure(error) {
  if (error instanceof ControlConnectionError) return error;
  return new ControlConnectionError(errorCode(error) === "ENOENT" ? "not-running" : "insecure-record");
}
async function readConnectionRecord(home) {
  try {
    await controlDirectory(home, false);
    return parseConnectionRecord(await privateJson(recordPath(home)));
  } catch (error) {
    throw safeFileFailure(error);
  }
}
async function readCurrentRuntime(home, record) {
  try {
    const result = SafeRuntimeSchema.safeParse(await privateJson(join(home, "desktop", "current-runtime.json")));
    if (!result.success || result.data.runId !== record.runId || result.data.hostPid !== record.hostPid || result.data.port !== Number(new URL(record.origin).port || 80)) {
      throw new ControlConnectionError("stale-runtime");
    }
    try {
      process.kill(record.hostPid, 0);
    } catch {
      throw new ControlConnectionError("stale-runtime");
    }
    return result.data;
  } catch (error) {
    throw safeFileFailure(error);
  }
}

// src/connect.ts
async function connectDesktop(home, signal) {
  signal?.throwIfAborted();
  const record = await readConnectionRecord(home);
  const runtime = await readCurrentRuntime(home, record);
  const loginSignal = signal ?? AbortSignal.timeout(1e4);
  let cookie;
  try {
    const response = await fetch(record.authenticatedUrl, { redirect: "manual", signal: loginSignal });
    try {
      const cookies = response.headers.getSetCookie();
      const name2 = `dsh-auth-${createHash("sha256").update(new URL(record.origin).host).digest("base64url")}`;
      const pair = cookies[0]?.split(";", 1)[0];
      if (response.status !== 303 || response.headers.get("location") !== "/" || cookies.length !== 1 || !pair || !pair.startsWith(`${name2}=`) || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pair.slice(name2.length + 1))) {
        throw new ControlConnectionError("authentication-failed");
      }
      cookie = pair;
    } finally {
      await response.body?.cancel();
    }
  } catch {
    throw new ControlConnectionError("authentication-failed");
  }
  const assertCurrent = async () => {
    const latest = await readConnectionRecord(home);
    if (latest.instanceId !== record.instanceId) throw new ControlConnectionError("stale-runtime");
    await readCurrentRuntime(home, record);
  };
  await assertCurrent();
  const rpc = createWebConnectionRpc(async (input, init) => {
    await assertCurrent();
    if (!input.pathname.startsWith("/api/") || input.search !== "" || input.hash !== "" || init.method !== "POST") {
      throw new ControlConnectionError("transport-failed");
    }
    const requestSignal = init.signal ?? signal ?? AbortSignal.timeout(1e4);
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    try {
      return await fetch(new URL(input.pathname, record.origin), { ...init, headers, redirect: "manual", signal: requestSignal });
    } catch {
      throw new ControlConnectionError("transport-failed");
    }
  });
  return { record: { origin: record.origin, hostPid: record.hostPid, instanceId: record.instanceId }, runtime, rpc };
}

// src/client.ts
import { brandString } from "@deepseek-ai/dsh-brand";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { z as z2 } from "zod";
var ControlCommandError = class extends Error {
  /**
   * @param code - stable command error code.
   * @param message - safe product-owned diagnostic.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var sessionList = z2.object({ items: z2.array(z2.object({
  sessionId: z2.string().min(1),
  running: z2.boolean(),
  updatedAt: z2.number().finite(),
  cwd: z2.string().optional()
})) });
var accepted = z2.object({ accepted: z2.literal(true) });
function printable(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}
async function invoke(desktop, endpoint, args, signal) {
  signal.throwIfAborted();
  const response = await desktop.rpc.call("/api", endpoint, { args }, signal);
  signal.throwIfAborted();
  if (!response.ok) {
    const known = ["session/not-found", "session/agent-busy", "session/model-unavailable", "gateway/bad-request"];
    const code = known.includes(response.error.code) ? response.error.code : "remote-rejected";
    throw new ControlCommandError(code, "\u684C\u9762\u672A\u63A5\u53D7\u6B64\u8BF7\u6C42\uFF0C\u8BF7\u68C0\u67E5\u4F1A\u8BDD\u72B6\u6001\u3002");
  }
  return response.value;
}
async function executeControlCommand(command, dependencies, signal) {
  signal.throwIfAborted();
  let prepared;
  if (command.kind === "send") {
    const text = await dependencies.readInput(signal);
    if (text.trim().length === 0) throw new ControlCommandError("empty-input", "\u8F93\u5165\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A\u3002");
    prepared = { ...command, request: {
      requestId: brandString(command.requestId),
      sessionId: brandString(command.sessionId),
      mode: command.steer ? "steer" : "queue",
      content: [{ type: "text", text }]
    } };
  } else {
    prepared = command;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ControlCommandError("request-timeout", "\u684C\u9762\u8BF7\u6C42\u8D85\u65F6\uFF0C\u64CD\u4F5C\u53EF\u80FD\u5DF2\u63A5\u6536\uFF1B\u8BF7\u5148\u6838\u5BF9\u72B6\u6001\u3002")), dependencies.requestTimeoutMs);
  timer.unref();
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    return await executeConnectedCommand(prepared, dependencies, requestSignal);
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function executeConnectedCommand(command, dependencies, signal) {
  const desktop = await dependencies.connect(signal);
  signal.throwIfAborted();
  switch (command.kind) {
    case "status":
      return {
        value: { connected: true, runtime: desktop.runtime },
        text: `ClawMaster \u5DF2\u8FDE\u63A5 \xB7 \u684C\u9762 ${printable(desktop.runtime.desktopVersion)} \xB7 Host ${desktop.record.hostPid}`
      };
    case "sessions": {
      const result = sessionList.safeParse(await invoke(desktop, "session/list", { _request: {} }, signal));
      if (!result.success) throw new ControlCommandError("invalid-response", "\u684C\u9762\u8FD4\u56DE\u7684\u4F1A\u8BDD\u5217\u8868\u65E0\u6548\u3002");
      const items = result.data.items.filter((item) => !command.running || item.running).map((item) => ({
        sessionId: brandString(item.sessionId),
        running: item.running,
        updatedAt: item.updatedAt,
        ...item.cwd === void 0 ? {} : { cwd: item.cwd }
      }));
      return {
        value: { items },
        text: items.length === 0 ? "\u6CA1\u6709\u5339\u914D\u7684\u4F1A\u8BDD\u3002" : items.map(
          (item) => `${printable(item.sessionId)}	${item.running ? "\u8FD0\u884C\u4E2D" : "\u7A7A\u95F2"}${item.cwd === void 0 ? "" : `	${printable(item.cwd)}`}`
        ).join("\n")
      };
    }
    case "send": {
      const { mode } = command.request;
      const result = accepted.safeParse(await invoke(desktop, "session/prompt", { request: command.request }, signal));
      if (!result.success) throw new ControlCommandError("invalid-response", "\u672A\u53D6\u5F97\u6709\u6548\u63A5\u6536\u51ED\u8BC1\uFF0C\u8BF7\u4F7F\u7528\u540C\u4E00\u8BF7\u6C42 ID \u6838\u5BF9\u6216\u91CD\u8BD5\u3002");
      return {
        value: { accepted: true, sessionId: command.sessionId, requestId: command.requestId, mode },
        text: `\u684C\u9762\u5DF2\u63A5\u6536${command.steer ? "\u5F15\u5BFC" : "\u6392\u961F"}\u8BF7\u6C42\uFF0C\u5C1A\u672A\u786E\u8BA4\u4EFB\u52A1\u5B8C\u6210\u3002
\u8BF7\u6C42 ID\uFF1A${command.requestId}`
      };
    }
    case "cancel": {
      const request = { sessionId: brandString(command.sessionId) };
      const result = accepted.safeParse(await invoke(desktop, "session/cancel", { request }, signal));
      if (!result.success) throw new ControlCommandError("invalid-response", "\u672A\u53D6\u5F97\u6709\u6548\u7684\u4E2D\u65AD\u8BF7\u6C42\u51ED\u8BC1\u3002");
      return {
        value: { accepted: true, sessionId: command.sessionId, pendingInbox: "retained" },
        text: "\u5DF2\u8BF7\u6C42\u4E2D\u65AD\u5F53\u524D\u8F6E\uFF1B\u5F85\u5904\u7406\u961F\u5217\u4FDD\u7559\uFF0C\u5C1A\u672A\u786E\u8BA4\u4E2D\u65AD\u5B8C\u6210\u3002"
      };
    }
    default:
      return assertNever(command);
  }
}
function controlFailure(error, command) {
  let code = "request-failed";
  let message = "\u8BF7\u6C42\u5931\u8D25\uFF1B\u684C\u9762\u53EF\u80FD\u5DF2\u63A5\u6536\u64CD\u4F5C\uFF0C\u8BF7\u5148\u6838\u5BF9\u72B6\u6001\u3002";
  if (error instanceof ControlCommandError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof ControlConnectionError) {
    code = error.code;
    const messages = {
      "not-running": "\u672A\u627E\u5230\u8FD0\u884C\u4E2D\u7684 ClawMaster\uFF0C\u8BF7\u5148\u6253\u5F00\u684C\u9762\u5E94\u7528\u3002",
      "insecure-record": "\u684C\u9762\u8FDE\u63A5\u8BB0\u5F55\u7684\u8BBF\u95EE\u6743\u9650\u4E0D\u5B89\u5168\uFF0C\u8FDE\u63A5\u5DF2\u505C\u6B62\u3002",
      "invalid-record": "\u684C\u9762\u8FDE\u63A5\u8BB0\u5F55\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u684C\u9762\u5E94\u7528\u3002",
      "stale-runtime": "\u684C\u9762\u8FD0\u884C\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002",
      "authentication-failed": "\u684C\u9762\u8BA4\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u684C\u9762\u5E94\u7528\u540E\u8FDE\u63A5\u3002",
      "transport-failed": "\u65E0\u6CD5\u8FDE\u63A5\u684C\u9762\uFF0C\u8BF7\u68C0\u67E5\u5E94\u7528\u662F\u5426\u4ECD\u5728\u8FD0\u884C\u3002"
    };
    message = messages[error.code];
  }
  return {
    code,
    message,
    ...command.kind === "send" ? { requestId: command.requestId } : {}
  };
}

// src/cli.ts
var name = "clawmaster-control";
var inject = ["cmdlineArgs", "appReady"];
var configSchema = z3.object({
  maxInputBytes: z3.number().int().positive().default(1024 * 1024),
  requestTimeoutMs: z3.number().int().positive().max(2147483647).default(3e4)
}).strict();
function requestIdentity(value) {
  if (!z3.uuid().safeParse(value).success) throw new InvalidArgumentError("\u8BF7\u6C42 ID \u5FC5\u987B\u662F UUID\u3002");
  return value;
}
function createControlProgram(select, newIdentity = randomUUID) {
  const program = new Command("clawmaster-control").description("\u67E5\u8BE2\u5E76\u63A7\u5236\u6B63\u5728\u8FD0\u884C\u7684 ClawMaster \u684C\u9762\u4F1A\u8BDD\u3002").showSuggestionAfterError(false);
  program.command("status").description("\u68C0\u67E5\u684C\u9762\u8FDE\u63A5\u548C\u8FD0\u884C\u7248\u672C\u3002").option("--json", "\u8F93\u51FA JSON\u3002").action((options) => select({ kind: "status", json: options.json === true }));
  program.command("sessions").description("\u5217\u51FA\u4F1A\u8BDD\uFF0C\u4E0D\u6062\u590D Agent\u3002").option("--running", "\u53EA\u5217\u51FA\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\u3002").option("--json", "\u8F93\u51FA JSON\u3002").action((options) => select({
    kind: "sessions",
    running: options.running === true,
    json: options.json === true
  }));
  program.command("send <session-id>").description("\u53D1\u9001\u6587\u672C\uFF1B\u63A5\u6536\u51ED\u8BC1\u4E0D\u4EE3\u8868\u4EFB\u52A1\u5B8C\u6210\u3002").requiredOption("--stdin", "\u4ECE\u7BA1\u9053\u6216\u91CD\u5B9A\u5411\u8BFB\u53D6 UTF-8 \u6587\u672C\u3002").option("--steer", "\u5F15\u5BFC\u5F53\u524D\u8F6E\uFF1B\u9ED8\u8BA4\u52A0\u5165\u5F85\u5904\u7406\u961F\u5217\u3002").option("--request-id <uuid>", "\u91CD\u8BD5\u65F6\u4F7F\u7528\u539F\u8BF7\u6C42 ID\u3002", requestIdentity).option("--json", "\u8F93\u51FA JSON\u3002").action((sessionId, options) => select({
    kind: "send",
    sessionId,
    steer: options.steer === true,
    requestId: options.requestId ?? newIdentity(),
    json: options.json === true
  }));
  program.command("cancel <session-id>").description("\u8BF7\u6C42\u4E2D\u65AD\u5F53\u524D\u8F6E\uFF0C\u4FDD\u7559\u5F85\u5904\u7406\u961F\u5217\u3002").option("--json", "\u8F93\u51FA JSON\u3002").action((sessionId, options) => select({
    kind: "cancel",
    sessionId,
    json: options.json === true
  }));
  return program;
}
function readCommandInput(input, maxBytes, signal) {
  signal.throwIfAborted();
  if (input.isTTY) return Promise.reject(new ControlCommandError("terminal-input", "\u8BF7\u901A\u8FC7\u7BA1\u9053\u6216\u6587\u4EF6\u91CD\u5B9A\u5411\u63D0\u4F9B --stdin \u6587\u672C\u3002"));
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      input.pause();
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        fail(new ControlCommandError("input-too-large", `\u8F93\u5165\u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650\u3002`));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve2(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        reject(new ControlCommandError("invalid-input", "\u8F93\u5165\u5FC5\u987B\u662F\u6709\u6548\u7684 UTF-8 \u6587\u672C\u3002"));
      }
    };
    const onError = () => {
      fail(new ControlCommandError("input-failed", "\u65E0\u6CD5\u8BFB\u53D6\u8F93\u5165\u6587\u672C\u3002"));
    };
    const onClose = () => {
      fail(new ControlCommandError("input-closed", "\u8F93\u5165\u5728\u7ED3\u675F\u524D\u5173\u95ED\uFF0C\u672A\u53D1\u9001\u6587\u672C\u3002"));
    };
    const onAbort = () => {
      fail(signal.reason);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (input.readableEnded) onEnd();
    else if (input.destroyed) onClose();
    else input.resume();
  });
}
function apply(ctx, config = {}) {
  const { maxInputBytes, requestTimeoutMs } = configSchema.parse(config);
  let selected;
  parseCmdline(ctx, createControlProgram((command2) => {
    selected = command2;
  }));
  if (selected === void 0) return;
  const command = selected;
  const exit = ctx.get("appExit");
  const ready = ctx.get("appReady");
  if (exit === void 0 || ready === void 0) throw new Error("clawmaster-control requires the DSH launcher");
  ctx.effect(() => {
    const abort = new AbortController();
    let task;
    const remove = ready.onReady(() => {
      task = (async () => {
        let code = 0;
        try {
          const result = await executeControlCommand(command, {
            requestTimeoutMs,
            connect: (signal) => connectDesktop(resolveDshHome(), signal),
            readInput: (signal) => readCommandInput(process.stdin, maxInputBytes, signal)
          }, abort.signal);
          if (!abort.signal.aborted) process.stdout.write(`${command.json ? JSON.stringify(result.value) : result.text}
`);
        } catch (error) {
          code = 1;
          if (!abort.signal.aborted) {
            const failure = controlFailure(error, command);
            process.stderr.write(command.json ? `${JSON.stringify({ error: failure })}
` : `${failure.message}${failure.requestId === void 0 ? "" : `
\u91CD\u8BD5\u8BF7\u4F7F\u7528\u540C\u4E00\u8BF7\u6C42 ID\uFF1A${failure.requestId}`}
`);
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
  }, "clawmaster-control: command lifetime");
}
export {
  apply,
  createControlProgram,
  inject,
  name,
  readCommandInput
};
