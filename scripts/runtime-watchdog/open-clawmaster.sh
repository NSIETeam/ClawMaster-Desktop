#!/usr/bin/env bash
# open-clawmaster.sh —— 先自愈，再启动 ClawMaster
#
# 为什么需要它：app 升级后，provision 几十毫秒内就会新建版本目录并拉起 dsh web，
# 定时任务根本来不及补 CSP 补丁 —— 那次启动仍然是白屏/错位。
# 从登录项或 Dock 走这个包装器，就没有这个竞态：补丁一定先打好。
#
# 用法：双击，或 `open -a` 换成它；建议替换 Dock 里的 ClawMaster 图标。

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! "$HERE/heal.sh" --quiet; then
  printf '\n\033[33m注意\033[0m：自愈未能全部通过（多半是受保护核心缺失或网络问题）。\n'
  printf '      仍会尝试启动；若窗口异常，请看 %s/logs/clawmaster-heal.log\n\n' "${DSH_HOME:-$HOME/.dsh}"
fi

exec /usr/bin/open -a ClawMaster
