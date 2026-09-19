# Agent Note：只构建 Android 生产 Node 目标

Status: implemented

[English](2026-09-18-android-production-node-target.md) | 中文

## 问题

Android 运行时工作流使用 Node.js 默认 make 目标，同时编译了不属于发布运行时的 `cctest` 源码；这些测试源码无法通过当前 Android NDK 编译。

## 决策

`android-configure` 生成输出目录后，工作流在 `out` 下使用 Release 配置构建 `node` 目标。产物可执行检查、16 KB ELF 对齐检查和模拟器冒烟测试保持不变。

## 考虑过的替代方案

继续构建默认目标并修补仅用于测试的 Android C++ 源码，会把测试兼容工作带入生产运行时构建。发布产物需要生产可执行文件；Android 设备行为由模拟器冒烟测试覆盖。

## 后果

运行时任务不再构建 Node 测试程序。该任务证明生产 Node 二进制可以构建，并在所选 Android 模拟器上运行；它不声称 Node 的 C++ 测试套件可在 Android 上运行。

## 验证

工作流回归测试要求显式构建 `node` 目标，拒绝默认并行 `make` 命令，并保留 ELF 与模拟器检查。工作流中的两个 ABI 构建负责验证编译器变更。
