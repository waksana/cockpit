# 安装与运行

Cockpit 提供普通前后端服务包。使用者准备运行环境、配置原生登录与远程认证入口，
并选择如何启动服务。

> 本页对应已发布的 [**v0.2.3**](https://github.com/waksana/cockpit/releases/tag/v0.2.3)。
> 安装其他版本时，请阅读相同 tag 下的文档，不混用宿主配置、模块命令或运行包文件。
> Web API v2 不兼容旧前端模块；使用文件或通知模块时，配套
> **Cockpit File 0.1.7 / Cockpit Notification 0.1.0**，下载与使用说明见[模块目录](module-catalog.md)。
> 以上为历史 Release 配对，不包含未发布源码的菜单能力；当前源码配对与能力检查见
> [模块契约](module-contract-draft.md)。开发包仍标 0.2.3 不表示两者功能相同。

本指南也供 Agent 执行安装时使用。先核对运行前提，再下载、认证、启动并完成首次聊天。
开始安装前，阅读[模块目录](module-catalog.md)，逐个向用户介绍现有模块的用途、
主要限制和与所选宿主版本的兼容性；对每个可安装模块分别询问是否安装，一次只问一个。
允许全部不安装，只安装用户明确选择的配套发行。待适配项目只作介绍，不作为可安装选项。
完成后说明已安装与实际加载的模块，以及仍需用户配置或授权的事项。
如果机器上已有安装或运行中的服务，先与用户确认再替换、停止或变更配置；
不要把安装请求当成删除旧会话或迁移用户数据的授权。
需要用户登录时引导其在本机安全输入，不要求将令牌粘贴到聊天中。

## 运行前提

| 项目 | 当前要求 |
| --- | --- |
| 发行 | **v0.2.3**；正式运行包只从[对应 Release](https://github.com/waksana/cockpit/releases/tag/v0.2.3) 获取，以 workflow 成功发布的资产为准。 |
| 平台 | Linux x64 / glibc；未承诺 musl、arm64、macOS 或 Windows 运行包。 |
| Node | **24.20.0**，由安装者单独准备；运行包 manifest 校验完整版本号，其他 patch 也会被拒绝。 |
| 原生配对 | 已包含 SDK **1.0.13**、bundled runtime **1.0.83** / protocol **3**。 |
| 源码工具 | Git、pnpm **10.34.5**；使用运行包不需要 pnpm。 |

从 [Node 官方版本目录](https://nodejs.org/dist/v24.20.0/)取得对应 Node，按官方校验说明安装，
用 `node --version` 确认输出 `v24.20.0`。不要将网上安装脚本直接管道到 shell。
源码 package 的最低 Node 声明不等于运行包支持范围。
原生登录、可写配置和工作目录由安装者准备，不能复制别人的凭据。

Web 与 API 在一个 Node 服务内；SDK 自己的进程外 runtime、原生 MCP/工具子进程正常保留。
需要长期服务时由人工或宿主自己的进程管理决定如何启动，Cockpit 不配置或依赖它。
不要对同一原生 home 启动多个相互竞争的宿主。
工具权限固定为 **`allow-all`**，工作目录、技能、MCP 和项目指令必须可信。
这不是沙箱或多用户权限系统；详细边界见 [SECURITY](../SECURITY.md)。

## 安装运行包

从 v0.2.3 Release 下载 `runtime.tar.gz` 与 `runtime.tar.gz.sha256`。
两项资产必须齐全；下载失败时先排查网络或发布资产，不使用其他版本或开发 artifact 替代。
GitHub 自动生成的 Source code ZIP/tar 不包含安装好的依赖，不能替代 `runtime.tar.gz`。

确认已准备上面的 Node 版本后，在新的下载目录执行：

```sh
mkdir cockpit-download &&
cd cockpit-download &&
curl --fail --location --remote-name https://github.com/waksana/cockpit/releases/download/v0.2.3/runtime.tar.gz &&
curl --fail --location --remote-name https://github.com/waksana/cockpit/releases/download/v0.2.3/runtime.tar.gz.sha256 &&
sha256sum -c runtime.tar.gz.sha256 &&
mkdir cockpit &&
tar -xzf runtime.tar.gz -C cockpit &&
cd cockpit
```

任一步失败都会停止后续步骤；不要忽略下载或摘要错误继续安装。
两个文件必须来自同一版本；不要分别跟随可能变化的 latest 地址。
checksum 用于校验文件完整性，不是独立发布者签名。

包内包含 built Web、MCP 客户端、server/core TypeScript、必要 loaders、
运行依赖以及 LICENSE/NOTICE；**不包含 Node、用户凭据或原生会话数据**。
完整闭包与来源清单由[产包说明](packaging.md)维护。

先完成下方原生认证，再从解压后的包根启动：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts
```

启动后按下方[首次聊天与就绪检查](#首次聊天与就绪检查)打开
**http://127.0.0.1:8771** 并确认原生回复。本地使用不需要反向代理；
远程访问必须先配置[认证 HTTPS 入口](#remote-access)，不能直接暴露未认证的服务。

<a id="from-source"></a>
## 从源码安装

普通使用者选择固定发行 tag `v0.2.3`；开发者也可以明确选择已验证的完整源码 SHA。
贡献者按[贡献指南](../CONTRIBUTING.md)工作。
在新目录中执行：

```sh
git clone https://github.com/waksana/cockpit.git cockpit &&
cd cockpit &&
git switch --detach v0.2.3 &&
node --version &&
pnpm --version &&
pnpm install --frozen-lockfile &&
pnpm build
```

不要以持续变化的 main 代替所选 tag 的固定来源。
确认 Node 为 `v24.20.0`、pnpm 为 `10.34.5`。不要升级锁文件来绕过安装错误。
先按下一节准备原生认证，然后在同一终端启动：

```sh
pnpm start
```

`start` 使用与运行包相同的显式 TypeScript loader 入口，不依赖全局 `tsx`。
不要在现有进程直接读取的源码或 Web 目录里构建候选版本。

<a id="native-authentication"></a>
## 原生认证：与远程网页登录分开

Cockpit 没有自己的 GitHub 登录页面。当前
[`OfficialRuntime`](../packages/core/src/runtime.ts)使用 `mode:"copilot-cli"` 和
`useLoggedInUser:true`，由安装版 SDK 启动配套 runtime，读取该操作系统用户可用的原生凭据。
本体不指定 `baseDirectory` 或 session 的 `configDirectory`，原生目录遵循 Copilot 自己的
默认值和配置（默认 `~/.copilot`）；`COCKPIT_HOME` 不影响它。
已有可用原生登录的用户不必重新保存凭据。

**不要安装“全局最新版 CLI”来替换此运行包的依赖。**
`COPILOT_CLI_PATH` 会覆盖 SDK 自带 runtime；正常安装应不设置它。
服务检查 runtime **1.0.83 / protocol 3**，不匹配就拒绝启动。
包内 `packages/core/node_modules/@github/copilot-sdk/README.md`、`package.json`
和 `dist/generated/rpc.d.ts` 是这里所用 SDK 契约的版本依据。
[上游认证指南](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)
说明账号、令牌类型和凭据来源，但其 main 分支可能先于此包变化。

### 首次保存 GitHub 凭据

没有现成登录时，可以通过**包内同一 SDK/runtime** 的 `account.login` 保存有效的
GitHub Copilot 凭据，不需要启动另一版本的交互式 CLI。
先按上游认证指南取得有相应 Copilot 访问权限的令牌，并准备操作系统安全凭据存储。
这会验证并持久化登录，不创建会话或发送模型请求。

以下是 **Bash** 示例，在包根或已安装依赖的源码根执行。只在自己的可信机器上运行，
且此时不要运行另一个使用相同原生目录的 Cockpit/SDK 宿主。若使用 Copilot 原生目录配置，
认证与服务需使用一致的原生配置，且不要将数据放在可替换的安装目录里。
独立数据目录不等于独立系统用户或钥匙串隔离。

```bash
unset COPILOT_CLI_PATH
set +x
read -r -s -p "GitHub Copilot token: " COCKPIT_SETUP_TOKEN
printf '\n'
export COCKPIT_SETUP_TOKEN
node --input-type=module <<'NODE'
import { CopilotClient, RuntimeConnection } from './packages/core/node_modules/@github/copilot-sdk/dist/index.js';

const token = process.env.COCKPIT_SETUP_TOKEN;
delete process.env.COCKPIT_SETUP_TOKEN;
if (!token) throw new Error('A token is required.');
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio(),
  mode: 'copilot-cli',
  useLoggedInUser: false,
});
try {
  await client.start();
  const status = await client.getStatus();
  if (status.version !== '1.0.83' || status.protocolVersion !== 3) {
    throw new Error('Unexpected runtime version; use the pinned bundle.');
  }
  const result = await client.rpc.account.login({ host: 'https://github.com', token });
  if (!result.storedInVault) {
    throw new Error('Credential was not saved. Configure native secure storage before continuing.');
  }
  console.log('Native credential saved; you can now start Cockpit.');
} finally {
  const errors = await client.stop();
  if (errors.length) throw new AggregateError(errors, 'Native setup did not stop cleanly.');
}
NODE
unset COCKPIT_SETUP_TOKEN
```

此示例已核对安装版 SDK 的公开、实验性 `account.login` schema 和脚本语法，
**尚未执行真实登录或钥匙串验证**。`storedInVault:false` 明确表示没有保存，
不要把它当成下次启动可用。
SDK 也允许在原生配置显式启用明文存储时返回 `true`，因此该字段不是加密存储证明；
本指南不建议为方便关闭安全存储。不要把令牌写入命令行参数、仓库配置或问题日志。
GitHub Enterprise 的账号与主机设置应遵循其原生认证文档，不能照搬此 github.com 示例。

### BYOK 的当前边界

SDK 支持通过 `SessionConfig.provider` 传入自定义提供方；见
[上游 BYOK 指南](https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md)
及包内 SDK README 的 `Custom Providers`。但是当前 Cockpit 没有自己的
provider 配置表单、环境变量到 `SessionConfig.provider` 的映射或 HTTP provider 参数。
core 的 `RuntimeOptions.sessionConfig` 是代码集成接口，不是可直接填写的服务器配置文件。
不能只设置 `OPENAI_API_KEY` 或照抄独立 SDK 示例就声称完成 Cockpit 的 BYOK 安装。
安装版原生 runtime 自身可接受哪些提供方配置，仍需按该版本的契约单独验证；
本指南不将尚未验证的 BYOK 配置作为新用户 quickstart，也不为此改变认证逻辑。

## 首次聊天与就绪检查

启动后另开终端，检查本机服务：

```sh
curl --fail http://127.0.0.1:8771/health
curl --fail http://127.0.0.1:8771/version
```

`/health` 的 `ok:true` 表示该请求成功，不保证模型可调用或凭据有足够额度；
其中 `login` 可能包含账号信息，不要原样粘贴到报告。
`/version` 的包版本/source SHA 来自 manifest；源码模式没有 manifest 时 SHA 为 `null`，
可另外用 `git rev-parse HEAD` 记录源码身份。

打开 **http://127.0.0.1:8771**，新建会话时选择**服务端机器上**自己有权限的可信工作目录。
创建本身不发送消息；输入一条简单文字消息并发送，确认原生回复。
服务和模型可用不是同一检查，模型权限、网络或配额失败应保留错误并分别排查。

默认同时提供 built Web 与 API。如果没有 Web 的 `index.html`，启动明确失败，
不会在健康的名义下悄悄变成没有界面的服务。
仅在确实需要 API-only 时设置 `COCKPIT_SERVE_WEB=0`。
本体仍不内置文件业务。上传和媒体预览由显式安装的文件模块提供；
HTTP/MCP 的 SDK 原生附件路径属于运行侧文件系统，不是从浏览器自动上传的文件。

## 数据根与本地模块

`COCKPIT_HOME` 只定义 Cockpit 自身数据根，默认 `~/.cockpit`；
Copilot 的原生数据和认证继续使用其自己的默认目录和配置，不由 Cockpit 迁移或覆盖。
模块安装选择、不可变代码和数据分别位于 `modules/config.json`、
`modules/installed/` 与 `modules/data/`。浏览器草稿和操作系统钥匙串不搬进这个目录。
旧部署若将 `COCKPIT_HOME` 指向 `~/.copilot`，应移除该宿主覆盖或改为独立的 Cockpit 数据目录；
这只决定模块数据的位置，不移动原生数据。不要复制、链接或搬迁 Copilot 目录来适配本体。

在包根使用实际的 Node 入口管理本地可信模块：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts install /absolute/path/module.tgz --trust-local-code --enable
```

`--trust-local-code` 明确授权包代码在宿主进程执行，不是签名验证或安全沙箱。
安装器只接收本地 `.tgz`，不执行安装脚本或自动安装依赖。
安装、启用或停用只改变下次启动选择，不会热改正在运行的服务；
是否关闭已有服务仍需遵循其正常 graceful 流程。
可安装的模块与配套版本见[模块目录](module-catalog.md)，
详细格式、状态查询和公共接口见[模块契约](module-contract-draft.md)。

## 环境配置

| 变量 | 默认/含义 |
| --- | --- |
| `COCKPIT_PORT` | `8771`，只监听 loopback。 |
| `COCKPIT_HOME` | `~/.cockpit`，非空绝对路径；仅用于 Cockpit 自身及模块数据，不控制 Copilot 原生目录。 |
| `COCKPIT_SERVE_WEB` | 默认开启；`0`/`false` 明确关闭。 |
| `COCKPIT_WEB_DIR` | 默认使用包/源码相对位置的 `apps/web/dist`，可显式指定。 |
| `COCKPIT_ALLOWED_ORIGINS` | 可追加允许的请求来源，用于来源保护。 |
| `LOG_LEVEL` | 服务日志级别。 |

MCP 客户端配置单独见 [MCP](../apps/mcp/README.md#configuration)。
前端默认同源，显式选择的后端地址由使用者负责；开发 lab 不继承真实后端覆盖。
宿主管理的服务需要显式传递与人工准备认证时一致的用户、home 和环境；
本项目不会安装 systemd 单元或自动传递当前 shell 的秘密。

<a id="remote-access"></a>
## 远程入口

由外部认证 HTTPS 入口保护 Web、API、MCP 和需要公开的健康/状态接口。
反向代理 SSE 时关闭缓冲并允许长连接。后端 loopback 和 Origin/Referer 检查
不是登录认证，不能把未认证的隧道作为替代。
普通代理与服务管理属于宿主选择，不由 Cockpit 安装或改写。
当前 MCP 是本地 stdio 客户端，其 HTTP 请求经过同一后端认证入口；
逐模块 HTTP MCP path 仍属于未来协议。

### 示例：自行管理的 nginx HTTPS + Basic 认证

以下只展示**一个单操作者 Web 入口**，不是可直接启用的完整安全配置。
先由宿主操作者为自己的域名配置 DNS、可信 TLS 证书和独立的强密码，
使用交互式密码工具生成权限受限的 htpasswd 文件。证书、私钥和密码文件不放进仓库。
域名、路径和运维策略必须替换为自己的值；不要把 HTTP 明文端口直接代理到后端。

```nginx
server {
    listen 443 ssl;
    server_name cockpit.example.com;

    ssl_certificate /etc/nginx/certs/cockpit.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/cockpit.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    auth_basic "Cockpit";
    auth_basic_user_file /etc/nginx/private/cockpit.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:8771;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_set_header Authorization "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        gzip off;
    }
}
```

所有路径共享认证，不能给 `/health`、`/version`、`/events`、`/chat/stream` 或 `/intent/*`
另开未认证例外。保留外部 Host 使同源请求与现有 Origin/Referer 检查一致；
不删除这些浏览器请求头，也不关闭 CSRF 检查来“修好”代理。SSE 不缓冲、不缓存，
但长连接仍需按宿主超时和资源限制管理。

正式开放前由操作者检查 nginx 配置，确认无凭据访问任一路径都被拒绝、
登录后 Web/API 正常、事件及时到达、8771 仍只监听 loopback。
该例使用 Basic 认证；当前 stdio MCP 使用访问令牌认证，而不是 Basic 用户名/密码，
**不能直接接入这个 Basic-only 入口**。远程 MCP 需要网关另外提供兼容的受认证入口，
细节见 [MCP 配置](../apps/mcp/README.md#configuration)，不要为 MCP 绕过网关。

## 常见问题

| 现象 | 先检查 |
| --- | --- |
| Node/平台身份不匹配 | `node --version` 必须为 `v24.20.0`；核对 manifest、Linux x64/glibc，不修改 manifest 绕过检查。 |
| `Unvalidated Copilot runtime` | 是否设置了 `COPILOT_CLI_PATH`；使用包内 SDK/runtime 配对，不随意升级全局 CLI。 |
| SDK 平台资产或 `tsx` 找不到 | 是否下载了 `runtime.tar.gz`、完整解压并从包根使用显式 loader 入口；源码则按 frozen lockfile 安装。 |
| Web `index.html` 缺失 | 源码先 `pnpm build`；运行包核对下载与解压，不能用 API-only 开关掩盖缺包。 |
| 页面出现，但没有模型/无法回复 | 检查原生认证、Copilot 访问权限、配额和网络；`/health` 成功不代表模型请求成功。 |
| 原生凭据保存返回 `storedInVault:false` | 登录没有持久化；先准备当前操作系统用户可用的原生安全凭据存储。 |
| `EADDRINUSE` | 端口已占用；不要杀掉未知进程。确认旧宿主已正常退出，或为独立原生目录选择 `COCKPIT_PORT`。 |
| 远程 401 / 403 | 401 先查网关；403 核对外部 Host、Origin/Referer 与显式允许来源，不关闭认证或 CSRF。 |
| 回复集中延迟出现、连接断开 | 检查代理的 SSE 缓冲、缓存、压缩与长连接超时，不先重发可能已受理的 prompt。 |

仍有问题时按[贡献指南](../CONTRIBUTING.md)提供版本、环境和最小脱敏复现，不上传原生 home。

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
