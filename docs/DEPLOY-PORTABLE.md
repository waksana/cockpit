# 安装与运行

Cockpit 提供普通前后端服务包，不包含安装器、更新器、循环 launcher 或私有 CD。
本页不自动部署、修改 systemd/Nginx、迁移 native home 或提供账号系统。
最后一次已记录的生产实例与当前源码可能不同，见[部署记录](deployments.md)。

## 运行前提

需要匹配包 manifest 的 Node、操作系统/架构及 SDK 原生运行条件。
当前可复验基线是 Linux x64/glibc、Node 24.20.0；Node 不打进包中。
源码 package 的最低 Node 声明不等于所有平台组合已经验证。
原生 Copilot 的登录/提供方设置、可写配置和工作目录由安装者准备，不能复制别人的凭据。

Web 与 API 在一个 Node 服务内；SDK 自己的进程外 runtime、原生 MCP/工具子进程正常保留。
需要长期服务时由人工或宿主自己的进程管理决定如何启动，Cockpit 不配置或依赖它。
不要对同一原生 home 启动多个相互竞争的宿主。

## 从源码工作

在独立工作树中安装锁定依赖并构建：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`start` 是直接服务入口，不再起一个 Cockpit 自写的 respawn 父进程。
运行包不要求用户安装 pnpm；对应入口与产物结构由[产包说明](packaging.md)维护。
不要在现有进程直接读取的源码或 Web 目录里构建候选版本。

默认同时提供 built Web 与 API。如果没有 Web 的 `index.html`，启动明确失败，
不会在健康的名义下悄悄变成没有界面的服务。
仅在确实需要 API-only 时设置 `COCKPIT_SERVE_WEB=0`。

## 环境配置

| 变量 | 默认/含义 |
| --- | --- |
| `COCKPIT_PORT` | `8771`，只监听 loopback。 |
| `COCKPIT_HOME` | `~/.copilot`，给原生 runtime 使用；不代表自动创建或迁移了旧 home。 |
| `COCKPIT_SERVE_WEB` | 默认开启；`0`/`false` 明确关闭。 |
| `COCKPIT_WEB_DIR` | 默认使用包/源码相对位置的 `apps/web/dist`，可显式指定。 |
| `COCKPIT_ALLOWED_ORIGINS` | 可追加请求来源；无写死的生产站点，不是认证或模块 API 授权表。 |
| `LOG_LEVEL` | 服务日志级别。 |

MCP 客户端配置单独见 [MCP](../apps/mcp/README.md#configuration)。
前端默认同源，显式选择的后端地址由使用者负责；开发 lab 不继承真实后端覆盖。
原 `COCKPIT_CONSUMER_*`、`SERVICE_DELIVERY_*`、`COCKPIT_ASSET_DIR` 和 heap wrapper 配置
不再控制新服务，不用旧环境变量伪造版本或恢复更新器。

## 远程入口

由外部认证 HTTPS 入口保护 Web、API、MCP 和需要公开的健康/状态接口。
反向代理 SSE 时关闭缓冲并允许长连接。后端 loopback 和 Origin/Referer 检查
不是登录认证，不能把未认证的隧道作为替代。
普通代理与服务管理属于宿主选择，不由 Cockpit 安装或改写。
当前 MCP 是本地 stdio 客户端，其 HTTP 请求经过同一后端认证入口；
不是在本体已有一个 `/mcp/...` 网关。逐模块 HTTP MCP path 仍属于未来协议。

## 关闭

`SIGTERM`、`SIGINT` 或 `POST /intent/system/shutdown`（`{"confirm":true}`）
请求 graceful 退出。它等待原生活动和受保护调用完成，再关闭 SDK/连接，不重拉自己。
`system/status` / `GET /status` 在运行/等待阶段返回状态，关闭/失败阶段可能返回 503
错误与关闭详情，退出后 HTTP 不可达；受理不是进程已经消失。
具体工作准入、竞态和失败边界见[关闭契约](cockpit-plan.md#shutdown)。

从被关闭服务承载的 session 发起时，返回受理后结束回合，不能留后台任务等自己退出。
正常读取/显示不是业务完成条件；已有问题仍可回答，不以删除 session 或清队列制造空闲。
没有 force、取消或重启模式；重复信号不变成强停。

## 旧安装

原 private-CD/consumer 程序、身份、数据库和真实模块数据没有随源码提取被删除。
旧安装不能把此包当作原 bootstrap/launcher 协议的新版本自动采用。
只有单独授权的部署/主机配置变更才能撤换旧启动方式；源码推送不是这样的操作。
保留数据的采用边界见[模块目录](module-catalog.md#interim-behavior-and-adoption)，
移出原件见[项目外归档](extractions.md)。
