#!/usr/bin/env node
/**
 * preflight.mjs —— ClawMaster / DSH 启动前体检（严格只读）
 *
 * 原则：**不重新发明判定规则，直接调用 DSH 自己的代码。**
 *   A 类 profile bundle 解析失败 → @deepseek-ai/dsh-app-boot 的 loadProfile()
 *   B 类 patch 文件非法        → 同上的 loadProfile() / loadOptionalPatches()
 *   C 类 会话日志身份不符      → session-persistence-jsonl 的 generationLogPath()
 *                                复刻 assertStoredIdentity 的路径不变量
 *   D 类 CSP 补丁缺失          → 直接读 frontend-static 源码
 *   E 类 版本/供应漂移         → runtime/manifest.json 对比 app 内置 bundle 与 node 实际版本
 * 以上调用均不写盘（会写盘的 composeProfile/healProfilesModuleFallback 一律不碰）。
 *
 * 用法：node preflight.mjs [--json-only] [--quiet]
 * 输出：人类可读报告 → stderr；机器可读 JSON → stdout；退出码 0=健康 / 1=有阻断项
 */

import { readFileSync, existsSync, readdirSync, statSync, createReadStream, readlinkSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createZstdDecompress } from 'node:zlib'

const ARGS = new Set(process.argv.slice(2))
const JSON_ONLY = ARGS.has('--json-only')
const QUIET = ARGS.has('--quiet')

const HOME = process.env.DSH_HARNESS_HOME ?? join(homedir(), 'Library/Application Support/DeepSeek Harness')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const APP_ROOT = process.env.DSH_APP_ROOT ?? '/Applications/ClawMaster.app'
// 默认校验**所有**本地 profile（web 与 headless 都在 ~/.dsh/profiles 下）。
// 只盯 web 会漏掉另一条启动路径 —— headless 坏了同样是"运行问题"。
const PROFILES = process.env.DSH_PROFILE !== undefined
  ? [process.env.DSH_PROFILE]
  : (existsSync(join(DSH_HOME, 'profiles'))
      ? readdirSync(join(DSH_HOME, 'profiles'))
          .filter(n => n !== 'node_modules' && existsSync(join(DSH_HOME, 'profiles', n, 'package.json')))
      : ['web'])

const findings = []
const infos = []
const add = (kind, severity, detail, extra = {}) => findings.push({ kind, severity, detail, ...extra })
const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }
const modUrl = p => pathToFileURL(p).href

// ─────────────────────────────────────────── 定位
const manifest = readJson(join(HOME, 'runtime/manifest.json'))
const harnessRoot = manifest?.harnessRoot

if (harnessRoot === undefined || !existsSync(harnessRoot)) {
  add('runtime-root', 'blocker', `runtime/manifest.json 未给出可用的 harnessRoot（${harnessRoot ?? '空'}）`)
  finish()
}
infos.push(['harnessRoot', harnessRoot])
infos.push(['harnessVersion', manifest.harnessVersion ?? '?'])

// ─────────────────────────────────────────── A/B：调用真实 loader
let appBoot
try {
  appBoot = await import(modUrl(join(harnessRoot, 'packages/boot/app-boot/lib/index.js')))
} catch (error) {
  add('loader-import', 'blocker', `无法加载 harness 的 app-boot 模块：${error.message}`)
}

if (appBoot !== undefined) {
  const installAnchor = join(harnessRoot, 'apps/cli/package.json')
  for (const PROFILE of PROFILES) {
  try {
    const profile = appBoot.loadProfile('dsh', PROFILE, installAnchor, DSH_HOME, { userLayer: true })
    infos.push([`profile ${PROFILE}`, `${profile.layers.length} 层`])
  } catch (error) {
    const m = String(error?.message ?? error)
    const pkg = /cannot resolve profile bundle "([^"]+)"/.exec(m)?.[1]
    if (pkg !== undefined) {
      add('bundle-unresolved', 'blocker', `profile "${PROFILE}" 的 bundle 无法解析：${pkg}`, { package: pkg, profile: PROFILE })
    } else if (m.includes('top-level YAML array')) {
      // 措辞随来源不同：profile 层是 "overlay <path>"，home 层是 "patches <path>"
      const file = /(?:overlays?|patches) (\S+)/.exec(m)?.[1]
      const layer = file === undefined ? undefined
        : file === join(DSH_HOME, 'cordis.patch.yml') ? 'home 层'
        : file.startsWith(join(DSH_HOME, 'profiles')) ? `profile 层(${PROFILE})`
        : '其他'
      add('patch-invalid', 'blocker', m, { file, layer })
    } else {
      add('profile-load', 'blocker', m)
    }
  }

  // home 层 patch 只有 composeProfile 会读，必须单独校验。
  for (const [label, file] of [
    ['home 层', join(DSH_HOME, 'cordis.patch.yml')],
    [`profile 层(${PROFILE})`, join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')],
  ]) {
    if (!existsSync(file)) continue
    try { appBoot.loadOptionalPatches('dsh', file) }
    catch (error) {
      add('patch-invalid', 'blocker', `${label} patch 非法：${String(error?.message ?? error)}`, { file, layer: label })
    }
  }
  }
}

// ─────────────────────────────────────────── C：会话日志身份不变量
let generationLogPath
try {
  ({ generationLogPath } = await import(
    modUrl(join(harnessRoot, 'packages/session/session-persistence-jsonl/lib/types/format.js'))
  ))
} catch (error) {
  add('format-import', 'warn', `无法加载会话路径模块，C 类检查跳过：${error.message}`)
}

/** 只解压到第一行，避免整份日志进内存。 */
async function readHeader(file) {
  const rs = createReadStream(file, { highWaterMark: 1 << 16 })
  const dec = createZstdDecompress()
  rs.pipe(dec)
  let buf = Buffer.alloc(0)
  try {
    for await (const chunk of dec) {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl >= 0) { buf = buf.subarray(0, nl); break }
      if (buf.length > 1 << 20) break
    }
  } catch { /* 交给下面判断 */ } finally { rs.destroy(); dec.destroy() }
  if (buf.length === 0) return undefined
  try { return JSON.parse(buf.toString('utf8')) } catch { return undefined }
}

const sessionsRoot = join(DSH_HOME, 'sessions')
if (generationLogPath !== undefined) {
  if (!existsSync(sessionsRoot)) {
    add('sessions-missing', 'warn', `${sessionsRoot} 不存在（全新环境？）`)
  } else {
    let scanned = 0
    for (const wsDir of readdirSync(sessionsRoot)) {
      const wsPath = join(sessionsRoot, wsDir)
      let wst; try { wst = statSync(wsPath) } catch { continue }
      if (!wst.isDirectory()) continue
      for (const entry of readdirSync(wsPath)) {
        const entryPath = join(wsPath, entry)
        let est; try { est = statSync(entryPath) } catch { continue }
        if (!est.isDirectory()) continue
        // 文件名形如 session.v<版本>.jsonl[.zstd]
        const logName = readdirSync(entryPath).find(n => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n))
        if (logName === undefined) continue
        const actual = join(entryPath, logName)
        const version = Number(/^session\.v(\d+)\./.exec(logName)?.[1] ?? 3)
        const compression = logName.endsWith('.zstd') ? 'zstd' : 'plain'
        scanned += 1
        const header = await readHeader(actual)
        if (header === undefined) {
          add('session-unreadable', 'warn', `无法读取会话头（可能本身已损坏）：${actual}`, { path: actual })
          continue
        }
        let canonical
        try { canonical = generationLogPath(sessionsRoot, header.cwd, header.id, version, compression) }
        catch (error) {
          add('session-identity-mismatch', 'blocker',
            `会话头无法推导出存储路径（id="${header.id}" cwd="${header.cwd}"）：${error.message}`,
            { path: actual, quarantineDir: entryPath, workspace: wsDir, sessionId: header.id })
          continue
        }
        if (canonical !== actual) {
          add('session-identity-mismatch', 'blocker',
            `会话日志身份不符：磁盘 ${actual} ；按 header(id="${header.id}", cwd="${header.cwd}") 应为 ${canonical}`
            + ' —— 这会让 dsh web 启动期抛错并以 code 1 退出',
            { path: actual, canonical, quarantineDir: entryPath, workspace: wsDir, sessionId: header.id })
        }
      }
    }
    infos.push(['扫描会话日志', `${scanned} 份`])
  }
}

// ─────────────────────────────────────────── D：CSP 补丁
const frontendStatic = join(harnessRoot, 'packages/host/frontend-static/lib/index.js')
if (!existsSync(frontendStatic)) {
  add('csp-file-missing', 'blocker', `找不到 ${frontendStatic}`, { file: frontendStatic })
} else {
  const src = readFileSync(frontendStatic, 'utf8')
  if (!src.includes("script-src 'self' 'unsafe-eval'")) {
    add('csp-missing', 'blocker', "frontend-static 缺少 script-src 'unsafe-eval'（前端白屏）", { file: frontendStatic, aspect: 'script-src' })
  }
  const styleLine = src.split('\n').find(l => l.includes('style-src')) ?? ''
  if (!styleLine.includes("'unsafe-inline'") || styleLine.includes('styleNonce')) {
    add('csp-missing', 'blocker', "style-src 不是 'self' 'unsafe-inline'（或仍带 nonce，右侧栏错位）", { file: frontendStatic, aspect: 'style-src' })
  }
}

// ─────────────────────────────────────────── F：本地链接农场（profiles/node_modules）
// ~/.dsh/profiles/node_modules 里几百个符号链接**全部指向冻结的 harness 树**，
// 是 app 每次启动重建的派生结构。树被换掉/删掉而链接没重建 → 全部悬空、web profile 直接崩。
// 这是与"运行时树"耦合最强的一处本地依赖，之前完全没人看。
const linkRoot = join(DSH_HOME, 'profiles', 'node_modules')
if (existsSync(linkRoot)) {
  let total = 0, dangling = 0, stale = 0
  const samples = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) {
        total += 1
        let target
        try { target = readlinkSync(p) } catch { continue }
        if (!existsSync(p)) {
          dangling += 1
          if (samples.length < 3) samples.push(`${p} → ${target}（悬空）`)
        } else if (!target.startsWith(harnessRoot)) {
          stale += 1
          if (samples.length < 3) samples.push(`${p} → ${target}（指向别的 harness 目录）`)
        }
      } else if (e.isDirectory()) {
        walk(p, depth + 1)
      }
    }
  }
  walk(linkRoot, 0)
  infos.push(['本地链接农场', `${total} 个符号链接`])
  if (dangling > 0) {
    add('profile-links-broken', 'blocker',
      `profiles/node_modules 有 ${dangling}/${total} 个链接悬空（目标已不存在）：${samples.join('；')}`,
      { root: linkRoot, dangling, total })
  } else if (stale > 0) {
    add('profile-links-stale', 'warn',
      `profiles/node_modules 有 ${stale}/${total} 个链接指向非当前 harness 树：${samples.join('；')}`,
      { root: linkRoot, stale, total })
  }
} else {
  infos.push(['本地链接农场', '不存在（首次启动会重建）'])
}

// ─────────────────────────────────────────── G：本地配套服务
// OpenViking（127.0.0.1:1933）是记忆插件的后端。它挂了**不会**让 dsh web 起不来，
// 但记忆与语义检索会静默降级 —— 属于"你以为还好、其实已经残了"的那类问题，必须显式报告。
const ov = await new Promise(resolve => {
  const req = request({ host: '127.0.0.1', port: 1933, path: '/health', timeout: 2500 }, res => {
    res.resume()
    resolve({ up: true, code: res.statusCode })
  })
  req.on('timeout', () => { req.destroy(); resolve({ up: false, reason: '连接超时' }) })
  req.on('error', e => resolve({ up: false, reason: e.code ?? e.message }))
  req.end()
})
if (ov.up) {
  infos.push(['OpenViking', `HTTP ${ov.code}`])
} else {
  add('local-service-down', 'warn',
    `OpenViking(127.0.0.1:1933) 不可用（${ov.reason}）→ 记忆/语义检索降级运行。`
    + '本机实测原因：~/.dsh/.credentials.yaml 已不存在（凭据迁到 Keychain），而本地启动器仍在读该旧文件',
    { service: 'openviking', reason: ov.reason })
}

// ─────────────────────────────────────────── E：版本面漂移
const appBundle = readJson(join(APP_ROOT, 'Contents/Resources/harness-source/.bundle-manifest.json'))
if (appBundle?.contentSha256 !== undefined && manifest.bundleSha256 !== undefined
    && appBundle.contentSha256 !== manifest.bundleSha256) {
  add('provision-drift', 'blocker',
    `app 内置 bundle(${appBundle.contentSha256.slice(0, 16)}…) ≠ 运行时(${manifest.bundleSha256.slice(0, 16)}…)：`
    + '下次启动会 provision 全新目录，该目录没有 CSP 补丁',
    { appBundle: appBundle.contentSha256, runBundle: manifest.bundleSha256 })
}

if (manifest.nodeVersion !== undefined) {
  const { execFileSync } = await import('node:child_process')
  try {
    const actual = execFileSync(process.execPath, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '')
    if (actual !== manifest.nodeVersion) {
      add('node-drift', 'warn',
        `${manifest.nodePath ?? process.execPath} 实际 v${actual}，provision 时记录 v${manifest.nodeVersion}（node 被换过，当前可用但未记录）`,
        { actual, recorded: manifest.nodeVersion })
    }
  } catch { /* 忽略 */ }
}

// ─────────────────────────────────────────── H：运行期配置文件可解析性（只告警）
// 为什么是 warn 而不是 blocker：实测确认 boot 入口（packages/boot、apps/cli/lib）
// **完全不引用** settings-file —— 这些文件是 host 起来之后才由服务读的，
// 所以它坏了不会让 `dsh web` 退出。但它是"静默降级"那一类：
// settings-file 的注释写得很清楚，不可解析时"每个调用方自己挑策略"，
// 于是你看到的是功能悄悄失效，而不是一条错误。必须显式报告。
{
  const { createRequire } = await import('node:module')
  let yaml = null
  try {
    // 用应用自己那棵树里的 yaml 实例，保证同版本、同行为
    const treeReq = createRequire(join(manifest.harnessRoot ?? HOME, 'packages/settings/settings-file/package.json'))
    yaml = treeReq('yaml')
  } catch { yaml = null }

  const cfg = [
    { file: join(DSH_HOME, 'settings.yaml'), kind: 'yaml', what: '设置' },
    { file: join(DSH_HOME, '.credentials-index.json'), kind: 'json', what: '凭据索引' },
  ]
  for (const c of cfg) {
    if (!existsSync(c.file)) { infos.push([`${c.what}文件`, '不存在（走默认值）']); continue }
    let text = ''
    try { text = readFileSync(c.file, 'utf8') } catch (e) {
      add('runtime-config-unreadable', 'warn', `${c.file} 读不出来（${e.code ?? e.message}）→ ${c.what}会静默失效`)
      continue
    }
    let bad = null
    if (c.kind === 'json') {
      try { const v = JSON.parse(text); if (typeof v !== 'object' || v === null || Array.isArray(v)) bad = '顶层必须是对象' }
      catch (e) { bad = e.message }
    } else if (yaml === null) {
      infos.push([`${c.what}文件`, '跳过（拿不到应用同版的 yaml 解析器）'])
    } else {
      const doc = yaml.parseDocument(text, { prettyErrors: true })
      if (doc.errors.length > 0) bad = doc.errors[0].message
      else {
        const root = text.trim().length === 0 ? {} : doc.toJS()
        if (typeof root !== 'object' || root === null || Array.isArray(root)) bad = '顶层必须是映射（namespace → 配置）'
      }
    }
    if (bad !== null) {
      add('runtime-config-invalid', 'warn',
        `${c.file} 解析失败（${bad}）→ 不会让启动崩，但${c.what}会静默失效。`
        + '实测依据：boot 入口不读这个文件，所以它属于"你以为还好、其实已经残了"那一类',
        { file: c.file })
    }
  }
}

// ─────────────────────────────────────────── I：磁盘余量
// 诚实说明它跟 A–G 的区别：**历史 13 次崩溃里没有一次是它造成的**。
// 但它是 core 之外能让启动硬失败的现实原因——启动要写会话日志，升级还要 provision 一整棵树，
// 磁盘满了就是 ENOSPC；而这是"外部条件"而不是 DSH 的 bug，所以没人会去改代码修它。
// 成本几毫秒，值得一直看着。阈值可用 CLAWMASTER_MIN_FREE_GIB / CLAWMASTER_CRIT_FREE_GIB 覆盖。
{
  const { statfsSync } = await import('node:fs')
  const min = Number(process.env.CLAWMASTER_MIN_FREE_GIB ?? 5)
  const crit = Number(process.env.CLAWMASTER_CRIT_FREE_GIB ?? 1)
  let tight = null
  for (const p of [HOME, DSH_HOME]) {
    try {
      const st = statfsSync(p)
      const free = st.bavail * st.bsize
      if (tight === null || free < tight.free) tight = { p, free }
    } catch { /* 统计不了就不报，不制造噪音 */ }
  }
  if (tight !== null) {
    const gib = tight.free / 1024 ** 3
    if (gib < crit) {
      add('disk-low', 'blocker',
        `${tight.p} 所在卷只剩 ${gib.toFixed(1)} GiB（低于 ${crit} GiB）→ 启动写会话日志 / 升级 provision 都会失败`,
        { freeGiB: Number(gib.toFixed(1)) })
    } else if (gib < min) {
      add('disk-low', 'warn',
        `${tight.p} 所在卷只剩 ${gib.toFixed(1)} GiB（低于 ${min} GiB）→ 还能跑，但升级 provision 可能中途失败`,
        { freeGiB: Number(gib.toFixed(1)) })
    } else {
      infos.push(['磁盘余量', `${gib.toFixed(0)} GiB 可用`])
    }
  }
}

finish()

function finish() {
  // 同一个文件可能被两条路径分别发现（loadProfile 与逐层单独校验），按 种类+层+文件 去重；
  // 层/aspect 是判别位：CSP 的 script-src 与 style-src 同文件不同问题，不能被压成一条。
  const seen = new Set()
  const list = findings.filter(f => {
    const k = `${f.kind}|${f.layer ?? f.aspect ?? ''}|${f.file ?? f.detail}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const blockers = list.filter(f => f.severity === 'blocker')
  const result = { ok: blockers.length === 0, checkedAt: new Date().toISOString(), findings: list, infos: Object.fromEntries(infos) }

  if (!JSON_ONLY && !QUIET) {
    const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', x: '\x1b[0m' }
    const e = s => process.stderr.write(s)
    e(`\n${C.b}ClawMaster 启动前体检${C.x} · ${result.checkedAt}\n`)
    for (const [k, v] of infos) e(`  ${k}: ${v}\n`)
    if (list.length === 0) e(`  ${C.g}✓${C.x} 未发现会导致启动失败的问题\n`)
    for (const f of list) {
      e(`  ${f.severity === 'blocker' ? `${C.r}✗${C.x}` : `${C.y}!${C.x}`} [${f.kind}] ${f.detail}\n`)
    }
    e(blockers.length === 0 ? `${C.g}结论: PASS${C.x}\n\n` : `${C.r}结论: FAIL${C.x} — ${blockers.length} 项会阻断启动\n\n`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.ok ? 0 : 1)
}
