# 验证与证据边界

本文维护现有验证入口和隔离要求，不是当前运行健康、安全认证或永久测试数字。
产品门槛以 [R1–R8](product-requirements.md) 为准。
以下命令默认从仓库根执行，已明确子目录的例外除外。
覆盖原生、HTTP、Web、graceful 关闭与普通产包；第一方测试文件不属于运行依赖。

## 按改动选择最小范围

| 范围 | 命令 |
| --- | --- |
| 协议 schema | `pnpm --filter @cockpit/protocol test` |
| 共享消息折叠 | `pnpm --filter @cockpit/core exec node --import tsx --test src/fold.test.ts` |
| 原生控制、资源和生命周期 | `pnpm --filter @cockpit/core test` |
| 真实 HTTP handler、schema、CSRF、流和退出 | `pnpm --filter @cockpit/server test` |
| MCP 映射、附件、分页和传输 | `pnpm --filter @cockpit/mcp test` |
| Web 原生窗口、文字草稿和交互 | `pnpm --filter @cockpit/web test` |
| Web 类型 / lint | `pnpm --filter @cockpit/web typecheck` / `pnpm --filter @cockpit/web lint` |
| 全仓现有套件 | `pnpm test` |
| 当前构建 | `pnpm build` |
| 普通运行包边界 | [产包说明](packaging.md)中的现有 Node test 入口 |

需要定向到文件时，用各 package 已有的 Node test/tsx runner，不安装另一套测试框架。
同 runner 的相关选择器合并执行；仅当改变范围或结果需要时再扩大到全套。
文档变更核对链接、锚点、来源和命令路径；没有专门文档用例时无需运行产品构建或测试。

默认用例采用合成输入和受控依赖；明确 opt-in 的 native probes 不包含在普通成功数字里。
server/core/MCP 的构建排除其测试文件；protocol 及 Web 的 tsconfig 包含 `src`
下的测试，所以相应类型检查也覆盖它们。以各自实际脚本/tsconfig 为准，
不能用“所有测试都不参与类型检查”概括。

全局/会话菜单改动使用 Web 现有 runner，合并运行 `src/lib/moduleRuntime.test.ts`、
`src/lib/sessionActions.test.ts`、`src/lib/menuFocus.test.ts`、
`src/components/GlobalNavigation.test.ts`、`src/components/ModuleSurfaces.test.ts`、
`src/components/Thread.lifecycle.test.ts`、`src/components/SessionResource.lifecycle.test.ts`
和 `src/components/InteractionOwnership.test.ts`。
其中 App 的合成挂载覆盖三点、右键、长按、动态状态、精确 session 与撤销后的晚结果；
不连接原生服务或推送渠道。公共类型导出使用
`node --test scripts/export-module-api.test.mjs`；模块还需从干净配套 SHA 导出并自行构建，
不能以宿主用例代替真实模块包与消费者接入。

## 真正的 SDK 与包

现有 native 用例使用新建 synthetic home/config/workspace 和 loopback 模型替身，
不读取生产登录、复制用户 session，也不连接真实渠道：

```sh
cd packages/core
COCKPIT_NATIVE_SMOKE=1 COCKPIT_NATIVE_STATE_SMOKE=1 COCKPIT_NATIVE_FORK=1 \
COCKPIT_NATIVE_MODEL_SMOKE=1 COCKPIT_NATIVE_DELETE_TEST=1 \
  node --import tsx --test src/runtime-smoke.test.ts src/native-state-smoke.test.ts \
  src/fork-native.test.ts src/model-settings-native.test.ts src/delete-native.test.ts
```

文件输入用例让 Engine 传入合成原生文件，再由 native view 读取。
四种附件 schema/转发用例不等于每种媒体/模型均实测可读。完整 MCP/native fork 用例
见[分叉指南](session-fork.md#local-regression-fixture)，不要用 schema 样例代替真实连接。

实际运行包必须来自干净固定提交，使用已有 packager 和 manifest 校验。
只有针对实际 tar 的验证才能证明该包；合成 fixture 的通过不能替代。
按产包/解包工具保留精确字节和可执行 mode，
从包自己的依赖入口运行；不能借用开发树依赖让缺包伪装成功。
具体命令由[普通产包](packaging.md)维护。

## 可选诊断

| 诊断 | 显式入口 |
| --- | --- |
| 合成 fold | `pnpm regress --synthetic-fixture-root /absolute/synthetic-jsonl` |
| 隔离 HTTP E2E | `pnpm e2e --synthetic-fixture-root /absolute/synthetic-workspace --test-base-url http://127.0.0.1:45678` |
| 合成 fold / HTTP / SSE 性能 | `pnpm perf --synthetic-fixture-root /absolute/synthetic-jsonl --test-base-url http://127.0.0.1:45678` |
| 无后端组件 lab | [开发指南](DEVELOPMENT.md#isolated-chat-component-review) |

诊断默认缺参数即拒绝，不使用用户历史或生产 URL。
`pnpm regress` 执行 `packages/core/test-support/regress.mts`，输入是显式合成日志。
日志限平坦的 1–32 个普通非链接 JSONL 文件，每个最多 4 MiB、合计 16 MiB。
个人/native/config 根、链接、硬链接和格式错误被拒绝。
HTTP 只能指定独立 IPv4 loopback 测试端口，不能用 8771 或已声明的生产端口，
也不能通过重定向跨目标。

**参数或端口不提供环境隔离。** 必须先独立配置 runtime/home/workspace/凭据与模型替身。
`e2e` 会创建/修改/删除自己的原生 fixture，并创建/停止原生 schedules；
`perf` 会重复读接口并开启并发 SSE。失败或中断可能留下测试资源，不能当成无副作用操作。

## 如何解释证据

| 证据 | 能说明什么 | 不能替代什么 |
| --- | --- | --- |
| 源码/schema 检查 | 声明、调用路径和静态边界 | 模型真的读取媒体、进程实际关闭或现场部署 |
| 合成单元/组件用例 | 已构造输入的行为、失败和并发情况 | 所有真实设备和实际工作负载 |
| 隔离 native SDK 用例 | 固定 SDK/runtime 的真实调用与合成副作用 | 生产凭据/历史、真实渠道和整机容量 |
| 固定产物与入口运行 | 包闭包、原生资产、实际可解析的 Web/API/MCP | 该包已经上线 |
| 实例与实际包观察 | 指定时间的源码、产物、实例和健康 | 用户业务结果或未来一直健康 |

分别度量 RPC、事件数、字节、前端计算和可测 I/O；不能把一种代理成另一种或推成 token。
原生 accepted/queued 不是完成，历史子代理“此次结束”不是整个目标完成。

验证结束要关闭本人的 loopback 监听、SSE、SDK 子进程和临时 fixture，
记录真实清理失败；不借清理删除真实 session、native home、用户上传或其他人的 worktree。
原生安全退出与认证本身的行为只维护在[架构边界](cockpit-plan.md)，不在测试指南另写一套。
