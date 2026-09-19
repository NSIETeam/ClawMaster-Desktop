#!/usr/bin/env bash
# drill-real-snapshot.sh —— 灾难演习：用**真实的 439MB 快照**走一遍完整的还原路径
#
# 为什么要有这个：
#   单元测试用的是几百字节的 fixture 快照，它**不会**暴露真实快照的问题。
#   实测已经栽过一次：真实快照里有 3669 个符号链接、且文件是冻结只读的，
#   于是 `tar` 会在"第二次还原同一个文件"时撞上只读副本而整条失败。
#   fixture 没模拟这一点，所以那个 bug 在测试里根本冒不出来。
#
#   所以这里做的是**演习**而不是单测：拿真实快照、真实成员路径、真实哈希，
#   在一个假 core 上跑真实的 repair-core.sh。**不碰真实 core 一个字节。**
#
# 用法：./drill-real-snapshot.sh
# 没有快照时自动跳过（退出 0），不会在别的机器上误报失败。

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

FIX="$HERE/.drill"
PASS=0; FAIL=0
ck() { if [ "$1" = "$2" ]; then printf '  \033[32m✓\033[0m %s\n' "$3"; PASS=$((PASS+1));
       else printf '  \033[31m✗\033[0m %s（期望 %s，实际 %s）\n' "$3" "$2" "$1"; FAIL=$((FAIL+1)); fi }

CORE_REAL="$(harness_version_dir)"
CORE_ID="$(basename "$CORE_REAL")"

if [ ! -f "$SNAPSHOT" ]; then
  printf '\033[33m跳过\033[0m：找不到真实快照 %s（这不是失败，只是没得演习）\n' "$SNAPSHOT"
  exit 0
fi

# 基线是机器专属的（.gitignore 明确排除），新鲜克隆里必然没有。
# 没有基线就挑不出样本 —— 这是「没得演习」，不是「演习失败」：
# 以失败退出会让任何新克隆的 CI 直接变红，而那跟被测代码没有关系。
if [ ! -f "$HERE/core-manifest.sha256" ]; then
  printf '\033[33m跳过\033[0m：没有 core-manifest.sha256（先跑 doctor.sh --build-manifest）\n'
  exit 0
fi

# 从真实基线里挑 3 个普通文件（都真实存在于快照里）
# 注意：不用 mapfile —— macOS 自带的 /bin/bash 是 3.2，没有它。
PICK=()
while IFS= read -r line; do PICK+=("$line"); done < <(
  grep '^[0-9a-f]\{64\}  ' "$HERE/core-manifest.sha256" \
  | sed 's|^\([0-9a-f]\{64\}  \)\./|\1|' \
  | grep -E '^[0-9a-f]{64}  packages/(core/session|host/frontend-static|boot/app-boot)/' \
  | head -3)
[ "${#PICK[@]}" -eq 3 ] || { printf '\033[31m✗\033[0m 基线里挑不出 3 个样本文件\n'; exit 1; }

rm -rf "$FIX"
chmod -R u+w "$FIX" 2>/dev/null
mkdir -p "$FIX/core"

# ── 假 core：1 个被篡改、1 个被删掉、1 个多余（真 core 一个字节都不动）
{
  echo "# drill manifest（把真实基线的 3 行搬过来）"
  printf '%s\n' "${PICK[@]}"
} > "$FIX/manifest.sha256"

i=0
for line in "${PICK[@]}"; do
  p="${line#*  }"
  h="${line%%  *}"
  i=$((i+1))
  mkdir -p "$FIX/core/$(dirname "$p")"
  case "$i" in
    1) printf 'TAMPERED-BY-DRILL\n' > "$FIX/core/$p" ;;          # 要还原
    2) : ;;                                                        # 要补回（不存在）
    3) printf 'LEGIT-LOOKING-BUT-EXTRA\n' > "$FIX/core/$p" ;;      # 要移出
  esac
  printf '%s\n' "$line"    # 写回整行（哈希 + 路径）；只写哈希的话，后面会拿哈希当文件名去比对
done > "$FIX/want-hashes.txt"

# 多余文件（基线里没有，必须被移出 core）
mkdir -p "$FIX/core/drill-extra"
printf 'NOT-IN-BASELINE\n' > "$FIX/core/drill-extra/extra.txt"

export CLAWMASTER_SNAPSHOT_PREFIX="harness-versions/$CORE_ID"
export CLAWMASTER_REPAIR_WORK="$FIX/work"

run_repair() {
  "$HERE/repair-core.sh" --core "$FIX/core" --manifest "$FIX/manifest.sha256" --snapshot "$SNAPSHOT" "$@" 2>&1
}

printf '\033[1m演习：用真实快照（%s MB）走完整还原路径\033[0m\n' \
  "$(awk -v b="$(stat -f '%z' "$SNAPSHOT")" 'BEGIN{printf "%.0f", b/1048576}')"

# ── 第 1 轮
out1="$(run_repair)"; rc1=$?
# 诊断只在失败时才吵：第一次写这个演习时，计数断言红了但看不出原因，
# 把原始输出打出来比猜快得多。
[ "${DRILL_DEBUG:-0}" = "1" ] && { echo "--- repair-core 原始输出 ---"; printf '%s\n' "$out1"; echo "--- 样本 ---"; printf '%s\n' "${PICK[@]}"; }
ck "$rc1" "0" "第一轮：还原成功（真实快照 + 真实成员路径）"
# 3 个样本全都是"内容被改"（第 3 个我原本以为算多余，其实它在基线里，只是内容不对）
ck "$(printf '%s' "$out1" | grep -c '需要还原: 3')" "1" "第一轮：正确识别 3 个待还原文件"
ck "$(printf '%s' "$out1" | grep -c '多余(移出): 1')" "1" "第一轮：正确识别 1 个多余文件"

# 内容必须与真实基线逐字节一致
ok_content=0; checked=0
while IFS= read -r line; do
  p="${line#*  }"; h="${line%%  *}"
  got="$(shasum -a 256 "$FIX/core/$p" 2>/dev/null | awk '{print $1}')"
  checked=$((checked+1))
  if [ "${DRILL_DEBUG:-0}" = "1" ]; then
    printf '    [dbg] %s\n          want=%s\n          got =%s\n' "$p" "$h" "$got"
  fi
  [ "$got" = "$h" ] && ok_content=$((ok_content+1))
done < "$FIX/want-hashes.txt"
ck "$ok_content" "$checked" "第一轮：还原出来的内容与真实基线哈希逐字节一致（${checked} 个）"
ck "$([ -e "$FIX/core/drill-extra/extra.txt" ] && echo still || echo gone)" "gone" "第一轮：多余文件被移出 core"

# ── 第 2 轮：**这一轮才是关键**。上一轮在工作目录里留下的是只读副本，
#    早先的实现在这里会 tar 失败（Can't unlink … Permission denied），整条修不动。
p1="${PICK[0]#*  }"
chmod u+w "$FIX/core/$p1" 2>/dev/null
printf 'TAMPERED-AGAIN\n' > "$FIX/core/$p1"
out2="$(run_repair)"; rc2=$?
ck "$rc2" "0" "第二轮：同一个文件**再修一次**仍然成功（只读副本不再卡住 tar）"
ck "$(shasum -a 256 "$FIX/core/$p1" | awk '{print $1}')" "${PICK[0]%%  *}" "第二轮：内容再次回到真实基线"
ck "$(printf '%s' "$out2" | grep -c 'Can.t unlink')" "0" "第二轮：没有出现 unlink 类错误"

# ── 演习完毕，清理（先解冻：还原出来的文件是只读的）
chmod -R u+w "$FIX" 2>/dev/null
rm -rf "$FIX"

printf '\n\033[1m结果: %s 通过, %s 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
