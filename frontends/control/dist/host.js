// src/host.ts
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { randomUUID } from "node:crypto";
import { join as join2 } from "node:path";

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
async function publishConnectionRecord(home, value) {
  const record = parseConnectionRecord(value);
  const path = recordPath(home);
  try {
    await controlDirectory(home, true);
    await withFileLock(path, async () => {
      await controlDirectory(home, false);
      try {
        await privatePath(path, "file");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await writeFileAtomic(path, JSON.stringify(record) + "\n", { mode: 384, dirMode: 448 });
      await privatePath(path, "file");
    });
  } catch (error) {
    throw safeFileFailure(error);
  }
  return async () => {
    try {
      await controlDirectory(home, false);
      await withFileLock(path, async () => {
        const current = await readConnectionRecord(home);
        if (current.instanceId === record.instanceId) await unlink(path);
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT" || error instanceof ControlConnectionError && error.code === "not-running") return;
      throw safeFileFailure(error);
    }
  };
}

// src/host.ts
var name = "clawmaster-control-host";
var inject = ["connection", "webServer"];
async function apply(ctx) {
  const runId = process.env.CLAWMASTER_RUNTIME_RUN_ID;
  const statePath = process.env.CLAWMASTER_RUNTIME_STATE;
  if (runId === void 0 && statePath === void 0) return;
  const home = resolveDshHome();
  if (!runId || statePath !== join2(home, "desktop", "current-runtime.json")) {
    throw new Error("ClawMaster control requires the desktop runtime identity for its Harness home.");
  }
  if (ctx.webServer.host !== "127.0.0.1") throw new Error("ClawMaster control requires a loopback Web Host.");
  const origin = new URL(`http://127.0.0.1:${ctx.webServer.port}`).origin;
  await ctx.effect(() => publishConnectionRecord(home, {
    schemaVersion: 1,
    instanceId: randomUUID(),
    hostPid: process.pid,
    runId,
    origin,
    authenticatedUrl: ctx.connection.authenticatedUrl(origin)
  }), "clawmaster: private CLI login capability");
}
export {
  apply,
  inject,
  name
};
