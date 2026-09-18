# Agent Note: 在同一工作流中构建安卓 Node 运行时并执行应用检查

Status: implemented

[English](2026-09-18-android-runtime-cloud-validation.md) | 中文

## 问题

应用进程中的 Node 检查需要使用同一源码修订构建的安卓运行时。若必须依赖另一轮已完成的构建，手动云端验证就依赖先前工作流，单轮结果也无法显示从构建到模拟器的完整过程。Node 默认 make 目标还会编译安卓运行时不需要的宿主测试程序。

## 决策

[安卓云验证工作流](../../../../.github/workflows/android-cloud-validation.yml)使用 `make node` 构建 Node 运行时，并将完成构建的各 ABI 运行时作为短期工作流产物上传。安卓兼容补丁会在 Android 上关闭 V8 不支持的 `execinfo` 路径，避免 Android cctest 对保护页的假设，为 V8 启用 Android POSIX 陷阱处理源码，并通过 Android 的 `getauxval` 头文件检测 arm64 CPU 能力，绕开未链接的 NDK 辅助函数。Android 16 的 16 KB smoke 在失败时会输出进程退出码和 linker 日志。手动运行未提供历史运行 ID 时，会在同一工作流中构建运行时，并将其打入云模拟器测试用 APK。手动运行提供了运行 ID 时，会先确认该运行的 x86_64 运行时作业已成功完成，再下载其产物。运行时库只会加入 runner 上的临时验证 APK；工作流不会上传该 APK。

## 曾考虑的替代方案

**链接 NDK CPU 能力辅助库。** Android zlib 构建会引用 `android_getCpuFeatures`，但把 NDK 辅助库链接到 Node 原生目标会增加运行时依赖。通过 Android 的 `getauxval` 接口读取相同的 arm64 能力位，不需要该依赖，也与 Linux arm64 实现一致。

**每次应用进程检查都要求运行两轮工作流。** 这能保留运行时产物复用能力，却让常规验证依赖另一轮运行和手动复制的运行 ID。保留可选运行 ID 可以继续复用产物，同时允许单轮完成构建到模拟器验证。

## 后果

托管构建仍会从 Node 源码编译所需 ABI，耗时可能较长；工作流保留有界的作业超时。运行时产物证明相应 Node 二进制通过构建和对齐检查；应用进程仪器测试会单独验证其能以安卓应用 UID 运行。该验证不能证明 DSH 能启动、桌面功能可在安卓运行，或分发版安卓应用包含 DSH。

## 验证

工作流 YAML 可解析，Node 运行时和模拟器作业仍存在，且 `git diff --check` 通过。只有 GitHub Actions 在云模拟器中完成运行时构建和应用进程仪器测试后，才能接受这项工作流变更。
