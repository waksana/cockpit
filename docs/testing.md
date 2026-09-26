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
| Web browser smoke and screenshots | `pnpm --filter @cockpit/web test:smoke` ([Chat Lab smoke](#chat-lab-smoke)) |
| Web types / lint | `pnpm --filter @cockpit/web typecheck` / `pnpm --filter @cockpit/web lint` |
| Backend test types | `pnpm typecheck:test` (per package: `pnpm --filter <pkg> typecheck:test`) |
| Backend / scripts lint | `pnpm exec eslint .` |
| Documentation links and anchors | `node --test scripts/check-docs.test.mjs` |
| Release and package checks | `node --test scripts/*.test.mjs` ([releasing](releasing.md)) |

To target files, use each package's existing Node test/tsx runner; do not add another
test framework (Web real-DOM tests use happy-dom and Testing Library on that runner,
see [Web interaction tests](#web-interaction-tests)). Combine related selectors for the same runner in one invocation and widen
only when the change or a result requires it. Documentation changes need link,
anchor, source and command-path checks, not a product build or test run.

Rules:

- Identity assertions on DOM/React nodes use `src/test/identityAssert.ts`;
  never hand object graphs with React internals to Node assert's diff formatting, and
  compare node arrays by element identity.
- On shared machines, give test processes their own cgroup memory limit, no swap and
  an execution timeout (a tool's wait threshold is not one). Do not rerun a failure
  unprotected after resource exhaustion.
- Default tests use synthetic inputs and controlled dependencies; opt-in native
  probes are not part of ordinary pass counts.
- server/core/MCP builds exclude their tests; protocol and Web tsconfigs include
  tests under `src`, so their typechecks cover them. Check the actual scripts.

### Bounded user scopes

Agent/service shells may not inherit the user manager's bus environment. If
`systemd-run --user` reports "No medium found", use the existing manager for the
current UID, not a hard-coded user or an authenticated system scope:

```sh
(
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  test -S "$XDG_RUNTIME_DIR/bus" || {
    echo "No user-manager bus at $XDG_RUNTIME_DIR/bus; bounded tests were not started." >&2
    exit 1
  }
  systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 \
    timeout --kill-after=30s 15m pnpm --filter @cockpit/web test
)
```

The values are an example budget; choose bounds for the selected suite. These
variables do not create a missing user manager or grant access to its bus. If the
manager or resource controls are unavailable, resolve that explicitly rather than
running the same workload unbounded. Native tests still need their isolated homes.

### Documentation checks

`node scripts/check-docs.mjs` checks tracked Markdown's local links and heading or
explicit HTML anchors, ignoring examples in code and external URLs. Its regression
tests and repository scan are part of `pnpm test`, so failures block required CI.
Generated/ignored files are not valid link targets. This does not check remote
sites or validate the claims in a document.

The separate **Module catalog freshness** workflow runs daily and on manual
dispatch. It compares only the catalog's **Latest release** column with GitHub's
Latest releases (`gh api`); it is not a required PR check. A mismatch or API failure
is reported, never silently accepted or used to update the catalog. New releases
do not establish an accepted host pairing. `node scripts/check-module-versions.mjs`
performs the same networked check when explicitly requested; its unit tests use
injected responses without network access.

<a id="web-interaction-tests"></a>
## Web interaction tests

Web component and interaction tests render into a real DOM: import
`src/test/dom.ts` **first** in the test file. It registers a happy-dom document as
the process's browser globals (Node keeps its own `fetch`, timers, `Response`,
`AbortController` and URL, so `t.mock.method(globalThis, 'fetch')` and
`t.mock.timers` work as elsewhere), re-exports Testing Library (`render`, `screen`,
`within`, `fireEvent`, `act`, `waitFor`) and `userEvent`, and unmounts after each
test. Tests that only need `document` for a manual `createRoot` can import
`src/test/happyDom.ts` alone.

- Drive behavior with `userEvent` (clicks, typing, keyboard) and `fireEvent` for
  events it cannot express; query by role, label and text where the element has an
  accessible name. Do not build hand-written fake DOM hosts or force `event.target`.
- happy-dom does no layout. Stub only the geometry a test needs (`clientHeight`,
  `getBoundingClientRect`, `matchMedia`) on specific elements or prototypes and
  restore it; measured layout belongs in the [Chat Lab smoke](#chat-lab-smoke).
- Registering the DOM also provides `localStorage` and other browser APIs; keep
  tests that assert no-DOM or no-storage behavior on the plain Node runner.
- Assert behavior, not product source text. Reading files is reserved for static
  guardrails such as stylesheets, class definitions, `index.html` and licenses, and
  for negative architecture guards (a component must not import or measure
  something) that no rendered behavior can observe.
- The harness makes `assert.equal`/`strictEqual` and their negations compare DOM
  nodes by identity with a short failure message; Node's default formatting of a
  happy-dom node walks the whole window and looks like a hang. Do not
  `deepEqual` nodes.
- Static markup (`renderToStaticMarkup`) remains fine for pure presentation checks.

<a id="chat-lab-smoke"></a>
## Chat Lab smoke

```sh
pnpm --filter @cockpit/web exec playwright install --only-shell chromium   # once
pnpm --filter @cockpit/web test:smoke
```

`apps/web/playwright.config.ts` starts the [Chat Lab](development.md#isolated-chat-component-review)
Vite server on `127.0.0.1:47851` (`COCKPIT_LAB_SMOKE_PORT` overrides) with a throwaway
`HOME`, `COCKPIT_HOME` and `COPILOT_HOME` and no lab module roots, then runs
`apps/web/e2e/chat-lab.spec.ts` in Chromium at desktop (1280×800) and narrow
(390×844 touch) sizes. Every page blocks requests leaving the lab origin and fails
on backend paths, page errors, console errors and horizontal overflow. It also runs
the in-page sidebar geometry and dialog-focus checks, real composer typing and the
region-failure repair.

Screenshots go to `apps/web/chat-lab-screenshots/<project>/` (git-ignored). CI's
parallel `Chat Lab smoke` job uploads them with failure traces as the
`chat-lab-screenshots-<sha>` artifact (30 days): that is the visual regression
baseline for review — compare a PR's artifact with `main`'s. Screenshots are not
pixel-compared, so fonts or Chromium updates do not fail CI. The job never contacts
a real service or session; it is not native, iOS or production evidence.

## Targeted Web suites

Global/session menus (one Web runner invocation): `src/lib/moduleRuntime.test.ts`,
`src/lib/sessionActions.test.ts`, `src/lib/menuFocus.test.ts`,
`src/components/GlobalNavigation.test.ts`, `src/components/ModuleSurfaces.test.ts`,
`src/components/Thread.lifecycle.test.ts`, `src/components/SessionResource.lifecycle.test.ts`
and `src/components/InteractionOwnership.test.ts`. The synthetic App mount covers
the overflow button, context menu, long press, dynamic state, exact session and late
results after withdrawal, without native services or push channels.

Public SDK package closure:
`pnpm --filter @waksana/cockpit-module-sdk test`. This builds and packs the SDK,
installs it into isolated, locked npm consumers with real peers and strict
declaration checks, and covers the [supported SDK entry points and matrix](module-sdk.md#build-and-verify).
`pnpm sdk:check` rejects stale generated wire types. PR CI separately checks
[independent SDK version decisions](module-sdk.md#versions-and-compatibility).
Host tests do not replace a real module package and consumer.

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
`packages/core/src/engine-roles.test.ts` cover saving during busy/pending/queue/schedules,
unloaded staying unloaded, repeated saves, uncertain persistence, lifecycle
concurrency and load-time resource validation. Mock injection is not production
failure evidence.

**MCP invocation metadata.** Synthetic: `pnpm --filter @cockpit/core exec node --import tsx --test src/mcp-invocation.test.ts`
— attaching [invocation metadata](module-contract.md#mcp-invocation-meta) only for
module role servers, preserving and merging existing request `_meta`, replacing a
forged namespace value, main agent versus subagent, subagent names and a fresh name
table after reload. Native:
`COCKPIT_NATIVE_MCP_META=1 pnpm --filter @cockpit/core exec node --import tsx --test src/mcp-invocation-native.test.ts`
— a real main-agent call and a `task` subagent call reach a loopback HTTP MCP server
with the expected metadata; a non-module server receives none.

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

**Default new-session model.** `packages/core/src/session-defaults.test.ts`,
`apps/server/src/session-defaults.test.ts`, `apps/server/src/intents.test.ts` and
`apps/mcp/src/tools/session-defaults.test.ts` cover create-only defaults, captured
concurrent choices, storage and catalog errors, and MCP-to-host dispatch. Run
`COCKPIT_NATIVE_MODEL_SMOKE=1 pnpm --filter @cockpit/server exec node --import tsx --test src/session-defaults-native.test.ts`
for isolated real SDK/HTTP/module creation and model readback, durable settings,
unchanged existing sessions/resume/reload/fork and later per-session switching.
It uses synthetic homes and a loopback model stand-in, not production credentials.
The Web DOM tests are `DefaultModelDialog.test.ts` and `GlobalNavigation.test.ts`;
Chat Lab smoke covers the global entry, persistence across reopening, focus and
desktop/narrow layout.

**Packages.** A runtime package must come from a clean fixed commit via the existing
packager and manifest checks. Only tests against the actual tar prove that package;
keep exact bytes and executable modes and run from the package's own dependencies,
never the development tree. Commands are in [releasing](releasing.md).

<a id="deployment-service"></a>
### Independent deployment service

The [deployment guide](deployment.md) owns installation, inputs and recovery.
Run the existing server runner for `src/deployment/deployment.test.ts`.
Default cases use generated archives, an injected GitHub response source and
separately spawned synthetic hosts with the real module loader/graceful-exit
owner. They cover HTTP/CLI, actual PID/instance replacement, SQLite/WAL backups,
data/file preservation, declared migration, cancellation races, partial claims,
durable failures and interrupted-process recovery. They are not production
deployment or arbitrary real-module migration evidence.

With the current user's working systemd manager, explicitly opt into:

```sh
COCKPIT_DEPLOYMENT_SYSTEMD_TEST=1 pnpm --filter @cockpit/server exec \
  node --import tsx --test src/deployment/deployment.test.ts
```

Apply the [bounded user scope](#bounded-user-scopes) around it. These cases create
uniquely named, test-only user unit files, use isolated homes/data/ports, exercise
startup/restart guards, and kill only their own controller while an actual
migration child is running. Cleanup stops/removes those exact units. They never
operate the real `cockpit.service`; absence of a user manager is a limitation,
not permission to switch to system units. An unset opt-in is a skip, not proof
of user-unit behavior.

<a id="diagnostics"></a>
## Optional diagnostics

| Diagnostic | Explicit entry |
| --- | --- |
| Synthetic fold | `pnpm regress --synthetic-fixture-root /absolute/synthetic-jsonl` |
| Isolated HTTP E2E | `pnpm e2e --synthetic-fixture-root /absolute/synthetic-workspace --test-base-url http://127.0.0.1:45678` |
| Fold / HTTP / SSE performance | `pnpm perf --synthetic-fixture-root /absolute/synthetic-jsonl --test-base-url http://127.0.0.1:45678` |
| Backend-free component lab | [Chat Lab](development.md#isolated-chat-component-review); automated smoke: [Chat Lab smoke](#chat-lab-smoke) |

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
