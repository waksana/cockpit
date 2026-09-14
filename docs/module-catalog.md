# 模块目录与迁出边界

本文维护能力归属和源码提取结果，不是模块安装注册表。
当前没有新模块加载器；同进程 import、冷加载及分 path MCP 仍是
[后续协议目标](module-contract-draft.md)。

所有提取原件已经分类放到[项目外目录](extractions.md)，包括原先仓内的
`module-staging/`。本体源码不再保存这些可执行原件，也不把它们装入运行包。
来源、路径、摘要与许可仍可追溯；现存独立模块仓库和真实数据未被移动或清除。

## 模块能力与归档来源

下面列十项已确认的模块能力，**不是十个已经实现/安装的模块**。
能力名与归档目录分开，归档名不决定未来 moduleId。
“下次启动消息”作为显式能力单列；其记录格式、查询/取消、发送状态仍需新实现，
不能因有旧重启脚本就宣称代码已存在。

<a id="十类能力"></a>

| 模块能力 | 原件来源 | 完整责任与本体边界 |
| --- | --- | --- |
| 文件 | `files` | 上传、托管、元数据、关联、下载、文件库；输入区与聊天流的文件增强展示。负责自己的字节传输/引用，不接管原生会话、history、cursor 或队列。 |
| 通知/收件箱 | `notifications` | 未读/已读、提醒、去重、订阅、push 和 badge；普通消息收发、决策与本地 API 错误提示仍是本体。 |
| 语音 | `voice` | 听写、语言、采音、识别提供方及令牌；写原草稿，不抢发送权，发送录音时才需要文件能力。 |
| 会话整理 | `session-organization` | 置顶与额外首回复命名策略；不拥有原生命名或标题/历史镜像。 |
| 系统状态展示 | `system-status` | 可选系统/模块版本和外部状态看板；不是更新器、部署控制器或通用安装器。普通版本/健康接口仍在本体。 |
| 下次启动消息 | 参考 `graceful-restart` 的旧便利材料，新行为未实现 | 显式保存下一次启动 prompt，记录自动尝试、受理、失败/unknown；不主持等待空闲，不保证重拉，不复制部署账本。 |
| Context Reset | `context-reset` | self-only 上下文清理工具/skill 与交接，不等于关闭服务、reload、compaction、rewind 或删除 session。 |
| Assistant | `assistant` | 公开角色/skills/模板，不含私人人格记忆实例，不覆盖工作区规则或隐藏发初始化消息。 |
| Task | `task` | 目标、授权、身份、Commander/Owner、业务投递和结果；业务状态自有，未来 import 后随宿主退出，不代替原生队列。 |
| 微信 | `wechat` | 渠道绑定、收发、媒体和 unknown 处理；不自动启用暂停渠道或重发未知结果。 |

Task 与微信源码仍分别属于
[cockpit-task](https://github.com/waksana/cockpit-task)、
[cockpit-wechat-connector](https://github.com/waksana/cockpit-wechat-connector)。
独立仓库/版本可以保留，过去的独立服务进程形态不能直接当成新协议模块。
原生 `assistant` 消息和 `task` 子代理不是这些业务模块，继续保留。

### 移出但不列成模块的内容

不是每个移出的文件都应重新做成插件。按照已经确认的范围，以下有明确去向，
不把“没有列模块”误报为功能遗漏或未来恢复承诺：

| 去向 | 内容 | 理由 |
| --- | --- | --- |
| 外部运维，不是当前模块计划 | 主程序 updater/bootstrap、runner/launch/receive、生产审批/回执/回滚、原重拉 wrapper、主机 systemd/Nginx 示例 | 本体只产包、serve 和 graceful 退出；需要在宿主关闭后运行的安装/拉起工作不应依赖宿主内模块。 |
| 旧平台原件，仅供参考 | `_legacy-host` 中官方模块 ID、角色绑定、专用网关与旧配置兼容层 | 新协议采用通用同进程冷加载，旧宿主不能作为另一模块装回来。 |
| 已退役的业务设计，未决定恢复 | `_retired-governance` 中 Butler/Flow、Hook/定时治理等材料 | 它们不是原生 task/定时提示，也没有因归档重新获得实现授权；不默认塞给 Task。 |
| 直接清理，不应模块化 | 无生产用途的 store 路径 helper、过时字段/协议适配 | 没有独立用户能力需要保留；Git 与外部原件保留来源。 |
| 留开发仓库、排除运行包 | 普通测试、诊断、组件 lab、历史文档与产包 CI | 这是工程材料，不是运行期能力或插件。 |

更早明确退役的软删除/恢复、虚拟 session、原生工具图片查找及后端历史镜像，
以及主动取消的消息整段复制/装饰性交互，都不能因这次模块梳理自动变成待补模块。
文件、通知和其他业务能力未来是否吸收新的功能，需各自明确需求，不从旧代码推定。

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

尚未迁移的旧安装采用当前包时，需要由安装者替换旧启动链。
源码提取没有自动停用、重写或删除旧 runner、配置、身份及已运行包；
单独完成的部署事实见[部署记录](deployments.md)，不能由源码状态推断。

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
