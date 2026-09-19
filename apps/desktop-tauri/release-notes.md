# ClawMaster Desktop 0.2.2-fix

## 中文

- 使用 Tauri 桌面壳和 DSH 运行时，复用已有模型凭证、Session、工具、审批和插件。WatchDog 提供任务入口，创建任务时分配工作目录。
- 首次 WatchDog 教程介绍企业管理：明确业务目标、记录责任与验收标准、核查 CRM/ERP 和办公资料、安排巡检并跟进整改。模型和聊天配置作为可选辅助入口；教程可跳过或从设置重看，阅读教程不会启动任务。
- 添加工作区时使用应用内目录窗口，可浏览文件夹、输入路径或新建文件夹。WatchDog 创建任务时仍自动分配工作目录。
- 启动页、产品界面、通知、小组件静态文案和 Web 图标统一使用 ClawMaster，口号为“开启AI时代的企业协作”。保留 DeepSeek 模型提供商名称、DSH 软件包与数据路径以及上游许可声明。
- 品牌图标使用按原图轮廓复刻的可编辑 SVG，界面、启动页和 favicon 共用同一源文件，原生桌面图标由它生成。
- 编辑器和浏览器在右侧打开，终端在会话下方打开。会话内切换同一格的标签或访问全局面板时保留已打开内容；关闭标签、切换 Session 或退出前仍需保存。
- 基础 DOCX、XLSX 与 PPTX 可在侧栏使用本地 ONLYOFFICE 编辑器编辑、保存并重新打开；浏览器验收覆盖三种格式及编辑期间磁盘变化后的冲突保护，冲突时拒绝覆盖磁盘文件。复杂排版、宏、加密文件与旧版二进制格式未纳入验收；保留 ONLYOFFICE 许可声明及对应源码入口。
- CSV/TSV、CRM 和 ERP 提供 AI 工具；CRM 与 ERP 也可从组件设置打开右侧标签进行复核。AI 库存写入、删除与订单提交使用 DSH 单次审批。
- 内置 Agent Teams、OpenViking Memory、Routing Suite、Better Sidebar 与 IM 集成。OpenViking 需另行配置服务；Routing 的智能路由预设提供任务指导。飞书、微信、企微与钉钉接入需完成对应平台的登录确认。
- 主窗口使用系统原生控件。macOS 隐藏标题文字并为交通灯预留空间；通过 Dock 或 Finder 重开被关闭偏好隐藏的窗口时，恢复已有窗口与 Host。系统窗口外观和 Web 主题分别设置。
- 打包排除依赖与开发目录，即使复制根目录本身为 `node_modules`；交付校验拒绝排除目录、符号链接与安装内容摘要漂移。

发布工作流在 Windows x64、macOS Apple Silicon、macOS Intel、Linux x64 四项构建全部成功后，向 [ClawMaster-Desktop](https://github.com/NSIETeam/ClawMaster-Desktop/releases) 发布预发布版，包含 NSIS、DMG、AppImage/deb、Tauri 更新签名、公钥 `clawmaster-release-signing.pub`、`latest.json` 与 `SHA256SUMS.txt`。macOS 使用临时签名验证完整性，不包含 Apple 公证；Windows 没有发布者证书。默认包含发布验签公钥，自动更新端点为空，请通过版本附件安装。

macOS 最低要求为 11.0。Linux 的 Landlock 沙箱需要内核实际支持并启用该能力；功能探测确定完整、部分或不可用状态。首次启动需要联网准备运行环境与生产依赖。升级前保存编辑、结束运行任务并备份 DSH 主目录；保留该主目录以复用凭证与会话。

## English

- Uses a Tauri desktop shell and the DSH runtime, reusing existing model credentials, Sessions, tools, approvals, and plugins. WatchDog provides the task entry and allocates a working directory when a task is created.
- The first-run WatchDog tutorial guides enterprise management: define business goals, record responsibilities and acceptance criteria, review CRM/ERP records and files, schedule checks, and follow up on findings. Model and chat configuration are optional supporting links. Skip the tutorial or replay it from Settings; reading it starts no task.
- Adding a workspace uses an in-app directory dialog with folder browsing, path entry, and folder creation. WatchDog still allocates a working directory when creating a task.
- The splash, product UI, notifications, static widget copy, and Web icons use ClawMaster with the slogan “开启AI时代的企业协作”. DeepSeek model-provider names, DSH package and data paths, and upstream license notices remain intact.
- The brand mark is an editable SVG traced from the original artwork. The UI, splash and favicon share that source, which also generates the native desktop icons.
- The editor and browser open on the right; the terminal opens below the conversation. Open content remains mounted during global-panel visits and tab switches within the same pane. Save before closing tabs, changing Sessions, or quitting.
- Basic DOCX, XLSX, and PPTX files can be edited, saved, and reopened in local ONLYOFFICE sidebar editors. Browser acceptance covers all three formats and conflict protection when disk content changes during editing; a conflicting save preserves the file on disk. Complex layouts, macros, encrypted files, and legacy binary formats remain outside acceptance. ONLYOFFICE license notices and corresponding-source access remain available.
- CSV/TSV, CRM, and ERP expose AI tools; CRM and ERP also open right-side review tabs from component settings. AI inventory writes, deletions, and order submission use one-shot DSH approval.
- Includes Agent Teams, OpenViking Memory, Routing Suite, Better Sidebar, and IM integration. OpenViking requires a separate service; Routing's Smart preset provides task guidance. Feishu, Weixin, WeCom, and DingTalk setup requires each platform's login confirmation.
- The main window uses native system controls. macOS hides title text and reserves space for traffic lights; reopening a window hidden by the close preference from the Dock or Finder restores the existing window and Host. System window appearance and Web themes have separate settings.
- Packaging excludes dependency and development directories even when the copy root is `node_modules`; validation rejects excluded directories, symbolic links, and payload digest drift.

After all four Windows x64, macOS Apple Silicon, macOS Intel, and Linux x64 builds succeed, the release workflow publishes a prerelease to [ClawMaster-Desktop](https://github.com/NSIETeam/ClawMaster-Desktop/releases) with NSIS, DMG, AppImage/deb, Tauri updater signatures, the public key `clawmaster-release-signing.pub`, `latest.json`, and `SHA256SUMS.txt`. macOS uses ad-hoc signing for integrity without Apple notarization; Windows has no publisher certificate. The release public key is bundled and automatic-update endpoints are empty; install from the version's assets.

macOS requires version 11.0 or later. Linux Landlock confinement requires an enforcing kernel; its functional probe determines full, partial, or unusable enforcement. First launch requires network access to prepare the runtime and production dependencies. Before upgrading, save edits, finish running tasks, and back up the DSH home; retain that home to reuse credentials and Sessions.
