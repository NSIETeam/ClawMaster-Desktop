# Agent Note: 本地 DSH 安装的运行时看门狗

Status: implemented

[English](2026-09-19-runtime-watchdog-hardening.md) | 中文

## 问题

令本地安装无法使用的运行时问题并非源码缺陷。本地 `boot.log` 记录的 89 次启动中，有 13 次以 `ERROR dsh web 进程已退出 (code 1)` 结束，源自三类树外原因：

| 类别 | 记录的失败 | 次数 |
|---|---|---|
| A | `cannot resolve profile bundle …` | 9 |
| B | `patches ~/.dsh/cordis.patch.yml must be a top-level YAML array` | 2 |
| C | `corrupt session log … header id and cwd identify …` | 1 |

另外两类不会让启动崩溃，却会静默降级：缺少 CSP 补丁（窗口空白、侧栏错位），以及本地记忆服务不可用。这些面都不在本仓库自身门禁的覆盖范围内，因为它们全部位于检出目录之外：Profile bundle、`~/.dsh` 配置、会话日志，以及冻结的 harness 树。

本机还会就地修改 harness 树。一次已记录的事件把 `packages/core/agent-loop/lib/index.js` 改为向 `/tmp/cm-sched-diag.log` 追加内容；该文件已从快照恢复，但当时运行的进程仍在执行被修改的模块。

## 决策

看门狗以 shell 与 Node 工具的形式交付在 `scripts/runtime-watchdog/` 下，不改动 `packages/`、`apps/` 或任何已发布面。它有四个入口：

- `doctor.sh` — 唯一的只读入口：core 完整性、树外启动输入、服务、常驻医生存活状态，以及可选的基线×快照交叉核对。
- `preflight.mjs` — 调用真实的 DSH loader（`loadProfile`、`loadOptionalPatches`、`generationLogPath`），而不是重新实现其规则，因此检查与启动在构造上必然一致。它不调用任何写入路径。
- `heal.sh` / `repair-core.sh` — 修复，并带有一份自动化删除永远无法触碰的受保护 core 清单。
- `resident-doctor.sh` — 由 LaunchAgent 驱动的修复循环，外加一份心跳，使其自身缺席可被发现。

### 验证恢复资产，而不是信任它们

检测路径读取哈希基线，修复路径读取 tar 快照。两者都是输入，而在此前的若干轮迭代中只检查了前者。改为检查后者后，又发现了三个各自独立的缺陷：

1. `tar` 在无法恢复符号链接元数据时以非零状态退出（本树中有 3669 个符号链接，macOS 上报 `EBADF`）。1675 条元数据警告、一个退出码 1，而内容是完整的。因此解包会传入 `-o` 并分类 stderr，而不是以退出码为准。
2. 快照以只读方式存放目录，因此后续运行无法删除或覆盖上一次解包的结果。`repair-core.sh` 无法对同一个文件修复两次。修法是先提升写位，再删除工作副本并以 `-o` 解包。
3. `drill-real-snapshot.sh` 从 `core-manifest.sha256` 中挑选样本，而该文件与机器相关且被 `.gitignore` 忽略，因此全新克隆会失败而不是跳过。

`crosscheck-core.sh` 直接比较这两份产物（集合与内容，双向）。在本机上两者一致：49028 个文件，双向完全相同。

### 不得进入仓库的状态

`core-manifest.sha256` 是对某台机器某一时刻的逐字节描述，而且有 8 MB。提交它会让基线描述别人的树，这比没有基线更糟。它与其他生成产物由工具目录中的 `.gitignore` 排除；每台机器用 `doctor.sh --build-manifest` 构建自己的基线。

### 看门狗不处置其他服务

`com.clawmaster.openviking` 因 `~/.dsh/.credentials.yaml` 已不存在而在 `KeepAlive` 下崩溃循环。看门狗报告该循环、已记录的错误，以及停止或恢复它的确切命令，然后到此为止。停用另一个主体的服务，不是修复工具应当做出的决定。

## 后果

该工具不向 `packages/`、`apps/` 或任何已发布面引入依赖，core 树也不因它改变：快照、哈希基线与心跳都逐机器生成并从仓库排除，因此全新克隆在没有它们的情况下也能运行看门狗，而 `doctor.sh` 会逐项报告缺失的产物，而不是失败。

保证是有边界的，本文也按此表述。检测加恢复产出的是下一次干净的启动；它不会让运行中的进程变得不可变，而一个已经加载了被修改模块的进程会继续执行该模块，直到 Host 重启。`--quick` 修复路径还有一个已证实的盲区，即 mtime 被回拨、只读位被恢复的文件不会被检出，该盲区由周期性的 `--deep` 通过关闭，而不是由快速路径关闭。

有一项运维决定是刻意留开的：`com.clawmaster.openviking` 会一直处于崩溃循环，直到有人停止它，因此该循环会持续产生日志增长与重启负载，看门狗只报告而不消除。

## 曾考虑的替代方案

- **把文件权限当作不可变性。** `chmod -R a-w` 只提高了门槛，仅此而已：同一用户下的进程可以恢复写位。实测到的边界是检测并恢复到下一次启动，而不是对运行中进程的保证。进程隔离（独立用户，或只读挂载）才是能够关闭该缺口的手段，而它无法从应用之外触及。
- **用轮询替代事件驱动修复。** 桌面应用自身在崩溃后的重试实测为 9.6 秒到 20982 秒。修复循环改由 `boot.log` 上的 `WatchPaths` 唤醒，其触发时间为一到四秒。
- **认为哈希干净就已足够。** 整树匹配并不能说明快照是否仍能恢复该树。常驻医生现在会先检查恢复能力，再决定是否需要恢复，并把不可用的快照报告为失败且不自动补救。

## 验证

`self-test.sh` 运行四个套件：`fixture-test.sh`、`resident-doctor-test.sh`、`repair-core-test.sh`、`drill-real-snapshot.sh`。在作者机器上它们分别报告 31、47、42 与 8 条通过的断言，且演练针对 fixture core 使用真实的 439 MB 快照，因此生产树从不被修改。

有几条断言之所以存在，是因为此前的测试以错误的理由通过。`resident-doctor-test.sh` 断言渲染出的心跳整行而不是其前缀，此前一处 `${…}` 替换错误让仅比对前缀的检查通过了。`repair-core-test.sh` 让其 fixture 快照变为只读，与生产快照一致，此前第二次修复的缺陷在可写 fixture 背后一直不可见。
