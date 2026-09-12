# URL驱动模块契约草案

> **设计提案，未实现，也不是当前产品能力或部署授权。**
> 现行模块契约见[官方模块与会话角色](module-system.md)，现行发行方式见
> [模块Release](module-releases.md)，原则仍以[产品要求](product-requirements.md)为准。

本稿维护一份现状接口盘点和拟议契约，2026-09-12。源码盘点基线：
[Cockpit f734cb1](https://github.com/waksana/cockpit/tree/f734cb1be9235f8b8bcc103d0689d22d0748c2de)、
[Task 1.2.7](https://github.com/waksana/cockpit-task/tree/d9252de5a44be14165a4c4d8b83dc3564f971ff5)、
[WeChat 0.1.6](https://github.com/waksana/cockpit-wechat-connector/tree/4bc21437806cfd00e2e1f65c7dccdb95399dcef6)。
这些是代码引用，不是某个生产实例的验收记录。

文中“现状”指固定代码；“候选/MUST/请求示例”属于未来契约。
`schemaVersion:2 / hostProtocol:2`用于区分草案和当前v1。示例版本带
`-draft.1`，不是已发布的新产品。所有样例均为合成数据，见
[示例说明与文件](examples/module-contract-v2/README.md)。

## 已确认的简化边界

以下取舍替代本稿早期的细粒度API授权和旧版兼容设计；**只确定设计，不表示已经实现**。

- 核心是好用的Copilot代理和通用模块宿主，不拥有Assistant、Task、Commander或微信
  业务概念。Copilot原生的`assistant`消息角色/事件和`task`子代理工具保持正常代理、
  展示与生命周期保护；`assistant`并不是一个同名工具，也不是这里的Assistant模块。
- 受信任且启用的模块默认可访问**所有公开产品API**，与Web/MCP使用同一接口和认证边界。
  不设计每模块的API白名单、目标scope或权限委派体系；仍保留接口自己的参数校验、
  确认、busy和unknown规则，模块服务自己的业务鉴权仍由模块负责。
- 模块自己获取/处理文件，直接调用通用上传接口，再向prompt提交附件引用。文件字节
  不走模块JSONL控制消息；不要求所有模块HTTP调用绕`host.invoke`，不另造大文件协议。
- 新协议不兼容旧模块协议、专用路由、旧配置格式或旧driver。第一节保留旧代码的
  接口事实作为设计输入，不是兼容承诺。此决定不授权删除现有数据或改变运行实例。

## 0. 推荐结论

把模块定义为**独立版本和责任边界的能力单元**，由静态manifest描述；
把宿主做成有限能力协议的执行者，而不是任意插件框架或第二个业务后端。

首版推荐一个标准入口：**HTTPS签名发行描述URL**。官方目录只是发现入口和
可选预置信任，不是身份白名单。新增一个使用既有能力协议的模块，无须新增
`ModuleId`枚举、仓库allowlist、业务if分支或路由。

模块业务身份、绑定条件和业务恢复留在模块。宿主保留签名/安装/配置保护、
原生适配、进程归属、操作回执和最小恢复。只有用户明确授权“使用”后才运行
服务、hook或MCP；inspect/verify不执行包代码。

**“给URL即可接入”不等于“任意URL自动可信并执行”。** 合规URL可以到达清楚的
识别/兼容/信任结果；未知发布者仍需一次最少确认，缺业务配置仍需补配置。
无需改宿主代码或让用户手工拷包，才算达到目标。

## 1. 现状接口盘点（非新协议）

### 1.0 范围、基线与引用

这是 **设计输入的现状清单**，不是未来 manifest/trust/install-state 设计，也不是运行验收。仅依据固定公开程序、manifest 和接口实现；没有调用服务、读取真实配置/凭据/业务状态、执行被审阅程序/测试、安装或变更会话。

- **C**：Cockpit 源码根，commit `f734cb1be9235f8b8bcc103d0689d22d0748c2de`。
- **T**：Task **1.2.7** 源码根，commit `d9252de5a44be14165a4c4d8b83dc3564f971ff5`。
- **W**：WeChat **0.1.6** 发布包程序根，只审阅公开静态 manifest/entry/interface；没有读取 profile、配置、state、凭据或运行 `status` / `can-bind` / control。
- 下文 `C 路径:行`、`T 路径:行`、`W 路径:行` 都相对于上述源码或发布包程序根，构成精确文件定位。版本仅界定审阅代码，不宣称任何实例的安装、运行或部署状态。
- 同组连续引用继承前一个 C/T/W 根；仅有文件名的 `manager.ts`、`adapters.ts`、`supervisor.ts` 固定指 C `packages/core/src/modules/` 下对应文件；仅有 `index.ts` 固定指 C `packages/protocol/src/index.ts`，不是 server entry。
- 本文不包含内部审阅存放路径、真实 task/session ID、凭据内容或运行中业务事实；历史审阅实验不计作本清单的动态验证。

**阅读约定：**表中列出实际入口、调用者用到的 schema/字段和实现返回的关键形状；`…` 表示省略字段，不是可发送的 JSON。**没有声称每个响应字段、SDK 元数据字段、业务状态机分支或所有管理 CLI 均已完整审阅。**示例中的 session/task/operation ID、路径、内容都是合成占位，不是真实身份或凭据。API 名保留实际 camelCase，不能直接把 MCP 的 snake_case 参数当 HTTP body。

### 1.1 先看当前真实边界

```text
Assistant release ──instructions/skills──> Host role composer ──> native session
Task release ──role + stdio MCP──> session ──work_*──> independent Task HTTP service
                                                    └─ /intent/* ─> Cockpit ─> native SDK
Host ──Task setup child / caller HTTP / viewer proxy / service runner──> Task
Host ──WeChat control child / service runner──> WeChat
WeChat connector ──capabilities / native-session intents / managed files──> Cockpit
```

**身份约束：**Cockpit 创建时先选定 `sessionId`，把同一 ID 交给 SDK，核对 SDK 返回 ID，之后才执行 `modules.connected`；这是原生会话的真实 ID，不是模块另建的影子 ID（C `packages/core/src/engine.ts:473-485,551-575,638-664`）。Task 的 `taskId/workstream/goalVersion/operationId` 与 WeChat 的 binding ID/revision 是各模块自己的业务/控制身份，**不能代替 native sessionId**。模块角色、文件路径、caller/owner 字样本身也不是授权。

### 1.2 Host → module：静态角色、初始化、进程与生命周期（01–12）

**现有 driver 配置形状（只读源码，不是实例配置）：**Host 外壳是 `ModuleConfig{moduleId,revision,configVersion,values}`；`values` 当前仅接受 `ownership`、`activationEnabled`、`serviceUrl`、`gatewayUrl`、`managerCredentialFile`、`viewerCredentialFile`、`credentialDirectory`、`retainedCredentialDirectory`、`configFile`、`dataDirectory`。其中 secret-bearing 内容只通过绝对路径引用；serviceUrl 限显式 IPv4 loopback HTTP origin，gatewayUrl 限 HTTPS origin。Assistant 仅允许 `ownership:"none"`；retained-root 仅 managed Task。它是 Host 内置白名单，不是每个 manifest 任意贡献的 config schema（C `packages/protocol/src/modules.ts:111-118`；C `packages/core/src/modules/adapters.ts:9-64`）。

| # / 接口与方向 | 传输、入口、输入 → 输出形状 | 调用时机；状态所有者；副作用 | 错误 / unknown / 幂等；当前硬编码与证据 |
|---|---|---|---|
| **01 读取 release manifest**，Host ← 模块静态文件 | `module.json`：`schemaVersion:1,id,version,name,description,compatibility,configVersion`；可选 `roles[]`、`service{entry,args?,healthPath,versionPath,drainPath,publicPath?}`、`sessionLifecycle{unbind?,canBind?}`、`configLifecycle{initialize?}`；hook 为 `{entry,args?}`。→ 校验后的 `InstalledModule{manifest,release,digest}`。 | 安装解析、选版、角色/服务执行边界；Host 拥有安装 inventory/pin，模块拥有包内容。读取声明本身不发消息、不创建业务身份。 | 严格键/相对 entry/兼容校验；不是 URL 执行接口。ID 只有 `assistant/task/wechat`，兼容类固定 API1/Node24/Linux x64，`binding` 只允许 WeChat。C `packages/core/src/modules/catalog.ts:10-38,173-245`；C `packages/protocol/src/modules.ts:7-22,44`。 |
| **02 通用 session-role 宿主接口**，Engine → module manager → native configuration | 进程内 `prepare(sessionId,cwd,selections,operationId)`、`configuration(sessionId,cwd?,applying)` → `systemMessage/skillDirectories/mcpServers/disabledSkills`；`connected(sessionId,sdk,applying)`、`failed`、`assertReady/read/removed`。外层 `session/new{cwd,modules?}`；`session/modules/apply{sessionId,selections,operationId}` → `{modules}`。 | 显式新建/应用、cold resume；Host 记录 selections/pendingSelections/phase/operation；native 拥有实际会话与连接。composer 用 `systemMessage.mode:"append"`，不覆盖工程指令，不写全局开关。 | 校验技能实际固定路径与 MCP `connected`；同名 project/global/selected 资源冲突拒绝；连接一直 pending 可 unknown。普通未选模块会话不自动加角色。通用接口不懂 Task 目标，但 manager 内部仍按 ID 分流。C `packages/core/src/module-session.ts:4-17`；C `packages/core/src/modules/role-environment.ts:44-126`；C `packages/protocol/src/index.ts:868-882`。 |
| **03 Assistant 内容入口**，Host ← Assistant；无独立 module→host 服务接口 | `assistant/assistant@1.0.0`：`roles/assistant.md` + `skills/` 下 `cockpit-assistant`；skill 引用相对 `references/memory.md` / `personality.md`。无 service、MCP、setup、bind hook；输出是 append 文本及 native skill 配置，而非 RPC 响应。 | 选角色后 create/resume/apply；包拥有说明，native 会话拥有加载结果，用户 workspace 不由安装器初始化。后续记忆文件操作需要实际任务授权。 | 不自动 onboarding、创建人格/记忆文件、派工或回放。Host 明确拒绝 Assistant 的 service/workspace-init 配置，manager 跳过初始化。C `modules/assistant/module.json:1-16`；C `modules/assistant/roles/assistant.md:3-19`；C `modules/assistant/skills/cockpit-assistant/SKILL.md:9-25`；C `packages/core/src/modules/adapters.ts:61-63`；C `packages/core/src/modules/manager.ts:249-251,293-294,313-314`。 |
| **04 Task 角色与 MCP 注入**，Host ← Task package；Host → native local MCP 配置 | `task/commander` 或 `task/owner`，分别 instructions 与 `skills/commander` / `skills/owner`；都声明 `cockpit-task:{entry:"src/mcp.js"}`。转换成 `type:"local",command:process.execPath,args:[固定release entry],tools:["*"]`；Task 专用 env：`WORK_URL/WORK_CREDENTIAL_DIR`、可选 retained-root/version、commander 的 `COCKPIT_TASK_ACCESS_FILE`；append 只给 `taskAccessFile` 路径。 | create/apply/cold；Host 组合环境和 session access 引用；Task 服务拥有 caller/owner 凭据。owner 不走 caller provisioning，初始 receipt 可为 `unprovisioned`。 | 同一模块只选一个角色；列表硬过滤 `role.id==="owner"`，不让普通新建选择；Task 自己派发 owner。role 不等于凭据/授权。C `packages/core/src/modules/manager.ts:191-218,251-270,304-355,439`；T `module.json:17-34`。 |
| **05 WeChat binding-only 角色**，Host ← WeChat package | `wechat/wechat@0.1.6`；只有角色 id/name/description；`binding:"wechat"`；可选能力实际已声明 `sessionLifecycle.canBind/unbind.entry:"src/module-control.js"`。→ Host 角色选项、绑定初始化，不产出 instructions/skill/MCP。 | 选项发现、prepare/connected/cold verification；Host 保存角色 pin/初始化引用，WeChat 拥有唯一 binding。 | Host 显式禁止 WeChat instructions、skills、MCP；ready 校验不是一般模块判断。C `packages/core/src/modules/manager.ts:195-197,235-244,330-352,429-433`；W `module.json:1-21`。 |
| **06 Task fresh setup**，Host → Task 一次性子进程 → Host config | 外部 `modules/config/initialize{moduleId:"task",operationId,version,digest,gatewayUrl,confirm:true}` → `{operation:{目标字段,phase,updatedAt,config?,reason?}}`。Host 以 `node <release>/src/module-setup.js`、空 env、stdin 单个 JSON `{operation:"config-initialize",operationId,dataDirectory}` 调用；child → `{ok:true,operationId,dataDirectory,credentialDirectory,managerCredentialFile,viewerCredentialFile}`。 | 仅显式 fresh 初始化；Host 要求 revision0/空 values/空 data，选择端口并 CAS 发布配置；Task 创建自己的 DB、viewer 和 manager 文件及 durable setup receipt。**不启动服务、不建 native session、不发 caller。** | Task 同 operation 完成后验证文件 hash 读回；不同 ID 冲突、非空数据拒绝、半成品 unknown 禁止重新 mint。Host 30s/64KiB/非零退出或不可信引用可能 unknown；拒绝后未退出 child 仍计 active。专用 `task` 目录、manager/viewer 双引用与结果字段验证写在 Host。C `packages/core/src/modules/initialization.ts:141-274`；C `packages/protocol/src/modules.ts:120-135`；T `src/module-setup.js:9-15,55-84,86-166`。 |
| **07 Task caller provisioning**，Host → Task HTTP → Cockpit metadata | `POST /admin/module/caller`，manager bearer 来自受保护文件；body 严格 `{requestId,sessionId}`；→ `{credentialFile}`。Task 首次调用自身 Cockpit adapter 的 `session/get` 核对真实 native ID。 | commander 的 native skill/MCP 连接确认后；Host 先记 `attempted`，Task 先 reserve `module_provisions` 后签发 caller；Host 写 access 引用、digest 和 ready receipt。不是 host 自行签发 caller。 | 同 requestId+sessionId 返回原路径；换 session 冲突；reservation 不完整不再签发。Host 请求/响应不确定即保留原 operation unknown，且硬认路径 `module-caller-<sha256(operationId)>.json`。C `packages/core/src/modules/manager.ts:304-355`、`adapters.ts:266-289`；T `src/server.js:93-108`、`src/module.js:20-56`。 |
| **08 Task ready/cold 身份核对**，Host → Task 只读 HTTP | `/version` + `/health`；再 `POST /api/read`，caller bearer，固定 body `{view:"summary",limit:1,before:1}`；Host 要求 `{items:[],nextBefore:null}` 并前后核对凭据 digest。 | 已 ready 的 prepare、cold load、connected/readiness；Host 读取固定 receipt/access，Task 认证 caller；不签发、不派发。 | missing/changed receipt 或 authority 不一致要求 explicit adoption/reconciliation；`attempted` 不自动再 provision。Host 知道 Task 的业务分页形状，把空页作为认证探针；不是通用 `/authenticate`。C `packages/core/src/modules/adapters.ts:93-134,254-263`、`manager.ts:111-165,185-190,285-301`。 |
| **09 managed 服务启动与 runner 边界**，Host → runner → Task/WeChat | 公共 `modules/service{moduleId,action:"start"/"stop"/"apply",operationId,version?,digest?,recoveryOf?,confirmRecovery?}` → `{job}`。内部 private Unix socket 为 JSON 行 `{type:"control",command:{id,…}}` → `{ok:true,result:job}`；再 spawn `node <pinned service.entry> args`。共同 `COCKPIT_MODULE_ID/VERSION/DIGEST/INSTANCE/PORT`；Task 翻译 `WORK_* / COCKPIT_URL`，WeChat 加 `--config <reference>`。 | 显式 start/apply、宿主 exact-pin restore；runner 拥有 child/job/runtime identity；模块拥有自己的 DB/业务。不是 import/list 自动启动；不能接管外部进程。 | public start/apply 必须 version+digest；stop 不选 release；接受不代表 ready；端口占用/身份不符不 adopt，控制超时读原 job、不盲重发。服务 ID 仅 Task/WeChat，Task env 与另一分支的 WeChat config 是硬编码 driver。C `packages/protocol/src/modules.ts:44-90`；C `packages/core/src/modules/supervisor.ts:102,122-124,249-289,551-598,775-825`。 |
| **10 Task version/health/status**，Host → Task HTTP | `GET /version` → runtime `{projectId:"task",moduleApi:1,version,moduleVersion,moduleDigest,instanceId,identitySource,authority,…}`；`GET /health` → `{ok,version,release,instanceId,moduleVersion,moduleDigest,authority,observedAt}`；`GET /status` → lifecycle 状态加 identity。 | Host readiness/list/drain 前，其他显式状态消费者；Task runtime 冻结启动身份；health 执行 DB quick_check。不把安装版号冒充运行版号。 | module env 必须完整并与实际 package/version 相符，不能混 delivery/module authority。Host checks moduleApi1、相同 instance；runner 进一步校验固定 digest/version。C `packages/core/src/modules/adapters.ts:237-263`、`supervisor.ts:217-233`；T `src/runtime.js:4-40`、`src/server.js:73-80`、`src/lifecycle.js:29-39`。 |
| **11 WeChat version/health/status**，Host → WeChat loopback HTTP | `GET /version` → managed `{moduleApi:1,moduleId:"wechat",version,moduleVersion,moduleDigest,instanceId}`；`GET /health` → identity + `{running,ok,phase}`；`GET /status` → identity + `{drainProtocol:1,running,restartPending,phase,reason}`。 | `cli.js run` 安装 lifecycle listener；Host 实例/健康核对。不等于 binding `status` JSON hook，更不等于 WeChat 消息状态验收。状态回调/业务安全由 connector 提供。 | 要求 literal IPv4 loopback peer/Host、无 Origin/sec-fetch-site；403/404 明确。env/manifest/package 不同版或 mixed authority 拒绝。C 通用 runner 使用声明的路径，但只支持两个 service IDs。W `src/lifecycle.js:5-29,50-87`、`src/cli.js:179-196`；C `packages/core/src/modules/supervisor.ts:217-233`。 |
| **12 safe drain**，Host runner → 两种服务 | Task `POST /drain`，manager bearer；WeChat `POST /admin/restart`，本地非浏览器控制；body 都仅 `{pending:true}`。Task → `{ok:true,pending:true,restartPending,acceptingMutations,inFlight,…,instanceId,moduleVersion,moduleDigest}`；WeChat → row11 status snapshot（**没有统一的 `ok` 字段要求**）。 | stop/apply/宿主退出时；runner 先验同实例、一次请求、等待 owned child clean exit；Task lifecycle 停止接收新 mutation、等 active mutation；WeChat requestDrain 交现有 connector 安全边界。 | acceptance 不是退出；Task `SERVICE_DRAINING`503 拒新 mutation、不可取消 drain。runner 不明结果不 signal/替换，不设强杀期限；receipt identity 缺失时再验，冲突拒绝。两端接口幂等程度不能代替 runner 的“不重放 uncertain mutation”。Task bearer 分支专用。C `packages/core/src/modules/supervisor.ts:599-633`；T `src/server.js:109-115`、`src/lifecycle.js:11-49`；W `src/lifecycle.js:85-122`、`src/cli.js:179-196`。 |

### 1.3 Task 的 MCP → 独立服务 → Cockpit 链，以及 viewer gateway（13–21）

| # / 接口与方向 | 传输、入口、输入 → 输出形状 | 调用时机；状态所有者；副作用 | 错误 / unknown / 幂等；当前硬编码与证据 |
|---|---|---|---|
| **13 Task MCP transport**，native session → Task MCP → Task service | 发布包 `src/mcp.js`，MCP stdio server 实际名 `work-commander`，Host 配置名 `cockpit-task`。注册 10 个 `work_*`：在各业务 schema 上增加必需 `credential:<protected-file-path>`。MCP 从限定 root 读取认证，剥离 `credential`，`POST /api/tools/<name>` 发业务 JSON + bearer；→ MCP `content:[{type:"text",text:JSON.stringify(result)}],isError`。 | 每次显式 tool call；MCP 是认证/传输桥，Task HTTP service/Store 才拥有业务和幂等记录；不直接通过 MCP 创建 native session。 | 240s timeout、redirect:error、无自动 HTTP 重试；HTTP失败或 operation `failed/unknown` 标 isError；client catch `CLIENT_ERROR` 提醒读回/同 key-input，不换 key。严格 root/retained-version 校验。这是独立 Task 模块 MCP，不是 Cockpit 基础 MCP、SDK native tasks 或 npm `commander`。T `src/mcp.js:10-68`、`src/contracts.js:13-126`；T `src/server.js:126-132`。 |
| **14 只读与记录/授权元数据工具**，MCP → Task service | `work_read{taskId?,workstream?,query?,view?,group?,status?,includeClosed?,limit?,before?}` → 依 view 的页/详情，summary 页 `{items,nextBefore}`；`work_record{action,taskId?,recordRevision?,title?,…}`；`work_dependency{action,taskId,prerequisiteId,recordRevision,…}`；`work_observe{taskId,recordRevision,observedState,observedAt,source,summary,…}`；`work_import{mode,manifestId,planHash?}`；`work_amend{taskId,goalVersion,goal,reason}`。mutation 均加 `idempotencyKey`。 | read 按 caller/owner/viewer 可见范围；其余 caller-only；记录、依赖、历史观察/导入及 amend 在 Task Store 内完成。amend 增 goalVersion、清旧 acceptance，**不自动发送/重开 owner**；这些入口不调 Cockpit。 | `recordRevision` 和 `goalVersion` 不可混用；stale、wrong scope、hash-plan/显式来源等检查。按 principal+key+canonical input 绑定幂等；changed input 为 `IDEMPOTENCY_CONFLICT`。Host 不需要理解这些业务 fields；仅 row08 空页认证例外。T `src/contracts.js:47-100,113-117,128-138`、`src/work.js:43-59,90-166,167-211,228-279,326-336`。 |
| **15 owner 报告 / 最终交付**，MCP → Task service | `work_report{idempotencyKey,taskId,goalVersion,kind,summary,artifacts?}`，kind=`accepted/progress/blocked/needs_decision/result` → `{task,notification:"not_sent"}`。`work_deliver{…,outcome:"delivered"/"failed"/"cancelled",summary,artifacts?}` → `{task,operation}`，operation 状态见 row16。 | 绑定 owner/current goal；Task 持久化 acceptance/progress/result，deliver 先 commit 整目标结果，再尝试 **一条 caller prompt 通知**。普通 report/result 不通知 caller。 | scope、`STALE_GOAL/NOT_ACCEPTED/TERMINAL_GOAL/ALREADY_DELIVERED`；delivered 要可定位 artifacts。通知失败不抹结果；返回成功 operation 也不表示 caller 已读。exact-key replay 读原 operation，不再次通知。T `src/contracts.js:101-117`、`src/work.js:171-211,337-359,557-573`。 |
| **16 dispatch / recover 业务边界**，MCP → Task service → 下列 native APIs | `work_dispatch{selection,new/fork/continue/adopt 所需字段,modelId?,reasoningEffort?,contextTier?,idempotencyKey}`；`goal={objective,scope,acceptance,authorization}`。new 要 absolute cwd+goal，fork 要 sourceSessionId，continue 要 taskId+goalVersion+message，adopt 要原记录+recordRevision+goal；`work_recover{operationId,idempotencyKey,resolution?{outcome,evidence,sessionId?}}`。→ `{task,operation:{operationId,kind,goalVersion,status,step?,error?,completedSteps,metrics}}`。 | caller 显式执行完整目标；Task 拥有任务/版本/owner绑定/operation/step/session locks/owner credential；调用 Cockpit 只是操作原生资源。默认模型 Astra；无调度器/工作树隔离。 | mutation exact-key 读回；step 先 inflight 再执行，unknown 不自动续做；recover 必须显式，创建 unknown 的 applied 证明需要真实 native sessionId。1.2.7 known absence 源码分支仍可能保留旧 active_op/locks，不能宣称已自动释放，也不证明某实例发生过该情况。T `src/contracts.js:14-46,118-126`；T `src/work.js:60-89,171-224,280-325,361-415,575-601`。 |
| **17 Task → Cockpit presence/load** | Task `Cockpit.call` 发 `POST /intent/session/get {sessionId}` → `{meta:SessionMeta或null}`；必要时 `POST /intent/session/load {sessionId}` → `{ok:true,sessionId}`，再 metadata 核对。共同 HTTP adapter 支持可选 Cockpit bearer，60s timeout，redirect:error。 | provisioning、caller/source/owner检查、prompt前、通知前；unloaded 不等于 missing。Task 只引用 native ID，Cockpit/native 管真实 presence、loaded状态。load 有运行时副作用但不发消息/建替代 ID。 | **仅有效成功响应的 `meta:null` 是 `SESSION_NOT_FOUND`**；403/timeout/坏schema 是 `UPSTREAM_READ_FAILED`。mutation HTTP/schema不明为 `EFFECT_UNKNOWN`，即使HTTP错误也可能已提交。T `src/cockpit.js:7-59`、`src/work.js:430-447,470-478,508,564`；C `packages/protocol/src/index.ts:979-983,1049-1052`。 |
| **18 Task → Cockpit new/fork** | `POST /intent/session/new {cwd,modules:[{moduleId:"task",roleId:"owner",version:"1.2.7"}]}` → `{sessionId}`；fork 发 `POST /intent/session/fork {sessionId:sourceSessionId,toEventId?}` → 新 native `{sessionId}`。 | 首次授权而未有 owner；Task 把已确认返回 ID 绑定为 owner。managed new 不隐含 Assistant；fork 继承 native history/cwd、不是文件隔离，之后显式核对角色。 | create/fork 非幂等原语；Task 用 durable create step 保留结果，不换身份重试；fork source 必须已 loaded/idle；结果无有效 ID 为 unknown。**不把 operation/taskId 当 sessionId**。T `src/work.js:28-33,397-407,469-489`；C `packages/protocol/src/index.ts:868-872,884-893`。 |
| **19 Task → Cockpit model/role 配置** | `POST /intent/setModel {sessionId,modelId,reasoningEffort?,contextTier?}` → `{ok:boolean}` 后 get 再验；`session/modules/get{sessionId}` → `{modules:null或SessionModules}`；`session/modules/apply{sessionId,selections,operationId}` → `{modules}`。仅 unmanaged fallback：`mcp/session-toggle{sessionId,name:"work-commander",on:true}` → `McpToggleResult`（Task检查返回的status若存在须connected）；`skills/session-toggle{sessionId,name:"work-commander-owner",enabled:true}` → `{ok:boolean}`。 | 派工准备、显式继续/recover；native 负责 model/MCP/skill，Host 负责 role pin，Task 负责已完成步骤。sole-owner continue/adopt 保留已有版本；fresh new 只读验角色，不能为修复而关闭重配空会话。 | busy model mismatch 不改；坏/未applied module response 不发 prompt；新建角色不符 `MODULE_NOT_CONFIRMED`。Task 自己硬编码 owner selection/legacy MCP/skill 名；Host 端这组 session API 本身按参数分派。T `src/work.js:448-466,491-506,524-555`；C `packages/protocol/src/index.ts:873-882,932-940,1124-1127,1150-1153`。 |
| **20 Task → Cockpit prompt** | `POST /intent/prompt {sessionId,text,mode:"enqueue"}` → `{ok:boolean,queued?:boolean}`。owner text 含当前 task/version/goal/路径引用；caller text 含 task/version/final/result/链接。 | dispatch 已验 owner/model/module 后，或 deliver 的单次通知；Task 记录 prompt/notify step；Cockpit/native 拥有 queue/turn。接收≠开始≠owner接受≠完成≠caller已读。 | Task transport 不自动重发；已完成 step 不再 send。Task 生成的任务说明/通知是业务逻辑，Host `prompt` 不解析 taskId/goalVersion。native prompt 本身没有 Task idempotencyKey；exact-once 边界依 Task 操作记录与显式 unknown recovery。T `src/work.js:379-396,416-429,508-522,557-573`；C `packages/protocol/src/index.ts:913-923`。 |
| **21 Task viewer gateway**，browser → Host → Task | Host `/modules/task` → `/modules/task/`；仅 GET/HEAD `/`,`/app.js`,`/style.css`,`/api/events` 和 POST `/api/read`，代理时剥 `/modules/task` 前缀、重设 public Host、用私有 **viewer** bearer替换客户端认证。`/api/read` 使用 row14 schema；SSE `ready/changed` data `{}` 与 heartbeat，非任务正文流。 | 用户打开 dashboard/read/SSE；Host 负责公开入口/代理，Task 负责 viewer认证、数据可见范围、HTML basePath与查询。读不派工；SSE 定期重新授权。 | 路径404、未配置503、origin mismatch403、POST >64KiB413；Task再次只许 viewer/只读 route，gateway SSE≤60s重连。路由、允许列表、`taskGateway()` 均 **Task 专用硬编码**；`service.publicPath` 不自动注册任意页面。C `apps/server/src/module-proxy.ts:4-45`、`packages/core/src/modules/manager.ts:607-614`、`apps/server/src/index.ts:952`；T `src/server.js:20-58,116-161`。 |

#### Task 工具 schema 的共性边界

所有 `work_*` 均来自 T `src/contracts.js`；**凭据路径只在 MCP 外层 schema 出现，HTTP body 不带它**。`work_read` 不要求幂等 key，其余工具要求 `idempotencyKey`。record 操作的 CAS 是 `recordRevision`，已授权目标的 CAS 是 `goalVersion`。service 在认证后再做 caller/owner/task/session scope 检查（T `src/store.js:136-157`、`src/work.js:43-59,167-211`）。这不是用 role 名或调用者自报 sessionId 来授权。

### 1.4 WeChat：只枚举静态 control / connector→Cockpit 接口（22–30）

下面记录的是接口实现会做什么，**并未调用这些方法**，也不复述消息收发、outbox/inbox 处理或真实用户业务。

| # / 接口与方向 | 传输、入口、输入 → 输出形状 | 调用时机；状态所有者；副作用 | 错误 / unknown / 幂等；当前硬编码与证据 |
|---|---|---|---|
| **22 WeChat control JSON envelope**，Host → release entry | `node <pinned>/src/module-control.js --config <reference>`，stdin JSON；Host 内部 `action` 被翻译为 wire `operation`。允许 `status/can-bind/bind/unbind/session-unbind`；stdout 单 JSON `{ok:true,…}` 或 `{ok:false,error:{code},…}`；失败 exit2。Host 依据 `sessionLifecycle` 找 canBind/unbind，status/bind 默认 entry 固定。 | list/admission/prepare/connected/手动解绑；WeChat 子进程拥有控制效果，Host 保存自身 operation/initialization receipt并跟踪 active child。 | entry请求限16KiB、stdout上限检查按JSON字符串长度16K、stdin5s；Host maxBuffer128KiB，没有在该 `execFile` 配置中设完成期限。合法 exit2+error code 是已知失败，UNKNOWN/UNCONFIRMED 标不明；坏JSON、operation/session echo不符、异常退出不确认。不是可随 manifest 指任意 HTTP URL 的hook。C `packages/core/src/modules/adapters.ts:291-360`；W `src/module-control.js:14-20,177-192,320-345`。 |
| **23 binding `status`**，Host → WeChat control | `{operation:"status"}` → `{ok:true,status:{available,reason,boundSessionId,managed,configReady,credentialsPresent,unknownOperation,running,runnerUnknown,pendingJobs,unknownJobs,revision,bindingConfirmed,…}}`。partial 时 jobs 可 `null`，`detailsAvailable:false`；可有 adopted/activationState/retainedMissingBindings。 | 普通 modules/list、cold identity核对、移除role前检查；connector 拥有控制/绑定/业务阻塞判定，Host不应把缺字段/null当0。该分支做状态读取，不调用 native metadata清理或bind。 | Host 目前明确解释这些字段；初绑还要求 pending/unknown jobs=0、stopped、available、unbound、reason:null；已绑定验证 sessionId/revision，识别 `ALREADY_BOUND/RUNNING` 及指定业务 blocker reason。不是通用 health/readiness boolean。C `packages/core/src/modules/adapters.ts:142-174`、`manager.ts:185-190,235-244,429-433`；W `src/module-control.js:61-148,215-225`。 |
| **24 optional `can-bind` admission**，Host → WeChat → Cockpit | `{operation:"can-bind"}`，**不接收 prospective sessionId/cwd/operationId**；→ `{ok:true,status,checkedSessionId,exists,cleared}`，Host adapter当前只取 `status`。 | `modules/list(checkAvailability:true)` 和首次 prepare admission；不是 slot reservation。connector 核查**已有** binding 的 native metadata；只有确认原 target missing 才可能 retire旧 active binding；历史与未知证据保留。 | **不是纯只读探针**：`cleared` 可表示控制引用被清理。网络/schema失败或绑定变化不能当缺失；没有提供 request幂等 key，不等于可以任意并发重试。Host 不发送未来身份；可选能力只在 WeChat分支调用。C `packages/core/src/modules/manager.ts:98-102,251-259,429-433`；C `packages/core/src/modules/adapters.ts:295-298,332-338`；W `src/module-control.js:150-175`、`src/cockpit.js:105-134`。 |
| **25 `bind` / cwd-bound `unbind`**，Host control adapter → WeChat | `{operation:"bind",operationId,sessionId,cwd}` 或同字段 `operation:"unbind"`；→ `{ok:true,operationId,revision,boundSessionId,replayed}`（unbind 后 ID null）。bind 内部只用 native metadata确认目标，不创建 native session。 | connected初次绑定；cwd-bound unbind 是当前 control/adapter支持的较旧形式（当前公开手动解绑见row26）。WeChat 用 gate+durable operation记录维护 active/history/revision；bind创建模块自己的 binding identity/stateDir；unbind归档其绑定，不删业务历史/原生会话。 | 要 stopped且known、无pending操作/旧业务blocker；request ID固定输入，pending→`OPERATION_OUTCOME_UNKNOWN`，完成返回replayed；换输入`OPERATION_ID_CONFLICT`，结果与当前状态不再一致`OPERATION_STATE_CHANGED`。Host仍硬编码bind/cwd/revision流程。C `packages/core/src/modules/manager.ts:330-353`、`adapters.ts:344-351`；W `src/module-control.js:177-213,227-317`。 |
| **26 native-independent `session-unbind`**，public Host API → WeChat hook | `modules/wechat/unbind{sessionId,operationId,confirm:true}` → `{ok:true}`；hook只收到 `{operation:"session-unbind",sessionId,operationId}` → `{ok:true,operationId,sessionId,unbound:true,replayed}`。读回 `modules/wechat/unbind/get{operationId}` → `{operation:null或{operationId,sessionId,state,error?}}`。 | 显式手动解绑，**不需要 native cwd/会话仍存在**。WeChat只归档指定 active绑定；若指定target不是当前active，记成功“不再绑定该target”，不干预较新runner。Host记录pin/digest/operation，并对已有applied role记录写移除WeChat的pendingSelections。 | 当前active目标必须stopped/业务安全；无关目标不会停止新runner。Host同operation只读原receipt，interrupted→unknown不重放；不自动重新加载会话。专门 API 名、role过滤和 receipt 文件均写死 WeChat。C `packages/protocol/src/index.ts:848-857`、`packages/core/src/modules/manager.ts:511-606`；W `src/module-control.js:232-270,301-317`。 |
| **27 connector → Cockpit discovery/presence/load** | 逐项 GET `/capabilities?name=<encodeURIComponent(intent)>`，intent为 `prompt`、`session/get`、`session/chat`，可选 `session/interrupt`；检查 `{name,inputSchema.properties,resultSchema}` 及 enqueue。POST `/intent/session/get {sessionId}` → `{meta}`；`session/load{sessionId}` → `{ok:true,sessionId}`。 | connector连接能力确认、绑定/admission元数据核对、明确加载已有target；只绑定配置中的native ID/cwd。Host只提供通用native接口；connector拥有binding guard/retire-missing逻辑。 | `meta:null`有效响应才 `TARGET_SESSION_MISSING`且可能清active引用；其它schema/cwd mismatch/HTTP错误不冒充missing。请求适配层默认15s（调用可用config限额）、redirect manual但拒3xx、4MiB响应限额、无自动重试。W `src/cockpit.js:79-141`、`src/http.js:36-51,76-78,89-125`；C `packages/protocol/src/index.ts:979-983,1049-1052`。 |
| **28 connector → native event history** | `POST /intent/session/chat {sessionId,source:"live"/"persisted",direction,cursor?,max,waitMs:0,bootstrap,includeEphemeral:false,…}`；live filter 为 `agentScope:"primary",types:["user.message","assistant.message","session.error"]`。→ `{sessionId,source,direction,events,cursor,cursorStatus,hasMore,liveCursor?,read}`。 | checkpoint/baseline/后续输出读取；native提供不透明cursor/events；connector自己做展示转换及checkpoint，不让Host重建消息缓存。load选择live/persisted不是模块自造history ID。 | cursorStatus必须ok；保留source/direction、max<=256，分页不前进/窗口超限/不匹配明确错误；不能把UUID作游标，不能把过期cursor当续页；无native tool-image lookup。W `src/cockpit.js:142-226`；C `packages/protocol/src/native-chat.ts:25-64`、`index.ts:858-862`。 |
| **29 connector → prompt / optional interrupt** | `POST /intent/prompt {sessionId,text,mode:"enqueue",attachments?或parts?}` → `{ok:true,queued?}`；parts时text为空。`POST /intent/session/interrupt {sessionId}` → `{ok:true,interrupted:boolean}`。 | connector已授权的输入提交/可选nativeInterruptFollowup能力；Cockpit/native拥有queue/turn，connector拥有是否提交/跟进的业务决策。本清单不追踪业务执行。 | prompt接受不表示执行/已读附件；interrupt ack不表示idle，false可能没有main turn，队列不清空、background工作可继续。接口本身没有connector operation key，错误不可视为未提交并自动重发。已枚举client没有把ask/plan/elicitation当自动回答API。W `src/cockpit.js:92-103,240-253`；C `packages/protocol/src/index.ts:913-930`。 |
| **30 connector → managed files** | `POST /upload?name&mime&source=weixin&sessionId&sourceId`，raw octet-stream+Content-Length；→ `UploadedFile{kind,name,url,path,size,mime,sha256?,…}`。`POST /intent/files/get {url:"/uploads/<safe-basename>"}` → 同类权威metadata；再 authenticated `GET /uploads/<name>` 取原始字节。 | connector媒体入口/已发布文件读取的静态接口；Cockpit拥有留存文件与权威metadata/URL，connector拥有其消息关联；upload保留并关联文件，read不send，prompt另一步。 | loopback要求、safe URL/hash/size/schema检查、missing显式失败；Host upload上限25MiB，不许 arbitrary path/URL作为prompt附件。**不能从有sourceId推导 exactly-once upload保证**。Host目前硬编码source enum含`weixin`；文件API本身跨模块通用。本轮只看接口调用，不检查媒体收发业务。W `src/cockpit.js:227-239`、`src/media.js:218-241`；C `packages/protocol/src/index.ts:110-123,903-907`、`apps/server/src/index.ts:475-511`。 |

### 1.5 合成示例：把三类“身份”和两个阶段分开

以下是 schema/function 导出的**示意**，不是执行脚本，也未发送过；路径仅表达返回关系，不应拿来读取。

#### A. Task caller 初始化不是派工

```json
{"requestId":"example-caller-op-001","sessionId":"native-example-session"}
```

`POST /admin/module/caller` 的成功响应形状为：

```text
{ credentialFile: "<Task credentialDirectory>/module-caller-<sha256(requestId)>.json" }
```

没有 token body、taskId、goalVersion，也没有 owner创建/首条消息；身份由 Task 验 native session 后发放（row07）。后续 commander 的 native MCP引用来自 Host 的 session-access 文件，不是把 token append 到模型上下文（row04）。

#### B. Task service 调 Host new，然后单独 prompt

```json
{"cwd":"/example/project","modules":[{"moduleId":"task","roleId":"owner","version":"1.2.7"}]}
```

→ `{"sessionId":"native-example-owner"}`；这个 native ID 才进入 Task owner binding。模型/角色确认之后另发：

```json
{"sessionId":"native-example-owner","text":"Example authorized goal instructions","mode":"enqueue"}
```

→ `{"ok":true,"queued":true}` 只是合法的一种接受响应，不是业务完成。Task `taskId/goalVersion` 是 Task记录及prompt内容，不是 Host `session/new` 参数（rows16–20）。

#### C. WeChat admission 与 bind 的输入不相同

```json
{"operation":"can-bind"}
```

响应形状 `{"ok":true,"status":{…},"checkedSessionId":null,"exists":null,"cleared":false}` 只是无已检查目标时的一种形状；它不是预留许可。真正首次bind才传真实native ID/cwd：

```json
{"operation":"bind","operationId":"example-bind-op-001","sessionId":"native-example-session","cwd":"/example/project"}
```

成功形状可为 `{"ok":true,"operationId":"example-bind-op-001","revision":1,"boundSessionId":"native-example-session","replayed":false}`；**revision=1 是合成初始情况，不能用于断言实际配置状态**。依据 W `src/module-control.js:150-192,261-317`。

#### D. 保留绑定历史的解绑

```json
{"operation":"session-unbind","operationId":"example-unbind-op-001","sessionId":"native-example-session"}
```

→ `{"ok":true,"operationId":"example-unbind-op-001","sessionId":"native-example-session","unbound":true,"replayed":false}`。它不能被解释成“native会话已删”或“所有业务历史已删”，也不授权解绑另一个较新active target（row26）。

### 1.6 已通用的部分，与 Host 仍知道的业务知识

**已经可以跨当前模块复用：**

1. release内相对entry/角色声明、固定版本与digest、append composer、native技能路径和MCP连接确认；Engine的`SessionModuleHost`接口不含Task goal/WeChat消息模型（rows01–02）。
2. runner的owned-child、same-instance version/health、durable job、安全排空与unknown保留机制（rows09–12）。这不表示启动环境driver已通用。
3. `session/get/new/fork/load`、模型/角色配置、prompt、native chat cursor、managed-file接口；Task/WeChat作为客户端消费真实native接口，不另造native session数据库（rows17–20、27–30）。

**Host 仍然明确知道：**

- **三个官方ID、两个服务ID**，不是任意新module ID；manifest hook形状通用不代表任意hook自动可达。协议 enum、catalog、manager `officialIds`、runner ID集合均有限（C `packages/protocol/src/modules.ts:7,44`；`packages/core/src/modules/catalog.ts:10,220-223`；`manager.ts:21,405`；`supervisor.ts:102,122-124`）。
- **Task commander与owner区别**、owner新建选项过滤、caller provisioning时点、manager/viewer/credential-root字段、固定caller路径、业务空页认证、Task env翻译及专用dashboard代理；但没有把 Task任务/授权/依赖/交付状态机放进Host（rows04、06–09、13–21）。
- **WeChat binding-only、can-bind/bind/unbind、native ID+cwd+binding revision、pending/unknown/running及部分业务reason**；manual-unbind API和Host role记录调整也是专用，不是任意模块生命周期统一派发（rows05、22–26）。
- **页面并非仅看manifest就能挂载**：当前`publicPath`可展示，真实代理仍只注册Task allowlist。`modules/config/initialize`也仅允许`moduleId:"task"`；不能因字段存在便声称任意模块已有初始化/网关能力（rows06、21）。

**删除不是隐式解绑广播：**Engine native `deleteSession` 后调用的是Host `removed`清理，manager仅归档Host role record，并未调用WeChat hook、Task业务通知或所有模块广播（C `packages/core/src/engine.ts:1899-1921`、`packages/core/src/modules/manager.ts:386-389`）。native absence由模块在其已声明的后续接口中核对；Task 1.2.7的active-reference不足保持为已有已知问题，不能借此报告假定升级或修复。

**以上为现状接口。**下一节开始是候选通用协议；不要把候选atomic lifecycle、摘要、actor或等待规则反写为上述版本已经实现。

## 2. 候选定义与判断标准

**模块：有稳定身份、独立版本、声明至少一种受支持能力，并明确拥有或明确不拥有
配置、数据和运行资源，可独立安装、停用、升级、卸载的完整能力单元。**

“拥有资源”允许空集；“完整”指一个可独立理解和维护的目标，不是每个按钮一个模块。

| 判断 | 正例 | 反例 / 边界 |
| --- | --- | --- |
| 有独立能力与责任 | Assistant角色包；Task工作管理；语音输入provider | 随手一段未版本化prompt、单个CSS文件、某个保存按钮 |
| 不必有后台进程 | Assistant只提供说明/skill | 不给纯内容包强行启动空daemon或要求health接口 |
| 不必有页面 | 仅MCP工具包、通知输送provider | 为通过安装检查强制创建无用Web页 |
| 不只是prompt | Task有独立数据/身份/服务；Clipbook示例有API/事件/页面 | 把Task工作状态复制进host后只把提示词叫“模块” |
| 可组合但权责独立 | Assistant+Task可显式同选；普通Chat可不选 | Task隐式授予Assistant身份、模块替host创建虚拟session |
| 有退出/升级边界 | 包与data分离、数据兼容声明、必要时drain | 停用要删除native会话；卸载必须清业务库或未知发送记录 |

身份：`moduleId`是稳定的安全ASCII标识，不再是官方enum；displayName仅用于显示。
**有效安装身份不是自报名称**，而是宿主建立的
`(trustAuthority, moduleId) → moduleRef`。`moduleRef`是安装注册记录的稳定句柄，
不是native session ID。不同发布者的同名模块默认是不同身份，不能覆盖原包、
占用原data或冒充原Task。

初次信任把该moduleId、发布者公钥指纹、来源策略和“受信模块可访问全部公开API”的
执行边界绑定起来，不逐项授予API能力。公钥改变
不等于旧身份自动延续；首版要求单独确认/明确身份迁移，保留原安装。后续可加
交叉签名轮换，但不以新增复杂PKI作为第一版前提。

`trustAuthority`是host首次批准时分配并持久化的随机authorityId，含受信key集合、
允许来源、信任状态和单调revision；发布者不能自报这个ID。默认新key得到新authority/
moduleRef，不继承旧data、pin或反回滚状态。若用户明确选择“更换原模块签名key”，
操作必须指定原moduleRef、expected trust revision、旧/新指纹和新描述证据；保留
moduleRef/data与历史验证回执，trust revision递增，原sequence floor不清零。
旧key不再签发新的受理版本；已经验证的旧release默认仍可按pin使用，除非用户明确
另选撤销这些release。key轮换与撤销不能混成一个无提示操作。

标识的首版语法：moduleId为1–120字符的lowercase ASCII段（字母开头，段内字母/
数字，用`.`或`-`分隔）；moduleRef/authorityId为host分配的安全opaque句柄，不接受
路径分隔符；roleId/pageId为1–80字符安全ASCII，在各自module内唯一；action/event/
contract名为1–100字符安全ASCII，可含`.`、`_`、`-`，在其contract内唯一。
拒绝空段、`..`、原型属性保留名和规范化碰撞。首版单session对每个moduleRef只选
一个role，可组合多个module。MCP逻辑name由host加稳定moduleRef哈希前缀，不随软件
版本变化；生成名若不符合所选native限制或冲突则显式拒绝，不默默重命名skill。

## 3. 必选/可选能力及最小依赖

| 项目 | 必选性 | 作用域 / 契约 | 最小实现优先级 |
| --- | --- | --- | --- |
| identity/version/schema | 必选 | moduleId、版本、host协议、静态manifest；未知必需能力拒绝 | 首版基础 |
| 发行元数据/完整性/信任 | URL安装必选 | 外部签名描述、manifest和归档摘要/大小/目标；安装前完成信任 | 首版基础 |
| 资源/兼容声明 | 必选，允许无资源 | data/config/logs为空或明确归模块；运行依赖只在需要时声明 | 首版基础 |
| 至少一种能力 | 必选 | 可为roles、actions、service、page/provider之一；无能力的空包拒绝 | 首版基础 |
| roles说明/skill | 可选，可多角色 | native session；append，不覆盖cwd；role有selectableBy声明 | 首版 |
| 本地MCP | 可选，随role选择 | 已验证包的stdio entry；工具/schema与静态contract一致；不修改全局MCP | 首版 |
| 独立service | 可选 | 首版每安装一个共享实例；identity/health/drain必实现；actual instance独立于installed | 首版 |
| control/hook | 有行为才需要 | 一个有界JSONL控制协议，配置初始化/session接入/解绑等可选方法；无行为则不存在entry | 首版 |
| namespaced actions/events | 可选 | 由模块执行；host验证/路由/转发；模块事件cursor不变成native历史镜像 | 首版 |
| module.home页面 | 可选 | 首版为声明式schema-page；不是任意HTML/React/DOM注入 | 首版完整目标 |
| config schema/secret refs | 有配置才需要 | JSON Schema有限子集；host表单/JSON编辑；秘密只走受保护引用 | 首版 |
| session.admission/attach/unbind | 有业务绑定才需要 | 模块拥有绑定及身份；host记录opaque receipt并核对真实native目标 | 首版，迁Task必要 |
| 普通native工具 | 可选扩展 | host绑定的工具代理→同一个模块action；不得自定义terminal语义/覆盖native核心工具 | 第二阶段可选，首版优先MCP |
| trusted HTML页面/composer输入provider/其他UI slot | 可选扩展 | 只在宿主公布的具体slot和浏览器安全profile；未知必需能力在verify时报不兼容 | 第二阶段可选 |
| 模块→模块依赖 | 首版不自动处理 | 优先只依赖host服务；不得隐式安装依赖树、自动借另一模块身份 | 延后；需要时显式绑定已安装provider，拒绝循环 |

第一版支持的**能力种类**仍有协议定义，这与预编码**模块名单**不同。
新模块使用已有能力种类必须无需改host；新发明一种host从未支持的native/浏览器
原语，必须声明不兼容，不能偷偷执行降级探测。不能把这一正常协议边界藏起来。

JSON Schema建议2020-12的可移植有限子集：object/array/scalar/enum、required、
additionalProperties、常用边界及包内`$defs`。禁止网络`$ref`、动态代码和未实现的
必需vocabulary；`$schema`只是已知dialect标识，不触发远程下载。UI不能渲染的
合法复杂配置可以用同一schema约束的JSON编辑器，不要求模块进入host if分支。

## 4. 一个新模块的完整静态示例

[clipbook.module.json](examples/module-contract-v2/clipbook.module.json)定义 **`org.example.clipbook`**：
配置一个note长度上限，独立data、Node service、`notes.list/add` API、
`notes.changed`事件、可选writer角色/MCP和一个module.home页面。它不需要
Assistant/Task/微信，本例业务不调用native session、不读剪贴板或用户目录；
只处理明确提交的合成文本。
这描述示例使用了什么，不是它的API权限白名单；受信任启用后默认公开API访问规则相同。

它能表达一个未知名称的新能力，而不仅是给现有Task换名字。host只识别
roles/service/actions/events/page这几种通用协议，没有Clipbook分支。

[assistant.module.json](examples/module-contract-v2/assistant.module.json)无control/service/page/config/data，应用角色即为
完整使用，不能因为没有“启动进程”把它标成未完成。

[task-adapted.module.json](examples/module-contract-v2/task-adapted.module.json)是Task向新契约迁移的**字段映射示意**：
commander与owner的入口可见性、attach参数由模块声明/解释；host不再比较字符串
`roleId==='commander'`。其`work.read`是代表性API示例，**不是完整Task接口清单**；
完整work接口应从Task自己的schema打包进同一contract，而不是在host重新编写。
这些新schema/示例版本都不属于当前安装的1.2.7。

## 5. URL到底支持什么

| 链接形态 | 首版建议 | 明确行为 |
| --- | --- | --- |
| HTTPS签名发行描述 | **主要且必须支持** | 按Content-Type/JSON kind+schema识别，不依赖域名、GitHub owner或文件名 |
| manifest JSON | 有明确发行描述locator才可衔接 | 先显示未验证能力；跟随locator获得签名描述并核对manifest原字节摘要。裸manifest不够安装 |
| 裸ZIP/其他模块包直链 | 首版不直接安装 | 返回`MODULE_DESCRIPTOR_REQUIRED`；不能猜包名或从包自带key自动信任。未来可支持明确外部签名sidecar/Link关系 |
| 普通repo或Release HTML页 | 首版不爬页面猜入口 | 返回`UNSUPPORTED_ENTRY_KIND`和标准描述链接要求；不能执行HTML、自动clone/build或猜某个ZIP |
| 官方目录项 | 可选便利来源 | 解析为相同标准URL；不能成为合法moduleId/仓库门槛 |
| 私有URL | 可选sourceProfile，非默认条件 | 匿名401/403/404如实返回；用户显式选择已授权服务端凭据引用；不自动降级或扩权 |
| 内网/localhost/file URL | 默认拒绝 | 不以“任意仓库”之名允许SSRF或本地文件读取；受控内网源另需operator网络profile |

**最薄路径：只把签名发行描述作为安装的权威入口。** 因此新发布者只需要
公开符合格式的文件和包，用户给其描述URL即可；不需要维护者预登记该仓库。
GitHub网页便利解析器可以以后按平台标准实现，不按具体仓库写分支，也不是
URL核心目标的前提。

发行描述与包分离，避免“包内描述包含包自身hash”的自引用循环。
归档可以包含manifest/inventory，但归档自身摘要由**外部**签名描述绑定。

## 6. 发行格式、身份、可信与权限是五件事

候选签名外壳：

```json
{
  "kind": "cockpit.module.release-envelope",
  "schemaVersion": 2,
  "payload": "<base64 of exact UTF-8 release JSON bytes>",
  "signatures": [{
    "algorithm": "Ed25519",
    "keyId": "sha256:<public-key fingerprint>",
    "publicKey": "<candidate public key>",
    "signature": "<base64 signature>"
  }]
}
```

签名覆盖 `UTF8("cockpit.module.release/v2\n") + decode(payload)`（末尾是真实0x0A）；
publicKey采用Ed25519 SPKI DER的base64，指纹为SPKI DER的SHA256。JSON解析拒绝
重复键，核验原字节而非任意重排后的JSON。首版一个已信任key即可；包/描述带来的
publicKey只是候选证据。不是HTTPS证书、displayName或自签名自动变成可信作者。

payload具体示例见 [clipbook.release-payload.json](examples/module-contract-v2/clipbook.release-payload.json)，含：
`moduleId/version/sequence/issuedAt/expiresAt`、manifest URL/bytes/hash、
每个平台的archive URL/format/bytes/hash、downloadOrigins、updateUrl。
字段中的URL首版用绝对HTTPS，避免相对路径随恶意重定向改变解析基准。
manifest/package内文件路径仍是受限相对路径。

| 校验层 | 能证明什么 | 不能替代什么 |
| --- | --- | --- |
| 识别 | 这是支持的descriptor/manifest schema和能力语言 | 名字真实、作者可信、代码无害 |
| 兼容 | host协议/必需cap/runtime/native平台要求有交集 | service已经运行；未来任意版本都兼容 |
| 完整性 | 下载字节与签名描述、manifest、archive/inventory一致 | 发布者无恶意、业务数据兼容 |
| 发布者信任 | 用户/策略已将这个module身份绑定到该key和来源范围 | OS沙箱或真实Task caller/owner授权 |
| 使用者权限 | 当前host用户确认信任并启用模块后，模块默认使用全部公开API | 尚未信任的签名包可自行执行、访问API不必认证/遵守确认和busy、模块名等于业务授权 |

同 `(trustAuthority,moduleId,version)` 的manifest不可改写；
同一manifest可列多个平台产物，但同 `(moduleRef,version,target)` 不得换不同字节。
纯内容包可声明 `os/arch:any,runtime:none`，有执行entry的包不能借此跳过运行依赖检查；
内容可移植也不代表Cockpit宿主已经支持任意OS。同名不同publisher不能覆盖。
`moduleRef`为host注册身份，不在manifest中由发布者自定。升级继续使用同moduleRef；
新key/身份迁移需明确处理，不自动接管原data。

摘要的候选定义必须区分：

| 字段 | 覆盖对象 |
| --- | --- |
| descriptorDigest | inspect实际保留的完整签名外壳原字节，锁定此次候选，不跟随latest变动 |
| manifestDigest / archiveDigest | 各自文件的原字节SHA256 |
| releaseDigest | 提取后受限inventory的SHA256：按规范化相对路径排序，目录记录path/kind，文件记录path/kind/bytes/sha256；用RFC8785 JCS编码，不包含host生成的回执自身 |
| contractDigest | `JCS({contract:contractName,definition:manifest.api[contractName]})`的SHA256；不同业务schema不能只因名字相同就互换 |
| capabilityDigest | 声明的JCS SHA256：能力种类、可见角色/接入方法、配置/资源类别、actions及其effect/schema、page slots/调用关系；不包含displayName、软件版本号或普通说明正文；不是API权限集合 |

capabilityDigest只绑定本次使用的声明，便于显示变化和发现不兼容，不承载逐API权限。
同一受信publisher的显式更新不因增加一项公开API调用再次索要scope授权；不能用
“版本号变了”要求逐步骤审批，也不能用“hash没变”证明代码无害。
实施规格应把该投影固定成共享schema/函数，不能Web/MCP各算一遍不同含义。

反回滚记录按 `(authorityId,moduleId,channel)` 持久化 `{sequence,payloadDigest}`。
更小sequence拒绝；相同sequence不同**payload**拒绝，相同payload允许重新读取，
仍检查key与expiry。卸载/更换来源或key不重置旧floor；显式回退只能选已验证本地
release并检查当前data兼容，不用过期/较低sequence的远端描述绕过。
descriptor与manifest的moduleId/version必须一致；所选artifact target必须满足
manifest runtime/native要求及真实host能力，不能分别验证两个不相干的对象。

### 最少信任确认

新发布者/新来源范围/新key，合并成一张“信任并使用”摘要：
key指纹、原始与最终来源、module身份/版本、执行代码类型、默认全部公开API访问边界、
目标session与将执行的步骤。确认绑定 `planDigest + descriptorDigest + key +
capabilityDigest + target/config revisions`，不能拿旧确认套新包。

推荐信任粒度为**这个模块的这个发布者**，不是一键信任所有该作者未来模块。
已信任同key、同来源政策的显式更新显示声明变化，不重复逐步骤询问；显式更新/
使用动作仍存在。不默认自动检查、下载或安装。

Web显示确认卡；MCP经用户明确授权提交相同approval。`confirm:true`不是对恶意
同UID自动化的安全证明，安装授权与原生allow-all工具策略分开，不改native permissionPolicy。
不运行包代码来决定它是否值得信任。

**执行边界必须直说：**第一版仍是同用户本机信任模型。签名和能力清单不提供
恶意同UID代码隔离；受信Node服务/MCP可能具备该用户的文件/网络权限。角色文字也
可能影响拥有工具的模型。模块默认全API访问是一项有意的信任取舍，不是沙箱；
需要强隔离时再另行设计独立UID/OS sandbox，不把身份记录或iframe误称为后端隔离。

## 7. URL与解包的通用安全边界

这些约束是scheme/address/资源规则，不是官方域名allowlist：

- 初始URL及每次重定向都解析/规范化；只HTTPS，禁userinfo、降级、非支持scheme；
  IPv4/IPv6、映射地址、DNS结果、实际连接目标均须是允许的公开地址，阻断loopback、
  RFC私网、link-local、metadata endpoints等。DNS检查与实际连接绑定，保留正确SNI/
  TLS证书校验；不能“查一次DNS后让HTTP客户端另解析”。HTTP proxy也必须满足此保证，
  无法保证则明确不支持该路径，不能悄悄绕过。
- 元数据首次可以从用户指定任意公共HTTPS来源取得。用户的inspect/verify请求只授权
  **匿名、限额、无执行的候选证据获取**：描述、manifest与本机一个匹配artifact。
  在通用公共地址规则内可跟随候选描述的精确资源URL，不因此持久信任来源或给它凭据。
  这与install时批准持续来源/执行权限分开，避免“先要信任才可取得验签证据”的循环。
  私有凭据使用和非公开网络访问不包含在该临时取证授权中。
  签名描述列出的asset origins是候选范围，经安装确认才成为该module持久来源政策，
  不是包单方面授予权限。
  每跳仍做公共地址和HTTPS检查，建议最多5次。跨origin不转发Authorization/Cookie；
  私有源凭据只给已配置origin，不将临时签名URL或token放进Web/MCP回执、日志。
- 私有源401/403/404分别保留；404可能是权限隐藏，不能宣称一定不存在。
  query可能含秘密，仅受保护保留/脱敏显示；推荐credentialRef而非URL内凭据。
- 候选默认限额：描述1MiB、manifest256KiB、JSON深度32、归档400MiB、
  展开1GiB/10,000条目；连接10秒、无进展30秒、下载总时限10分钟。实际实施要在
  统一host policy固化并有边界用例；模块不能自行提高。超限明确失败，不自动放宽。
- 下载先到私有隔离staging；校验归档hash再安全提取；仍限制解压实际字节/CPU/
  文件数，拒绝绝对路径、`..`、规范化/大小写碰撞、符号/硬链接、设备/FIFO、
  特权权限和覆盖既有目录。所有entry/reference须在该固定release内。
- 静态manifest显示为不执行的文本；不执行HTML预览、外部schema引用、脚本图标、
  npm/pip/install脚本、build、hook或MCP `tools/list`“探测”。模块依赖由发布者打包；
  默认消费不clone、不在宿主编译。验证不是执行不可信代码。
- 发布前再次检查本次trust/config版本、权限、sequence floor和expiry；不能在长下载
  后用已过期/撤销的许可发布，也不把新fetch的“latest”混入旧操作。失败保留原ID，
  不在背景自动重试。明确已装的可信旧版本回退是另一种显式本地操作，不等于接受
  过期远端metadata。

上述限额/私网profile为候选策略，不是宣称当前实现已具有这些全部防护。

## 8. 通用宿主↔模块控制契约

### 单一最小传输

首版Node模块可声明一个 `control.entry`；host在已信任/安装且用户授权的动作中
启动短命控制worker，用JSONL stdin/stdout交互，日志走stderr。没有hook的内容包
不启动worker。长期service同样用 `stdio-jsonl-v1`，只是进程寿命不同；host注入标准的
`COCKPIT_MODULE_CONTEXT_FILE`，模块自己的entry把它翻译成WORK_*、--config等，
不再让supervisor按moduleId翻译。

控制context是host生成的私有文件引用：moduleRef、固定release/hash、operation、
运行generation、必要native目标/role、资源引用以及通用API地址/认证方式。模块不能靠body自报
moduleRef/sessionId取得身份；绑定的私有channel才是调用身份。
其中actor由host认证层填写。外部MCP请求或Web自行传来的sessionId只是一项目标，
不是native-session身份凭证；Task仍须验证自己的caller/owner业务凭据。
受信任且启用的模块按当前用户的完整公开API能力调用，不再引入独立hostAccess授权层。
Task等服务自己的业务凭据与该通用API访问资格仍不是同一件事。

#### 最小wire/context表

| 对象 | 必需字段及语义 |
| --- | --- |
| context私有文件 | schemaVersion、moduleRef/moduleId/version/target、manifestDigest/releaseDigest、instanceId、leaseGeneration、configRevision、资源根引用、host认证actor、hostApi地址/认证方式、bootNonce；session应用上下文另含真实sessionId/cwd/roleId及已知applied revision。文件不进入Web/MCP回执 |
| 建连 | host以已验证相对entry用Node spawn，持有stdin/stdout和实际child；发送hello带bootNonce。模块返回同nonce及固定身份。随后health确认ready才是可用；握手不是安装前探测 |
| request frame | `{protocol:"cockpit.module-control/1",type:"request",requestId,method,input,operationId?,context?}`；requestId在此channel内唯一，变更必须operationId；双方都要在等待response时继续处理peer请求，不能同步回调死锁 |
| response frame | 同protocol、type=response、requestId及适用operationId，加统一phase/step/effect/completedSteps/result或error；一条请求可先accepted并以操作查询继续，不能多次伪造终态 |
| progress frame | type=event、event=`operation.progress`、operationId和有限进度字段；不改变native状态或重新触发业务。业务事件首版走下述显式有界读取 |
| frame限制 | 一行一个完整UTF-8 JSON，最大1MiB/深度32，默认最多16个在途请求；stdio stdout不混日志。未知必需字段/方法/协议拒绝；失去channel不能重发原变更 |
| 可选host.invoke结果 | 仅作为小型JSON intent的便捷适配，result是同一公开API真实返回，错误保留code/真实资源ID/effect。模块可直接HTTP调用，不强制经过该channel；prompt成功只代表接受消息 |
| host API访问 | 受信任且启用的模块默认访问全部公开API，不限制module专属intent/目标集合。复用安装已有认证方式，必要认证材料只通过私有引用提供；接口确认/busy/校验不绕过，不声称约束同UID代码的文件/网络能力 |

context中的leaseGeneration只标识进程代际及晚结果归属，不是权限lease或API scope。
hostApi复用当前安装实际使用的认证方式；示例credentialFile只示意已有token认证时的
私有引用，不要求无token的受信loopback安装额外创建一套模块凭据系统。

任何包含变更action或hook的provider还必须提供`operation.read`，按原operationId
返回自身保留回执或明确unknown；不能以“进程重启”把原副作用重新执行。未运行service
不得为了读取而自动启动业务，可由已声明的短命control只读其日志；没有该能力就明确
暂不可核实。示例context/wire见 [context-and-wire.json](examples/module-contract-v2/context-and-wire.json)。

| 方法 | 何时调用 | 输入/输出关键项 | 状态归属 |
| --- | --- | --- | --- |
| `config.initialize`（可选） | 已安装/信任，显式配置初始化 | operationId、config/data ref；返回已创建的module资源ref/config结果 | 数据/业务secret归模块；host只验证引用与CAS发布配置 |
| `session.admission`（可选） | 配置已就绪，用户准备接入时 | role、当前配置；不提供未来native ID；返回available/reason | 业务条件归模块，不预留/创建native身份 |
| `session.attach`（可选） | **真实native ID已确认**后、第一条业务prompt前 | operationId、实际sessionId/cwd、role及模块自定义input；返回bindingRef、configurationReferences | 模块签发业务身份/绑定；host保存最小应用回执 |
| `session.validate`（可选） | cold/apply前后按需 | 原bindingRef/实际目标/固定版本；返回ready/unavailable/unknown | 不再issue/bind，不重放业务 |
| `session.unbind`（可选） | 用户明确解除模块关联 | 原operationId/绑定；返回确认解绑或blocked/unknown | 模块负责唯一绑定/活动引用；不删除native session |
| `identity/health/drain`（有service则必需） | 启动就绪、操作边界、受控退出 | moduleRef/version/digest/instance与drain operation；只有真实退出后host报stopped | 模块排空内部工作；host拥有child/IPC/实际退出证据 |
| `api.invoke` / `api.events`（可选） | 有授权的命名空间调用/订阅 | contractDigest、action/schema、输入/操作ID；结果或模块cursor事件 | 业务结果/事件日志归模块，不镜像native状态 |
| 直接HTTP或可选`host.invoke`（模块→宿主） | 受信任启用模块需要调用公开API | HTTP按现有接口认证/输入；便捷JSON调用可用既有intent和input，不加API白名单 | 同一公开API及原生权威，非第二套MCP业务后端 |

通用请求/回执示例见 [requests-and-receipts.json](examples/module-contract-v2/requests-and-receipts.json)。
单步安装、配置、启动、应用、排空和卸载另见 [atomic-lifecycle.json](examples/module-contract-v2/atomic-lifecycle.json)。
回执匹配 requestId/operationId/instance/实际目标，未知不伪造done。
`configurationReferences`只能是受限引用：例如
`{kind:"module-file",root:"data",path:"session-access/…json"}`，
host规范化到该模块声明的资源root；绝不把任意字符串当绝对文件路径。旧外部data/
credential-root的自动接管和兼容不在新协议内；不新增storageGrant授权体系。
这些引用校验保护host代读/注入的资源，不是受信模块进程的文件系统沙箱。
只有host自己写的私有context可含 `host-resolved-file/directory` 的绝对本机路径；
模块回执中的相对ResourceRef与这种已解析资源不是同一输入类型，不能混用绕过root校验。

`session.admission`默认是纯读。若模块必须按需清除已确认不存在的旧活动引用，
另声明 `admissionReconcile`这一有限维护动作并使用操作ID；只在用户显式接入/
核对的上下文执行，不在URL inspect或普通列表渲染中悄悄维护。它只能CAS释放捕获
的失效活动引用，保留历史和unknown；原生超时/403/unloaded不是不存在。

每次selection可有`attachInput`，严格按该role的attachInputSchema验证；模块声明的
静态`input`与本次动态输入分开传递，不准客户端覆盖静态mode。可另传受限attachRefs，
由模块自己的业务记录解释。`selectableBy`只描述普通UI的角色展示/建议入口，
不是host API授权。`["module"]`的角色不在普通新建选择器里展示，但API不再按调用模块
身份额外拒绝；是否能建立对应业务身份由目标模块的attach及业务凭据检查决定。

### 首消息前初始化：避免新的循环或虚拟session

静态角色/MCP配置先准备；host预留的是**私有应用context文件**，不是可聊天的虚拟
session。MCP entry须能在业务attach尚未完成时完成协议连接，但业务调用明确返回
`MODULE_NOT_APPLIED`，不能自行发caller或偷偷初始化。

host调用现有native创建接口并确认真实ID，再将该ID交给可选attach；Task自己的
driver发caller并返回受保护引用。context文件更新后，已连接MCP按需读取引用。
全部应用确认前host不接受该session的prompt。**无需为了补身份关闭一个空native
session，也不发初始化假消息。**

Task owner的动态关联：Task先在自己的已授权dispatch操作中保留dispatchRef，再经
通用API请求owner role并带attachInput.dispatchRef。真实native创建确认后，Task可直接
通过普通session/get核对该ID，不需要临时metadata-read grant或“先bound才可读”的门槛。
Task attach把同一reserved dispatch绑定到实际
ID并签发owner凭据；必须允许这一步作为原操作的关联续步回调，不能等待原new调用返回
才发凭据又让attach等待该凭据。new返回后Task验证已完成绑定再发目标prompt，不再签发一次。

已创建但attach失败：保留真实ID和操作身份，显示部分失败；无确认的create仍
标unconfirmed，不把预分配ID/文件当native存在。未知create/prompt不自动重发。
普通 `session/new → 真ID → prompt` 不改为首消息协调器；通用use流程只能记录这个
已有原生操作的结果，不能另造session数据库或自动替代会话。
v2含模块的`session/new`带operationId，记录的是一次创建/接入尝试而非虚拟session；
不提供旧模块创建入口的兼容层。普通新session仍由native当场创建，绝不延迟到首条消息。
attach失败仍按原操作核实，不再有临时target grant升级/撤销流程；模块应用未完成时，
所有调用者都必须遵守相同prompt前置保护。
成功创建保留原API的顶层`sessionId`，另附`operation`回执；只有真实ID已确认且角色
配置/必要attach完成才成功。创建前没有回执中的sessionId就不向session列表添加对象。

## 9. namespaced API、事件和页面

宿主注册一次通用路由/dispatcher，不为Clipbook/Task等逐个增删route：

```text
POST /intent/modules/capabilities/get
POST /intent/modules/invoke
POST /intent/modules/events/read
POST /intent/modules/pages/open
GET  /modules/<moduleRef>/pages/<pageId>/...
```

action/page/event必须存在于**正在提供能力的固定版本**manifest/contract中。
service API取actual running release，不取新installed/default；session入口先解析其
applied pin再检查相应provider。manifest的`api`是以contractName为key的映射，版本
可以显式保留多个旧/新contract，不能从“名字都API1”推断兼容。

`capabilities/get {moduleRef,target,contract?}`的target为service、
`{kind:"session",sessionId}`或`{kind:"installed-version",version,releaseDigest}`。
返回各contract完整schema及server-issued `providerRef`：绑定provider种类、固定release/
target、actual instance或control generation、config revision、contractDigest，
必要时还绑定session applied revision。它不是权限token，仍须通常认证/模块业务授权。
invoke/events/page必须使用这个ref；相同schema但实例或release变了也返回
`PROVIDER_CHANGED`，不能静默转给新的服务。control provider没有常驻实例时，以固定
release/config/applied generation绑定，执行时才启动被批准worker。

MCP generic和Web发同一 `modules/invoke` body（包含providerRef）；模块的本地MCP代理同一action
实现而不是复制业务算法。新增module注册其schema后即可使用，无须发布新的基础
MCP工具代码。工具名称按moduleRef命名空间避免同名碰撞；native skill同名仍按
真实冲突规则拒绝，不默默选其中一个。
MCP facade的变更参数必须显式携带operationId，不能把会重置的JSON-RPC id或每次新
随机数当业务幂等身份。模块暴露的工具名/schema须对应其contract，以免拿错版本调用；
这约束的是模块的能力声明，不是该模块访问host公开API的权限。是否能连接并正确使用
所选MCP仍按真实SDK能力确认，不新增一套宿主API授权白名单。

首版module.home推荐**schema-page**，不执行模块HTML/JS：验证包内页面JSON，只允许
list/form/json/text等有限block，data binding是JSON Pointer而非表达式，输入/结果仍经
对应action schema。没有任意URL fetch、脚本、事件处理代码或HTML渲染；字符串按文本
显示。这样一个新模块仍可提供完整页面，而不把任意浏览器代码隔离作为首版暗含前提。
[clipbook.home.page.json](examples/module-contract-v2/clipbook.home.page.json)给出list+form；Task例仅示意一张只读action表单。

`pages/open {moduleRef,pageId,target}`确认所需provider并返回固定release的page URL与
pageLeaseRef；页面内调用使用该lease关联的providerRef，不能把旧页面JS/schema搭配
新默认版本。pageLease绑定用户/目标/角色、page声明和generation，关闭/撤销/
provider变化后失效；它不授予任意native接口，也不返回secret。
其中page列出的actions/events是renderer要使用的声明，不是模块API访问的权限清单；
版本/页面实例隔离与“受信模块默认全部公开API”是两种不同约束。

自定义HTML页面可以作为后续单独能力 `modulePageHtml:1`，不能用schema-page降级
运行。若实施，必须选定并验证浏览器安全profile：sandbox只允许必要scripts，不给
same-origin/forms/popups/downloads/top-navigation；parent frame策略、CSP默认拒绝、
connect/form/worker/frame/导航及外部资源策略，固定资产、校验MessagePort schema、
nonce/frame/generation失效都必须定义。对无法可靠限制的浏览器不得宣称支持该profile；
也不能把页面规则当作Node同UID程序隔离。

Task应由自己的新包发布schema-page或另经批准的HTML能力，而不是要求host新增Task组件。
新协议不保留旧dashboard代理、`/modules/task`别名或原域名兼容映射；也不因此声称
简化schema-page已经等价覆盖旧工作台全部交互。新模块需要的额外页面能力须单独定义。

事件首版确定为有界读取：
`modules/events/read {moduleRef,providerRef,contract,event,cursor?,limit:1..100,waitMs:0..1000}`，
返回`{streamId,cursorStatus,items,nextCursor,hasMore}`；事件schema由固定contract声明。
cursor绑定moduleRef/contract/event/模块数据streamId，不绑定或复制native聊天。
provider切换先明确重新取得providerRef；仅streamId及schema仍匹配时可继续旧cursor，
否则expired，显式重同步该模块。首版events要求service provider；不为内容包制造
事件daemon。host不累积另一个业务事件库，也不自动扫描全历史。
省略cursor表示取得当前tail（空items和nextCursor），之后只前向读；页面可先取得tail，
再调用snapshot action，最后沿cursor继续，以revision去重而不漏掉建立读取时的变化。
需要历史回溯须另用模块显式action，不能省略cursor就隐式重读全历史。
installed-version目标可静态预览schema；若contract要求尚未运行的service，就返回
不可调用的预览而非可执行providerRef。不能把“已安装能力声明”变成“实际provider已就绪”。

### 文件直接走通用上传/附件API

文件获取、存储、格式处理和上传由模块自己的服务完成；交给Copilot时调用现有
上传接口得到附件引用，再单独调用prompt。原字节下载也直接使用受保护的文件HTTP入口。

```text
模块取得本地文件 → 通用HTTP上传 → 附件引用 → prompt(attachments)
```

文件字节不进入1MiB JSONL控制frame，JSON控制消息只携带必要引用。当前上传接口的
体积/流式/超时限制由上传API负责，不是模块协议的大文件门槛；超过限制按该API明确
失败，不以分片或自动重试绕过。模块内部使用的文件不必上传给host。普通JSON API和
大native事件也可走已有HTTP读取路径，不强制压进控制frame。
见 [files-via-http.json](examples/module-contract-v2/files-via-http.json) 的合成接口顺序。

## 10. 安装与使用：固定线性流程，不做工作调度平台

```text
URL
 └─ inspect（仅静态识别）
     ├─ unsupported / incompatible / source-auth-required
     └─ recognized
         └─ verify（受限下载到隔离staging，验签/包/manifest，不执行）
             ├─ rejected / publisher-untrusted
             └─ verified bytes + compatibility + trust decision
                 └─ install（原子发布immutable，登记，不启动）
                     └─ configure（有配置才需要）
                         └─ initialize（声明且明确授权才需要）
                             └─ start（有service且选择使用才需要）
                                 └─ apply（选中role/session才需要）
                                     └─ ready-for-that-capability
```

这是依赖偏序的推荐UI次序，不强迫所有模块经过全部步骤。例如Assistant
install→apply已完整；API-only模块install→configure/start→invoke，无需session；
可离线完成的binding控制hook不应被强制要求先启动业务service。

### 通用API草案

| API | 语义 |
| --- | --- |
| `modules/inspect {url,sourceProfileRef?}` | 静态识别；返回inspectionId、描述digest、兼容/信任状态，不安装 |
| `modules/verify {inspectionId,descriptorDigest}` | 锁定输入、下载/验证，不执行；返回verificationId；自签一致不等于trusted |
| `modules/install {verificationId,planId,planDigest,operationId,approval?}` | install-only也先形成最小计划；原子安装，不自动start/apply |
| `modules/config/get/set {moduleRef,revision,…}` | set带operationId；同schema表单/JSON与CAS、私有ref/备份，不混业务迁移 |
| `modules/config/initialize {moduleRef,version,configRevision,operationId,confirm:true}` | 仅已声明initialize的方法；用户可单独调用或在use计划中明确批准，不固定为Task、不默认接管非空data |
| `modules/service {moduleRef,action,version,digest,operationId}` | 显式start/stop/apply；owned actor、job与readback语义不变 |
| `session/modules/apply {sessionId,selections:[{moduleRef,roleId,version,attachInput?,attachRefs?}],operationId}` | 完整角色选择，包括增删/旧版本；安全idle/empty/schedule保护，不自动改native全局设置 |
| `modules/use/plan` / `modules/use/execute` | 仅上述有限线性步骤的planDigest与一次明确使用授权；不是任意DAG/脚本/workflow语言 |
| `modules/operations/get {operationId}` | 保留原始输入/phase/effect/已完成步骤/资源身份，只读；无“查不到就重发” |
| `modules/capabilities/get` / `modules/invoke` / `modules/events/read` / `modules/pages/open` | providerRef绑定的通用能力发现/使用，不预置module ID |
| `modules/disable` / `modules/uninstall` | 在引用/排空保护下停止接入；卸载默认保留data/config/secrets/历史，native删除独立 |

未来Web和MCP必须共同使用这套API和schema，不在Web藏一个与MCP不同的安装流程。
Web可以把inspect/verify/plan合为一个界面动作；需要确认新publisher/key/来源时只弹
一次摘要确认，然后执行已经批准且无需补配置的后续步骤。缺配置、未授权执行、
service不可用、目标busy时停在明确waiting项，不逐步骤审批，也不偷偷跳过。
use计划的`desired.initialize`缺省为false；需要初始化才能使用时返回明确要求，
用户可在同一确认摘要中选择它。不是仅因为包声明了initialize就自动执行。

`verificationId`是服务器冻结的候选证据记录，不是“此URL总可安装”的票据：绑定
descriptor/payload/manifest/archive digests、目标平台、候选key、证据来源和检查时间。
`planDigest`为JCS SHA256，覆盖plan schema版本、verification记录内容摘要、现有
moduleRef或候选identity、expected trust revision、确切步骤/版本、目标session/cwd/
完整selections、配置值/secret refs、外部config/applied前置revision和声明摘要。
operator来自认证上下文，模块默认全部公开API访问；plan中的目标用于绑定本次动作，
不是授予API访问scope。install-only也用同样
规则生成只含install的最小plan；它不需要第二次步骤确认。

同一operation自己成功写出的config/trust/applied新revision记为已确认postcondition，
后续步骤用这个结果核对，不能拿最初revision误判自己冲突；外部并发改动则要求
重新计划。plan过期只限制首次受理；已受理操作可以继续原授权等待。远端候选在最终
安装发布前仍核对metadata expiry/floor和当前信任。**本地已验证旧pin的启动、cold
恢复/回退不要求重新取得未过期远端metadata**；它们核对保留验证回执、当前撤销政策、
字节完整性、data/config兼容和使用权限。安全撤销不能因旧操作已受理而绕过。

execute前重校验plan所绑定的versions/config revisions/trust/targets；不把plan当
运行状态快照。等待后被绑定的版本、配置、权限或目标引用变化须显式显示失效/新plan，不能自动改
输入完成另一件事。单纯busy→idle属于原授权等待条件；新鲜安全门槛满足且绑定项未变，
同一已受理操作可以继续，不需再次确认，也不是重发已完成的步骤。host应先返回
accepted/waiting，由会话外执行器继续，不让当前owner同步等待自己idle。
禁止把“安装成功”显示为已运行/已注入；等待apply时已经启动的service必须如实显示。

新session使用：plan先明确cwd和roles，execute走 `session/new` 的真实初始化
链路，不先创建普通空session再关闭重apply。已有session则走显式apply。选择现有
会话不会读取其全历史；只用必要native身份/安全门槛。

## 11. 操作、失败和生命周期

变更/工作流的通用回执至少有：
`operationId, phase, step, effect, completedSteps, result?, reason?, warnings?`。
纯读取/hello可只使用requestId及其read result，不能凭空生成一个业务操作。
原生API的正常返回结构不强行改成模块结果；v2创建可附operation回执，host.invoke
仍包装该原API返回，不造另一种native session实体。
错误envelope的phase同样只能为终态/运行态枚举；`attach/install`等动作用step表示，
不混在phase字段里。变更在受理前被拒也应保留已提供的operationId与effect:none。

```text
phase: accepted → running ↔ waiting → succeeded | failed | unknown
effect: none | applied | partial | unknown
```

HTTP状态表示请求/访问/受理，phase/effect表示效果。成功查询一个failed回执仍是
成功的读取，不是业务成功；MCP必须保留结构化code/ID/effect，而非只留截断文本。
错误中的真实nativeSessionId独立于诊断长度；没有确认就不造一个。

| 场景 | 强制规则 |
| --- | --- |
| 相同operationId/输入再次到达 | 返回原回执，不再执行；不同输入为冲突 |
| 没有收到ACK/进程崩溃 | 原操作unknown；不换ID、替换owner、重新初始化或发送 |
| 已知失败且effect:none | 先保留原终态；经明确新操作/原失败依据才可再试，不是同ID自动重试 |
| 部分成功 | 精确列已完成步骤与资源；不能回滚已签发身份或native创建来装作没发生 |
| 安装已成功，scratch清理失败 | succeeded + warning/保留staging引用，不反转安装结果（对应失败场景） |
| 下次启动发现旧unknown | 保留原operation/generation/error；新观察引用旧记录，不覆盖（对应失败场景） |
| restore中接到stop/parent loss | 独立锁存停止意图，停止新增start；已有动作落定后一次安全drain，不丢事件（对应失败场景） |
| Task或绑定目标明确不存在 | 模块CAS清捕获的失效active reference，保留历史/unknown，并防老recovery抢回新操作（对应失败场景） |
| Web重定向/网络错误 | 意图POST禁止自动redirect/replay；单次受理不等于完成，原ID读回（对应失败场景） |
| 时间/容量限额 | 下载/handshake可超时并报告；已受理副作用/安全drain不因此强杀、重试或伪造stop |

host生命周期维持：围住新module操作→等已受理工作→捕获**实际owned运行**
`moduleRef/version/digest/configRef`→模块service/control workers安全退出→runner退出
→native安全关闭。新main只恢复该捕获列表；installed/default/activation许可不构成
启动意图。手动停用不被更新唤起。restore不重做session.attach或业务初始化。
模块排空期间所需的host API仍可服务已受理工作，不能先全站503导致自等死锁。

模块异常崩溃与正常排空分开。孤儿/未知进程不adopt，不强行认领；同用户外部客户端
和非host-owned服务不在这个控制保证内。由当前session承载的host重启仍要外部
launcher在自然idle后完成，不能同步等自己退出。

停用不等于删除session：先禁止新接入/调用，已有工作自然完成并移除所选runtime
资源，不能强停busy模型。仍被applied/pending引用或有unknown时，注销/卸载明确
受阻；由用户选定解除范围。它**不能阻挡用户的native永久删除**。
native删除仍无模块解绑前置、审批或自动广播；host仅归档自己的引用，模块在
实际使用目标时自行核对。模块事件接口不是恢复全量删除广播的理由。

模块停用/卸载按正常生命周期停止host拥有的模块资源，不再发起新的host-managed工作；
不增加per-module API token/授权lease体系，也不承诺能阻止脱离宿主管理的同UID代码。
业务凭据/data默认保留，不自动重新签发或清除。程序垃圾回收与业务数据销毁是不同动作。

## 12. 新协议内的更新、配置和业务数据安全

本节约束新协议下各版本的正常升级/回退，不表示兼容当前v1模块、旧配置或专用入口。
不兼容旧协议也不等于允许覆盖数据、自动清除unknown或破坏原生session。

显示四个独立版本：installed列表、default供新使用、shared actual service、
每个session applied。cold/reset恢复原pin，不复制native数据库、全局开关或
已运行MCP状态；显式升级才换连接/内容，旧上下文不伪称已抹掉。

配置用schemaVersion+revision，host保留变更前私有备份。模块声明可读data schemas、
本次写schema；无兼容声明不得假定回退可读。业务迁移由模块自己的显式方法、
固定operation、停写/一致性备份方案执行；安装本身不运行迁移。

代码回退只在旧代码能读当前data/config、无未知新写入且旧pin真实可用时进行；
否则修复前进或请求决策。不能把旧DB快照覆盖切换后的新数据。主程序跨host协议/
SDK代际更新也应静态检查已应用/已运行pins，不能为了启动而静默升级模块。

首版没有自动跨模块依赖安装、自动Key轮换或复杂数据迁移引擎。这些限制不妨碍
符合已声明协议的新名称模块从URL安装并使用。

### 自有能力如何归组：设计案例，不是迁移决定

| 能力 | 合理的模块边界 | 必须保留的宿主基础 / 首版限制 |
| --- | --- | --- |
| 置顶与个人偏好 | 可归为个人化偏好单元，而不是每个按钮一个模块；拥有自己的偏好规则/配置和查询能力 | native session身份及原生设置仍归SDK。侧栏排序/装饰需要明确UI消费接口；当前只定义module.home，不能声称可不改UI就迁走现有置顶 |
| 命名 | 自动命名策略、触发/推理可与个人化能力归组 | native name get/set、手动命名权威和新建session基础不能依赖可选命名模块 |
| 通知 | 可把Web Push等送达provider、订阅/secret和送达结果作为一个完整单元；不要按渠道按钮机械拆分 | 真实ask/plan安全、必要inbox/seen身份及普通回复可见性留host。provider默认可调用公开API，但事件订阅仍须定义需要的内容/游标和消费时机，不后台全扫或自动广播删除 |
| 文件 | 文件库页面、分类/导出或可选存储provider可以模块化；共享同一个文件引用契约 | 认证、稳定附件URL/解析、安装器隔离staging不能依赖一个尚未装好的文件模块。业务文件不能因该模块卸载消失，存储切换另需迁移/恢复契约 |
| 语音 | 识别provider、令牌/配置与浏览器输入适配应作为完整语音单元 | 普通text/attachment prompt和设备授权边界留host。麦克风/composer需要明确输入provider能力，属后续slot，不把任意脚本塞进schema-page |

这些案例说明模块按责任、资源和生命周期划分，而非“非SDK代码一律移走”。
安装/信任校验、最小操作恢复、native适配与基础附件解析必须可独立启动；否则会出现
“先安装模块才能安装模块”或“先启动可选provider才能读取自身配置”的自举循环。
当前能力迁移与新的UI slot均需后续明确批准，本草案没有实施或预先宣告已支持。

## 13. 专用分支如何退出通用host

| 当前点 | 候选替代 | 责任留在哪里 |
| --- | --- | --- |
| ModuleId与仓库映射作为合法性门槛 | 动态注册的moduleRef + signed identity；官方目录只是URL/预置信任 | identity与trust在host；作者无需改官方repo列表 |
| `provisionTaskCaller`、固定凭据文件名 | 通用session.attach；Task driver签发并返回受限resourceRef | 签发/幂等/Task授权仍在Task |
| host识别commander/owner字符串 | role.selectableBy + 模块解释attach input | 可见入口由声明驱动；绑定Task目标/owner凭据由Task |
| `wechatControl`及pending/unknown原因表 | 模块自己的control.entry与admission/attach/validate/unbind | 业务判断/唯一绑定/CAS在连接器；host保护操作身份、不重放 |
| `taskGateway`硬路由 | 通用module page/action/event命名空间 + 声明的页面bridge | Task页面与viewer业务授权在Task；host保留认证/隔离/路由安全 |
| supervisor的WORK_* / --config分支 | 标准private context file + 模块entry翻译 | 进程/固定pin/drain归host，具体程序参数归模块 |
| Web Task初始化/微信解绑 if | capability驱动的通用控件和schema/操作回执 | 模块发布能力声明；不往host加业务按钮逻辑 |

新协议**不保留旧v1 driver、API别名、旧域名/basePath映射、旧配置/凭据根和旧pin格式的
兼容层**。模块按新契约发布，宿主只实现通用契约；现状矩阵中的专用分支不再成为新设计
需要维护的负担。如何处置/导出/保留现有数据属于另行明确的实施决定，本稿不执行
切换、删除、重新签发身份或修改真实会话。

## 14. 用三个案例走通设计

### Assistant

标准签名URL→识别roles能力→验签/兼容/信任→安装纯内容包→用户选一个已有或新
session→append/skill pin。没有configure/start/health，也无问卷和workspace
初始化。结束状态是role applied，不是service running。无需host写Assistant if。

### Task

URL→验证新的通用契约包→安装→配置Task自己的业务项→对明确的新空数据
由Task自己的initialize创建管理资源→start确认实际实例
→选择commander的native创建/apply→Task attach发caller并返回引用。

owner由Task业务dispatch经同一host `session/new` 请求其声明的owner role；
Task自己的goal/caller/owner认证不由manifest代替。host不再知道caller文件名。
模块调用公开API不需要独立hostAccess/scope授权。旧安装迁移不是此新协议的承诺，
不能据此对非空旧数据运行fresh initializer。

### 未预置的 `org.example.clipbook`

用户只提供 `https://modules.example.invalid/clipbook/stable.module-release.json`
（**不可访问的合成例子**）。按 [requests-and-receipts.json](examples/module-contract-v2/requests-and-receipts.json)：

1. inspect识别hostProtocol2 + notes/role/page能力；签名自洽但publisher untrusted。
2. verify绑定描述、manifest和archive的精确bytes/hash，无代码执行。
3. use/plan生成install→configure(default)→start→apply(writer到实际目标)的固定计划。
4. 一次“信任该module发布者并使用”的确认绑定指纹/capabilityDigest/target。
5. install只报installed；start后报实际run instance；目标busy则waiting/apply，
   不伪造applied；idle条件满足并确认后才能应用。
6. Web schema-page经受限action绑定发`modules/invoke notes.add`，MCP generic发**完全相同body**。
   业务由Clipbook的handler执行，host不增加notes表或notes.add实现。
7. notes.changed由模块cursor续读；升级保留旧session pin，卸载保留notes data。

这组例子检验**契约表达和引用一致性**，不是运行原型或网络安装证明：
`.invalid` URL、key/hash/byte示例均不可当真实发行证据，归档没有生成/下载/执行。
最终实现验收必须在一台已装通用host上由外部测试方提供此前未知的新module URL，
不改host配置文件/源码、不拷包，然后完整走Web/MCP相同流程及失败案例；现在尚未做到。

## 15. 最小分阶段改造与成本

| 阶段 | 最少工作 | 完成门槛 / 复杂度 |
| --- | --- | --- |
| A：失败契约和注册边界 | 保留结构化结果/原unknown身份、stop latch、成功后清理warning；规范动态moduleRef而不是只删enum | 对应失败场景回归；M级，保护不可倒退 |
| B：URL静态接入 | descriptor/manifest解析、公共地址/redirect隔离、信任确认、immutable安装、操作readback、动态角色/MCP | 未知名称内容模块只凭URL可用；M–L级，网络信任是主要成本 |
| C：通用运行与接入 | control/context、service/actions/events、config/schema、session hooks、一个page slot；Task/微信driver迁出host | 未知service模块Clipbook设计可实际落地；Task保持真实身份；L级 |
| D：可选扩展 | native普通tool、composer provider、repo网页便利解析、强沙箱、key轮换/显式模块依赖 | 分别新授权，不阻挡标准URL与基础能力完成 |

**第一版完整目标是A+B+C，不是做到纯内容安装就宣称全部通用化。**
保持一套API/错误/操作语义；不建立通用DAG调度器、业务凭据中心或native状态镜像。
发布新模块主要改其repo/manifest/包/schema；符合已有能力协议的新module不能要求
再改host enum、MCP工具实现或route table。新的基础能力原语才需要明确协议升级。

## 16. 其余少数取舍

| 取舍 | 推荐 | 可选代价 |
| --- | --- | --- |
| 首版链接形态 | 签名descriptor；manifest仅明确locator；裸ZIP/HTML不猜 | 做repo/Release网页自动发现需平台适配及更多不确定性，不是按仓库加白名单 |
| 新来源信任 | 一次确认这个module的key/来源/计划，并明确其默认全部公开API访问；不信任作者所有未来模块 | 不引入每模块API白名单；全publisher信任仍扩大了代码来源信任范围 |
| 执行隔离 | 首版坦诚同UID可信代码模型；页面sandbox独立 | 强隔离需要单独UID/容器/OS sandbox与文件/工具访问设计，成本更高；不是强制Docker |
| 页面/工具范围 | 一个声明式module.home schema-page；MCP优先；native terminal核心保留host | 自定义HTML需单独浏览器安全profile；任意DOM/React扩展和terminal hook不在首版 |

文首“不兼容旧模块、业务概念归模块、受信启用模块默认全部公开API、文件直接HTTP”
已经确定；其余具体能力范围和实现方案仍可讨论，不要求逐步骤开工确认。任何设计确认
均不表示本稿能力已经实现，也不构成修改现有数据或部署的授权。

## 17. 规范参考与它们不负责的部分

- [TUF specification](https://theupdateframework.github.io/specification/latest/)：
  支持区分可信文件分发、rollback/freeze、key与更新元数据；它明确不替应用决定任意
  首次软件安装是否可信，也不规定本模块包格式。此草案**不是TUF完整实现**。
- [JSON Schema 2020-12 core](https://json-schema.org/draft/2020-12/json-schema-core)：
  作为数据schema/dialect参考；不是允许网络ref或可执行schema。
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：
  tools/list、tools/call、input/output schema与结构化结果；annotations不自动可信。
  参考规范不意味着当前SDK已支持草案所有tool特性或改变现有allow-all policy。
- [RFC3986](https://www.rfc-editor.org/rfc/rfc3986.html)：
  URI解析/规范化基础，不等于SSRF防护。
- [RFC8785 / JCS](https://www.rfc-editor.org/rfc/rfc8785.html)：
  用于明确列出的inventory/contract/plan投影摘要；签名payload仍签原字节，不能经schema
  转换日期/数字后再假定是同一份签名字节。
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)：
  区分固定allowlist与任意公共目标场景，提醒重定向、DNS与实际地址边界；本草案用
  通用网络政策取代硬编码官方域名，不因支持任意仓库而取消防护。
