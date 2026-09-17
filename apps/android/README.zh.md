---
description: ClawMaster 安卓版运行桌面 DSH 客户端与本机宿主。
---

# ClawMaster 安卓版

[English](README.md) | 中文

## 概述

ClawMaster 安卓版在设备本机启动 DSH 宿主，并通过 Android WebView 显示共享的 ClawMaster Web 客户端。启动图标与桌面端来自同一 SVG。安卓应用使用桌面默认 profile，不连接另一台电脑上的 DSH 宿主。系统要求为 Android 8.0 或以上。

## 目录

- [使用](#use)
- [数据与权限](#data-and-permissions)
- [开发](#development)
- [分发](#distribution)

<a id="use"></a>
## 使用

联网后启动应用。首次启动时，应用会验证并解压 DSH 载荷，在私有存储中安装锁文件规定的生产依赖，然后启动本机宿主。首次启动可能需要几分钟。请保持应用打开，直到桌面客户端出现；如果宿主报告错误，请重试启动。

共享 Web 客户端提供桌面产品界面和桌面 profile。安卓端能否达到完整对齐，仍取决于 profile 中每项能力是否可在安卓运行。依赖桌面原生进程、设备或窗口集成的功能，需要实现安卓版本并通过云端设备验收后，才能视为可用。

当前安卓应用面向 arm64-v8a 和 x86_64。Node.js 22.19.0 在安卓上的运行时仍属实验性质，因为 Node.js 上游不支持安卓。DSH 主目录、运行时载荷和已安装依赖保存在应用私有文件目录。首次安装依赖和使用已配置的远程服务均需要网络。

<a id="data-and-permissions"></a>
## 数据与权限

应用声明联网及网络状态访问、DSH 宿主运行期间所需的数据同步前台服务和通知权限。WebView 导航限制在本机回环地址，文件选择交由 Android 处理。DSH 配置、会话、工作区数据、运行时文件和已安装依赖均保存在应用私有存储中；卸载应用时 Android 会移除这些数据。不要在共享链接或日志中放入 API 密钥。

<a id="development"></a>
## 开发

安卓构建和模拟器检查在 GitHub Actions 中运行。本项目不得在本地构建安卓版本或运行安卓模拟器。云端工作流会为 arm64 和 x86_64 构建校验和固定的 Node.js 22.19.0 运行时，打包已构建的桌面 DSH harness 与锁定依赖，并在 Android API 26、API 36 云模拟器的两种 ABI 上验证 release APK。测试会检查已安装的图标、本机 DSH 启动、共享 ClawMaster 工作区、Activity 重建，以及宿主停止和重启。云端 DOM 检查能够识别共享前端，但不能证明每项桌面能力均已验收。

Release APK 构建仅在云端工作流安装对应的 Android Node 运行时和 DSH 载荷后执行。工作流使用一次性验证证书为测试版本签名，记录 APK 校验和与签名信息，并将 APK 留在 runner 上。不得使用该证书分发应用。

<a id="distribution"></a>
## 分发

分发前须使用保留的 Android 发布密钥为已测试 APK 签名，并核验 APK 签名、包版本、版本代码、ABI 内容、校验和及证书指纹。更新必须使用相同发布密钥和更高的版本代码。使用临时证书签名的云端验证 APK 不可用于分发。

生成 APK 不等于完成 Google Play 发布或 Android 开发者账户验证。Node.js 安卓运行时仍属实验性质；只有安卓专属能力工作流全部通过验收，才能确认与桌面功能对齐。
