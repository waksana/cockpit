# 模块目录与迁出边界

本文是**能力归属、源码停放和退役采用边界的唯一目录**，不是安装注册表。
文件/通知等增强和旧官方模块接入已完成源码摘除；实际部署证据见[部署记录](deployments.md)。
**这不等于晚间新目标中的运维外围也已迁出。** 后者见[待迁出盘点](#pending-extraction)。
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
| `graceful-restart`（原停放名） | 原重启便利脚本保留为历史；新目标是可选的“下次启动消息”能力，可通过 MCP 保存接续 prompt，并在落盘后请求本体 graceful 退出。 | 可选的记录/状态操作；不强制页面。 | 启动就绪后处理模块自己的记录，发送尝试/受理/unknown 分开；不主持等待空闲，不保证重新拉起，不带部署控制器。 |
| `context-reset` | 原 `self-context-reset`：准备并重读本地交接，再执行 self-only 清上下文和恢复提示。 | 将来需要时才贡献界面，页面不是必选。 | 原工具、skill 和工作流保护随能力停放；依赖支持的原生上下文 API，保留 session ID/事件历史，不混同删除、reload 或 compaction。 |
| `assistant` | 可选角色说明、skills 和公开模板。 | 不强制有页面或服务。 | 显式选择内容，不替代工作区规则，不自动初始化用户人格/记忆实例。 |
| `task` | 目标、授权、Commander/Owner 角色、业务身份、投递、进展和结果。 | 自己的任务页面与操作。 | 业务记录、凭据和任务状态由模块负责，进程/资源退出随宿主；消费真实 session API，不代替原生队列或默认继承 Assistant。 |
| `wechat` | 渠道绑定、收发、媒体及不确定投递处理。 | 渠道配置与状态。 | 渠道协议、凭据、身份和业务恢复自有；不自动启用暂停渠道，不重发 unknown。 |

目录名用于组织源码，不是宿主 moduleId 白名单，也不决定未来安装身份。
Task/微信的独立业务源码分别属于 [cockpit-task](https://github.com/waksana/cockpit-task)
和 [cockpit-wechat-connector](https://github.com/waksana/cockpit-wechat-connector)；
这里停放的是曾在宿主中的接入材料，不是把独立仓库或真实数据复制回来。
Assistant 目录同样只含公开内容，不是用户实例。
上述是能力归属，不是承诺保留它们过去的进程拓扑。2026-09-13 晚间确认的目标是
所有模块后端同进程 import，前后端同包、宿主统一 serve，首版冷加载；
Task/微信现有独立服务也需按此重新适配。`graceful-restart` 只是既有归档目录名，
不强制未来模块沿用该 ID，也不暗示新消息模块已经实现。

## 迁出不等于去掉原生能力

| 已迁出的增强 | 仍保留的原生/宿主能力 |
| --- | --- |
| 文件库、传输、托管描述和文件 UI | SDK 原生附件参数、原生文件工具、普通文本/链接；不提供替代上传服务。 |
| 收件箱、未读、push 与 badge | 真实 ask/plan/elicitation、队列和运行状态；未读标记消失不等于问题已回答。 |
| 置顶、额外自动命名与语音 | 原生命名/标题读取、普通文字草稿和原生 prompt。 |
| 系统看板、重启便利脚本/工具 | 最小身份/健康和原生安全退出；独立 launcher 当前仍在，按新目标待迁出，不是永久保留项。 |
| 自清上下文工具/skill | SDK 自有上下文能力及已接入的 reload、compaction、rewind；不新增跨会话 self-clear 接口。 |
| 业务角色、注册、服务和渠道接入 | 原生 `assistant` 消息与 `task` 子代理，不保留旧业务兼容层。 |

原生用户配置中的普通 MCP/skill 仍由用户管理；删除宿主业务接入不授权清空这些配置。
停放功能不等于抹掉旧模型上下文中的文字或原生日志。
本地 API 错误提示、发送反馈和当前阅读窗口的新内容滚动提示仍是普通交互，
不属于已迁出的持久未读/推送业务，不能因为名称含“通知”就删掉。

<a id="pending-extraction"></a>
## 新目标下仍可迁出的内容

这是对源码 `0f09124e0cc1efb4643277f2a84ab1380339fd4f` 的职责盘点，不是已执行的迁移。
运行事实仍对应[已记录的 a1f4a9a 部署](deployments.md)。下面区分已确认不属本体、
建议清理及应留在开发仓库而排除出运行包的内容，避免继续造没有必要的模块。

### 已确认不应进入本体运行包或启动依赖

| 内容与证据位置 | 当前实际作用 | 迁出/替代边界 |
| --- | --- | --- |
| [`scripts/consumer/`](../scripts/consumer/cli.mjs)、[`packages/core/src/consumer/`](../packages/core/src/consumer/release-transport.mjs)、[`consumer-runtime.json`](../consumer-runtime.json) | 主程序签名下载、安装身份、不可变选择、launcher、IPC 排空、操作回执和恢复；共享代码还留在 core 下。 | 整套主程序消费者安装/更新功能外置或退役，不能只移 CLI 而保留 core 内的更新传输。通用模块签名接入是另一能力，不能据此取消。 |
| [`.delivery/toolkit/`](../.delivery/provenance.json) 中 runner/launch/receive、[`scripts/vendor-delivery.mjs`](../scripts/vendor-delivery.mjs) | 私有交付授权、顺序、产物接收、版本选择、数据库及恢复；线上另有独立安装副本。 | 产品不依赖其常驻控制器或启动审批。可复用的纯产包/校验逻辑与私有运行控制分开，不能把 runtime 继续绑在工具集目录。 |
| [`scripts/start.mjs`](../scripts/start.mjs)、[`scripts/heap-config.mjs`](../scripts/heap-config.mjs) 及根 `start` 脚本 | 源码模式额外起一个父进程，子进程退出后循环重拉；同时补 Web 环境和启动参数。 | 保留一个直接服务入口，移除自监督循环。替代时仍须正确定位 Web/依赖、提供完整 serve；不能只删 wrapper 导致网页默认不再提供。 |
| [`consumer-control.ts`](../apps/server/src/consumer-control.ts)、[`delivery-identity.ts`](../apps/server/src/delivery-identity.ts)、server [`index.ts`](../apps/server/src/index.ts)、协议 [`consumer.ts`](../packages/protocol/src/consumer.ts) | 本体识别两种部署权威，读取安装/操作记录，通过 IPC/Unix socket 连接 launcher；状态和 restart 路径携带 consumer 字段。 | 移出部署专用身份/状态和多运行器分支，保留简单的包版本/实例、健康、活动与 graceful 退出。不是把整个 server、protocol 或所有状态查询删掉。 |
| [`package-consumer-release.mjs`](../scripts/package-consumer-release.mjs)、[`verify-consumer-bootstrap.mjs`](../scripts/verify-consumer-bootstrap.mjs) | 生成/验证主程序消费者 bootstrap 和签名更新格式，复用 `.delivery` 解包/manifest 代码。 | 跟随主程序更新系统迁出。普通完整包、摘要和依赖闭包可以保留，但不继续携带安装器 bootstrap。 |
| [`delivery-transfer.yml`](../.github/workflows/delivery-transfer.yml)、[`shared-delivery-transfer.yml`](../.github/workflows/shared-delivery-transfer.yml) 及 CI 的私有部署参数 | 绑定 requestId 的构建结果经 SSH 进入现有控制器。 | 私有目标/审批/传输不属于本体。CI 中纯验证、构建、产包部分可以留下，不能把有用 CI 一并删除。 |
| 外部 runner 的 [`notify()`](../.delivery/toolkit/bin/runner.mjs) | 部署终态后向提交者绑定的 session 发普通 prompt，发送前记 attempted。不是本体启动钩子。 | 部署通知随外部系统走；用户选择的下次启动消息由可选模块维护自己的数据，不能把部署 SQLite/凭据带进新模块。 |

[`service-delivery.json`](../service-delivery.json) 目前同时描述构建闭包和生产交付绑定。
后续应保留明确、可复验的产包输入，去掉产品对私有部署字段的依赖。
不能直接删除 `.delivery` 后仍让 consumer/import 或 CI 引用它；这是一组有连线的清理，
不是删几个目录即可完成。

### 适合外置配置、排除出包或删除的候选

| 判定 | 证据与原因 | 不应误删的部分 |
| --- | --- | --- |
| 宿主专用配置外置 | [`deploy/systemd/cockpit.service`](../deploy/systemd/cockpit.service)、[`deploy/nginx/cockpit.conf`](../deploy/nginx/cockpit.conf) 含特定用户、路径和外部网关依赖；server 的既有允许主机、Web [`config.ts`](../apps/web/src/lib/config.ts) 的默认开发 URL 也绑定某个部署。 | 认证入口要求、通用 Origin/CSRF、loopback 默认和可配置 API 地址仍必要；不是另造“域名模块”。 |
| 部署历史资源接线收简 | server `registerStaticWeb()` 用 `COCKPIT_ASSET_DIR` 合并外部保留的历史 hash 资源，私有 launch 负责复制/保留这些文件；它们是现行多版本部署策略的一部分。 | Web 普通静态资源服务、资源 hash 和缓存行为仍必要。只解除外部部署资源库依赖，不把前端从本体拆出去，也不假设旧浏览器会自动热替换。 |
| 开发材料不进入运行包 | 当前完整 `src` 产包会带第一方测试与诊断入口；已部署 manifest 中有 23 个第一方 `.test.ts`，另有 11 个 consumer 相关文件及两个 `.delivery` 文件。 | 普通测试、构建、lab、diagnostics 可以留仓库；不是运行业务模块，也不靠删测试降低要求。SDK 依赖内部文件不能按关键词裁剪。 |
| 小型遗留接口清理候选 | [`paths.ts`](../packages/core/src/paths.ts) 的 `sessionStorePath` 在仓内无生产调用；`copilotPath` 只见导出、该旧 helper 和测试使用，旧注释仍称 MCP 直接读 store。 | `cockpitHome()` 是当前原生 baseDirectory，必须保留。公开导出的兼容边界需核对；这些 helper 没有必要包装成模块。 |
| 退出语义与文案收简 | server 的 `restartPending`、`restarting`、`drainForRestart` 仍服务现行重启链。 | 目标应表达等待/关闭，不承诺再次启动；只调整真正的宿主重启含义，不机械替换所有原生状态词。 |

上述运行包数量仅属于记录的 a1f4a9a 产物，不是永久阈值；`module-staging` 未进入该包。
这里没有删除文件、停用 workflow、修改网关或停止真实服务。

### 不建议继续搬出的基础能力

原生 session/消息/队列/模型/计划/定时/MCP/skill 适配、真实回调和在途保护、
HTTP/SSE/schema/认证边界、普通文本 Web、草稿 ACK 与阅读窗口、错误反馈以及 graceful 退出，
都是本体的直接职责。`apps/mcp` 的通用 API 客户端也不是 Task/微信业务服务。
未来的冷 import、声明校验、同端口 MCP 命名空间和前端组合是通用宿主基础，
不能依赖一个尚未能加载的模块来加载自己。

下一步最明确的收薄对象仍是**主程序运维系统及其内嵌接线**，而不是继续按关键词
拆原生能力。当前安装使用 runner + launch；源码目标改变不自动解除这条实际依赖，
真正迁移必须另行安排启动方式、保留用户数据及历史回执，不能先停控制器再赌下次能启动。

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
失败、冷启动加载、版本应用、分 path MCP 和保留数据的卸载；不做首版热加载。
独立编译、模块目录或一个按钮样例
都不能替代真实接通；验收标准由[基础协议](module-contract-draft.md)统一维护。
