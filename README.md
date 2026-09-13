# Cockpit

**原生 Copilot 的薄 Web / HTTP / MCP 接入层。** 会话身份、执行、历史、模型、
队列和原生配置由 Copilot 管理；Cockpit 提供远程交互，不再做第二套 agent 平台。

## 从这里开始

| 想了解什么 | 阅读 |
| --- | --- |
| 完整文档及每个主题的唯一维护位置 | [文档索引](docs/README.md) |
| 产品原则与已确认取舍 | [R1–R8](docs/product-requirements.md) |
| 当前本体、认证和启动器的边界 | [架构与运行边界](docs/cockpit-plan.md) |
| 哪些能力已迁出、以后由谁负责 | [模块目录](docs/module-catalog.md) |
| 前后端插件如何合作 | [基础模块协议设计](docs/module-contract-draft.md) |
| 安装与使用 | [安装指南](docs/DEPLOY-PORTABLE.md) · [MCP](apps/mcp/README.md) |
| 已实际部署过哪个版本 | [部署记录](docs/deployments.md) |

## 当前范围

保留原生会话、普通文字聊天、工具与子代理展示、模型/模式设置、队列、用户决策、
计划、MCP/skill、原生定时提示，以及受保护的生命周期操作。
HTTP/MCP 可以传递 SDK 原生附件参数；这不是浏览器文件上传或托管文件服务。

文件、通知/收件箱、语音、置顶/自动命名、系统看板、重启便利入口、Context Reset、
Assistant、Task 和微信接入已从运行路径迁出。原件保存在
[`module-staging/`](module-staging/README.md)，不参与本体构建或运行包；
**不是已可安装的模块，当前也没有模块加载器。**

远程登录由外部认证网关承担，Copilot 登录由原生运行时承担。仓库仍含源码启动器、
独立消费者安装/更新器及私有交付集成；它们是运行外围设施，不是业务模块。
“外部 launcher”指在 Cockpit 进程之外运行，**不表示已经迁出此仓库**。

源码、已部署版本和未来设计是不同状态。后续文档提交不自动部署、重启或启用模块；
实时身份以运行实例和交付控制器为准。

## 开发

使用独立工作区，按[开发指南](docs/DEVELOPMENT.md)与[验证指南](docs/cockpit-testing.md)
工作。服务端/core 保留 TypeScript，通过 `tsx` 运行；Web 与 MCP 需要构建。
不要在生产正在读取的源码或静态资源目录里构建候选版本。

本项目使用 [GPL-3.0-only](LICENSE)；第三方来源与署名见 [NOTICE](NOTICE.md)。
