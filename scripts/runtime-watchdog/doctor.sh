#!/usr/bin/env bash
# doctor.sh —— ClawMaster 运行时体检与自愈的统一入口
#
# 覆盖三件事，对应三条要求：
#   1. core 在运行期间是否被改过   → core 完整性（可写位 / mtime 跳线 / 全树哈希 / 可疑代码扫描）
#   2. core 之外的东西会不会把运行带崩 → 复用 preflight.mjs 的 A–G 七类判定
#   3. doctor 本身                 → 一个命令看全部，可选自动修复
#
# 用法：
#   ./doctor.sh                  # 快速体检（秒级，只读）
#   ./doctor.sh --deep           # 追加全树哈希比对（分钟级，权威，只读）
#   ./doctor.sh --scan           # 追加可疑代码扫描（分钟级，只读）
#   ./doctor.sh --full           # = --deep --scan
#   ./doctor.sh --build-manifest # 重建 core 哈希基线（会写 core 之外的清单文件）
#   ./doctor.sh --snapshot-check # 只查恢复快照能不能用（秒级；--deep 也会带上它）
#   ./doctor.sh --crosscheck     # 基线 × 快照 交叉核对（分钟级；验证"两份物证说的是同一棵树"）
#   ./doctor.sh --fix            # 调用 heal.sh 自愈 core 之外的问题
#   ./doctor.sh --deep --repair-core # 发现漂移就调用 repair-core.sh 还原（会改动 core）
#   ./doctor.sh --quick-repair-core  # 秒级：只查可疑面并还原（常驻医生用）
#   ./doctor.sh --json           # 机器可读输出
#
# 退出码：0=健康 / 1=有问题

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

NODE_BIN="${DSH_NODE:-/usr/local/bin/node}"
# 注意：**不能**复用 lib.sh 的 MANIFEST —— 那个是 runtime/manifest.json。
CORE_MANIFEST="$HERE/core-manifest.sha256"
# core 被冻结的时刻。早于此的 mtime 视为正常（provision 批量写入就是 06:29:0x）。
FREEZE_GUARD="${CLAWMASTER_FREEZE_GUARD:-2026-09-19 06:29:10}"

DO_DEEP=0; DO_SCAN=0; DO_FIX=0; DO_BUILD=0; DO_JSON=0
DO_REPAIR=0; DO_REPAIR_QUICK=0; DO_SNAP=0; SNAP_ONLY=0; DO_CROSS=0
for a in "$@"; do
  case "$a" in
    --deep)           DO_DEEP=1; DO_SNAP=1 ;;
    --scan)           DO_SCAN=1 ;;
    --full)           DO_DEEP=1; DO_SCAN=1; DO_SNAP=1 ;;
    --build-manifest) DO_BUILD=1 ;;
    --snapshot-check) DO_SNAP=1; SNAP_ONLY=1 ;;
    --crosscheck)     DO_CROSS=1 ;;
    --fix)            DO_FIX=1 ;;
    --repair-core)    DO_REPAIR=1 ;;
    --quick-repair-core) DO_REPAIR_QUICK=1 ;;
    --json)           DO_JSON=1 ;;
    -h|--help)        sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

FAILED=0; WARNED=0
report_head() { [ "$DO_JSON" = 1 ] || printf '\n\033[1m%s\033[0m\n' "$*"; }
report_ok()   { [ "$DO_JSON" = 1 ] || ok "$*"; }
report_bad()  { FAILED=$((FAILED + 1)); [ "$DO_JSON" = 1 ] || bad "$*"; }
report_warn() { WARNED=$((WARNED + 1)); [ "$DO_JSON" = 1 ] || warn "$*"; }
# 只打印、不计数、不改判定的细节行（lib.sh 里没有这个helper，别想当然用它）
info() { [ "$DO_JSON" = 1 ] || printf '    %s\n' "$*"; }

CORE="${CLAWMASTER_CORE_ROOT:-$(harness_version_dir)}"
[ -n "$CORE" ] && [ -d "$CORE" ] || { echo "找不到 harness 树" >&2; exit 1; }
CORE_ID="$(basename "$CORE")"

# ───────────────────────────────────────────── 构建 core 哈希基线
if [ "$DO_BUILD" = 1 ]; then
  report_head "重建 core 哈希基线（$(find "$CORE" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件）"
  TMP="/tmp/core-manifest-build.txt"
  {
    echo "# clawmaster core manifest v1"
    echo "# treeId ${CORE_ID}"
    echo "# builtAt $(date '+%F %T %Z')"
    echo "# freezeGuard ${FREEZE_GUARD}"
  } > "$TMP"
  # find -type f 不跟随符号链接，所以 pnpm 的链接环不会让它打转。
  ( cd "$CORE" && find . -type f -print0 | xargs -0 shasum -a 256 ) | sort -k2 >> "$TMP" || true
  n="$(grep -c '^[0-9a-f]\{64\} ' "$TMP" || true)"
  printf '# fileCount %s\n' "$n" >> "$TMP"
  cp "$TMP" "$CORE_MANIFEST"
  report_ok "基线已写入 ${CORE_MANIFEST}（${n} 个文件）"
  exit 0
fi

# ───────────────────────────────────────────── 恢复快照：还原**依赖**它
# 容易犯的错是只检查"文件在不在"。一个被截断的 439MB tar.gz 依然存在、
# 依然以 1f8b 开头，但解不出东西——等到真要还原时才发现就太晚了。
# 所以：存在性 + gzip 魔数 + **全量 CRC 校验**（实测 439MB 几秒，够便宜）。
check_snapshot() {
  local f="${DSH_SNAPSHOT:-$SNAPSHOT}" mb magic
  if [ ! -f "$f" ]; then
    report_bad "恢复快照不存在：${f} —— core 一旦被改就没法还原"
    return 1
  fi
  mb="$(awk -v b="$(stat -f '%z' "$f" 2>/dev/null || echo 0)" 'BEGIN{printf "%.0f", b/1048576}')"
  magic="$(od -An -tx1 -N2 "$f" 2>/dev/null | tr -d ' \n')"
  if [ "$magic" != "1f8b" ]; then
    report_bad "恢复快照不是 gzip（头两字节 ${magic}）：${f}"
    return 1
  fi
  if gzip -t "$f" 2>/dev/null; then
    report_ok "恢复快照可用于还原（${mb} MB，gzip 全量校验通过）"
    return 0
  fi
  report_bad "恢复快照 CRC 校验失败（${mb} MB）：${f} —— 快去重建，否则还原不了"
  return 1
}

# --snapshot-check 单独使用时只做这一件事：这样"退出码 0/1"只有一个含义，
# 不会被 core 可写位之类无关失败污染（第一版就是因为混在一起而无法判定）。
if [ "$SNAP_ONLY" = 1 ]; then
  report_head "恢复快照检查"
  check_snapshot
  printf '\n'
  if [ "$FAILED" = 0 ]; then printf '\033[32m结论: PASS\033[0m\n'; exit 0
  else printf '\033[31m结论: FAIL\033[0m\n'; exit 1; fi
fi

# ───────────────────────────────────────────── 1. core 完整性
report_head "1. core 完整性 · ${CORE_ID}"
CORE_DRIFT=0   # 一旦确认 core 偏离基线就置 1，供 --repair-core 决定是否动手

# 1a 可写位
writable="$(find "$CORE" \( -type f -o -type d \) -perm -u+w 2>/dev/null)"
wn="$(printf '%s' "$writable" | grep -c . || true)"
if [ "$wn" = "0" ]; then report_ok "整树只读（0 个可写条目）"
else
  CORE_DRIFT=1
  report_bad "有 ${wn} 个可写条目："
  printf '%s\n' "$writable" | head -10 | sed 's/^/      /'
fi

# 1b mtime 跳线：冻结之后被碰过的文件。便宜、秒级，能抓住"改完又 chmod 回去"。
#    注意基准必须用冻结时刻，不能随手取"今天 14:00"这种想当然的值——
#    本工具开发时就因为基准取错而漏掉过一次 13:51 的注入。
tripwire="$(find "$CORE" -type f -newermt "$FREEZE_GUARD" 2>/dev/null)"
tn="$(printf '%s' "$tripwire" | grep -c . || true)"
SUSPECTS="$tripwire"
if [ "$tn" = "0" ]; then
  report_ok "冻结（${FREEZE_GUARD}）之后无文件被触碰"
else
  report_warn "冻结之后被触碰过 ${tn} 个文件（mtime 跳线；内容是否真变见下方哈希判定）："
  printf '%s\n' "$tripwire" | sed "s|${CORE}/||" | head -10 | sed 's/^/      /'
fi

# 1c 全树哈希（权威）
if [ "$DO_DEEP" = 1 ]; then
  if [ ! -f "$CORE_MANIFEST" ]; then
    report_warn "没有基线（${CORE_MANIFEST}）—— 先跑 ./doctor.sh --build-manifest"
  else
    CACHE="/tmp/core-deep-verify.txt"
    ( cd "$CORE" && find . -type f -print0 | xargs -0 shasum -a 256 ) | sort -k2 > "$CACHE" || true
    drift="$(diff <(grep '^[0-9a-f]\{64\} ' "$CORE_MANIFEST") "$CACHE" | grep -E '^[<>]' || true)"
    dn="$(printf '%s' "$drift" | grep -c . || true)"
    if [ "$dn" = "0" ]; then
      report_ok "全树哈希与基线逐字节一致（$(grep -c '^[0-9a-f]\{64\} ' "$CORE_MANIFEST" || true) 个文件）"
    else
      CORE_DRIFT=1
      report_bad "全树有 ${dn} 行哈希差异（< 基线 / > 当前）："
      printf '%s\n' "$drift" | head -20 | sed 's/^/      /'
    fi
  fi
fi

# 1d 可疑代码扫描：core 里出现写 /tmp、外联、调试残留的痕迹。
#    这一次被注入的就是 appendFileSync("/tmp/cm-sched-diag.log", ...)，
#    一条 grep 就能抓到——比全树哈希便宜得多，适合每次都跑。
if [ "$DO_SCAN" = 1 ]; then
  # 两种痕迹分开扫，避免一个复杂正则出错就整体失效：
  #   ① 往 /tmp 写文件（本次被注入的就是 appendFileSync("/tmp/cm-sched-diag.log", …)）
  #   ② 调试残留命名
  hits="$(grep -rlE '(appendFileSync|writeFileSync|createWriteStream|appendFile)[[:space:]]*\([[:space:]]*["'"'"']/tmp/' "$CORE" --include='*.js' --include='*.mjs' --include='*.cjs' 2>/dev/null | sed "s|${CORE}/||")"
  hits2="$(grep -rlE 'cm-sched-diag|__fs\.appendFileSync|__debug_trace' "$CORE" --include='*.js' --include='*.mjs' --include='*.cjs' 2>/dev/null | sed "s|${CORE}/||")"
  all_hits="$(printf '%s\n%s\n' "$hits" "$hits2" | grep -v '^$' | sort -u)"
  hn="$(printf '%s' "$all_hits" | grep -c . || true)"
  if [ "$hn" = "0" ]; then report_ok "未发现写 /tmp 或调试残留的可疑代码"
  else
    CORE_DRIFT=1
    report_bad "发现 ${hn} 个可疑文件（core 里不应出现写 /tmp 的代码）："
    printf '%s\n' "$all_hits" | head -10 | sed 's/^/      /'
  fi
fi

# 1e 恢复快照（--deep 也会带上它；实现见文件上方的 check_snapshot）
[ "$DO_SNAP" = 1 ] && check_snapshot

# ───────────────────────────────────────────── 2. core 之外（A–G 七类）
report_head "2. core 之外 · 启动路径是否会被带崩"
if [ -f "$HERE/preflight.mjs" ]; then
  pf_out="$(DSH_HARNESS_HOME="$HARNESS_ROOT" "$NODE_BIN" "$HERE/preflight.mjs" --json-only 2>/dev/null || true)"
  pfn="$(printf '%s' "$pf_out" | jq -r '[.findings[]|select(.severity=="blocker")]|length' 2>/dev/null || echo '?')"
  pfw="$(printf '%s' "$pf_out" | jq -r '[.findings[]|select(.severity=="warn")]|length' 2>/dev/null || echo '?')"
  if [ "$pfn" = "0" ]; then report_ok "core 之外无阻断项（${pfw} 条提醒）"
  else
    report_bad "core 之外有 ${pfn} 项会阻断启动："
    printf '%s' "$pf_out" | jq -r '.findings[]|select(.severity=="blocker")|"      ✗ [\(.kind)] \(.detail)"' 2>/dev/null | head -10
  fi
  if [ "$DO_JSON" = 1 ]; then printf '%s' "$pf_out" | jq -c '{preflight: .}' >/dev/null 2>&1 || true; fi
else
  report_warn "缺少 preflight.mjs，跳过 core 之外检查"
fi

if [ "$DO_FIX" = 1 ]; then
  report_head "2b. 自愈"
  if "$HERE/heal.sh" --quiet; then report_ok "自愈完成，复检通过"
  else report_warn "自愈后仍有阻断项，见 ~/.dsh/logs/clawmaster-heal.log"; fi
fi

# 2c. core 还原：把"检测到漂移"变成"漂移被消掉"。
#     quick 模式只查可疑面（秒级），常驻医生在崩溃瞬间用它；
#     deep 模式全树比对（分钟级），适合人工/周期巡检。
if [ "$DO_REPAIR" = 1 ] || [ "$DO_REPAIR_QUICK" = 1 ]; then
  if [ "$DO_REPAIR_QUICK" = 1 ]; then
    report_head "2c. core 还原（快速模式）"
    if "$HERE/repair-core.sh" --quick; then report_ok "core 已确认与基线一致"
    else report_bad "core 还原失败，需要人工介入（证据在 /tmp/core-repair-${CORE_ID}/evidence）"; fi
  else
    report_head "2c. core 还原（全树模式）"
    if [ "$CORE_DRIFT" = "0" ]; then report_ok "快速检查未见漂移；仍做全树比对确认"
    else warn "快速检查已见漂移，开始全树还原"
    fi
    if "$HERE/repair-core.sh"; then report_ok "core 已回到基线"
    else report_bad "core 还原失败，需要人工介入（证据在 /tmp/core-repair-${CORE_ID}/evidence）"; fi
  fi
fi

# ───────────────────────────────────────────── 3. 服务与版本
report_head "3. 服务与版本"
ov_up=0
if "$NODE_BIN" -e '
const {request}=require("node:http");
const r=request({host:"127.0.0.1",port:1933,path:"/health",timeout:2000},s=>{s.resume();process.exit(0)});
r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1));r.end();
' 2>/dev/null; then ov_up=1; fi

ov_disabled=0
for f in "$DSH_HOME_DIR"/profiles/*/cordis.patch.yml; do
  [ -f "$f" ] || continue
  if grep -qE 'id:[[:space:]]*openviking-memory-runtime' "$f" && grep -A3 -E 'id:[[:space:]]*openviking-memory-runtime' "$f" | grep -q 'disabled:[[:space:]]*true'; then
    ov_disabled=1
  fi
done

if [ "$ov_up" = 1 ]; then
  report_ok "OpenViking(1933) 在线"
elif [ "$ov_disabled" = 1 ]; then
  report_ok "OpenViking(1933) 未运行，且记忆插件已按配置停用（这是有意状态，不算问题）"
else
  report_warn "OpenViking(1933) 不可用，但记忆插件仍启用 → 记忆会静默降级"
fi

# 崩溃重启循环必须被单独点名。它是"看起来已经停用"和"其实每 30 秒失败一次"的区别：
# 后者会持续烧 CPU、把日志灌满，还会把真正的信号埋掉。
# 这里**只报告、不擅自停用别人的服务** —— 停不管用，得让人看见再决定。
ov_status="$(launchctl list 2>/dev/null | awk '$3=="com.clawmaster.openviking"{print $2}')"
if [ -n "$ov_status" ] && [ "$ov_status" != "0" ]; then
  ov_reason="$(tail -1 "$HOME/Library/Application Support/ClawMaster/OpenViking/logs/server.stderr.log" 2>/dev/null | cut -c1-120)"
  report_warn "com.clawmaster.openviking 处于崩溃重启循环（KeepAlive + 上次退出码 ${ov_status}）"
  [ -n "$ov_reason" ] && info "最近一次报错：${ov_reason}"
  info "要停掉：launchctl bootout gui/$UID/com.clawmaster.openviking ｜ 恢复：launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.clawmaster.openviking.plist"
fi

report_ok "harness $(jq -r '.harnessVersion // "?"' "$MANIFEST" 2>/dev/null || echo '?') · app $(/usr/bin/plutil -extract CFBundleShortVersionString raw "$APP_ROOT/Contents/Info.plist" 2>/dev/null || echo '?')"
if [ -f "$DSH_HOME_DIR/logs/clawmaster-health.json" ]; then
  last="$(jq -r '.checkedAt // "?"' "$DSH_HOME_DIR/logs/clawmaster-health.json" 2>/dev/null)"
  report_ok "最近一次 LaunchAgent 体检：${last}"
fi

# ───────────────────────────────────────────── 4. 常驻医生还在不在
# 这一节存在的理由：医生自己挂掉时 launchd 只记一个非零退出，没人会看见，
# 而"常驻"这个保证就已经悄悄没了。所以必须有东西能回答"它现在还在岗吗"。
report_head "4. 常驻医生"
HB_FILE="${CLAWMASTER_HEARTBEAT:-$DSH_HOME_DIR/logs/doctor-heartbeat.json}"
PLIST_FILE="${CLAWMASTER_PLIST:-$HOME/Library/LaunchAgents/com.clawmaster.preflight.plist}"
# 巡检间隔是 300 秒；允许 3 倍余量再判死，避免机器休眠/负载造成的误报。
HB_MAX_AGE="${CLAWMASTER_HEARTBEAT_MAX_AGE:-900}"
if [ ! -f "$PLIST_FILE" ]; then
  report_warn "LaunchAgent 未安装（跑 ./install.sh）—— 现在没有常驻医生"
elif [ ! -f "$HB_FILE" ]; then
  report_bad "装了 LaunchAgent 但医生从没跑过（没有心跳文件）：${HB_FILE}"
else
  hb_epoch="$(jq -r '.epoch // 0' "$HB_FILE" 2>/dev/null || echo 0)"
  case "$hb_epoch" in ''|*[!0-9]*) hb_epoch=0 ;; esac
  hb_age=$(( $(date +%s) - hb_epoch ))
  if [ "$hb_epoch" = "0" ] || [ "$hb_age" -gt "$HB_MAX_AGE" ]; then
    report_bad "常驻医生似乎已经不在了：心跳 ${hb_age} 秒没更新（上限 ${HB_MAX_AGE} 秒）"
  else
    # 先把值取出来再拼消息。（第一版把命令替换写成了 ${jq ...}，shell 直接报 bad substitution；
    # 更糟的是当时的测试只 grep 了消息前缀，照样"通过"了——测试必须断言渲染后的内容。）
    hb_heal="$(jq -r '.healRc // "?"' "$HB_FILE" 2>/dev/null || echo '?')"
    hb_core="$(jq -r '.coreRc // "?"' "$HB_FILE" 2>/dev/null || echo '?')"
    hb_deep="$(jq -r '.deepRc // "?"' "$HB_FILE" 2>/dev/null || echo '?')"
    report_ok "常驻医生在岗（${hb_age} 秒前刚跑过，崩溃处理=${hb_heal} core=${hb_core} 深度=${hb_deep}）"
  fi
fi

# ───────────────────────────────────────────── 5. 基线 × 快照 交叉核对（按需）
# 整个检测/还原链条建立在"基线说的树"和"快照里的树"是同一棵之上。
# 这一步把那个前提**验证**掉，而不是默认它对。（分钟级，所以只在你点名时跑。）
if [ "$DO_CROSS" = 1 ]; then
  report_head "5. 基线 × 快照 交叉核对"
  if [ -x "$HERE/crosscheck-core.sh" ]; then
    if cross_out="$("$HERE/crosscheck-core.sh" 2>&1)"; then
      report_ok "$(printf '%s' "$cross_out" | grep -o '两件物证一致.*' | head -1)"
    else
      report_bad "两份物证不一致 —— 先别信任何一边，人工核对后再重建："
      printf '%s\n' "$cross_out" | grep -E '^✗|^  ' | head -10 | sed 's/^/      /'
    fi
  else
    report_warn "缺少 crosscheck-core.sh，跳过交叉核对"
  fi
fi

# ───────────────────────────────────────────── 结论
printf '\n'
if [ "$DO_JSON" = 1 ]; then
  printf '{"failed":%s,"warned":%s,"core":"%s","deep":%s,"scan":%s}\n' "$FAILED" "$WARNED" "$CORE_ID" "$DO_DEEP" "$DO_SCAN"
fi
if [ "$FAILED" = "0" ]; then
  printf '\033[32m结论: PASS\033[0m'
  [ "$WARNED" != "0" ] && printf '（%s 条提醒）' "$WARNED"
  printf '\n'
  [ "$DO_DEEP" = 0 ] && printf '\033[33m提示\033[0m：未做全树哈希比对；要权威判定请跑 ./doctor.sh --deep\n'
  exit 0
else
  printf '\033[31m结论: FAIL\033[0m — %s 项失败' "$FAILED"
  [ "$WARNED" != "0" ] && printf '，%s 条提醒' "$WARNED"
  printf '\n'
  exit 1
fi
