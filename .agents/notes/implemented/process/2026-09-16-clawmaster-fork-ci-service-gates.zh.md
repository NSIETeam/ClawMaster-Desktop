# Agent Note: ClawMaster 仓库的 CI 外部服务门禁

Status: implemented

[English](2026-09-16-clawmaster-fork-ci-service-gates.md) | 中文

## 问题

ClawMaster-Desktop 保留了 DSH 工作流源码，却不拥有 DeepSeek Harness 的 Issue Project、对应 GitHub App、Cloudflare 预览项目或自定义 16 核运行器标签。这些作业因缺少凭证失败，或因本仓库无法分配运行器而长期排队。Python 已安装 wheel 矩阵的无密钥黑盒检查已经通过，但真模型预检仍因缺少密钥失败。

## 决策

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) 和 [Issue policy](../../../../.github/workflows/issue-policy.yml) 作业只在所属的 DeepSeek Harness 仓库运行。[预览工作流](../../../../.github/workflows/build-preview-cloudflare.yml) 仍为每个 PR 构建页面，但只在该仓库部署和探测 Cloudflare。因此 ClawMaster-Desktop 不报告 Cloudflare 部署或上游 Project 校验。

[PR CI](../../../../.github/workflows/ci.yml) 在上游仓库保留原有 16 核标签，为 ClawMaster-Desktop 选用 GitHub 标准 `ubuntu-24.04` 和 `windows-2025` 运行器。4 核消费者作业通过[预期输出配置](../../../../vitest.expected.config.ts)限制并行门禁和预期输出 worker，保留原断言与超时，上游作业继续使用资源更多的池。Linux 和 Windows 覆盖率仍测量所有归属源码文件，但 ClawMaster 作业使用两个分区、每分区两个 worker，并一次执行一个门禁；上游保留四个分区、六个 worker 和三个并行门禁。在根仓库的消费者 lint 门禁之前，ClawMaster CI 安装单独锁定的 DSH 和 Office 前端开发依赖；这些 TypeScript 文件仍参与 lint。可复用的 [Python 运行时构建器](../../../../.github/workflows/build-exe-for-python-sdk.yml) 在两个仓库都继续运行干净安装和无密钥 wheel 检查。经过认证的步骤要求 `real_api` 输入；上游 CI 和发布调用保留默认 `true`，ClawMaster PR CI 传入 `false`，这些步骤明确显示为跳过。缺失密钥不会被算作一次成功的模型调用。

## 验证

[工作流规格](../../../../scripts/ci-workflow.spec.ts) 计算两个仓库的运行器选择与消费者并发预算、锁定外部服务归属，并确认四个 Python 认证步骤共用显式输入。GitHub 托管运行结果和真实模型回复仍需分别从远端取得证据。

## 考虑过的替代方案

**复制上游凭证：**ClawMaster-Desktop 无权控制 DeepSeek Harness 的 Project 或 Cloudflare 预览；添加这些密钥会耦合无关仓库，并授予不必要的访问权限。

**把缺失密钥的预检标成成功：**这会将没有执行的模型测试算作绿色结果。明确跳过才能保留证据缺口。

## 后果

ClawMaster-Desktop 的 PR 可以运行 DSH 无密钥和构建检查，不再等待无法使用的自定义运行器。标准运行器的资源少于上游 16 核作业，因此必须观察完整远端矩阵，才能声称 CI 等效。在服务实际存在的上游仓库，Project 和预览门禁保持原样。
