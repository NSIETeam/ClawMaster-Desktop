#!/usr/bin/env bash
# verify.sh —— DSH 运行时固化状态核对（只读，不做任何写操作）
#
# 退出码：0 = 固化完好；1 = 有漂移/缺失（详见输出）
#
# 用法：
#   ./verify.sh            # 人类可读报告
#   ./verify.sh --quiet    # 只输出结论行

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

BASELINE="$HERE/baseline.tsv"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1
FAILED=0
WARNED=0

report_head() { [ "$QUIET" = 1 ] || head1 "$*"; }
report_ok()   { [ "$QUIET" = 1 ] || ok "$*"; }
report_bad()  { FAILED=$((FAILED + 1)); [ "$QUIET" = 1 ] || bad "$*"; }
report_warn() { WARNED=$((WARNED + 1)); [ "$QUIET" = 1 ] || warn "$*"; }

report_head "DSH 运行时固化核对 · $(date '+%Y-%m-%d %H:%M:%S %Z')"

# ---------------------------------------------------------------- 0. 定位
HV="$(harness_version_dir)"
if [ -z "$HV" ] || [ ! -d "$HV" ]; then report_bad "找不到 harness 版本目录"; printf '结论: FAIL（无运行时目录）\n'; exit 1; fi
report_ok "harness 版本目录: $(basename "$HV")"
report_ok "manifest 指向: $(jq -r '.harnessVersion // "?"' "$MANIFEST" 2>/dev/null) / $(jq -r '.bundleSha256 // "?"' "$MANIFEST" 2>/dev/null | cut -c1-16)"

# ---------------------------------------------------------------- 1. 只读性
report_head "1. 冻结（只读位）"
TOTAL_FILES="$(find "$HV" -type f 2>/dev/null | wc -l | tr -d ' ')"
WRITABLE="$(find "$HV" \( -type f -o -type d \) -perm -u+w 2>/dev/null)"
WRITABLE_N="$(printf '%s' "$WRITABLE" | grep -c . || true)"
if [ "$WRITABLE_N" = "0" ]; then
  report_ok "整树只读：$TOTAL_FILES 个文件，0 个可写条目"
else
  report_bad "有 $WRITABLE_N 个可写条目（冻结不完整）："
  printf '%s\n' "$WRITABLE" | head -10 | sed 's/^/      /'
fi
if [ -w "$HV" ]; then report_bad "版本目录本身可写"; else report_ok "版本目录不可写（$(mode_of "$HV")）"; fi

# ---------------------------------------------------------------- 2. CSP 补丁
report_head "2. CSP 补丁（前端空白/错位的唯一修复点）"
FS="$HV/packages/host/frontend-static/lib/index.js"
if [ ! -f "$FS" ]; then
  report_bad "缺少 $FS"
else
  grep -q "script-src 'self' 'unsafe-eval'" "$FS" \
    && report_ok "script-src 'unsafe-eval' 在位" \
    || report_bad "script-src 缺 'unsafe-eval' → 前端顶层 new Function 会被 CSP 拦截（窗口空白）"
  grep -q "style-src 'self' 'unsafe-inline'" "$FS" \
    && report_ok "style-src 'unsafe-inline' 在位" \
    || report_bad "style-src 缺 'unsafe-inline' → 插件样式被拦截（右侧栏错位）"
  # 若 style-src 同时带 nonce/哈希，unsafe-inline 会被规范忽略
  if grep -q "style-src 'self' 'unsafe-inline'" "$FS"; then
    case "$(grep -m1 'style-src' "$FS")" in
      *styleNonce*) report_bad "style-src 行仍带 nonce —— 按 CSP 规范 unsafe-inline 会被忽略（右侧栏错位会复现）" ;;
      *)            report_ok  "style-src 行已无 nonce/哈希（unsafe-inline 真正生效）" ;;
    esac
  fi
  [ -f "$FS.bak-20260919" ] && report_ok "原版备份存在（$(basename "$FS").bak-20260919）" \
                            || report_warn "未找到 $FS.bak-20260919（回退原版将失去参照）"
fi

# ---------------------------------------------------------------- 3. 同批文件与 app 源自洽
report_head "3. 编译产物与 app 自带源自洽性"
SRC="/Applications/ClawMaster.app/Contents/Resources/harness-source"
if [ -d "$SRC" ]; then
  for rel in packages/core/session/lib/index.js packages/boot/app-boot/lib/index.js vendor/include/lib/index.js; do
    if [ ! -f "$SRC/$rel" ]; then report_warn "$rel 在 app 源中不存在（跳过）"
    elif cmp -s "$SRC/$rel" "$HV/$rel"; then report_ok "$rel 与 app 源一致"
    else report_bad "$rel 与 app 源不一致（非预期改动）"; fi
  done
  if cmp -s "$SRC/packages/host/frontend-static/lib/index.js" "$FS" 2>/dev/null; then
    report_warn "frontend-static/lib/index.js 与 app 源相同 —— 补丁可能已被覆盖！"
  else
    report_ok "frontend-static/lib/index.js 与 app 源不同（= 补丁生效）"
  fi
else
  report_warn "找不到 app 自带源（${SRC}），跳过自洽性检查"
fi

# ---------------------------------------------------------------- 4. 基线比对
report_head "4. 关键面基线比对"
if [ ! -f "$BASELINE" ]; then
  report_warn "尚无基线（${BASELINE}）—— 先跑 ./freeze.sh 建立基线"
else
  base_gen="$(grep '^# generatedAt' "$BASELINE" | cut -f2)"
  report_ok "基线生成于: ${base_gen:-未知}"
  DRIFT=0
  while IFS=$'\t' read -r kind sha mode path; do
    case "$kind" in \#*|"") continue ;; esac
    case "$kind" in
      harness) target="$HV/$path" ;;
      dshhome) target="$DSH_HOME_DIR/$path" ;;
      runtime) target="$HARNESS_ROOT/$path" ;;
      snapshot) target="$SNAPSHOT"; sha_live="$(sha_of "$SNAPSHOT")" ;;
      *) continue ;;
    esac
    if [ "$kind" = "snapshot" ]; then
      cur="$(sha_of "$target")"
      if [ "$cur" = "$sha" ]; then report_ok "快照完好 ($path)"
      else report_bad "快照哈希不符 ($path)"; DRIFT=$((DRIFT + 1)); fi
      continue
    fi
    if [ ! -e "$target" ]; then report_bad "缺失: $kind/$path"; DRIFT=$((DRIFT + 1)); continue; fi
    cur="$(sha_of "$target")"
    if [ "$cur" != "$sha" ]; then
      report_bad "内容漂移: $kind/$path"
      printf '      基线 %s\n      当前 %s\n' "$sha" "$cur"
      DRIFT=$((DRIFT + 1))
    elif [ "$(mode_of "$target")" != "$mode" ]; then
      report_warn "权限变化: $kind/${path}（基线 ${mode} → 当前 $(mode_of "$target")）"
    fi
  done < "$BASELINE"
  [ "$DRIFT" = "0" ] && report_ok "所有基线文件与基线一致" || report_bad "共 $DRIFT 项漂移"
fi

# ---------------------------------------------------------------- 5. 恢复快照
report_head "5. 恢复能力"
if [ -f "$SNAPSHOT" ]; then
  report_ok "快照: $(basename "$SNAPSHOT") ($(du -h "$SNAPSHOT" | awk '{print $1}'))"
else
  report_bad "缺少恢复快照: $SNAPSHOT"
fi
PATCH_DIR="$HARNESS_ROOT/../../.."
[ -f "$HARNESS_ROOT/HARNESS-CORE-README.md" ] && report_ok "恢复文档在位 HARNESS-CORE-README.md" \
                                              || report_warn "缺少 HARNESS-CORE-README.md"

# ---------------------------------------------------------------- 6. 版本与更新
report_head "6. 版本面"
report_ok "app 版本: $(/usr/bin/plutil -extract CFBundleShortVersionString raw "$APP_ROOT/Contents/Info.plist" 2>/dev/null || echo '?')"
report_ok "harness: $(jq -r '.harnessVersion // "?"' "$MANIFEST" 2>/dev/null)  node: $(jq -r '.nodeVersion // "?"' "$MANIFEST" 2>/dev/null)"
APP_BUNDLE_SHA="$(jq -r '.contentSha256 // empty' "$APP_SOURCE/.bundle-manifest.json" 2>/dev/null)"
RUN_BUNDLE_SHA="$(jq -r '.bundleSha256 // empty' "$MANIFEST" 2>/dev/null)"
if [ -n "$APP_BUNDLE_SHA" ] && [ -n "$RUN_BUNDLE_SHA" ]; then
  if [ "$APP_BUNDLE_SHA" = "$RUN_BUNDLE_SHA" ]; then
    report_ok "运行时 = 当前 app 内置 bundle（${RUN_BUNDLE_SHA:0:16}…）：provision 不会再新建目录"
  else
    report_bad "app 内置 bundle (${APP_BUNDLE_SHA:0:16}…) ≠ 运行时 (${RUN_BUNDLE_SHA:0:16}…)：app 已升级，下次启动会 provision 新目录，需对新目录重打 CSP 补丁"
  fi
else
  report_warn "无法读取 bundle 指纹，跳过 app/运行时一致性判断"
fi

# ---------------------------------------------------------------- 结论
printf '\n'
if [ "$FAILED" = "0" ]; then
  printf '\033[32m结论: PASS\033[0m — 运行时已固化'
  [ "$WARNED" != "0" ] && printf '（%s 条提醒）' "$WARNED"
  printf '\n'
  exit 0
else
  printf '\033[31m结论: FAIL\033[0m — %s 项失败' "$FAILED"
  [ "$WARNED" != "0" ] && printf '，%s 条提醒' "$WARNED"
  printf '\n'
  exit 1
fi
