---
description: "面向 Tauri 前端组合包用户与维护者的 ClawMaster WatchDog 桌面工作台、本地数据处理、CRM 与库存订单说明。"
kind: "package-bundle"
---

# ClawMaster WatchDog 前端

[English](README.md) | 中文

## 概述

ClawMaster 在同一个 Tauri 桌面工作台中提供任务、文档编辑、网页浏览、终端与本地业务记录，口号为“开启AI时代的企业协作”。桌面默认包含本组合包，并由 DSH 负责对话、模型、工具、审批、插件和会话恢复。AI 通过 DSH 工具处理 CSV、查询和整理客户与订单；界面用于查看结果、审批及人工接手。AI 任务复用已配置的 DSH 提供方，手动操作不调用模型。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用 ClawMaster Tauri 桌面应用。运行环境准备程序包含本前端及[桌面默认组件](../../apps/desktop-tauri/README.zh.md#architecture)中列出的插件。[桌面指南](../../apps/desktop-tauri/README.zh.md)负责安装器、运行环境准备与启动说明；本前端包本身不是桌面安装器。

<a id="first-run-tutorial"></a>
### 首次使用教程

没有 Session 或工作空间历史时，WatchDog 以“本周客户跟进与交付风险巡检”教授五步管理流程：确定范围、写清分工与验收标准、核查 CRM/ERP 记录及提供的文件、选择巡检频率并复核审批，再验证结论、跟进整改。负责人和期限是任务说明中的文字约定。主按钮进入 WatchDog 管理台；模型与 IM 设置作为末尾的辅助入口。阅读、跳过或重看均不创建任务，也不会发送提示词或外部消息。已有用户可随时打开“设置 → WatchDog 教程”。

跳过和完成会通过 DSH 设置记录版本化确认，桌面重启或本地端口变化后仍然保留，较新的确认版本不会被降级。写入被拒绝时，教程保持打开并显示重试提示。远程浏览器只在本次设置外壳存续期间保留确认。读完教程不代表 API Key 已验证，也不会创建任务、安排提醒或连接 IM 账号。

### 启动任务或打开工具

应用启动时不创建默认工作空间。没有会话或工作空间历史时，首次进入会打开 WatchDog；已有选择和后续导航优先。启动 WatchDog 任务会在 `$DSH_HOME/watchdog-workspaces/tasks/<uuid>` 下分配目录，并使用 DSH 的常规会话流程。打开编辑器、浏览器或终端时优先使用当前未归档会话；没有可用会话时，首次工具请求才分配 `$DSH_HOME/watchdog-workspaces/desk`，并创建或复用其会话。这些目录和文件会在应用重启后保留。

手动选择工作空间目录时，点击工作区标题栏的**添加工作区**。目录浏览器在 ClawMaster 窗口内打开，可逐级浏览、直接输入路径或新建文件夹，再点击**打开**使用选中的目录。

WatchDog 位于主区。Better Sidebar 在会话右侧的标签页中打开文档编辑、网页浏览、CRM 和 ERP，在底部打开终端。CRM 和 ERP 与其他组件一起在“设置 → 侧边卡片”管理，各组件的功能设置可打开其右侧标签页。组件默认启用，仅在请求时打开；再次打开已存在的组件会选中其标签页。

访问 WatchDog 等全局面板时，当前 Session 右侧的编辑器和浏览器实例继续保留，包括未保存正文和 iframe 文档。隐藏的停靠与浮动内容不占框架列宽或键盘焦点。切换 Session、关闭 tab 或退出前请先保存。[桌面兼容补丁](../../apps/desktop-tauri/README.zh.md#architecture)还按原生 Session 与 tab 身份保留浏览导航，但不持久保存编辑器草稿。

| 模块 | 用途 |
| --- | --- |
| 文档 | 编辑文本和代码，预览会话工作空间中的文件。 |
| 浏览器 | 在 Better Sidebar 的沙箱浏览面板中打开网站。 |
| 终端 | 使用关联到会话工作空间的终端。 |
| CRM | 维护联系人、公司、阶段、下一步行动和跟进日期。 |
| ERP | 维护 SKU、库存、补货线、供应商及采购/销售订单。 |

### 让 AI 使用业务组件

在任务中描述目标，并把需要处理的文件放入该任务的工作空间。例如：“清理 customers.csv 的空白与重复记录，保存 customers-clean.csv，再查询 CRM，整理需要跟进的客户。”AI 直接调用内置业务工具。CRM 和 ERP 组件提供复核及人工操作，文件编辑器可打开 CSV 结果。数据处理不设置独立面板或导航入口。

### 处理 CSV 或 TSV 数据

让 AI 按明确的分隔符、表头、去除首尾空白、去重、删除空记录、子串筛选和排序规则处理工作空间文件。解析保留单元格文本，包括前导零。引号错误或列数不一致会阻止处理与输出，直到原始数据修正。

工具默认输入上限为 16 MiB，结果预览最多显示 10 行。保存的 CSV 包含全部处理结果，并附带 UTF-8 BOM。电子表格公式保护默认开启，会在可触发公式的单元格前添加单引号。DSH 在会话中记录工具结果和保存的文件路径。

### 保存联系人、库存与订单

CRM 和 ERP 使用 `$DSH_HOME/watchdog/enterprise.sqlite` 中的空数据库开始工作。已保存记录不依赖浏览器来源、Host 随机端口或所选会话。联系人和 SKU 的编辑与删除会记录审计信息。已有浏览器 `localStorage` 记录既不会被删除，也不会自动导入 SQLite。

以草稿保存带数量和单价的采购或销售订单。提交采购订单增加库存，提交销售订单扣减库存。所有明细、订单状态、版本号以及变更前后的审计信息在同一事务中提交。库存不足时整笔提交回滚。已提交订单不能修改、删除或重复生效。

库存与数量使用安全整数，金额使用人民币最小货币单位的整数。订单引用的 SKU 不能删除。其他视图修改记录后，基于旧版本保存会返回版本冲突：刷新记录、核对当前值，再重新保存。不支持、属于其他应用或已损坏的数据库会报错，不会自动重置。

Schema 3 迁移新增业务快照以外的责任历史。业务写入和恢复成功记录在同一事务中提交；审计失败会阻止写入。恢复旧备份仍会保留备份之后变更的责任记录。记录包含 Host 生成的操作者、传输来源、Session/调用、审批引用、策略版本、修订、结果和备份摘要，不包含联系人或订单正文。从 schema 1/2 导入的历史回执明确标记操作者未知。已认证的 `/api/clawmaster/enterprise/responsibility` 路由提供最多 500 条的分页，可按操作者、命令、对象或操作筛选。恢复请求提供 `commandId` 后，完全相同的重试具有幂等性。仅追加触发器和校验的哈希链能检测本地不一致；机器管理员能够替换数据库，因此企业留存需要独立可信归档。责任历史不会自动删除，也不包含在可移植的业务备份中。

### 使用提醒与即时通信连接

组合包启用 DSH 官方 Schedule、时间上下文和提醒目录。提醒送达需要应用保持运行，且所属会话中有活动的根 agent（智能体）；关闭应用不会创建操作系统后台调度程序。到期提醒在该会话可以接收时返回原对话。支持的定时方式与恢复行为见 [Schedule 指南](../../docs/user/guide/schedule.zh.md)。

即时通信账号设置与平台登录流程由内置 IM 插件负责。包含该插件并不代表已经连接飞书、微信、企业微信或钉钉；各平台的账号条件和连接结果需要在其设置中实际核验。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现与贡献者检查——点击展开</summary>

侧栏与对话欢迎区通过客户端构建的 SVG data URL loader 渲染透明的[浅色 SVG](src/clawmaster.svg) 或[深色 SVG](src/clawmaster-dark.svg)。CSS 跟随 DSH 解析后的 `body[data-ds-dark-theme]` 状态，包括手动选择主题与跟随系统模式。[桌面资源指南](../../apps/desktop-tauri/README.zh.md#release)负责启动页、favicon 与原生图标分发；[PNG](src/clawmaster.png)仅保留为视觉参考。

[Profile 补丁](cordis.patch.yml)禁用官方品牌与自适应目录选择行，插入本前端及 DSH 的目录浏览后端与界面，启用 Schedule 与时间上下文，并开启提醒界面。DSH Web 组合包已提供这两个目录浏览软件包。[客户端入口](src/client.tsx)使用 DSH 现有的 slot、主题、会话、工作空间与面板服务。[Host 入口](src/host.ts)在已有、带认证的 DSH Fetch 传输层注册惰性工作空间分配和企业路由，不启动第二个服务。

[PapaParse 处理代码](src/business.ts)负责 CSV 语法与序列化。[企业存储](src/enterprise-host.ts)使用 Node SQLite 和事务；HTTP 路由与 [AI 工具](src/enterprise-tools.ts)共用存储、命令校验和版本检查。DSH 设置存储仍用于配置。企业数据不会自动进入模型。

Host 插件通过 Cordis 配置接受以下可选设置。存储路径必须为绝对路径。

| 设置 | 默认值 |
| --- | --- |
| `managedRoot` | `$DSH_HOME/watchdog-workspaces` |
| `databasePath` | `$DSH_HOME/watchdog/enterprise.sqlite` |
| `busyTimeoutMs` | `5000`；SQLite 写锁等待时间，范围为 `0` 至 `60000` 毫秒 |
| `dataTools.maxInputBytes` | `16777216` |
| `dataTools.previewRows` / `previewColumns` / `previewCellChars` / `maxDiagnostics` | `10` / `8` / `120` / `10` |
| `enterpriseTools.maxQueryRows` / `maxQueryBytes` | `100` / `262144` |

在已准备好仓库支持的 Node 运行时和本包依赖后，在本目录执行以下命令：

```sh
npm run typecheck
npm test
npm pack
```

测试命令先构建客户端 factory 和 Host bundle，再执行本包的定向测试。打包时会运行相同构建并生成本地 `.tgz`；本包为 private。React 与 React DOM 来自 DSH 的共享客户端运行时。工具导航先提交会话视图，再打开面板，确保 DSH 面板挂载点已绑定。[桌面构建](../../apps/desktop-tauri/README.zh.md)把前端产物包含在运行时资源中。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [桌面安装与运行时](../../apps/desktop-tauri/README.zh.md)——Tauri 打包、启动与平台行为。
- [Profile 组合](../../packages/boot/app-boot/README.zh.md)——DSH 组合包顺序与配置。
- [官方 Schedule](../../packages/schedule/schedule/README.zh.md)——持久提醒与活动会话内送达。
- [企业记录与命令](src/enterprise-types.ts)——客户端和 Host 共享的数据定义。

-----

<a id="model-experience"></a>
## 模型体验

前端通过 DSH 常规工具流程注册 `csv_process`、`enterprise_query` 和 `enterprise_command`。CSV 工具读取当前 Session 工作空间内的完整文件，返回有上限的预览与统计，并可保存全部处理结果。覆盖已有文件需要先读取，并通过 DSH 文件版本保护。写入提权使用常规 DSH 单次审批，获准后路径仍不得超出工作空间。

企业查询返回带版本号和继续偏移量的有界分页。AI 可以保存客户和订单草稿；库存写入、记录删除和订单提交需要明确的 DSH 审批。审批拒绝、取消或无人处理时不修改记录。版本冲突需要重新查询；相同的已提交命令编号返回原回执。界面与 AI 使用同一个本地数据库。

工具调用和返回数据经 DSH 写入 Session 日志及后续模型请求，数据库不会自动复制到提示词中。包内录制的[业务流程](tests/business-tool-flow.test.mjs)使用合成模型覆盖 CSV 到 CRM 的工具结果、持久化重放和 ERP 审批缺席。Schedule 负责提醒工具与后续消息。

ClawMaster profile 为新 Session 选择 DSH `read-only` 文件访问与 `ask` 审批。工作空间文件写入需要显式单次提权；`never` 审批会拒绝需要决定的请求，而不是自动同意。已保存的用户设置优先于 profile 默认值。委派 Session 在模型步骤与工具执行前，将创建时取得的文件访问范围与实时祖先权限取交集；祖先缺失或成环时仅允许读取，子代理审批保持 `never`。DSH 规范 setter 将收紧操作追加到 Session 日志。Agent Teams 默认最多三名成员、一级委派；既有服务负责名单校验，包括 Web 规划路由。

#### KV Cache 影响

`runtime_status` 返回带观测时间的桌面身份与源码来源；壳记录不属于当前 Host 时返回不可用。记录到日志的运行时上下文在请求组装时刷新这些事实，并将记忆中的版本、路径、端口和权限视作历史。前端 Host 行的 `runtimeGovernance` 可配置 `maxRssMiB`（默认取 2048 MiB 与物理内存四分之一中的较小值，下限 256 MiB）、`maxConcurrentHeavyTools`（2）和 `heavyToolPatterns`（Shell、子代理、团队、工作流与 CSV 工具名称）。DSH 单调守卫在 Host RSS 达到预算时拒绝新的匹配工具；执行分发拒绝超额重叠调用，并在成功、失败或取消后释放容量。状态读取仍可用。这些限制不约束外部进程内存、工具返回后的后台工作、Office WebView 或其他应用。

前端增加工具 schema、已记录的工具结果与带时间戳的运行时上下文，不添加独立模型提供方或系统提示词前缀。观测与结果变化影响请求后缀。DSH 负责请求组装与缓存处理。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

以下限制适用于本前端及其本地记录。

- 集成基线为 DSH `0.1.5-rc.2` 与 Cordis `4.0.2`。兼容范围限于本包使用的公开服务和实际测试过的插件组合，不代表所有 DSH 插件均已认证兼容。

- CRM 和 ERP 是本地单用户记录功能，不是多人共享的多租户企业系统，也不是外部 ERP/CRM 连接器。审计历史完整保留。浏览器和内部存储读取完整快照，模型查询对输出分页；尚未确立大数据库容量。数据处理器支持分隔文本，不支持 XLSX 工作簿或持久化电子表格服务。

- 本包不承诺独立安装器体积。Tauri 壳、DSH、Node 运行时与第三方组件分别具有各自的打包和许可要求；本包采用 Apache-2.0。

- OpenViking Memory 已安装，但桌面默认在连接前保持禁用。[本地服务指南](../../apps/desktop-tauri/README.zh.md#optional-local-openviking-service)负责 macOS 准备、USER 凭据和外置 AGPL-3.0 服务说明；集成插件采用 Apache-2.0。仅有服务健康不能验证桌面记忆捕获或跨 Session 检索。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>开发验证背景——点击展开</summary>

当前检出版本处于桌面集成开发阶段。源码测试和包构建属于开发证据，不能证明新安装桌面、所有模块交互、真实模型提醒或平台扫码登录已通过验收。桌面集成任务负责在发布前完成这些实际检查。

</details>
