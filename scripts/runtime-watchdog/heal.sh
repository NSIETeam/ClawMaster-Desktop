#!/usr/bin/env bash
# heal.sh —— ClawMaster 启动前自愈
#
# 流程：preflight 体检 → 只对「有确定解法」的问题动手 → 复检 → 写日志与状态文件。
# 不确定、或可能丢用户意图的问题一律**不动手**，只上报并非零退出。
#
# 可自愈：
#   session-identity-mismatch  → 把该会话目录移出 sessions 树（隔离，不删除）
#   patch-invalid              → 备份后写回顶层空数组 []
#   csp-*                      → 调用 freeze.sh 重打 CSP 补丁
#   bundle-unresolved          → 先尝试 dsh plugin install；仍失败且该包是 optional 才降级
# 只上报：
#   node-drift（换 node 风险更大）、provision-drift（等下次启动 provision）
#
# 用法：./heal.sh [--dry-run] [--quiet]
# 退出码：0 = 体检通过（可能刚修好）；1 = 仍有阻断项

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
QUARANTINE="$DSH_HOME_DIR/sessions-quarantine"
LOGDIR="$DSH_HOME_DIR/logs"
LOG="$LOGDIR/clawmaster-heal.log"
STATUS="$DSH_HOME_DIR/logs/clawmaster-health.json"
NODE="${DSH_NODE:-/usr/local/bin/node}"

DRY=0; QUIET=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --quiet)   QUIET=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGDIR" 2>/dev/null
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }
ts()  { date '+%Y%m%d-%H%M%S'; }
say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*" >&2; }

# ───────────────────────────────────────────── 受保护核心
# 「运行时保证正常运行的内容」：这些是 DSH 的外壳本身，摘掉就没有运行时了。
# 任何自动流程都不许改动它们 —— 它们出问题只上报，不自动处理。
PROTECTED_CORE="${CLAWMASTER_HEAL_PROTECTED_EXTRA:+$CLAWMASTER_HEAL_PROTECTED_EXTRA }@deepseek-ai/dsh-base @deepseek-ai/dsh-web-app @deepseek-ai/dsh-acp-app @deepseek-ai/dsh-sdk-app @deepseek-ai/dsh-headless"
is_protected_core() {
  case " $PROTECTED_CORE " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# ───────────────────────────────────────────── 并发锁
# LaunchAgent 定时触发与手动执行可能撞上；同一时刻只允许一个 heal 在跑，
# 否则两边可能同时对同一个 package.json 做「备份 → 改写」，互相覆盖。
LOCKDIR="$DSH_HOME_DIR/.heal.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # 陈旧锁（进程被 kill 掉没清）超过 10 分钟视为失效
  if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    log "清理陈旧锁 ${LOCKDIR}"
    rmdir "$LOCKDIR" 2>/dev/null
    mkdir "$LOCKDIR" 2>/dev/null || { log "另一个 heal 正在运行，退出"; exit 0; }
  else
    [ "$QUIET" = 1 ] || printf '另一个 heal 正在运行，退出\n' >&2
    exit 0
  fi
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# ───────────────────────────────────────────── 1. 体检
run_preflight() { "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null; }

report="$(run_preflight)"; rc=$?
if [ "$rc" = 0 ]; then
  log "体检通过，无需自愈"
  printf '%s' "$report" > "$STATUS" 2>/dev/null
  exit 0
fi

blockers="$(printf '%s' "$report" | jq -r '.findings[] | select(.severity=="blocker") | "\(.kind)\t\(.detail)"' 2>/dev/null)"
n_blockers="$(printf '%s' "$blockers" | grep -c . || true)"
log "体检发现 $n_blockers 项阻断问题，开始自愈$( [ "$DRY" = 1 ] && printf '（dry-run）' )"
[ "$QUIET" = 1 ] || printf '%s\n' "$blockers" | sed 's/^/    /' >&2

fixed=0

# ───────────────────────────────────────────── 2. C：隔离身份不符的会话
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  [ -d "$dir" ] || continue
  ws="$(basename "$(dirname "$dir")")"
  dest="$QUARANTINE/$ws/$(basename "$dir").$(ts)"
  if [ "$DRY" = 1 ]; then
    log "[dry-run] 将隔离 $dir → $dest"
  else
    mkdir -p "$QUARANTINE/$ws" && mv "$dir" "$dest" 2>/dev/null \
      && { log "已隔离会话目录（移出 sessions 树，未删除）：$dest"; fixed=$((fixed+1)); } \
      || log "隔离失败：$dir"
  fi
done < <(printf '%s' "$report" | jq -r '.findings[] | select(.kind=="session-identity-mismatch") | .quarantineDir' 2>/dev/null)

# ───────────────────────────────────────────── 3. B：修复非法 patch 文件
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  # 只在它确实不是「顶层数组」时改；已经合法就不碰
  if "$NODE" -e '
      const fs=require("node:fs");
      const raw=fs.readFileSync(process.argv[1],"utf8");
      try { const p=/^\s*\[/.test(raw); process.exit(p?0:1) } catch { process.exit(1) }
    ' "$f" 2>/dev/null; then
    log "patch 文件看似已是数组，跳过：$f"
    continue
  fi
  bak="$f.bak-$(ts)"
  if [ "$DRY" = 1 ]; then
    log "[dry-run] 将备份 $f → $bak 并写回 []"
  else
    cp -p "$f" "$bak" 2>/dev/null
    # 只写最小合法内容：顶层空数组。不加注释，避免任何解析歧义；原件已在 $bak。
    printf '[]\n' > "$f" \
      && { log "已修复非法 patch 文件：${f}（原件备份 ${bak}）"; fixed=$((fixed+1)); } \
      || log "修复失败：$f"
  fi
done < <(printf '%s' "$report" | jq -r '.findings[] | select(.kind=="patch-invalid") | .file // empty' 2>/dev/null | sort -u)

# ───────────────────────────────────────────── 4. D：重打 CSP 补丁（交给 freeze.sh）
if printf '%s' "$report" | jq -e '.findings[] | select(.kind|startswith("csp"))' >/dev/null 2>&1; then
  if [ "$DRY" = 1 ]; then
    log "[dry-run] 将执行 freeze.sh 重打 CSP 补丁"
  else
    log "检测到 CSP 补丁缺失，调用 freeze.sh 重打"
    if "$HERE/freeze.sh" >/dev/null 2>&1; then fixed=$((fixed+1)); log "freeze.sh 完成"
    else log "freeze.sh 失败（可能权限不足），CSP 未修复"; fi
  fi
fi

# ───────────────────────────────────────────── 5. A：未解析的 bundle
# 用户要求：**缺 tool 不能耽误继续任务**。只要不是「保证正常运行的核心」，
# 装不上就从 bundles 里摘掉，让 dsh web 照常起来；核心组件绝不自动摘除。
#
# 必须循环：loadProfile 在**第一个**解析不了的 bundle 上就抛错，一次只能暴露一个。
# 不循环的话，多个插件缺失时一次自愈只修得掉一个。
manifest_pkg="$DSH_HOME_DIR/profiles/$PROFILE/package.json"
HARNESS_DIR="${DSH_HARNESS_HOME:-$HOME/Library/Application Support/DeepSeek Harness}"
cli="$HARNESS_DIR/apps/cli/lib/bin.js"

attempt=0
while [ "$attempt" -lt 30 ]; do
  attempt=$((attempt+1))
  # 注意：不能写成 `if ! preflight | jq ...`。本脚本开着 pipefail，而 preflight
  # 故意用退出码 1 表示"有问题"，整条管道会被它带偏、误判成"已恢复"。
  # 所以先把 JSON 抓下来，只让 jq 决定真假。
  now_json="$("$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null || true)"
  pkg="$(printf '%s' "$now_json" | jq -r '[.findings[]|select(.kind=="bundle-unresolved")][0].package // empty' 2>/dev/null)"
  [ -n "$pkg" ] || break
  log "bundle 无法解析：$pkg"

  if [ "$DRY" = 1 ]; then
    log "[dry-run] 将尝试 dsh plugin --profile $PROFILE install；若仍不可解析则从 bundles 摘除"
    break
  fi

  if [ "${CLAWMASTER_HEAL_NO_INSTALL:-0}" = 1 ]; then
    log "跳过插件安装尝试（CLAWMASTER_HEAL_NO_INSTALL=1）"
  elif [ -f "$cli" ]; then
    log "尝试 dsh plugin --profile $PROFILE install（可能耗时/需网络）"
    if DSH_HOME="$DSH_HOME_DIR" "$NODE" "$cli" plugin --profile "$PROFILE" install >>"$LOG" 2>&1; then
      log "插件安装命令返回成功"
    else
      log "插件安装命令失败，详见 $LOG"
    fi
  fi

  now_json="$("$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null || true)"
  if ! printf '%s' "$now_json" | jq -e --arg p "$pkg" '.findings[] | select(.kind=="bundle-unresolved" and .package==$p)' >/dev/null 2>&1; then
    log "bundle 已恢复：$pkg"; fixed=$((fixed+1)); continue
  fi

  if is_protected_core "$pkg"; then
    log "!! ${pkg} 属于受保护核心，绝不自动摘除（摘了运行时就不存在了）—— 需要人工修复"
    break
  fi

  bak="$manifest_pkg.bak-$(ts)"
  cp -p "$manifest_pkg" "$bak"
  tmp="$(mktemp)"
  jq --arg p "$pkg" '.dsh.profile.bundles -= [$p]' "$manifest_pkg" > "$tmp" && mv "$tmp" "$manifest_pkg" \
    && { log "已把无法解析的 ${pkg} 从 bundles 摘除（备份 ${bak}），本次启动不再被它阻断"; fixed=$((fixed+1)); } \
    || { log "摘除失败：$pkg"; break; }
done
[ "$attempt" -ge 30 ] && log "警告：bundle 处理达到 30 次上限，可能仍有残留"

# ───────────────────────────────────────────── 6. 复检
final="$(run_preflight)"; frc=$?
printf '%s' "$final" > "$STATUS" 2>/dev/null
if [ "$frc" = 0 ]; then
  log "自愈完成，复检通过（本轮修复 $fixed 项）"
  exit 0
else
  remaining="$(printf '%s' "$final" | jq -r '.findings[] | select(.severity=="blocker") | .kind' 2>/dev/null | tr '\n' ' ')"
  log "复检仍有阻断项：$remaining"
  [ "$QUIET" = 1 ] || printf '%s' "$final" | jq -r '.findings[] | select(.severity=="blocker") | "    ✗ [\(.kind)] \(.detail)"' >&2
  exit 1
fi
