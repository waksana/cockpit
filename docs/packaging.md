# 普通运行包

本页维护构建产物和包身份。
Cockpit 只产生包含前后端与必要依赖的包，由使用者决定放在哪里、何时运行。
本页对应已发布的 0.2.3 发行；其他版本应使用对应 tag 的文档。

## 获取运行包

普通使用者在 [Cockpit v0.2.3 Release](https://github.com/waksana/cockpit/releases/tag/v0.2.3)
下载 `runtime.tar.gz` 和 `runtime.tar.gz.sha256`；不必安装 pnpm 或克隆开发工作树。
在下载目录验证摘要，再解压到新目录：

```sh
sha256sum -c runtime.tar.gz.sha256
mkdir cockpit
tar -xzf runtime.tar.gz -C cockpit
cd cockpit
```

运行前准备该发行所要求的准确 Node 版本和原生认证/提供方，见[安装指南](DEPLOY-PORTABLE.md)。
当前支持 Linux x64/glibc、Node **24.20.0**。包 manifest 会核对 Node 的完整版本号，
不仅是主版本。

## 命令

先在同一干净提交上构建，再产包。产包器不会替使用者重新构建或证明任意已有 dist 的来源。
需要 Git、锁定的 pnpm 10.34.5 和 GNU tar；完整依赖安装后，产包阶段离线取得生产闭包：

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/package-runtime.mjs --source-sha "$(git rev-parse HEAD)" --output runtime-output
```

输出目录必须是仓库根下一个尚不存在的普通直接子目录名，默认 `runtime-output`。
它不是线上安装目录；已有目录、链接输出、脏源和不匹配的 HEAD 均拒绝。
输出为 `runtime.tar.gz` 和 `runtime.tar.gz.sha256`，失败不留下半成品供误用。
这里的 `pnpm deploy` 仅是包管理器的可搬迁依赖导出，不是部署到服务器。
生产依赖从共享 lockfile 派生，产包阶段离线取得固定依赖闭包。
workspace 的 injected/deduped 配置为此提供锁定图；当前无 peer 冲突的工作区依赖仍指向
源码，build 后同步实际需要注入的依赖副本。

在独立位置解压后，进入包根直接运行，无需 pnpm 或开发工作树：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts
```

若需要独立 stdio MCP 客户端，包根的入口是：

```sh
node --import ./apps/mcp/node_modules/tsx/dist/loader.mjs apps/mcp/dist/index.js
```

这两个入口都直接进入对应 Node 进程；MCP 客户端通过 HTTP 调用后端。
0.2.3 继续包含本地模块 CLI 和公共 module-api/protocol 类型，
可以在包根运行 `apps/server/src/module-cli.ts` 或 `scripts/export-module-api.mjs`，
具体命令见[模块契约](module-contract-draft.md)。
本次 Web API v2 不兼容旧前端模块；使用文件或通知模块时，必须分别配套
Cockpit File 0.1.7 / Cockpit Notification 0.1.0，见[发行说明](release-notes.md)。
这是历史 0.2.3 Release 的配套关系，不是未发布源码的兼容声明；
当前菜单能力和源码配对见[模块契约](module-contract-draft.md)，不能只凭开发包仍为 0.2.3 判断。
模块单独发行，不包含在本体运行包内。

## 闭包与身份

包保留工作区相对布局：server 入口、built Web、compiled MCP 客户端及它们的运行依赖。
包含 `packages/module-api` 与类型导出脚本；不包含用户安装的模块、`.cockpit` 数据或文件原件。
SDK 的平台原生资产和依赖许可必须完整，不借开发 worktree 的 symlink 才能运行。
Node 可执行文件没有合包；具体 Node、平台、架构以产物 manifest 和验证范围为准。

根 `runtime-manifest.json` 记录 `format:1`、`product:"cockpit"`、版本、固定源 SHA、
Node/平台/架构及文件清单。
归档摘要用于完整性/来源核对，不把同源 checksum 宣称为抗恶意发布签名。

只有干净、已提交的固定源码可以正式产包，输出位置必须是新的独立目录；
不能覆盖正在运行文件、嵌套输出进自身输入或追随包外 symlink。
生产依赖及原生资产不能根据名字盲删；第一方用例、仅测试 fixture、开发诊断、
文档（必要 LICENSE/NOTICE 除外）和 Git 不属于运行依赖。

本体 `/version` 从包 manifest 读 `sourceSha`，与本次进程的实例 ID 一起报告。
没有 manifest 的源码模式报告 null；不从本机 Git HEAD 或外部部署环境猜 SHA。

## 构建与使用

普通构建、类型检查与定向用例使用仓库现有命令。PR/main CI 验证、构建、产包，
开发 artifact 保留 7 天；它不是稳定下载入口。版本 tag 通过同一检查后发布到
GitHub Releases。使用者独立选择安装和运行时机；主分支变化不代表实例已经换包。

SDK 真机合成用例与实际包入口验证使用隔离 home/config/workspace 和受控提供方。
不能复制生产凭据或 native home，也不能从正在运行的服务目录做实验。
更多边界见[验证指南](cockpit-testing.md)。

已有包用例和实际归档检查：

```sh
node --test scripts/package-runtime.test.mjs
COCKPIT_PACKAGE_PNPM_SMOKE=1 node --test scripts/package-runtime.test.mjs
COCKPIT_RUNTIME_ARCHIVE="$PWD/runtime-output/runtime.tar.gz" \
  node --test scripts/package-runtime.test.mjs
```

前两者分别覆盖合成闭包与真实离线依赖搬迁，后者才检查指定归档。
未设置变量时相应 case 跳过，不能把跳过写成实际包/原生运行证明。

<a id="versioned-releases"></a>
## 版本发行

当前为实验性 **0.x**：Web、后端和 MCP 只承诺同一 release 的组合，
支持全新安装，不维护旧接口别名或自动迁移。破坏性输入/API 变化必须在新版本说明中明确，
不能让两个不同公开版本都只靠“当前 main”区分。workspace 的版本号统一维护。

维护者按以下顺序发行，不从未提交工作树发包：

1. 通过 PR 更新全部 workspace 版本、MCP 自报版本及本次
   [`release-notes.md`](release-notes.md)，必要时同步锁文件与支持条件。
2. 合入 main，确认该固定 SHA 的 `CI / Required checks` 全部成功。
3. 创建指向该 SHA 的 `vMAJOR.MINOR.PATCH` tag，并推送该 tag。
4. `Release` workflow 在 tag 的固定 SHA 上重新使用同一 CI；成功后下载该次 CI 的
   原始 artifact，核对 tag/workspace 版本、源 SHA、Node/平台及 checksum，再发布。

例如本次服务发行：

```sh
git fetch origin
git tag -a v0.2.3 VERIFIED_MAIN_SHA -m "Cockpit v0.2.3"
git push origin v0.2.3
```

将 `VERIFIED_MAIN_SHA` 替换成已通过检查的完整 main 提交。
发布器要求 tag 位于 main 历史中，并在发布前复核远端 tag 仍指向该提交。
仓库禁止更新或删除 `v*` 版本 tag；发布器不会覆盖已有 release 资产。
失败先明确原因；不要移动已公开的版本 tag，源代码问题通过下一个版本修复。
短期开发 artifact 可过期；当前正式 Release 的下载文件不会随 CI retention 到期而消失。
`release-notes.md` 只维护下一次/本次发行摘要，已发布说明由 GitHub Release 承载，
不在源码树堆积逐次构建归档。
