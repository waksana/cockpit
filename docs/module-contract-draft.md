# 模块接入协议

**Cockpit 0.2.4：模块包/后端 API v1，Web API v2，公共 UI v1，菜单能力 menuVersion 1。**
本地可信包、主进程 import、冷加载、模块 payload 事件及独立菜单注册已实现。
当前开发源码另提供 `chatWindowVersion: 1` 与 `composerActionsVersion: 1`：
只读当前聊天窗口与真实输入行的后置动作组合。它们不是历史 0.2.4 Release 的能力；
消费者须独立检查能力并使用配套源码导出的类型，不能仅凭 package 版本判断。
**0.2.4 配套 / 发布资产以对应 Release 为准**，本文不表示发布已完成。
配套模块为 **Cockpit File 0.1.7 / Cockpit Notification 0.1.5**，
下载和使用入口见[模块目录](module-catalog.md)。File 0.1.7 不使用已移除的
`globalNavigation` HOC，继续兼容，本轮不重新发行文件模块。

Notification 0.1.5 的精确宿主 SDK 源码 pin 为
**`e6b0b8d7c4ba7b21a0b627dc21fd61c0c53f6ac0`**，权威记录位于通知仓库
[`tooling/host-sdk.json`](https://github.com/waksana/cockpit-notification/blob/v0.1.5/tooling/host-sdk.json)。
该导出来自当时包版本仍为 **0.2.3** 的开发源码（0.2.3-development），
已经包含与本次等价、兼容的公开 API，并非历史 0.2.3 Release 的导出；
宿主升为 0.2.4 的 patch 版本变更不改变这些类型，不需要仅为版本标签改写该源码 pin。
这不等于历史 [Cockpit v0.2.3 Release](https://github.com/waksana/cockpit/releases/tag/v0.2.3)
具备新菜单/payload 能力；其 **File 0.1.7 / Notification 0.1.0** 配套及资产仍以历史 tag/Release 为准。
Web v2、UI v1 和菜单能力分别检查，不能只凭包版本判断兼容；
旧 `globalNavigation` HOC 已移除，不保留旧 Web 插口或导航 middleware 的兼容别名。
源码更新不表示已经发布、安装或重启，也不代表已安装的服务或模块已经升级。
远程签名 URL 安装、模块 HTTP MCP、角色/skill 包和通用页面贡献仍未实现。

产品边界见 [R1–R8](product-requirements.md)，文件模块的业务契约由
[cockpit-file](https://github.com/waksana/cockpit-file) 维护。
本文维护宿主当前接口与未实现目标，不复制文件业务。

**按任务阅读：**[安装模块](#2-包格式与本地安装) · [配置与数据](#3-代码数据与配置) ·
[后端接口](#4-公共-typescript-契约) · [HTTP 与资源](#5-http资产与版本) ·
[前端扩展](#6-前端注册与草稿) · [事件与退出](#7-原生观察和退出) · [后续目标](#8-后续目标)。

## 1. 当前支持范围

| 能力 | 当前源码 |
| --- | --- |
| 本地包安装 | 选择 `.tgz`，显式信任代码，验证包后复制到不可变版本目录 |
| 后端 | 在宿主 Node 进程 import 已构建的 JavaScript，返回能力声明 |
| 前端 | 同包 ESM/CSS，共用宿主 React 和主题，不新建 SPA |
| HTTP | 统一端口、模块命名空间、版本绑定的 API 与静态资源 |
| 原生观察 | 按声明类型接收已加载会话的 SDK 通知，不开启额外历史读取 |
| Web 贡献 | 声明式全局/会话菜单、真实语义组件 middleware、模块 state/service/draft、独立 Markdown link/image 注册 |
| 草稿 | 本体基础 state；模块经声明、作用域绑定的 actions 扩展，发送与 ACK 仍归本体 |
| 安装/版本选择/启停选择 | 修改下次启动选择，当前实际加载不变；不做热加载、热启停或热更新 |

文件和通知模块已经使用公开模块接口。全局文件库和文件管理页面仍在文件模块的 roadmap 中；
当前 Web 菜单注册只声明已有全局/会话菜单中的动作，不注册任意页面或 router。
manifest/后端 API v1 也不提供页面注册字段，未知字段明确拒绝。
不为尚未用到的插口预造通用组件反射或业务工作流系统。

## 2. 包格式与本地安装

包根提供 `cockpit.module.json`，例如：

```json
{
  "apiVersion": 1,
  "id": "example-module",
  "name": "Example",
  "version": "0.1.0",
  "backend": "dist/server/index.js",
  "frontend": {
    "entry": "dist/web/index.js",
    "styles": ["dist/web/styles.css"],
    "assets": ["dist/web", "dist/shared"]
  }
}
```

当前 id 使用小写字母开头的小写字母、数字和连字符，最长 64 字符，不是官方名称枚举。
后端入口为必需；前端可选。纯内容/纯前端包尚不在此版本支持范围。
包必须包含实际运行依赖，不能指望宿主自动安装 npm 包。

可选 `frontend.worker` 指向包内、已声明 assets 根下的独立 `.js` 文件，最大 1 MiB，
安装与读取使用同一上限。
依赖该字段的模块需要包含 worker 能力的宿主，旧运行包不会自动得到支持。

安装器接受普通 tar 文件/目录，支持统一的 npm `package/` 前缀；
拒绝符号链接、硬链接、特殊文件、路径逃逸、重复条目和扩展 tar header。
压缩包上限 32 MiB、展开 128 MiB、单包内文件 32 MiB、最多 8192 条目。
这些是代码包限制，不是文件模块的上传大小限制。

在 Cockpit 包根执行：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts install /absolute/path/module.tgz --trust-local-code --enable
```

`--trust-local-code` 表示信任这个包的可执行代码，**不是签名验证**。
验证完成前不 import 入口，不运行安装脚本。相同版本不同摘要拒绝覆盖，
不能覆盖当前进程仍在使用的代码。模块与 Copilot plugin 的格式和加载机制相互独立。

启用、停用和查询：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts enable example-module --version 0.1.0 --digest PACKAGE_SHA256
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts disable example-module
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts list --server http://127.0.0.1:8771
```

查询区分已安装、下次选中及当前服务实际加载状态。服务不可达时明确返回 unavailable，
不把选中状态冒充已运行。命令不会 shutdown 或 restart。

## 3. 代码、数据与配置

`COCKPIT_HOME` 是非空绝对宿主根，默认 `~/.cockpit`，只保存本体及模块内容：

```text
.cockpit/
  modules/
    config.json                    下次启动选择及每模块配置
    installed/<id>/<version>/<digest>/package/
    data/<id>/                     模块业务数据
```

Copilot 原生数据不在上面的宿主管理范围内。本体不覆盖其 baseDirectory/configDirectory，
默认 `~/.copilot` 及原生配置继续由 Copilot 决定，无需迁移或链接目录。
认证与服务使用一致的原生配置，见[安装指南](DEPLOY-PORTABLE.md)。

安装 CLI 写入 `config.json` 的 version/digest/enabled。模块参数位于对应选择的
`config` 对象；需要修改时保留 CLI 生成的身份，只更改模块文档支持的配置字段。
参数在下次冷启动传给模块。不要把秘密写进模块公开配置或源代码包。
模块停用、更新和原生 session 删除不自动删除模块数据。

## 4. 公共 TypeScript 契约

唯一代码定义由
[`packages/module-api/src/index.ts`](../packages/module-api/src/index.ts) 导出；
后端契约在该文件，Web v2 契约在
[`frontend.ts`](../packages/module-api/src/frontend.ts)。
模块构建时可以导出真实的公共类型，避免复制一份声明：

```sh
node scripts/export-module-api.mjs /absolute/new/sdk-directory
```

导出包含 module-api 和其 protocol 依赖；不包含 SDK 凭据、原生数据或 Copilot runtime。
该目录是模块构建输入，不是另一套运行时权威。

后端导出 `activate(context)`，返回 `ModuleBackend`：

| 输入/贡献 | 内容 |
| --- | --- |
| context | apiVersion、moduleId、dataRoot、apiBase、config、AbortSignal、report、invalidate、publish |
| routes | method/path、json 或 stream body、bodyLimit、handler |
| publicConfig | 明确允许浏览器读取的少量配置，不默认公开整个 config |
| events | 事件类型列表与只读处理器 |
| controlEvents | 按 ServerEvent 类型选择宿主已有原生控制投影；不是重新读取原生会话 |
| dispose | 非阻塞的资源释放入口，不进入宿主 graceful 等待链 |

模块返回声明，不取得根 Fastify、Engine 私有状态或原生 session handle。
宿主先在未监听候选中校验路由，再注册到主服务；失败和超时归属具体模块。
同进程无法隔离无限同步计算、OOM、process.exit 等行为，不提供安全沙箱。

## 5. HTTP、资产与版本

当前入口：

```text
GET /_modules
/_modules/<id>/<digest>/api/...
/_modules/assets/<id>/<digest>/<declared-path>
/_modules/workers/<id>/worker.js
```

bootstrap 返回实际成功的前端模块、backend-only 的 active 状态及错误/诊断。
错误列表不自动等于该模块已经停止；实际运行身份以 active/modules 为准。
前端 entry/styles 只允许声明的资源根，API 与资源 URL 都绑定包摘要。

模块通过 `context.request` 请求相对 API 路径，宿主客户端设置凭据和
`x-cockpit-module-digest`。变更方法要求匹配的摘要；
GET/HEAD 可不带此 header，以支持 img/video 等，但 URL 已绑定版本。
提供了错误 header 时仍拒绝。旧摘要路径没有指向新模块的兼容回退。
认证和来源保护仍由统一宿主入口承担，摘要不是身份认证。

上传走声明的流式 body，只接受 application/octet-stream，并在正文解析前拒绝其他类型，
不为此增加全局 JSON 上限。
模块返回 Node Readable 时，宿主负责响应归属、取消和销毁，包括断开后才返回的流。
所有模块 HTTP 请求不自动成为原生 busy 或 graceful 等待项。

`context.invalidate()` 在已成功加载、仍活跃的模块中向既有 `/events` 发送
`module/invalidated { moduleId }`。它只是重新读取模块状态的提示，不承载业务数据或原生消息，
不存储/重放模块状态，不增加每模块 SSE 连接，也不影响 graceful 的忙闲条件。
消费者重连应自行重新读取模块状态，不能将提示当作可靠事件日志。

**当前已实现的通用数据事件：** `context.publish(payload)` 使用同一 `/events` 连接发送
`module/event { moduleId, payload }`。moduleId 由宿主实际加载身份绑定，模块不能指定另一模块或伪造原生事件。
payload 为 JSON 数据，最大 64 KiB；宿主拒绝不合法或超限数据，不静默截断、丢字段或回退为空值。
发布时固定数据副本，调用方的后续修改不改变已排队内容。
只有成功激活且仍存活的模块能够发布；失败按模块归属报告，不回滚模块已经完成的业务事务。

Web 的 `context.onEvent(listener)` 只接收当前模块的 payload，随模块作用域撤销监听。
本体不理解其中的业务 schema、版本、未读、文件或推送含义，也不维护第二份模块状态。
此扩展没有新增长连接、原生历史事件、重放日志、业务等待或逐消息 ACK。
它与原有 invalidate 提示兼容共存；是否发送完整数据、增量或同步提示由模块决定，
丢失、断线和重连恢复也由模块自己的 state 管理。

worker 使用稳定的模块专属 URL 和相同目录 scope，`Service-Worker-Allowed: ./`，
不能控制 Chat 或根页面。宿主不自动注册、不申请通知权限、不实现 push/角标业务。
只有当前成功加载且声明 worker 的包能被服务，每次读取核对包内大小和摘要，响应不缓存。
脚本前置 `self.__cockpitModuleWorker`，仅含 moduleId、digest 和相对于 worker 的 apiBase；
部署前缀保留，不包含模块秘密。模块 worker 必须独立打包，沿标准注册 API 管理自己的生命周期。
停用模块后该入口不可用；已有浏览器注册和订阅不会因服务端停止而神奇消失，
模块须提供明确取消订阅入口并说明浏览器离线清理边界。

## 6. 前端注册与草稿

浏览器入口同样导出 `activate(context)`，但前端 context 和返回声明都要求 `apiVersion: 2`。
这不改变 manifest、后端 context 或 HTTP API 的 v1。
context 提供宿主现有 React、ReactDOM `createPortal`、state、
apiBase、公开配置、request、signal、onInvalidate、onEvent 和 report。
模块不得自建 root 或依赖私有 DOM/store。
宿主并行初始化不同前端模块；单个超时/错误不阻塞其他模块，晚结果不能重新发布已撤销贡献。

当前宿主另提供 `context.uiVersion: 1`，声明已实现的公共语义 CSS 与图标规范。
精确类名、变量、兼容条件、两仓交付顺序与可运行示例统一维护在
[模块 UI 开发指南](module-ui-guide.md)。这是前端 additive 能力，不是新的 manifest 字段；
依赖 UI v1 的模块必须检查该字段并明确拒绝不兼容激活，不能只看宿主 package 版本。

菜单注册另由 **`context.menuVersion: 1`** 声明；使用菜单的模块必须独立检查此能力。
它不是 `apiVersion` 或 `uiVersion` 的别名，也不是兼容旧导航接口的开关；
缺少或不支持该能力时明确拒绝激活，不能回退到旧接口。

模块 UI 与本体共同遵循[交互语义与结构正确性要求](DEVELOPMENT.md#interaction-semantics-and-structural-correctness)。
Web 模块集成有四种不同机制，不能相互伪装：

| 机制 | 责任 |
| --- | --- |
| 菜单声明 | 向本体已有全局/会话菜单声明动作和展示状态，不包装导航组件 |
| 语义组件 middleware | 增强已有真实组件的 props/children/ref，不制造空插口 |
| State/service/draft | 模块业务状态、订阅、异步操作与草稿 schema，复用模块已有服务 |
| Markdown 注册 | 已解析 link/image 的独立渲染规则，不是通用组件或菜单机制 |

不得把业务 dispatcher、旧 slot 或空组件改名后当作通用机制；基础设施不能承担模块业务。
文件选择/上传和通知/已读/push 策略均由模块拥有。本体只提供通用状态生命周期、组件契约和原生操作适配。
`context.createPortal(children, container)` 是宿主现有 ReactDOM 的原函数，
返回 `ReactPortal`；container 为 `Element | DocumentFragment`。
它只提供通用 React 挂载，不管理弹窗业务、焦点或状态，也不是模块页面注册机制。
模块可将自己拥有的原生 dialog 挂到标准 `document.body`，避免置于 Markdown 行内节点；
组件卸载/作用域撤销时必须关闭并卸载，保留原生焦点返回。不得操作宿主私有 DOM。

当前 `ModuleFrontend` 返回字段：

| 字段 | 用途 |
| --- | --- |
| apiVersion | 必须为 2；旧 Web 声明明确拒绝 |
| writes | 当前仅声明基础 text 编辑；模块字段经自己注册的 schema 修改，不是安全隔离 |
| components | `{ id, boundary, order?, wrap }`，wrap 接收基础组件并返回增强组件 |
| menus | `ModuleMenuRegistration[]`，声明已有全局/会话菜单的动作，见 [6.5](#65-菜单注册) |
| markdown | 已解析 link/image 节点的排他渲染规则；不处理附件 |
| dispose | 释放前端自己持有的资源；注册 state 的 disposer 由宿主单独执行 |

### 6.1 State 扩展

`context.state.register({ id, create, dispose })` 在前端激活阶段同步创建一次服务，
返回保留具体类型的 handle；`handle.get()` 取得该实例，撤销后明确失败。
服务可以复用已有 store，或持有按草稿/资源键分组的多个 store，不要求复制一份全局消息数据库。
快照、选择器、订阅、HTTP actions 和异步资源由服务自己管理；框架不自动持久化或重试。
创建函数不能返回 Promise，初始网络读取由已创建服务执行，不阻塞普通聊天渲染。

`context.state.host` 仅提供 `sessionId/visible/connected` 三个只读基础字段；
它没有消息列表、会话标题或当前问题正文。
`context.state.chatWindow` 提供另一个只读当前窗口快照，见[窗口数据](#chat-window-state)。
注册服务或调用 `handle.get()` 本身不会自动取得聊天数据，服务需显式读取对应公共来源。
`onInvalidate` 仍是本模块的既有 SSE 变化提示，不携带完整业务 state。
`onEvent` 是同一传输中按模块归属的数据出口；模块 state 可消费自己的 payload，
不能把它注入原生会话 store。依赖新能力的模块须检查配套 SDK/运行时，不以旧发行版本号假定存在。
模块扩展消息/session 的组合视图，不覆盖原生数据或派生另一份原生权威；
未加载和读取失败不能伪造成 false/零。

草稿也是本体基础 state，但基础快照不内建附件或其他模块字段。
它只包含文字、文字修订、pending/unconfirmed、通用阻止和聚合 hasContent。
`DraftReference` 带稳定生命周期 id、sessionId 和 purpose；
`context.state.bindDraft(reference)` 提供文字编辑及通用阻止，不暴露私有 store、
附件方法或通用 native patch/submit/ACK/reset。

模块通过同一个 state 注册体系的 `registerDraft` 扩展自己的草稿 schema：

| 成员 | 责任 |
| --- | --- |
| id / purposes | 模块内唯一身份及适用草稿类型，不按当前路由重定向已有引用 |
| create / validate | 同步初值、数据形状与规范化；失败不替换成空值 |
| hasContent | 声明该字段是否提供内容，不把 schema 存在当成有内容 |
| project | 将捕获值显式映射到当前既有原生接口的附加参数 |
| acknowledge | 结合当前值与捕获值，只清理确认提交的部分，保留并发修改 |
| persistence | 可选的模块自有字符串编码、恢复和旧记录迁移 |

handle 的 `forDraft(reference)` 返回稳定的字段 scope，或因 purpose 不适用返回 undefined。
scope 提供只读快照、订阅和仅修改自己字段的验证型 update；不是任意改写本体 state。
文件模块在这里定义附件、校验、上限、顺序、持久化与原生 attachments 投影。
本体只负责通用事务，拒绝覆盖文字/session/request 等保留参数和同次提交中的字段冲突，
并按既有原生接口验证投影，不静默丢弃未知参数。

未注册 schema 的序列化 namespace 和原始记录保持不透明，不参与当前 hasContent、
展示或发送，也不制造文件兜底 UI、阻止或清空操作。普通文字仍可发送。
恢复、旧字段迁移和提交后空值标记由模块 schema 完成，防止旧记录重新导入。

<a id="chat-window-state"></a>
#### 当前窗口的只读数据

依赖此能力须检查 `context.chatWindowVersion === 1`。通过
`context.state.chatWindow.getSnapshot()` / `subscribe(listener)` 读取已有窗口；
没有 session 参数、历史加载、分页、刷新或写入动作，不增加 HTTP、SSE 或 SDK 读取。
只对当前活动 session 可见，切换时不会把上一会话的数据套到新身份。

| 字段 | 含义 |
| --- | --- |
| sessionId | 当前活动会话，未选择时为 null |
| status | `unavailable` 尚无窗口；`loading` 首次读取中；`ready` 已有有效窗口；`stale` 失效或断线；`error` 当前历史读取失败 |
| hasMore / partial | 更早历史是否仍可读、窗口是否存在已知片段/归属边界；ready 不代表全历史完整 |
| error | 已有窗口读取错误，不把失败伪造成空会话 |
| messages | 当前已加载的根消息，保留窗口顺序；各消息的 children 保留子 Agent 层级及其各自顺序 |

每条 `ChatWindowMessage` 只投影 `id/origin/role/text/complete/subtype/children`。
`id` 是展示身份，`origin` 才是原生 session/message/agent 归属；未知归属为 null，
不按组件挂载顺序、时间戳或猜测的原生 ID 重排。`complete` 不把流式片段或已知不完整内容当定稿。
`text` 只取现有消息 content，不额外导出 thought、toolCalls、attachments、
私有 store 或原生 session handle。
原生问题的结构化正文不在这个接口中。

快照和节点只读冻结；同一输入返回稳定引用，未变化的消息复用投影，
没有消费者读取时不额外复制逐消息元数据。订阅随模块 scope 撤销，停止后的读取明确失败。
空的 ready 窗口和尚未加载/失效/失败可区分；保留的旧内容不自动变成当前权威内容。
模块自行选择角色、完成状态、截取长度与使用时机；本体没有“最近回复”或语音提示词策略。

### 6.2 Component middleware

| boundary | 基础组件契约 |
| --- | --- |
| message | 原生消息/宿主当前 ask 身份、完成事实、实际正文 bodyRef、children 与真实 adornment 节点 |
| sessionStatus | 原生回复中/错误/待选择状态和非交互 children，不嵌套按钮 |
| composer | 实际输入卡片及其原生问题内容，组合 children；不预建附件组 |
| composerEditor | 实际输入行、文字编辑器和发送控件；普通 DOM props/children/ref 及 actions，不解释文件或语音事件 |
| attachment | 一项原生历史附件、消息归属、基础显示及附加动作；不承担草稿附件列表 |
| managementHeader | 实际管理列表标题栏，包含返回、标题和刷新控件 |
| managementDetailHeader | 实际管理详情标题栏，包含返回和标题焦点行为 |

Middleware 按 `(order, moduleId, id)` 排列，较小者在外层。
组合只在注册或基础组件变化时创建，不在每次消息、草稿或未读更新时生成新的组件类型。
增强器必须保留继承的 children、refs、actions、原生身份与滚动锚点。
React 增强链和错误边界不产生 HTML；不为注册项增加空 div/span 占位。
新增业务节点通过原组件的正常 props/children 组合，不能产生视觉嵌套或改变原有布局。
每个 boundary 的默认实现必须承担真实现有界面职责。禁止专门插入一个只返回 children、
生产环境无基础内容的“全局动作”空边界；有 HOC 包装不等于不是 slot。

输入行动作须检查 `context.composerActionsVersion === 1`：
`ComposerEditorProps.children` 仍在文字编辑器前，`actions` 在编辑器后、既有发送按钮前。
增强器保留并组合继承的 actions，不替换原生发送按钮、编辑器或其门槛。
两者直接作为真实输入行的兄弟节点，不增加空容器或新的空组件边界；
DOM/键盘顺序与视觉顺序一致，不用私有 CSS 把前置节点搬到后面。
模块根据具体草稿/原生输入门槛决定自己的动作是否可用，不自动继承文件模块的 prompt-only 策略。

message 的 bodyRef 指向实际正文或当前 ask 的问题，不含 byline、滚动外框或选择按钮。
ask 使用宿主当前 AskRequest.requestId，不冒充 SDK requestId。
模块可观察该元素，但不能查询私有 DOM、移动正文或写入滚动位置。
边缘标记使用现有内容外侧留白，出现/消失不能改变宽度、换行、行高或输入框对齐；
标记非交互但可以提供可访问说明。阅读阈值、未读数据和红线策略仍属于模块，
本体不计算阅读完成、不维护红线或通知业务。

### 6.3 草稿与文件输入

本体按 session 保留普通 prompt 草稿，并为每个实际原生决策请求选择独立草稿。
ask/plan/elicitation 使用 kind 与当前宿主 requestId；不是复制、清空再覆盖同一份 prompt。
请求结束后恢复普通草稿，替换请求使用新的草稿身份；失败/未知回答保留自己的输入。
选择操作和迟到回执不能提交或清理普通草稿的字段。

文件 schema 仅适用于 prompt。文件模块从自己的字段和上传服务渲染完整就绪/上传中列表，
作为 Composer 的真实 children 放在输入框上方；切换到回答草稿后自然不再显示，
不需要附件隐藏标志、不兼容附件警告、预先生成的附件组或新的列表插口。
后台上传仍绑定原 prompt 草稿，返回后可见其结果。

本体捕获一次文字修订、适用字段与提交 token。只有实际确认成功才清理匹配的文字修订，
并调用参与字段的 acknowledge；旧草稿、旧 schema generation 或失败的清理不能冒充成功。
网络未知/失败保留数据，不自动重试。模块拥有附件操作与持久化，本体不删除服务器原件。
每次持久化修改都核对上次读取/写入的原始记录；旧实例的字段更新、文字编辑或 ACK
不能覆盖新实例的记录，也不能重新写回旧提交 token。
pending 期间文件操作规则由模块执行；本体的文字编辑和原生提交门槛仍有效。
模块/schema 不可用时释放其通用阻止，不转为 orphan 文件提示，其他模块状态不受影响。

文件模块通过 composerEditor middleware 的普通 onPaste/onDrop/onDragOver 和 children
增强实际输入行；自己的 state/service 创建选择器、捕获草稿、接纳文件、上传并清理监听。
本体没有 onFiles/pickFiles、文件回调身份表、选择事务或 receiveFiles dispatcher。
模块在打开选择器时捕获自己的稳定草稿引用，迟到结果不改投到当前会话或回答草稿；
取消或模块释放时由模块撤销回调。普通 DOM 事件链遵循 defaultPrevented，
业务异常由模块报告，不能依赖本体的文件专用回调包装。
混合剪贴板文字、IME、原生提交快捷键和基于真实状态的发送门槛保持不变。
模块/schema 缺失时本体不处理或保存文件、不新增恢复 UI，普通文字仍可发送。

### 6.4 Markdown 注册与资源生命周期

Markdown 渲染上下文保留原生消息身份和原始解析目标，不使用 HAST 规范化后的 URL
代替模块引用键。主/子 Agent 保留真实根 session 身份。
无匹配时保留默认内容；多个排他规则匹配时报告冲突并回退，不按下载顺序覆盖。
原生附件消息不因正文为空而被丢弃。
历史展示使用 `NativeAttachmentDescriptor`，与严格的发送参数 `NativeAttachment` 分开：
blob 的 data 缺失或带 omittedReason 时仍保留名称、MIME 和不可用原因，
没有模块渲染器时显示基本文字占位，不伪造空 blob，也不补抓字节。

Markdown 注册只接收 link/image，原生历史附件走 attachment middleware；
草稿附件的完整列表和单项操作属于文件模块自己的 Composer 增强。
模块不重新解析完整 Markdown；替代输出保持行内 phrasing 结构，
dialog 使用 body portal，不嵌入链接或段落。相同目标的资源请求可在模块 state 中复用。

同模块所有 state、draft、components、menus 和 Markdown 注册 ID 必须唯一；
宿主身份带 moduleId 命名空间，不会因不同模块使用相同局部 ID 而混淆。
激活先暂存注册，整体校验后才发布；失败/超时回滚已经创建的 state。
停止时立即撤销草稿绑定、活动 schema 及其阻止，但暂缓草稿通知；
完成服务清理和退订、更新模块列表后，再通知最终状态，避免消费者通过已撤销 handle 回读。
state disposer 逆注册顺序执行一次，某个清理失败不能阻止其他清理。
state 作用域不等于组件挂载范围：切换会话不能取消仍属于原草稿的上传。
页面 state 清理也不等于注销设备推送订阅或关闭后端模块。

### 6.5 菜单注册

`ModuleFrontend.menus` 中每项为 `ModuleMenuRegistration`：

```ts
interface ModuleMenuRegistration {
  id: string;
  menu: 'global' | 'session';
  order?: number;
  getState(
    target: Readonly<{ menu: 'global' } | { menu: 'session'; sessionId: string }>,
  ): ModuleMenuState;
  subscribe?(listener: () => void): () => void;
  onSelect(
    target: Readonly<{ menu: 'global' } | { menu: 'session'; sessionId: string }>,
    context: { signal: AbortSignal },
  ): void | Promise<void>;
}
```

`order` 必须是有限数，省略按 0 排序。宿主保留原生菜单项在前，
随后按 `(order ?? 0, moduleId, id)` 稳定排列模块项，并规范化分隔线，
不留下开头、结尾或连续分隔线。模块不能替换、重排或吞掉原生项。

`target` 是判别联合 `{ menu: 'global' } | { menu: 'session', sessionId: string }`。
宿主捕获并冻结原始目标，状态读取与动作使用该目标，不按当前活动路由重定向。
会话模块动作要求前端已应用当前完整 snapshot、连接处于 open 且目标存在于该视图中；
不可用或未知的目标拒绝使用，不靠旧元数据猜测，也不为菜单复制原生 store 或额外加载会话。
这一门槛不改变原生导航已有的离线行为。
这是前端生命周期保护，不证明 API 授权或替代后端的真实校验。

`ModuleMenuState` 为：

```ts
interface ModuleMenuState {
  label: string;
  icon?: ReactNode;
  visible?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}
```

`getState` 必须同步、纯读取；网络请求、状态变更和业务副作用放在模块已有 service/action 中。
`subscribe` 可监听同一模块服务并返回退订函数，变化时通知宿主重新读取，
不建立菜单专属的原生状态镜像。订阅属于整个模块激活作用域，不随菜单每次打开重复建立。
订阅初始化失败会回滚模块激活；退订失败报告错误，但继续其余清理。
`getState` 抛错或返回不合法展示状态时，只省略并报告该命令，保留健康贡献，
与 Markdown predicate 的错误隔离一致。图标渲染失败只去掉图标并报告，命令仍保留。
`icon` 仅作装饰，不内嵌按钮或另一套菜单交互。
可见性、禁用和分隔需求是声明；宿主负责实际菜单的键盘、焦点、关闭与焦点返回。
点击时再次核对目标和最新 visible/disabled，不能以曾经渲染过的可用状态执行。

`onSelect` 收到该次动作的 `AbortSignal`。异步操作始终绑定原始 session；
宿主按注册项与目标组合防止重复并发执行。普通同步/异步动作错误只报告，不撤销健康贡献。
模块停止、目标丢失或连接状态未知时信号中止，陈旧菜单回调拒绝执行。
普通菜单关闭或路由切换不会取消已经接纳的动作，也不会把尚未接纳的旧回调变为新的动作。
中止立即释放宿主的动作跟踪，不等待模块 Promise；晚完成不能重新发布已撤销贡献或恢复旧动作。
宿主不将返回数据写入任何状态；模块必须在 `await` 后检查 signal，
自行隔离晚结果、处理错误和业务状态。中止信号不证明已发出的后端副作用已被撤销。
菜单动作可以开启模块自己拥有的 UI，但不取得任意页面或 router 注册能力。

## 7. 原生观察和退出

原生通知通过 `Engine.onNativeEvent` 的类型过滤出口提供；
没有感兴趣观察者的事件不额外遍历大 payload。
工作目录随经过验证的 root context-change 更新，不增加逐事件 metadata RPC。
观察返回值不替换原生事件，错误不污染原生控制状态。

`controlEvents` 接收类型过滤后的已有 ServerEvent 副本，可观察当前 ask 出现/消失、
会话删除和历史失效等原生控制事实；不额外获取 snapshot 或加载会话。
订阅和失效通知随模块 scope 关闭一起撤销。副作用和持久化仍属于模块。

`NativeObservation` 是冻结的只读快照；`cwd` 与可选的
`readonly workspacePath?: string | null` 相互独立。后者直接读取当前归属该会话的
SDK `CopilotSession.workspacePath`：字符串是 SDK 提供的原生 workspace 绝对路径；
已有 handle 但 SDK 未关联 workspace（getter 返回 `undefined`）时为 `null`。
创建或恢复期间、SDK handle 尚未返回的早期通知省略此字段，表示未知，不表示没有 workspace。
路径格式无效或 getter 抛错时报告观察失败，该通知仍以省略字段的未知状态交付，不回退到 `cwd`。
宿主不缓存、推导或管理原生 workspace 路径，不为此增加 RPC、加载其他会话或缓冲通知；
模块自行处理上下文不可用，宿主不承担文件解析业务。

它是已加载 session 的既有 SDK 通知，不是新的后台 eventLog reader。
文件模块仅处理实际启用后的新实时输出；历史读取保持原样，不因浏览而捕获文件。
原生消息、上下文、队列和配置开关仍只有 Copilot 一个权威。

graceful 仍只等待原生工作和必要的原生在途操作。
进入关闭后，宿主撤销模块 scope、订阅与流，不等待业务排空或模块 close 回执。
模块持久化必须在正常工作时完成，不依赖退出回调获得保证的保存窗口。

## 8. 后续目标

模块坚持主进程可信 import 和冷加载，安装及版本选择由下次启动生效。
热加载、热启停和热更新不是后续目标，不为其预留业务框架或改进程模型。
本体独立系统页面的只读版本/模块状态展示与安全退出范围见
[R6](product-requirements.md#r6--自然交互产品取舍明确)，不纳入本次菜单注册实现，
也不增加首版模块管理操作或替代现有安装 CLI。

- 远程 HTTPS 签名发行描述、发布者信任与更新选择；在验证前不执行代码。
- 同端口独立 HTTP MCP path，每模块工具表/协议会话隔离，不隐式修改原生 MCP 配置。
- 角色/skill 等内容包与下次启动消息模块，保持各自业务和原生状态边界。

这些尚未实现，不应通过当前 API v1 的未知字段或旧原型入口模拟。
已有菜单动作声明不等于任意页面/router 注册；当前没有此类公开注册入口。
实施范围以 [模块目录](module-catalog.md)及明确的产品决定为准。
