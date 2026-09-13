# 普通运行包

本页维护构建产物，不是安装器、发布控制器或部署授权。
Cockpit 只产生包含前后端与必要依赖的包，由使用者决定放在哪里、何时运行。

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

在独立位置解压后，进入包根直接运行，无需 pnpm 或开发工作树：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts
```

若需要独立 stdio MCP 客户端，包根的入口是：

```sh
node --import ./apps/mcp/node_modules/tsx/dist/loader.mjs apps/mcp/dist/index.js
```

这两个入口都直接进入对应 Node 进程，不是生成另一个进程的保活脚本。
MCP 是调用后端的客户端，不意味着另起一份后端或实现了逐模块 MCP。

## 闭包与身份

包保留工作区相对布局：server 入口、built Web、compiled MCP 客户端及它们的运行依赖。
SDK 的平台原生资产和依赖许可必须完整，不借开发 worktree 的 symlink 才能运行。
Node 可执行文件没有合包；具体 Node、平台、架构以产物 manifest 和验证范围为准。

根 `runtime-manifest.json` 记录 `format:1`、`product:"cockpit"`、版本、固定源 SHA、
Node/平台/架构及文件清单。包不包含部署环境、审批、回执、安装器、进程重拉或恢复脚本。
归档摘要用于完整性/来源核对，不把同源 checksum 宣称为抗恶意发布签名。

只有干净、已提交的固定源码可以正式产包，输出位置必须是新的独立目录；
不能覆盖正在运行文件、嵌套输出进自身输入或追随包外 symlink。
生产依赖及原生资产不能根据名字盲删；第一方用例、仅测试 fixture、开发诊断、
文档（必要 LICENSE/NOTICE 除外）、Git、外部归档和旧运维系统不属于运行包。

本体 `/version` 从包 manifest 读 `sourceSha`，与本次进程的实例 ID 一起报告。
没有 manifest 的源码模式报告 null；不从本机 Git HEAD 或外部部署环境猜 SHA。

## 构建和交付边界

普通构建、类型检查与定向用例使用仓库现有命令。CI 只验证、构建、产包和保存产物，
没有私有 SSH transfer、`workflow_run` 激活、审批或生产回调。
主分支变化不意味着任何机器已经换包；运行证据只记在[部署记录](deployments.md)。

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

旧产包器和 consumer 格式原件在[项目外归档](extractions.md)；
新包不是旧 private-CD/consumer 协议的兼容产物，现有安装不能自动采用或回滚它。
