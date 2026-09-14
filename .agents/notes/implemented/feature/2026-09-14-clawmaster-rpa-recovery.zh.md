# Agent Note: 把受治理的 RPA 控制面恢复为 DSH 组件

Status: implemented

[English](2026-09-14-clawmaster-rpa-recovery.md) | 中文

## Problem

ClawMaster 需要一个强大的 RPA 组件。但 DSH 桌面化改造把它原有的那套丢掉了：分支 `codex/clawmaster-before-dsh`（检查点 `7f7616c3e4`，"chore: checkpoint ClawMaster before DSH desktop adoption"）上带着一套受治理的 RPA——一个 TypeScript 控制面加一个 Rust 原生控制面——而当前分支里一行都没有。没有任何记录说明它被丢掉，于是这个能力看起来像是不存在，而不是放错了地方；面对这个需求的第一反应也就变成了从零设计一个替代品。

## Decision

以恢复出的实现为准，恢复而不是重新设计。它已经具备新设计正在追求的那些性质，有些地方还更强：模型永远不提供 PID 或坐标，而是从控制面产出的加密产物里选择窗口引用（`@wN`）与元素引用（`@eN`）；已经开始的、带外部副作用的动作被中断后会变成 `unknown_outcome`，绝不自动重放；被拒绝的审批会留下持久回执却不冻结整次运行；可编辑值在语义快照中被脱敏。

组件是 `frontends/rpa`（`@clawmaster/dsh-rpa`），分三部分。`seam/` 是逐字还原的 TypeScript 控制面——契约、端口、受策略约束的运行器、带版本校验的文件存储，以及按运行隔离的 Web 驱动。`src/` 是 DSH 宿主半：三个面向模型的工具加一个进程桥。`native/` 是作为独立 crate 的 Rust 控制面。

Rust 控制面不需要任何改造：它对 `tauri::` 的引用为零，也没有声明任何 Tauri 命令，所以它本来就是"只是恰好住在 `src-tauri/` 下"的控制面。DSH 之前的 `main.rs` 会在命令行响应 `--native-tool <name>`、否则启动 GUI，所以"独立进程、stdout 输出 JSON、stderr 输出错误并以退出码 2 结束"这套助手传输形态同样是恢复出的契约，而不是新做的选择。这个二进制只保留其中的命令行角色。

有两处缺口必须补，两处都是新增而不是重写。恢复出的分发支持 `capabilities`、`desktop-snapshot`、`input` 和文档写入，却没有暴露十六个语义化的 `rpa_*` 工具——那些工具在 DSH 之前是由应用进程内调用的；`native/src/rpa_cli.rs` 从 JSON 请求构造 `ModelToolCall`，并运行应用当年用的同一个 `NativeRpa::execute` 分发器。而用 `serde_json` 编码的工具目录在命令行上取不到，所以由 `main.rs` 自己响应 `--native-tool definitions`，从而让恢复出的 `native_tools.rs` 保持逐字不变。

治理需要的是修复，而不只是接线。`native_rpa::is_write` 把八个工具归类为触碰外部世界，但 `NativeRpa::execute` 只对其中一部分强制审批绑定：`rpa_start` 会一路走到 `launch` 而自身不做任何检查——这一点是测出来的而不是假设的：一次未经批准的 `rpa_start` 创建了运行记录、真实的浏览器 profile 目录和状态库，并报告 `state: "running"`。恢复出的设计把这个决定放在调用方，而 DSH 之前的应用就是那个调用方；现在调用方成了这个适配器，所以由 `rpa_cli.rs` 执行恢复出的闸门：`is_write_call` 决定是否需要审批，`approval_summary` 组装运维当年会看到的请求文本，`record_rejection` 通过恢复出的路径留下拒绝回执。同一调用在改动之后不创建任何 profile，并给出 `state: "rejected"`、`idempotencyKey: "rejected:launch"`、以审批提示文本为原因的收据。

因此宿主半永远发送 `approvalId: null`，绝不自己发明审批；它也不在 TypeScript 里复制写分类，因为适配器与分类本身在同一个进程、同一种语言里强制执行它。`rpa_native` 另外把命令行限制在只读集合内，所以裸坐标的 `input` 子命令对模型不可达。

宿主半直接以字面量声明工具定义，而不是调用 harness 的工厂函数，因此它的产物除了 Node 内建模块之外不导入任何东西。这与其它内置组件一致，也让这个组件能从干净的检出直接测试：它自己没有 `node_modules`，但 `node scripts/build.mjs` 与 `node --import tsx/esm --test tests/*.test.mjs` 都能跑。裸定义要自己负责输入校验，因此各处理器显式校验 action、子命令与工具名，而不是依赖 schema 包装。

## Alternatives considered

从零设计一个新组件是最初的计划，在找到那个分支之后被放弃；替代品恰恰在要紧的地方更弱，包括产物作用域的引用与 unknown_outcome 处理。整套复制恢复出的 Rust 闭包在测量之后被否决：基于 `crate::` 计算的闭包报告为 13 个模块 11,393 行，但按 `use` 语句算出的真实闭包是 6 个模块 6,341 行，而与 `native_agent_tools` 的表面耦合只出现在一个 `#[test]` 里。复用已发布的某个 macOS 微信 MCP 被否决，因为这台机器既没有 `uv` 也没有 `bun`，那会让一个无关运行时变成前置条件。在 `native/system` 下加 N-API 插件被否决，因为它的构建阶梯只认识两种类型，而且 darwin-x64 根本没有产物。让恢复出的分发器只能在进程内可达被否决，因为 DSH harness 是另一个 Node 进程。

## Consequences

`native_tools.rs` 是个混合模块：它同时装着 RPA 的操作系统适配层和文档写入器（docx、pptx、pdf、chart），所以这个 crate 为了 RPA 路径根本不会走到的代码背上了 `lopdf` 和 `zip`。拆分被推迟，在那之前恢复出的文件保持不动。

桌面动作仍然跑不起来：没有接审批桥，所以每个写步骤都会被拒绝并留下回执。交付它需要在宿主半接上 harness 的审批能力，并就哪些动作可以预先授权作出决定。

已发布的应用程序是 ad-hoc 签名且没有任何 entitlement，所以 macOS 的辅助功能与屏幕录制授权撑不过一次重装。这是分发任务而不是组件任务，并且不受今天 `updater` 端点为空的影响。

记录这次恢复并不能补上 DSH 之前那套工作当时仍然缺失的证据：它自己的文档写明 release gate #21 仍未闭合，需要已安装的 Windows x64 与 macOS ARM64 构建上做出一次真实可见的点击、取消后不残留任何自有浏览器子进程、Safari 通过其系统 WebDriver 契约，以及在同一次运行上完成截图、审批、审计与回执。这道门里已有一部分在本机变成实测而非待办。`rpa_browser_support` 发现了 Google Chrome 与 `/usr/bin/safaridriver`，并把后者标记为具备 WebDriver 契约；`rpa_webdriver_probe` 对 `safari-webdriver` 适配器返回了提供它的 Safari 版本；两个调用都不需要运行记录或审批。可见点击、取消残留、截图、审批、审计与回执这几部分仍需已安装的构建。

## Verification

在 `frontends/rpa/native` 下 `cargo check --lib` 与 `cargo build --bin clawmaster-rpa-native` 都以 0 退出（一条 `write_docx_content` 的 dead-code 警告，恢复出的分发够得到它但 RPA 路径不会走），工作区锁定了恢复出的 crate 版本，包括 `xa11y = "=0.13.0"`。

构建出的助手在 `--native-tool capabilities` 下返回七项清单，其中 `desktop.input` 项声明了 `rust:xa11y-input` 提供方与 `rpa_click` 工具；在 `--native-tool definitions` 下返回全部十六个恢复出的工具；在 `--native-tool desktop-snapshot` 下以退出码 2 拒绝，并给出指明确切系统设置面板的消息——这独立复现了在本机另行测得的权限状态。

恢复出的缝自带测试套件在这个组件内通过（13 通过，1 个 e2e 在未设 `RUN_RPA_BROWSER_E2E=1` 时跳过）。宿主半与桥接合计通过 22 项测试。宿主演习覆盖持久化运行回路、跨处理器实例的带版本校验持久化、外部副作用拒绝、工具注册，以及 `approve` 对模型不可达。桥接测试覆盖 JSON 解析、非零退出的原因传递、非 JSON 输出、超时、取消、二进制缺失、只读子命令白名单、未构建助手报告为不可用、宿主半为语义调用发送的确切请求，以及两个真实助手用例。

第一个真实助手用例直接断言审批闸门：只读的 `rpa_status` 返回 `{"run": null}`，而 `rpa_start` 返回空的 `profilePath` 与一条收据，其 `state` 为 `"rejected"`、`externalSideEffect` 为 `true`、`approvalId` 为 `null`、原因为审批提示文本。第二个接受桌面快照成功或权限拒绝，但不接受静默的空快照，并检查浏览器半返回的条目带有 `id`、`installed` 与 `webdriverContract` 标志。在这台 macOS ARM64 机器上，该浏览器半报告 Chrome 已安装、`/usr/bin/safaridriver` 已安装且具备 WebDriver 契约，`rpa_webdriver_probe` 对 `safari-webdriver` 适配器返回 `Included with Safari 26.5 (21624.2.5.11.4)`。`node scripts/build.mjs --check` 与 `dist/` 一致。
