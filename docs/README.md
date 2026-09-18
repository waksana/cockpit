# Cockpit 文档

Cockpit 本体提供 Copilot 的浏览器界面与 API，模块扩展文件、通知等功能。
第一次使用从安装指南开始；选择模块看模块目录；开发模块看接入协议。

## 开始使用

| 文档 | 内容 |
| --- | --- |
| [项目介绍与界面预览](../README.md) | 本体功能、前后端扩展方式和现有模块。 |
| [安装与运行](DEPLOY-PORTABLE.md) | 运行包/源码安装、Copilot 登录、首次聊天、远程访问、排错与关闭。 |
| [模块目录](module-catalog.md) | 已发布模块、各自用途和版本配套；与待接入项目、后续方向分开列出。 |
| [MCP 客户端](../apps/mcp/README.md#configuration) | 让其他 Agent 通过 stdio MCP 使用同一 Cockpit 后端。 |
| [发行说明](https://github.com/waksana/cockpit/releases) | 已发布版本的下载与变更；仓库中的[0.2.5 发行摘要](release-notes.md)描述待发行变更，配套 / 发布资产以对应 Release 为准。 |
| [安全政策](../SECURITY.md) | 单操作者信任边界、远程认证要求和私密漏洞报告。 |

## 现有模块与扩展项目

| 项目 | 简介 | 当前状态 |
| --- | --- | --- |
| [Cockpit File](module-catalog.md#文件) | 在聊天中选择、粘贴或拖入附件，预览和下载文件、图片与媒体。 | 可配套安装。 |
| [Cockpit Notification](module-catalog.md#通知) | 新回复和待回答问题的未读标记、会话计数，以及浏览器推送与应用角标。 | 可配套安装；推送与角标需要设备支持和用户授权。 |
| [Cockpit Task](https://github.com/waksana/cockpit-task) | 记录结构化任务、授权派单、执行者报告与协作结果。 | 已有独立发布包，待适配当前模块体系。 |
| [Cockpit WeChat Connector](https://github.com/waksana/cockpit-wechat-connector) | 将授权微信私信用户连接到指定会话，收发文本及支持的媒体。 | 已有独立发布包，待适配当前模块体系。 |

配套版本、下载入口和详细限制统一见[模块目录](module-catalog.md)。
模块均为可选项；交给 Agent 安装时，使用 [README 中的安装提示词](../README.md#安装与运行)，
让它逐个介绍模块并询问是否安装，不默认全部启用。

## 开发扩展

模块包可以同时包含后端 JavaScript 和前端 ESM/CSS。它们使用本体的服务端口、
React 与公开接口，不需要另建聊天应用。

| 文档 | 内容 |
| --- | --- |
| [模块接入协议](module-contract-draft.md) | [公共接口速查](module-contract-draft.md#public-api-map)、[数据可见范围](module-contract-draft.md#public-data-boundaries)、包格式、冷加载和 Web 四类扩展。 |
| [模块 UI 开发指南](module-ui-guide.md) | 公共样式、独立菜单能力检查、主题变量、图标、组件组合及可运行的最小前端示例。 |
| [公共 TypeScript 类型](../packages/module-api/src/index.ts) | 后端 API v1；[frontend.ts](../packages/module-api/src/frontend.ts) 定义 Web API v2。 |

建议按“[导出类型](module-contract-draft.md#4-公共-typescript-契约) →
[最小前端示例](module-ui-guide.md#executable-minimal-frontend) →
[打包与安装](module-contract-draft.md#2-包格式与本地安装)”阅读。
公共 UI 版本目前为 v1，与包/后端及 Web API 的版本分别维护；
菜单能力另检查 `context.menuVersion: 1`，不是旧接口的兼容别名。
注册模块 state 不等于自动取得聊天数据：当前宿主基础快照只含会话 ID、可见性和连接状态。
开发源码新增的 `chatWindowVersion: 1` 提供[只读当前窗口](module-contract-draft.md#chat-window-state)，
模块自行选择和裁剪文字；`composerInputVersion: 1` 提供真实受控 textarea 的组件增强。
这两项尚不属于历史 0.2.4 Release，不新增本体后端能力或语音业务。

## 接口与架构

| 文档 | 内容 |
| --- | --- |
| [架构与运行边界](cockpit-plan.md) | 本体、SDK 和模块的职责，原生数据归属、认证、graceful 退出与当前实现差距。 |
| [API 发现与调用](../apps/mcp/README.md#discover-and-invoke-the-api) | `/capabilities`、HTTP intent、MCP 工具和错误语义。 |
| [原生聊天](native-chat.md) | 原生事件、分页 cursor、历史/实时/重连、Web 阅读窗口和媒体边界。 |
| [原生 fork](session-fork.md) | HTTP/MCP 分叉入口、前检与继承；不是 Web 界面功能。 |
| [产品要求 R1–R8](product-requirements.md) | 已确认的定位、边界、目标及接受的成本，包括模块冷加载和独立系统页面范围；不代表每项目标已实现。 |

接口文档描述当前源码，安装文档对应指定发行；使用旧运行包时应阅读相同 tag 下的文档。
对正在运行的服务，以 `/version` 和 `/capabilities` 为准。
0.2.4 包含独立菜单注册及模块 payload 事件，配套 Notification 0.1.5；
**0.2.4 配套 / 发布资产以对应 Release 为准**，文档不表示发布已完成。
File 0.1.7 继续兼容且不重新发行；历史 0.2.3 → Notification 0.1.0 配套保持不变。
通知仓库 `tooling/host-sdk.json` 记录精确兼容 SDK 源码 pin；
完整 SHA、0.2.3-development 导出来源与 0.2.4 的关系见[模块协议](module-contract-draft.md)。

为保留外部链接，`cockpit-plan.md` 和 `module-contract-draft.md` 沿用原文件名：
前者是当前架构说明，后者是已实现的模块协议，并在末节单列[后续目标](module-contract-draft.md#8-后续目标)。
已确认要求与实现的差距见[架构对照](cockpit-plan.md#target-gap)。
[已确认要求](product-requirements.md#single-service-target)明确不做模块热加载、热启停或热更新；
安装和版本选择由下次冷启动生效。系统页面是独立需求，不属于菜单注册实现，
也不是模块任意页面注册机制。

## 参与开发

| 文档 | 内容 |
| --- | --- |
| [贡献指南](../CONTRIBUTING.md) | 问题报告、分支、PR、review 和许可。 |
| [开发与集成](DEVELOPMENT.md) | 工程流程、交互语义、隔离 Chat Lab 和文档截图的更新方式。 |
| [验证指南](cockpit-testing.md) | 按改动选择现有命令、隔离条件和清理要求。 |
| [构建与发行](packaging.md) | 运行包内容、来源 manifest、依赖闭包、CI、版本政策和 tag 发行。 |

## 真相来源与冲突处理

| 问题 | 权威来源 |
| --- | --- |
| 产品应当做什么 | 已确认的 R1–R8；未确认建议不得写成既定要求。 |
| 源码现在做什么 | 当前提交的实现、依赖和已有验证证据；实现文档必须随之修正。 |
| API 接受什么 | [`Intents` / schema](../packages/protocol/src/index.ts)，运行实例的 `GET /capabilities`。文档不另建可执行 API 注册表。 |
| 构建和运行包包含什么 | [普通产包](packaging.md)、package/锁文件和实际 `runtime-manifest.json`。 |
| 某实例实际运行什么 | 该实例 `/version`、同实例 `/health` 与实际包身份。 |

要求与实现不符时，要标明缺口，不能偷偷改要求来匹配代码；实现说明与代码不符时，
修正文档，不把错误说明变成实现授权。合成用例、源码推导和运行实例观察
各有证据边界，不能相互替代。机器可读的 transport 列表包含运维端点，
不表示每条 transport 都是公开产品 intent 或无需认证。

## 维护规则

1. 每次行为变化只在对应主题正文维护细节；其他文档用链接和必要摘要，不复制整段契约。
2. 新建文档先确定它属于哪种性质、替代什么、从哪里进入；没有独立主题就更新现有正文。
3. 当前说明使用可追溯的版本和明确状态；文档或源码提交不代表任何实例已经采用。
4. 正文聚焦当前能力、使用契约和已确认目标，不维护旧接口别名、迁移清单或归档页面；
   不把构建产物和临时审阅记录写入产品源码。
5. 提交前核对相对链接、锚点、命令路径及示例与其真实实现；不为 Markdown 改动启动生产服务
   或重跑无关构建。变更具体声明或记录时保留可追溯来源。

文档维护不会自动产生模块、部署、调度、认证修改或用户数据迁移授权。
