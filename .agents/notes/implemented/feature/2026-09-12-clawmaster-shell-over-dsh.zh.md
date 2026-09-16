# Agent Note: 基于 DSH 的 ClawMaster 桌面壳

Status: implemented

[English](2026-09-12-clawmaster-shell-over-dsh.md) | 中文

## 问题

ClawMaster 需要直接使用成熟的 DSH 运行时、会话、审批、工具与插件生态，避免维护第二套 Agent 后台。产品仍需使用 Tauri 桌面壳、ClawMaster 视觉身份，并通过二维码接入企业 IM。若原样交付上游桌面，启动页、窗口顶部、通知与 Web 界面会显示 DeepSeek Harness。

## 决策

准备后的完整性记录包含组件 manifest 与产出字节、依赖锁文件、本地补丁及其源码记录的明确清单。发布工作流在编译前将选定候选解析为完整提交，并通过 `DSH_DESKTOP_RELEASE_COMMIT` 校验。单独的组件版本不能识别本地补丁或被替换的产物；清单同时保留版本与字节摘要。

桌面溯源将编译产物绑定到编译前观察的源码，并在准备阶段拒绝源码或产物变化。仅在复制后记录摘要，无法证明现有 JavaScript 由哪份源码生成。因此发布模式要求干净的 Git 源文件集合、匹配的完整提交与树标识，以及完整 harness 构建和产品准备过程生成的阶段记录。开发产物保留脏文件路径和明确的开发构建编号。原生图标输出从源 SVG 重新生成并作为产物验证，因为平台编码可能独立于图案变化。资源包对独立溯源记录副本计算摘要，并为每个平台公开一份 manifest，不携带 Git 元数据。[桌面 README](../../../../apps/desktop-tauri/README.zh.md#release)负责记录字段与发布操作。

前端的 [ClawMaster SVG](../../../../frontends/dsh/src/clawmaster.svg)是客户端标识、启动页、favicon 与原生图标生成的矢量图案源。共用一个源文件可避免分别缩放或重画的标识产生偏差。原始 PNG 仅保留为参考，不参与运行时渲染。桌面资源检查要求 SVG 路径并拒绝内嵌或链接图片，防止 SVG 包装悄悄恢复位图缩放。打包保留 favicon 的精确源文件字节，分发的客户端 factory 渲染同一图案。

手动选择工作区时使用 DSH 的应用内目录浏览器。ClawMaster 组合包禁用自适应 `directory-picker` 行，同时挂载已有的目录浏览后端和客户端界面；Web 组合包提供这两个依赖。路径浏览、新建文件夹、取消和工作区接入均由 DSH 负责。这项部署选择仅在加载 ClawMaster 组合包时生效，官方 Web profile 保留自适应选择器。

ClawMaster 负责产品呈现与 Tauri 桌面壳。运行执行、Session、工具、审批和插件加载由 DSH 负责。`@clawmaster/dsh-frontend` 通过公开客户端插槽增加 ClawMaster 图标、WatchDog 导航与口号“开启AI时代的企业协作”。加载产品时不创建默认 Workspace：用户明确新建任务后，系统在 `$DSH_HOME/watchdog-workspaces/tasks` 下分配目录，再创建普通 DSH Session 并提交消息。工具入口沿用当前未归档的 Session，或按需分配共用 `desk` 目录。后续导航会阻止延迟完成的 Session 抢占选择或提交模型请求。bundle 启用官方 Schedule 与 time-context；DSH base 提供 Goal 与 goal-round-driver。`@xmanrui/dsh-im` 提供飞书、微信、企微与钉钉扫码接入。

默认 profile 挂载 `dsh-better-sidebar@0.19.1`，由维护者按 DSH 0.1.5-rc.2 验证。WatchDog 是产品唯一的左侧导航入口。编辑器与浏览器入口打开原生右侧面板，终端打开底部面板。CRM 与 ERP 通过公开的 `betterSidebar.registerTab` 注册 `clawmaster:crm` 和 `clawmaster:erp`，每个 Session 中各类型只有一个标签。已有侧栏设置负责启用开关与功能弹窗；产品弹窗明确打开原生右侧标签，失败时提示重试。注册既不打开标签，也不选择或创建 Workspace。CSV/TSV 处理是 AI 能力，没有独立客户端页面。

CRM 与 ERP 通过 DSH 已认证 Fetch 注册表访问 `$DSH_HOME/watchdog/enterprise.sqlite` 本机 SQLite 数据库。库存变化、不可修改的已提交订单、版本递增、命令回执及前后审计事实在同一事务中提交。版本冲突会保留未保存输入；结果不确定的客户端写入保留命令标识，供用户明确进行幂等重试。数据库版本单调递增，无法读取或不属于本产品的数据库会报错而不被替换。该系统面向单用户人民币库存与联系人管理，使用完整快照读取，不是多租户 ERP。旧浏览器记录不会被删除或自动迁移；数据库使新记录不依赖浏览器来源和桌面端口。

没有历史记录时，客户端首次进入只选择一次 WatchDog；已有选择优先。工具入口使用共享 React DOM 的提交操作，先挂载目标 Session 并绑定右侧面板挂载点，再打开标签；导航取消仍优先。

全局面板导航保留当前 Session 的右侧栏子树，每个停靠格也保留访问过的 tab 正文，使编辑器在同一格内切换 tab 时保留未保存正文、浏览器保留 iframe 文档。隐藏正文释放布局空间与焦点；隐藏面板关闭菜单，并发布 false 的 tab 可见性。当前服务绑定在返回会话界面前释放。这样保留已有编辑器的保存基线，无需另建草稿存储。固定 Better Sidebar 补丁通过公开更新 API 保留 URL、标题与导航历史，按 Session 和 tab 身份区分原生记录，在真实原生生命周期中止时释放记录。正文生命周期更短：将 tab 移到另一格或浮窗、切换 Session、关闭 tab 与退出前仍需保存编辑内容。

AI 经已有 DSH 工具流程使用 `csv_process`、`enterprise_query` 和 `enterprise_command`。PapaParse 负责 CSV/TSV 解析和序列化。CSV 工具通过沙箱文件系统读取完整工作空间文件，返回有上限的预览，并在观察版本保护下保存完整输出，默认防护公式执行。企业工具与认证路由共用数据库所有者和事务实现。模型查询对输出分页；AI 库存写入、删除与订单提交需要 DSH 单次审批。审批缺席时不修改记录，过期审批不能跳过版本检查。卸载先撤销两个调用方并等待进行中操作结束，再关闭数据库。DSH 记录工具调用和结果，可从 Session JSONL 重建。CRM 与 ERP 右侧组件用于复核与人工接手。

Tauri 安装内容将已构建前端及精确版本插件依赖加入 CLI 解析范围。Node 预加载脚本在受支持的 `dsh web` 入口前初始化普通 Web profile，并追加缺失的产品 bundle；用户依赖版本与补丁策略保持不变。因此全新安装不依赖开发者预先配置的 profile。复制时排除依赖与开发目录，即使复制根目录为 `node_modules`。`assertPreparedBundle` 拒绝被排除目录、符号链接及与准备 manifest 不一致的摘要；默认项和前端产物参与该摘要。profile 中明确安装的软件包优先于安装包内的补丁副本。[桌面 README](../../../../apps/desktop-tauri/README.zh.md#im-workspaces-and-bundled-packages)负责受支持的移除、备份与已安装产物验证流程。

运行时世代也可能包含已登记 Workspace 的文件，位于应用数据目录不代表它们是可丢弃缓存。清理读取选定 DSH 主目录中当前版本 2 的工作区存储，保留与已登记路径相等、包含工作区或被工作区包含的运行目录，包括解析后的别名。登记缺失允许全新安装；已有登记不可读、版本不支持或无效时停止删除，日志不记录存储值。依赖失效处理与源码重铺在修改内容或运行时 manifest 前拒绝受保护或归属不明的目录。无条件保留最新三个世代只是存储策略，不授予移除 Workspace 数据的权限。隔离 Rust 文件系统测试覆盖路径重叠、缺失子目录、别名、损坏登记、manifest 保留和普通无引用目录清理。

预加载创建 `$DSH_HOME/watchdog-workspaces/im`，不创建默认 Workspace。桌面策略分别把这个持久目录提供给微信、飞书、钉钉与企微；运行时安装目录不适合作为机器人的持久工作区。IM 只在会话需要时登记 Workspace。已有机器人保留保存的路径，通过上游工作区选择器更改；该操作清除聊天绑定而不删除旧 Session。用户补丁最后应用，对 IM 配置执行浅覆盖，因此预加载不会修复或合并覆盖用户明确的选择。

精确版本的 IM 与 Better Sidebar 补丁负责静态产品文案。IM 包含客户端与 Host 词典、连接状态、审批与提问消息、错误、接入显示名称和 Slack 应用模板。侧栏包含受支持语言词典及 Electron 兼容性标签；Agent Teams、OpenViking 与 Routing Suite 使用产品化的软件包简介。IM Host 产物只修改与源码匹配的字符串，其余可执行 token 字节不变。包身份、DeepSeek 模型提供商名称、许可证、权限、协议字段与凭证路径保持不变。用户名称、模型输出和其他动态文字不进行整页替换。完整性记录与生产锁把每个补丁绑定到已安装字节；聚焦测试覆盖客户端呈现文案、Host 消息、仅元数据修改及可执行 token 不变。

产品拥有的原生字符串与资源在应用元数据、启动页、托盘、通知、关闭对话框、Windows 快捷方式及安装器图标中使用 ClawMaster。[原生窗口决策](2026-09-13-clawmaster-native-window-titlebar.zh.md)负责窗口装饰、macOS 覆盖式顶栏预留空间、分别设置的系统与 Web 主题，以及重开隐藏窗口而不启动另一个 Host 的行为。内部 `dsh` 命令、包名、profile 数据与旧应用数据路径保留兼容义务。

桌面包含发布验签公钥，自动更新端点为空。启动与托盘操作在创建 updater 或发送请求前检查端点；即使已有公钥，空端点列表仍禁用自动更新。已配置的端点必须配有匹配公钥。公开 ClawMaster-Desktop 仓库只在每项配置的平台构建成功后发布版本化预发布版，附带更新签名、公钥、manifest 与校验和。Tauri 签名验证更新产物；macOS 临时签名不提供 Apple 公证或开发者身份，Windows 没有发布者证书。[桌面 README](../../../../apps/desktop-tauri/README.zh.md#release)负责发布操作与启用方式。

DSH 提供品牌图标插槽，但没有对话首页标题插槽。因此 ClawMaster 图标把 `MutationObserver` 限定在 `[data-phase="hero"]`，只替换完全匹配的上游中英文标题。这样无需修改 DSH 源码，但上游文字或结构变化后必须进行可见界面回归。

桌面构建为 Web 外壳和动态插件统一选择 `DSH_CLIENT_TITLE=ClawMaster` 与 `clawmaster` 客户端 profile。无框架启动页捕获初始文档标题，使插件激活前与失败报告中即可呈现产品品牌。仅构建产物的资源处理为 PWA manifest 和 favicon 写入已有 ClawMaster 身份，再记录客户端摘要；上游 Web 资源源码保留默认项。打包检查该摘要、profile、标题、manifest 名称和精确图标字节。浏览器稍后运行的 MutationObserver 无法修复首帧品牌错误。启动快照与 hydration 回归覆盖初始品牌，打包测试拒绝上游资源和后续变更。[WatchDog 教程决策](2026-09-13-watchdog-first-run-tutorial.zh.md)负责单一产品引导、持久确认与模型设置保留。

[本地 Office 决策](2026-09-13-clawmaster-local-office-editing.zh.md)负责本地转换、受版本保护的二进制保存及 Office 分发义务。

## 考虑过的替代方案

**保留原 ClawMaster 运行时。** 这能保留完整控制权，却会重复开发 DSH 已有的会话、工具、审批与插件能力，不符合减少维护的目标。

**原样交付 DSH 桌面。** 代码最少，但应用会在启动和正常使用期间显示 DeepSeek Harness 身份。

**分叉 DSH Web 客户端。** 这样能直接替换所有文字，却会产生第二套 Web 界面，使上游升级变成持续合并工作。

**另建持久层恢复编辑器草稿。** 全局面板访问和同一格内切换 tab 期间保留已有组件，会同时保留草稿和保存基线。独立草稿存储还需检测编辑器离开期间的磁盘修改，否则可能静默替换当前保存基线。

## 影响

桌面在已有 IM 和侧栏插件之外固定安装 Agent Teams、OpenViking Memory 与 Routing Suite。部署补丁将 Routing 与 OpenViking 的历史读取接到公开 Session Projection；原包对 `session.events` 的读取无法重建当前 Session。Routing 在组装前包含首条已领取的用户消息，并把指导写入普通系统消息。OpenViking 添加记忆时保留请求系列标记。固定补丁和生产依赖解析均为安装输入；桌面把 DSH peer 绑定到本安装的 workspace 包，避免加载第二套预发行核心。

OpenViking 由桌面策略组合包保持可见但禁用，直到独立记忆服务配置完成。用户补丁在该策略之后应用，可以启用插件。仅安装包不会创建 embedding 服务或使记忆检索可用。Agent Teams 复用其磁盘状态与公开工具；空白待审批团队的上游 deliverable 标记不代表工作完成。Routing 在所选预设中增加任务指导，不进行多模型分发。[桌面 README](../../../../apps/desktop-tauri/README.zh.md)负责版本、启用方式与服务要求。

macOS 本地服务助手准备私有的外置 OpenViking 部署，固定本地 512 维 embedding 模型，并写入不含凭据的 launchd 任务草稿。明确加载 launchd 后，由其管理启用 API Key 认证的独立回环守护进程。每次启动时，runner 把已有 DSH DeepSeek 凭据读入服务环境；凭据配置创建专用 USER 客户端凭据，不把 root 密钥交给插件。准备、运行、诊断和凭据配置均不修改 DSH profile。外置服务采用 AGPL-3.0，集成插件采用 Apache-2.0，两者许可证保持独立。服务准备和已认证健康，与 DSH 捕获、检索及打包桌面验收分别成立。

ClawMaster 不代理插件协议，因此兼容性跟随实际 profile。仅凭 peer 范围不能证明兼容或不兼容。已审计的 `dsh-stall-guard@1.3.0` 使用过时状态与用户消息 API。运行时复现还确认 `dsh-scheduled@0.1.4` 的 runner 读取已移除的 `session.events`，`dsh-cron@0.8.0-alpha.4` 的目标提取遗漏当前 `session.header.cwd`；其 automation 依赖的恢复路径还保留已移除的 `persistence.inspect` 调用。这些包不作为默认项。官方 Schedule 在应用与根 Session 保持活动时提供持久固定间隔提醒，不提供后台守护进程或会话外通知。频率选择器把用户请求记录并提交至普通模型/工具流程，不会在工具成功前声称提醒已创建。

企业 IM 凭据保留在插件与 DSH 主目录。每个平台只有在二维码正确渲染且操作员完成扫码后才算真实连接。聚焦测试覆盖真实 CSV 解析/导出、SQLite 并发与回滚、结果不确定的 HTTP 写入、导航取消及编译后的产品插槽。启动 smoke 使用隔离 DSH 主目录和真实认证通道；桌面验收还须检查打包后的 Tauri 应用、首帧及编辑器/浏览器/业务操作。
