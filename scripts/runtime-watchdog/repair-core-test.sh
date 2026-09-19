#!/usr/bin/env bash
# repair-core-test.sh —— core 自动还原的行为测试（全用 fixture，不碰真实 core）
#
# 制造三种漂移，验证 repair-core.sh 的语义：
#   ① 内容被改   → 必须从快照还原
#   ② 文件被删   → 必须从快照补回
#   ③ 多出文件   → 必须移出 core（而不是删掉）
# 另外验证：被改动的现状要有证据备份、还原后权限回到只读、复检通过。

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/.fixture-repair"
PASS=0; FAIL=0
ck() { if [ "$1" = "$2" ]; then printf '  \033[32m✓\033[0m %s\n' "$3"; PASS=$((PASS+1));
       else printf '  \033[31m✗\033[0m %s（期望 %s，实际 %s）\n' "$3" "$2" "$1"; FAIL=$((FAIL+1)); fi }

# 上一轮如果没跑完，fixture 里会留下"真的被冻结"的只读目录/文件（那正是加固生效的证据）。
# 所以清理必须先解冻，否则 rm 会失败、残留状态污染下一轮——这是实测踩到过的坑。
chmod -R u+w "$FIX" 2>/dev/null
rm -rf "$FIX"; mkdir -p "$FIX/core/sub" "$FIX/snap/harness-versions/fake"

# ── 造原始 core（三个文件）
printf 'ALPHA-v1\n' > "$FIX/core/a.txt"
printf 'BETA-v1\n'  > "$FIX/core/b.txt"
printf 'GAMMA-v1\n' > "$FIX/core/sub/c.txt"

# ── 基线（与 doctor.sh 同格式）
{
  echo "# clawmaster core manifest v1"
  echo "# treeId fake"
  echo "# fileCount 3"
} > "$FIX/manifest.sha256"
( cd "$FIX/core" && shasum -a 256 a.txt b.txt sub/c.txt ) >> "$FIX/manifest.sha256"

# ── 快照：装原始文件的副本，成员前缀为 harness-versions/fake
cp -p "$FIX/core/a.txt" "$FIX/snap/harness-versions/fake/a.txt"
cp -p "$FIX/core/b.txt" "$FIX/snap/harness-versions/fake/b.txt"
cp -p "$FIX/core/sub/c.txt" "$FIX/snap/harness-versions/fake/c.txt"   # 注意：tar 成员名会保留扁平路径
mkdir -p "$FIX/snap/harness-versions/fake/sub"
cp -p "$FIX/core/sub/c.txt" "$FIX/snap/harness-versions/fake/sub/c.txt"
tar -czf "$FIX/snapshot.tar.gz" -C "$FIX/snap" harness-versions/fake/a.txt harness-versions/fake/b.txt harness-versions/fake/sub/c.txt
# 让 fixture 的快照**像真实快照一样是冻结的只读**。
# 这一条很关键：真实快照里的文件是 a-w，解出来的副本也是 a-w，
# 于是"第二次还原同一个文件"时 tar 会撞上只读对象而整条失败——
# 早期 fixture 没模拟这一点，所以那个 bug 在测试里根本冒不出来。
chmod a-w "$FIX/snap/harness-versions/fake/a.txt" "$FIX/snap/harness-versions/fake/b.txt" "$FIX/snap/harness-versions/fake/sub/c.txt"

REPAIR_ARGS=(--core "$FIX/core" --manifest "$FIX/manifest.sha256" --snapshot "$FIX/snapshot.tar.gz")
export CLAWMASTER_SNAPSHOT_PREFIX="harness-versions/fake"
export CLAWMASTER_REPAIR_WORK="$FIX/work"

# ── 场景 0：未漂移时应当什么都不做
out0="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" 2>&1)"; rc0=$?
ck "$rc0" "0" "场景0：无漂移时退出码 0"
ck "$(printf '%s' "$out0" | grep -c '与基线一致，无需还原')" "1" "场景0：明确报告无需还原"

# ── 制造三种漂移
printf 'ALPHA-TAMPERED\n' > "$FIX/core/a.txt"
chmod u+w "$FIX/core/a.txt"
rm -f "$FIX/core/sub/c.txt"
printf 'I-AM-EXTRA\n' > "$FIX/core/extra.txt"

# ── 场景 1：dry-run 不应改动任何东西
dry="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" --dry-run 2>&1)"; drc=$?
ck "$drc" "0" "场景1：dry-run 退出码 0"
ck "$(cat "$FIX/core/a.txt")" "ALPHA-TAMPERED" "场景1：dry-run 没有改动被篡改的文件"
ck "$([ -f "$FIX/core/extra.txt" ] && echo yes)" "yes" "场景1：dry-run 没有移走多余文件"
ck "$(printf '%s' "$dry" | grep -c '需要还原: 2')" "1" "场景1：dry-run 正确报出 2 个待还原文件"
ck "$(printf '%s' "$dry" | grep -c '多余(移出): 1')" "1" "场景1：dry-run 正确报出 1 个多余文件"

# ── 场景 2：真正还原
out2="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" 2>&1)"; rc2=$?
ck "$rc2" "0" "场景2：还原后退出码 0（已回到基线）"
ck "$(cat "$FIX/core/a.txt")" "ALPHA-v1" "场景2：被篡改的文件已还原"
ck "$(cat "$FIX/core/sub/c.txt" 2>/dev/null)" "GAMMA-v1" "场景2：被删除的文件已补回"
ck "$(printf '%s' "$out2" | grep -c 'core 已回到基线')" "1" "场景2：复检确认回到基线"

# ── 场景 3：多余文件是"移出"而不是"删除"
ck "$([ -e "$FIX/core/extra.txt" ] && echo still || echo gone)" "gone" "场景3：多余文件已移出 core"
ck "$(ls -1 "$FIX/work/evidence/" 2>/dev/null | grep -cx 'EXTRA_extra.txt')" "1" "场景3：多余文件保留在证据目录（没被删掉）"

# ── 场景 4：被改动的现状有备份，可人工复核
ck "$(ls -1 "$FIX/work/evidence/" 2>/dev/null | grep -cx 'a.txt')" "1" "场景4：被篡改的现状有证据备份"
ck "$(cat "$FIX/work/evidence/a.txt" 2>/dev/null)" "ALPHA-TAMPERED" "场景4：证据里保存的是篡改后的内容"

# ── 场景 5：还原后重新冻结（不可写）
ck "$([ -w "$FIX/core/a.txt" ] && echo writable || echo readonly)" "readonly" "场景5：还原后文件不可写（重新冻结）"

# ── 场景 6：再跑一次应当无漂移
out6="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" 2>&1)"
ck "$(printf '%s' "$out6" | grep -c '与基线一致，无需还原')" "1" "场景6：还原是收敛的（再跑无漂移）"

# ── 场景 7-10：快速模式（常驻医生崩溃瞬间用的那条路径）
# 语义：只检查"有可能被改过"的三类 —— mtime 晚于冻结时刻、带可写位、基线外新增。
# 它必须能抓住真实改动，也必须诚实暴露自己的盲区（靠 --deep 兜底）。
qout0="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" --quick 2>&1)"; qrc0=$?
ck "$qrc0" "0" "场景7：快速模式在无漂移时退出码 0"
ck "$(printf '%s' "$qout0" | grep -c '快速模式：只比对可疑面')" "1" "场景7：快速模式标明了自己的检查范围"

chmod u+w "$FIX/core/a.txt"; printf 'ALPHA-TAMPERED-2\n' > "$FIX/core/a.txt"
printf 'EXTRA-2\n' > "$FIX/core/extra2.txt"
qout1="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" --quick 2>&1)"; qrc1=$?
ck "$qrc1" "0" "场景8：快速模式还原后退出码 0"
ck "$(cat "$FIX/core/a.txt")" "ALPHA-v1" "场景8：快速模式抓到了内容篡改并还原"
ck "$([ -e "$FIX/core/extra2.txt" ] && echo still || echo gone)" "gone" "场景8：快速模式移出了新增文件"
ck "$([ -w "$FIX/core/a.txt" ] && echo writable || echo readonly)" "readonly" "场景8：快速模式还原后重新冻结"

# 盲区必须被证明存在，而不是被假设：
# 把内容改掉、mtime 用 touch -t 倒填到冻结之前、权限也改回只读 —— 三类候选全部躲开。
# 注意：场景 8 还原后文件是只读的，改之前必须先 u+w，否则写不进去（这本身就是加固的证据）。
chmod u+w "$FIX/core/a.txt"
printf 'ALPHA-TAMPERED-3\n' > "$FIX/core/a.txt"
chmod a-w "$FIX/core/a.txt"
touch -t 202001010000 "$FIX/core/a.txt"
ck "$(cat "$FIX/core/a.txt")" "ALPHA-TAMPERED-3" "场景9：前提成立——文件确实被改了且已倒填 mtime"
qout2="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" --quick 2>&1)"; qrc2=$?
ck "$qrc2" "0" "场景9：快速模式对这类改动报【一致】（盲区如文档所述）"
ck "$(printf '%s' "$qout2" | grep -c 'core 与基线一致')" "1" "场景9：快速模式确实没看见倒填 mtime 的篡改"
dout2="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" --dry-run 2>&1)"
ck "$(printf '%s' "$dout2" | grep -c '需要还原: 1')" "1" "场景9：全树模式（--deep）仍然抓到了它"
ck "$(cat "$FIX/core/a.txt")" "ALPHA-TAMPERED-3" "场景9：dry-run 没有改动文件"

dout3="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" 2>&1)"; drc3=$?
ck "$drc3" "0" "场景10：全树模式把它还原并退出 0"
ck "$(cat "$FIX/core/a.txt")" "ALPHA-v1" "场景10：倒填 mtime 的篡改已被修复"

# ── 场景 11：往"冻结的目录"里还原文件（真实 core 的目录也是 a-w）
# 这是最容易漏的一条：只放开文件自身的写位是不够的，必须临时放开父目录，
# 而且动完要按原样恢复目录权限，不能想当然写成 755。
mkdir -p "$FIX/core/frozen"
printf 'DELTA-v1\n' > "$FIX/core/frozen/d.txt"
(cd "$FIX/core" && shasum -a 256 frozen/d.txt) >> "$FIX/manifest.sha256"
mkdir -p "$FIX/snap/harness-versions/fake/frozen"
cp -p "$FIX/core/frozen/d.txt" "$FIX/snap/harness-versions/fake/frozen/d.txt"
tar -czf "$FIX/snapshot.tar.gz" -C "$FIX/snap" \
  harness-versions/fake/a.txt harness-versions/fake/b.txt \
  harness-versions/fake/sub/c.txt harness-versions/fake/frozen/d.txt

chmod u+w "$FIX/core/frozen"; rm -f "$FIX/core/frozen/d.txt"; chmod a-w "$FIX/core/frozen"
ck "$(stat -f '%Lp' "$FIX/core/frozen")" "555" "场景11：前提成立——父目录已冻结为 555"
s11="$("$HERE/repair-core.sh" "${REPAIR_ARGS[@]}" --quick 2>&1)"; rc11=$?
[ "$rc11" = 0 ] || printf '%s\n' "$s11" | sed 's/^/      | /'
ck "$rc11" "0" "场景11：能往只读目录里还原（退出码 0）"
ck "$(cat "$FIX/core/frozen/d.txt" 2>/dev/null)" "DELTA-v1" "场景11：冻结目录里被删的文件已补回"
ck "$(stat -f '%Lp' "$FIX/core/frozen")" "555" "场景11：父目录权限按原样恢复（没有被改成 755）"

# ── 场景 12：恢复快照本身必须被当作"被守护的对象"来检查
# 论点：还原**依赖**快照，所以"文件还在"根本不等于"还能用"。
# 一个被截断的 tar.gz 依然存在、依然以 1f8b 开头，但解不出东西——
# 等真要还原时才发现就太晚了。所以 doctor 必须做全量 CRC 校验。
snapchk() { CLAWMASTER_CORE_ROOT="$FIX/core" DSH_SNAPSHOT="$1" "$HERE/doctor.sh" --snapshot-check 2>&1; }

good="$(snapchk "$FIX/snapshot.tar.gz")"; grc=$?
ck "$grc" "0" "场景12：完好快照判定为可用"
ck "$(printf '%s' "$good" | grep -c '可用于还原')" "1" "场景12：并说明它可用于还原"

# 截断必须真的截掉东西：fixture 的快照只有几百字节，
# 写死 head -c 2000 会一口气拷完整个文件 —— 那就是"没截断"，测出来的通过没有意义。
snap_sz="$(stat -f '%z' "$FIX/snapshot.tar.gz")"
head -c $((snap_sz / 2)) "$FIX/snapshot.tar.gz" > "$FIX/truncated.tar.gz"
ck "$([ "$(stat -f '%z' "$FIX/truncated.tar.gz")" -lt "$snap_sz" ] && echo yes)" "yes" "场景12：前提成立——截断文件确实比原件小"
bad="$(snapchk "$FIX/truncated.tar.gz")"; brc=$?
ck "$brc" "1" "场景12：截断的快照必须判定为 FAIL"
ck "$(printf '%s' "$bad" | grep -c 'CRC 校验失败')" "1" "场景12：报出的是 CRC 失败（不是含糊的【文件存在】）"

printf 'NOT A GZIP AT ALL\n' > "$FIX/notgzip.tar.gz"
ng="$(snapchk "$FIX/notgzip.tar.gz")"
ck "$(printf '%s' "$ng" | grep -c '不是 gzip')" "1" "场景12：非 gzip 的文件被单独识别出来"

miss="$(snapchk "$FIX/does-not-exist.tar.gz")"; mrc=$?
ck "$mrc" "1" "场景12：快照缺失时必须 FAIL"
ck "$(printf '%s' "$miss" | grep -c '不存在')" "1" "场景12：并明确说 core 一旦被改就没法还原"

printf '\n\033[1m结果: %s 通过, %s 失败\033[0m\n' "$PASS" "$FAIL"
# 清理前必须先解冻：场景 11 留下的是真正 555 的目录 + 只读文件（这正是加固生效的证明）。
chmod -R u+w "$FIX" 2>/dev/null
rm -rf "$FIX"
[ "$FAIL" = 0 ] || exit 1
