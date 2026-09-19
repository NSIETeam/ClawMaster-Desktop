#!/usr/bin/env bash
# freeze.sh —— 固化 DSH 运行时（幂等）
#
# 作用：
#   1. 校验 harness 版本目录与 runtime/manifest.json 指向一致
#   2. 确保 CSP 补丁在位（缺失则补打，并保留 .bak）
#   3. 递归去掉写权限（chmod -R a-w），使运行时不可被静默改写
#   4. 生成/更新关键面基线（baseline.tsv），供 verify.sh 做漂移检测
#   5. 可选：生成新的恢复快照 tar.gz
#
# 用法：
#   ./freeze.sh                 # 冻结 + 刷新基线
#   ./freeze.sh --baseline-only # 只刷新基线（不触碰系统，可在只读沙箱内跑）
#   ./freeze.sh --snapshot      # 额外生成 harness-core-<日期>.tar.gz
#   ./freeze.sh --dry-run       # 只报告将要做什么，不改动任何东西
#
# 注意：本脚本改动都发生在工作区之外，需要提权/审批。

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DO_SNAPSHOT=0
DRY=0
BASELINE_ONLY=0
for a in "$@"; do
  case "$a" in
    --snapshot)      DO_SNAPSHOT=1 ;;
    --baseline-only) BASELINE_ONLY=1; DRY=1 ;;
    --dry-run)       DRY=1 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

head1 "0. 定位运行时"
HV="$(harness_version_dir)"
if [ -z "$HV" ] || [ ! -d "$HV" ]; then bad "找不到 harness 版本目录（manifest: ${MANIFEST}）"; exit 1; fi
ok "harness 版本目录: $HV"
ok "manifest: $MANIFEST"
[ "$DRY" = 1 ] && warn "dry-run 模式：不会做任何写操作"

# ---------------------------------------------------------------- 1. CSP 补丁
head1 "1. CSP 补丁（前端空白/错位的唯一修复点）"
FS="$HV/packages/host/frontend-static/lib/index.js"
if [ ! -f "$FS" ]; then
  bad "缺少 $FS"
else
  need_eval=0; need_style=0
  grep -q "script-src 'self' 'unsafe-eval'" "$FS" || need_eval=1
  grep -q '"style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'"' "$FS" || grep -q "style-src 'self' 'unsafe-inline'" "$FS" || need_style=1

  if [ "$need_eval" = 0 ] && [ "$need_style" = 0 ]; then
    ok "补丁已在位（script-src unsafe-eval + style-src unsafe-inline）"
  else
    warn "补丁缺失（script-src=$need_eval style-src=${need_style}），需要重打"
    if [ "$DRY" = 1 ]; then
      printf '  [dry-run] 将备份并改写 %s\n' "$FS"
    else
      run chmod u+w "$FS" "$(dirname "$FS")" "$HV/packages/host/frontend-static" "$HV/packages/host" "$HV/packages" "$HV" 2>/dev/null
      [ -f "$FS.bak-$(date +%Y%m%d)" ] || cp -p "$FS" "$FS.bak-$(date +%Y%m%d)"
      # script-src：插入 'unsafe-eval'
      /usr/bin/sed -i '' "s|script-src 'self' 'wasm-unsafe-eval'|script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'|" "$FS"
      # style-src：整条替换为 self + unsafe-inline（必须去掉 nonce/哈希，否则 unsafe-inline 被忽略）
      /usr/bin/sed -i '' "s|style-src 'self' 'nonce-\${styleNonce}' \${styleHashes.join(\" \")}|style-src 'self' 'unsafe-inline'|" "$FS"
      ok "补丁已重打；原文件备份为 $(basename "$FS").bak-$(date +%Y%m%d)"
    fi
  fi
fi

# ---------------------------------------------------------------- 2. 冻结
head1 "2. 去写权限（chmod -R a-w）"
if [ "$DRY" = 1 ]; then
  printf '  [dry-run] chmod -R a-w %s\n' "$HV"
else
  # 不吞错误：chmod 在自己没有权限时（例如受限沙箱内）会失败，
  # 这里必须把失败暴露出来，否则会谎报"已固化"。
  chmod_err="$(chmod -R a-w "$HV" 2>&1)" || true
  if [ -n "$chmod_err" ]; then
    warn "chmod 报错（说明当前权限不足，冻结未完成）："
    printf '%s\n' "$chmod_err" | head -5 | sed 's/^/      /'
  fi
  # 复核
  leftovers="$(find "$HV" \( -type f -o -type d \) -perm -u+w 2>/dev/null | wc -l | tr -d ' ')"
  LEFTOVERS="$leftovers"
  if [ "$leftovers" = "0" ]; then ok "整树已只读（0 个可写条目）"
  else
    bad "仍有 $leftovers 个可写条目（冻结不完整）："
    find "$HV" \( -type f -o -type d \) -perm -u+w 2>/dev/null | head -10 | sed 's/^/      /'
  fi
fi

# ---------------------------------------------------------------- 3. 基线
head1 "3. 刷新基线"
BASELINE="$HERE/baseline.tsv"
if [ "$DRY" = 1 ] && [ "$BASELINE_ONLY" != 1 ]; then
  printf '  [dry-run] 写入 %s\n' "$BASELINE"
else
  {
    printf '# dsh-runtime-freeze baseline v1\n'
    printf '# generatedAt\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
    printf '# harnessRoot\t%s\n' "$HV"
    printf '# kind\tsha256\tmode\tpath\n'
    while IFS= read -r rel; do
      p="$HV/$rel"; [ -e "$p" ] && printf 'harness\t%s\t%s\t%s\n' "$(sha_of "$p")" "$(mode_of "$p")" "$rel"
    done < <(hv_critical_files)
    while IFS= read -r rel; do
      p="$DSH_HOME_DIR/$rel"; [ -e "$p" ] && printf 'dshhome\t%s\t%s\t%s\n' "$(sha_of "$p")" "$(mode_of "$p")" "$rel"
    done < <(dsh_critical_files)
    [ -f "$MANIFEST" ] && printf 'runtime\t%s\t%s\t%s\n' "$(sha_of "$MANIFEST")" "$(mode_of "$MANIFEST")" "runtime/manifest.json"
    if [ -f "$SNAPSHOT" ]; then
      printf 'snapshot\t%s\t%s\t%s\n' "$(sha_of "$SNAPSHOT")" "$(size_of "$SNAPSHOT")" "$(basename "$SNAPSHOT")"
    fi
    printf '# tree\t%s\t%s\t%s\n' "$(find "$HV" -type f 2>/dev/null | wc -l | tr -d ' ')" "$(find "$HV" \( -type f -o -type d \) -perm -u+w 2>/dev/null | wc -l | tr -d ' ')" "$HV"
  } > "$BASELINE"
  ok "基线已写入 ${BASELINE}（$(grep -vc '^#' "$BASELINE") 条）"
fi

# ---------------------------------------------------------------- 4. 快照
if [ "$DO_SNAPSHOT" = 1 ]; then
  head1 "4. 生成恢复快照"
  NEWSNAP="$HARNESS_ROOT/harness-core-$(date +%Y%m%d).tar.gz"
  if [ -f "$NEWSNAP" ]; then
    warn "已存在，跳过: $NEWSNAP"
  elif [ "$DRY" = 1 ]; then
    printf '  [dry-run] tar -czf %s -C %s harness-versions/%s\n' "$NEWSNAP" "$HARNESS_ROOT" "$(basename "$HV")"
  else
    mkdir -p "$HARNESS_ROOT" 2>/dev/null
    tar -czf "$NEWSNAP" -C "$HARNESS_ROOT" "harness-versions/$(basename "$HV")" && \
      ok "快照: $NEWSNAP ($(du -h "$NEWSNAP" | awk '{print $1}'))" || bad "快照生成失败"
  fi
fi

head1 "完成"
if [ "$BASELINE_ONLY" = 1 ]; then
  ok "已只刷新基线（未改动系统）；运行 ./verify.sh 复核"
elif [ "$DRY" = 1 ]; then
  warn "dry-run：未做任何改动"
elif [ "${LEFTOVERS:-0}" != "0" ]; then
  bad "固化未完成：仍有 ${LEFTOVERS} 个可写条目（见上方列表）。用更高权限重跑本脚本。"
  exit 1
else
  ok "运行时已固化；现在可运行 ./verify.sh 复核"
fi
exit 0
