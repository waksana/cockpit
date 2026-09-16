# 模块接入协议

**当前源码：Module API v1，本地可信包、主进程 import、冷加载。**
这是 Cockpit 0.2.0 的未发布源码能力，不适用于已发布 v0.1.0 运行包。
远程签名 URL 安装、模块 HTTP MCP、角色/skill 包和通用页面贡献仍未实现。

产品边界见 [R1–R8](product-requirements.md)，文件模块的业务契约由
[cockpit-file](https://github.com/waksana/cockpit-file) 维护。
本文维护宿主当前接口与未实现目标，不复制文件业务。

## 1. 当前支持范围

| 能力 | 当前源码 |
| --- | --- |
| 本地包安装 | 选择 `.tgz`，显式信任代码，验证包后复制到不可变版本目录 |
| 后端 | 在宿主 Node 进程 import 已构建的 JavaScript，返回能力声明 |
| 前端 | 同包 ESM/CSS，共用宿主 React 和主题，不新建 SPA |
| HTTP | 统一端口、模块命名空间、版本绑定的 API 与静态资源 |
| 原生观察 | 按声明类型接收已加载会话的 SDK 通知，不开启额外历史读取 |
| Web 贡献 | 输入栏操作、输入栏上方组件、文件输入事件、聊天节点渲染 |
| 草稿 | 声明写 text/attachments，经作用域句柄修改，发送与 ACK 仍归本体 |
| 启用/停用 | 修改下次启动选择，当前进程不热加载或热卸载 |

首个消费者是文件模块。全局文件库和汉堡菜单页面已移至其 roadmap；
当前 API v1 不提供全局页面或 session 菜单页面的注册字段，未知字段明确拒绝。
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

唯一代码定义是
[`packages/module-api/src/index.ts`](../packages/module-api/src/index.ts)。
模块构建时可以导出真实的公共类型，避免复制一份声明：

```sh
node scripts/export-module-api.mjs /absolute/new/sdk-directory
```

导出包含 module-api 和其 protocol 依赖；不包含 SDK 凭据、原生数据或 Copilot runtime。
该目录是模块构建输入，不是另一套运行时权威。

后端导出 `activate(context)`，返回 `ModuleBackend`：

| 输入/贡献 | 内容 |
| --- | --- |
| context | apiVersion、moduleId、dataRoot、apiBase、config、AbortSignal、report |
| routes | method/path、json 或 stream body、bodyLimit、handler |
| publicConfig | 明确允许浏览器读取的少量配置，不默认公开整个 config |
| events | 事件类型列表与只读处理器 |
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

## 6. 前端注册与草稿

浏览器入口同样导出 `activate(context)`。context 提供宿主现有 React、
apiBase、公开配置、request、signal 和 report。模块不得自建 root 或依赖私有 DOM/store。
宿主并行初始化不同前端模块；单个超时/错误不阻塞其他模块，晚结果不能重新发布已撤销贡献。

当前返回字段：

| 字段 | 用途 |
| --- | --- |
| writes | 声明可写的 text/attachments；是接口协作约束，不是安全隔离 |
| rendersDraftAttachments | 声明 composerAbove 已完整展示草稿附件，本体不再重复展示附件列表；必须同时提供 composerAbove |
| composerActions | 输入栏操作组件 |
| composerAbove | 输入栏上方组件 |
| fileInput | 文件选择结果、粘贴/拖放文件的接受与处理 |
| chatRenderers | 原生附件、Markdown link/image 节点的匹配和组件 |
| dispose | 释放本模块的浏览器资源 |

本体提供绑定 session 的草稿句柄：快照、订阅、追加/移除附件、编辑文字、登记发送阻止。
模块不操作发送按钮的实现，不发隐式消息。提交快照和原生 ACK 清理由本体统一完成，
新增加的文字/附件不会被旧 ACK 清掉。
原生提交 pending 期间，本体向输入区贡献传入 disabled，上传、移除和重试须置灰；
拖放/粘贴文件也不接纳。文字仍可编辑，收到回执后恢复附件操作，不等待 Agent 整个回合结束。
当前页面内，模块负责在文件项内展示上传/失败状态，本体发送阻止只使发送按钮置灰，
不额外弹出正常上传提示。处理器异常会撤销该前端模块，
遗留发送阻止转为宿主可明确移除的行内提示，避免永久锁住草稿。
没有声明附件展示的模块或模块失效时，本体保留简单的附件移除列表；
不显示重复的“原生附件”折叠区，声明草稿写权限本身不等于承担附件展示。
刷新只恢复文字和已写入草稿的成功附件，不保留未完成文件选择、上传任务或相关阻止。
成功附件不能为等待同批其他文件而延迟写入草稿。原生发送回执未确认的提醒仍保留，
与未完成上传的刷新规则分开。

Markdown 渲染上下文保留原生消息身份和原始解析目标，不使用 HAST 规范化后的 URL
代替模块引用键。主/子 Agent 保留真实根 session 身份。
无匹配时保留默认内容；多个排他规则匹配时报告冲突并回退，不按下载顺序覆盖。
原生附件消息不因正文为空而被丢弃。
历史展示使用 `NativeAttachmentDescriptor`，与严格的发送参数 `NativeAttachment` 分开：
blob 的 data 缺失或带 omittedReason 时仍保留名称、MIME 和不可用原因，
没有模块渲染器时显示基本文字占位，不伪造空 blob，也不补抓字节。

## 7. 原生观察和退出

原生通知通过 `Engine.onNativeEvent` 的类型过滤出口提供；
没有感兴趣观察者的事件不额外遍历大 payload。
工作目录随经过验证的 root context-change 更新，不增加逐事件 metadata RPC。
观察返回值不替换原生事件，错误不污染原生控制状态。

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

- 本体模块管理页面/API、GitHub Release 安装更新及 CLI 替代单独跟踪于
  [#5](https://github.com/waksana/cockpit/issues/5)，不属于当前局部正确性修正。
- 远程 HTTPS 签名发行描述、发布者信任与更新选择；在验证前不执行代码。
- 同端口独立 HTTP MCP path，每模块工具表/协议会话隔离，不隐式修改原生 MCP 配置。
- 全局页面/session 菜单页面等通用 UI 贡献，按真实消费者扩展版本化接口。
- 角色/skill 等内容包与下次启动消息模块，保持各自业务和原生状态边界。

这些尚未实现，不应通过当前 API v1 的未知字段或旧原型入口模拟。
实施范围以 [模块目录](module-catalog.md)及明确的产品决定为准。
