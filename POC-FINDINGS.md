# Phase 0 — SDK PoC 结论:GO ✅(2026-06-16, copilot 1.0.63)

> 历史 PoC，仅保留当时的调查记录，不是当前实施方案。下文进程内
> `internal.*`、旧认证 bootstrap 和旧能力结论已被官方进程外 SDK 接入替代，
> 不应按此重新配置或开发。当前定位见
> [Cockpit 定位与验收准则](docs/product-requirements.md)，实现见
> [底座设计](docs/cockpit-plan.md)。

进程内 `@github/copilot/sdk` 驱动 Copilot session **全部验证通过**。可以照 STACK-v2.md 推进。

## 关键意外:已发布 SDK 的公开面 ≠ .d.ts

`sdk/index.d.ts` 声明了 `query` / `Session` / `LocalSession` / `LocalSessionManager` / `AuthManager`,
但**实际 runtime 都没导出**。可用的真实入口是:
- `sdk.internal.LocalSessionManager`(session 管理类,在 `internal` 下)
- `sdk.resolveAuthInfoFromToken(token, host?)`(造 AuthInfo)
- `sdk.createLocalFeatureFlagService({authInfo})`
- `sdk.internal.NoopTelemetryService`
- 其余:schemas / 模型 helper / loggers / hooks

→ **走 `internal.*`,属内部 API,必须锁 copilot 版本(1.0.63),update 后回归。**

## 可用的 bootstrap 配方(Phase 3 core 直接用)

```js
import * as sdk from "@github/copilot/sdk";
import { execSync } from "node:child_process";

// 1. auth —— gh token 即可(无需 copilot OAuth store)
const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
const authInfo = await sdk.resolveAuthInfoFromToken(token);
// → { type:"token", host, token, copilotUser:{ login:"waksana", ... } }

// 2. feature flags
const ffs = sdk.createLocalFeatureFlagService({ authInfo });

// 3. manager（注意 internal）
const mgr = new sdk.internal.LocalSessionManager({
  version: "1.0.63",
  telemetryService: new sdk.internal.NoopTelemetryService(),
  featureFlagService: ffs,
});

// 4. session —— featureFlagService 必须也传进 createSession options，
//    否则 session ctor 走 e.createFeatureFlagService(...) 报错
const session = await mgr.createSession({ workingDirectory, authInfo, featureFlagService: ffs });
```

## 事件与控制 API(LocalSession 是 EventEmitter)

- 监听:`session.on(type, handler)`。已观测事件类型:
  `user.message` · `assistant.message`(增量 content) · `assistant.turn_start` · `assistant.turn_end` ·
  `session.idle`(轮结束信号) · `session.model_change` · `system.message` ·
  `permission.requested` · `user_input.requested` · `pending_messages.modified` ·
  (还有 `tool.execution_start/complete` 等)
- 发送:`session.send({ prompt, mode })`;`mode:"enqueue"`(默认,FIFO 队列) / `"immediate"`(轮内插入)。
- YOLO 权限:`session.on("permission.requested", e => session.respondToPermission(e.data.requestId, { kind:"approved" }))`
- **ask_user 问卷**:挂 `session.on("user_input.requested", ...)` 即**启用 ask_user 工具**;
  事件 data = `{ requestId, question, choices:[...], allowFreeform }`;
  回答:`session.respondToUserInput(requestId, { answer, wasFreeform })`。
- 会话管理:`mgr.listSessions()`(全量无分页,带 summary/cwd/modifiedTime) ·
  `mgr.deleteSession(id)` · `mgr.bulkDeleteSessions` · `mgr.pruneOldSessions` · `mgr.getSessionSizes` · `mgr.getSession`/`loadSession` · `mgr.forkSession`。

## 实测验证清单

| 项 | 结果 |
|---|---|
| auth 自动(gh token) | ✅ login=waksana |
| listSessions 全量 | ✅ 146–157 条,带 summary/cwd/mtime,无 50 分页 |
| createSession | ✅ |
| send + 事件流 + session.idle | ✅ 助手回 "POC_OK",~35s |
| **ask_user 问卷(choices)** | ✅ 模型带 ["Apple","Banana","Cherry"] 调用,respondToUserInput("B") → 模型答 "Banana" |
| **消息队列 enqueue** | ✅ pending_messages.modified 触发;轮内入队的第2条在第1条后处理,顺序保持 |
| deleteSession | ✅ 删除 14 个 /tmp 测试 session,磁盘回收 |
| 空闲驱逐(ACP 的 30min 坑) | N/A —— 进程内自管 session 生命周期,该类 bug 消失 |
| MCP 加载 | 未测(SessionOptions.mcpServers 存在,低风险,留待实现期) |

## 结论
SDK 进程内方案**全绿**,且一次性拿到 ACP 缺的:全量列表、删除、CLI 队列、ask_user 结构化问卷。
踩坑账本里 A1/A2/A3/A4/A6 全部由 SDK 消解。继续 Phase 1（scaffold ~/cockpit monorepo）。
