# 安装与运行 Cockpit

本文是安装路径的选择入口。当前功能见[架构](cockpit-plan.md)，迁出的增强及旧数据
规则见[模块目录](module-catalog.md)。安装 Cockpit 不会安装业务模块、创建角色或启用渠道。
本页描述现行方式；[下一版目标](product-requirements.md#single-service-target)是前后端包
直接 serve、无自更新/循环 launcher/私有部署启动依赖，尚未完成相应入口和包闭包改造。
不要把以下三条现行路径误读为未来本体必须一起保留的组件。

## 先选一种路径

| 路径 | 适合谁 | 入口与边界 |
| --- | --- | --- |
| 源码运行 | 开发者或自行准备运行环境的安装者 | 本页的 `pnpm start`；不会自动取得、验证或部署新 Release。 |
| 独立消费者发行 | 使用发布者提供的可信完整包 | [消费者安装/更新](consumer-installation.md)；不依赖开发者私有 CD，不接管已有私有部署。 |
| 已接入私有 CD 的实例 | 拥有相应安装策略和本次授权的维护者 | [私有不可变交付](DELIVERY.md)；固定 SHA/产物，外部控制器等待安全退出。 |

不要叠加启动器、重复启动后端或让两个运行时争用同一 native home。
仓库里的 [systemd](../deploy/systemd/cockpit.service) 与
[Nginx](../deploy/nginx/cockpit.conf) 是特定环境示例，含示例用户/路径及外部 Passkey
依赖，**不是任意机器可直接复制的完整安装方案，也不是当前主机所有 drop-in 的快照**。

## 宿主前提

源码要求能运行锁定 SDK 的 Node 环境、pnpm、Git、可写工作区及原生配置目录。
package 声明的 Node 下限是 22.12，但它不等于所有 Node/OS 组合都已覆盖：
当前 CI/发行基线为 Linux x64/glibc、Ubuntu 24.04、Node 24.20.0、pnpm 10.34.5。
消费者安装/解包还需要 Python 3.12+，精确限制以其[安装指南](consumer-installation.md#prerequisites)为准。

Windows/macOS 的源码运行需要对应 SDK 平台资产和独立进程监督配置；
这里不据一个跨平台 JS 启动器承诺这些平台的发行安装/原地更新已可用。
当前实现不捆绑 Node，不为用户安装 OS 库，不声称任意宿主无前提解压即用。

默认运行时使用**服务账户的原生 Copilot 登录**；应由安装者先配置并确认可用。
浏览器不需要自己的 Copilot 进程。远程访问另需认证 HTTPS 网关，
原生登录和网页认证不能互相替代，详见[认证边界](cockpit-plan.md#authentication)。

## 从源码启动

在独立、已选择的源码目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` 通过 `scripts/start.mjs` 启动后端，并从 `127.0.0.1:8771`
同时提供已构建 Web 和 API。启动器在子进程正常退出后可重新启动它，
连续快速退出则失败退出，交给安装者的进程监督方式处理。
长期运行需要独立终端或操作系统服务，不能靠待重启的原生会话保活。
具体 launcher 责任和三条路径的差别见[启动器](cockpit-plan.md#launchers)。

源码模式没有不可变包 provenance；此时 `/version` 返回 503 是明确未知，
不是把当前 Git HEAD 当作已部署版本。浏览器关闭不会取消已经提交的原生工作，
但进程崩溃不保证正在执行的回合无损恢复。

## 主要环境配置

| 变量 | 当前默认/含义 |
| --- | --- |
| `COCKPIT_PORT` | `8771`，后端只监听 loopback。 |
| `COCKPIT_HOME` | `~/.copilot`，默认原生存储根；不表示复制或迁移了已有 home。 |
| `COCKPIT_SERVE_WEB` | 经源码 launcher 默认 `1`；直接运行 server 时需显式开启。 |
| `COCKPIT_WEB_DIR` | built Web 路径；源码 launcher 默认使用本仓 `apps/web/dist`。 |
| `COCKPIT_ALLOWED_ORIGINS` | 追加浏览器请求来源；仍有代码内已有来源规则，不是登录认证或 API 授权表。 |
| `COCKPIT_MAX_OLD_SPACE_MB` | 可选的 API 子进程 V8 堆上限；未设置使用 Node 默认，不控制独立原生进程。 |

MCP 客户端变量单独维护在 [MCP 配置](../apps/mcp/README.md#configuration)。
消费者安装器保存自己的安装根和操作回执，不把这些当作 native session 状态。
旧上传、语音或模块环境变量不能恢复已经移除的功能。

## 远程访问与 MCP

使用同一认证 HTTPS 入口保护 Web、`/intent/*`、`/events`、`/chat/stream`、
`/capabilities` 和需要暴露的运维路径。代理 SSE 时关闭缓冲并保留长连接。
后端的 Origin/Referer 检查不是登录，不能用未认证隧道代替网关。
本体没有账户管理、认证安装器或浏览器文件传输服务。

构建后将 `apps/mcp/dist/index.js` 注册为 stdio MCP，配置它能访问的后端 URL；
准确工具和示例见 [MCP](../apps/mcp/README.md)。MCP 无需挂载后端历史数据库。
其原生附件路径属于 Copilot 运行侧，不会把另一台机器的同名路径自动上传。

## 采用旧安装与重启

升级前应由安装者安排符合该服务一致性要求的备份；本指南不自动执行备份、
复制凭据、迁移 native home 或删除用户数据。旧模块协议和托管附件接口不兼容，
数据保留不代表旧文件链接仍可下载；富草稿也不自动进入新的文字输入框。
完整采用规则只维护在[模块目录](module-catalog.md#interim-behavior-and-adoption)。

普通重启只重新启动所选代码，部署新版本才会改变该选择。
私有实例使用[交付流程](DELIVERY.md)，消费者使用自己的[显式更新/重启](consumer-installation.md#explicit-check-download-install-and-restart)。
便利重启脚本和 MCP 工具已停放，底层安全退出仍在，不得改用强制服务重启绕过原生 busy。
当前回合由待重启应用承载时，提交后结束回合，不能后台等自己退出。

不要在服务正在读取的源码或 Web 目录里构建候选版本；分离源码、不可变程序、
原生数据和秘密。刷新网页、重连 MCP、reload 单个 session、重启服务、部署代码和
Context Reset 是不同操作，不能用其中一个冒充另一个。
