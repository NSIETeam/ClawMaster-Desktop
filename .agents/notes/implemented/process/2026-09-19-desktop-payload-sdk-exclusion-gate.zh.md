# Agent Note: 已发布 core 依赖排除的发布检查

Status: implemented

[English](2026-09-19-desktop-payload-sdk-exclusion-gate.md) | 中文

## 问题

已发布的桌面安装包不得携带外部 subagent 后端 `@openai/codex` 与 `@anthropic-ai/claude-agent-sdk`。`apps/desktop-tauri/scripts/bundle-harness-source.mjs` 通过 `pruneInstalledCore` 完成该移除，而它的排除范围列表是函数内的局部数组。该函数未被导出，也没有任何测试引用它：`bundle-harness-source.test.mjs` 完全没有提到 `pruneInstalledCore`、`@openai` 或 `@anthropic-ai`，其他桌面脚本测试也没有解析过这些范围。

其后果是双向的静默回归路径。从列表中删掉一个范围，或重命名消费它的函数，都会交付一个携带产品并不支持的后端的安装包，而现有全部门禁仍然全绿。误加一个范围同样静默：过度裁剪会移除载荷仍然导入的包，而失败只在已安装的机器上暴露。

## 决策

把排除范围列表导出为 `PRUNED_DEPENDENCY_PACKAGES` 并导出 `pruneInstalledCore`，再在 `test:bundle` 本就会运行的测试文件中同时断言该排除，以及使该排除安全的条件。载荷字节不变，被裁剪的包集合也不变。

本说明负责桌面载荷的依赖排除以及固定它的检查。[生产安装排除决策](../../archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md)负责另一个 Profile 层决定，即 `@deepseek-ai/dsh-base` 不依赖也不挂载任一产品提供方；[subagent 后端说明](../feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)负责这些提供方的协议。两者都未被取代：本次改动不从载荷中移除任何东西，也不改变任何放置决定。

- `PRUNED_DEPENDENCY_PACKAGES` 是该排除决定的唯一归属，并已冻结，因此消费方无法在运行时扩展它。
- `pruneInstalledCore` 读取该常量而不是局部字面量，因此列表与移除动作不会彼此漂移。
- 保留清单与裁剪清单一样被直接断言。若裁剪后合成的 core 中缺少 `@earendil-works/pi-ai`（LLM 提供方层），或裁剪列表中出现 `sherpa-onnx`、`@img`、`pdf-lib`、`node-pty` 或 `@earendil-works` 等保留范围，测试即失败。

两个产品提供方都在模块加载时硬依赖各自的运行时，因此裁剪掉它会让载荷中留有一个无法被导入的提供方包，而不是一个优雅降级的提供方：

| 提供方 | 加载时依赖 |
|---|---|
| `@deepseek-ai/dsh-subagent-claude-code` | `src/process.ts` 与 `src/run.ts` 中的 `import … from '@anthropic-ai/claude-agent-sdk'` |
| `@deepseek-ai/dsh-subagent-codex` | `src/run.ts` 模块顶层的 `createRequire(import.meta.url).resolve('@openai/codex/package.json')` |

裁剪先于 `installBundledCore` 中悬挂符号链接的清扫执行。裁剪会删除 `node_modules/.bin` 垫片所指向的包，因此先清扫会把这些垫片留成悬挂链接，而 Tauri 的资源遍历会拒绝整个载荷目录（`resource path ../bundled/harness/node_modules/.bin/tsserver doesn't exist`），此前每一次桌面发布构建都因此失败。调换这两次调用，才让一个排除了 `typescript` 的载荷能够被打包。

因此，只有当没有任何桌面 Bundle 挂载这两个提供方时，裁剪才是安全的。`scripts/desktop-defaults.mjs` 中的 `DESKTOP_BUNDLES` 一个都不挂载，这与上面的生产安装排除决策一致；新增的测试直接断言这一耦合，因此在未恢复其运行时的前提下把产品提供方加入桌面 Bundle 列表会直接让测试套件失败，而不是交付一个 Profile 无法启动的安装包。

## 后果

排除项与保留清单若发生漂移，`test:bundle` 就会失败；使该排除安全的那层 Bundle 耦合同样如此。

载荷仍以工作区源码的形式包含这两个提供方包：用户若针对随包附带的离线 core 启用其中任一 Bundle，会收到来自提供方的模块缺失失败，而不是一条指明后端缺失的消息。把产品运行时恢复到载荷中，或把提供方源码从载荷中移除，都是本说明不做的载荷决定。本次改动不改变已安装载荷的大小或内容。

## 曾考虑的替代方案

**只断言裁剪清单，不断言保留清单。** 已否决：保留清单保护的正是 LLM 提供方层，而过度裁剪的改动与裁剪不足的改动一样静默。

**通过新增包级导出面来测试 `pruneInstalledCore`。** 已否决：桌面构建脚本由它自己的 `test:bundle` 运行消费，新增第二个入口会让一个只有一个归属的载荷决定出现两处所有者。

**增加参数，让测试注入排除范围列表而不是改动该常量。** 已否决：构建脚本上的纯测试参数并不是产品需要的能力，而该常量已经就是唯一归属；替代做法是证明各条验收路径都会对真实改动该常量而失败。

## 验证

无法失败的测试不会关上这个缺口，因此每条验收路径在提交前都对照真实改动验证过。每次对源码做单范围改动后都运行 `node --test scripts/bundle-harness-source.test.mjs`，并在两次运行之间恢复该文件：

| 对 `PRUNED_DEPENDENCY_PACKAGES` 的改动 | 失败的测试数 |
|---|---|
| 无（对照） | 0 |
| 移除 `@anthropic-ai` | 2 |
| 移除 `@openai` | 2 |
| 移除 `openai` | 2 |
| 加入 `@earendil-works` | 2 |

每次改动有两个测试失败，是因为一个断言从已安装树中移除，另一个断言列表本身；两者都旨在拒绝同一个回归。

`node --test apps/desktop-tauri/scripts/bundle-harness-source.test.mjs` 报告 16 项通过、0 项失败，其中包含新增的两个测试。`test:bundle` 中的其他文件通过。`build-provenance.test.mjs` 只在本分支的 worktree 中失败，原因是该 worktree 没有 `frontends/dsh/node_modules` 供 `esbuild` 解析；同一文件在未被修改的主检出中报告 6 项通过、0 项失败。
