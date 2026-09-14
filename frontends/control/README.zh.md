---
description: "通过同一操作系统用户的私有登录，从终端连接正在运行的 ClawMaster Host，查询会话、提交消息并取消当前轮次。"
kind: "package-bundle"
---

# ClawMaster Control

[English](README.md) | 中文

## 概述

ClawMaster Control 让你从终端检查正在运行的桌面 Host、列出会话、向已有会话发送消息，并取消当前轮次。它连接该 Host，沿用其中配置的模型、凭据与权限。Host 必须包含控制桥接，两个进程必须选择同一个 Harness 主目录。连接记录赋予同一操作系统用户完整的 Host 登录权限，不是只读凭据。

## 目录

- [使用 CLI](#use-the-cli)
- [命令与结果](#commands-and-results)
- [连接与故障恢复](#connection-and-recovery)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [进一步阅读](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-the-cli"></a>
## 使用 CLI

保持兼容的 ClawMaster Host 运行，并由[桌面策略层](../../apps/desktop-tauri/defaults/cordis.patch.yml)启用控制桥接。使用与该 Host 相同的操作系统账号和 `DSH_HOME`。桌面准备过程和仓库便捷命令根据这个私有 bundle 的[补丁](cordis.patch.yml)初始化专用客户端 profile。构建或调用这个 CLI 不会更新、重启或安装桌面应用。

受支持的入口是具名 `dsh` profile：

```sh
dsh --profile clawmaster-control status --json
dsh --profile clawmaster-control sessions --running --json
```

在本仓库中，`pnpm clawmaster status --json` 选择同一个 profile。这个便捷命令启动的是短时运行的控制客户端，不会再启动一个 agent Host。

发送任务前，先用 `sessions` 找到已有会话，再把下面的 `SESSION` 替换为会话 ID。将消息准备为本地 UTF-8 文本文件，避免正文出现在命令行参数中。`--stdin` 要求管道或文件重定向；空内容、纯空白及无效 UTF-8 输入会被拒绝。默认输入上限为 1 MiB：

```sh
dsh --profile clawmaster-control send SESSION --stdin --json < message.txt
```

检查确认结果，再回到 ClawMaster 中的对应会话查看回答或处理审批。消息被接受只代表任务已进入队列，不代表结果已经完成。

-----

<a id="commands-and-results"></a>
## 命令与结果

所有命令都支持 `--json`，便于读取结构化输出。可用操作限于以下几项：

| 命令 | 结果与影响 |
|---|---|
| `status [--json]` | 检查与选定运行中 Host 的连接。JSON 包含 `connected` 和经过筛选的 `runtime` 元数据。 |
| `sessions [--running] [--json]` | 返回包含 ID、运行状态、活动时间及可选工作区路径的 `items`，不返回消息正文。`--running` 筛选当前运行中的会话。列出持久化会话不会激活其 agent。 |
| `send SESSION --stdin [--steer] [--request-id UUID] [--json]` | 向已有会话提交标准输入。`--steer` 选择 steering（中途引导）投递；`--request-id` 指定请求的 UUID。回执包含 `accepted`、`sessionId`、`requestId` 和 `mode`。Host 的准入规则与会话权限仍然生效。 |
| `cancel SESSION [--json]` | 请求取消当前轮次。回执包含 `accepted`、`sessionId` 和 `pendingInbox: "retained"`。 |

CLI 不会批准工具请求、回答交互提问，也不提供任意 RPC 调用。排队中的消息仍可能等待 Host、模型提供方或用户决定。取消轮次不会删除会话、清空收件箱，也不承诺撤销已完成的工具操作。

-----

<a id="connection-and-recovery"></a>
## 连接与故障恢复

桥接在 `$DSH_HOME/control/connection.json` 发布私有连接记录。请将该文件视为登录凭据：不要附到 issue、复制到共享工作区或打印到诊断信息中。即使当前 CLI 命令只查询会话，其中的信息仍可获得完整的 Host 认证访问权限。CLI 用进程启动 URL 换取 Host 的普通登录 cookie。

如果连接记录不存在，检查运行中的 Host 是否包含桥接，以及两个进程是否使用同一个主目录。如果认证或连接失败，确认目标 Host 仍在运行。不要用猜测的端口替换记录、复用其他用户的记录，或仅为查询成功而另外启动 agent Host。

如果发送响应丢失，重新发送前先检查目标会话。CLI 不会自动重试。重试同一条消息时，用 `--request-id` 保留原请求 ID；该 ID 标识提交的请求，并不证明模型已经完成任务。命令操作失败时以非成功状态退出；JSON 模式向标准错误写入包含 `code`、`message` 及可选 `requestId` 的 `error` 对象。成功结果写入标准输出；两种输出都不回显提交的正文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

私有软件包 `@clawmaster/dsh-control` 有两个插件入口：`.` 运行控制 profile，`/host` 从运行中的 Host 发布连接信息。控制 profile 不加载 `dsh-base`。它使用已有的认证 Connection 与 Session Remote 操作，不通过子进程 SDK 连接，也不拥有第二份模型配置。

bundle 补丁挂载命令插件；桌面策略层另行挂载 Host 入口。命令插件接受以下部署限制：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInputBytes` | `1048576` | 正整数 UTF-8 输入字节上限。 |
| `requestTimeoutMs` | `30000` | 连接、认证和 RPC 的时限，范围为 `1` 到 `2147483647` 毫秒，从标准输入结束后开始计算。超时报 `request-timeout`，不证明消息是否已被接受。 |

[Host Session 控制器](../../packages/api/session-controller/README.zh.md)负责准入、状态与取消语义。它的 `list` 操作读取冷会话而不激活。流式 `follow` 操作可能激活冷 agent，因此 CLI 不用它实现列表查询。

</details>

-----

<a id="model-experience"></a>
## 模型体验

控制客户端不增加模型工具或系统提示词。`send` 提交的消息通过目标 Host 会话已有的消息准入路径进入；该会话负责模型对话、工具权限与审批。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

这个接口控制已有的本地 Host，具有以下限制：

- 不创建会话、流式输出完整回答、管理审批或提供通用 RPC 访问。
- 连接记录是操作系统用户凭据，不是限定权限的服务账号或只读 token。CLI 命令范围不会缩小所存登录材料的权限。
- 已安装的桌面若没有桥接，就无法通过该入口控制。源码改动和隔离命令测试不能证明已安装应用或跨平台验收通过。
- 发现过程要求原生桌面提供匹配且已就绪的运行时身份。普通源码 Web 与 WSL 启动不发布这种身份。所有权、权限或符号链接路径不安全的连接文件会被拒绝。

<a id="further-exploration"></a>
## 进一步阅读

- [桌面配置](../../apps/desktop-tauri/README.zh.md) — 运行中的应用及所选主目录。
- [Connection](../../packages/client/connection/README.zh.md) — 已有 HTTP 认证与 RPC 传输。
- [控制接口决策](../../.agents/notes/implemented/feature/2026-09-14-clawmaster-control-cli.zh.md) — 同用户访问与替代方案。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
