# 安装与运行

Cockpit 提供普通前后端服务包。使用者准备运行环境、配置原生登录与远程认证入口，
并选择如何启动服务。

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

`start` 直接进入服务入口。
运行包不要求用户安装 pnpm；对应入口与产物结构由[产包说明](packaging.md)维护。
不要在现有进程直接读取的源码或 Web 目录里构建候选版本。

默认同时提供 built Web 与 API。如果没有 Web 的 `index.html`，启动明确失败，
不会在健康的名义下悄悄变成没有界面的服务。
仅在确实需要 API-only 时设置 `COCKPIT_SERVE_WEB=0`。

## 环境配置

| 变量 | 默认/含义 |
| --- | --- |
| `COCKPIT_PORT` | `8771`，只监听 loopback。 |
| `COCKPIT_HOME` | `~/.copilot`，原生 runtime 的数据与配置目录。 |
| `COCKPIT_SERVE_WEB` | 默认开启；`0`/`false` 明确关闭。 |
| `COCKPIT_WEB_DIR` | 默认使用包/源码相对位置的 `apps/web/dist`，可显式指定。 |
| `COCKPIT_ALLOWED_ORIGINS` | 可追加允许的请求来源，用于来源保护。 |
| `LOG_LEVEL` | 服务日志级别。 |

MCP 客户端配置单独见 [MCP](../apps/mcp/README.md#configuration)。
前端默认同源，显式选择的后端地址由使用者负责；开发 lab 不继承真实后端覆盖。

## 远程入口

由外部认证 HTTPS 入口保护 Web、API、MCP 和需要公开的健康/状态接口。
反向代理 SSE 时关闭缓冲并允许长连接。后端 loopback 和 Origin/Referer 检查
不是登录认证，不能把未认证的隧道作为替代。
普通代理与服务管理属于宿主选择，不由 Cockpit 安装或改写。
当前 MCP 是本地 stdio 客户端，其 HTTP 请求经过同一后端认证入口；
逐模块 HTTP MCP path 仍属于未来协议。

## 关闭

`SIGTERM`、`SIGINT` 或 `POST /intent/system/shutdown`（`{"confirm":true}`）
请求 graceful 退出。它等待原生活动和受保护调用完成，再关闭 SDK/连接，不重拉自己。
`system/status` / `GET /status` 在运行/等待阶段返回状态，关闭/失败阶段可能返回 503
错误与关闭详情，退出后 HTTP 不可达；受理不是进程已经消失。
具体工作准入、竞态和失败边界见[关闭契约](cockpit-plan.md#shutdown)。

从被关闭服务承载的 session 发起时，返回受理后结束回合，不能留后台任务等自己退出。
正常读取/显示不是业务完成条件；已有问题仍可回答，不以删除 session 或清队列制造空闲。
没有 force、取消或重启模式；重复信号不变成强停。
未来模块接入后，原生 session 空闲仍是退出的等待目标；模块活动和关闭回执不阻止退出。
