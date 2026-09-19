#!/usr/bin/env bash
# resident-doctor-test.sh —— 常驻医生的行为测试
#
# 验证四组行为：
#   1. 崩溃且尚未恢复  → 必须立刻处理
#   2. 同一次崩溃再来  → 必须幂等跳过（否则会反复 heal）
#   3. 崩溃之后已有成功 boot → App 自己恢复了，只记录、不插手
#   4. 周期性深度核对  → 到期才跑、拿锁防叠跑、发现漂移就全树还原
#
# 全程用 fixture 的 boot.log / DSH_HOME / 桩件，**不碰真实系统**，
# 也**不会真的扫一遍 49028 个文件**（那要几分钟，测试跑不动）。
# 桩件只复刻输出的"判定标记"，控制流是真的。

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/.fixture-doctor"
PASS=0; FAIL=0
ck() { if [ "$1" = "$2" ]; then printf '  \033[32m✓\033[0m %s\n' "$3"; PASS=$((PASS+1));
       else printf '  \033[31m✗\033[0m %s（期望 %s，实际 %s）\n' "$3" "$2" "$1"; FAIL=$((FAIL+1)); fi }

rm -rf "$FIX"; mkdir -p "$FIX/logs" "$FIX/bin"

# ── 桩件：doctor 与 repair-core 只输出常驻医生用来判定的那几行标记
cat > "$FIX/bin/doctor.sh" <<'STUB'
#!/usr/bin/env bash
echo "doctor --deep --scan $*" >> "$FIX_CALLS"
if [ -e "$FIX_SNAPSHOT_BAD" ]; then
  echo "  ✓ 全树哈希与基线逐字节一致（49028 个文件）"
  echo "  ✗ 恢复快照 CRC 校验失败（439 MB）：/tmp/x —— 快去重建，否则还原不了"
  exit 1
fi
if [ -e "$FIX_DRIFT" ]; then
  echo "  ✗ 全树有 3 行哈希差异（< 基线 / > 当前）："
  exit 1
fi
echo "  ✓ 全树哈希与基线逐字节一致（49028 个文件）"
echo "  ✓ 未发现写 /tmp 或调试残留的可疑代码"
echo "  ✓ 恢复快照可用于还原（439 MB，gzip 全量校验通过）"
exit 0
STUB
cat > "$FIX/bin/repair-core.sh" <<'STUB'
#!/usr/bin/env bash
echo "repair-core $*" >> "$FIX_CALLS"
if [ -e "$FIX_REPAIR_FAIL" ]; then
  echo "  ✗ 快照解压失败"
  exit 1
fi
echo "  ✓ core 已回到基线（还原 3，移出 0）"
exit 0
STUB
chmod +x "$FIX/bin/doctor.sh" "$FIX/bin/repair-core.sh"

# heal.sh 的桩件：必须存在，否则崩溃路径会去调**真实的** heal.sh。
# 这一点是有教训的：heal.sh 读的是 DSH_DSH_HOME 而不是 DSH_HOME，
# 测试里只设 DSH_HOME 拦不住它，会真的去动 ~/.dsh。
cat > "$FIX/bin/heal.sh" <<'STUB'
#!/usr/bin/env bash
echo "heal $*" >> "$FIX_CALLS"
if [ -e "$FIX_HEAL_FAIL" ]; then echo "  ✗ 仍有阻断项"; exit 1; fi
echo "  ✓ 自愈完成"
exit 0
STUB
chmod +x "$FIX/bin/heal.sh"

export FIX_CALLS="$FIX/calls.log"
export FIX_DRIFT="$FIX/DRIFT"
export FIX_REPAIR_FAIL="$FIX/REPAIR_FAIL"
export FIX_HEAL_FAIL="$FIX/HEAL_FAIL"
export FIX_SNAPSHOT_BAD="$FIX/SNAPSHOT_BAD"
: > "$FIX_CALLS"

# 让深度核对"未到期"，好让崩溃类场景保持干净
seed_deep_fresh() { printf '{"lastDeepAt":%s,"at":"seed","rc":0}\n' "$(date +%s)" > "$FIX/logs/doctor-deep.json"; }
calls() { grep -c . "$FIX_CALLS" 2>/dev/null || true; }

DEEP_INTERVAL=21600
run_doctor() {
  CLAWMASTER_BOOT_LOG="$FIX/boot.log" DSH_HOME="$FIX" \
  CLAWMASTER_BIN_DIR="$FIX/bin" \
  CLAWMASTER_DEEP_STATE="$FIX/logs/doctor-deep.json" \
  CLAWMASTER_DEEP_INTERVAL="$DEEP_INTERVAL" \
  "$HERE/resident-doctor.sh" --verbose "$@" 2>&1
}

seed_deep_fresh

# ── 场景 1：崩溃且尚无新的 boot session
printf '1789799994857 === boot session started ===\n1789799994944 provision complete\n1789800000000 ERROR dsh web 进程已退出 (code 1)\n' > "$FIX/boot.log"
out1="$(run_doctor)"; rc1=$?
ck "$(printf '%s' "$out1" | grep -c '检测到崩溃且尚未恢复')" "1" "场景1：识别出「崩溃且未恢复」并立刻处理"
ck "$(jq -r '.lastHandledCrash' "$FIX/logs/doctor-state.json" 2>/dev/null)" "1789800000000" "场景1：处理状态已落盘（供幂等用）"
ck "$([ -s "$FIX/logs/clawmaster-doctor.log" ] && echo yes)" "yes" "场景1：写入了常驻医生日志"
ck "$(printf '%s' "$out1" | grep -c '深度核对未到期')" "1" "场景1：深度核对未到期时被跳过（不拖慢崩溃处理）"

# ── 场景 2：同一次崩溃再触发（WatchPaths 可能连发），必须跳过
out2="$(run_doctor)"
ck "$(printf '%s' "$out2" | grep -c '已处理过')" "1" "场景2：同一次崩溃幂等跳过，不重复修复"
ck "$(printf '%s' "$out2" | grep -c '检测到崩溃且尚未恢复')" "0" "场景2：没有再次执行修复"

# ── 场景 3：崩溃之后 App 自己起来过 → 只记录
printf '1789799994857 === boot session started ===\n1789800000001 ERROR dsh web 进程已退出 (code 1)\n1789800009000 === boot session started ===\n1789800009100 dsh web ready\n' > "$FIX/boot.log"
out3="$(run_doctor)"
ck "$(printf '%s' "$out3" | grep -c 'App 已自行恢复')" "1" "场景3：崩溃后已恢复的，只记录不插手"
ck "$(jq -r '.outcome' "$FIX/logs/doctor-state.json" 2>/dev/null)" "self-recovered" "场景3：状态标记为 self-recovered"
ck "$(printf '%s' "$out3" | grep -c '检测到崩溃且尚未恢复')" "0" "场景3：没有多此一举去修"

# ── 场景 4：没有崩溃过的 boot.log → 不做崩溃处理，深度核对照旧走自己的节奏
printf '1789799994857 === boot session started ===\n1789799994944 provision complete\n1789800000265 dsh web ready\n' > "$FIX/boot.log"
out4="$(run_doctor)"
ck "$(printf '%s' "$out4" | grep -c '没有任何崩溃记录')" "1" "场景4：无崩溃记录时不做崩溃处理"
ck "$(printf '%s' "$out4" | grep -c '深度核对未到期')" "1" "场景4：无崩溃时深度核对仍然按自己的节奏判定"

# ── 场景 5：boot.log 不存在 → 静默退出，不报错
out5="$(CLAWMASTER_BOOT_LOG="$FIX/nope.log" DSH_HOME="$FIX" \
        CLAWMASTER_BIN_DIR="$FIX/bin" CLAWMASTER_DEEP_STATE="$FIX/logs/doctor-deep.json" \
        CLAWMASTER_DEEP_INTERVAL="$DEEP_INTERVAL" "$HERE/resident-doctor.sh" --verbose 2>&1)"; rc5=$?
ck "$rc5" "0" "场景5：缺 boot.log 时退出码 0（不制造噪音）"

# ── 场景 6：从没做过深度核对 → 立刻做一次（不能因为健康就永远不查）
rm -f "$FIX/logs/doctor-deep.json"; : > "$FIX_CALLS"
out6="$(run_doctor)"
ck "$(printf '%s' "$out6" | grep -c '开始周期性深度核对')" "1" "场景6：从未核对过时立刻做一次"
ck "$(printf '%s' "$out6" | grep -c '深度核对通过')" "1" "场景6：无漂移时判定为通过"
ck "$(jq -r '.rc' "$FIX/logs/doctor-deep.json" 2>/dev/null)" "0" "场景6：核对结果（rc=0）已落盘"
ck "$(grep -c 'doctor --deep --scan' "$FIX_CALLS")" "1" "场景6：真的把 doctor 以 --deep --scan 调起来了"

# ── 场景 7：刚核对过 → 第二次必须跳过，不能每 5 分钟扫一遍全树
before="$(calls)"
out7="$(run_doctor)"
ck "$(printf '%s' "$out7" | grep -c '深度核对未到期')" "1" "场景7：未到期时跳过"
ck "$(calls)" "$before" "场景7：跳过时没有真的去调 doctor"

# ── 场景 8：--deep-now 无视间隔，立刻核对
out8="$(run_doctor --deep-now)"
ck "$(printf '%s' "$out8" | grep -c '开始周期性深度核对')" "1" "场景8：--deep-now 无视间隔立刻核对"

# ── 场景 9：核对发现漂移 → 必须调用全树还原
: > "$FIX_CALLS"; touch "$FIX_DRIFT"
out9="$(run_doctor --deep-now)"; rc9=$?
ck "$(printf '%s' "$out9" | grep -c '发现漂移')" "1" "场景9：发现漂移并说明"
ck "$(grep -c 'repair-core' "$FIX_CALLS")" "1" "场景9：调用了全树还原"
ck "$(printf '%s' "$out9" | grep -c '全树还原完成')" "1" "场景9：还原成功后如实记录"
ck "$rc9" "0" "场景9：修复成功时退出码 0"

# ── 场景 10：还原失败 → 必须非零退出（人工必须看得见）
: > "$FIX_CALLS"; touch "$FIX_REPAIR_FAIL"
out10="$(run_doctor --deep-now)"; rc10=$?
ck "$(printf '%s' "$out10" | grep -c '全树还原失败')" "1" "场景10：还原失败如实上报"
ck "$rc10" "1" "场景10：还原失败时退出码 1"
rm -f "$FIX_DRIFT" "$FIX_REPAIR_FAIL"

# ── 场景 11：另一轮正在核对（锁是新的）→ 本轮跳过，避免几份全树扫描叠着跑
: > "$FIX_CALLS"; mkdir -p "$FIX/logs/.doctor-deep.lock"; rm -f "$FIX/logs/doctor-deep.json"
out11="$(run_doctor)"
ck "$(printf '%s' "$out11" | grep -c '深度核对已在运行')" "1" "场景11：锁被占用时本轮跳过"
ck "$(calls)" "0" "场景11：跳过时没有启动 doctor"

# ── 场景 12：锁是残留的（进程被 kill 掉的老锁）→ 清掉重来，不能永远卡死
touch -t 202001010000 "$FIX/logs/.doctor-deep.lock"
out12="$(run_doctor)"
ck "$(printf '%s' "$out12" | grep -c '锁已残留')" "1" "场景12：识别出残留的锁"
ck "$(printf '%s' "$out12" | grep -c '开始周期性深度核对')" "1" "场景12：清掉老锁后照常核对（不会永远卡死）"
ck "$([ -d "$FIX/logs/.doctor-deep.lock" ] && echo left || echo cleaned)" "cleaned" "场景12：核对结束后释放锁"

# ── 场景 13：部署形态。常驻的"常驻"是由 plist 保证的，所以 plist 的形状也是被测对象。
# 特别要守住的一条不变量：**WatchPaths 绝不能盯医生自己的输出**——
# 医生的深度核对会写 doctor-deep.json、日志会写 clawmaster-doctor.log，
# 一旦把这些路径也放进 WatchPaths，就会变成"自己触发自己"的无限循环。
dry="$("$HERE/install.sh" --dry-run 2>/dev/null)"
ck "$(printf '%s' "$dry" | grep -c 'resident-doctor\.sh')" "1" "场景13：LaunchAgent 跑的是常驻医生（不是一次性体检）"
wp="$(printf '%s' "$dry" | awk '/<key>WatchPaths<\/key>/{f=1} f{print} /<\/array>/{if(f)exit}')"
# 断言必须只看 WatchPaths 这一段：整份 plist 里 boot.log 在注释中也会出现一次，
# 拿整份去 grep 会数成 2 —— 这正是我第一版写错的地方。
ck "$(printf '%s' "$wp" | grep -c 'boot\.log')" "1" "场景13：WatchPaths 盯 boot.log（崩溃事件源）"
ck "$(printf '%s' "$wp" | grep -c 'logs/')" "0" "场景13：WatchPaths 不盯医生自己的日志/状态（防自触发循环）"
ck "$(printf '%s' "$dry" | grep -c '<key>RunAtLoad</key>')" "1" "场景13：RunAtLoad 在（登录即跑一次）"
ck "$(printf '%s' "$dry" | grep -c '<key>StartInterval</key>')" "1" "场景13：StartInterval 在（每 5 分钟兜底巡检）"
printf '%s\n' "$dry" | /usr/bin/plutil -lint - >/dev/null 2>&1
ck "$?" "0" "场景13：产出的 plist 是合法 XML"

# ── 场景 14：恢复快照坏了 —— 这是最容易漏的"看起来没事"
# 哈希一致、没有可疑代码，一切正常；但那一刻 core 一旦被改就还原不了。
# 所以判定顺序必须是"先看还原能力，再看要不要还原"，而且没有自动解法，只能喊人。
: > "$FIX_CALLS"; touch "$FIX_SNAPSHOT_BAD"
out14="$(run_doctor --deep-now)"; rc14=$?
ck "$(printf '%s' "$out14" | grep -c '恢复快照不可用')" "1" "场景14：快照坏了必须被点名（不是静默通过）"
ck "$rc14" "1" "场景14：退出码 1（人工必须看得见）"
ck "$(grep -c 'repair-core' "$FIX_CALLS")" "0" "场景14：没有误调还原（它修不了快照，调了是白费）"
rm -f "$FIX_SNAPSHOT_BAD"

# 恢复正常后必须回到"通过"，证明上面那条不是永久性卡死
out15="$(run_doctor --deep-now)"
ck "$(printf '%s' "$out15" | grep -c '深度核对通过')" "1" "场景14：快照恢复后重新判定为通过"

# ── 场景 15：心跳。医生的"常驻"必须能被验证，否则它挂了也没人知道
# 关键点：**健康的一轮也要盖时间戳**——只有在健康轮也记录的前提下，
# "心跳不更新"才等于"医生不在了"这件有意义的事。
echo "=== 场景 15：心跳（谁来看着守望者）==="
printf '1789799994857 === boot session started ===\n1789800000265 dsh web ready\n' > "$FIX/boot.log"
seed_deep_fresh
run_doctor >/dev/null 2>&1
hb="$FIX/logs/doctor-heartbeat.json"
ck "$([ -f "$hb" ] && echo yes)" "yes" "场景15：健康的一轮也盖了心跳（否则【没更新】毫无意义）"
ck "$(jq -r '.epoch > 0' "$hb" 2>/dev/null)" "true" "场景15：心跳带可比较的时间戳"
ck "$(jq -r '.pid > 0' "$hb" 2>/dev/null)" "true" "场景15：心跳记录 pid（出问题能追是哪一轮）"

# doctor 侧：四种状态必须被区分开，不能糊成一种
printf '%s\n' "$dry" > "$FIX/preflight.plist"
hbchk() { CLAWMASTER_PLIST="$FIX/preflight.plist" CLAWMASTER_HEARTBEAT="$hb" "$HERE/doctor.sh" 2>&1; }
# 断言必须落在**渲染后的内容**上，不能只 grep 前缀。
# 第一版这里只查了"常驻医生在岗"，结果 doctor.sh 里一个 ${jq ...} 的语法错误
# 把整行原样打出来，测试照样通过 —— 典型的"为错误的原因通过"。
ck "$(hbchk | grep -cE '常驻医生在岗（[0-9]+ 秒前刚跑过，崩溃处理=0 core=0 深度=0）')" "1" "场景15：心跳新鲜 → 在岗，且数值真的被渲染出来"
printf '{"epoch":1,"at":"old"}\n' > "$hb"
hbout="$(hbchk)"
ck "$(printf '%s' "$hbout" | grep -c '似乎已经不在了')" "1" "场景15：心跳过期 → 判定医生已经不在了"
rm -f "$hb"
ck "$(hbchk | grep -c '从没跑过')" "1" "场景15：装了但从没跑过 → 单独报出来（不是笼统的失败）"
ck "$(CLAWMASTER_PLIST="$FIX/nope.plist" CLAWMASTER_HEARTBEAT="$hb" "$HERE/doctor.sh" 2>&1 | grep -c 'LaunchAgent 未安装')" "1" "场景15：没装 LaunchAgent → 如实说现在没有常驻医生"

# 收尾：让心跳回到真实状态，避免留下一个"过期"的假状态给下一轮
seed_deep_fresh
run_doctor >/dev/null 2>&1

printf '\n\033[1m结果: %s 通过, %s 失败\033[0m\n' "$PASS" "$FAIL"
rm -rf "$FIX"
[ "$FAIL" = 0 ] || exit 1
