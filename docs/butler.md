# 管家系统 (Butler) 设计文档 — 讨论稿

> 历史设计，已退出 Cockpit foundation。下文描述的进程内 Hook / Flow / Gate
> 和治理部署流程不是当前底座接口或安装要求。治理应作为独立上层应用，
> 通过 Cockpit API / MCP 使用 session、消息和文件能力；底座不自动安装或恢复它。
> 本文仅保留设计背景，不代表已提供替代治理服务。

状态：DECISIONS LOCKED（2026-06-20，5 项决策 + R1 防环已逐项确认，见末尾决策记录）。
下一步 → 提升到 `~/cockpit/docs/butler.md` 并据此写开发者 spec（dev-spec todo）。
日期：2026-06-20。作者：Cockpit 管理员 session (96c3db7a)。

---

## 0. 一句话

给 cockpit 增加**第三种驱动力**——「对生态自身的事件做出反应」——并让一个常驻 agent（管家）
基于它，在合适的时机自动接管 session 的仪容（命名、配装）与治理（提议清理）。

机制（mechanism）是通用的、机械的、便宜的；智能（intelligence）全部在 agent 那一层。
**cockpit 永远不需要变聪明，它只需要把事件准确地送到一个会思考的 agent 面前。**

---

## 1. 动机：cockpit 缺的第三种驱动力

今天 cockpit 里「任何事情发生」只有两条路径：

1. **人的 intent** — 用户输入/点击 → `POST /intent/*` → engine 执行。（reactive to human）
2. **时间 schedule** — SDK 的 `ScheduleRegistry` 在某时间/间隔/cron 触发一个 prompt。（reactive to clock）

就这两条。cockpit 对「人」和「时钟」有反应，但对**它自己**没有反应——
对自己 session 群里正在发生的事一无所知、无法行动：

- 一个新 session 刚出现 → 没人给它起名、配 skill/MCP。
- 一个 session 刚跑完第一轮 → 没人借此判断它在干嘛、迎新。
- 一个 session 一直在报错 / 空转 / 被丢进垃圾桶 → 没人注意、没人处理。

这些都要靠人手动，或靠一个**每小时轮询**的外部脚本（现在的 skill-pipeline driver 就是轮询）。
轮询 = 高延迟 + 浪费 + 漏。

**智能机制 = 给 cockpit 第三条路径：reactive to ecosystem events，且用 agent 的判断来响应。**

---

## 2. 智能机制：事件钩子 (Event-Hook) — Schedule 的兄弟

### 2.1 核心类比

钩子之于事件，正如 schedule 之于时间。两者是同构的兄弟：

| 维度 | Schedule（已有） | Hook（新增） |
|---|---|---|
| 触发源 | 时间（at / interval / cron） | 事件（session.created / first-turn-complete / idle / error / trashed …） |
| 触发动作 | 向**自己** session 投递一个 prompt | 向**owner**（管家）session 投递一个 prompt（携带事件上下文） |
| 订阅范围 | 单 session 对自己 | 跨 session：一个 session 订阅**整个 fleet** 的事件 |
| 归属 | SDK 构造 `sdk.scheduleRegistry` | **cockpit 原生**（engine 内 HookRegistry，SDK 没有对应物） |
| 持久化 | `session.schedule_created` 事件，reload 重水化 | cockpit-prefs.json 或同类事件，reload 重水化 |
| 可见性 | sidebar 时钟徽章 + info-panel ScheduleSection | sidebar 钩子徽章 + info-panel HookSection |
| MCP 工具 | schedule_add / list / stop | hook_add / list / stop |

一个 Hook 说的是：**「当事件 E 发生（可能在别的 session），就把 prompt P 投进管家 session」。**

### 2.2 两层结构：机械触发 + 智能响应（observer ≠ actor）

这是整个设计最关键、也最省事的地方：

- **Layer 1 — 机制 / 管道（cockpit 做）**：事件 → 匹配钩子 → 投递 prompt。
  确定性、便宜、无 LLM，和 ScheduleRegistry 一样朴素。这是开发者要写的代码。
- **Layer 2 — 智能 / 判断（agent 做）**：钩子把 prompt 投进一个 agent session，
  agent 带着完整推理 + skills + tools 决定**做什么**。触发是机械的，响应是智能的。

cockpit 不内置任何业务逻辑（「什么名字好」「该配哪个 MCP」「该不该清理」全不在 cockpit 里）。
这与你整套生态的哲学完全一致——**observer ≠ actor、markerless、不靠纪律靠独立观察者**：
不要把判断硬编码进基础设施，让一个独立的 agent 观察并裁决。

### 2.3 事件目录（event catalog）

**v1 只发一个事件**；其余是已规划的扩展枚举（不在 v1）：

| 事件 | 触发时机 | 谁会用 | 状态 |
|---|---|---|---|
| `session.first-turn-complete` | session 首次 running→idle + ≥1 轮真实对话（正常完成，非 cancel，非 worker 源） | 管家：迎新（命名 + 配装） | **v1 唯一** |
| `session.created` | 新 session 建出（cold） | — | **砍**：创建瞬间无信号；skill/MCP 基线本就是 cockpit 默认行为，无需 hook |
| `session.idle`（裸） | 任意一轮 running→idle | 流水线 driver | **缓**：歧义（阶段 vs 真结束）；以后用「静默 N 分钟」去抖事件代替 |
| `session.error` / `session.trashed` | 出错 / 入垃圾桶 | 监控 / salvage | later |

`first-turn-complete` 是 idle 的「**首次 + 有内容**」特例——只触发一次、就在第一份信号出现时，
绕开「阶段 vs 最终」的歧义（它是「首」不是「末」）。SDK 已在 `engine.ts:446` 内部发 idle，
v1 在那里加「首次 + 有内容 + 非 worker（R1）」判定后 re-emit 到可订阅总线。

### 2.4 Hook 数据结构

```
HookEntry {
  id:            string            // 钩子 id（用于 stop）
  ownerSession:  string            // 接收 prompt 的 session（= 管家）
  event:         EventType         // 订阅哪个事件
  filter?:       { cwdPrefix?, excludeSelf?, sessionId? }  // 可选过滤
  promptTemplate: string           // 投递的 prompt，可插值事件上下文
  once?:         boolean           // 同一来源是否只触发一次（迎新 = 是）
  createdAt:     number
}
```

投递时把事件 payload 注入 prompt，例如：
`"管家迎新：session {event.sessionId}（cwd={event.cwd}）刚完成首轮。读它实际在做什么，起一个清晰短名，并配装合适的 MCP。"`
——管家拿到的不是空 ping，而是带着「对哪个 session 做什么」的完整上下文。

### 2.5 跨 session 订阅模型（最本质的一点）

- **Schedule 是「自反」的**：一个 session 给**自己**排 prompt。
- **Hook 是「跨会话」的**：管家订阅**别人**的事件，投递到**自己**。

所以 HookRegistry 是 **engine 级全局**的（不是 per-session）。engine 本来就看得见所有 session 的
生命周期跃迁（它自己的总线 `engine.onEvent` 已经在发 `session/added|removed|patch`），
是放钩子分发的天然位置。一句话：**一个 session 对整个 fleet 作出反应。**

### 2.6 持久化 + 重水化 + 自愈（按已定的架构 B）

- 触发器（schedule + hook）和 Flow 定义都不绑某个 session，归 **cockpit-server 进程级的常驻
  TriggerRegistry / FlowRegistry**。cockpit-server 是 systemd `Restart=always` 单元，本就永远在线。
- 重水化：server 启动时从磁盘加载所有 flows（`~/.copilot/flows/*.json`）+ 触发器并 arm。
  graceful self-restart（idle-exit + systemd 拉起）后自动重 arm。**不依赖任何 session 被 pin/loaded。**
- pin（P0）/ 开机重载 pinned（P1）因此**退居可选**——只给「owner 想保持温热的 session」用，
  不再是流水线存活的承重件。B 的最大红利：消灭了「session 被 evict 导致 silent-stall」这一最脏失败模式。
- 自愈/补漏：停机窗口内错过的事件，靠周期 schedule 触发的「巡视 Flow」补扫兜底。
  事件 hook 负责低延迟，定时 schedule 负责不漏——两者都挂在同一个常驻 registry 上。

### 2.7 可见性（= 看门狗）

你一贯看重「可见即存活」：

- sidebar：管家 session 上一个钩子徽章（类比 `.dialog-schedule` 时钟徽章）。
- info-panel：一个 `HookSection`，列出订阅了哪些事件、过滤条件、prompt 模板。
- 钩子触发时，prompt 出现在管家 chat 里 → 每次迎新都肉眼可见。

`SessionMeta` 加一个 `hookCount`（和 `scheduleCount` 同款，加字段即可 patch，见 cockpit gotcha）。

### 2.8 防环 / 幂等

worker 会再发事件、管家动作（改名→`renamed`）也会发事件，必须防无限环：

- **R1（核心防环，owner 2026-06-20）**：Flow spawn 出的 session 一律打 `spawnedBy=flowId` 标记，
  **作为「非触发源」——它的任何生命周期事件都不 fire 任何 flow**。只有真实（人建的）session 是触发源。
  根除「迎新 worker 跑完 → 又触发迎新 → spawn 下一个 worker」的 **fork 炸弹**。
  同一个 `spawnedBy` 标记还用于 UI 折叠 worker——**一标双用**。需要 flow→flow 衔接时走显式链，不走通用事件层。
- `first-turn-complete` 用 `once`：每个来源 session 只迎新一次（per-session「已迎新」位）。
- 钩子默认 `excludeSelf` + 过滤管家动作导致的事件（renamed/patch 不回灌迎新）。

### 2.9 为什么它「通用」——不止管家

同一个机制，换个 {event, prompt, owner} 就是另一个自治能力：

- **管家**：hook `created` → 配装；hook `first-turn-complete` → 迎新（命名+配装）。
- **skill-pipeline driver**：hook `idle` → 扫刚结束的 session（P2，把每小时轮询升级为事件驱动）。
- **监控 agent**：hook `error` → 分诊/告警。
- **salvage 守卫**：hook `trashed` → purge 前冷扫描。
- **fleet 编排**：hook 某 worker 的 `idle` → 派发下一个任务。

→ 这不是一个「管家功能」，是一个**让任意 agent 对生态事件作出反应的底座**。管家只是第一个、旗舰应用。

---

## 2.10 升级：触发的产物是一个 Flow（流程），不是一条 prompt

（核心洞见，owner 2026-06-20）

到这为止，schedule 和 hook 触发的都是「向某 session 投一条 prompt」。再抽象一层：
**让触发器指向一个可复用的「Flow（流程）」，而不是一条裸 prompt。** 三层解耦：

```
TRIGGER（何时）      →    FLOW（做什么，可复用）            →    ACTION（产出）
- schedule（时间）        ┌ 可选 gate 脚本（便宜·无 LLM）       ├ skip（gate 说不用跑）
- hook（事件）            └ action 模板                          ├ prompt → 已有 session（旧行为）
                                                                └ spawn → 一个出生即配好的新 session
```

**Flow = { 可选 gate 脚本, action }**

- **gate（可选 — 判断是否启用 agent）**：一个便宜、确定性、**不跑 LLM** 的脚本，先跑，
  决定「这次到底要不要花一个 agent」。go → 继续；skip → 流程便宜地结束。
  这正是现有 skill-pipeline driver 里 `decide.py` 的角色（读 cursor/backlog/severity 返回 skip/FAST/FULL）。
  gate 还能**输出参数**（stdout JSON）插值进下游 prompt（decide.py 输出 FAST/FULL → 选不同 prompt 变体）。
  **这层是成本闸门**：贵的 agent 只在 gate 放行时才启动。

- **action**
  - `prompt-existing { sessionId, prompt }` — 向已有 session 投 prompt（= 今天的行为）。
  - `spawn-session { template }` — **启动一个全新、出生即配置好的 session**：
    `SessionTemplate { cwd, prompt, skills:[...], mcps:[...], model?, mode?, ephemeral? }`
    cockpit 按模板：`new(cwd)` → 套 skill 集 → 套 mcp 集 → 设 model/mode → 投 prompt → 跑。
    `ephemeral=true` 的跑完自动进垃圾桶（一次性 worker，不留 session 垃圾）。

**为什么这是对的架构**

1. **fresh per run**：每次触发起一个干净 context 的新 session，无累积、无需 compact、可复现。
   这正是现有 driver 用 `copilot -p` 一次性进程的做法——现在变成 cockpit 原生能力。
2. **gate 是成本闸门**：cheap 脚本先筛，贵的 agent 只在该跑时才跑。decide.py 的通用化。
3. **Flow 可复用**：配一次，多种触发——schedule 管周期、hook 管事件，**同一个 Flow**。
4. **出生即就绪**：spawn 出来的 session 全配好，「运行即可」。管家的「创建策略（skills 全开 / MCP 按需）」
   天然就是一个 Flow 模板。

**它统一了现有散落的四样东西**

| 现状（散落） | 在 Flow 模型里 |
|---|---|
| schedule 投 prompt | `Flow{ 无 gate, action=prompt-existing }` |
| 外部 skill-pipeline driver（systemd + decide.py + `copilot -p`） | `Flow{ gate=decide.py, action=spawn-session }`，触发器换成 cockpit schedule/hook |
| 持久 Builder session 收 dispatch | `Flow{ gate, action=spawn 一次性 builder-worker, ephemeral }` |
| 管家迎新 | `Flow{ gate=值不值得迎新, action=spawn 一次性 butler-worker 或 prompt 常驻管家 }` |

→ 外部那套「便宜 gate → 有条件起一个配置好的一次性 agent」的模式被收进 cockpit 成一等原语，
且不再只能被 timer 触发，schedule **或** hook 都能触发它。

**对 §2.4 HookEntry 的修订**：`promptTemplate` 字段 → 改为 `flowId`（指向一个 Flow）。
schedule 同理获得可选 `flowId`（不填则维持「投裸 prompt」旧行为，向后兼容）。

**几乎不需要新原语**：spawn 的每一步（new / skill-toggle / mcp-toggle / set-model / prompt）
cockpit **都已有 intent**。新东西只有 **FlowRegistry（存流程定义）+ FlowRunner（编排 gate→spawn→prompt）**，
外加触发器指向 flowId。gate 脚本是 owner 本地可信脚本（非第三方），cockpit 以子进程跑它（与既有 decide.py 同信任级）。

---

## 3. 管家：第一个应用

### 3.1 身份：管家 = 一组 Flow，不是一个常驻 agent（按架构 B）

管家不再是「一个一直开着的 daemon session」，而是**挂在常驻 TriggerRegistry 上的一组 Flow**：

- **welcome-flow**：hook `first-turn-complete` 触发 → gate（值不值得迎新）→ spawn 一次性 butler-worker，
  去给那个新 session 命名 + 配装，跑完即焚。
- **patrol-flow**：schedule（每 N 小时）触发 → gate（有无乱名/可治理项）→ spawn 一次性 worker 出治理清单。
- **creation-flow**：hook `session.created` 触发 → 全开 skills、默认关 MCP。

好处：没有要保活的常驻管家进程（B 的核心），每次迎新/巡视都是干净 context、可并发、可复现。
**现有的持久 daemon `eaaa6fe2` 与 Builder `c5b4a6cc` 也随之收编为 Flow**（gate=decide.py + spawn 一次性 worker），
长驻 session 数量降到「只剩 owner 想温热的那几个」。管家的「方法」（命名/配装/治理）沉淀进 skill，
被 worker 的 prompt 引用——人格在 Flow 模板 + skill 里，不在某个长命 session 里。

### 3.2 三个触发时机

| 时机 | 触发方式 | 现在能不能做 |
|---|---|---|
| 迎新 | `session.first-turn-complete` 钩子（**本设计核心新增**） | 需要事件机制 |
| 巡视 | 常驻 schedule（定时） | 机制落地后；逻辑今天可演练 |
| 召唤 | 人直接 `cockpit_send_prompt` 触发 Flow / 让管家做某事 | **现在就能做** |

创建时机已砍：cockpit 默认即处理新 session 的 skill/MCP 基线，无需 hook。

### 3.3 职责分级（autonomy ladder）

- **仪容类（reversible, 🟢 green-tier, 自动）** = 命名 + 配装（skill/MCP 开关）。可逆、留痕，自动做。
- **治理类（deletion, 🔴 never auto）** = 只**提议**清理候选（测试/重复/废弃 session），永不自动删活的 session。
  （垃圾桶里已被 owner 丢弃的，按既有放宽红线：salvage 冷扫描后可自动 purge——那是另一条线，归 distillation。）

被砍掉的：model/mode 适配（你说不需要）。被推迟的：头像（cockpit 无自定义头像字段，monogram 是 cwd 派生）。

### 3.4 方法（管家干活的具体手法）

- **命名**：不抄首句。读 session 的 cwd + 实际在做什么（前几轮），提炼「领域·任务」式短名，
  `cockpit_rename_session`。例：`cockpit·SSE 推送机制`、`evo 项目调研对比`。
- **配装**：复用 `session-outfitter` 的判断——按 session 实际角色，**匹配合适的 skill（剪掉不相关的，不再全开）
  和合适的 MCP（按它真的在用的能力开）**。skill 与 MCP 一视同仁，都做精准匹配。全自动、不刻意通报。
- **治理清单**：识别测试/重复/废弃/空壳 session，**列清单给 owner**，绝不自动删。

### 3.5 配装策略：skill 与 MCP 都精准匹配（不再全开 skill）

- **反转自之前的「skills 全开」**（owner 2026-06-20）：skill 也要控制——迎新时按 session 实际角色
  **匹配合适的 skill（剪掉不相关的）**，与 MCP 一视同仁。理由：全开会让无关 skill 描述稀释注意力 / 误触发。
- **创建瞬间**无信号，仍走 cockpit 默认基线（可后续考虑改成最小基集而非全开）；真正的匹配发生在
  **首轮完成后**的迎新——那时才有内容判断该配哪些 skill/MCP。这就是迎新钩子存在的核心理由。

---

## 4. cockpit 开发工作量（给开发者 session）

### 已完成（不用再做）
- **P0 — session pin**：`cockpit-prefs.json` pinned 标记 + 两条 eviction 路径豁免。✅
- **P1 — 开机重载 pinned**：`loadPinnedSessions()` 启动重水化 schedule。✅

### 待建 — P2++：事件钩子 + Flow 机制（本设计的新增部分）

**架构 B（已定）**：触发层做成 **cockpit-server 进程级、常驻、不绑 session** 的 `TriggerRegistry`
（schedule + hook 都挂这）。它在 always-on 的 cockpit-server 里运行，开机加载 flows 并 arm，
不依赖任何 session 被 pin/loaded。这是一个**新增的、server 级**的调度/事件引擎，
与 SDK 的 per-session `ScheduleRegistry`（用于「session 给自己排 prompt」）**并存**——
Flow 触发走新的 native registry，旧的自反 schedule 维持不动（加性改动，非替换）。

分层改动（沿用 cockpit 的标准 recipe：protocol → engine → server → mcp → web）：

1. **protocol** (`packages/protocol/src/index.ts`)
   - `HookEntry` zod schema；`hook/add|list|stop` intents；`SessionMeta` 加 `hookCount`。
   - 事件枚举 `SessionEventType`。
2. **engine** (`packages/core/src/engine.ts`)
   - 新建 `HookRegistry`（engine 级全局，跨 session）。
   - 在生命周期跃迁点 **re-emit** 规范事件到可订阅总线：
     - `session.created`（`session/new` 路径）
     - `session.first-turn-complete`（在 `session.idle` 处理 `:446` 加「首次 + 有内容」判定 + per-session once 位）
     - `session.idle`（re-emit 已有的内部 idle）
   - 事件匹配钩子 → 用既有「向 session enqueue prompt」路径投递（带上下文插值）。
   - 防环过滤（excludeSelf / 动作导致的事件）。
   - 持久化（prefs）+ reload 重水化（管家 reload 时 re-arm 钩子）。
3. **server** (`apps/server/src/index.ts`)：dispatch 接 `hook/add|list|stop`。
4. **mcp** (`apps/mcp/src/tools/`)：`cockpit_hook_add|list|stop`（schedule 工具的兄弟，放新组文件）。
5. **web** (`apps/web`)：sidebar 钩子徽章 + info-panel `HookSection`（纯投影，读 `hook/list`，
   随 `hookCount` 变化重取——和 ScheduleSection 同款，无前端缓存）。

6. **Flow 层**（trigger 与 action 之间的新一层，§2.10）：
   - `FlowRegistry`：加载/存储 Flow 定义（`~/.copilot/flows/*.json`），定义 = `{ gate?, action }`。
   - `FlowRunner`：编排一次触发 = 跑 gate 子进程 →（go 则）按 action 执行：
     `spawn-session` 走 `new → skill/mcp-toggle → set-model → prompt`（**全是已有 intent**，只是编排）；
     `prompt-existing` = 旧行为。`ephemeral` 完成后 `session/delete`（trash）。
   - 触发器（schedule entry / hook entry）增加可选 `flowId`；缺省维持「投裸 prompt」向后兼容。
   - 新增 intents `flow/list|run`（+ MCP `cockpit_flow_list|run`），便于人手动触发/调试一个 Flow。

红线提醒（给开发者）：~/cockpit 现已是 git 仓库 → 每步提交留痕；secret 不入代码；
开发者自查 schedule 触发时**不要重连本 session 的 cockpit MCP**（会断开它自己）。
fold 不动则不必跑 fold 测试；动了 intent/engine 要跑 `pnpm build` + e2e。

---

## 5. 待讨论的设计决策（forks）

这些是想和你拍板的点：

- **F1 事件起步集**：先只做 `session.created` + `first-turn-complete`（管家够用），
  还是顺带把 `session.idle` 也做了（让 skill-pipeline driver 从轮询升级为事件驱动，一举两得）？
  → 我倾向**一起做 idle**：边际成本极小，且立刻消灭现有轮询延迟。
- **F2 「首轮完成」判定**：running→idle 首次 + 有 ≥1 轮真实 user+assistant 对话。
  cold/空壳（0 轮）不触发迎新。同意吗？
- **F3 命名是否要 owner 确认**：仪容类我定为 🟢 自动（可逆）。迎新自动改名 + 自动配 MCP，
  事后进 digest 通报，**不打断你**。还是你想要「改名自动、配 MCP 先攒着等你点一下」？
  → 我倾向**全自动 + digest 通报**（符合你「异步通知优先于打断式确认」的标准偏好）。
- **F4 机制归属**：HookRegistry 做成 **cockpit 原生**（engine 内）。
  对比：schedule 是 SDK 的。我认为 hook 必须 cockpit 原生（SDK 没有、且跨 session 是 cockpit 的域）。确认。
- **F5 委派方式**：这套机制是 cockpit 开发活 → 交给开发者 session `dfd7c71e` 实现。
  你要先把这份 doc 定稿，我再整理成开发者能直接开工的 spec 交过去。

### Flow 层引出的新决策

- **F6 Flow 定义存哪**：`~/.copilot/flows/*.json`（git 可追踪、可手写、脚本路径自然）
  还是塞进 `cockpit-prefs.json`？→ 倾向 **flows/ 目录**（可追踪 + 留痕）。
- **F7 ephemeral 清理**：一次性 worker 跑完，自动 **trash**（可逆 + 仍可 salvage 冷扫描，由 distillation 兜底清）
  还是直接 **purge**？→ 倾向 **trash**。
- **F8 gate 契约**：输入 = 触发/事件上下文（env 或 stdin JSON）；输出 = `exit 0=go / 非0=skip`，
  stdout JSON = 给下游 prompt 的参数。确认这个契约。
- **F9 管家迎新用哪种 action**：**spawn 一次性 butler-worker**（干净 context、可并发多个迎新、跑完即焚）
  还是 **prompt 常驻管家**（省 spawn，但串行 + context 累积要 compact）？→ 倾向 **spawn 一次性 worker**。
  （注意：迎新的 action 是 spawn 一个 worker 去**操作那个新 session**，worker 自己是临时的。）
- **F10 gate 安全面**：cockpit 以子进程跑 owner 脚本。仅限**本地 owner 自有脚本**（与 decide.py 同信任级），
  绝不跑第三方/下载脚本。flows/ 目录纳入 git 留痕。确认这条红线。

---

## 6. 落地顺序（建议）

1. **今天**（不依赖事件机制）：管家做一次巡视——改乱名 + 出治理清单（已准备好，等你放行）。
2. **doc 定稿**（本文件，讨论后）→ 提升到 `~/cockpit/docs/butler.md`。
3. **委派事件机制**给开发者 session（P2++：HookRegistry + 事件 + MCP 工具 + UI 徽章）。
4. **机制落地后**：给 daemon 叠加管家人格 + 注册 `created`/`first-turn-complete`/(`idle`) 钩子。
5. **沉淀**：把「session 治家方法」（命名/配装/治理）写进 distillation/heartbeat 或新 skill。

---

## 附：和现有资产的关系

- **复用** P0/P1（pin + 开机重载）——地基已成。
- **复用** `session-outfitter`（配装判断）、`session-distillation`（skill/MCP 沉淀）、
  `cockpit-daemon`（常驻自治方法论）、`cockpit-scheduling`（定时，hook 的兄弟）。
- **新增** 唯一的真·基础设施 = 事件钩子机制（cockpit 代码）。
- **退役** 旧 `cockpit-dev-hook-spec.md` 的 P2（被本设计的事件钩子取代并大幅扩展）；P0/P1 已落地。

---

## 决策记录 (Decisions log)

### 已锁定
- **架构 B（2026-06-20）**：触发层（schedule + hook）搬出单个 session，做成 **cockpit-server 进程级、
  常驻、永远在线**的 TriggerRegistry。**不需要任何常驻 host agent session**；pin（P0/P1）退居可选，
  不再是流水线承重件。触发 → Flow → 起一次性 worker。终态：cockpit = 「事件/定时 → 流程 → 一次性 agent」编排底座。
- **触发的产物是 Flow（§2.10）**，不是裸 prompt；Flow = 可选 gate 脚本 + action（prompt-existing | spawn-session）。
- **Flow 统一收编**外部 skill-pipeline driver、持久 Builder、管家——都变成 Flow（gate + spawn ephemeral worker）。

### 已确认（2026-06-20，逐项 locked）
- **dec-retire-longlived**：daemon(eaaa6fe2)+Builder(c5b4a6cc) 都退役、收编为 Flow（spawn 一次性 worker）。切换在 core 建好+验证后。
- **F1 dec-scope-idle**：v1 事件集 = **仅 `first-turn-complete`**。砍 `created`（无信号）；缓裸 `idle`（歧义）→ 以后用「静默 N 分钟」去抖事件。
- **F2**：first-turn-complete = 首次 running→idle + ≥1 轮真实 user+assistant + 正常完成（非 cancel）+ 非 worker 源（R1）；once-per-source。
- **F3 dec-welcome-autonomy**：迎新**全自动**（改名 + 配装），**不刻意通报**（改名/配装本身可见）。
- **配装策略反转**：skill 不再全开，**skill 与 MCP 都按角色精准匹配**（剪掉不相关 skill）。
- **F7 dec-ephemeral-cleanup**：worker 跑完**保留 + 折叠，不自动删**（owner 重保留/可观测）。tag=`spawnedBy`。
  连带：每个真实 session 都生一个 worker → 列表翻倍 → **UI 折叠 worker 升为 v1 承重项**。
- **R1 防环（owner 提出）**：`spawnedBy` worker = 非触发源，其事件不 fire 任何 flow。根除 fork 炸弹；一标双用（防环 + 折叠）。
- **F10 dec-gate-security**：gate 脚本仅本地 owner 自有、入 git、绝不第三方/下载。
- **F6**：Flow 存 `~/.copilot/flows/*.json`。　**F8**：gate 契约 = 输入(env/stdin JSON)→输出(exit 0=go/非0=skip, stdout JSON=参数)。
- **F9**：迎新 = spawn 一次性 worker 去操作那个新 session（非常驻管家）。
- **schedule 引擎**：新增 server 级 native 触发引擎，与 SDK per-session ScheduleRegistry **并存**（加性，非替换）。
