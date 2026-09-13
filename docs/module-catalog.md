# 模块目录与迁出边界

本文维护能力归属和源码提取结果，不是模块安装注册表。
当前没有新模块加载器；同进程 import、冷加载及分 path MCP 仍是
[后续协议目标](module-contract-draft.md)。

所有提取原件已经分类放到[项目外目录](extractions.md)，包括原先仓内的
`module-staging/`。本体源码不再保存这些可执行原件，也不把它们装入运行包。
来源、路径、摘要与许可仍可追溯；现存独立模块仓库和真实数据未被移动或清除。

## 十类能力

| 原分组 | 完整责任 | 与本体的边界 |
| --- | --- | --- |
| `files` | 上传、托管、元数据、关联、下载、文件库；选择/粘贴/拖拽、暂存与进度；聊天流的文件卡片、图片/视频预览和下载。 | 负责自己的 HTTP 字节传输和引用解析，提供 SDK 原生附件输入，不接管会话、历史、cursor 或发送队列。 |
| `notifications` | 收件箱、未读/已读、提醒与去重、订阅、push 和 badge。 | 只拥有通知业务数据；普通消息收发、决策和本地 API 错误提示仍在本体。 |
| `voice` | 听写、语言、采音、识别提供方及令牌。 | 写入原草稿，不抢发送权；纯听写不依赖文件模块，发送录音才需要文件能力。 |
| `session-organization` | 置顶与额外首回复自动命名策略。 | 原生命名和标题读取仍在本体，不做标题/历史镜像。 |
| `system-status` | 可选系统、模块版本和外部运行/部署状态展示。 | 读取真实权威，不让本体重新内置部署控制器；普通版本/健康接口不等于系统看板。 |
| `graceful-restart`（原归档名） | 保留原重启便利材料；新的可选能力是保存下一次启动消息并处理一次发送尝试。 | 不主持 graceful 等待，不保证重新拉起，不复制外部部署账本。未来 ID 不要求沿用归档名。 |
| `context-reset` | self-only 上下文清理工具、skill 和交接工作流。 | 不等于关闭主程序、reload、compaction、rewind 或删除 session。 |
| `assistant` | 公开角色内容、skills、模板。 | 不包含用户人格/记忆实例，不覆盖工作区规则或隐藏发送初始化消息。 |
| `task` | 目标、授权、业务身份、Commander/Owner 角色、投递和结果。 | 业务状态自有；未来作为 import 模块随宿主退出，不代替原生队列。 |
| `wechat` | 渠道绑定、收发、媒体和 unknown 处理。 | 业务数据与恢复由模块负责，不自动启用暂停渠道或重发未知结果。 |

Task 与微信源码仍分别属于
[cockpit-task](https://github.com/waksana/cockpit-task)、
[cockpit-wechat-connector](https://github.com/waksana/cockpit-wechat-connector)。
独立仓库/版本可以保留，过去的独立服务进程形态不能直接当成新协议模块。
原生 `assistant` 消息和 `task` 子代理不是这些业务模块，继续保留。

<a id="pending-extraction"></a>
## 运维外围提取结果

原盘点中的主程序运维系统已从当前源码移出；这不是生产进程的切换。

| 已移出内容 | 保留/替代部分 |
| --- | --- |
| consumer 更新器、稳定安装 bootstrap、版本选择/回退、操作回执、core 发行传输和 consumer 协议 | 主程序只产生普通运行包；未来通用模块签名接入没有被取消，也尚未实现。 |
| 私有 runner/launch/receive、专用交付配置、transfer workflow 和 vendor 工具 | 普通验证/构建/产包 CI；无私有传输、部署审批或启动控制器依赖。 |
| `scripts/start.mjs` 重拉循环及 heap helper | 直接启动服务入口；不把 `pnpm start` 功能删除或暗中保留父进程 supervisor。 |
| server 的 consumer-control、delivery-identity 和部署状态分支 | 一份普通服务实例/版本信息、原生活动查询及 `system/shutdown`。 |
| 外部旧版本 Web 资源库接线、固定部署域名和主机示例 | 自身 Web 静态资源与普通缓存、可配置来源/地址、loopback 和 CSRF 保护。 |
| 无生产使用的旧 store 路径 helper | 真实使用的 `cockpitHome()`；不再提供读取 native SQLite 的伪接入。 |
| 仓内 `module-staging` 原件 | 项目外分类保存及固定 Git 来源；不重新制作旧模块运行器。 |

原件包括被删独占文件和修改过的混合文件。测试随职责迁移：旧更新/部署用例归档，
本体原生、HTTP、UI、graceful 退出和普通产包用例仍保留。开发资料不需要成为运行包内容。
运行包的实际边界由[产包说明](packaging.md)维护，不按依赖内部文件的名字盲目裁剪 SDK。

真正部署当前源码前，需要由安装者替换旧启动链。旧 runner、配置、身份及已运行包
没有在此操作中被停用、重写或删除；不能把源码提取等同于线上完成。

<a id="retired-capabilities"></a>
## 退役与替代接口

| 已退役表面 | 当前语义 |
| --- | --- |
| `files/*`、`inbox/seen`、`push/*`、`speech/token`、`session/pin`、`session/auto-name` | 不注册，不提供空成功或业务兼容层。 |
| `modules/*`、`session/modules/*`、旧专用网关和创建时的 `modules` 参数 | 新加载协议尚未实现，不能假报接入成功。 |
| `/upload`、`/uploads/*`、`/files`、`/system/versions` | 没有这些服务或页面；旧文件仍保留。 |
| `/admin/restart`、`/admin/lifecycle`、`system/consumer/*` | 不再是接口或 shutdown 别名；使用新公开的 `system/shutdown` / `system/status`。 |
| MCP 文件、pin、restart 便利工具及旧重启脚本 | 不恢复；generic `cockpit_call_intent` 可以调用当前已发布的 shutdown schema。 |
| singular `attachment`、ordered `parts` 和托管文件描述 | 不属于原生附件输入，严格拒绝；native file/directory/selection/blob 仍支持。 |
| `session/tool-image`、`files/from-tool-image` | 无查找/收集逻辑，作为未知 intent 返回 404。 |
| bundled reset skill 和 `self_clear_context` | 未适配为可运行模块，不是当前本体工具。 |

未知/退役 intent 标准结果为 404，非法输入按 schema 拒绝。
聊天旧消息分页的 `410 CHAT_PROTOCOL_CHANGED` 是单独的原生协议迁移，
见[原生聊天](native-chat.md#protocol-migration)。
`skills/refresh` 保持原生定义刷新，只返回 `ok`，不再携带旧 `willRestartWhenIdle` 字段。
退出具体受理/等待/失败语义见[架构](cockpit-plan.md#shutdown)。

<a id="interim-behavior-and-adoption"></a>
## 保留数据与以后采用

原生会话、工作区、偏好、上传原件、凭据、外部部署历史和模块业务数据均不随源码提取
删除、迁移或重放。本体不再读写 `cockpit-prefs.json`；留下数据不代表旧接口仍有效。

文字草稿使用 `cockpit:native-composer:<sessionId>`；旧
`cockpit:composer:<sessionId>` 富草稿及 caption 保持原样，不自动继承或覆盖。
旧聊天文字还在，但自有文件标记没有增强渲染，旧托管链接没有下载服务。
后续模块的数据采用需显式设计，不能修改 native history 来伪装兼容。

源码变化不撤销所有设备上已显示的通知、旧 worker 或订阅，也不保证已有远端
MCP/浏览器进程自动换成新定义。原语音 late-start/token 等缺口仍在归档中，
不是停放即修复。新模块必须按冷加载、版本应用、分 path MCP 和错误/unknown 规则适配。

不再把原生 SDK/session/队列、MCP/skill、HTTP/SSE、文本 Web、草稿/阅读保护和安全退出
拆成业务模块。它们就是本体；未来通用加载也不能依赖一个尚未加载的模块来启动自己。
