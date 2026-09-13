# Agent Note: Windows 安装后桌面验收

Status: implemented

[English](2026-09-14-windows-installed-desktop-validation.md) | 中文

## Problem

复制后的生产 Host 可以正常启动，而 Windows 安装器、原生窗口或正常退出仍可能存在故障。原生验收还可能接管已有 Harness 数据，因为 Windows 已知文件夹的解析不会遵循 APPDATA 环境变量覆盖。

## Decision

[原生验收脚本](../../../../apps/desktop-tauri/scripts/verify-windows-native.ps1) 仅在一次性的 GitHub 托管 Windows runner 上运行。存在桌面进程、ClawMaster 安装注册或 Harness 已知文件夹数据时，脚本拒绝执行。脚本拥有唯一安装目录和 DSH 主目录，通过受支持的主目录补丁配置独立笔记库，并只清理自身获得的目录与进程。外壳偏好使用真实且原本不存在的应用数据目录；修改 APPDATA 不能建立隔离。

脚本检查已安装程序的版本、可见主窗口、要求认证的 Host 就绪状态及进程父子关系。正常关闭窗口必须停止桌面及 Host，随后再次启动原生程序并发布不同的运行编号。[证据校验](../../../../apps/desktop-tauri/scripts/windows-native-evidence.mjs) 将两次观察与已发布载荷的来源记录比较，拒绝陈旧或其他进程的状态。

仅手动触发的验证工作流从官方公开发行版下载既有 beta.6 安装包及清单，检查其 SHA-256 并固定校验和附件的摘要。它不构建、发布或替换发行版。

## Alternatives considered

**用复制后的 Host 冒烟检查作为原生证据。** 该检查不执行安装器，也不覆盖原生窗口生命周期。

**仅重定向 APPDATA。** Rust 目录提供器解析 Windows 已知文件夹，因此环境覆盖不能隔离外壳存储或陈旧 Host 恢复。

## Consequences

没有交互桌面时，验收明确失败。测试不包含模型请求或 Office 编辑。跨平台证据测试验证拒绝行为；只有 Windows 任务成功才能证明安装后原生生命周期行为。
