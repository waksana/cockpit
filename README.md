# Cockpit

**原生 Copilot 的薄 Web / HTTP / MCP 接入层。** 会话身份、执行、历史、模型、
队列和原生配置由 Copilot 管理；Cockpit 提供远程交互。

## 从这里开始

| 想了解什么 | 阅读 |
| --- | --- |
| 完整文档及每个主题的唯一维护位置 | [文档索引](docs/README.md) |
| 产品原则与已确认取舍 | [R1–R8](docs/product-requirements.md) |
| 当前本体、认证与关闭的边界 | [架构与运行边界](docs/cockpit-plan.md) |
| 后续模块的能力归属 | [模块目录](docs/module-catalog.md) |
| 当前事实与下一版还差什么 | [架构对照](docs/cockpit-plan.md#target-gap) |
| 前后端插件如何合作 | [基础模块协议设计](docs/module-contract-draft.md) |
| 安装与使用 | [安装指南](docs/DEPLOY-PORTABLE.md) · [MCP](apps/mcp/README.md) |
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

使用独立工作区，按[开发指南](docs/DEVELOPMENT.md)与[验证指南](docs/cockpit-testing.md)
工作。服务端/core 保留 TypeScript，通过 `tsx` 运行；Web 与 MCP 需要构建。
不要在生产正在读取的源码或静态资源目录里构建候选版本。

本项目使用 [GPL-3.0-only](LICENSE)；第三方来源与署名见 [NOTICE](NOTICE.md)。
