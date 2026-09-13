# Cockpit 架构与运行边界

本文说明当前源码，不替代[产品要求](product-requirements.md)。
每个主题的维护位置见[文档索引](README.md)；已实际部署的版本只记录在
[部署记录](deployments.md)，不由这里推断所有安装实例的运行状态。

<a id="source-status"></a>
## 实现状态

Cockpit 是原生 Copilot 的薄远程接口，覆盖其部分能力，不是完整 CLI 替代品、
第二套 agent 平台或任务调度系统。Web、HTTP 与 MCP 共用同一产品契约。

旧业务模块宿主和自有增强已迁出；当前没有模块加载器，也没有预置官方角色/ID、
渠道网关或业务初始化。原生 `assistant` 消息、`task` 子代理工具、原生 MCP/skill
与这些同名业务概念无关，正常保留。[模块目录](module-catalog.md)说明迁出结果，
[基础协议](module-contract-draft.md)说明以后如何接回，不能当成现有 API。

<a id="target-gap"></a>
## 当前事实与已确认目标

2026-09-13 晚间的[产品决定](product-requirements.md#single-service-target)收紧了运行边界。
本文后续的 launcher/consumer 描述是**尚在源码和现行安装中存在的事实**，
不是继续把它们保留在本体的要求。本文只记录和分析，不执行迁移。

| 主题 | 当前事实 | 已确认目标 / 尚需实现 |
| --- | --- | --- |
| 包与启动 | Web/API 已能同进程 serve；运行包仍含 consumer 和交付校验文件，默认根启动命令是循环 wrapper。 | 一个前后端包和直接服务入口；不内置自更新/重拉或依赖部署控制器。 |
| 实际进程 | 已记录安装由外部 runner 控制，systemd 启动 launch，再启动一个 Cockpit Node 服务及 SDK 原生子进程。 | Cockpit 自身只运行服务入口；SDK/原生工具子进程不被误算成模块守护进程。 |
| 模块 | 只有停放原件，无加载器。 | 后端同进程 import、前后端同包、宿主统一 serve；随本体加载/关闭，无独立进程和自治生命周期。 |
| 模块更新 | 尚无可用的新协议安装/应用流程。 | 冷加载；变更显示待重启，当前实际版本不变，下一次本体启动生效；首版不热加载。 |
| MCP | `apps/mcp` 是 stdio API 客户端，宿主未提供逐模块 HTTP MCP 端点。 | 同端口不同 path 的独立工具/资源/prompt 和协议连接，不共享一个大工具表；不是安全沙箱。 |
| 关闭 | 原生 busy/在途保护已在 Engine；SIGTERM/SIGINT 和 `/admin/restart` 都进入等待空闲路径，仍带部署/consumer 分支和重启措辞。 | 本体仅提供 graceful 退出，不依赖模块主持，不判断业务目标，不保证重新拉起。 |
| 启动接续消息 | runner 的部署终态回调会给绑定 session 发 prompt；Engine 启动只发状态事件。 | 可选模块保存下一次启动消息和发送状态；本体/SDK/API 就绪后处理，未知不自动重发。 |

路径级迁出分析只维护在[模块目录的待迁出盘点](module-catalog.md#pending-extraction)；
新模块的冷加载、MCP 隔离和启动消息语义只维护在[模块协议](module-contract-draft.md)。

## 代码与进程

```text
浏览器 ── HTTPS / 外部认证网关 ──┐
                               ├─ Cockpit HTTP/SSE ── Engine ── 官方 SDK
MCP 客户端 ── 同一后端 API ─────┘                                  │
                                                         JSON-RPC / stdio
                                                                 │
                                                        原生 Copilot 进程
```

| 位置 | 当前责任 |
| --- | --- |
| [`packages/protocol`](../packages/protocol/src/index.ts) | Zod 输入/结果、typed intents、原生事件传输和共享浏览器折叠。`/capabilities` 从这里生成契约。 |
| [`packages/core`](../packages/core/src/engine.ts) | 拥有本宿主的真实 SDK handle、回调和在途操作；按需读取原生状态，执行原生适配与安全保护。 |
| [`runtime.ts`](../packages/core/src/runtime.ts) | 创建并关闭一个 SDK 管理的进程外运行时；固定 SDK 1.0.13 / runtime 1.0.83 / protocol 3。 |
| [`apps/server`](../apps/server/src/index.ts) | HTTP、控制 SSE、聊天流、静态 Web 和受保护的本进程生命周期。 |
| [`apps/web`](../apps/web/src/App.tsx) | 原生状态的当前展示窗口、普通文字输入、阅读位置与交互；不拥有执行权威。 |
| [`apps/mcp`](../apps/mcp/README.md) | stdio MCP 到 HTTP 的客户端；不读取本地 session 数据库，不另建聊天折叠。 |

服务端/core 以 TypeScript + `tsx` 运行，Web 和 MCP 有构建产物。
安装/发行包还必须包含匹配平台的原生依赖；“TS 无需转成 JS”不等于“无需构建、
依赖或运行环境”。宿主支持范围见[安装指南](DEPLOY-PORTABLE.md)。

<a id="authentication"></a>
## 认证边界

**Cockpit 没有内置账号、密码库或独立登录系统。** 两种认证不能混称“本体认证”：

| 边界 | 谁负责 | Cockpit 的实际行为 |
| --- | --- | --- |
| 远程访问 Web/API | 安装者配置的外部 HTTPS/认证网关；已记录部署使用 Passkey 网关。 | 后端只监听 `127.0.0.1`，信任该入口。源码启动本身不创建或安装网关。 |
| 使用 Copilot 服务 | 原生 Copilot 的登录/提供方配置。 | 默认复用运行账户的原生登录；不把网页 Passkey 变成 Copilot 凭据，不建立凭据副本。 |
| MCP 访问后端 | MCP 所在环境及其网关凭据。 | 可向兼容网关发送 Bearer；后端本身没有新增 Bearer 登录系统。详见 [MCP 配置](../apps/mcp/README.md#configuration)。 |

后端检查浏览器修改请求的 Origin/Referer，防止跨站请求；这是 **CSRF 保护，不是
身份认证**。不能把“监听 loopback”“来源检查通过”或“已列出 capability”
当成独立的用户权限校验。无认证的远程隧道不属于支持的部署方式。

产品使用 `permissionPolicy:"allow-all"`：原生工具自动批准。interactive、plan、
autopilot 是交互模式，不是权限开关。原生 ask/plan/elicitation 仍需要实际回答；
永久删除等产品操作仍有既有确认和 busy 保护。此应用是单操作者、服务账户信任模型，
不是多租户系统或恶意同用户代码沙箱。
确认位于哪一层取决于操作，不能把 Web/MCP 的交互确认写成所有 HTTP 接口强制校验；
当前区别见 [MCP 确认边界](../apps/mcp/README.md#confirmation-boundaries)。

<a id="launchers"></a>
## 启动器、重启与部署

**本节是当前尚未迁出的运行外围。** 外部 launcher 指在 Cockpit 应用进程之外运行，
不表示代码已移出本仓库。现行安装需要由外围进程完成重新启动；
新目标只要求本体退出，不保证该后半程一定发生。

| 入口 | 所在位置与职责 | 不做什么 |
| --- | --- | --- |
| 源码启动器 | [`scripts/start.mjs`](../scripts/start.mjs)，`pnpm start` 使用；启动后端、继承环境，并在子进程退出后重拉，连续快速退出则放弃。 | 不下载新版本，不选择 Release，不保证正在执行的回合跨进程延续。 |
| 消费者安装/更新器 | [`scripts/consumer/`](../scripts/consumer/cli.mjs)，安装后有独立稳定入口；签名下载、不可变版本、显式切换、健康身份与恢复。 | 不安装业务模块，不自动检查/更新，不自动崩溃重拉，不接管现有私有 CD。 |
| 私有交付控制器及 launcher | 外部独立安装的 service-delivery 工具；本仓保存固定集成/构建工具。控制器串行处理授权部署，launcher 在安全退出后启动已批准包。 | 不是开源消费者必须依赖的服务，不受原生会话或 Task 模块调度。 |

三种安装方式按各自的进程所有权工作，不能把不同 launcher 叠起来争抢同一个后端
或原生 home。完整前提分别见[源码安装](DEPLOY-PORTABLE.md)、
[消费者安装](consumer-installation.md)与[私有交付](DELIVERY.md)。

| 动作 | 实际含义 |
| --- | --- |
| 普通重启 | 安全退出后重新启动当前选择的版本；不会把 Git `main` 自动部署上去。 |
| 部署后重启 | 验证新产物，等待旧实例安全退出，再选择并启动新包，回读新 SHA/摘要/实例。 |
| 原生 session reload | 关闭/恢复一个空闲 session 的 handle；不是服务器重启或代码更新。 |
| Context Reset | 已停放的 self-only 上下文清理工具/skill 工作流；不是 reload、compaction、rewind 或删除。 |

本体保留 `/health`、`/version`、`/status`、`/admin/lifecycle`、
`/admin/restart` 和正常信号退出。这些是运维原语，不是已恢复的系统看板或重启模块，
也不因出现在 transport 清单中就获得额外授权。
源码/私有 CD 安装的 restart 请求与 consumer 的稳定 operation ID/IPC 契约不同；
操作入口必须使用对应安装文档，不能互换回执。

安全退出等待实际运行、队列/steering、用户决策、子任务、MCP 连接操作和本宿主在途调用；
空闲 handle 可以正常关闭，不是等待所有已保存会话消失。安全读取失败不能当成 idle。
被重启服务承载的发起回合必须结束，不能后台等待自己退出；受理不等于重启成功。

新目标不再让 Graceful Restart 模块主持关闭、版本选择或进程重拉。
graceful 退出留在本体，可选模块只提供下次启动消息/便利调用；详见
[目标协议](module-contract-draft.md#7-可选的下次启动消息模块)。
现行运维原语和启动链尚未被新目标替换。

### 当前启动后消息的实际来源

Engine 的 `start()` 启动 SDK 后发布 `agent/status`，server 随后开放 HTTP，
没有本体通用的“启动后给所有 session 发 prompt”逻辑。
现有消息来自外部 runner 的 [`notify()`](../.delivery/toolkit/bin/runner.mjs)：
部署请求达到终态后，找提交者绑定的 session，先持久化通知 attempted，
再调用普通 `/intent/prompt`，使用 `mode:"enqueue"`。
失败或 build-only 等终态也可通知，所以它不是“每次启动成功”的事件；
标记已尝试也不等于保证消息送达。

## 原生权威与本体保留状态

Copilot 唯一拥有持久会话、消息事件、模型上下文、执行与队列。Cockpit 不保留
后端聊天窗口、资源快照、原生开关副本、私库查询兜底或另一个投递队列。

| 本体保留项 | 必要用途和释放边界 |
| --- | --- |
| session ID、SDK handle、订阅、连接归属 | 定位本宿主实际连接；关闭后释放，未完成的断开不能伪报成功。 |
| 创建/加载/关闭、发送/取消/打断、配置操作的 Promise 和计数 | 原生状态不包含尚未完成的宿主调用；完成或明确结束后释放，不缓存结果。 |
| 发送回执、interaction/turn 身份及并发 gate | 关联早到事件和晚结果，避免旧回合清掉新回合；按对应在途操作/原生结束释放。 |
| ask/plan/elicitation 的真实 request ID 与回调 | 回答 SDK 当前等待的请求；答复、取消或结束后释放，不从历史伪造请求。 |
| 事件 revision、资源失效名称和当前读取保护 | 合并失效、隔离旧结果，不保存跨请求的原生值。 |
| HTTP/SSE 连接与有限待写帧 | 当前传输和背压，结束即释放；不是可回放聊天缓存。 |
| 浏览器当前展示窗口、原生 cursor、文字草稿和交互状态 | 供当前用户阅读/编辑，不取代后端原生权威。 |

没有周期性后台全量会话/资源同步，也没有旧的八秒 inventory/attach 轮询。
元数据请求和实际操作按需读取。SSE 传输心跳不是原生状态同步。

### 元数据与模型

`session/list` 读取身份、当前模型和控制状态，不预读完整模型选项、todos 或 schedules。
snapshot/SSE 增加模式和侧栏定时数量；完整详情用 `session/get`。
`session/resources` 按声明字段读依赖，`session/panel` 只读一个原生面板。
读取结果在请求结束后释放；资源事件只通知失效，不能填充后端镜像。

字段未请求不等于清空；`loaded:false` 不能夹带缓存的运行态，`meta:null` 才是原生对象
未知。缺少 cwd 明确未知，不退回 home。列表活动时间来自原生持久索引；
Web 实时 patch 的宿主接收时间另标来源，不伪称原生持久时间。
精确 busy 仍可能需要原生完整 `queue.pendingItems`，不能以响应省略队列正文宣称省掉了该 RPC。

模型选项以当前原生 session 的候选集合为准；缺失能力可在同一次请求中按同模型 ID
从原生全局目录补充，但不能覆盖显式空 effort、false 或受限 context tiers。
同模型只改一个选项时，从原生即时读取保留另一个；排队变更保持原生 FIFO，
未生效不乐观改写。未知档位仍未知，不硬编码模型名单；长 context 不关闭原生 compaction。

### 原生生命周期与配置

`session/new(cwd)` 返回真实 ID，不发送消息；再显式 `prompt`。
空且未持久化的原生会话可能在卸载后消失，不预留虚拟身份、不自动重建。
history 读取不恢复 session；需要 loaded handle 的详情显式返回 `SESSION_UNLOADED`。

原生 idle timeout 配置为 30 分钟。这不是永远保活承诺：原生未来 schedules 不阻止
卸载，卸载期间暂停，相对延时恢复时重新起算；Cockpit 不按旧偏好自动恢复它们。
原生后台工作和进程故障有各自的语义，不能承诺所有工作都跨崩溃续跑。
确认 SDK 子进程死亡时，本体报告失败并退出给外围恢复，不重发可能已受理的输入。

MCP/skill 选择归原生配置。冷恢复及 native MCP reload 按原生全局默认重新发现，
不读取 Cockpit 原生开关副本；全局定义刷新不自动改写所有已加载 session。
SDK 1.0.13 对全局 disabled-skill 列表的缺口，由适配层读取原生用户设置并传入
create/resume，不另存一份设置。技能正文重读与旧模型上下文不会被混为一谈。

## Web 与聊天

原生消息、工具、思考、子代理、决策和队列仍可展示。会话列表按原生活动排序，
没有置顶分组。全局菜单只有原生 MCP/Skills；会话菜单有七个详情页及 fork/永久删除。
“运行维护”指单个原生会话的生命周期页，不是已迁出的系统部署看板。

普通文字 Composer 保留草稿版本、同会话身份和 ACK 保护。文件/语音按钮、富附件
状态及文件卡片不再内置；旧草稿和文件数据的采用边界由[模块目录](module-catalog.md)
统一说明。手动命名走原生 API，首回复额外命名策略不运行。

全局 `/events` 用于元数据/决策/失效，`/chat/stream` 用于当前共享 all-agent 阅读窗口。
展开子代理不另读全历史，重连沿原生 cursor 补齐；普通 Markdown/文本展示不是文件服务。
精确分页、完整消息、缺失临时 delta、compaction 和媒体行为以[原生聊天](native-chat.md)
为唯一详细说明；MCP 的较小输出窗口及 JSON 分片以 [MCP 文档](../apps/mcp/README.md)
为准。会话 fork 的特殊前检与继承见[原生 fork](session-fork.md)。

## 明确不承诺

本体不提供托管文件上传下载、原生工具图片查找、通知收件箱、语音识别、自动命名、
可运行模块系统或自有 self-clear 工具。SDK 原生附件的参数传递不等于所有媒体格式都已
被模型读取；原生普通文件工具不受“文件模块缺席”这一 UI 边界替代。

当前调度创建只支持原生简单 after/every 或区间内单次绝对时间；不会用隐藏模型消息
猜测 cron。结构化/URL elicitation 不被包装成一个尚未实现的通用表单系统。
临时流片段逐 token 恢复、跨崩溃无损续跑、任意宿主零前提更新均不属于能力承诺。
