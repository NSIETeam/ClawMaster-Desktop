# ClawMaster Desktop (Tauri)

[English](README.md) | 中文

这是 ClawMaster 基于现有 `dsh web` 运行时的 Rust/WebView 外壳。安装包携带 **Harness 源码**，不包含 `node_modules`；首次运行扫描本机兼容的 Node.js、pnpm 和已有的 `~/.dsh` 主目录，下载缺失的 Node.js 或 pnpm，再对安装包内的源码树安装生产依赖。应用元数据、启动页、通知和 Web 界面使用 ClawMaster 名称、图标与口号“开启AI时代的企业协作”。

桌面包版本：**0.2.2**。`build:harness` 选择 ClawMaster 客户端 profile，在插件加载前设置浏览器标题，并把已有产品图标写入构建后的 favicon 与 PWA manifest。构建记录最终客户端摘要；打包拒绝标题、profile、manifest 名称、图标或摘要不符的产物。上游 Web 资源源码保留默认品牌。

Tauri 包名为 `@deepseek-ai/dsh-desktop-tauri`，与上游 Electron 应用独立。Host 启动地址只在内存中传给独立 WebView，由上游认证流程签发登录 cookie。应用命令归本地外壳所有；回环 Host 内容仅获得窗口拖动与双击最大化权限。启动日志不记录认证令牌。裁剪包包含 `native/system`，并仅在裁剪树中允许开发工具补丁未使用；实际补丁应用失败仍会阻止安装。

<a id="architecture"></a>
## 架构

| 层 | 安装包内容 | 首次运行 |
|---|---|---|
| **安装包** | Tauri 二进制、启动页、裁剪后的 monorepo 子集（`bundled/harness/`） | — |
| **构建环境** | — | 复用本机 Node 22.19+ 或 24+ 和 pnpm；没有时再从 npmmirror 下载 Node，并通过 npm 安装 pnpm |
| **依赖** | — | 在平台应用数据目录执行 `pnpm install --prod --no-frozen-lockfile`（裁剪包与 lockfile 不完全相同；移除 `CI`，避免 pnpm 强制冻结安装） |
| **Host** | — | `node apps/cli/lib/bin.js web --host 127.0.0.1`；启动时加载失败的插件会被禁用，然后重试 Host |
| **UI** | 原生窗口装饰与本地 `shell.html` 关闭对话框 | 子 WebView 嵌入 `dsh web`；macOS 将原生交通灯控件保留在 WebView 上方独立的标题栏区域，并隐藏标题文字。系统负责窗口外观，Web 设置负责嵌入客户端主题 |
| **托盘** | 原生托盘图标 | 第一次关闭询问最小化到托盘还是退出，并写入 `desktop-settings.json`；托盘可改该偏好、显示窗口、安装 Sakana 插件库（在当前 Host 主目录执行 `dsh plugin --profile web add github:Sakana-yuyu/dsh-plugins`）、检查更新、重启或退出。重启和退出都会停止 Host 的 Node 进程树；重启随后重新拉起桌面进程。插件库安装成功后走同一条重启路径，以便加载该库。最小化到托盘则保持 Host 运行 |
| **通知** | Overlay 插件 + 本机 POST | `turn/end` 且 `completed` 时，窗口不在前台则弹出系统通知并播放 `sounds/complete.wav` |
| **更新** | 更新服务器上的签名正式通道，保留 GitHub 备用地址 | 窗口打开后开始后台检查，应用运行期间定期检查；每次启动对同一可用版本仅提示一次。从托盘检查更新后，先确认下载并校验签名，再单独确认安装与重启。取消时当前应用继续运行 |
| **Agent 环境（Windows）** | Windows（默认）或 WSL | 托盘写入 `desktop-settings.json`；WSL 在默认 WSL2 发行版内启动 Linux `dsh web`；需重启后生效 |

Windows 桌面只交付一个安装包、一个桌面二进制和同一个 Web 客户端（WebView 中的 `dsh web`）；这不是第二个 SKU，也不是第二套 Web UI。托盘中的 Agent 环境开关只改变 Host 进程的运行位置：Windows Node + pwsh，或默认 WSL2 发行版内的 Linux Node + bash。切换是运维操作，不是第二套代码：需要重启；Windows 使用隔离的桌面主目录，WSL 使用发行版内的 `~/.dsh`；会话不共享；当 Linux 主目录同时缺少凭据与 `.env` 时，会从 Windows 主目录各复制一次。再做一个安装包或分叉 Web 客户端会重复更新器、overlay、主目录和 CI，因此不单独交付。WSL 模式下工作区浏览使用 Linux 路径（例如 Windows 盘符对应 `/mnt/d/...`）；不修改 `packages/`；若 Docker Desktop 是默认发行版，需用 `wsl --set-default` 设为可用的 WSL2 发行版。

安装包内的源码树包括已构建的 `apps/cli/lib` 与 `apps/web/dist`、除 examples 与 test-support 外的 `packages/*/*`、`native/system`、`vendor/*`、补丁与生产 lockfile。复制时排除依赖和开发目录，即使复制根目录本身就是 `node_modules`；workspace 的 `devDependencies` 也会移除，不改写不可变 Office 运行资源及其对应源码。`assertPreparedBundle` 在交付前拒绝被排除目录、符号链接及与准备 manifest 不一致的安装内容摘要。

安装包包含已构建的 `frontends/dsh` 及下表中的精确版本插件。原生与 WSL 启动在 `dsh web` 前预加载 [desktop-defaults.mjs](scripts/desktop-defaults.mjs)，校验产物并追加缺失的 Web profile 组合包，保留现有依赖和用户补丁。原生启动要求预加载模块使用绝对路径，将其转换为 `file:` URL；转换失败时在启动 Node 前报告错误；[预加载决策](../../.agents/notes/implemented/bug-fix/2026-09-13-desktop-node-preload-file-url.zh.md)说明 Windows 与文件名编码要求。源码 checkout 的 `dev:local` 跳过此安装专属预加载。插件安装内容复用当前 DSH workspace 依赖，避免预发行 peer 范围自动安装另一版核心。

| 插件 | 桌面默认行为 |
| --- | --- |
| `@xmanrui/dsh-im@4.20.0` | 平台登录与 IM 设置，固定使用 ClawMaster 客户端与 Host 文案；连接需完成实际账号登录。 |
| `dsh-better-sidebar@0.19.1` | 文档、网页与终端面板，附带固定的原生 tab 兼容补丁及本地化 ClawMaster 文案。 |
| `@nanmicoder/dsh-agent-teams@0.1.17` | 团队工具与面板；成员使用 DSH 模型配置。 |
| `dsh-routing-suite@0.1.2` | 安装“智能路由”预设，选择该预设时加入任务执行指导，不切换模型。 |
| `@openviking/dsh-memory-plugin@0.3.0` | 已安装，记忆运行插件默认禁用；配置独立 OpenViking 服务后启用。 |

WatchDog 是产品的左侧导航入口，工具入口打开编辑器、浏览器和终端。CSV/TSV 处理内置于 AI 工具，没有独立数据处理页面。CRM 与 ERP 是用于复核记录和人工修改的可选右侧组件：在“设置 → 侧边卡片 → 侧边栏内容”中启用组件，进入“功能设置”，选择“在右侧打开”。注册时不打开标签，也不创建 Workspace。用户明确打开时，沿用当前未归档的 Session，或在共用 WatchDog Desk 工作区中按需创建 Session；原生标签可关闭、重开。[前端 README](../../frontends/dsh/README.zh.md)负责 AI 工具与业务数据行为说明。

路由预设只补齐 `$DSH_HOME/.agent-presets/routing-suite` 下缺失的文件，保留用户修改。固定的 [Routing](patches/dsh-routing-suite@0.1.2.patch) 和 [OpenViking](patches/@openviking__dsh-memory-plugin@0.3.0.patch) 兼容补丁使用当前 DSH Session Projection 重建历史状态；OpenViking 还保留请求系列标记。补丁作为安装输入参与摘要计算，应用失败即停止安装。

固定的 [IM 补丁](patches/@xmanrui__dsh-im@4.20.0.patch)在客户端与 Host 的产品文案、连接状态、审批、提问、错误、接入显示名称及 Slack 应用模板中使用 ClawMaster；IM 顶部使用产品口号。Better Sidebar 在受支持词典中本地化产品文案；Agent Teams、OpenViking 与 Routing Suite 使用产品化的软件包简介。IM Host 产物只修改与源码匹配的静态字符串。[IM 完整性记录](patches/dsh-im@4.20.0.provenance.json)与[侧栏完整性记录](patches/dsh-better-sidebar@0.19.1.provenance.json)把源码、产物与补丁绑定。包标识、DeepSeek 模型提供商名称、协议字段、凭证路径、许可证及用户或模型文字保持不变，不运行整页文字替换。

固定的 [Better Sidebar 补丁](patches/dsh-better-sidebar@0.19.1.patch) 通过公开 tab 更新 API 保留浏览器 URL、标题与前进/后退历史。原生记录同时使用 Session 和 tab 身份，临时卸载期间保留，原生 tab 生命周期信号中止时释放。[右侧栏](../../packages/client/ui-sidebar-right/README.zh.md#the-expand-button)在访问全局面板期间保留当前 Session 的停靠和浮动内容挂载，使隐藏的编辑器正文与 iframe 文档继续存在。编辑器适配层在关闭、刷新或替换未保存编辑器前询问，取消时保留草稿。Office 文件使用内嵌编辑器的保存操作。切换 Session、移除分栏或退出前请先保存；保留的浏览导航不等于已保存编辑内容。

[Office 组件](../../frontends/office/README.zh.md)通过已有侧栏提供本地 ONLYOFFICE 查看器，用于基础 DOCX、XLSX 与 PPTX 编辑和保存。保存冲突时保留已变化的磁盘内容。复杂排版、宏、加密文件与旧格式未纳入验收。查看器保留许可声明与对应源码入口；其 README 负责文件限制、运行资源准备与许可说明。

<a id="im-workspaces-and-bundled-packages"></a>
### IM 工作区与内置软件包

桌面准备阶段创建持久目录 `$DSH_HOME/watchdog-workspaces/im`，不注册默认 DSH Workspace。[桌面策略](defaults/cordis.patch.yml)通过 `xmanrui-dsh-im` 的 `config.weixin.workspace`、`config.feishu.workspace`、`config.dingtalk.workspace` 和 `config.wecom.workspace` 提供该目录。插件在会话需要时登记 Workspace。已有机器人保留各自保存的工作区；请通过“设置 → IM机器人 → 机器人工作区”选择器更改。选择器清除该机器人的聊天绑定，保留旧 Session 和文件；后续消息使用所选工作区。这个固定目录不会为每条消息分配独立任务目录。

用户补丁最后应用。DSH 对 IM 条目的 `config` 执行浅覆盖，不深合并各渠道对象，因此用户提供的 `config` 必须包含部署所需的全部渠道默认项。准备过程保留这份用户配置和目录中已有的内容。

profile 中明确安装的 IM 软件包优先于内置补丁包，即使两者都显示版本 `4.20.0`。发行操作者在已安装桌面上执行以下切换验收：

1. 正常退出 ClawMaster，私密备份选定主目录中的 `$DSH_HOME/profiles/web`、`$DSH_HOME/integrations/dsh-weixin`、`$DSH_HOME/.credentials.yaml` 和 `$DSH_HOME/storages/workspace.json`；同时保留 `integrations` 下其他已连接渠道的目录。
2. 使用桌面的 `dsh` 命令和相同的 `DSH_HOME`，执行下面受支持的移除命令。它移除 profile 依赖和 bundle 注册，不移除 IM 账号或 Session 数据。
3. 启动打包桌面，预加载恢复由安装管理的 IM bundle。确认 profile 解析到本次安装运行时中的补丁客户端与 Host，且两者 SHA-256 分别与内置 IM 完整性记录的 `patchedSha256["lib/client.js"]` 和 `patchedSha256["lib/index.js"]` 一致；仅版本一致不够。
4. 在 IM 设置中检查已有机器人的连接与工作区。需要回退时，先退出应用，再恢复私密备份的 profile 与集成配置。

```sh
dsh plugin --profile web remove @xmanrui/dsh-im --config.ignore-scripts=true
```

<a id="optional-local-openviking-service"></a>
### 可选的本地 OpenViking 服务

OpenViking 默认由安装层 `@clawmaster/dsh-desktop-policy` 禁用 `openviking-memory-runtime`，插件清单仍显示该条目。记忆功能需要单独配置的 [OpenViking 服务](https://docs.openviking.ai/en/agent-integrations/17-dsh)。macOS [本地部署助手](scripts/openviking-local.py)默认在应用外的 `~/Library/Application Support/ClawMaster/OpenViking` 准备服务，不修改 DSH profile 或 `~/.openviking`。

| 助手命令 | 操作 |
| --- | --- |
| `prepare` | 创建私有部署目录，安装固定版本的 Python 软件包和 embedding 模型，并写入 launchd 任务草稿但不加载。已有受管文件必须一致；内容不同的文件会保留并报错。 |
| `serve` | 在前台运行启用认证的服务。launchd 任务使用此命令，明确加载后管理独立守护进程。 |
| `doctor` | 使用受管配置运行 OpenViking 诊断，并在输出中隐藏凭据值。 |
| `provision` | 通过认证 API 创建专用 `clawmaster` 账号和 `watchdog` USER 凭据，再写入 `config/ovcli.conf`；已有客户端密钥会经过检查并保留。 |

助手固定 OpenViking `0.4.19` 与 `llama-cpp-python` `0.3.35`，校验 embedding 模型 SHA-256，并使用本地 512 维 `bge-small-zh-v1.5-f16` embedding。存储和 embedding 在本机运行；文本总结使用配置的 DeepSeek 模型，默认为 `deepseek-flash`。每次启动时，runner 从选定的 DSH 凭据文件（默认为 `~/.dsh/.credentials.yaml`）读取 `refs.DEEPSEEK_API_KEY`，注入服务进程环境。服务配置只保存环境变量引用，launchd 任务不含凭据值。服务默认绑定 `127.0.0.1:1933`，启用 API Key 认证，并持有独立的私有 root 凭据。

OpenViking 服务使用 AGPL-3.0，DSH 记忆插件使用 Apache-2.0。助手把服务安装在 Tauri 安装内容之外的独立本地环境中；集成插件的许可证不会替代服务本身的许可证。

完成凭据配置后，让 DSH Host 的 `OPENVIKING_CLI_CONFIG_FILE` 指向私有部署目录下的 `config/ovcli.conf`，再在 `$DSH_HOME/profiles/web/cordis.patch.yml` 合并以下配置并重启。插件使用 USER 凭据，不使用服务 root 凭据。准备好文件或观察到已认证服务健康，不代表桌面记忆捕获和检索已经连通；还需要启用客户端连接并完成跨 Session 流程。

```yaml
- id: openviking-memory-runtime
  disabled: false
  config:
    endpoint: http://127.0.0.1:1933
```

启用后，上游默认同步用户与助手消息，工具结果默认不捕获；不可达的请求进入本地待重放队列。`syncTurns: false` 只停止新消息捕获，已有队列重放和会话提交仍可能执行；完全停用使用插件的 `disabled: true`。用户 profile 补丁在桌面策略之后应用，已有明确启用选择保持有效。

### 镜像（可通过环境变量覆盖）

| 变量 | 默认值 |
|---|---|
| `DSH_NODE_MIRROR` | `https://npmmirror.com/mirrors/node` |
| `DSH_NPM_REGISTRY` | `https://registry.npmmirror.com` |

### 开发与生产模式

| 模式 | 环境变量 | 行为 |
|---|---|---|
| **本地开发** | `DSH_DESKTOP_LAUNCH=local` | 使用 monorepo checkout 和 `PATH` 中的 `node`/`pnpm`，跳过镜像下载 |
| **生产** | （默认） | 从安装包复制 `harness-source` 到应用数据目录，通过镜像安装，再启动应用 |

可写目录位于 `dirs::data_dir()` 解析的平台数据目录下的 `DeepSeek Harness` 子目录：Windows 使用 `%APPDATA%\DeepSeek Harness`，macOS 使用 `~/Library/Application Support/DeepSeek Harness`；Linux 同样在其平台数据目录下追加 `DeepSeek Harness`。

- `harness-versions/<bundle-hash>/` — 按源码包隔离的源码，以及首次 `pnpm install` 后的 `node_modules`
- `runtime/` — Node、pnpm-global 和 manifest
- `dsh-home/` — 未发现已有 Harness 主目录时的回退会话数据
- `bin/` — 写入 Host PATH 的可 spawn `dsh.exe` / `dsh.cmd` / `pnpm.cmd`；用户 Path 缺失时也会加入
- `cache/` — 下载的 Node zip 或 tarball

首次启动会先扫描进程 `PATH`（Windows 上再加上用户/系统里的持久 Path）和常见安装位置，查找满足 `^22.19 || >=24` 的 Node 和可用的 pnpm，再决定是否从镜像下载。若 `$DSH_HOME`（进程环境，或 Windows 上的用户/系统环境）或 `~/.dsh` 已包含会话、凭据、`.env`、profile 或 settings，则采用该主目录，并把隔离 `dsh-home/` 中缺失的文件复制进去。随后写入可被 spawn 的 `dsh` / `pnpm` shim（`dsh.exe` 是以 CLI 跳板运行的桌面二进制），并把已选定的 Node / pnpm 目录（以及发现 PATH 上缺少 `git` 或 `bash` 时的 Git `cmd`/`bin`）前置到 Host PATH，使应用内的 `spawn('dsh')`、`dsh plugin`、MCP 的 `npx` 以及 agent 的 `bash`/`git` 查找能够解析。Windows 不写入无扩展名的 `dsh` 文件。父进程没有可见控制台时，Windows 上的 Host 与 CLI 子进程不会再弹出控制台窗口。用户 Path 通过注册表加入 shim 目录；仅当对应命令仍不是可 spawn 文件时，才加入 Node 或 pnpm 目录。扫描失败时，预配器仍会为 Windows x64/x86、macOS x64/arm64 和 Linux x64/arm64 下载 Node。zip 与 tar.gz 解压会拒绝预期 Node 根目录以外的条目。Unix 压缩包保留可执行权限。私有安装的 pnpm 由已选定的 Node 二进制执行；扫描到主机 pnpm 时则直接调用。按源码包隔离的 Harness 目录允许更新版本预配新源码，而不删除旧 Host 正在使用的文件；兼容的 Node 和 pnpm 会在源码更新之间复用。安装包内的 workspace 文件派生自仓库的 `pnpm-workspace.yaml`，裁剪包成员，并允许未使用的开发工具补丁。预配失败时，应用回退到依赖已安装完成的最新一棵 harness 树；安装与下载步骤均有期限，清理保留最新三棵 harness 树及已登记 Workspace 目录。原生外壳只允许一个应用实例，重复启动时聚焦已有窗口。在 macOS 上，通过 Dock 或 Finder 重新打开应用，会显示并聚焦被关闭偏好隐藏的已有窗口，不启动另一个 Host。已配置更新通道的 Release 构建会在主窗口打开后再检查更新；更新网络或 manifest 失败只写入日志，不拖住启动页。运行时 manifest 已就绪时跳过主机工具链扫描，并用文件大小比对 Node，不再对 `node.exe` 做 SHA256。原生窗口行为、托盘、更新、系统通知和完成音都留在这个 Rust crate。与 Host 的协作是复制到 `$DSH_HOME/desktop-overlay` 的 overlay 插件，通过 `dsh web --patch` 加载，不修改 `packages/`。

清理读取选定 DSH 主目录中的 `storages/workspace.json`。运行目录与已登记 Workspace 路径相等、包含工作区或位于工作区内时保留；解析后的文件系统别名获得相同保护。登记文件不存在时允许新用户安装；已有文件无法读取、版本不支持或路径无效时停止自动清理，诊断不包含存储值。依赖修复和源码重铺也拒绝替换受保护或归属不明的目录，保留文件及运行时 manifest，交由人工恢复。

<a id="build"></a>
## 构建

[原生 RPA 准备程序](scripts/prepare-rpa-native.mjs)为当前平台或显式 `--target` 编译锁定的 Rust 源码，把可执行文件放入 `frontends/rpa/dist/native/<platform>-<arch>/`。打包拒绝缺失 helper、错误的可执行文件头、架构不符、过期组件版本和 SHA-256 摘要变化。发布矩阵的每个目标都对分发的 helper 执行 `--native-tool capabilities`，不读取桌面内容；生产 Host 检查确认 `wechat_read` 与更新工具已注册。[RPA 组件](../../frontends/rpa/README.zh.md)负责审批与平台支持说明。

macOS 最低要求为 11.0，与预配的 Node.js 22.19 运行时和原生 addon 目标一致。Linux 发行构建安装 `musl-tools`，并完整构建 `native/system` 原生资源，包含静态 Landlock 启动器和两种 libc addon；根目录仅构建 addon 的源码测试命令不足以交付这些资源。Landlock 还需要内核实际执行限制；可用性由功能探测确定，不能只看内核版本。参见[原生支持矩阵](../../native/system/docs/support-matrix.md)。

在仓库根目录执行（需要已构建的 CLI 与 Web dist）。发行负责人通过 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 提供发行签名材料：

```powershell
pnpm --dir apps/desktop-tauri run build:harness
node apps/desktop-tauri/scripts/prepare-rpa-native.mjs --smoke
cd apps/desktop-tauri
pnpm install
pnpm run build:win
```

安装包输出：`src-tauri/target/release/bundle/nsis/ClawMaster_0.2.2_x64-setup.exe`

NSIS 安装包包含**英语**、**简体中文**和**繁体中文**。安装语言自动跟随操作系统 locale，不显示语言选择器；不支持的 locale 使用英语。原生启动页、托盘、关闭对话框和启动状态文案遵循同一规则（`zh*` 用中文，其余用英语）。嵌入的 `dsh web` 客户端仍使用自己的 Settings 语言。复制文件前，安装器会静默关闭 `dsh-desktop.exe` 及其子进程树。安装后，安装器使用独立的版本化 ICO 资源重建已有桌面快捷方式，并通知 Explorer 清除陈旧的图标缓存记录。

<a id="release"></a>
## 发布

推送 `desktop-v*` 标签会运行[桌面发布工作流](../../.github/workflows/desktop-release.yml)。它构建 Windows x64 NSIS 安装包、macOS Apple Silicon DMG 和 Linux x64 AppImage/deb，在所有矩阵任务成功后发布。程序版本 `0.2.2` 对应正式版 `desktop-v0.2.2`；预发行程序版本不进入 GitHub Latest。已有正式版本禁止覆盖。手动触发默认为仅构建：构建所选分支提交并上传签名安装包，不发布版本或改变更新通道。只有在重建已有发布标签并需要发布时，才启用 `publish`。每个更新产物携带 Tauri 签名；版本附件包含 `latest.json`、`clawmaster-release-signing.pub` 与 `SHA256SUMS.txt`。manifest 将 DEB 安装映射到单独签名的 DEB，并为通用 Linux 目标保留 AppImage。[发布通道决策](../../.agents/notes/implemented/architecture/2026-09-13-desktop-stable-confirmed-updates.zh.md)负责版本与更新确认规则。

Windows 构建步骤使用原生 PowerShell。每个 PowerShell 发布步骤要求 7.4 或更高版本，并在原生命令失败时立即停止；后续成功命令不能覆盖该失败。仅供 macOS/Linux 使用的 Bash 步骤保留 shell 失败处理。[发布命令决策](../../.agents/notes/implemented/process/2026-09-15-desktop-release-native-command-failures.zh.md)负责其理由与反向控制要求。

应用包含发布验签公钥，优先使用[更新服务器](https://8.140.52.117/updates/clawmaster/v2/latest.json)的 HTTPS manifest，并以公开仓库 Latest manifest 为备用地址。[服务器更新参考](server-updates/README.zh.md)负责同步、发布与恢复行为。仅接受更高的正式版本，拒绝预发行版本和降级。Release 构建在主窗口打开后检查，此后在每次后台检查成功的六小时后再次检查。检查失败时，先等待 15 分钟重试，再将等待时间逐次加倍，最长六小时；成功后重置等待时间。若已有其他更新操作，后台检查等待一分钟，不发出请求。每次应用启动对同一可用版本最多提示一次；发现另一个更高版本时可再次提示。Debug 构建和空端点均不发出更新请求；非空端点必须配置公钥。

后台检查仅提示更新。从托盘更新须分别确认下载与安装，第二次确认出现在签名验证成功后。取消确认或下载失败时，当前应用继续运行。退出和重启会取消并等待后台检查任务结束，再停止所属 Host 进程树。安装会重启桌面；确认安装前请保存编辑并结束任务。

此通道分发桌面版本及其内置运行时，不单独更新或热重载 DSH 插件。profile 插件管理仍由 [DSH profile](../../packages/boot/app-boot/README.zh.md)负责；开发期间的客户端重载需要[客户端 HMR（热模块替换）watcher](../../packages/client/hmr/README.zh.md)。

内置的[更新组件](../../frontends/updates/README.zh.md)提供 `/updates`、`clawmaster_updates` 和受审批控制的 `clawmaster_update` 工具。默认每分钟检查签名服务器元数据；下载和 profile 改动须获一次性批准。打包时仅向更新器的副本补充桌面专用的 `dsh.bundle.patch` 元数据与[桌面补丁](updates/cordis.patch.yml)，其公开模块和原始包保持不变。profile 声明 `@clawmaster/dsh-updates`，因此既有便携更新包会拒绝重复首次安装。桌面补丁与该更新包使用相同的条目 id。既有 profile、主目录补丁或其他 bundle 已插入该更新器时，启动会省略桌面 overlay 并保留用户补丁。运行时激活与原生安装仍受该组件文档中的限制；仅暂存且要求重启的组件不会在桌面重启后自动应用。

GitHub 仍是构建与发布来源；更新服务器镜像已验证的更新文件，不重新构建或签名。已安装的 `0.2.1` 程序在后续原生更新前仍保留编译时的 GitHub 端点；更改服务器或 DSH profile 不会改变该端点。

桌面 0.2.2 内置更新器 0.1.2，包含 Windows 缓存冲突处理、原始归档路径校验及四目标 v2 原生通道支持。旧端点保留五目标清单，供旧版严格解析器使用。用户已经挂载的更新器保留自己的版本和配置；原生桌面升级不会静默替换该组件。已有独立更新器须单独升级组件后才能使用 v2 通道。已发布的 0.1.0 组件与便携更新包保持不可变。

Release 资产归公开的 [ClawMaster-Desktop 仓库](https://github.com/NSIETeam/ClawMaster-Desktop/releases)所有，名称包含操作系统与架构。发布前，[签名校验器](scripts/verify-updater-signatures.mjs)使用已提交的发布公钥校验每份更新产物的签名，并核对 manifest 中的签名与对应产物。Tauri 更新签名通过配置的更新公钥验证下载产物。macOS 临时签名检查应用完整性，不认证开发者身份，也不包含 Apple 公证。Windows 安装包没有发布者证书。

透明背景的[浅色 SVG](../../frontends/dsh/src/clawmaster.svg)与[深色 SVG](../../frontends/dsh/src/clawmaster-dark.svg)使用同一轮廓，分别以黑色和白色绘制。应用内图标跟随 Web 主题的最终明暗状态，启动页跟随系统外观。Web favicon 保留浅色 SVG 的精确字节。桌面准备过程通过[图标生成脚本](scripts/generate-icons.mjs)从浅色矢量源生成各原生图标格式；ICNS 条目按类型排序，并保留其中的编码图像。桌面品牌检查拒绝 SVG 内嵌或链接的图片。[原始 PNG](../../frontends/dsh/src/clawmaster.png)保留为视觉参考。macOS 隐藏原生标题栏中的标题文字。Windows 安装还携带文件名含版本的 ICO 文件，避免快捷方式图标查询复用旧的可执行文件路径缓存键。

Windows 发布 CI 在一次性托管 runner 上执行[已安装桌面检查](scripts/verify-windows-native.ps1)：NSIS 安装、可见主窗口、正常关闭与第二次启动必须对应打包源码。已有用户数据或缺少交互桌面时，该检查不能通过。macOS 矩阵还须在签名检查后通过下述原生 GUI 检查。解压后的 Linux 安装器另有平台检查。托管 runner 检查不能证明所有用户机器均已验收。

[macOS 原生检查](scripts/verify-macos-native.mjs)仅支持一次性 GitHub 托管 runner。构建前传入 `--preflight`，检查已有 GUI 及辅助功能权限。打包后提供绝对路径 `--app`、`--prepared-root`、`--output` 和 `--expected-version`。它将应用复制到随机 Unicode 路径，使用独立 DSH 主目录，并通过打包清单、Host 归属、HTTP 鉴权及设置与会话目录哨兵验证两次原生启动。默认 `--close-mode gui` 点击主窗口关闭按钮，要求正常退出且清理 Host。显式 `--close-mode terminate` 只验证进程终止和再次启动，报告 `guiCloseVerified: false`；不会自动降级或修改 TCC。原生验收还必须测量交通灯与内容 WebView 的矩形，确认两者不重叠；[窗口几何布局决策](../../.agents/notes/implemented/architecture/2026-09-15-macos-native-content-rectangle.zh.md)定义这一要求。[验收决策](../../.agents/notes/implemented/testing/2026-09-15-macos-native-relaunch-acceptance.zh.md)定义证据范围。

[构建溯源](scripts/build-provenance.mjs)将完整 harness 构建和产品准备过程绑定到完整 Git 提交、已提交树、工作区源码 SHA-256 与相对路径脏文件清单。准备过程拒绝编译后的源码改动或被替换的 Host、客户端与前端产物。默认 `development` 模式生成明确的开发构建编号，源码有改动时包含 `dirty`。`DSH_DESKTOP_BUILD_MODE=release` 要求整个工作流使用干净源码和发布模式记录。生成的原生图标属于受验证的构建输出，不作为源码输入；平台编码器可能在 SVG 不变时改变输出字节。源码变化后，须重新完整执行 `build:harness`，再执行 `prepare:dist`。

资源包的 `.bundle-manifest.json` 包含 `desktopVersion` 与 `buildProvenance`，同内容的 `.build-provenance.json` 参与 `contentSha256`。安装包携带这些记录，不携带 `.git`。每个平台的 `*-build.json` 发布附件标识其源码与产物，发布流程核对其提交、树、版本及干净发布模式与标签一致。溯源检查纳入 `test:bundle`。

发布工作流使用 [Office 下载器](scripts/prepare-office-runtime.mjs)有限重试暂时性 HTTP 失败，随后由 Office 准备程序检查固定的 SHA-256。认证、TLS 和内容校验失败均不能绕过。

在完成 `build:harness`、原生 RPA helper 和 Office 资源准备后，准备载荷而不编译原生壳：

```powershell
node scripts/prepare-dist.mjs
```

## 运行

**开发模式（monorepo checkout）：**

```powershell
# repo root: pnpm --dir apps/desktop-tauri run build:harness  (once)
cd apps/desktop-tauri
$env:DSH_DESKTOP_LAUNCH='local'
pnpm run dev
```

**已安装应用：**从 GitHub Releases 选择对应系统的安装包。首次启动在启动页扫描本机环境、选择已有 DSH 主目录，并安装缺失的工具或依赖，完成后打开 Web 界面。

## 脚本

原生 Host 就绪后写入 `$DSH_HOME/desktop/current-runtime.json`，正常退出时将自身记录标记为已停止。记录包含载荷摘要、源码来源、进程标识和观测时间；预置元数据与记忆条目不是实时状态依据。前端的 `runtime_status` 工具每次重新读取此文件，并要求 Host PID 与当前进程一致，拒绝已停止、缺失或格式错误的记录。历史观测保留原日期。未注册的空版本目录不占用三个回滚保留名额；已注册 Workspace 目录仍受保护。WSL 和源码开发启动不发布这份原生身份记录。

| 脚本 | 用途 |
|---|---|
| `scripts/bundle-harness-source.mjs` | 裁剪并复制 monorepo 子集到 `bundled/harness/` |
| `scripts/prepare-dist.mjs` | 生成启动页 dist 与源码包（Tauri `beforeBuildCommand`） |
| `scripts/serve-dist.mjs` | 为 `tauri dev` 启动静态启动页服务器 |
| `scripts/openviking-local.py` | 明确执行外置本地 OpenViking 服务的 macOS 准备、运行、诊断和 USER 凭据创建 |
| `overlay/desktop-notify/` | Cordis overlay：把已完成的 turn 发到原生通知端口 |

启动回归：先复制裁剪包到临时目录并安装生产依赖，将 DSH_DESKTOP_SMOKE_ROOT 指向该目录，再运行 pnpm run test:startup；它使用独立主目录验证桌面默认插件、认证、跨源写入拒绝、CRM/ERP 空数据、Workspace 按需创建，以及 Host 换端口重启后保留 CRM 记录，不调用模型 API。

包兼容性：在本目录依次运行 `pnpm run build:harness`、`pnpm run prepare:dist` 和 `pnpm run test:compat`。兼容性运行器要求准备好的源码与载荷摘要对应当前版本，将已验证的包复制到私有临时目录，并在那里安装锁定依赖，不执行生命周期脚本。它下载固定版本的官方 OpenViking 和 Sidebar 压缩包，并在解包前检查已登记哈希。插件安装、路由、OpenViking 会话兼容性和 Office 保存冲突测试使用明确的产物位置。陈旧构建或压缩包变化会导致失败；真实 OpenViking 捕获与检索、IM 送达及原生平台验收仍需独立证据。运行需要网络、pnpm 和 tar。

## 开发规划

拟议的 [ClawMaster 0.2.3 交付规划](../../.agents/notes/proposed/process/2026-09-15-clawmaster-0.2.3-delivery-plan.zh.md)负责下一轮工作包、依赖、恢复要求和验收用例。未勾选工作不是已交付行为；本 README 继续负责已安装桌面的使用说明。
