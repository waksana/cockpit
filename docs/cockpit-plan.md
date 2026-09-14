# Cockpit 架构与运行边界

本文描述当前源码，要求以 [R1–R8](product-requirements.md) 为准。
各主题的唯一维护位置见[文档索引](README.md)。
运行实例的身份以 `/version`、`/health` 和对应包为准。

<a id="source-status"></a>
## 当前实现

Cockpit 是一个直接启动的 Web/API 服务，通过官方 SDK 控制原生 Copilot。
前端静态资源与 API 由同一服务提供，默认开启 Web；明确的 API-only 模式可以关闭 Web。

当前没有新模块加载器、逐模块 HTTP MCP 端点或启动接续消息模块。
这些仍按[模块协议](module-contract-draft.md)另行实现。
原生 `assistant` 消息、`task` 子代理、MCP/skill 和定时提示由 SDK 提供。

<a id="target-gap"></a>
## 当前实现与目标差距

| 能力 | 当前实现 | 已确认目标 |
| --- | --- | --- |
| 前后端运行包 | 包含服务、Web 与必要依赖；Node 由宿主提供。 | 按[普通产包契约](packaging.md)维护。 |
| 关闭 | `system/shutdown` 等待原生活动和受保护在途调用，再关闭 SDK/连接并退出。 | 等待只关注原生 session；模块业务和关闭回执不参与。当前尚无模块。 |
| 原生确认 | 部分 API/MCP 操作有 Cockpit 添加的 `confirm` 要求，详见[客户端说明](../apps/mcp/README.md#confirmation-boundaries)。 | 按 R3 跟随原生契约，额外防误触确认由 Web 提供；尚未修改实现。 |
| 模块 | 尚未提供加载器。 | 冷加载、前后端同包、独立 MCP path、失败模块局部禁用；执行进程模型待定。 |
| 启动消息 | 尚未提供。 | 可选模块保存下一次启动 prompt，并处理一次发送尝试。 |

## 代码与进程

```text
浏览器 ── 外部认证 HTTPS 入口 ──┐
                               ├─ Cockpit HTTP/SSE ── Engine ── 官方 SDK
MCP 客户端 ── 同一后端 API ─────┘                                  │
                                                         JSON-RPC / stdio
                                                                 │
                                                        原生 Copilot runtime
```

| 位置 | 当前责任 |
| --- | --- |
| `packages/protocol` | 输入/结果 schema、typed intents、原生事件及共享 Web 折叠。 |
| `packages/core` | 本宿主的 SDK handle、真实回调、在途操作和原生适配/安全保护。 |
| `apps/server` | HTTP/SSE、Web 静态文件、普通实例信息和 graceful 关闭。 |
| `apps/web` | 当前事件窗口、草稿、阅读位置、原生控件和本地错误反馈。 |
| `apps/mcp` | stdio 到 HTTP 的通用客户端，不读取 native DB，也不是新的逐模块 MCP 宿主。 |

SDK 固定为 1.0.13，原生 runtime 1.0.83 / protocol 3，仍是进程外接入。
SDK runtime、原生 MCP 和工具可以产生子进程。
`apps/mcp` 是可由客户端启动的独立 stdio 适配器，不是后端必需的常驻伴随服务；
本体尚无 HTTP MCP 宿主端点。
服务端/core 继续使用 TypeScript 与必要 loader，Web/MCP 有构建产物。
运行条件和包闭包见[安装运行](DEPLOY-PORTABLE.md)及[产包](packaging.md)。

### “薄”不是所有代码都原样透传

| 本体保留的层次 | 用途与限制 |
| --- | --- |
| 原生操作适配 | 会话、模型、消息、队列、决策、计划、原生定时、MCP/skill 等；调用 SDK 的实际能力，不另建权威状态。 |
| 远程访问与交互基础 | HTTP/schema、SSE、Web、当前阅读窗口、文字草稿、错误提示及选择 cwd 所需的 `fs/listDir`。目录浏览是宿主文件系统适配，不是 SDK 原生 API 或文件传输模块。 |
| 服务自身资源管理 | 包版本、实例/健康、活动查询、请求保护和 graceful 退出。它们不是 Copilot 的业务功能，也不是更新/部署系统。 |

快照/资源投影、cursor 和响应大小适配属于必要接口工作。
它们使用请求/连接范围的控制状态，原生数据仍由 SDK 管理。

<a id="authentication"></a>
## 认证边界

Cockpit 没有内置账号、密码库或独立登录服务。远程 Web/API 的身份认证由安装者的
外部网关承担，Copilot 登录由原生运行时承担；二者不能互相替代。
默认只监听 loopback，MCP 可使用兼容网关的凭据，不意味着本体实现了额外登录平台。

来源检查允许同 Host、loopback 和显式 `COCKPIT_ALLOWED_ORIGINS`。
它是 CSRF 保护，不是身份认证。前端默认同源；
实验环境不得通过未认证隧道绕过访问边界。

原生工具权限保持 `allow-all`；interactive/plan/autopilot 是交互模式。
真实 ask/plan/elicitation、永久删除的确认和 busy 保护保留。
客户端确认与后端强制字段的实际差异见 [MCP 确认边界](../apps/mcp/README.md#confirmation-boundaries)。
单操作者、同用户运行不是多租户或恶意模块沙箱。

<a id="shutdown"></a>
## 直接启动与 graceful 退出

本体直接进入服务入口，启动 SDK 并提供 Web/API。
退出后的重新启动由人工或宿主设施负责。

```json
{"name":"system/shutdown","body":{"confirm":true}}
```

上例可通过 `cockpit_call_intent` 或 `POST /intent/system/shutdown` 调用。
API 当前严格要求 `confirm:true`，提供 graceful 退出语义。
重复请求返回当前已受理状态。`SIGTERM`/`SIGINT` 请求同一 graceful 退出，
再次发信号不变成强停。这里的重复受理只适用于尚在运行/等待、请求可被接纳的阶段；
已进入关闭或失败阶段时不保证再次返回 `ok:true`。

状态为 `running → waiting → closing → closed`，以及明确的 `failed`。
`system/status` 与 `GET /status` 给出新鲜原生活动和宿主关闭状态；
`requestedAt`、错误和受保护在途 HTTP 数量属于宿主控制状态，不是原生副本。
返回 `ok:true` 表示已受理，不是进程已经退出。
`running` / `waiting` 阶段可正常读取状态。`closing` / `failed` 阶段的全局请求门禁
返回 HTTP 503、`SERVICE_CLOSING` 及可用的 shutdown 字段，不再返回成功形状的
`system/status`；实际完成退出后 HTTP 不可达。`closed` 是关闭状态机的内部终态，
不能要求已退出的进程通过 HTTP 自证。退出码/进程是否消失由调用方或宿主观察。

等待时不接受新的独立 prompt、session 创建、fork 或配置/定时新增。
已有 ask/plan/elicitation 回答、队列移除、Stop/interrupt、schedule stop 等完成通路保留，
原生读取仍可用；已接纳的原生队列按自身语义完成。
等待原生回合、队列/steering、决策、子任务、MCP 操作和宿主受保护调用收敛，
再复核并正常关闭空闲 handle、SDK 与网络连接。
浏览器长连接/只读显示流不是需要永远等待的业务目标，关闭显示不取消模型工作。

已知 busy 前检竞争可回到等待；未知关闭副作用或关闭失败不自动重试、不假报正常退出。
安全读取失败仍等待并报告错误。确认 SDK 进程死亡或服务启动失败时，记录错误、
清理拥有的资源并非零退出；不重放可能已经受理的输入。
发起关闭的原生回合必须结束，不能留后台工具等待自己退出。
未回答的原生问题或仍在运行的工作可以持续阻止退出；当前没有关闭取消、强制超时
或自动回答机制。这是已选的安全边界，不等于业务目标已完成。

模块接入后的等待边界遵循 [R7](product-requirements.md#r7--安全和生命周期如实表达)：
只关注原生 session 空闲，模块活动、业务发送和关闭回执不阻止退出。
当前实现尚无模块，但仍保护原生 API 的在途操作和响应；不能将本节理解为现有
HTTP 请求保护已经删除，也不能以后把模块请求加入等待条件。

## 版本与原生权威

`/health` 和 `/version` 共享本次进程的实例 ID。`/version` 返回 package version 和
`sourceSha`：打包时来自固定 manifest；源码无 manifest 时明确为 null，不读取移动 Git HEAD。
包信息是来源与兼容标识，不是用户认证、签名信任或部署成功证明。

Copilot 唯一拥有会话、历史、模型上下文、执行和队列。后端不保存聊天窗口、资源快照、
原生开关副本或私库兜底。保留项只包括实际 SDK handle/订阅、调用和关闭 Promise、
发送与 interaction 身份、待回答回调、版本/实例信息、有限 HTTP 缓冲及必要并发保护。
它们按请求或连接生命周期释放，不成为持久的原生镜像。

元数据按需读取，资源事件只失效消费者。
`session/list`、snapshot、`session/resources`、单面板与详情保持原有投影粒度。
未请求字段不等于清空，unloaded 不夹带缓存运行态，未知 cwd 不猜 home。
模型选项依据原生候选与能力，显式空/false 不被 fallback 放宽；排队变更仍由原生 FIFO 管理。

创建返回真实 ID，不隐藏发消息；空且未持久化的 session 卸载后可消失，不自动重建。
原生 idle timeout 为 30 分钟，未来 schedule 不保活；卸载暂停、相对延时恢复后重算。
全局 MCP/skill 设置和冷恢复由原生权威负责，不复制临时开关。
SDK 的全局 disabled-skill 适配仍读取原生用户设置并传入 create/resume，不另存列表。

## Web 与普通交互

前端仍在同一包和服务里。保留文本聊天、Markdown、工具、思考、子代理、决策、队列、
模型设置，以及会话设置、MCP、Skills 和永久删除入口。会话按原生活动排序。
Web 不展示或切换 interactive/plan/autopilot 模式，也不为此额外读取或设置模式。
新建会话沿用原生默认交互模式；打开或发送到已有会话不会强制改写其原生模式。
真实 ask/plan/elicitation 决策及其原生答复通路仍保留，后端 HTTP/MCP 模式能力不变。
Web 不再提供计划与任务、上下文资料/用量、定时任务、运行维护页面或会话分叉操作，
也不调用这些页面对应的原生管理 API；HTTP/MCP 能力保持不变。
保留页面需要恢复未加载会话时使用 `session/load`，不关闭并重载已有 handle。
聊天正文使用浏览器原生右键菜单，不拦截为消息复制菜单；代码和工具细节的复制按钮保留。
草稿版本、同会话 ACK 和滚动保护属于基本交互。

`/events` 用于控制/失效，`/chat/stream` 用于共享 all-agent 事件窗口。
历史、完整消息、重连和媒体边界由[原生聊天](native-chat.md)维护，
输出分页见 [MCP](../apps/mcp/README.md)，特殊继承和前检见[原生 fork](session-fork.md)。
前端扩展的组合方式由[模块协议](module-contract-draft.md#5-前后端共同组成一个-app)定义。
