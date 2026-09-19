# ClawMaster 运行时守护

目标只有三条，来自明确要求：

1. **core 在运行期间不可被更改。** 冻结 + 全树哈希基线 + 可从快照还原。
2. **core 之外的东西不能把运行带崩。** 启动前拦截 + 自动降级。
3. **常驻医生：一崩就修。** 崩溃一落盘就被唤醒，先修病因，不指望 App 自己重试。

外加一条硬约束：**保证正常运行的内容不能被改变** —— 有受保护核心清单，任何自动流程都不许动。

据此，本目录把"运行时问题"从**被动救火**变成**启动前拦截 + 自动降级 + 事后可验证 + 可还原**。

---

## 一、先看真实故障史（这是设计依据，不是想象）

`boot.log` 里有 89 次启动、**13 次 `dsh web 进程已退出 (code 1)`**，全部来自三类硬崩：

| 类别 | 真实报错 | 次数 |
|---|---|---|
| **A. profile bundle 解析失败** | `cannot resolve profile bundle "@clawmaster/dsh-pdf" / dsh-office / dsh-guard / @nanmicoder/dsh-agent-teams / dsh-ocr` | 9 |
| **B. patch 文件格式非法** | `patches ~/.dsh/cordis.patch.yml must be a top-level YAML array` | 2 |
| **C. 会话日志身份不符** | `corrupt session log ... header id … and cwd identify …` → plugin tree 加载失败 | 1 |
| D. CSP 补丁丢失（前端白屏/右侧栏错位） | `style-src` / `script-src` 被 provision 冲掉 | 1 |

**A 是头号杀手**：一个插件装不上，整个 ClawMaster 就打不开。

---

## 二、设计原则：不重新发明判定规则

预检器**直接调用 DSH 自己的代码**，不靠猜：

| 检查 | 用什么判定 |
|---|---|
| A/B | `@deepseek-ai/dsh-app-boot` 的 `loadProfile()` / `loadOptionalPatches()` —— 与真正启动同一条代码路径。**逐个 profile 校验**（web 与 headless 都查），只盯 web 会漏掉另一条启动路径 |
| C | `@deepseek-ai/dsh-session-persistence-jsonl` 的 `generationLogPath()` —— 复刻 `assertStoredIdentity` 的路径不变量 |
| D | 直接读 `frontend-static/lib/index.js` 的 CSP 指令 |
| E | `runtime/manifest.json` × app 内置 bundle × node 实际版本 |
| F | 本地链接农场：`~/.dsh/profiles/node_modules` 里数百个符号链接**全部指向冻结的 harness 树**，是 app 启动时重建的派生结构。悬空 = web profile 直接崩 |
| G | 本地配套服务：OpenViking(127.0.0.1:1933)。它挂了不会让 dsh web 起不来，但记忆/语义检索会**静默降级** —— 属于"你以为还好、其实已经残了"，必须显式报告 |
| H | 运行期配置文件（`settings.yaml` / `.credentials-index.json`）**能不能解析**。用应用自己那棵树里的 `yaml` 实例判定。**只告警不阻断**：实测 `packages/boot` 与 `apps/cli/lib` **完全不引用** `settings-file`，这些文件是 host 起来之后才由服务读的，坏了不会让 `dsh web` 退出；但它属于静默降级那一类，必须报出来 |
| I | **磁盘余量**。诚实说：历史 13 次崩溃里没有一次是它造成的。但它是 core 之外能让启动硬失败的现实原因——启动要写会话日志、升级要 provision 一整棵树，满了就是 ENOSPC，而这是"外部条件"不是 DSH 的 bug，所以没人会去改代码。低于 5 GiB 告警、低于 1 GiB 阻断（阈值可用 `CLAWMASTER_MIN_FREE_GIB` / `CLAWMASTER_CRIT_FREE_GIB` 覆盖） |

这些调用**都不写盘**（会写盘的 `composeProfile` / `healProfilesModuleFallback` 一律不碰）。

---

## 三、文件

| 文件 | 作用 |
|---|---|
| `preflight.mjs` | 只读体检，**八段**核对（A–H），退出码 0/1，JSON 输出到 stdout |
| `heal.sh` | 自愈：只修"有确定解法"的问题，其余如实上报并非零退出 |
| `doctor.sh` | **统一入口**：core 完整性 + core 之外 + 服务与版本，一个命令看全部 |
| `core-manifest.sha256` | core 全树哈希基线（49028 个文件） |
| `repair-core.sh` | **把 core 还原到基线**：内容变了就覆盖、删了就补回、多了就移出，全程留证据 |
| `crosscheck-core.sh` | **两份物证交叉核对**：验证"基线说的树"和"快照里的树"是同一棵（分钟级） |
| `drill-real-snapshot.sh` | **灾难演习**：用真实的 439 MB 快照在假 core 上走完整还原路径（不动真 core） |
| `resident-doctor.sh` | **常驻医生**：被 launchd 的 WatchPaths 唤醒，崩溃即刻修复 |
| `freeze.sh` / `verify.sh` / `lib.sh` | 运行时冻结与漂移检测（CSP 补丁自愈 + `chmod -R a-w` + 基线） |
| `baseline.tsv` | 冻结基线（sha256 + 权限） |
| `install.sh` | 安装/卸载 LaunchAgent（跑的是 `resident-doctor.sh`） |
| `open-clawmaster.sh` | 启动前置包装器：先自愈再开 App（消竞态） |
| `fixture-test.sh` | preflight/heal 端到端负向测试，23 项断言 |
| `resident-doctor-test.sh` | 常驻医生行为测试，10 项断言 |
| `repair-core-test.sh` | core 还原行为测试，34 项断言（含盲区证明） |
| `lint-varexp.py` | 静态检查：`$VAR` 紧邻中文会被 bash 吞进变量名 |

---

## 四、自愈策略（与两条硬约束一一对应）

| 类别 | 自动动作 | 为什么这样定 |
|---|---|---|
| **A 缺 tool** | 先试 `dsh plugin install`；仍不行且**非核心** → 从 `bundles` 摘除（备份原件），照常启动 | 约束①：缺 tool 不阻断。**循环处理**，因为 `loadProfile` 在第一个失败处就抛错，一次只能暴露一个 |
| **A 核心缺失** | **不动手**，只告警 | 约束②：摘掉 `dsh-base`/`dsh-web-app` 就没有运行时了 |
| **B 非法 patch** | 备份后写回顶层空数组 `[]` | 只有这一种确定解法；原件保留 |
| **C 会话身份不符** | 把该会话目录**移出** `sessions` 树（隔离，不删除） | 应用自己改名成 `.broken-*` 反而永久损坏启动；必须移出去 |
| **D CSP 缺失** | 调 `freeze.sh` 重打补丁 | 前端白屏/错位的唯一修复点 |
| **E 版本漂移** | 只报告（node 被换过、app 已升级待 provision） | 擅自换 node/删目录风险更大 |

**受保护核心清单**（`heal.sh` 里的 `PROTECTED_CORE`）：
`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-acp-app`、`dsh-sdk-app`、`dsh-headless`。
可用 `CLAWMASTER_HEAL_PROTECTED_EXTRA="包名 …"` 追加。

---

## 五、core 不可变：冻结 → 检测 → 还原

三层，逐层加强，也逐层更贵：

| 层 | 做什么 | 代价 | 抓得住什么 |
|---|---|---|---|
| ① 冻结 | `chmod -R a-w` 整树只读 | 瞬时 | 挡不住同用户进程（它可以自己 `chmod u+w`），只提高门槛 |
| ② mtime 跳线 | `find -newermt <冻结时刻>` | 秒级 | 抓"改完又把权限改回去"——**本次真实注入就是这样被发现的** |
| ③ 全树哈希 | 49028 个文件逐字节比对 `core-manifest.sha256` | 分钟级 | 权威判定，任何内容改动都逃不掉 |

还原由 `repair-core.sh` 负责，语义是"**回到基线定义的状态**"而不是"回滚某个操作"：

- 内容变了 → 从 `harness-core-*.tar.gz` 快照覆盖
- 文件被删 → 从快照补回（**父目录是 555 也能补**：临时放开写位，动完按原样恢复，不会擅自改成 755）
- 多出文件 → **移出**到证据目录，不删除
- 每一步的现状都先备份到 `/tmp/core-repair-<treeId>/evidence/`，可人工复核

`repair-core.sh` 有两种模式：

- **`--quick`（秒级）** 只查三类可能被改过的文件：冻结后 mtime 变过、带可写位、基线外新增。
  常驻医生在崩溃瞬间用它，才谈得上"立即修复"。
- **`--deep`（默认，分钟级）** 全树比对。

**还有一件容易被忽略的事：还原依赖快照，所以快照自己也是被守护的对象。**
只检查"文件在不在"是不够的——一个被截断的 439 MB tar.gz 依然存在、依然以 `1f8b` 开头，
但解不出任何东西，等真要还原时才发现就太晚了。所以 `doctor.sh` 会做
**存在性 + gzip 魔数 + 全量 CRC 校验**（`--snapshot-check` 可单独跑，也会随 `--deep` 一起跑）。
快照坏了**没有自动解法**，只能喊人——所以常驻医生把判定顺序定成"**先看还原能力，再看要不要还原**"。

> **盲区是实测证明过的，不是推测的**：把内容改掉、`touch -t` 把 mtime 倒填到冻结之前、
> 权限也改回只读，`--quick` 会报"一致"；此时 `--deep` 仍然抓得到。
> 测试场景 9 就是**故意**把这个盲区跑成通过的断言，防止有人把它当成"全覆盖"。

---

## 六、常驻医生：一崩就修

`resident-doctor.sh` 由 LaunchAgent 的 `WatchPaths` 唤醒——`boot.log` 一落盘新内容就跑（实测约 1 秒）。

为什么不用定时重试：`boot.log` 里 21 次"崩溃 → 下次 boot"的间隔实测从 **9.6 秒到 6 小时**都有，
桌面 App 自己的重试**不可靠**。所以关键不是替它重启，而是**在它意识到该重试之前把病因修掉**。

每轮做的事：

1. 解析 `boot.log`：最后崩溃时刻 vs 最后成功 boot。**崩溃之后已经成功起来过 = App 自己恢复了，不插手**。
2. 幂等：同一次崩溃只处理一次（`~/.dsh/logs/doctor-state.json`）。
3. 先修 core（`repair-core.sh --quick`）——崩溃时最该怀疑的就是"core 在运行中被改了"。
4. 再修 core 之外（`heal.sh`，历史 13 次崩溃的全部来源）。
5. 若都修好了但 App 还没重试，助推一次 `open -a ClawMaster`；**10 分钟内最多 3 次**，避免和 App 自己打架。

**另外还有一件与崩溃无关、但必须做的事**（第 4 步，**不受"有没有崩溃"影响**）：

`--quick` 的盲区是证明过的，只跑 quick 等于承认"精心掩盖的改动永远不会被发现"。
所以医生还会**按间隔做一次全树哈希（`--deep --scan`），发现漂移就全树还原**：

- 间隔默认 6 小时（`CLAWMASTER_DEEP_INTERVAL`），状态记在 `~/.dsh/logs/doctor-deep.json`
- **拿锁**（`~/.dsh/logs/.doctor-deep.lock`）：launchd 可能短时间多次唤醒，全树扫描要 38 秒，
  不能几份叠着跑；锁超过 1 小时视为残留（进程被 kill 过），清掉重来，避免永远卡死
- `--deep-now` 可以无视间隔立刻核对一次
- 实测：全树核对 **38 秒**（15:18:27 → 15:19:05），PASS

> 早期版本的医生用 `exit` 早退（无崩溃就直接退出），结果是**健康机器上深度核对永远轮不到**。
> 测试场景 6/7 就是为抓这个写的。

> **为什么不盯医生自己的输出**：`WatchPaths` 只列 boot.log、manifest、harness-versions、profile 三件套，
> **刻意不含** `logs/`。医生的深度核对会写 `doctor-deep.json`、日志会写 `clawmaster-doctor.log` ——
> 一旦把这些路径也放进去，就变成"自己触发自己"的无限循环。场景 13 把这条不变量钉住了。
>
> 医生确实会写被监视的路径（`repair-core.sh` 改 core 树、`heal.sh` 改 profile），
> 但那只是**多唤醒一次**：崩溃已处理、深度核对未到期，下一轮是静默空转，不会形成闭环。

**还有一件事：谁来看着守望者。**
医生自己挂掉时 launchd 只会记一个非零退出，**没有任何人会看见** —— 而"常驻"这个保证就已经悄悄没了。
所以每轮运行（**包括健康的那一轮**）都会盖一个心跳 `~/.dsh/logs/doctor-heartbeat.json`，
`doctor.sh` 第 4 节会回答"医生现在还在不在岗"：

- 心跳新鲜（≤ 900 秒 = 3× 巡检间隔，留足休眠/负载余量）→ **在岗**
- 心跳过期 → **FAIL**："常驻医生似乎已经不在了"
- 装了 LaunchAgent 但从没跑过 → 单独报出来（不是笼统的失败）
- 没装 LaunchAgent → 如实说"现在没有常驻医生"

> 关键是**健康轮也记录**：只有在健康轮也盖时间戳的前提下，"心跳不更新"才等于"医生不在了"这件有意义的事。

---

## 六·五、两份物证必须互相对得上（已验证，不是假设）

检测用**基线**（49028 个文件的期望哈希），还原用**快照**（439 MB tar.gz）。整条链建立在
"这两者说的是同一棵树"之上，可是这个前提长期只是**默认**。如果它们矛盾，后果很具体：

- 基里有、快照没有 → 那些文件一旦丢失就再也还原不回来
- 快照有、基里没有 → **危险**：`repair-core.sh` 会把它当成"多余文件"移出 core（错杀）
- 同名内容不一致 → 还原后复检永远不过，"回到基线"永远做不到

`crosscheck-core.sh` 把前提验证掉（实测 **51 秒**）：

```
✓ 两件物证一致：49028 个文件的内容与集合都互相对得上
```

过程中踩到的两个坑（都写进注释了，因为它们是这类校验最容易误判的地方）：

1. **`tar` 的退出码不能单独当判据**：pnpm 布局里有 3669 个符号链接，给符号链接还原元数据
   在 macOS 上会 EBADF，bsdtar 于是让整条命令退出 1。实测对照：不加 `-o` → 1675 条
   metadata 警告 + exit 1；加 `-o` → exit 0。所以判据必须是"**有没有非元数据的错误行**"，
   而且要认识 bsdtar 末尾那句汇总 `Error exit delayed from previous errors.`（它只是在说"前面有警告"）。
2. **下面这条是真的 bug**：快照里的目录是**冻结的只读**目录，解出来的树 `rm -rf` 删不掉，
   残留下来会让下一次解压到处 `Can't unlink already-existing object: Permission denied`。
   同一条机制打在 `repair-core.sh` 上就是：**同一个文件第二次还原会因为只读副本而整条失败**。
   修法是解压前先解冻、先删掉上一轮的副本、并用 `-o` 解包。
   而 fixture 早先没模拟"快照是只读的"，所以这个 bug 在测试里根本冒不出来 —— 现在已经补上。

---

## 七、自动运行

`./install.sh` 装一个 LaunchAgent（`com.clawmaster.preflight`）：

- `RunAtLoad` —— 登录即跑一次
- `StartInterval 300` —— 每 5 分钟兜底巡检
- `WatchPaths` —— 盯 `boot.log`、`runtime/manifest.json`、`harness-versions/`、`profiles/web/package.json` 与 `cordis.patch.yml`，**一变就立刻跑**（实测 1–4 秒触发）

> **升级竞态说明**：app 升级后 provision 在 ~84 ms 内完成、~140 ms 后拉起 `dsh web`，任何外部任务都抢不过它。
> 所以那一次启动仍可能白屏 —— 消掉它的办法是**从 `open-clawmaster.sh` 启动**（先自愈再开 App），
> 或者等常驻医生/巡检自动修复后再重启一次。这是架构决定的，不是本工具没做好。

---

## 八、用法

```bash
cd ~/.dsh/watchdog-workspaces/im/dsh-runtime-freeze

./doctor.sh                     # 快速体检（秒级）
./doctor.sh --deep              # 追加全树哈希比对（权威）
./doctor.sh --full              # = --deep --scan
./doctor.sh --fix               # 发现 core 之外的问题就自愈
./doctor.sh --quick-repair-core # 秒级：只查可疑面并还原
./doctor.sh --deep --repair-core# 全树比对后还原
./doctor.sh --snapshot-check     # 只查恢复快照能不能用（秒级）

./repair-core.sh --dry-run      # 只看要动哪些文件
./repair-core.sh --quick        # 秒级可疑面检查
./resident-doctor.sh --verbose  # 手动跑一轮常驻医生
./resident-doctor.sh --deep-now # 无视间隔，立刻做一次全树核对

./preflight.mjs                 # 只读体检（A–G）
./heal.sh [--dry-run]           # core 之外自愈
CLAWMASTER_HEAL_NO_INSTALL=1 ./heal.sh   # 离线：不尝试装插件，直接降级

./fixture-test.sh               # 23 项断言
./resident-doctor-test.sh       # 10 项断言
./repair-core-test.sh           # 34 项断言
python3 lint-varexp.py *.sh     # 静态检查

./install.sh                    # 装 LaunchAgent
./install.sh --dry-run          # 只看会写什么
./install.sh --uninstall        # 卸载
```

状态与日志：`~/.dsh/logs/clawmaster-health.json`、`clawmaster-heal.log`、`clawmaster-doctor.log`。

---

## 八·五、运维手册（把它当产品用）

### 自动运行的到底是什么

| 谁 | 什么时候跑 | 干什么 | 跑多久 |
|---|---|---|---|
| `com.clawmaster.preflight`（LaunchAgent） | 登录时、每 300 秒、以及 `boot.log` / manifest / harness-versions / profile 一变就触发（实测 1–4 秒） | `resident-doctor.sh`：崩溃就修 + 到期做深度核对 | 健康轮 < 1 秒；深度核对轮 ~40 秒 |

它**不会**做的事（这是有意的，不是遗漏）：不会重启你手动关掉的 App；不会停用别人的服务；不会改 core 之外你手写的配置；不会在无网络时硬装插件。

### 例行巡检

| 频率 | 命令 | 代价 | 看什么 |
|---|---|---|---|
| 随时 | `./doctor.sh` | 秒级 | 结论是不是 PASS；第 4 节"常驻医生在岗" |
| 每周 | `./doctor.sh --deep --scan` | ~40 秒 | core 是否逐字节等于基线 |
| 每月 / 重建后 | `./doctor.sh --crosscheck` | ~50 秒 | 基线 × 快照两份物证是否互相对得上 |
| 改动过还原逻辑后 | `./drill-real-snapshot.sh` | ~5 秒 | **用真快照演习一遍还原**（不碰真 core） |
| 升级前 | `./doctor.sh --snapshot-check` | 秒级 | 万一升级搞坏了，还原的底子还在不在 |

### 退出码语义（写进脚本契约，可被监控直接吃）

| 命令 | 0 | 1 | 2 |
|---|---|---|---|
| `doctor.sh` | 无 FAIL（可能有 warn） | 至少一个 FAIL | 参数错误 |
| `preflight.mjs` | 无 blocker | 有 blocker | — |
| `repair-core.sh` | 已回到基线（或本就一致） | 仍有漂移 / 无法修复 | 参数错误 |
| `crosscheck-core.sh` | 两份物证一致 | 不一致 | 参数错误 |
| `resident-doctor.sh` | 本轮无待办且全绿 | 有修不好的东西（人工必须看见） | — |

### 信号 → 含义 → 动作

| 看到什么 | 含义 | 怎么做 |
|---|---|---|
| `整树只读（0 个可写条目）` ✓ | 加固在位 | 不用管 |
| `冻结之后被触碰过 N 个文件` ! | mtime 跳线，**不代表内容变了** | 看下一行的全树哈希结论再判断 |
| `全树有 N 行哈希差异` ✗ | core 真被改了 | `./doctor.sh --deep --repair-core`（会留证据在 `/tmp/core-repair-*/evidence`） |
| `恢复快照 CRC 校验失败` ✗ | **还原能力已经没了**，且没有自动解法 | 立刻重建快照（见下），别等出事 |
| `两份物证不一致` ✗ | 基线或快照有一个是错的 | **先别信任何一边**，人工核对后再重建两者 |
| `常驻医生似乎已经不在了` ✗ | 无人值守的保证已失效 | `launchctl kickstart -k gui/$UID/com.clawmaster.preflight`，再看日志 |
| `com.clawmaster.openviking 处于崩溃重启循环` ! | 有个服务每 30 秒失败一次（日志会灌满） | 要么修好它、要么 `launchctl bootout gui/$UID/com.clawmaster.openviking` 停掉；本工具**只报告不动手** |
| `core 之外有 N 项会阻断启动` ✗ | 下次启动会崩 | `./doctor.sh --fix` |

### 重建流程（顺序不能反）

```bash
# 1) 重建恢复快照（从**当前已验证干净**的树打）
cd "$HOME/Library/Application Support/DeepSeek Harness"
tar -czf harness-core-$(date +%Y%m%d).tar.gz harness-versions/<treeId>
# 2) 重建哈希基线
~/.../dsh-runtime-freeze/doctor.sh --build-manifest
# 3) 立刻交叉核对，确认两者说的是同一棵树（这一步别省）
~/.../dsh-runtime-freeze/doctor.sh --crosscheck
```

### 明确的外部依赖与边界

- **只读位挡不住同用户进程**：本机进程可自行 `chmod u+w` 再写。所以"固化"= **可检测 + 可还原**。
- **检测与还原保证的是"下一次启动干净"，管不住"已经在跑的进程"**：真要做到运行期不可变，
  需要进程级隔离（换用户跑 / 只读挂载），**这不是文件权限能解决的，也不该由本工具偷偷做**。
  当前那次注入的内存残留（`/tmp/cm-sched-diag.log` 仍在增长）就是这条边界的实证。
- **只在 macOS 本机有效**：LaunchAgent 是用户级；desktop 执行随 App 退出而停止。

---

## 九、开发中真被抓到的坑（留作警示）

1. **`$VAR` 紧邻中文**：bash 在 UTF-8 locale 下把多字节字符并入变量名，`set -u` 直接
   `f（: unbound variable` 终止脚本。**只在中文输出路径上触发**，在 `verify.sh`/`freeze.sh`/`heal.sh`/`install.sh` 各咬过一次。
   已固化为 `lint-varexp.py`，并接进测试场景 0。
2. **`set -o pipefail` + 故意非零退出的程序**：`preflight | jq -e` 的管道状态会被 preflight 的
   退出码 1 带偏，导致"已恢复"误判、整段降级被跳过。
3. **`2>/dev/null || true` 吞掉失败**：`chmod` 被拒绝时脚本谎报"已固化"。失败必须暴露。
4. **断言空转**：一个测试曾因 fixture 环境本身加载失败而"通过"。现在每次断言前先确认前提成立。
5. **"每轮从零重建"没做到**：`repair-core.sh` 早期用 `>>` 追加待还原清单，导致**上一轮已经修好的文件
   在下一轮仍被报成漂移**。收敛性断言（场景 6）正是为抓这个而写的。
6. **只放开文件写位不够**：core 的目录也是 `a-w`，往只读目录里补文件必须先临时放开父目录，
   而且**动完要按原样恢复**——想当然写成 755 就把加固拆了。场景 11 专门盯这条。
7. **测试残留污染下一轮**：被正确加固的 fixture 是"真只读"的，清理前必须先 `chmod -R u+w`，
   否则 `rm -rf` 失败、残留状态让下一轮出现假失败。
8. **路径必须两侧归一化**：基线里可能是 `./a.txt` 也可能写成 `a.txt`，不统一会出现
   "每个文件都算漂移"或"漂移被漏掉"。
9. **演习脚本自己会撒谎三次**（写 `drill-real-snapshot.sh` 时连环踩到，值得记下来）：
   ① 用了 `mapfile` —— macOS 自带 `/bin/bash` 是 3.2，没这个内建；
   ② 基线是 `find .` 产出的，路径带 `./` 前缀，不归一化就"挑不出样本"；
   ③ **校验文件里只写了哈希、没写路径** —— 于是拿哈希当文件名去比对，3 个文件全部
   "不一致"，而实际上修复完全成功（`repair-core.sh` 自己的复检是通过的）。
   第 ③ 条最典型：**测试脚手架出问题时，它会以"产品有问题"的样子出现**。
   最后是靠把 `want`/`got` 都打出来才看清。

---

## 十、真实事件：core 曾被当场改过（本工具的存在理由）

2026-09-19 记录到一次真实注入：

- `packages/core/agent-loop/lib/index.js`（同一个文件可通过 `apps/cli/node_modules/@deepseek-ai/dsh-agent-loop` 抵达）
  在 **13:51:31** 被改，加进了 `appendFileSync("/tmp/cm-sched-diag.log", …)` 调试代码；
  哈希 `dafafaff…`（71835 B）对基线 `257eb83c…`（71267 B）。
- 处置：从快照还原、重新冻结（`-r--r--r--`），被篡改的那份留存为
  `/tmp/agent-loop-index.js.tampered-20260919` 作为证据。
- **残留事实**：`/tmp/cm-sched-diag.log` 从 211 行涨到 229 行（最后一次写入 15:08:20），
  说明**当时正在运行的进程仍在执行那份被改过的代码**——文件被还原不等于内存里的模块被还原。

---

## 十一、已知边界（不含糊其辞）

- **只读位挡不住同用户进程**：本机进程可以自己 `chmod u+w` 再写。所以"固化"= **可检测 + 可还原**，
  不等于"不可能被改"。
- **检测与还原保证的是"下一次启动是干净的"，管不住"已经在跑的进程"**：要真正做到运行期不可变，
  需要进程级隔离（换用户跑 / 只读挂载），不是文件权限能做到的。
- **`--quick` 有已证明的盲区**：倒填 mtime + 改回只读的改动它看不见，必须靠周期性 `--deep` 兜底。
- **只在 macOS 本机有效**：LaunchAgent 是用户级；desktop 执行随 App 退出而停止。
- **回退路径**：`harness-core-*.tar.gz` 快照 + `HARNESS-CORE-README.md`（在 `Application Support/DeepSeek Harness/`）。
