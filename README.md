# Cockpit

[![CI](https://github.com/waksana/cockpit/actions/workflows/build.yml/badge.svg)](https://github.com/waksana/cockpit/actions/workflows/build.yml)

**原生 Copilot 的薄 Web / HTTP / MCP 接入层。** 会话身份、执行、历史、模型、
队列和原生配置由 Copilot 管理；Cockpit 提供远程交互。
后端忠实适配 Copilot 功能的子集；Web 使用所提供 API 的子集实现聊天工具，
不要求后端覆盖全部 SDK，也不要求 Web 覆盖全部 API。

适合单操作者在可信机器上使用原生 Copilot，不是多租户服务或工具沙箱。
**工具权限固定为 `allow-all`**；请只选择可信工作目录，不要直接暴露到公网。

> English: Cockpit is an experimental, single-operator Web/API/MCP adapter for
> native GitHub Copilot. Start with the [installation guide](docs/DEPLOY-PORTABLE.md);
> contributions in English or Chinese are welcome. See [CONTRIBUTING](CONTRIBUTING.md)
> and the [security policy](SECURITY.md).

## 界面预览

![Cockpit 工作区：左侧会话列表，中间聊天展示折叠过程、工具详情与子 agent，右侧展开会话配置](docs/images/workspace.png)

当前生产组件的运行截图，使用合成会话与工具记录，不包含真实用户数据。
左侧切换会话，中间按需展开工具和子 agent，右侧调整模型配置。
截图可通过 [Chat Lab 工作区场景](docs/DEVELOPMENT.md#isolated-chat-component-review)复现。

## 快速开始

当前服务从 **v0.1.0** 开始发行。使用 [最新 Cockpit Release](https://github.com/waksana/cockpit/releases/latest)
的 `runtime.tar.gz` 与 `runtime.tar.gz.sha256`，不是模块 ZIP 或短期 Actions artifact。

| 条件 | 当前发行基线 |
| --- | --- |
| 平台 | Linux x64 / glibc；其他平台组合暂未作为受支持运行包发行。 |
| Node | **24.20.0，必须精确到 patch**；自行安装，不包含在运行包中。 |
| 已包含 | SDK **1.0.13**、原生 runtime **1.0.83** / protocol **3**、TypeScript loaders、Web/MCP 产物及运行依赖。 |
| 仅源码开发需要 | pnpm **10.34.5**，以及 Git。运行包不需要 pnpm。 |

1. 准备 [Node 24.20.0](https://nodejs.org/dist/v24.20.0/)，用 `node --version` 核对。
2. 下载、校验并解压到一个新目录：

   ```sh
   mkdir cockpit-download
   cd cockpit-download
   curl --fail --location --remote-name https://github.com/waksana/cockpit/releases/latest/download/runtime.tar.gz
   curl --fail --location --remote-name https://github.com/waksana/cockpit/releases/latest/download/runtime.tar.gz.sha256
   sha256sum -c runtime.tar.gz.sha256
   mkdir cockpit
   tar -xzf runtime.tar.gz -C cockpit
   cd cockpit
   ```

3. 首次使用先按[原生认证](docs/DEPLOY-PORTABLE.md#native-authentication)准备凭据。
   Cockpit 没有 Web 登录向导；不能假定全局最新版 `copilot` 与此包兼容。
4. 在包根启动：

   ```sh
   node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts
   ```

5. 打开 **http://127.0.0.1:8771**，新建会话、选择本机可信工作目录，再发送第一条文字消息。
   就绪检查、源码安装和常见错误见[安装指南](docs/DEPLOY-PORTABLE.md)。

checksum 用于校验文件完整性，不是独立发布者签名。远程访问必须另加
[认证 HTTPS 网关](docs/DEPLOY-PORTABLE.md#remote-access)，本地启动不需要反向代理。

## 从这里开始

| 想了解什么 | 阅读 |
| --- | --- |
| 安装、认证、首次聊天与排错 | [安装指南](docs/DEPLOY-PORTABLE.md) |
| 报告问题或贡献修改 | [贡献指南](CONTRIBUTING.md) · [Issues](https://github.com/waksana/cockpit/issues/new/choose) |
| 私密报告安全问题 | [安全政策](SECURITY.md) |
| 版本与发布 | [版本政策](docs/packaging.md#versioned-releases) · [发行说明](https://github.com/waksana/cockpit/releases) |
| 完整文档及每个主题的唯一维护位置 | [文档索引](docs/README.md) |
| 产品原则与已确认取舍 | [R1–R8](docs/product-requirements.md) |
| 当前本体、认证与关闭的边界 | [架构与运行边界](docs/cockpit-plan.md) |
| 后续模块的能力归属 | [模块目录](docs/module-catalog.md) |
| 当前事实与下一版还差什么 | [架构对照](docs/cockpit-plan.md#target-gap) |
| 前后端插件如何合作 | [基础模块协议设计](docs/module-contract-draft.md) |
| MCP 客户端 | [MCP](apps/mcp/README.md) |
| 完整运行包 | [产包说明](docs/packaging.md) |

## 当前范围

保留原生会话、普通文字聊天、工具与子代理展示、模型/模式设置、队列、用户决策、
计划、MCP/skill、原生定时提示，以及受保护的生命周期操作。
HTTP/MCP 可以传递 SDK 原生附件参数，路径属于 Copilot 运行侧的文件系统。
Web 会话菜单仅提供会话设置、MCP、Skills 和永久删除；其余原生管理能力仍通过
HTTP/MCP 使用。Web 不展示或切换三种交互模式，新建沿用原生默认交互模式，
已有会话模式不改写。聊天右键使用浏览器原生菜单。

远程登录由外部认证网关承担，Copilot 登录由原生运行时承担。
服务直接提供 Web/API，收到 graceful 关闭请求后等待原生活动和受保护调用结束，
关闭 SDK/连接并退出。进程启动与重新拉起由使用者或宿主管理。

实时身份以运行实例的 `/version`、`/health` 和对应包为准。
当前为实验性 **0.x**：仅支持当前发行与全新安装，Web、后端和 MCP 使用同一 release；
不承诺旧 API/客户端兼容，也没有自动迁移。公开发行必须有可区分的版本及真实的
变更说明，不能把更新安装包等同于删除原生数据。完整政策见[版本发行](docs/packaging.md#versioned-releases)。

## 已确认的下一版目标

后续模块以前后端同包、统一端口和独立版本接入，首版采用冷加载。
安装/更新/移除的选择在下次启动应用；各 MCP path 有独立的工具与协议连接。
模块运行承载方式仍待选择：主进程 import 或宿主管理的子进程。

graceful 的等待目标只关注原生 session 空闲；模块业务和关闭回调不增加退出条件。
下次启动给指定 session 发接续 prompt 是可选模块能力。

模块加载器、逐模块 HTTP MCP 和启动消息尚未实现。
产品决定见[产品要求](docs/product-requirements.md#single-service-target)，
具体设计见[模块协议](docs/module-contract-draft.md)。

## 开发

从[贡献指南](CONTRIBUTING.md)进入短期分支 → PR → `Required checks` → 绿色 main 的流程。
具体命令由[开发指南](docs/DEVELOPMENT.md)与[验证指南](docs/cockpit-testing.md)维护。
服务端/core 保留 TypeScript，通过 `tsx` 运行；Web 与 MCP 需要构建。
不要在生产正在读取的源码或静态资源目录里构建候选版本。
聊天组件使用现有的[维护中 Chat Lab](docs/DEVELOPMENT.md#isolated-chat-component-review)，
不另建演示应用。版本发布只发布经过检查的包，不自动部署或重启生产服务。

本项目使用 [GPL-3.0-only](LICENSE)；第三方来源与署名见 [NOTICE](NOTICE.md)。
