#!/usr/bin/env bash
# 共用定义：DSH 运行时固化 —— 关键面（critical surface）与路径解析
# 被 freeze.sh / verify.sh source。
# 只依赖：bash、shasum、stat、jq（macOS 自带前三个；jq 在 /usr/bin/jq）
#
# 说明：本文件里的 ok/bad/warn 只负责"打印"；成功/失败计数由调用方
# （verify.sh 的 report_* 包装）负责，避免重复计数。

set -uo pipefail

HARNESS_ROOT="${DSH_HARNESS_ROOT:-$HOME/Library/Application Support/DeepSeek Harness}"
DSH_HOME_DIR="${DSH_DSH_HOME:-$HOME/.dsh}"

MANIFEST="$HARNESS_ROOT/runtime/manifest.json"
SNAPSHOT="${DSH_SNAPSHOT:-$HARNESS_ROOT/harness-core-20260919.tar.gz}"
APP_ROOT="${DSH_APP_ROOT:-/Applications/ClawMaster.app}"
APP_SOURCE="$APP_ROOT/Contents/Resources/harness-source"

# ---- harness 版本目录：以 runtime/manifest.json 为准，而非硬编码 hash ----
harness_version_dir() {
  local root
  root="$(jq -r '.harnessRoot // empty' "$MANIFEST" 2>/dev/null)"
  if [ -n "$root" ] && [ -d "$root" ]; then printf '%s\n' "$root"; return 0; fi
  # 回退：取 harness-versions 下最新的目录
  ls -1dt "$HARNESS_ROOT/harness-versions"/*/ 2>/dev/null | head -1 | sed 's:/$::'
}

# ---- 关键文件清单（相对各自根）----
# harness 树内：被改动/被打补丁的编译产物（CSP 修复落点 + 同批文件）
hv_critical_files() {
  printf '%s\n' \
    "packages/host/frontend-static/lib/index.js" \
    "packages/host/frontend-static/lib/index.js.bak-20260919" \
    "packages/core/session/lib/index.js" \
    "packages/boot/app-boot/lib/index.js" \
    "vendor/include/lib/index.js"
}

# ~/.dsh 层：承载"隐性行为"，丢失不报错、只会悄悄失效
dsh_critical_files() {
  printf '%s\n' \
    "settings.yaml" \
    "cordis.patch.yml" \
    "profiles/web/package.json" \
    "profiles/web/cordis.patch.yml" \
    "profiles/web/cordis.yml" \
    "profiles/web/pnpm-workspace.yaml" \
    "scripts/clawmaster-maintenance.sh"
}

# ---- 小工具 ----
sha_of()  { [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}'; }
mode_of() { [ -e "$1" ] && stat -f '%Sp' "$1"; }
size_of() { [ -f "$1" ] && stat -f '%z' "$1"; }

# ---- 输出（只打印，不计数）----
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
head1(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
