#!/usr/bin/env bash
# crosscheck-core.sh —— 交叉核对两件独立物证的**一致性**
#
# 为什么必须有这一步：
#   整个"core 不可被改"的链条建立在两个独立产物的**互相印证**上：
#     ① core-manifest.sha256 —— "冻结时刻的树长什么样"（49028 个文件的期望哈希）
#     ② harness-core-*.tar.gz —— "能把它还原回去的快照"（还原时真正被解出来的内容）
#   检测用 ①、还原用 ②。**如果两者互相矛盾，整条链就是坏的**：
#     · ① 少了某个文件 → repair 会把那文件当成"多余"移出 core（错杀）
#     · ① 与 ② 内容不一致 → repair 还原后复检永远不过（"回到基线"永远做不到）
#   所以"两个物证互相对得上"是必须被验证的前提，而不是可以默认的假设。
#
# 做法：把快照解到临时目录，逐文件比对哈希；再双向比对文件集合。
# 代价：解 439MB + 哈希 1.4GB，分钟级。适合周期审计，不适合每次都跑。
#
# 用法：
#   ./crosscheck-core.sh            # 完整核对
#   ./crosscheck-core.sh --keep     # 保留解出来的树（默认用完就删）
#
# 退出码：0=一致 / 1=不一致或无法核对

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --manifest) CORE_MANIFEST="$2"; shift 2 ;;
    --snapshot) SNAPSHOT="$2"; shift 2 ;;
    --core)     CLAWMASTER_CORE_ROOT="$2"; shift 2 ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

CORE="${CLAWMASTER_CORE_ROOT:-$(harness_version_dir)}"
CORE_MANIFEST="${CORE_MANIFEST:-$HERE/core-manifest.sha256}"
CORE_ID="$(basename "$CORE")"
MEMBER_PREFIX="${CLAWMASTER_SNAPSHOT_PREFIX:-harness-versions/$CORE_ID}"
WORK="${CLAWMASTER_CROSSCHECK_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/core-crosscheck-$CORE_ID.XXXXXX")}"

fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

[ -f "$CORE_MANIFEST" ] || { fail "缺少基线：$CORE_MANIFEST"; exit 1; }
[ -f "$SNAPSHOT" ] || { fail "缺少恢复快照：$SNAPSHOT"; exit 1; }

mkdir -p "$WORK" || { fail "无法创建工作目录 $WORK"; exit 1; }

# ── 1. 期望值（来自基线）
norm() { sed 's|^\([0-9a-f]\{64\}  \)\./|\1|'; }
WANT="$WORK/want.sha256"
grep '^[0-9a-f]\{64\} ' "$CORE_MANIFEST" | norm | sort -k2 > "$WANT"
want_n="$(grep -c . "$WANT" || true)"
info "基线声明 $(printf '%s' "$want_n") 个文件"

# ── 2. 从快照解出整棵树（解到临时目录，避免"边解边算"漏掉文件名）
echo "从快照解出整棵树（$(awk -v b="$(stat -f '%z' "$SNAPSHOT")" 'BEGIN{printf "%.0f", b/1048576}') MB）…"
if [ -d "$WORK/tree/$MEMBER_PREFIX" ] && [ "${CLAWMASTER_CROSSCHECK_REUSE:-0}" = "1" ]; then
  info "复用已解出的树（CLAWMASTER_CROSSCHECK_REUSE=1）"
else
  # 必须先解冻再删：快照里的目录是**冻结的只读**目录，
  # 上一次解出来的树 rm -rf 删不掉，残留下来会让这次解压到处
  # "Can't unlink already-existing object: Permission denied"。
  chmod -R u+w "$WORK/tree" 2>/dev/null
  rm -rf "$WORK/tree" 2>/dev/null
  mkdir -p "$WORK/tree"
  if [ -d "$WORK/tree/$MEMBER_PREFIX" ]; then
    fail "临时目录里仍残留上一轮的树，无法清理：$WORK/tree —— 请手工删除后重试"
    exit 1
  fi
  # -o（不还原属主/权限）是**必须**的：pnpm 布局里有 3669 个符号链接，
  # 给符号链接还原元数据在 macOS 上会 EBADF，bsdtar 于是让整条命令退出 1。
  # 实测对照：不加 -o → 1675 条 metadata 警告 + exit 1；加 -o → exit 0、零 stderr。
  # 但也不能只看退出码 —— 下面把"元数据警告"和"真正的内容错误"分开判。
  tar -xzf "$SNAPSHOT" -C "$WORK/tree" -o "$MEMBER_PREFIX" 2>"$WORK/tar.err"
  tar_rc=$?
  # 已知无害的两行：逐条 metadata 警告，以及 bsdtar 末尾那句汇总
  # "Error exit delayed from previous errors."（它只是在说"前面有警告"，本身不是错误）。
  # 除此之外的任何一行才是真的解不出来。
  BENIGN='Failed to restore metadata|Error exit delayed from previous errors\.'
  bad_lines="$(grep -vE "$BENIGN" "$WORK/tar.err" 2>/dev/null | grep -c . || true)"
  if [ "$bad_lines" != "0" ]; then
    fail "快照解压出现非元数据错误（${bad_lines} 行）—— 这才是真的解不出来"
    grep -vE "$BENIGN" "$WORK/tar.err" | head -5 | sed 's/^/    /' >&2
    exit 1
  fi
  [ "$tar_rc" != "0" ] && info "tar 退出码 ${tar_rc}，但只有元数据警告，内容完整"
fi
[ -d "$WORK/tree/$MEMBER_PREFIX" ] || { fail "快照里没有 ${MEMBER_PREFIX} 这棵树"; exit 1; }

# ── 3. 实际值（来自快照）
GOT="$WORK/got.sha256"
( cd "$WORK/tree/$MEMBER_PREFIX" && find . -type f -print0 | xargs -0 shasum -a 256 ) | norm | sort -k2 > "$GOT"
got_n="$(grep -c . "$GOT" || true)"
info "快照里有 $(printf '%s' "$got_n") 个文件"

# ── 4. 双向集合比对
awk '{print $2}' "$WANT" | sed 's|^\./||' | sort -u > "$WORK/want.paths"
awk '{print $2}' "$GOT"  | sed 's|^\./||' | sort -u > "$WORK/got.paths"
comm -23 "$WORK/want.paths" "$WORK/got.paths" > "$WORK/missing.txt" || true   # 基里有、快照没有
comm -13 "$WORK/want.paths" "$WORK/got.paths" > "$WORK/extra.txt"   || true   # 快照有、基里没有
missing_n="$(grep -c . "$WORK/missing.txt" || true)"
extra_n="$(grep -c . "$WORK/extra.txt"   || true)"

# ── 5. 同名文件的内容比对
awk 'NR==FNR{w[$2]=$1; next} ($2 in w) && w[$2]!=$1 {print $2}' "$WANT" "$GOT" \
  | sed 's|^\./||' | sort -u > "$WORK/diff.txt"
diff_n="$(grep -c . "$WORK/diff.txt" || true)"

echo
rc=0
if [ "$missing_n" != "0" ]; then
  fail "基里有 ${missing_n} 个文件、快照里没有 —— 这些文件一旦丢失就还原不回来："
  sed 's/^/    /' "$WORK/missing.txt" | head -10
  rc=1
fi
if [ "$extra_n" != "0" ]; then
  fail "快照里有 ${extra_n} 个文件、基里没有 —— **危险**：repair 会把这些文件当成多余并移出 core："
  sed 's/^/    /' "$WORK/extra.txt" | head -10
  rc=1
fi
if [ "$diff_n" != "0" ]; then
  fail "两份物证对同 ${diff_n} 个文件的内容说法不一致 —— 还原后复检永远不过："
  sed 's/^/    /' "$WORK/diff.txt" | head -10
  rc=1
fi

[ "$KEEP" = 1 ] || rm -rf "$WORK/tree" 2>/dev/null

echo
if [ "$rc" = 0 ]; then
  ok "两件物证一致：${want_n} 个文件的内容与集合都互相对得上"
  info "（检测用基线、还原用快照，两者说的是同一棵树）"
else
  fail "两件物证不一致 —— 先别信任何一边，人工核对后再重建（见 $WORK/）"
fi
exit "$rc"
