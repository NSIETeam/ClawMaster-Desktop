# Agent Note: 连接运行中 Host 的 ClawMaster 控制 CLI

Status: implemented

[English](2026-09-14-clawmaster-control-cli.md) | 中文

## 问题

终端自动化需要查询桌面已有的会话并向其提交任务，同时沿用会话的模型配置、凭据与权限。第二个 agent 运行时会拥有不同的活动状态，而子进程 SDK 无法连接桌面 Web Host。访问该 Host 还携带操作系统用户的工具执行权限，因此不能把本地发现文件描述成只读凭据。

## 决策

[控制组件](../../../../frontends/control/README.zh.md)通过已有 Host 的认证 Connection 与 Session Remote 操作连接它。`clawmaster-control` profile 运行短时客户端，不加载 `dsh-base`。仓库的 `pnpm clawmaster` 便捷命令分派到这个 profile，不增加另一种应用启动器，也不启动 agent Host。

当源码安装只把选定的 control bundle 列为开发依赖时，已有的 [profile 模块 fallback](../../../../packages/boot/app-boot/README.zh.md)会将 bundle 本身暴露给 profile 的插件 loader。安装依赖和已有 pnpm 管理的条目仍然优先。源码与已安装入口因此沿用同一个 profile 解析器，无需 control 专用导入补丁。

Host 入口在私有、由 owner 控制的 `$DSH_HOME/control/connection.json` 记录中发布进程登录 URL。客户端验证发现记录后，用该 URL 换取普通 Host cookie。这是同一操作系统用户的完整 Host 认证。限制命令种类不会缩小凭据权限；持有记录即可获得与桌面浏览器相同的认证。诊断与普通命令输出不包含登录材料。

客户端只提供 `status`、`sessions`、`send` 和 `cancel`。列表查询使用不会激活冷会话的 Session 操作。发送要求目标会话已存在，并从标准输入读取正文；消息准入、steering（中途引导）和工具审批仍由 Host 负责。接受回执表示准入，不表示模型完成任务。取消针对当前轮次，并保留待处理收件箱。接口不提供通用 RPC 调用或自动审批答复。

## 考虑过的替代方案

**使用 TypeScript 子进程 SDK。** 它的客户端通过标准输入输出 JSON-RPC 创建新的 `dsh --profile sdk` 进程。这个进程无法查询或控制已有桌面的活动 agent。

**从回环端口推断身份，或增加另一个未认证入口。** 回环可达性不能识别用户。复用 Connection 保留已有的 cookie 交换与请求信任检查。

**把连接记录当成只读凭据，或开放任意 Remote 调用。** Host cookie 授予完整应用访问权限。固定命令集便于审核受支持的 CLI，但不能缩小底层凭据的权限。

**用 Session `follow` 查询。** 它的初始快照可能把冷会话提升为活动 agent。Session 列表无需这种激活，即可提供所需摘要与运行状态。

## 后果

终端任务沿用桌面的会话与权限负责人，无需复制模型配置。私有连接记录增加了进程登录材料的存放位置，因此必须仅允许 owner 访问，并避免进入共享文件或诊断输出。[浏览器认证决策](../architecture/2026-08-24-browser-token-authentication.zh.md)继续负责 cookie 验证与进程令牌轮换；这个产品层交接为具体的同用户客户端扩展其令牌存储策略。

Host 必须加载桥接，CLI 才能连接。构建 CLI 不会改变已安装的桌面，也不授权中断其中的活动任务。接口返回的是消息准入与取消确认，不保证任务完成，也不提供委派的细粒度服务凭据。
