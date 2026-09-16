# Agent Note: ClawMaster 原生权限归属于包内 WebView

Status: implemented

[English](2026-09-16-clawmaster-native-privilege-isolation.md) | 中文

## Problem

桌面窗口同时包含包内外壳与独立的已认证 Host WebView。按窗口授权会包括子 WebView，而 localhost 通配符也匹配其他监听器。文档内容不能通过任一规则继承原生命令。

## Decision

[Capability](../../../../apps/desktop-tauri/src-tauri/capabilities/default.json) 仅匹配包内 `main` 与 `splash` WebView。应用构建 manifest 注册三个外壳命令，由 Tauri ACL 强制执行。Host 内容及预览 frame 不获得原生权限。[导航校验器](../../../../apps/desktop-tauri/src-tauri/src/webview_security.rs)要求带明确端口的数字回环 HTTP 地址，只允许同一精确来源，拒绝凭据并禁止新窗口。

包内外壳默认拒绝的 CSP 允许本地脚本与图片、Tauri IPC，以及进度更新所需的内联样式。Tauri 为包内内联脚本生成哈希；不授权任意内联 JavaScript 或 `eval`。该策略不能替代独立 Host 的网页资源策略或 DSH 工具权限。[运行治理决策](2026-09-13-clawmaster-runtime-governance.zh.md)继续负责执行策略；插件仍是具有 Host 进程权限的可信代码。

## Alternatives considered

**授权给父窗口或 localhost 通配符。** 这些规则会授权子视图或无关监听器。[原生窗口决策](../feature/2026-09-13-clawmaster-native-window-titlebar.zh.md)已经将拖动与窗口控件交给原生装饰。

**同时禁止内联样式与脚本。** 现有进度渲染会更新样式属性。这一有限样式例外既不授权脚本执行，也不授权远程资源访问。

## Consequences

Host 内容不能调用外壳生命周期命令或创建原生窗口。要求新原生窗口的外部链接会被拒绝；普通内嵌浏览器保持独立。后续原生操作需要明确审核的 capability。任意恶意 Host 插件不会被 WebView ACL 隔离。

Rust URL 测试拒绝错误端口、来源、凭据和非 HTTP 目标。实际应用 ACL 能够编译，策略测试拒绝按窗口或远程来源授权。这些源码检查不能证明跨平台已安装 WebView 行为；打包后原生交互仍是独立验收要求。
