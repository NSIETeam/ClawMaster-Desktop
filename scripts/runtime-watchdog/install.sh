#!/usr/bin/env bash
# install.sh —— 把「ClawMaster 启动前自愈」安装为 LaunchAgent
#
# 装完之后你不必记得手动跑：
#   · 登录时（RunAtLoad）先体检自愈一次
#   · 每 5 分钟（StartInterval 300）巡检一次
#   · manifest / profile / 版本目录一变（WatchPaths）立刻跑一次
#
# 用法：
#   ./install.sh              # 安装并立即跑一次
#   ./install.sh --uninstall  # 卸载
#   ./install.sh --dry-run    # 只打印将要写入的 plist

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
HARNESS_DIR="${DSH_HARNESS_HOME:-$HOME/Library/Application Support/DeepSeek Harness}"
NODE="${DSH_NODE:-/usr/local/bin/node}"
LABEL="com.clawmaster.preflight"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$DSH_HOME_DIR/logs"

DRY=0
case "${1:-}" in
  --uninstall)
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
    rm -f "$PLIST"
    echo "已卸载 ${LABEL}（${PLIST} 已删除）"
    exit 0 ;;
  --dry-run) DRY=1 ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
esac

read -r -d '' PLIST_BODY <<PLIST_EOF || true
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${HERE}/resident-doctor.sh</string>
  </array>

  <!-- 登录即跑一次 -->
  <key>RunAtLoad</key>
  <true/>
  <!-- 每 5 分钟兜底巡检 -->
  <key>StartInterval</key>
  <integer>300</integer>

  <!-- 关键：这是"常驻"的实现方式 —— 事件驱动，不是轮询。
       boot.log 一出现崩溃行就立刻唤醒医生（实测约 1 秒），
       赶在桌面 App 自己重试之前把病因修掉。
       另外三个路径覆盖 app 升级 provision 出新树、以及 profile 被改。 -->
  <key>WatchPaths</key>
  <array>
    <string>${HARNESS_DIR}/boot.log</string>
    <string>${HARNESS_DIR}/runtime/manifest.json</string>
    <string>${HARNESS_DIR}/harness-versions</string>
    <string>${DSH_HOME_DIR}/profiles/web/package.json</string>
    <string>${DSH_HOME_DIR}/profiles/web/cordis.patch.yml</string>
  </array>

  <!-- 自愈不应该在失败时空转重试：heal 自己决定退出码 -->
  <key>KeepAlive</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_NODE</key>
    <string>${NODE}</string>
    <key>PATH</key>
    <string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOGDIR}/preflight.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGDIR}/preflight.err.log</string>
</dict>
</plist>
PLIST_EOF

if [ "$DRY" = 1 ]; then
  printf '%s\n' "$PLIST_BODY"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
printf '%s\n' "$PLIST_BODY" > "$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null || { echo "plist 格式校验失败"; exit 1; }

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$UID" "$PLIST" || { echo "bootstrap 失败"; exit 1; }
launchctl kickstart -p "gui/$UID/$LABEL" 2>/dev/null

echo "已安装 $LABEL"
echo "  plist : $PLIST"
echo "  日志  : $LOGDIR/clawmaster-heal.log"
echo "  状态  : launchctl print gui/$UID/$LABEL | head -20"
echo
echo "提示：为了消掉「升级后第一次启动」那次竞态，可用自带的启动包装器："
echo "  ${HERE}/open-clawmaster.sh   （先自愈，再启动 App）"
