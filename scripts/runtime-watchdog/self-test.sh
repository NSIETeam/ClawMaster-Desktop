#!/usr/bin/env bash
# self-test.sh —— 一次跑完全部测试（CI 与人工都用这一个入口）
#
# 四套：
#   fixture-test          启动前体检 / 自愈（含磁盘余量、运行期配置损坏）
#   resident-doctor-test  常驻医生：崩溃处理、幂等、深度核对、心跳、部署形态
#   repair-core-test      core 还原：篡改/删除/多余、冻结目录、快照可用性
#   drill-real-snapshot   灾难演习：用**真实快照**走完整还原（没有快照时自动跳过）
#
# 退出码：0=全绿 / 1=有失败

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0

for t in fixture-test.sh resident-doctor-test.sh repair-core-test.sh drill-real-snapshot.sh; do
  printf '\n\033[1m=== %s ===\033[0m\n' "$t"
  if [ ! -x "$HERE/$t" ]; then
    printf '  \033[31m✗\033[0m 缺少或不可执行：%s\n' "$t"
    FAILED=1
    continue
  fi
  if "$HERE/$t"; then
    printf '  \033[32m✓\033[0m %s 通过\n' "$t"
  else
    printf '  \033[31m✗\033[0m %s 失败\n' "$t"
    FAILED=1
  fi
done

printf '\n'
if [ "$FAILED" = 0 ]; then
  printf '\033[32m全部测试通过\033[0m\n'; exit 0
else
  printf '\033[31m有测试失败\033[0m\n'; exit 1
fi
