# 私有不可变交付

本文维护 Cockpit 已接入的 **`github-actions-v1` 私有部署流程**，不记录持续运行状态。
已完成的运行事实集中在[部署记录](deployments.md)。
开源消费者的发行/更新是另一条路径，见[消费者产包](consumer-publishing.md)与
[消费者安装](consumer-installation.md)；不要求消费者取得开发者的私有 CD 凭据。

## 三个不同阶段

| 阶段 | 谁负责 | 结果不代表什么 |
| --- | --- | --- |
| 源码集成 | 开发者在隔离 worktree 集成最新目标，保留他人成果并推送。 | 不等于运行版本已变化。 |
| CI 固定产包 | 根据固定 SHA 和已提交配置，执行验证/构建并产出不可变归档。 | 不等于已授权部署，也不是自动公开签名 Release。 |
| CD 安全激活 | 独立外部控制器核对审批、顺序、产物和运行身份，等待安全退出并启动新包。 | 受理/构建/等待空闲均不等于成功上线。 |

仓库为 `waksana/cockpit`，目标 `refs/heads/main`。
[`delivery-ci.yml`](../.github/workflows/delivery-ci.yml) 的 push 入口只构建；
[`delivery-transfer.yml`](../.github/workflows/delivery-transfer.yml) 只接收成功的显式请求产物。
不得通过手工 `workflow_dispatch`、改文件指针或应用 `systemctl restart` 绕过交付权威。

## 配置与包的边界

[`service-delivery.json`](../service-delivery.json) 是提交内的构建命令、产物路径和
no-force busy 策略。当前 CI 工具链为 Ubuntu 24.04 x64、Node 24.20.0、
pnpm 10.34.5、frozen lockfile；workflow actions 固定到提交。
工具集来源固定在 [`.delivery/provenance.json`](../.delivery/provenance.json)，
不能未经审阅跟随其上游 main。

运行包必须包含 built Web/MCP、server/core/protocol TypeScript、`tsx` 及匹配平台依赖，
而不只是假定存在的 `dist/`。声明列表不包含 `module-staging/`、旧 `modules/` 或 root
`skills/`。源目录中 retained tests 与可运行增强是不同东西；精确内容由实际 manifest 定义。

包不包含原生 home、用户偏好/上传、业务数据库、认证、审批和控制器凭据。
构建目录不得被生产进程直接读取，产物 symlink 不得逃向开发 worktree。
同一已验证归档从 CI 进入按摘要命名的目录，不在部署机重新构建。

已有产物边界命令：

```sh
COCKPIT_RELEASE_ARCHIVE=/absolute/runtime.tar.gz \
  node --test scripts/delivery-package.test.mjs
```

正常源码套件只验证声明和停放来源；未提供变量时跳过实际 tar case，
不能据此声称已检查某个包。更多证据界限见[验证指南](cockpit-testing.md)。

## 独立控制器与权限

控制器不是 Copilot 子任务、原生 schedule 或 Task 模块。其外部安装策略维护仓库身份、
允许的配置摘要、目标环境、启动参数、健康/版本权威及时间界限。
应用退出后，独立 singleton launcher 才选择已批准包并启动下一实例。
“外部”的含义见[进程边界](cockpit-plan.md#launchers)。

提交者使用安装者分配给自己的 submit-role 凭据文件；文件路径可作为参数，
令牌不进入命令输出、Git 或 CI 产物。不能借用其他 owner/Task 的身份。
部署审批由操作员通过独立 admin 权限登记，绑定项目、完整 SHA、环境和有效期；
本地 JSON 中写一个 `reference` 不会自行产生权威。
当前 submit role 不是项目级隔离，不能把它宣传为跨项目最小权限边界。

新配置摘要必须先审阅其实际差异，再由操作员更新外部允许项；不能为“让部署过”
关闭校验或放宽所有配置。如果控制器需要重读配置，必须先确认没有在途激活，
按该控制器的正常退出机制处理，不中断正在部署的实例。
这不授权启用另一个项目、更换用户认证或重启忙碌的 Cockpit。

## 一次请求的操作顺序

先读安装者提供的可信 toolkit 操作说明；下例变量均为本次实际指定的路径/值，
不是内置凭据或默认生产命令。

1. 在独立源码视图确认完整 `$SHA` 已包含在最新远端 main。`prepare` 还检查本地
   目标 ref 包含该 SHA；本地旧 ref 不是真实远端状态，不得移动他人的工作区来绕过它。
2. 根据真实用户授权，由操作员登记精确部署 approval，并保留原始引用及期限。
3. 生成私有 request 文件并只提交一次；成功、失败或超时后都保留原请求身份。
4. 若当前回合由待重启应用承载，提交后结束回合；由外部完成事件或下一次真实入口续验。
5. 认证 lookup 原 `requestId`，并核对实际版本、产物和新实例健康，才记录上线。

```sh
node "$TOOLKIT/bin/service-delivery.mjs" prepare \
  --repo "$REPO" --sha "$SHA" --config service-delivery.json \
  --request-id "$REQUEST_ID" --intent deploy \
  --authorization "$PRIVATE_AUTHORIZATION_JSON"

node "$TOOLKIT/bin/service-delivery.mjs" submit \
  --request "$PRIVATE_REQUEST_JSON" --credential "$OWN_SUBMIT_CREDENTIAL"

node "$TOOLKIT/bin/service-delivery.mjs" lookup \
  --request-id "$REQUEST_ID" --credential "$OWN_SUBMIT_CREDENTIAL"
```

`prepare` 只向 stdout 输出预览，不提交、不执行项目命令。保存时使用新私有文件和
限制权限，避免覆盖旧请求；`submit` 接受整个 plan envelope 或其中的 request。
只构建时用 `--intent build-only` 且不带部署 approval；它的终态 `built` 不是上线。
不能在原请求 ID 下把 build-only 变成 deploy。

## 安全切换与完成证据

```text
queued → building → built → waiting-idle → verifying → succeeded
                       原生安全退出          新包/新实例身份与健康
```

同环境部署按受理顺序串行，不按 CI 结束先后激活。每次切换重新核对授权期限、配置、
目标祖先关系和当前激活 fence；旧构建不能在较新健康版本之后倒退安装。
忙超时可失败，但不强停应用。停止源进程之前不覆盖它正在运行的文件。

`/version` 报告捕获的 SHA、产物摘要、requestId 和实例 ID；
`/health` 必须健康且属于同一实例。source 模式无可信包身份时返回 503，
不从移动 Git HEAD 猜版本。实际 Web 资源也应与该包一致，HTTP 200 本身不够。

只重启当前安装版本不会部署 main。部署流程已包含所需安全重启，
完成后不再追加一个重复重启请求。新 Web/API/MCP 源于同一个包，但已经运行的
外部 MCP 进程不会热加载 JS；它们需要正常的原生重连/恢复，不能强重载忙会话。

## 失败、恢复与数据

副作用未知时只读取原请求，禁止自动 redispatch、换 ID 重发或从“未查到”推断未执行。
操作员的 `recover` 先核对原构建/进程；不把恢复当作新部署。
二进制回退需要真实已知健康旧包和兼容数据，候选仍忙或归属未知时不能直接杀掉。
失败/未知回退必须如实保留，不报告成功，不还原业务数据库或原生历史。

禁止在待退出回合里启动后台 waiter、定时轮询或 `systemd-run --wait` 等待自己的重启。
detached shell 也可能仍计入原生活动，不能伪造 idle。外部 controller 的一次完成通知
是恢复读回的入口，不是额外的任务回执或业务完成证明。

旧包、用户数据、日志及操作回执不因这次流程自动删除。该流程没有自动模块恢复、
Task/微信启用或 unknown 渠道重发语义；增强退役与数据保留见[模块目录](module-catalog.md)。
