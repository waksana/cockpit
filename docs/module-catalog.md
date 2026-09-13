# 模块目录与迁出边界

本文是**能力归属、源码停放和退役采用边界的唯一目录**，不是安装注册表。
薄本体已完成源码摘除；实际部署证据见[部署记录](deployments.md)。
下列目录均为待适配原件，当前没有可用的模块加载器。

本体保留什么、认证网关和 launcher 是什么，统一见
[架构与运行边界](cockpit-plan.md)。未来的通用接入、前端组合、API 与版本语义，
统一见[基础模块协议](module-contract-draft.md)。

## 十类能力

| 目录 | 作用和能力 | 前端贡献 | 后端/原生边界 |
| --- | --- | --- | --- |
| `files` | 上传、托管、原件/元数据、关联、浏览、下载及自有文件引用解析。 | 文件选择、粘贴/拖拽、暂存/进度、文件库；**聊天流的附件卡片、图片/视频预览和下载**也归它。 | 自己负责传输、存储和校验，再提供原生附件输入；不接管 native history、cursor、队列或发送权威。 |
| `notifications` | 收件箱、未读/已读记录、提醒策略、去重、订阅和 Web Push。 | 收件箱/设置、未读标记与应用 badge。 | 自有通知状态，不建立第二份会话数据库；这里的“消息”指提醒，不是原生消息收发和决策。 |
| `voice` | 听写、语言/识别服务、采音、令牌与秘密管理。 | 麦克风、采音状态和转写反馈。 | 写入原草稿文字，不接管发送；纯听写不依赖文件模块，发送录音文件的能力才需要文件传输。 |
| `session-organization` | 置顶和 Cockpit 的首回复额外自动命名策略。 | 可选排序/标记及整理操作。 | 置顶数据和命名策略自有，调用原生命名/ephemeral query；不镜像标题或历史。原生手动命名仍在本体。 |
| `system-status` | 主程序/模块版本、运行状态和外部 CI/CD 状态展示。 | 系统看板、版本页及显式刷新。 | 读取实际身份与对应权威，不从 Git HEAD 猜运行成功；不是通用模块安装器。 |
| `graceful-restart` | 用户/agent 的重启便利操作、原操作进度与恢复交互。 | 重启按钮、状态与等待原因。 | 请求受保护生命周期或外围 launcher；**不拥有唯一的安全退出实现**，不能强停忙宿主。 |
| `context-reset` | 原 `self-context-reset`：准备并重读本地交接，再执行 self-only 清上下文和恢复提示。 | 将来需要时才贡献界面，页面不是必选。 | 原工具、skill 和工作流保护随能力停放；依赖支持的原生上下文 API，保留 session ID/事件历史，不混同删除、reload 或 compaction。 |
| `assistant` | 可选角色说明、skills 和公开模板。 | 不强制有页面或服务。 | 显式选择内容，不替代工作区规则，不自动初始化用户人格/记忆实例。 |
| `task` | 目标、授权、Commander/Owner 角色、业务身份、投递、进展和结果。 | 自己的任务页面与操作。 | 业务数据/凭据/生命周期自有，消费真实 session API；不代替原生队列，不默认继承 Assistant。 |
| `wechat` | 渠道绑定、收发、媒体及不确定投递处理。 | 渠道配置与状态。 | 渠道协议、凭据、身份和业务恢复自有；不自动启用暂停渠道，不重发 unknown。 |

目录名用于组织源码，不是宿主 moduleId 白名单，也不决定未来安装身份。
Task/微信的独立业务源码分别属于 [cockpit-task](https://github.com/waksana/cockpit-task)
和 [cockpit-wechat-connector](https://github.com/waksana/cockpit-wechat-connector)；
这里停放的是曾在宿主中的接入材料，不是把独立仓库或真实数据复制回来。
Assistant 目录同样只含公开内容，不是用户实例。

## 迁出不等于去掉原生能力

| 已迁出的增强 | 仍保留的原生/宿主能力 |
| --- | --- |
| 文件库、传输、托管描述和文件 UI | SDK 原生附件参数、原生文件工具、普通文本/链接；不提供替代上传服务。 |
| 收件箱、未读、push 与 badge | 真实 ask/plan/elicitation、队列和运行状态；未读标记消失不等于问题已回答。 |
| 置顶、额外自动命名与语音 | 原生命名/标题读取、普通文字草稿和原生 prompt。 |
| 系统看板、重启便利脚本/工具 | 最小身份/健康/生命周期端点、安全退出和独立 launcher。 |
| 自清上下文工具/skill | SDK 自有上下文能力及已接入的 reload、compaction、rewind；不新增跨会话 self-clear 接口。 |
| 业务角色、注册、服务和渠道接入 | 原生 `assistant` 消息与 `task` 子代理，不保留旧业务兼容层。 |

原生用户配置中的普通 MCP/skill 仍由用户管理；删除宿主业务接入不授权清空这些配置。
停放功能不等于抹掉旧模型上下文中的文字或原生日志。
本地 API 错误提示、发送反馈和当前阅读窗口的新内容滚动提示仍是普通交互，
不属于已迁出的持久未读/推送业务，不能因为名称含“通知”就删掉。

## 源码停放与来源

[`module-staging/`](../module-staging/README.md) 在 workspace、测试入口和运行产物之外。
独占能力文件按类别保留原路径；混合文件先保留整份原件，再从活跃文件删除增强部分。
**混合原件不是整份文件都属于模块的声明。**

| 分组 | 含义 |
| --- | --- |
| 十个能力目录 | 原代码、测试、文档、样例和资源；不修 imports、不补 driver、不宣称可运行。 |
| `_shared-originals` | 同时含原生适配和增强逻辑的完整提取前文件。 |
| `_legacy-host` | 旧官方模块宿主，不是下一代通用插件宿主。 |
| `_retired-governance` | 旧 Butler/Flow 背景，不是恢复这些能力的决定。 |

原件路径为 `<分组>/<源 SHA 前七位>/<原仓库相对路径>`。
[`source-inventory.json`](../module-staging/source-inventory.json) 记录每份源 SHA、路径、
目标、SHA-256 和 Git mode。薄本体提取基线保全了 300 份原件，来源为：

| 固定源码 | 用途 |
| --- | --- |
| `21fdcc264de347467e4cf42b44af114902878177` | 摘除前的活跃源码和前端插件设计。 |
| `33696b81c5d2ebe073e4700410c1cc4adabc4c1b` | 更早已移除的公开官方模块内容/接入，不复制私有运行资料。 |

维护当前说明不得改写这些原始副本；来源清单不是业务任务账本。
未来适配另行组织模块源码，不能把停放目录直接加入 workspace 或打进运行包。

<a id="retired-capabilities"></a>
## 退役接口

以下是破坏性边界，不提供兼容层或空成功结果：

| 表面 | 已移除内容 |
| --- | --- |
| 产品 intents | `files/*`、`inbox/seen`、`push/*`、`speech/token`、`session/pin`、`session/auto-name`、`system/consumer/*`。 |
| 旧模块接入 | `modules/*`、`session/modules/*`、旧专用网关及 `session/new` 的 `modules` 参数。 |
| HTTP / Web | `/upload`、`/uploads/*`、`/files`、`/system/versions`，以及对应增强页面。 |
| MCP / 便利命令 | 文件上传/下载、置顶、服务重启工具，以及 `scripts/graceful-restart.*`。 |
| 原托管附件 | singular `attachment`、ordered `parts`、`{kind,name,url,...}` 描述；不能当成 SDK 原生输入。 |
| 原生图片查找 | `session/tool-image`、`files/from-tool-image` 无处理器；不再保留专用 410 兼容提示。 |
| Reset 接入 | bundled `self-context-reset` skill 和 `self_clear_context` 工具，不因原生 SDK 有清上下文函数就变为可调用的本体入口。 |

未知/已移除 intent 的标准结果是 404；旧输入字段由当前对应 schema 拒绝。
聊天旧消息分页接口的 `410 CHAT_PROTOCOL_CHANGED` 属于另一条原生协议迁移，
详见[原生聊天](native-chat.md#protocol-migration)，不要混成所有退役路径都返回 410。
精确当前 schema 以 `/capabilities` 为准；上表不是另一个路由注册表。

<a id="interim-behavior-and-adoption"></a>
## 保留数据与未来采用

没有适配模块时，这些增强不可用，但既有 native history、工作区文件、偏好、上传原件、
凭据和模块业务记录不随摘除而删除、迁移或重放。
本体不再读取/写入 `cockpit-prefs.json`；保留数据不等于仍有旧业务服务。

文字输入使用 `cockpit:native-composer:<sessionId>`。原
`cockpit:composer:<sessionId>` 富草稿保持原样，不自动继承附件或文字 caption；
不得以“迁移”名义悄悄覆盖。旧聊天文字仍在，但自有文件标记没有增强渲染，
旧托管链接也没有下载服务。以后要访问这些资料，需显式设计模块采用路径。

源码更新不能远程撤销所有设备上的历史通知/订阅，也不抹掉已显示消息。
薄本体的后端和新 worker 没有 push 处理，不代表旧设备注册记录已被清理。
原语音的已知 late-start/token 缺口仍在原件中，不因停放就算修复。

后续逐个模块适配：先实现真实需要的最小通用能力，再验证完整前后端使用、
失败、冷恢复、版本应用和保留数据的卸载。独立编译、模块目录或一个按钮样例
都不能替代真实接通；验收标准由[基础协议](module-contract-draft.md)统一维护。
