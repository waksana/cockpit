# Cockpit 架构与运行边界

本文描述当前源码，要求以 [R1–R8](product-requirements.md) 为准。
源码完成不等于已部署；最后一次记录的线上实例仍见[部署记录](deployments.md)。
各主题的唯一维护位置见[文档索引](README.md)。

<a id="source-status"></a>
## 当前实现

Cockpit 是一个直接启动的 Web/API 服务，通过官方 SDK 控制原生 Copilot。
本体不包含自更新、循环重拉、私有部署控制器或模块业务原件。
前端静态资源与 API 由同一服务提供，默认开启 Web；明确的 API-only 模式可以关闭 Web。

当前没有新模块加载器、逐模块 HTTP MCP 端点或启动接续消息模块。
这些仍按[同进程冷加载协议](module-contract-draft.md)另行实现。
原生 `assistant` 消息、`task` 子代理、MCP/skill 和定时提示不是迁出的业务模块。

<a id="target-gap"></a>
## 已完成源码与剩余目标

| 表面 | 当前源码 | 尚未宣称完成的部分 |
| --- | --- | --- |
| 前后端运行包 | 普通产包、直接服务入口、自身 Web/API，无部署启动权威。 | 不捆绑 Node，不保证所有 OS/平台零前提运行，也没有自动发布/部署。 |
| 关闭 | 公开 `system/shutdown`，等待原生工作及受保护在途调用，再退出；不自重启。 | 不保证外部会重新拉起，不提供 force 或部署恢复模式。 |
| 原件迁出 | 按职责保存到项目外，仓内不再保留 `module-staging`。 | 原件没有适配成插件，真实安装/配置/业务数据未搬迁。 |
| 模块 | 只有确定的接口方向。 | 同进程 import、冷加载、前端组合、独立 MCP path 及启动 prompt 模块均未实现。 |
| 线上安装 | 历史运行包仍独立存在。 | 本次源码修改未部署，也未撤掉实际使用的旧 runner/launch。 |

提取范围和原件位置见[迁出目录](module-catalog.md)与[来源归档](extractions.md)。

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
“一个 Cockpit 服务”不等于 SDK/MCP/工具完全不产生子进程；没有额外 Cockpit 自监督父进程。
服务端/core 继续使用 TypeScript 与必要 loader，Web/MCP 有构建产物。
运行条件和包闭包见[安装运行](DEPLOY-PORTABLE.md)及[产包](packaging.md)。

<a id="authentication"></a>
## 认证边界

Cockpit 没有内置账号、密码库或独立登录服务。远程 Web/API 的身份认证由安装者的
外部网关承担，Copilot 登录由原生运行时承担；二者不能互相替代。
默认只监听 loopback，MCP 可使用兼容网关的凭据，不意味着本体实现了额外登录平台。

来源检查保留同 Host、loopback 和显式 `COCKPIT_ALLOWED_ORIGINS`，不再信任写死的个人域名。
它是 CSRF 保护，不是身份认证。前端默认同源，不再默认请求某个真实部署网站；
实验环境不得通过未认证隧道绕过访问边界。

原生工具权限保持 `allow-all`；interactive/plan/autopilot 是交互模式。
真实 ask/plan/elicitation、永久删除的确认和 busy 保护保留。
客户端确认与后端强制字段的实际差异见 [MCP 确认边界](../apps/mcp/README.md#confirmation-boundaries)。
单操作者、同用户运行不是多租户或恶意模块沙箱。

<a id="launchers"></a>
<a id="shutdown"></a>
## 直接启动与 graceful 退出

正常服务启动不访问 runner、不读 consumer 安装记录、不调用 `/boot`、不复制旧发行资源、
不选择回退版本、不发送接续 prompt。
本体只有自己的运行入口；退出后是否再次启动，由人工或独立宿主设施决定。

```json
{"name":"system/shutdown","body":{"confirm":true}}
```

上例可通过 `cockpit_call_intent` 或 `POST /intent/system/shutdown` 调用。
API 严格要求 `confirm:true`；无 `force`、`pending:false`、部署 operationId 或取消模式。
重复请求只返回当前已受理状态，不重建部署记录。`SIGTERM`/`SIGINT` 请求同一 graceful 退出，
再次发信号不变成强停。

状态为 `running → waiting → closing → closed`，以及明确的 `failed`。
`system/status` 与 `GET /status` 给出新鲜原生活动和宿主关闭状态；
`requestedAt`、错误和受保护在途 HTTP 数量属于宿主控制状态，不是原生副本。
返回 `ok:true` 表示已受理，不是进程已经退出。

等待时不接受新的独立 prompt、session 创建、fork 或配置/定时新增。
已有 ask/plan/elicitation 回答、队列移除、Stop/interrupt、schedule stop 等完成通路保留，
原生读取仍可用；不清空业务队列来制造空闲。
等待原生回合、队列/steering、决策、子任务、MCP 操作和宿主受保护调用收敛，
再复核并正常关闭空闲 handle、SDK 与网络连接。
浏览器长连接/只读显示流不是需要永远等待的业务目标，关闭显示不取消模型工作。

已知 busy 前检竞争可回到等待；未知关闭副作用或关闭失败不自动重试、不假报正常退出。
安全读取失败仍等待并报告错误。确认 SDK 进程死亡或服务启动失败时，记录错误、
清理拥有的资源并非零退出；不重放可能已经受理的输入。
发起关闭的原生回合必须结束，不能留后台工具等待自己退出。

`/admin/restart`、`/admin/lifecycle` 和 `system/consumer/*` 已删除，不是新 API 的别名。
部署模式、私有回执和主程序安装数据不再进入本体。

## 版本与原生权威

`/health` 和 `/version` 共享本次进程的实例 ID。`/version` 返回 package version 和
`sourceSha`：打包时来自固定 manifest；源码无 manifest 时明确为 null，不读取移动 Git HEAD。
不再接受 `SERVICE_DELIVERY_*` / `COCKPIT_CONSUMER_*` 作为版本权威，也不返回它们的
requestId、安装身份或 artifact 选择。
包信息是来源与兼容标识，不是用户认证、签名信任或部署成功证明。

Copilot 唯一拥有会话、历史、模型上下文、执行和队列。后端不保存聊天窗口、资源快照、
原生开关副本或私库兜底。保留项只包括实际 SDK handle/订阅、调用和关闭 Promise、
发送与 interaction 身份、待回答回调、版本/实例信息、有限 HTTP 缓冲及必要并发保护。
它们按请求或连接生命周期释放，不成为持久的原生镜像。

元数据按需读取，资源事件只失效消费者；没有后台全量同步或旧八秒轮询。
`session/list`、snapshot、`session/resources`、单面板与详情保持原有投影粒度。
未请求字段不等于清空，unloaded 不夹带缓存运行态，未知 cwd 不猜 home。
模型选项依据原生候选与能力，显式空/false 不被 fallback 放宽；排队变更仍由原生 FIFO 管理。

创建返回真实 ID，不隐藏发消息；空且未持久化的 session 卸载后可消失，不自动重建。
原生 idle timeout 为 30 分钟，未来 schedule 不保活；卸载暂停、相对延时恢复后重算。
全局 MCP/skill 设置和冷恢复由原生权威负责，不复制临时开关。
SDK 的全局 disabled-skill 适配仍读取原生用户设置并传入 create/resume，不另存列表。

## Web 与普通交互

前端仍在同一包和服务里。保留文本聊天、Markdown、工具、思考、子代理、决策、队列、
模型与原生管理页面。按原生活动排序；文件/语音/pin/收件箱等增强不内置。
草稿版本、同会话 ACK 和滚动保护属于基本交互，不因拆分而删除。

`/events` 用于控制/失效，`/chat/stream` 用于共享 all-agent 事件窗口。
历史、完整消息、重连和媒体边界由[原生聊天](native-chat.md)维护，
输出分页见 [MCP](../apps/mcp/README.md)，特殊继承和前检见[原生 fork](session-fork.md)。
未来插件不是任意 SPA 自动拼接，也不能借模块名特判恢复文件渲染。
