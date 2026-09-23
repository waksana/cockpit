# Testing

Existing verification entry points and their isolation rules. This page is not a
statement of current health or a permanent test count; product gates are
[R1–R8](product-requirements.md). Commands run from the repository root unless
stated otherwise. First-party test files are not runtime dependencies.

## Fast path

```sh
pnpm test     # every workspace suite + scripts/*.test.mjs + backend test typecheck (what CI runs)
pnpm lint     # backend/scripts ESLint (root config), then Web ESLint + Stylelint
pnpm build    # current build, including Web typecheck
```

Pick the smallest scope that covers the change:

| Scope | Command |
| --- | --- |
| Protocol schemas | `pnpm --filter @cockpit/protocol test` |
| Shared message folding | `pnpm --filter @cockpit/core exec node --import tsx --test src/fold.test.ts` |
| Native control, resources, lifecycle | `pnpm --filter @cockpit/core test` |
| HTTP handlers, schemas, CSRF, streams, shutdown | `pnpm --filter @cockpit/server test` |
| MCP mapping, attachments, paging, transport | `pnpm --filter @cockpit/mcp test` |
| Web native window, drafts, interaction | `pnpm --filter @cockpit/web test` |
| Web types / lint | `pnpm --filter @cockpit/web typecheck` / `pnpm --filter @cockpit/web lint` |
| Backend test types | `pnpm typecheck:test` (per package: `pnpm --filter <pkg> typecheck:test`) |
| Backend / scripts lint | `pnpm exec eslint .` |
| Release and package checks | `node --test scripts/*.test.mjs` ([releasing](releasing.md)) |

To target files, use each package's existing Node test/tsx runner; do not add a test
framework. Combine related selectors for the same runner in one invocation and widen
only when the change or a result requires it. Documentation changes need link,
anchor, source and command-path checks, not a product build or test run.

Rules:

- Identity assertions on simulated DOM/React nodes use `src/test/identityAssert.ts`;
  never hand object graphs with React internals to Node assert's diff formatting, and
  compare node arrays by element identity.
- On shared machines, give test processes their own cgroup memory limit, no swap and
  an execution timeout (a tool's wait threshold is not one). Do not rerun a failure
  unprotected after resource exhaustion.
- Default tests use synthetic inputs and controlled dependencies; opt-in native
  probes are not part of ordinary pass counts.
- server/core/MCP builds exclude their tests; protocol and Web tsconfigs include
  tests under `src`, so their typechecks cover them. Check the actual scripts.

## Targeted Web suites

Global/session menus (one Web runner invocation): `src/lib/moduleRuntime.test.ts`,
`src/lib/sessionActions.test.ts`, `src/lib/menuFocus.test.ts`,
`src/components/GlobalNavigation.test.ts`, `src/components/ModuleSurfaces.test.ts`,
`src/components/Thread.lifecycle.test.ts`, `src/components/SessionResource.lifecycle.test.ts`
and `src/components/InteractionOwnership.test.ts`. The synthetic App mount covers
the overflow button, context menu, long press, dynamic state, exact session and late
results after withdrawal, without native services or push channels.

Public type exports: `node --test scripts/export-module-api.test.mjs`. A module must
still export from a clean matching SHA and build itself; host tests do not replace a
real module package and consumer.

Current-window reads and input enhancement: `src/lib/moduleChatWindow.test.ts`,
`src/lib/moduleView.test.ts`, `src/lib/moduleRuntime.test.ts`,
`src/components/Composer.test.ts` and `src/components/Thread.lifecycle.test.ts`
(window state/ownership/withdrawal, native input gates, node order). A module's
microphone, credentials, recognition and cost are outside these tests.

With a companion Speech build made against the exact host SDK pin, run the real
consumer on the same runner:

```sh
COCKPIT_TEST_SPEECH_ENTRY=/absolute/cockpit-speech/dist/web/index.js \
  pnpm --filter @cockpit/web exec tsx --tsconfig tsconfig.app.json --test \
  src/components/Thread.lifecycle.test.ts
```

It mounts the real speech middleware on the real Composer with synthetic
AudioContext, AudioWorklet/PCM, WebSocket, permissions and HTTP, covering control
order, ref cleanup, selection/focus return, panel structure, leases and manual-edit
recovery. Without the variable it skips; it never reads speech config or uses Azure
or a real microphone.

<a id="native-sdk-and-package"></a>
## Native SDK and packages

Native tests create a synthetic home/config/workspace with a loopback model stand-in;
they never read production sign-in, copy user sessions or reach real channels:

```sh
cd packages/core
COCKPIT_NATIVE_SMOKE=1 COCKPIT_NATIVE_STATE_SMOKE=1 COCKPIT_NATIVE_FORK=1 \
COCKPIT_NATIVE_MODEL_SMOKE=1 COCKPIT_NATIVE_DELETE_TEST=1 \
  node --import tsx --test src/runtime-smoke.test.ts src/native-state-smoke.test.ts \
  src/fork-native.test.ts src/model-settings-native.test.ts src/delete-native.test.ts
```

**Roles.** Synthetic: `pnpm --filter @cockpit/mcp exec node --import tsx --test src/tools/roles.test.ts src/index.test.ts`
plus the HTTP stub in `apps/server/src/intents.test.ts` — one metadata-only request,
the complete `saved/unchanged/uncertain` result, error marking for unknown
persistence, saved/applied roles and reload state, and no readiness or native load on
ordinary reads. Native:
`COCKPIT_NATIVE_ROLES=1 pnpm --filter @cockpit/core exec node --import tsx --test src/roles-native.test.ts`
(from the root) — existing native ID/history/cwd, unchanged capabilities while saving,
and composed instructions with the minimal tool subset after explicit reload or cold
resume; temporary resource switches follow native global defaults. Role cases in
`packages/core/src/engine.test.ts` cover saving during busy/pending/queue/schedules,
unloaded staying unloaded, repeated saves, uncertain persistence, lifecycle
concurrency and load-time resource validation. Mock injection is not production
failure evidence.

**Tool metadata.** The same native entry covers null tool metadata after model/Skill
changes, MCP reload not restoring it, explicit `session/tools-initialize` restoring it
without inference or reload, and re-enabling a Skill after cold resume. Check that
temporary choices persist, disabled Skills still fail and real native tool filtering
still yields missing tools — not just connections. Engine tests add rejection of
unknown/unloaded/busy/concurrent operations, native errors, null readback and close
races.

**Resource preparation.** `session/resources-prepare` reuses the Engine, HTTP/module
facade and native roles entries: full precheck before mutation, per-step
partial/unknown effects, lifecycle concurrency, a single initialization after null or
confirmed-enabled resources, raw MCP tool identity/actual filtering, and unrelated
disabled resources preserved without cold reload. The native fixture covers an empty
non-null table rebuilt after MCP enable in the same preparation, null recovery after a
Skill fails, real filtering after known config changes, and no speculative rebuild
for untouched resources. Module result persistence and Task consistency must be
verified by the real module.

**Files and fork.** File-input tests pass synthetic native files through the Engine
and read them via the native view; the four attachment schemas do not prove each
media type/model is readable. The full MCP/native fork test is in the
[fork guide](../apps/mcp/README.md#session-fork).

**Packages.** A runtime package must come from a clean fixed commit via the existing
packager and manifest checks. Only tests against the actual tar prove that package;
keep exact bytes and executable modes and run from the package's own dependencies,
never the development tree. Commands are in [releasing](releasing.md).

<a id="diagnostics"></a>
## Optional diagnostics

| Diagnostic | Explicit entry |
| --- | --- |
| Synthetic fold | `pnpm regress --synthetic-fixture-root /absolute/synthetic-jsonl` |
| Isolated HTTP E2E | `pnpm e2e --synthetic-fixture-root /absolute/synthetic-workspace --test-base-url http://127.0.0.1:45678` |
| Fold / HTTP / SSE performance | `pnpm perf --synthetic-fixture-root /absolute/synthetic-jsonl --test-base-url http://127.0.0.1:45678` |
| Backend-free component lab | [Chat Lab](development.md#isolated-chat-component-review) |

Diagnostics refuse to run with missing arguments and never use user history or
production URLs. `pnpm regress` runs `packages/core/test-support/regress.mts` on
1–32 flat, regular, non-linked JSONL files (≤4 MiB each, 16 MiB total); personal,
native or config roots, links, hard links and malformed input are rejected. HTTP
targets must be a separate IPv4 loopback test port — never 8771 or a declared
production port — and redirects cannot cross targets.

**Arguments and ports do not isolate the environment.** Set up an independent
runtime/home/workspace/credentials and model stand-in first. `e2e` creates, modifies
and deletes its own native fixtures and schedules; `perf` repeats reads and opens
concurrent SSE. Failures or interruptions can leave test resources behind.

## Reading evidence

| Evidence | Shows | Does not replace |
| --- | --- | --- |
| Source/schema review | Declarations, call paths, static boundaries | A model reading media, a process actually exiting, a deployment |
| Synthetic unit/component tests | Behavior, failures and concurrency on constructed input | All real devices and workloads |
| Isolated native SDK tests | Real calls on the pinned SDK/runtime with synthetic effects | Production credentials/history, real channels, host capacity |
| Fixed artifact and entry runs | Package closure, native assets, resolvable Web/API/MCP | That the package is deployed |
| Instance and package observation | Source, artifact, instance and health at a point in time | User outcomes or future health |

Measure RPCs, event counts, bytes, frontend computation and I/O separately; never
substitute one for another or extrapolate tokens. Native accepted/queued is not
completion, and a historical subagent finishing is not the whole goal finishing.

Afterwards, close your own loopback listeners, SSE, SDK subprocesses and temporary
fixtures and record real cleanup failures; never delete real sessions, native homes,
user uploads or others' worktrees as cleanup. Shutdown and authentication behavior is
owned by [architecture](architecture.md#shutdown).
