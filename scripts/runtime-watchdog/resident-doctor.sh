#!/usr/bin/env bash
# resident-doctor.sh —— 常驻医生：崩溃发生即刻修复
#
# 为什么是"事件驱动"而不是"定时轮询"：
#   boot.log 里 21 次崩溃 → 下次 boot 的间隔，实测是 9.6 秒 到 6 小时不等
#   （1–30 分钟居多）——桌面 App 的自动重试**不可靠**。
#   所以关键不是我去重启 App，而是**在它意识到自己该重试之前，把病因修掉**。
#
# 触发方式（由 LaunchAgent 提供）：
#   · WatchPaths 盯 boot.log  → 崩溃行一落盘就被唤醒（实测约 1 秒）
#   · StartInterval 300       → 兜底巡检
#   · RunAtLoad               → 登录即跑
#
# 幂等：同一次崩溃只处理一次（状态记在 ~/.dsh/logs/doctor-state.json）。
#
# 用法：
#   ./resident-doctor.sh            # 正常工作（被 launchd 调用）
#   ./resident-doctor.sh --verbose  # 人读输出
#   ./resident-doctor.sh --force    # 忽略"已处理过"，强制走一遍崩溃处理
#   ./resident-doctor.sh --deep-now # 立刻做一次深度核对（不等间隔）
#   CLAWMASTER_BOOT_LOG=<path>      # 测试用：换一个 boot.log 来源
#   CLAWMASTER_DEEP_INTERVAL=<秒>   # 深度核对间隔，默认 21600（6 小时）

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
HARNESS_DIR="${DSH_HARNESS_HOME:-$HOME/Library/Application Support/DeepSeek Harness}"
BOOT_LOG="${CLAWMASTER_BOOT_LOG:-$HARNESS_DIR/boot.log}"
NODE_BIN="${DSH_NODE:-/usr/local/bin/node}"
LOGDIR="$DSH_HOME_DIR/logs"
DOCTOR_LOG="$LOGDIR/clawmaster-doctor.log"
STATE="$LOGDIR/doctor-state.json"
RELAUNCH_STATE="$LOGDIR/doctor-relaunch.json"
# 周期性深度核对：quick 模式的盲区是**已证明**的（倒填 mtime + 改回只读就看不见），
# 只跑 quick 等于承认"精心掩盖的改动永远发现不了"。所以按间隔做全树哈希。
DEEP_STATE="${CLAWMASTER_DEEP_STATE:-$LOGDIR/doctor-deep.json}"
DEEP_LOCK="$LOGDIR/.doctor-deep.lock"
DEEP_INTERVAL="${CLAWMASTER_DEEP_INTERVAL:-21600}"   # 默认 6 小时
DEEP_STALE_LOCK="${CLAWMASTER_DEEP_STALE_LOCK:-3600}" # 锁超过 1 小时视为残留
# 被调用的工具（heal / repair-core / doctor）所在目录。
# 留出这个接缝的真正原因：测试必须能跑完整控制流，而不能真的去 heal 真实 ~/.dsh，
# 也不能真的扫一遍 49028 个文件（几分钟，测试跑不动）。
# 注意 heal.sh 认的是 DSH_DSH_HOME 而不是 DSH_HOME——测试里只设 DSH_HOME 是拦不住它的。
BIN_DIR="${CLAWMASTER_BIN_DIR:-$HERE}"

VERBOSE=0; FORCE=0; FORCE_DEEP=0
for a in "$@"; do
  case "$a" in
    --verbose)   VERBOSE=1 ;;
    --force)     FORCE=1 ;;
    --deep-now)  FORCE_DEEP=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  esac
done

mkdir -p "$LOGDIR" 2>/dev/null
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$DOCTOR_LOG" >&2; }
say() { [ "$VERBOSE" = 1 ] && printf '%s\n' "$*"; return 0; }

# ── 周期性深度核对（补齐 quick 模式的盲区）─────────────────────────────
# quick 模式看不见"倒填 mtime + 改回只读"的改动，这是**测试证明过**的盲区。
# 只跑 quick 就等于承认"精心掩盖的改动永远不会被发现"，所以这里按间隔做全树哈希。
# 全树哈希要几分钟，而 launchd 可能短时间内多次唤醒（WatchPaths + 每 300 秒），
# 因此必须拿锁，避免几份全树扫描叠着跑把机器压垮。
deep_due() {
  [ "$FORCE_DEEP" = 1 ] && return 0
  [ -f "$DEEP_STATE" ] || return 0            # 从没跑过 → 立刻跑一次
  local last now
  last="$(jq -r '.lastDeepAt // 0' "$DEEP_STATE" 2>/dev/null || echo 0)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  now="$(date +%s)"
  [ "$((now - last))" -ge "$DEEP_INTERVAL" ]
}

periodic_deep() {
  local deep_rc=0 age last
  if ! deep_due; then say "深度核对未到期（间隔 ${DEEP_INTERVAL}s），跳过"; return 0; fi
  if ! mkdir "$DEEP_LOCK" 2>/dev/null; then
    last="$(stat -f '%m' "$DEEP_LOCK" 2>/dev/null || echo 0)"
    age=$(( $(date +%s) - last ))
    if [ "$age" -gt "$DEEP_STALE_LOCK" ]; then
      log "深度核对的锁已残留 ${age}s —— 清掉重来"
      rmdir "$DEEP_LOCK" 2>/dev/null
      mkdir "$DEEP_LOCK" 2>/dev/null || { log "深度核对：拿不到锁，本轮跳过"; return 0; }
    else
      say "深度核对已在运行（锁存在 ${age}s），本轮跳过"
      return 0
    fi
  fi

  log "开始周期性深度核对（全树哈希 + 可疑代码扫描 + 恢复快照）"
  local out=""
  if [ -x "$BIN_DIR/doctor.sh" ]; then
    out="$("$BIN_DIR/doctor.sh" --deep --scan 2>&1)"
    printf '%s\n' "$out" >> "$DOCTOR_LOG"
  fi

  # 判定顺序是有讲究的：先看"还原能力"再看"是否需要还原"。
  # 快照坏了的时候，就算哈希一致也必须喊出来——因为那一刻 core 一旦被改就修不回来了，
  # 而这恰恰是最容易被漏掉的一种"看起来没事"。而且它没有自动解法，只能让人去重建。
  if printf '%s' "$out" | grep -q '恢复快照不存在\|恢复快照不是 gzip\|恢复快照 CRC 校验失败'; then
    deep_rc=1
    log "!! 恢复快照不可用：core 一旦被改就还原不了，必须人工重建快照（doctor.sh --snapshot-check 可单独复查）"
  elif printf '%s' "$out" | grep -q '全树哈希与基线逐字节一致' \
       && printf '%s' "$out" | grep -q '恢复快照可用于还原' \
       && ! printf '%s' "$out" | grep -q '个可疑文件'; then
    log "深度核对通过：core 与基线逐字节一致、无可疑代码、恢复快照可用"
  elif [ -z "$out" ]; then
    deep_rc=1
    log "!! 深度核对没有产出结果（doctor.sh 缺失或崩溃），需要人工介入"
  else
    log "!! 深度核对发现漂移，调用全树还原（repair-core.sh）"
    if [ -x "$BIN_DIR/repair-core.sh" ] && "$BIN_DIR/repair-core.sh" >> "$DOCTOR_LOG" 2>&1; then
      log "全树还原完成，core 已回到基线"
    else
      deep_rc=1
      log "!! 全树还原失败——需要人工介入（证据在 /tmp/core-repair-*/evidence）"
    fi
  fi

  printf '{"lastDeepAt":%s,"at":"%s","rc":%s}\n' \
    "$(date +%s)" "$(date '+%F %T')" "$deep_rc" > "$DEEP_STATE" 2>/dev/null
  rmdir "$DEEP_LOCK" 2>/dev/null
  return "$deep_rc"
}

[ -f "$BOOT_LOG" ] || say "没有 boot.log（${BOOT_LOG}），跳过崩溃判定"

# ── 1. 找最后一次崩溃，以及它之后有没有新的 boot session
#     只有"崩溃之后还没成功起来"才算需要处理：
#     崩溃 → boot 成功 = App 自己恢复了，医生不必插手（但要记一笔）。
#     注意：**这里不再直接 exit** —— 深度核对是周期性的，和有没有崩溃无关，
#     早期版本用 exit 早退，导致健康机器上深度核对永远轮不到。
last_crash=0; last_boot=0; crash_line=0
if [ -f "$BOOT_LOG" ]; then
  read -r last_crash last_boot crash_line <<EOF
$(awk '
  /=== boot session started ===/ { boot=$1 }
  /ERROR dsh web 进程已退出/       { crash=$1; crashline=NR }
  END { printf "%s %s %s\n", (crash?crash:0), (boot?boot:0), (crashline?crashline:0) }
' "$BOOT_LOG")
EOF
fi

say "最后崩溃: ${last_crash:-无}  最后 boot: ${last_boot:-无}"

need_repair=0
if [ "${last_crash:-0}" = "0" ]; then
  say "boot.log 里没有任何崩溃记录"
else
  # 已处理过同一次崩溃？跳过（幂等）
  handled=0
  if [ -f "$STATE" ] && [ "$FORCE" = 0 ]; then
    prev="$(jq -r '.lastHandledCrash // 0' "$STATE" 2>/dev/null || echo 0)"
    [ "$prev" = "$last_crash" ] && handled=1
  fi
  if [ "$handled" = 1 ]; then
    say "这次崩溃（${last_crash}）已处理过，跳过"
  elif [ "${last_boot:-0}" -gt "${last_crash:-0}" ] 2>/dev/null; then
    # 崩溃之后已经成功 boot 过？说明 App 自己恢复了；记一笔即可，不重复修复。
    # 但仍要把状态推进，避免下次把同一个旧崩溃当成新的。
    log "检测到历史崩溃 ${last_crash}，但之后已有成功 boot ${last_boot} —— App 已自行恢复，仅记录"
    printf '{"lastHandledCrash":"%s","handledAt":"%s","outcome":"self-recovered"}\n' \
      "$last_crash" "$(date '+%F %T')" > "$STATE"
  else
    need_repair=1
  fi
fi

heal_rc=0; core_rc=0; relaunched=0
if [ "$need_repair" = 1 ]; then

# ── 2. 真的需要修：崩溃了而且还没起来
log "检测到崩溃且尚未恢复（crash=${last_crash}，boot.log 第 ${crash_line} 行）——立即修复"

# 2a. 先修 core 之外（A–G）：这是历史上 13 次崩溃的全部来源
"$BIN_DIR/heal.sh" --quiet || heal_rc=1
if [ "$heal_rc" = 0 ]; then
  log "core 之外已修复（heal.sh 退出 0）"
else
  log "!! heal.sh 未能全部修好——多半是受保护核心缺失或需要网络，需要人工介入"
fi

# 2b. core 完整性：崩溃时最该怀疑的就是"core 在运行中被改了"。
#     quick 模式只查可疑面（冻结后 mtime 跳线 / 可写位 / 基线外新增文件），秒级；
#     真发现漂移就从快照还原并重新冻结——这是"立马修复"的核心动作。
if [ -x "$BIN_DIR/repair-core.sh" ]; then
  if "$BIN_DIR/repair-core.sh" --quick >> "$DOCTOR_LOG" 2>&1; then
    log "core 完整性：与基线一致（快速模式）"
  else
    core_rc=1
    log "!! core 还原失败——需要人工介入（证据在 /tmp/core-repair-*/evidence）"
  fi
else
  log "!! 缺少 repair-core.sh，无法还原 core"
fi

# 2c. 顺手做一次廉价体检（只读位 + mtime 跳线 + core 之外 A–G），确认还有没有别的病因
if [ -x "$BIN_DIR/doctor.sh" ]; then
  if "$BIN_DIR/doctor.sh" >> "$DOCTOR_LOG" 2>&1; then
    log "doctor 快速体检：core 完好、core 之外无阻断项"
  else
    log "!! doctor 快速体检未通过，详见 ${DOCTOR_LOG}"
  fi
fi

# ── 3. 如果修好了但 App 一直没重试，推它一把
#    实测 App 的重试间隔从 9.6 秒到数小时都有，不能指望它。
port_up() {
  "$NODE_BIN" -e '
const {request}=require("node:http");
const r=request({host:"127.0.0.1",port:17890,path:"/",timeout:1500},s=>{s.resume();process.exit(0)});
r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1));r.end();
' 2>/dev/null
}

relaunched=0
if [ "$need_repair" = 1 ] && [ "$heal_rc" = 0 ] && [ "$core_rc" = 0 ]; then
  sleep 8
  if port_up; then
    log "Host 已自己起来（端口 17890 存活），无需助推"
  else
    # 限流：10 分钟内最多推 3 次，避免和 App 自己的重试打架
    now="$(date +%s)"
    recent=0
    if [ -f "$RELAUNCH_STATE" ]; then
      recent="$(jq -r --argjson now "$now" '[.times[]|select(($now - .) < 600)]|length' "$RELAUNCH_STATE" 2>/dev/null || echo 0)"
    fi
    if [ "${recent:-0}" -ge 3 ]; then
      log "Host 仍未起来，但 10 分钟内已助推 ${recent} 次 —— 停止助推，避免重启风暴"
    else
      log "Host 未起来，助推一次：open -a ClawMaster"
      /usr/bin/open -a ClawMaster 2>/dev/null && relaunched=1
      if [ -f "$RELAUNCH_STATE" ]; then
        jq -c --argjson now "$now" '.times = ((.times // []) + [$now] | map(select(($now - .) < 3600)))' \
          "$RELAUNCH_STATE" > "${RELAUNCH_STATE}.tmp" 2>/dev/null && mv "${RELAUNCH_STATE}.tmp" "$RELAUNCH_STATE"
      else
        printf '{"times":[%s]}\n' "$now" > "$RELAUNCH_STATE"
      fi
    fi
  fi
fi

if [ "$need_repair" = 1 ]; then
  printf '{"lastHandledCrash":"%s","handledAt":"%s","healRc":%s,"coreRc":%s,"relaunched":%s}\n' \
    "$last_crash" "$(date '+%F %T')" "$heal_rc" "$core_rc" "$relaunched" > "$STATE"
  log "本轮崩溃处理完毕（heal=${heal_rc} core=${core_rc} relaunch=${relaunched}）"
fi
fi   # ← 结束「这次崩溃需要处理」的分支（深度核对在分支外，健康时也要走）

# ── 4. 周期性深度核对（与有没有崩溃无关，到期就跑）
deep_rc=0
periodic_deep || deep_rc=1

# ── 5. 心跳：谁来看着守望者
# "常驻"如果没法被验证，那就只是句话。医生自己挂掉时 launchd 只会记一个非零退出，
# 没有任何人会看见 —— 而"常驻"这个保证就已经悄悄没了。
# 所以每次运行都盖一个时间戳，让 doctor.sh 能回答"医生现在还在不在岗"。
HEARTBEAT="${CLAWMASTER_HEARTBEAT:-$LOGDIR/doctor-heartbeat.json}"
printf '{"at":"%s","epoch":%s,"pid":%s,"healRc":%s,"coreRc":%s,"deepRc":%s,"lastCrash":"%s"}\n' \
  "$(date '+%F %T')" "$(date +%s)" "$$" "$heal_rc" "$core_rc" "$deep_rc" "${last_crash:-0}" \
  > "$HEARTBEAT.tmp" 2>/dev/null && mv "$HEARTBEAT.tmp" "$HEARTBEAT" 2>/dev/null

if [ "$heal_rc" = 0 ] && [ "$core_rc" = 0 ] && [ "$deep_rc" = 0 ]; then exit 0; else exit 1; fi
