#!/usr/bin/env bash
# fixture-test.sh —— 用工作区内的合成环境，端到端证明 preflight/heal 真的能
# 抓出并修好 A/B/C/D 四类故障，且遵守两条硬约束：
#   ① 缺 tool 不得阻断继续任务（降级，不是罢工）
#   ② 保证正常运行的核心内容绝不被自动改动
# **不触碰真实 ~/.dsh 与真实运行时。**
#
# 原理：preflight.mjs / heal.sh 都支持 DSH_HOME 与 DSH_HARNESS_HOME 覆盖。
# 用法：./fixture-test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${DSH_NODE:-/usr/local/bin/node}"
FIX="$HERE/.fixture"
FIX3="$HERE/.fixture-empty-harness"
PASS=0; FAIL=0
ck() { if [ "$1" = "$2" ]; then printf '  \033[32m✓\033[0m %s\n' "$3"; PASS=$((PASS+1));
       else printf '  \033[31m✗\033[0m %s（期望 %s，实际 %s）\n' "$3" "$2" "$1"; FAIL=$((FAIL+1)); fi }

echo "=== 场景 0：静态检查（\$VAR 紧邻非 ASCII 会在 set -u 下静默杀掉脚本）==="
lint_out="$(python3 "$HERE/lint-varexp.py" "$HERE"/*.sh 2>&1)"; lint_rc=$?
ck "$lint_rc" "0" "所有脚本无 \$VAR÷紧邻中文的写法"
[ "$lint_rc" = 0 ] || printf '%s\n' "$lint_out" | sed 's/^/      /'

rm -rf "$FIX" "$FIX3"
mkdir -p "$FIX/profiles/web" "$FIX/sessions/WRONG-WORKSPACE-DIR/WRONG-SESSION-DIR"

# ── 制造 C：一份身份不符的会话日志（目录名与 header 推导出的规范路径不符）
"$NODE" -e '
const {zstdCompressSync}=require("node:zlib"); const fs=require("node:fs");
if (typeof zstdCompressSync !== "function") { console.error("node 缺少 zstdCompressSync"); process.exit(3) }
const header={type:"session",version:3,id:"deadbeef-0000-4000-8000-000000000001",createdAt:Date.now(),cwd:"/tmp/fixture-cwd"};
fs.writeFileSync(process.argv[1]+"/sessions/WRONG-WORKSPACE-DIR/WRONG-SESSION-DIR/session.v3.jsonl.zstd",
  zstdCompressSync(Buffer.from(JSON.stringify(header)+"\n{\"type\":\"event\"}\n","utf8")));
' "$FIX" || { echo "无法构造 fixture（node 不支持 zstd 压缩）"; exit 3; }

# ── 制造 B：两层非法 patch 文件（不是顶层数组）
printf 'not-an-array: true\nfoo: bar\n' > "$FIX/cordis.patch.yml"
printf 'also: not-an-array\n'          > "$FIX/profiles/web/cordis.patch.yml"

# ── bundles 先与真实一致（合法），以便单独验证 B/C
cp "$HOME/.dsh/profiles/web/package.json" "$FIX/profiles/web/package.json"

echo "=== 场景 1：B（两层非法 patch）+ C（会话身份不符）==="
out="$(DSH_HOME="$FIX" "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"; rc=$?
ck "$rc" "1" "preflight 判定为 FAIL"
ck "$(printf '%s' "$out" | jq -r '[.findings[]|select(.kind=="patch-invalid")]|length')" "2" "抓到 2 处非法 patch（home 层 + profile 层，已去重）"
ck "$(printf '%s' "$out" | jq -r '[.findings[]|select(.kind=="session-identity-mismatch")]|length')" "1" "抓到 1 处会话身份不符"

DSH_HOME="$FIX" "$HERE/heal.sh" --quiet >/dev/null 2>&1; hrc=$?
ck "$hrc" "0" "heal 后复检通过"
ck "$(cat "$FIX/cordis.patch.yml")" "[]" "home 层 patch 已重置为顶层数组"
ck "$(cat "$FIX/profiles/web/cordis.patch.yml")" "[]" "profile 层 patch 已重置为顶层数组"
ck "$([ -d "$FIX/sessions-quarantine" ] && echo yes)" "yes" "身份不符的会话已被隔离（不是删除）"
ck "$([ -d "$FIX/sessions/WRONG-WORKSPACE-DIR/WRONG-SESSION-DIR" ] && echo still || echo gone)" "gone" "原会话目录已移出 sessions 树"
ck "$(ls -1 "$FIX"/*.bak-* 2>/dev/null | wc -l | tr -d ' ')" "1" "home 层 patch 原件已备份"

echo "=== 场景 2：A —— 缺 tool 不得阻断继续任务 ==="
"$NODE" -e '
const fs=require("node:fs"); const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.dsh.profile.bundles=["@clawmaster/definitely-not-installed-xyz","@deepseek-ai/dsh-base"];
fs.writeFileSync(p,JSON.stringify(j,null,2));
' "$FIX/profiles/web/package.json"
out2="$(DSH_HOME="$FIX" "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"; rc2=$?
ck "$rc2" "1" "preflight 如实报告 DSH 会硬失败"
ck "$(printf '%s' "$out2" | jq -r '.findings[]|select(.kind=="bundle-unresolved")|.package')" "@clawmaster/definitely-not-installed-xyz" "精确指出是哪个 bundle"

CLAWMASTER_HEAL_NO_INSTALL=1 DSH_HOME="$FIX" "$HERE/heal.sh" --quiet >/dev/null 2>&1; h2=$?
ck "$h2" "0" "heal 后复检通过（缺 tool 已被降级，任务不再受阻）"
ck "$(jq -r '.dsh.profile.bundles|join(",")' "$FIX/profiles/web/package.json")" "@deepseek-ai/dsh-base" "缺的 tool 已从 bundles 摘除，核心保留"

echo "=== 场景 2b：受保护核心绝不被自动摘除 ==="
# 用真实 harness 根（保证 loader 能加载、bundle 判定真实有效），
# 通过 CLAWMASTER_HEAL_PROTECTED_EXTRA 把一个本来"可摘除"的包临时提升为受保护，
# 以此精确命中保护分支。这样断言不会因为 loader 没加载而空转。
"$NODE" -e '
const fs=require("node:fs"); const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.dsh.profile.bundles=["@clawmaster/definitely-not-installed-xyz","@deepseek-ai/dsh-base"];
fs.writeFileSync(p,JSON.stringify(j,null,2));
' "$FIX/profiles/web/package.json"
out2b="$(DSH_HOME="$FIX" "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"
ck "$(printf '%s' "$out2b" | jq -r '[.findings[]|select(.kind=="bundle-unresolved")]|length')" "1" "确认该包确实被判为无法解析（断言非空转）"
CLAWMASTER_HEAL_NO_INSTALL=1 CLAWMASTER_HEAL_PROTECTED_EXTRA="@clawmaster/definitely-not-installed-xyz" \
  DSH_HOME="$FIX" "$HERE/heal.sh" --quiet >/dev/null 2>&1; h2b=$?
ck "$h2b" "1" "受保护时不自作主张：如实保持 FAIL"
ck "$(jq -r '.dsh.profile.bundles|index("@clawmaster/definitely-not-installed-xyz")!=null' "$FIX/profiles/web/package.json")" "true" "受保护的包仍在 bundles 中，未被摘除"
ck "$(grep -c '属于受保护核心' "$FIX/logs/clawmaster-heal.log")" "1" "日志明确说明因受保护而停手"

echo "=== 场景 3：D（CSP 补丁缺失）==="
FIX2="$HERE/.fixture-harness"
rm -rf "$FIX2"; mkdir -p "$FIX2/runtime" "$FIX2/packages/host/frontend-static/lib"
printf '{ "harnessRoot": "%s", "harnessVersion": "0.0.0-fixture", "bundleSha256": "unpatched" }\n' "$FIX2" > "$FIX2/runtime/manifest.json"
# 原版（未打补丁）的 CSP 形态
printf '%s\n' \
  "const csp = [\`script-src 'self' 'wasm-unsafe-eval' 'nonce-\${scriptNonce}'\`, \`style-src 'self' 'nonce-\${styleNonce}'\`];" \
  > "$FIX2/packages/host/frontend-static/lib/index.js"

out3="$(DSH_HARNESS_HOME="$FIX2" DSH_HOME="$FIX" "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"; rc3=$?
ck "$rc3" "1" "preflight 判定为 FAIL"
ck "$(printf '%s' "$out3" | jq -r '[.findings[]|select(.kind=="csp-missing")]|length')" "2" "抓到 script-src 与 style-src 两处补丁缺失（未被去重压掉）"
ck "$(printf '%s' "$out3" | jq -r '[.findings[]|select(.kind=="loader-import")]|length')" "1" "同时如实报告合成根缺少 loader"

echo "=== 场景 4：真实环境不得误报 ==="
out4="$(DSH_HOME="$HOME/.dsh" "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"; rc4=$?
ck "$rc4" "0" "真实环境判定为 PASS"
ck "$(printf '%s' "$out4" | jq -r '[.findings[]|select(.severity=="blocker")]|length')" "0" "真实环境 0 项误报阻断"
ck "$(printf '%s' "$out4" | jq -r '[.findings[]|select(.kind=="runtime-config-invalid")]|length')" "0" "真实环境的 settings/凭据没有被误报为损坏"

echo "=== 场景 5：运行期配置损坏 → 只告警，不得判成阻断 ==="
# 依据：实测 boot 入口（packages/boot、apps/cli/lib）不引用 settings-file，
# 所以这些文件坏了不会让 dsh web 退出；但会静默降级，必须报出来。
printf 'a: [1, 2\nbroken: : :\n' > "$FIX/settings.yaml"
printf '{"a": ' > "$FIX/.credentials-index.json"
out5="$(DSH_HOME="$FIX" "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"
ck "$(printf '%s' "$out5" | jq -r '[.findings[]|select(.kind=="runtime-config-invalid")]|length')" "2" "两种配置损坏都被报出来（YAML + JSON）"
ck "$(printf '%s' "$out5" | jq -r '[.findings[]|select(.kind=="runtime-config-invalid")|.severity]|unique|join(",")')" "warn" "只给 warn，不升级为阻断（它崩不了启动）"
rm -f "$FIX/settings.yaml" "$FIX/.credentials-index.json"

echo "=== 场景 6：磁盘余量（外部条件，也能让启动硬失败）==="
# 真实环境必须报出余量、且不误报
ck "$(printf '%s' "$out4" | jq -r '[.findings[]|select(.kind=="disk-low")]|length')" "0" "真实环境的磁盘余量没有被误报"
ck "$(printf '%s' "$out4" | jq -r '.infos|has("磁盘余量")')" "true" "真实环境如实报出可用空间"

# 用 env 把阈值拉到不可能满足，验证两级判定真的会触发（否则这段代码就是死代码）
w="$(DSH_HOME="$FIX" CLAWMASTER_MIN_FREE_GIB=999999 CLAWMASTER_CRIT_FREE_GIB=1 \
     "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"
# 注意：不能断言 .ok==true —— fixture 的 DSH_HOME 里本来就有别的 blocker（bundle 解析不了）。
# 这里要断言的是"磁盘这一条本身没升级成 blocker"，而不是整份体检通过。
ck "$(printf '%s' "$w" | jq -r '[.findings[]|select(.kind=="disk-low")]|map(.severity)|join(",")')" "warn" "余量低于警戒线 → warn（不升级为 blocker）"

b="$(DSH_HOME="$FIX" CLAWMASTER_MIN_FREE_GIB=999999 CLAWMASTER_CRIT_FREE_GIB=999999 \
     "$NODE" "$HERE/preflight.mjs" --json-only 2>/dev/null)"; brc=$?
ck "$(printf '%s' "$b" | jq -r '[.findings[]|select(.kind=="disk-low")]|map(.severity)|join(",")')" "blocker" "余量低到临界值 → blocker"
ck "$brc" "1" "blocker 级判定为 FAIL（启动真的会失败）"

rm -rf "$FIX2" "$FIX3"
printf '\n\033[1m结果: %s 通过, %s 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
