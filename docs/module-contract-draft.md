# 模块接入协议

**经典界面（`/`）是主要界面；独立 `/next/` 仅为实验界面。**
模块 UI 请求默认针对经典版，不要求同步新版适配；范围与共享契约边界见
[前端规范](frontend-guidelines.md#classic-primary-ui)。
0.3.0 开发源码新增的实验入口通过可选 `frontend.next` 选择模块展示。
新版使用 `ModuleNextFrontendContext.ui.version === 1` 的实际宿主 React 组件，
不声明经典 `uiVersion` / `uiSurfaceVersion` CSS 能力。配套 SDK 源码为
`0fa433d99c053df2caf80770f0f8762b9ed7002e`；这是可获取的开发提交，不是已发行或已部署的证明。
具体组件与展示边界见[独立新版 UI](module-ui-guide.md#independent-new-ui)。
下述历史版本配套记录不表示旧发行包具有该新增能力。

**Cockpit 0.2.5：模块包/后端 API v1，Web API v2，公共 UI v1，菜单能力 menuVersion 1。**
本地可信包、主进程 import、冷加载、模块 payload 事件及独立菜单注册已实现。
当前开发源码另提供 `chatWindowVersion: 1`、`composerInputVersion: 1`、
`draftLifecycleVersion: 1` 与 `draftSubmissionVersion: 1`：
只读当前聊天窗口、真实受控 textarea 的组件增强、草稿永久退休/原子修订写入及明确授权的一次性原稿提交。它们不是历史 0.2.4 Release 的能力；
消费者须独立检查能力并使用配套源码导出的类型，不能仅凭 package 版本判断。
**0.2.5 尚待发行**，本文不表示发布已完成。语音配套源码为 **Cockpit Speech 0.1.1**，
精确 SDK 提交由语音仓库 `tooling/host-sdk.json` 记录，必须先导出该干净提交再构建。
旧语音消费者不能与本次真实输入组件契约混用，没有兼容别名。
现有配套模块 **Cockpit File 0.1.7 / Cockpit Notification 0.1.5** 不受此次输入边界变更影响，
下载和使用入口见[模块目录](module-catalog.md)。File 0.1.7 不使用已移除的
`globalNavigation` HOC，继续兼容，本轮不重新发行文件模块。

Notification 0.1.5 的精确宿主 SDK 源码 pin 为
**`e6b0b8d7c4ba7b21a0b627dc21fd61c0c53f6ac0`**，权威记录位于通知仓库
[`tooling/host-sdk.json`](https://github.com/waksana/cockpit-notification/blob/v0.1.5/tooling/host-sdk.json)。
该导出来自当时包版本仍为 **0.2.3** 的开发源码（0.2.3-development），
已经包含通知所消费的等价、兼容公开 API，并非历史 0.2.3 Release 的导出；
宿主升为 0.2.4 的 patch 版本变更不改变这些类型，不需要仅为版本标签改写该源码 pin。
这不等于历史 [Cockpit v0.2.3 Release](https://github.com/waksana/cockpit/releases/tag/v0.2.3)
具备新菜单/payload 能力；其 **File 0.1.7 / Notification 0.1.0** 配套及资产仍以历史 tag/Release 为准。
Web v2、UI v1 和菜单能力分别检查，不能只凭包版本判断兼容；
旧 `globalNavigation` HOC 已移除，不保留旧 Web 插口或导航 middleware 的兼容别名。
源码更新不表示已经发布、安装或重启，也不代表已安装的服务或模块已经升级。
远程签名 URL 安装和通用页面贡献仍未实现。当前开发源码新增创建时/已有空闲会话角色装配与
模块自有 HTTP MCP 配置（下文 4.4）；不表示历史发行版具备这些能力。

产品边界见 [R1–R8](product-requirements.md)，文件模块的业务契约由
[cockpit-file](https://github.com/waksana/cockpit-file) 维护。
本文维护宿主当前接口与未实现目标，不复制文件业务。

**按任务阅读：**[安装模块](#2-包格式与本地安装) · [配置与数据](#3-代码数据与配置) ·
[公共接口速查](#public-api-map) · [数据可见范围](#public-data-boundaries) ·
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

可选 `frontend.next` 的形状为 `{ "entry": "dist/web/next/index.js",
"styles": ["dist/web/next/styles.css"] }`；`styles` 可省略，表示没有额外新版样式，
不继承经典样式。入口和样式必须位于同一包的 `frontend.assets` 根中，并接受相同
路径/文件校验和不可变摘要约束。经典入口仅加载原来的 `entry` / `styles`；
新版仅加载明确声明的 `next`。缺少新版声明只表示该展示不可用，不能据此判定后端停用。
旧宿主可能拒绝此新增 manifest 字段，双入口模块须明确要求配套 0.3.0 宿主能力。

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
开发者须在发布或部署不同包内容前递增版本并同步元数据，不是每次提交都递增；
固定源码 SHA 不能替代版本号。详见[不可变交付版本规则](packaging.md#delivery-versions)。

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
  session-roles/<sessionId>.json    已保存的角色选择；不是原生能力缓存
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
| context | apiVersion、serviceReadyVersion、moduleId、dataRoot、apiBase、config、AbortSignal、report、invalidate、publish、host.call |
| routes | method/path、json 或 stream body、bodyLimit、handler |
| publicConfig | 明确允许浏览器读取的少量配置，不默认公开整个 config |
| events | 事件类型列表与只读处理器 |
| controlEvents | 按 ServerEvent 类型选择宿主已有原生控制投影；不是重新读取原生会话 |
| onReady | 可选的一次性服务就绪回调；原生 runtime 已启动且公共 HTTP 已监听后调用 |
| dispose | 非阻塞的资源释放入口，不进入宿主 graceful 等待链 |

模块返回声明，不取得根 Fastify、Engine 私有状态或原生 session handle。
宿主先在未监听候选中校验路由，再注册到主服务；失败和超时归属具体模块。
同进程无法隔离无限同步计算、OOM、process.exit 等行为，不提供安全沙箱。

`onReady?(): void | Promise<void>` 是当前开发源码新增的后端可选贡献，API 仍为 v1；
不声明它的旧模块行为不变。使用它的消费者须配对包含此能力的宿主源码，
并在 `activate(context)` 中检查只读能力标记 `context.serviceReadyVersion === 1`。
旧宿主没有该字段；依赖回调的模块应在启动业务前明确抛错，不得默默忽略、
回退到 `agent/status`、入站请求或轮询。不能以 `apiVersion: 1` 判断是否支持；
旧宿主还会拒绝未知贡献字段。
能力检查必须先于打开、创建或迁移模块自己的持久化数据，避免不支持的宿主留下部分业务变更。

```ts
if (context.serviceReadyVersion !== 1) {
  throw new Error('This module requires a host with serviceReadyVersion: 1');
}
```

宿主在 `runtime.start()` 和公共 HTTP `listen()` 都成功后，对每个成功激活的模块调用一次；
此时本模块已声明的 HTTP 路由也已生效，回调中的 `host.call` 可以连接同一模块的 HTTP MCP；
这不替代原生连接结果或显式角色 readiness 检查。
`activate()`、Fastify `ready()`/注入请求及较早的 `agent/status: up` 都不是这个信号。
无需任何外部请求或轮询。启动/监听失败或就绪前已开始 shutdown 时不调用；
scope 已关闭的模块也不调用。安装、启停和版本选择仍只在下次冷启动生效，
不在运行中重新激活或重放回调；下次冷启动的新激活会再次收到一次。

回调的 Promise 不阻塞其他模块、服务启动或 graceful 退出。同步异常及 Promise 拒绝
沿现有模块错误报告入口记录日志并显示在 `/_modules.errors`，不隐式重试、卸载模块或发送替代事件。
模块使用原 `context.signal` 协作取消，并在 `await` 后重新检查；
关闭会 abort 该 signal，宿主不等待业务完成。通过 `context.host.call` 发起的原生调用
仍遵循既有 shutdown admission 和在途保护，模块就绪业务本身不进入等待链。
此回调只保证调用时的本地服务就绪，不保证认证、特定会话/角色能力、外部网关或业务投递成功；
持久化、恢复策略、幂等性及未知结果仍由模块负责。

<a id="public-api-map"></a>
### 4.1 公共接口速查

这里的“公共接口”指宿主显式传给模块的契约，不等于模块可以取得本体所有状态。
类型完整定义仍以上方两个源码文件为准；下面按用途列出入口和作用域，不复制另一套类型注册表。
原生 HTTP/MCP 产品操作是另一层接口，由 [`/capabilities`](../apps/mcp/README.md#discover-and-invoke-the-api)
发现，不能把某个原生 intent 存在理解为前端 `context` 已自动暴露它。

| 入口 | 当前实际提供 | 作用域与限制 |
| --- | --- | --- |
| 前端版本与运行基础 | `apiVersion: 2`、`menuVersion: 1`、`moduleId`、宿主 `react`、`createPortal`、`signal`、`report` | 同一模块激活生命周期；能力分别检查，不另建 React root |
| 展示能力 | 经典：`uiVersion: 1` / `uiSurfaceVersion: 1`；新版：`ui.version: 1` 及公开 React 组件 | 入口分别检查；不混用两套样式或不同实例的复合组件 |
| 前端模块 API | `apiBase`、公开 `config`、`request(path, init)` | 请求只到本模块的摘要绑定 API，带既有认证；不是任意原生 API 代理，公开配置不能含长期密钥 |
| 前端模块事件 | `onEvent(listener)`、`onInvalidate(listener)` | 只接收本模块 payload/失效提示，沿用既有 SSE；不是原生聊天事件订阅 |
| 宿主基础 state | `context.state.host.getSnapshot()` / `subscribe()` | 只有当前 `sessionId`、页面 `visible`、连接 `connected` |
| 当前已加载聊天窗口 | `context.state.chatWindow.getSnapshot()` / `subscribe()`，检查 `chatWindowVersion: 1` | 只读消息文字、归属、层级、顺序和窗口可用状态；不补读历史，不内置“最近回复”策略 |
| 模块 state/service | `context.state.register({ id, create, dispose })`，返回 `handle.get()` | 创建并取得模块自己的服务；其数据来源、查询与方法由模块实现，不自动注入聊天数据 |
| 草稿读取与编辑 | `context.state.bindDraft(reference)`，草稿 `getSnapshot()` / `subscribe()`、`editText(text)`、`block(reason)` | 绑定具体草稿生命周期；文字编辑需声明 `writes: ['text']`，不暴露通用原生提交/ACK/reset |
| 后台草稿完成 | 检查 `draftLifecycleVersion: 1`；`editTextIfRevision(text, revision)`、快照 `retired` | 原子校验修订、pending/unconfirmed/所有租约；永久退休可订阅，不把导航、隐藏、断线或 unload 当成删除 |
| 一次性原稿提交 | 检查 `draftSubmissionVersion: 1`；声明 `sends: ['draft']`，`captureSend().send(expectedRevision)` | 明确用户同意时捕获原稿及字段变更检查点；保留原生投影与 ACK，不能指定任意目标或 payload |
| 草稿字段扩展 | `context.state.registerDraft(...)`，`forDraft(reference)`、字段 `getSnapshot()` / `subscribe()` / `update()` | 模块拥有 schema、校验、内容判定、投影、ACK 和可选持久化；不能修改别的模块字段 |
| 菜单声明 | 返回 `menus`：`getState(target)`、可选 `subscribe`、`onSelect(target, { signal })` | 全局与指定 session 命令；本体保留原生项、渲染及焦点，不提供任意页面/router 注册 |
| 组件增强 | 返回 `components`：按 boundary 提供 `wrap(Base)` | 只增强公开的真实组件，保留 props/children/ref；具体边界见 [6.2](#62-component-middleware) |
| 真实文字输入 | `ComposerInputProps`，检查 `composerInputVersion: 1` | 包装承担受控编辑与 IME/键盘行为的 textarea Base；保留原生 props/events/ref，不能替换宿主发送 |
| Markdown 渲染 | 返回 `markdown`：`matches(node)`、`component` | 已解析 link/image 的目标、标签和消息归属；不是整份正文、附件或完整聊天解析接口 |
| 模块 worker | 可选 `context.worker: { entry, scope }` | 宿主提供同包窄作用域资源地址，模块自行注册；不自动控制 Chat、申请权限或订阅 push |
| 后端基础 context | `apiVersion: 1`、`moduleId`、`dataRoot`、`apiBase`、只读 `config`、`signal`、`report` | 模块私有数据与资源生命周期；不取得 Engine、根 Fastify 或 SDK session handle |
| 后端 HTTP 与公开配置 | 返回 `routes`、可选 `publicConfig` | 路由接收正文/查询/参数/headers/signal，返回状态/headers/body 或响应流；不直接开放 WebSocket upgrade |
| 后端服务就绪 | 检查 `context.serviceReadyVersion === 1`；返回可选 `onReady()` | runtime 启动且 HTTP 监听成功后每次冷激活调用一次；非阻塞、无重试，使用 context.signal 取消 |
| 后端观察与发布 | 返回 `events` / `controlEvents`；调用 `publish(payload)` / `invalidate()` | 观察已有原生通知/控制投影，发布自己的模块事件；不修改原生事实、不自动读取历史 |

例如，组件调用 `serviceHandle.get().getSnapshot()` 时，
第一层 `get()` 只是取得已注册的服务，第二层 `getSnapshot()` 是该服务自己定义的方法。
服务也可以提供明确的 `getExcerpt()` 等业务方法，但那不是宿主预置的聊天读取能力。

<a id="public-data-boundaries"></a>
### 4.2 数据可见范围与当前缺口

| 想取得的数据 | 当前可用来源 | 不应推导出的能力 |
| --- | --- | --- |
| 当前会话与前后台/连接 | `HostSnapshot` 的三个字段 | 没有当前会话标题、项目目录、问题正文或消息列表 |
| 当前窗口消息文字 | `ChatWindowSnapshot.messages`，节点 `text/origin/complete/subtype/children` | 仅已加载内容，不等于整个会话历史；ready 不等于全历史完整，未知归属不猜测 |
| 当前草稿文字 | `DraftReference` 的稳定身份及草稿快照 | 快照含 `text/revision/pending/unconfirmed/blocks/hasContent/retired` 和可选 `askContext`；不是聊天历史，也没有内建附件字段 |
| 当前输入操作 | Composer 的 `draft/operation/disabled/busy/sendBlocked`、编辑器 ref 和受保护回调 | `purpose` 标识 prompt 或具体 ask/plan/elicitation 请求；ask 草稿的 `askContext` 只提供问题与选项，不能越过原生自由文本限制 |
| 一条正在呈现的消息 | `MessageProps.identity/complete/bodyRef`、React `children/adornment` 与普通 DOM props | 没有原始正文字符串或全会话排序快照；React children、DOM 观察和组件挂载先后不是“最近回复”查询契约 |
| 一个 Markdown 引用或附件 | link/image 的 `MarkdownNode`，或附件组件的 descriptor/index/origin | 不提供全部文件库或全部历史消息，也不因引用存在自动加载资源 |
| 后端原生输出与控制事实 | `events` 的 `NativeObservation`、`controlEvents` 的 `ServerEvent` | 通知可能携带正文，但不是浏览器当前已加载窗口；不会自动转交前端或补读启用前历史 |

**本体提供窗口读取，不提供语音上下文或 `getLatestReply()` 业务方法。**
当前 ask 的问题与选项通过对应草稿的 `askContext` 读取，不是 session 全局状态。模块不得借窗口读取导入私有 store、
查询私有 DOM、读取 native home 或扫描全部历史。公开 `bodyRef` 的呈现观察用途保持不变。
用后端观察再保存/发布一份历史来替代当前窗口读取，不具有同等语义。

<a id="window-context-proposal"></a>
### 4.3 由模块构建上下文

```text
本体 state.chatWindow 的当前只读窗口
    → 模块 context state 选择消息、截取少量文字
    → 组件在用户动作发生时读取本次上下文
```

数据状态和原生归属由本体如实提供，选哪些角色/回复、截多少字、是否附加自己的草稿、
何时提交给外部服务均属于模块策略，不在本体预置语音提示词。
消费者区分空窗口与未知/失效，捕获原始 session/draft/request 身份，
不得把迟到结果改投到当前新目标或覆盖用户手动修改；文字读取本身不授权提交消息。
精确字段与能力版本见[当前窗口契约](#chat-window-state)，无需另建历史读取或业务缓存。

### 4.4 创建时角色与模块 HTTP MCP

后端 API 仍为 v1，新增 `context.host.call`。消费者须检查该字段是否存在，不以
`apiVersion: 1` 推断旧宿主已经支持。Web API v2/UI v1 不变。
模块自己实现 HTTP MCP，并用现有 `routes` 挂载；本体不注册模块业务工具。

manifest 可声明 `roles`：

```json
{
  "id": "executor",
  "name": "Executor",
  "description": "Optional role summary",
  "instructions": "roles/executor.md",
  "skillDirectories": ["skills/executor"],
  "mcpServers": {
    "example-tools": { "type": "http", "path": "/mcp", "tools": ["task_read", "task_report"] }
  }
}
```

`roles` 是上述对象的数组。每份 role System Prompt 最多 64 KiB，manifest 字段仍为 `instructions`。
文件与目录是包根相对路径；`path` 是以 `/` 开头的
模块 API 相对路径。每个 skill root 包含 `SKILL.md`（可位于子目录），只传入所选
角色的目录。角色来源按 `moduleId/roleId` 排序，同一选择与同一资源去重；
不同来源的同名 skill、不同模块的同名 MCP、同一 MCP key 的不同端点明确拒绝。
原生用户、工作区、插件等已发现的同名 MCP 也拒绝，即使配置相同，不自动合并或别名。
原始 role System Prompt 带模块、
角色与原生 session ID 标头，通过主 agent `systemMessage.mode: "append"` 追加；
不替换基础指令，不创建 custom agent，也不发送初始化消息。

MCP 名称原样采用 manifest 的 `mcpServers` key（例如 `example-tools`），不加模块前缀。宿主生成
`http://127.0.0.1:<host-port>/_modules/<moduleId>/<digest>/api<path>`，
并设置 `X-Cockpit-Module-Digest: <digest>`。同一模块、同名同端点的角色工具列表取并集，
`["*"]` 表示全部，`[]` 表示无工具。既有来源、摘要、请求大小和生命周期保护不变。
模块负责 MCP 协议实现、依赖、工具表和错误；普通模块 HTTP API 可并存。

公开 intent（Web 和本体 MCP 共用）：

- `roles/list {}` → `{roles: [{moduleId,roleId,moduleName,name,description?}]}`
- `session/new {cwd,roles?: [{moduleId,roleId}]}` → `{sessionId}`
- `roles/readiness {sessionId,roles?}` → `{sessionId,loaded,ready,roles,reasons,appliedRoles?,rolesNeedReload?}`
- `session/tools-initialize {sessionId}` → `{ok:true}`，显式初始化已加载空闲会话的原生工具表；不是 readiness。
- `session/resources-prepare {sessionId,skills?,mcpServers?}` → 请求范围的逐步资源准备回执，精确契约见[资源准备](#session-resource-preparation)。
- `roles/add {sessionId,roles: [{moduleId,roleId}]}` → 仅追加已保存角色 metadata，结果见下文。

后端 `context.host.call(name,body)` 只接受 `session/new`、`session/get`、
`roles/readiness`、`session/resources-prepare`、`prompt`，参数和结果使用 `@cockpit/protocol` 的 typed intents。
不暴露 Engine、SDK 或持久层；宿主校验输入、输出和 shutdown admission。
创建失败若已确认原生 ID，错误保留 `sessionId`，不得盲目重建。

所选角色按 session ID 保存在宿主目录，列表、identity、Web、MCP 在 unloaded
时仍展示；读取时按原有 moduleId/roleId 更新当前已安装模块与角色的展示名称，不迁移身份，
不装载会话。缺失身份保留持久化标签，但不表示能力可用。
冷恢复使用宿主当前已冷加载的最新角色资源重新装配，缺失模块不静默丢弃角色。
既有 loaded 会话仍展示原生实际资源名，不把旧的生成名称伪装成新名称。

`McpServerSession` 和 `SkillSession` 的可选 `module: {id, name, roles?: [{id, name}]}` 是显式模块来源，
不是名称前缀或原生 `source` 的推断；原生名称、来源、状态、错误和启用字段不变。
`roles` 只记录该模块内实际为此资源贡献配置的角色，按角色 ID 去重、稳定排序；
共享 MCP 工具子集合并、同路径/同哈希 Skill 去重仍只有一个资源行，但保留所有贡献角色。
没有已证实角色来源时省略 `roles`，只展示模块；非模块资源不补造来源。
Web 使用分段标签（例如 `Task | Owner` 或 `Task | Executor、Owner`），模块前不加装饰图标。
这些来源不是授权、启用、连接或就绪证明，也不是会话全部已选角色的副本。
来源仍绑定实际返回的 handle 装配：`roles/add` 只保存选择，旧 handle 继续仅展示原有贡献角色；
显式重载等待恢复、恢复结果未知时不宣称新增角色已提供资源；
恢复已返回但后续核验失败时可保留该 handle 已装配的配置来源，不把失败解释为全部就绪。
`skills/session` 仅在原生 name/path 与此 handle 实际装配的 skill 完全一致时输出来源；
同名原生替代项或路径缺失不输出。冷恢复重建该匹配，重载后的读取仍按实际原生路径验证。
`mcp/session` 的 `module` 表示本 handle 角色配置中声明该 MCP 名称的模块，
不是当前连接身份的证明。原生列表中没有该名称就不生成资源行；普通同名风格或前缀
不会得到模块标签。当前 SDK 1.0.13 不公开 live URL/config/resource identity，且支持
同名 `startServer`/`restartServer` 替换，因此声明来源不能核验之后的同名替换。
UI 提示和 Agent MCP 文本明确这个含义，连接状态仍独立取自原生。
该字段不是 readiness，也不使用缓存就绪状态或额外后台查询。冷恢复重建声明来源。
`session/resources` 当前只投影 metadata，不包含 MCP/skill 列表；Web 使用上述专用读取。
`session/panel(s)` 保留既有原生标签，不增加来源推断。

全局 `mcp/global`、`skills/global` 与 `skills/read` 使用可选 `modules: ModuleSource[]`，
支持多个已核验模块来源；会话资源继续使用单个 `module` 结构。
只标注原生目录已经返回的资源，不把角色专属资源加入全局目录，不另造全局默认开关。
MCP 仅在原生 HTTP 配置 URL 与当前已加载模块声明的完整 origin、安装 digest 和端点完全一致时
标注模块；不靠 MCP 名称、原生 `source` 或已选角色判断。Skill 仅在原生路径的真实路径命中
当前已加载模块安装清单中的 `SKILL.md`，且实际字节的 SHA-256 与清单一致时标注模块。
详情重新使用相同核验，不保留跨请求来源缓存；原生字段及 MCP 脱敏不变。
`mcp/global` 另提供可选 `connection: {method, target?}`：`method` 为
`http | sse | stdio | unknown`；依据原生配置类型区分 HTTP/SSE，本地 `local`
归一为 `stdio`，无类型的原生 URL/command 配置分别采用原生 HTTP/stdio 默认。
自定义、未知或有歧义的配置保持 `unknown`，不解析既有展示字符串猜测类型。
`target` 仅为 HTTP/SSE hostname 或本地 executable basename，不包含 URL 用户信息、
端口、路径、query、fragment 或命令参数；既有完整脱敏 `detail`/`config` 保留。
`mcp/session` 不声明 `connection` 字段；SDK 1.0.13 的 `mcp.list` 只公开
source/status 和 server-advertised instructions，`McpHostState` 没有当前配置。
会话 MCP 因此没有连接方式展示。`detail` 仍是 source/plugin，而不是连接方式；
`session.mcp_servers_loaded` 事件虽有 transport，但不是当前读取时的连接配置权威，
不能用历史事件、同名全局项或角色装配配置补造会话 transport。
这些全局证据无法证明哪个角色实际贡献了原生全局配置，因此省略 `roles`，不把声明此资源的
全部角色冒充贡献者。未加载/旧版本、未知端点或无法核验的文件不标注；不代表它们不是模块资源。
模块来源仍不是连接、原生启用或 readiness 的证明。
角色选择不是就绪：只有显式 `roles/readiness` / `cockpit_role_readiness` /
`context.host.call('roles/readiness', ...)` 检查该 native handle 的装配、skill 路径/启用状态、
MCP 连接/策略状态及当前原生工具 metadata。普通列表、snapshot、detail、identity 与 Web
会话资源不计算或携带 readiness。保留既有普通控制/生命周期安全读取，不引入能力轮询、
持续缓存或失效刷新服务。Web 普通会话标签仅表示角色选择，不实现实时 readiness badge；
显式追加或检查操作单独呈现其结果。
新建和冷恢复可初始化原生工具表，只读 readiness 不自动加载 unloaded 会话，
也不补装、重载、启用或自动修复。就绪是请求时能力证据而非永久承诺；
busy、pending、subagent 等活动状态须另行读取，不能与角色能力就绪混为一谈。
没有 Task ACL，不支持对当前 handle 热装配角色；活动工作期间可以保存待下次加载的角色。

#### 工具表失效与显式恢复

SDK 1.0.13 / runtime 1.0.83 的 `tools.getCurrentMetadata()` 返回的是**已初始化**
工具表快照。`tools: null` 表示尚未初始化（也可能是配置变化后的失效），不是空工具集；
`tools: []` 才是已初始化但没有工具。隔离 native 用例证实，模型配置变化和 Skill
开关可使原先正常的 metadata 变为 null，MCP 重连不保证恢复。MCP 连接、角色标签
或工具名称前缀不能代替实际过滤后的工具证据。

`roles/readiness` 对 null 返回 `ready:false` 和明确的未初始化原因，不再逐工具误报缺失。
它不自动初始化、重连、启用资源、加载会话或发送提示。非 null 的工具表仍按
`mcpServerName` / `mcpToolName` 核对角色所需工具；真正被过滤或缺失的工具仍失败，
读取失败仍为 unconfirmed，不降级为成功。

当前源码提供独立的 `session/tools-initialize` intent，通过 SDK 公开的
`tools.initializeAndValidate()` 构建工具表并读回确认。仅允许已加载、空闲且无受保护
工作/并发操作的会话；不会冷恢复或关闭当前 handle，不应用新保存的角色，不修改全局
配置，也不启用被禁用的 Skill/MCP。当前模型、临时资源选择、历史和 ID 保持原样，
原生工具过滤仍生效。返回 `ok:true` 只表示工具表已初始化（可以为空），调用者随后
必须另行检查 `roles/readiness`；原生错误、关闭竞态或 null 读回均失败，无自动重试。
初始化失败不承诺回滚已发生的原生效果。

本体 MCP 使用已有通用调用器；`session/tools-initialize` 不增加专用工具，也不进入模块 `host.call` 白名单：

```json
{"name":"session/tools-initialize","body":{"sessionId":"TARGET_SESSION_ID"}}
```

先通过 `cockpit_capabilities` 确认**运行宿主**发布此 intent，再调用
`cockpit_call_intent`，最后显式 `cockpit_role_readiness`。这不需要引导 prompt，
也不自动派单。活动中的调用者不能用它初始化自己的会话。

**旧宿主恢复边界：**0.2.6/source `59c4049` 与 0.2.7/source `1dd38c6` 的检查逻辑相同，
均未提供此 intent，源码合并不改变这些运行实例。已有持久化历史且空闲的会话可以用
现有 `session/reload` / `cockpit_reload_session` 正常冷恢复，再检查 readiness；
但临时 Skill/MCP 选择遵循全局默认，不会特殊保留。若依赖再次切换专业 Skill，
工具表又可能失效，因此这不是“保留临时配置”的恢复办法。空白未发言会话可能在关闭后
消失，不能拿完整 reload 当通用修复。对于必须保留当前 handle/临时选择的失效场景，
这些旧宿主没有已证实安全的公开恢复入口；需要另行授权部署包含新 intent 的版本，
不能私用 SDK/store、改全局配置、发送初始化提示或绕过 readiness。

<a id="session-resource-preparation"></a>
#### 显式会话资源准备

当前源码的只读、冻结 `context.host.resourcePreparationVersion: 1` 标记表明宿主支持
狭窄的 `session/resources-prepare` 模块桥接。类型中该字段可选，用于表示旧宿主缺能力；
消费者必须在**需要资源的新建会话之前**及准备已有会话之前检查标记，不能根据
backend API v1、包版本、角色标签或 UI 能力猜测。旧的不带资源创建契约不变。
模块桥接不开放单独的资源开关、工具初始化或任意 intent 透传。

严格请求体：

```ts
{
  sessionId: string;
  skills?: string[];
  mcpServers?: Array<{ name: string; tools?: string[] }>;
}
```

名称和 sessionId 非空白、长度最多 200，不改写原生身份；skills 最多 64 且名称唯一，
MCP 最多 64 且 server name 唯一，每个 tools 最多 256 且唯一。
tools 是原生 `mcpToolName`，不是带 server 前缀的 wire name。
显式 `"*"` 拒绝；省略或空 tools 表示至少需要一个实际 offered tool，
并只返回第一个实际 offered 原生工具名作为最小见证，不复制完整工具目录。
显式 tools 只返回请求中实际 offered 的名称，保留请求顺序。
省略/空 skills 或 mcpServers 不选择任何该类资源；
两者都空时仅在必要时初始化当前工具表。

```ts
{
  sessionId: string;
  ok: boolean;
  skills: Array<{
    name: string;
    effect: 'not_attempted' | 'unchanged' | 'enabled' | 'unconfirmed';
    enabled: boolean | null;
  }>;
  mcpServers: Array<{
    name: string;
    effect: 'not_attempted' | 'unchanged' | 'enabled' | 'unconfirmed';
    enabled: boolean | null;
    status: 'connected' | 'failed' | 'needs-auth' | 'pending'
      | 'disabled' | 'stopped' | 'not_configured' | null;
    tools: string[] | null;
  }>;
  tools: 'not_attempted' | 'unchanged' | 'initialized' | 'unconfirmed';
  error?: string;
}
```

必须是已加载且空闲的目标；同一个 transition 生命周期保护覆盖前检、原生修改、
初始化与读回，期间排除普通宿主修改、prompt 和 reload。修改前再次检查保存角色与当前
handle 的 applied roles，以及当前角色装配 fingerprint；需要 reload 或装配不一致/不明确
时返回未尝试的失败回执，不能依赖调用者先前的被动观察。此检查不要求未选中的角色
Skill 启用，也不等同于角色 readiness。所有选择先通过原生列表
验证，未知/重复/不明确的身份或状态在任何修改前拒绝。MCP 必须允许第三方工具、
未被 host 过滤，且仅 connected 或明确 disabled 状态允许继续；stopped 不重启，
needs-auth 不认证，pending/failed/not_configured 不重试连接。
只启用明确选中且禁用的资源，不改无关临时选择。Skill 启用由原生列表读回确认，
不是加载 Skill 正文。MCP enable 异常只额外读回一次连接状态，不再次 enable。

修改后读取真实 `tools.getCurrentMetadata()`；当 metadata 为 null，或本次已确认启用
任一所选资源时，调用一次 `initializeAndValidate()` 并读回，两个条件同时成立也只调用一次。
SDK 1.0.13/runtime 1.0.83 的隔离用例证实：MCP enable 有时保留此前已初始化的空表，
确认配置变化后必须重建才能提供实际工具，因此即使 metadata 非 null 也在本次准备中完成
初始化，不要求调用者再手动修复。原生 ToolSet/角色工具过滤仍生效；重建后真正缺失的工具
仍返回失败及已确认的启用效果，不扩大工具子集，也不再次初始化或重试连接。
所选资源原本已启用且 metadata 非 null 时不重建；仅仅发现空表/缺工具不是初始化依据。
调用者不能改用 prompt、重载、全局开关或私有 SDK 来绕过失败。

只有所有选择启用、MCP connected 且未过滤、按 `mcpServerName/mcpToolName`
匹配的实际工具满足选择、metadata 已初始化时才 `ok:true`。这不是角色装配 readiness、
Task 绑定、授权、Skill 正文已读或永久承诺。未完成 Task 的 Executor 选择保护及一致性
完全属于 Task 模块，不进入宿主。

进入序列前的 schema/admission 错误可抛出且无资源副作用；进入后失败返回 `ok:false`
与原生错误及逐步回执。`not_attempted` 表示未尝试该修改；`unchanged` 表示确认已启用，
`enabled` 表示确认此次启用，`unconfirmed` 表示已尝试但未确认。enabled/status
保留最后确认的观察；已尝试修改而结果未知时为 null。后续读失败不抹去已确认的
effect/状态，`ok:false` 和 error 表明最终确认失败。MCP tools 是选中且实际确认的
原生工具子集（省略或空选择时只返回一个实际 offered 名称）；null 表示未观察，[] 表示观察到没有匹配。
连接已启用但失败/需要认证仍可有 `effect:'enabled'`，不能把它当作连接就绪。
不自动重试、不回滚已发生效果、不保存回执镜像或资源控制工作流。调用者保留完整结果。
error 最多 2000 字符；超长原生错误保留前缀并以 `... [truncated]` 明示截断，不丢弃逐步效果回执。

此能力是 **source-only**；已运行 0.2.7/source `1dd38c6` 不含它或
`session/tools-initialize`。发布/部署改后内容前必须分配新的不可变交付版本，
不因每次源码提交修改宿主版本。Task 既有 UI pairing
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` / `uiSurfaceVersion: 1` 独立且不变。

#### 已有会话显式追加

`roles/add` / `cockpit_add_roles` 与 Web 会话设置使用同一入口。只追加、不移除；
请求与已有角色去重保存，最多 64 个角色。不改变 Task 责任、
标题、工作目录或会话 ID，不复制会话，不发送初始化 prompt。
用户明确执行一次“保存角色”：只更新原有角色持久化 metadata，不调用原生
stop、close/reload、resume 或 prompt。主回合、子代理/shell、队列/steering、
待答 ask/plan/elicitation、schedules 均不阻止保存；自我调用与无主用户消息的
空会话也可以保存。unloaded 会话保持 unloaded，不自动恢复。
原生加载、关闭、删除等生命周期冲突仍可拒绝；忙于执行本身不是拒绝理由。
没有后台等待、自动应用队列或新通知机制。

SDK 1.0.13 / runtime 1.0.83 的公开 `options.update` 可更新 `skillDirectories`，
`skills.enable/disable` 与 `mcp.startServer/restartServer` 也提供局部运行时操作，
但 `systemMessage` 不在 mutable options 中。完整主会话角色指令沿用
`createSession` / `resumeSession` 的 `systemMessage.mode: "append"`，
不借组织指令字段、custom agent 或隐藏消息模拟热装配。

保存时校验本次选择的 catalog module/role ID 及去重后 64 个角色上限；
角色组合、integrity、资源冲突校验延后到普通加载。不在保存时初始化工具表、
读取/改写临时 Skill/MCP 开关或验证 session-only 资源是否可重建。
新角色仅在后续普通显式 reload 或下一次冷加载时按原规则装配；普通 reload 的
空闲及生命周期限制保持不变。沿用原生/全局默认配置，没有角色追加专用的临时开关
或 session-only 资源保留层。已保存角色的资源不可用时加载明确失败，不静默丢弃
角色、不降级为无角色成功，也不创建替代会话。

结果为 `{sessionId,status,roles,appliedRoles,loaded,rolesNeedReload,error?,recovery?}`。
`roles` 是已保存选择；`appliedRoles` 是当前 handle 已装配角色。
`status` 为 `saved | unchanged | uncertain`：`saved` 只表示保存成功，不表示已装配
或就绪；相同已保存选择返回 `unchanged`，即使还未装配，也不会触发加载或修复。
兼容性变更：不再返回 `applied` / `incomplete`，删除 `phase` 和内嵌 `readiness`。
`SessionMeta` / `SessionBrief` 可选返回 `appliedRoles` 与 `rolesNeedReload`；
`rolesNeedReload` 仅在 loaded 且已保存/已装配角色 ID 集合不同时为 true。
unloaded 时为 false，表示下次加载采用保存选择，不表示已就绪。
`roles/readiness` 保留独立、被动、显式检查入口，可选返回 `appliedRoles` 与
`rolesNeedReload`，不因此自动装配新角色。普通读取不额外计算 readiness。

持久化异常后，若能读回保存状态，返回 `uncertain` 和检查/恢复指导；
若读回也失败，则明确报错（`AggregateError`），不返回陈旧的保存快照。
两者都不自动重试或回滚。
先用 `session/get` 核对同一 ID 的保存选择；需要能力证据时另行显式读取
`roles/readiness` 及原生资源。解决具体错误后才由调用者显式恢复。
网络错误同样不能视为“什么都没保存”。保存选择将用于后续普通加载；
metadata 保存成功不是未来 native 加载成功的保证。

宿主不提供自动队列推进。保留单次 `session/interrupt`（保留队列）、
按 ID 删除 pending、当前状态读取、prompt 以及普通 Stop/cancel。
模块业务通知及 Owner 更新处理由模块承担，不产生宿主队列助手或业务事件卡片。

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

经典界面的激活 context 另提供 `context.uiVersion: 1`，声明已实现的公共语义 CSS 与图标规范。
共享表面组合另以 `context.uiSurfaceVersion: 1` 声明；使用新增 surface/heading/actions/badge/modal
样式的消费者必须独立检查该能力，不能从 UI v1 或包版本推断。
它只声明 CSS 能力，不新增 React 运行时、组件中间件边界或原生模态行为。
准确类名、变量及组合由[模块 UI 指南](module-ui-guide.md#public-classes)维护；
配套消费者使用真实可获取的宿主源码 pin，不把当前源码能力当成旧 Release 已提供。
精确类名、变量、兼容条件、两仓交付顺序与可运行示例统一维护在
[模块 UI 开发指南](module-ui-guide.md)。这是前端 additive 能力，不是新的 manifest 字段；
依赖 UI v1 的模块必须检查该字段并明确拒绝不兼容激活，不能只看宿主 package 版本。

新版入口使用 `ModuleNextFrontendContext`，只通过 `context.ui` 消费当前宿主组件。
`ModuleFrontendServices` 抽出两种展示共用的非视觉能力；模块共用服务代码不应要求
经典 CSS 标志或导入任一展示入口。新版先等待该模块声明的样式加载，再激活/发布组件；
失败按模块报告并释放资源，不回退到经典组件。宿主原生阅读无需等所有模块完成，
但模块敏感的草稿提交必须等待本次启动结束及当前草稿准备完成，不能把暂时空的
模块快照误认为初始化成功。跨文档切换不会转移内存中的上传、录音或待确认操作；
离开保护与资源归属见[模块 UI 指南](module-ui-guide.md#independent-new-ui)。

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
| sends | 独立声明 `['draft']` 才能捕获一次性原稿提交；`writes: ['text']` 本身没有发送权限 |
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
它包含文字、文字修订、pending/unconfirmed、通用阻止、聚合 hasContent、retired 和可选 askContext。
`DraftReference` 带稳定生命周期 id、sessionId 和 purpose；
`context.state.bindDraft(reference)` 提供文字编辑及通用阻止，不暴露私有 store、
附件方法或通用 native patch/submit/ACK/reset。

`ModuleDraftSnapshot.askContext?: DraftAskContext` 是只读、深冻结的原生问题副本：
`{ readonly question: string; readonly choices?: readonly string[] }`。只有此草稿对应的
当前权威 ask 请求存在且 question 可用时才提供；prompt、plan、elicitation、结束/替换的
ask、退役会话、未加载或连接尚未确认时为 `undefined`。没有 choices 与空 choices 不合并。
问题不写入草稿存储，恢复答案不会恢复旧问题，必须等待原生权威再次确认。
相同活跃 requestId 的问题/选项更新会发布新快照，但不改文字 revision、阻止或发送状态；
requestId 在结束后重用属于新草稿生命周期。断线/卸载本身不证明请求结束。
模块应在一次操作开始时同步读取并保存该快照；已有快照不会被后续更新改变。
读取不要求文字写权限，但撤销的 module binding 的 `getSnapshot()` 会抛出；
已捕获的不可变数据不因此被修改。契约不暴露其他会话、完整 native ask 对象或回复权限。

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
| sessionStatus | 原生并存活动摘要/错误/真实待决策和非交互 children，不嵌套按钮；activity、loaded、connected 提供采样及可用边界，缺失不代表 idle；compacting、error 补充当前压缩和错误事实；activityRefreshing 仅表示浏览器 control 读取正在进行；activityDisplay 可保留上次采样外观或表达读取错误，只用于展示，绝不授权操作；总状态与具体活动并存，不因其他图标出现而隐藏运行圈圈 |
| composer | 实际输入卡片及其原生问题内容，组合 children；不预建附件组 |
| composerEditor | 实际输入行、文字编辑器和发送控件；普通 DOM props 与前置 children，不解释文件或语音事件 |
| composerInput | 实际受控 textarea；value/onChange、原生事件、editorRef、draft/operation/disabled/sendBlocked 和受保护 onSubmit |
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

输入增强须检查 `context.composerInputVersion === 1`。`composerInput` 的 Base
本身就是 textarea，无模块时仍处理受控编辑、IME、桌面 Enter 与 Ctrl/Meta+Enter；
原生 onKeyDown 先执行，defaultPrevented 和组合输入不会触发提交。
增强器透传 value/onChange 与其余原生 props，组合 editorRef，包括对象 ref、
callback(null) 和 React 19 callback cleanup；不查询或移动私有 DOM。
`ComposerEditorProps.children` 仍在文字编辑器前；输入增强器可直接返回
`<><Base {...props} /><Microphone /></>`，没有按钮注册器或位置插口。
宿主发送独立保留，DOM、键盘和视觉顺序都是 File → textarea → 麦克风 → 原生发送。
完整状态/错误/恢复面板通过既有 composer middleware 放在整个 Base 之后，
不是输入行的子项，也不需要新 slot、portal 或占位容器。

`disabled` 只表示原生编辑禁用；`sendBlocked` 是提交路由/连接门槛，不把它或 pending
变成 textarea disabled。pending 和草稿 blocks 也会阻止提交，但仍允许手动编辑。
无自由文本路由的 ask/elicitation 保留原编辑行为，增强器必须保持麦克风可见但禁用；
它不能绕过 sendBlocked。输入增强独立于 File 的 prompt-only schema。
所有异步输入仍捕获精确 draft.id、revision 与租约，旧输入或复用 request ID
不授权写入新生命周期。选区/焦点恢复也必须核对原草稿身份和写入后的修订。

后台完成须独立检查 `context.draftLifecycleVersion === 1`，使用捕获的
`draft.editTextIfRevision(text, revision)`，不能用先检查快照再调用 `editText` 代替。
先释放本任务自己的 block；其他模块租约仍阻止写入。修订不匹配、pending、
unconfirmed 或任何 block 返回 `false`，不修改文字/修订/存储；退休、能力撤销、
缺少 `writes: ['text']` 或持久化失败抛错，不冒充成功。`true` 表示已同步保存并发布
新修订；原 `editText` 的并发手动编辑和存储失败时保留内存文字行为不变。

草稿任务属于精确 lifetime，而不是当前组件或页面。切换会话、标签页、页面隐藏、
断线、unload 或 prompt 暂时被 ask 覆盖，不退休 prompt；原修订与上述门槛仍有效时，
后台结果可写回原非活动 prompt，不转投当前草稿。权威确认 decision 结束/替换时，
该 decision 快照不可逆地变为 `retired: true` 并通知订阅者；权威会话删除/完整列表
确认消失时，prompt 和所有 decision 一同退休。非权威空列表不代表删除。
相同 session/request ID 再出现也获得新 lifetime，旧引用不能复活。模块须在退休
通知时销毁保留的资源；临时不可见不是销毁信号。页面内任务/音频资源仍由模块服务
管理，不由宿主持久化，也不会因该能力自动发送或重试原生请求。
会话永久删除时清理该 prompt 的保存记录（存储失败会报告），退休 prompt 的晚到
ACK 不再写存储，避免污染同 session ID 的新 lifetime；decision 的既有独立 occurrence
存储与在途结算规则不变。

#### 明确授权的一次性原稿提交

消费者必须独立检查 `context.draftSubmissionVersion === 1`，并在 frontend 返回
`sends: ['draft']`。在用户明确确认发送的时刻调用捕获草稿的 `captureSend()`，
而不是等异步工作结束才重新捕获同意。返回的 `CapturedDraftSend` 不接受 session ID、
request ID、附件或任意 payload。文字写入权限与发送权限互相独立。

模块可继续使用自身 `editText` 做临时文字投影，维护自己的预期修订；完整收尾后先
释放自己的租约，再用 `editTextIfRevision` 写最终文字，然后调用
`intent.send(expectedRevision)`。自捕获以来的任何其他写入者文字修改或 schema
新增、移除、更新、generation 变化都使同意失效，包括先改后恢复的 ABA；自身
流式文字更新与纯 block 释放不改变字段检查点。宿主在 pending 发布后的最终派发
边界再次检查，不会跳过发生变化的 schema 而偷偷发送剩余字段。

首个 `send()` 消耗该 intent（包括 blocked）；重复调用返回**同一 Promise/结果**，
不会再派发。`cancel()` 只在派发前生效，不能撤销已在途的原生请求。返回值：

| status | 含义与处理 |
| --- | --- |
| `acknowledged` | 原生明确确认且本次文字/schema ACK 结算完成 |
| `blocked` | 确定没有派发；`reason` 是修订/字段变更、pending、unconfirmed、租约、退休、撤销、只读、连接/原生请求门槛或投影/持久化失败等安全代码；保留现场交给用户 |
| `unconfirmed` | 可能已发送，或原生已确认但本地 ACK 结算失败；`reason` 为 `native-unconfirmed` 或 `settlement-failed`；不得自动重新捕获同意或盲目重发 |

派发走同一个 `SessionDraft` 投影、原生请求构造、pending token 和 schema ACK 事务。
prompt 始终发送到原 session 的普通 prompt/enqueue，即使后来出现 ask，也不会回答、
关闭或改写该 ask；ask 只回答原来仍 live 且允许自由文字的 request（`wasFreeform: true`）；
plan 只提交原请求的 feedback；elicitation 没有文字路由。退休决策不会转投 prompt。
检查原 session 的原生状态与连接完整快照，不依赖当前可见 session、页面是否隐藏或
已卸载的 Composer 回调。只读原稿、断线、过期决策、未确认发送和其他模块租约仍阻止派发。
模块在请求中途卸载不表示“未发送”，既有原生回执按原 token 保守结算。

例如语音模块自行区分正常主动松手与按钮/中断/取消入口；宿主不推测手势、不自动录音、
拼接语音或发送静音结果。这些业务规则由配套模块维护。普通手动发送按钮继续由用户管理，
不能用这个能力自动重试未知回执。

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
- 纯内容包（没有 backend）和下次启动消息模块；现有角色须随可执行模块包提供。

这些尚未实现，不应通过当前 API v1 的未知字段或旧原型入口模拟。
已有菜单动作声明不等于任意页面/router 注册；当前没有此类公开注册入口。
实施范围以 [模块目录](module-catalog.md)及明确的产品决定为准。
