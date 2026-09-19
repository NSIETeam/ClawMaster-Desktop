#!/usr/bin/env bash
# repair-core.sh —— 把 core 还原到基线（从快照恢复被改动的文件）
#
# 与检测的分工：
#   doctor.sh --deep  负责"发现"漂移（全树 49028 文件逐字节比对，分钟级）
#   本脚本            负责"修复"漂移（从恢复快照还原，并重新冻结）
#
# 语义：**让 core 回到基线定义的状态**，不是"回滚某个操作"
#   · 内容变了的文件    → 用快照里的版本覆盖
#   · 基线里没有的文件  → 移出 core（放到证据目录，不删）
#   · 基线里有但缺失的  → 从快照补回
#
# 两种工作模式（等价目标，代价不同）：
#   --deep（默认）  全树重新哈希，任何一处不同都能发现。分钟级。
#   --quick         只检查"有可能被改过"的三类文件，秒级：
#                     ① 冻结时刻之后 mtime 变过的文件
#                     ② 带可写位的文件/目录（冻结应当是整树只读）
#                     ③ 基线清单里没有的新增文件
#                   —— 常驻医生在崩溃瞬间用它，才能"立即可修"。
#                   `touch -t` 把 mtime 改回冻结前的改动会躲过 ①，
#                   `chmod` 改回只读会躲过 ②；所以周期性的 --deep 仍然必要。
#
# 所有被替换/移除的现状都会先备份到证据目录，可人工复核。
#
# 用法：
#   ./repair-core.sh --dry-run     # 只看要动哪些文件（不写）
#   ./repair-core.sh --quick       # 秒级：只查可疑面
#   ./repair-core.sh               # 全树比对后还原
#   ./repair-core.sh --manifest <path> --snapshot <path> --core <dir>
#
# 退出码：0=已回到基线（或本就一致）/ 1=仍有漂移或无法修复

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DRY=0; QUICK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY=1; shift ;;
    --quick)    QUICK=1; shift ;;
    --deep)     QUICK=0; shift ;;
    --manifest) CORE_MANIFEST="$2"; shift 2 ;;
    --snapshot) SNAPSHOT="$2"; shift 2 ;;
    --core)     CLAWMASTER_CORE_ROOT="$2"; shift 2 ;;
    --help|-h)  sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

CORE="${CLAWMASTER_CORE_ROOT:-$(harness_version_dir)}"
CORE_MANIFEST="${CORE_MANIFEST:-$HERE/core-manifest.sha256}"
CORE_ID="$(basename "$CORE")"
# fixture 测试用：允许覆盖快照内的成员前缀（默认 harness-versions/<id>）
MEMBER_PREFIX="${CLAWMASTER_SNAPSHOT_PREFIX:-harness-versions/$CORE_ID}"
WORK="${CLAWMASTER_REPAIR_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/core-repair-$CORE_ID.XXXXXX")}"
# 与 doctor.sh 同一个冻结时刻基准；quick 模式的 ① 依赖它。
FREEZE_GUARD="${CLAWMASTER_FREEZE_GUARD:-2026-09-19 06:29:10}"

fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

[ -d "$CORE" ] || { fail "core 目录不存在：$CORE"; exit 1; }
[ -f "$CORE_MANIFEST" ] || { fail "缺少基线：${CORE_MANIFEST}（先跑 doctor.sh --build-manifest）"; exit 1; }
[ -f "$SNAPSHOT" ] || { fail "缺少恢复快照：$SNAPSHOT"; exit 1; }

mkdir -p "$WORK/evidence" || { fail "无法创建工作目录 $WORK"; exit 1; }
# 上一轮解出来的副本可能是**只读**的（快照里就是冻结的只读文件），
# 不先解冻就会在"再次还原同一个文件"时把 tar 卡在
# "Can't unlink already-existing object: Permission denied" —— 也就是**第二次修就修不动了**。
chmod -R u+w "$WORK" 2>/dev/null

# 路径必须两侧归一化：基线可能是 "./a.txt"（find 产出）也可能是 "a.txt"（手写清单）。
# 不统一就会出现"每个文件都算漂移"或"漂移被漏掉"——本脚本开发时正是栽在这里。
norm() { sed 's|^\([0-9a-f]\{64\}  \)\./|\1|'; }

BASE="$WORK/baseline.sha256"
grep '^[0-9a-f]\{64\} ' "$CORE_MANIFEST" | norm | sort -k2 > "$BASE"

# ── 1. 列出候选漂移
if [ "$QUICK" = 1 ]; then
  echo "快速模式：只比对可疑面（冻结后 mtime 变化 / 可写位 / 基线外新增）"
  : > "$WORK/cand.txt"

  # 完整文件清单（只 stat 不哈希，49028 个文件秒级完成）
  ( cd "$CORE" && find . -type f ) > "$WORK/allpaths.txt" || true
  sed 's|^\./||' "$WORK/allpaths.txt" | sort -u > "$WORK/allpaths.norm"
  awk '{print $2}' "$BASE" | sed 's|^\./||' | sort -u > "$WORK/basepaths.txt"

  find "$CORE" -type f -newermt "$FREEZE_GUARD" 2>/dev/null | sed "s|^${CORE}/||" >> "$WORK/cand.txt"
  find "$CORE" \( -type f -o -type d \) -perm -u+w 2>/dev/null | sed "s|^${CORE}/||" >> "$WORK/cand.txt"
  comm -13 "$WORK/basepaths.txt" "$WORK/allpaths.norm" >> "$WORK/cand.txt" || true

  # 基线里存在、但磁盘上已经没有的文件也直接列入还原（下面第 2 步会统一再算一次）
  : > "$WORK/restore.txt"
  sed 's|^\./||' "$WORK/cand.txt" | grep -v '^$' | sort -u > "$WORK/cand.norm" || true

  CUR="$WORK/current.sha256"
  if [ -s "$WORK/cand.norm" ]; then
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      [ -f "$CORE/$rel" ] || continue
      printf '%s  %s\n' "$(shasum -a 256 "$CORE/$rel" | awk '{print $1}')" "$rel"
    done < "$WORK/cand.norm" | sort -k2 > "$CUR"
  else
    : > "$CUR"
  fi
  info "候选文件 $(grep -c . "$WORK/cand.norm" || true) 个（其中已哈希 $(grep -c . "$CUR" || true) 个）"
else
  echo "重算当前 core 哈希（$(find "$CORE" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件）…"
  CUR="$WORK/current.sha256"
  ( cd "$CORE" && find . -type f -print0 | xargs -0 shasum -a 256 ) | norm | sort -k2 > "$CUR" || true
fi

# ── 2. 从哈希差异推出"要还原"和"要移出"
# 每一轮都必须从零重建：这是"每一轮都是一次独立判定"的前提。
# 之前用 >> 追加，导致上一轮修好的文件在下一轮仍然被报成漂移——测试场景 6 就是栽在这里。
: > "$WORK/restore.txt"

# 磁盘上现在的全部文件路径（两种模式都拿得到：quick 用 find 清单，deep 用哈希清单）
awk '{print $2}' "$BASE" | sed 's|^\./||' | sort -u > "$WORK/basepaths.txt"
if [ "$QUICK" = 1 ]; then
  APATHS="$WORK/allpaths.norm"
else
  sed -n 's/^[0-9a-f]\{64\}  //p' "$CUR" | sed 's|^\./||' | sort -u > "$WORK/curpaths.txt"
  APATHS="$WORK/curpaths.txt"
fi

# 基线里存在、且当前哈希与基线不同的（用逐行连接判断）
awk 'NR==FNR{b[$2]=$1; next} {if ($2 in b && b[$2]!=$1) print $2}' \
  <(grep '^[0-9a-f]\{64\} ' "$BASE") \
  <(grep '^[0-9a-f]\{64\} ' "$CUR") | sed 's|^\./||' >> "$WORK/restore.txt"
# 基线里有、磁盘上已经没有了 → 必须从快照补回
comm -23 "$WORK/basepaths.txt" "$APATHS" >> "$WORK/restore.txt" || true
sort -u "$WORK/restore.txt" -o "$WORK/restore.txt"

# 多余文件 ＝ 当前有、基线没有
comm -13 "$WORK/basepaths.txt" "$APATHS" > "$WORK/extra.txt" || true

n_restore="$(grep -c . "$WORK/restore.txt" || true)"
n_extra="$(grep -c . "$WORK/extra.txt" || true)"

if [ "$n_restore" = "0" ] && [ "$n_extra" = "0" ]; then
  ok "core 与基线一致，无需还原"
  info "（$( [ "$QUICK" = 1 ] && echo '快速模式：仅可疑面' || echo '全树模式' )）"
  exit 0
fi

echo
info "需要还原: ${n_restore} 个文件"
info "多余(移出): ${n_extra} 个文件"

if [ "$DRY" = 1 ]; then
  echo
  if [ "$n_restore" != "0" ]; then echo "── 需要还原 ──"; sed 's/^/    /' "$WORK/restore.txt" | head -20; fi
  if [ "$n_extra" != "0" ]; then echo "── 多余、将移出 ──"; sed 's/^/    /' "$WORK/extra.txt" | head -20; fi
  info "（dry-run：未改动任何文件）"
  exit 0
fi

# ── 3. 从快照取出需要还原的成员（一次 tar 调用，避免多次全量扫描）
if [ "$n_restore" != "0" ]; then
  echo
  echo "从快照解出 ${n_restore} 个成员…"
  members=()
  while IFS= read -r rel; do
    [ -n "$rel" ] && members+=("$MEMBER_PREFIX/$rel")
  done < "$WORK/restore.txt"
  # 先把上一轮解出来的同名副本删掉，再用 -o（不还原属主/权限）解。
  # 否则 tar 会撞上"已存在的只读对象"，报 Can't unlink … Permission denied 并整条失败。
  while IFS= read -r rel; do
    [ -n "$rel" ] && rm -f "$WORK/$MEMBER_PREFIX/$rel" 2>/dev/null
  done < "$WORK/restore.txt"
  if ! tar -xzf "$SNAPSHOT" -C "$WORK" -o "${members[@]}" 2>"$WORK/tar.err"; then
    fail "快照解压失败（见 $WORK/tar.err）；没有任何文件被改动"
    [ -s "$WORK/tar.err" ] && sed 's/^/    /' "$WORK/tar.err" | head -10 >&2
    exit 1
  fi
  ok "解压完成"
fi

# ── 4. 逐个替换/移出，先备份现状到证据目录
# 冻结是"整树只读"，所以目录本身也可能是 a-w；往这种目录里拷文件必须先放开写位，
# 动完再按原样恢复（不假设原来是 755）。只放开文件自己的写位是不够的。
echo
restored=0; removed=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  dst="$CORE/$rel"
  src="$WORK/$MEMBER_PREFIX/$rel"
  safe="$(printf '%s' "$rel" | tr '/' '_')"
  if [ ! -f "$src" ]; then fail "快照里没有 ${rel}，跳过"; continue; fi
  [ -f "$dst" ] && cp -p "$dst" "$WORK/evidence/$safe" 2>/dev/null

  dir="$(dirname "$dst")"
  dmode=""
  if [ -d "$dir" ]; then
    dmode="$(stat -f '%Lp' "$dir" 2>/dev/null)"
    chmod u+w "$dir" 2>/dev/null
  fi

  done_one=0
  if [ ! -e "$dst" ]; then
    mkdir -p "$dir" 2>/dev/null
    cp -p "$src" "$dst" && chmod a-w "$dst" \
      && { info "已补回 ${rel}"; restored=$((restored+1)); done_one=1; } || fail "补回失败 ${rel}"
  elif chmod u+w "$dst" 2>/dev/null; then
    if cp -p "$src" "$dst" && chmod a-w "$dst"; then
      info "已还原 ${rel}"
      restored=$((restored+1)); done_one=1
    else
      fail "还原失败 ${rel}"
    fi
  else
    fail "无法取得写权限 ${rel}"
  fi

  [ -n "$dmode" ] && chmod "$dmode" "$dir" 2>/dev/null
  [ "$done_one" = 1 ] || true
done < "$WORK/restore.txt"

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  dst="$CORE/$rel"
  safe="$(printf '%s' "$rel" | tr '/' '_')"
  if [ -e "$dst" ]; then
    dir="$(dirname "$dst")"
    dmode=""
    if [ -d "$dir" ]; then
      dmode="$(stat -f '%Lp' "$dir" 2>/dev/null)"
      chmod u+w "$dir" 2>/dev/null
    fi
    chmod u+w "$dst" 2>/dev/null || true
    mv "$dst" "$WORK/evidence/EXTRA_$safe" 2>/dev/null \
      && { info "已移出多余文件 ${rel}"; removed=$((removed+1)); } \
      || fail "移出失败 ${rel}"
    [ -n "$dmode" ] && chmod "$dmode" "$dir" 2>/dev/null
  fi
done < "$WORK/extra.txt"

# ── 5. 复检：只复检刚动过的东西（quick 模式必须保持秒级）
# 只判定"内容回到基线"和"不再有基线外的文件"。
# 整树可写位属于 doctor.sh 第 1 项的职责，不在这里重复判定——
# 否则 fixture 里没被冻结的目录会被误判成还原失败。
echo
echo "复检…"
bad=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  want="$(awk -v p="$rel" '$2==p || $2=="./"p {print $1; exit}' "$BASE")"
  [ -n "$want" ] || continue
  got="$(shasum -a 256 "$CORE/$rel" 2>/dev/null | awk '{print $1}')"
  if [ "$got" != "$want" ]; then fail "仍与基线不一致：${rel}"; bad=$((bad+1)); fi
done < "$WORK/restore.txt"

still_extra="$(cd "$CORE" && find . -type f | sed 's|^\./||' | sort -u | comm -13 "$WORK/basepaths.txt" - | wc -l | tr -d ' ')"

if [ "$bad" = "0" ] && [ "$still_extra" = "0" ]; then
  ok "core 已回到基线（还原 ${restored}，移出 ${removed}）"
  info "被替换的现状备份在 ${WORK}/evidence/"
  exit 0
else
  fail "复检未通过：内容不符 ${bad} 个，基线外多余 ${still_extra} 个"
  exit 1
fi
