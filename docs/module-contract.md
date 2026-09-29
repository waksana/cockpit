# Module contract
This document defines the current Cockpit module host contract. Version numbers in this file are API capability versions, not release pairings: manifest/backend API v1, Web API v3 (with native-only v2 compatibility), public UI v1, `menuVersion: 1`, `settingsVersion: 1`, `uiSurfaceVersion: 1`, `chatWindowVersion: 1`, `composerInputVersion: 1`, `draftLifecycleVersion: 1`,
`draftSubmissionVersion: 2`, `publicComponentsVersion: 1`, `draftOwnerVersion: 1`, `pageVersion: 1`, and `context.serviceReadyVersion: 1`. Host/module release pairings belong in the [module catalog](modules.md) and GitHub Releases.

Product boundaries are in [R1-R8](product-requirements.md). Business contracts for individual modules, such as File or Notification, stay in their own repositories; this document only defines host/module integration.

## 1. Supported scope
The host verifies trusted local `.tgz` packages into immutable install directories, imports built backend JavaScript in the main Node process, serves digest-bound module API/assets, and lets same-package ESM/CSS reuse host React, theme, state and public component boundaries without creating another SPA root. Loaded
modules may observe declared native SDK projections for loaded sessions, declare global/session menus and namespaced pages, wrap real semantic components, register module state/services and draft schemas, and render parsed Markdown link/image nodes. The host owns base prompt/decision draft state and native send/ACK; modules extend drafts
only through scoped declarations. Install, enable, disable, migrate and config changes take effect on a later cold start, not by hot-load, hot-unload or restart. Current APIs do not provide arbitrary page/router registration, a workflow engine, generic business slots, browser notification policy, file library pages,
remote signed URL installation, pure-content packages or frontend-only packages. Unknown manifest fields and old frontend slots are rejected.
<a id="package-install"></a>
## 2. Package format, installation, and ID migration
A package root contains `cockpit.module.json`:
```json
{
  "apiVersion": 1,
  "id": "example-module",
  "name": "Example",
  "version": "0.1.0",
  "backend": "dist/server/index.js",
  "frontend": {
    "entry": "dist/web/index.js",
    "styles": ["dist/web/styles.css"],
    "assets": ["dist/web", "dist/shared"],
    "worker": "dist/web/worker.js"
  }
}
```
`id` and role IDs match `^[a-z][a-z0-9-]{0,63}$`; versions are semver strings no longer than 128 characters. `backend` is required and must be a packaged `.js`, `.mjs`, or `.cjs` file. `frontend` is optional and strictly limited to `entry`, `styles`, `assets`, and `worker`: `entry` must be `.js`/`.mjs`, styles must be
`.css`, worker must be `.js`, and all frontend entry/style/worker files must exist under declared asset roots. No alternate frontend fields are valid.

All module-relative paths are nonempty, below 1024 characters, not absolute, and must not contain backslashes, drive separators, control characters, URL query or fragment characters, empty segments, `.`, or `..`. The package must include its runtime dependencies; the host does not run package-manager install scripts.
`frontend.worker` is a narrow optional worker file under an asset root and is limited to 1 MiB.
Optional top-level `instructions` names a packaged Markdown file (at most 16 KiB) with the module's [default instructions](#default-instructions).

The installer accepts plain tar archives and npm archives with a single `package/` prefix. It rejects symlinks, hard links, special files, path escape, duplicate entries, parent/file shadowing, mixed package roots, unsupported tar formats, invalid checksums, unterminated archives, and extended headers. Limits: 32 MiB
compressed archive, 128 MiB expanded archive, 32 MiB per file, 8,192 entries, and a 64 KiB manifest.
<a id="local-install"></a>
From a source checkout, prefer the root script:
```sh
pnpm module install /absolute/path/module.tgz --trust-local-code --enable
pnpm module enable example-module --version 0.1.0 --digest <sha256>
pnpm module disable example-module
pnpm module list --server http://127.0.0.1:8771
```
The equivalent runtime-package command is:
```sh
node --enable-source-maps apps/server/dist/module-cli.js ...
```
`install` requires `--trust-local-code`; the flag means the operator trusts this executable code, not that a signature was verified. Validation completes before any entry is imported and before any script can run. The same id/version with a different digest is not overwritten. `--enable` selects the installed digest
for the next start. `enable` may specify `--version` and `--digest`; without them it selects an installed module by id according to current CLI rules. `disable` changes only the next-start selection. `list` reads installed packages and selection, then optionally queries `/_modules` from a loopback HTTP origin; an
unreachable server is reported as unavailable, not as loaded. Commands never shut down or restart the host.

Module and Copilot plugin package formats are unrelated. For distributable module content, increase the module version before shipping different package bytes; a source SHA cannot replace the package version. Delivery and release process details are in [releasing](releasing.md).
<a id="module-id-migration"></a>
### One-time module ID migration
`pnpm module migrate-id <old-id> <new-id> --version <version> --digest <sha256> --offline [--apply | --resume]` changes the host-owned module identity once, without aliases. It does not relabel installed archives, modify native Copilot history/configuration, change session IDs or role IDs, or inspect/transform module
business data.

Stop every process using the target `COCKPIT_HOME`, including older hosts, CLI writers, and restart managers, before migration and keep them stopped through recovery. `--offline` is the explicit operator acknowledgement; a free port or HTTP failure is not proof that all writers are stopped. Migration currently requires
Linux with a shared network namespace for every cooperating process that uses the root. Non-Linux startup remains available but reports that migration fencing is unavailable; pending journals still block startup everywhere.

Offline procedure:
```sh
pnpm module install /absolute/path/new-module.tgz --trust-local-code
pnpm module migrate-id old-module new-module --version 1.0.0 --digest <sha256> --offline
pnpm module migrate-id old-module new-module --version 1.0.0 --digest <sha256> --offline --apply
```
The first migrate command is a read-only plan. Apply requires identical IDs and the verified destination version/digest. The destination must already be installed, pass full integrity verification, and have no selected entry, data directory, or persisted role references. The source must be selected. The cutover
preserves source `enabled` and `config`, removes the source selection, moves the data directory by same-filesystem rename, and refreshes migrated host role labels from the destination manifest while retaining role IDs. It refuses missing target roles, duplicate roles, corrupt or unexpected metadata, links, conflicting
stores, and unrelated drift before cutover. An absent source data directory is reported and no new directory is created. Unrelated role records remain byte-for-byte unchanged.

Before the first cutover, the migrator writes a bounded private `modules/.migration.json` journal with exact before/after host metadata and data directory identity. It contains configuration values and must not be published. Host startup and install/enable/disable writes refuse to proceed while the journal exists, even
if it is corrupt.

Resume an interrupted cutover explicitly:
```sh
pnpm module migrate-id old-module new-module --version 1.0.0 --digest <sha256> --offline --resume
```
Resume requires the original parameters, re-verifies both installations, the complete role-file inventory, exact recorded before/after metadata, and the original data directory inode/device at exactly one expected location. Unexpected drift is an error, not data to merge or overwrite. Do not delete the journal to
bypass an error. There is no automatic retry or rollback, and an error does not mean earlier changes were undone.

Storage writers (install, enable, disable and migration) are serialized by a separate root-specific Linux abstract-socket writer lease, so abrupt CLI death leaves no lock to remove before `--resume`. Do not remove storage recursively or discard the journal; unexpected permissions or unresolved metadata/data drift
requires investigation. A `modules/.lock` directory left by an older version is no longer used; once every older host and CLI writer is stopped it may be removed with `rmdir`.

On success the journal is retained as `modules/.migration-completed-<uuid>.json` with mode 0600 in private module storage. It preserves metadata originals, not a second copy of business data. Each journal is capped at 16 MiB and inventories at most 2,048 role files. Completed journals are not aliases, are not consulted
during normal startup, and do not allow applying the migration a second time to the removed source selection. Cooperative fencing uses a root-specific Linux abstract Unix socket lease acquired before native runtime construction and held through host exit; SIGKILL releases the lease, but a pending journal still blocks
boot. Different roots are independent. The CLI rejects non-Linux migration before writing; ordinary macOS/Windows startup only checks the pending journal. This is not authentication and cannot protect against arbitrary local filesystem writers, older binaries, or containers in a different network namespace.
<a id="storage-config"></a>
## 3. Storage, code, data, and configuration
`COCKPIT_HOME` is a nonempty absolute host root, defaulting to `~/.cockpit`, for host and module storage only:
```text
.cockpit/
  modules/
    config.json                    next-start selection and per-module config
    installed/<id>/<version>/<digest>/package/
    data/<id>/                     module business data
  session-roles/<sessionId>.json    saved role selection; not a native capability cache
  instructions.md                  optional user-written Cockpit user instructions
```
Native Copilot data is outside that tree. The host does not override native `baseDirectory` or `configDirectory`; `~/.copilot` and native configuration keep their ordinary ownership. Authentication and service setup are documented in [install](install.md).

The module CLI writes `config.json` with `apiVersion: 1`, selected `version`/`digest`/`enabled`, and a module-specific `config` object. Operators may edit documented config fields while preserving the identity fields written by the CLI. Config is passed on the next cold start. Do not put secrets in public module config
or source packages. Disable, update, native session deletion, and ID migration do not delete module business data unless explicitly stated above.

Install, enable, disable and migration require Linux and hold the writer lease, which excludes other writers but not a running host (writes still affect only the next cold start). Installation writes into private `modules/.install-<uuid>` staging, flushes every file and directory, publishes by one atomic rename and
then flushes the publication's parent directories; metadata files use the same write, flush, rename and parent-flush sequence. Staging left by a dead writer is never installed and is removed by the next writer. An installed directory is used only after its complete file inventory and digests verify; a same-digest directory that
fails verification is rejected, and reinstalling the identical archive moves it aside to `modules/.quarantine-<uuid>` for inspection and republishes verified content.
<a id="typescript-contract"></a>
## 4. Public TypeScript contract
The source of truth is the independently versioned
[`@waksana/cockpit-module-sdk`](module-sdk.md). Its repository sources are
[`backend.ts`](../packages/module-api/src/backend.ts) and
[`manifest.ts`](../packages/module-api/src/manifest.ts) for backend/manifest types,
and [`frontend.ts`](../packages/module-api/src/frontend.ts)
for Web API v3 and the explicit legacy v2 adapter. Modules should
[install an available, exact package version](module-sdk.md#install-from-github-packages)
and import its public types instead of copying declarations.
The package contains compiled ESM and declarations, with no internal protocol or
source-checkout dependency. Build, authentication, compatibility and independent
release rules are in the [module SDK guide](module-sdk.md).

Backend packages export `activate(context)` and return `ModuleBackend`:
| Field | Contract |
| --- | --- |
| `context` | `apiVersion: 1`, `serviceReadyVersion: 1`, `moduleId`, `dataRoot`, `apiBase`, read-only `config`, `signal`, `report`, `invalidate`, `publish`, and `host.call`. |
| `routes` | Validated `method`/`path` plus optional JSON or stream body and `bodyLimit`; handlers receive params/query/headers/body/signal and return status/headers/body or a stream. |
| `publicConfig` | Explicit browser-readable config only; the host never exposes all `config` by default. |
| `events` | Declared native event type filters and read-only handlers. |
| `controlEvents` | Declared `ServerEvent` type filters for existing native control projections; no extra native reads. |
| `onReady` | Optional service-ready callback; requires `context.serviceReadyVersion === 1`. |
| `roleAssignments` | Optional mutation-time `permit` and saved-selection `saved` hooks; requires `context.host.roleAssignmentVersion === 1`. |
| `dispose` | Non-blocking cleanup; it is not part of the host graceful-shutdown wait chain. |
A module never receives the root Fastify instance, Engine internals, native session handles, or a security sandbox. Routes are validated before registration; failure or timeout is attributed to the module. Same-process modules can still block synchronously, exhaust memory, or call process-level APIs.

### Role assignment lifecycle

Check `context.host.roleAssignmentVersion === 1` before relying on
`ModuleBackend.roleAssignments`. Both members are optional:

```ts
roleAssignments: {
  permit(assignment, signal) {
    signal.throwIfAborted();
    return { allowed: true }; // or { allowed: false, reason: 'Role is occupied' }
  },
  async saved(notification, signal) {
    // Idempotently record module-owned registration by notification.notificationId.
    // Do not infer readiness, load a carrier, or change its model here.
  },
}
```

`assignment` contains `operation: 'create' | 'add'`, the exact `sessionId`,
complete proposed `roles`, and `previousRoles`. Each role has `moduleId` and
`roleId`; combined selections include other modules. A module is consulted when
its roles occur in that selection. Missing permission means allow; missing
notification means no module handling. `saved` receives those same fields plus
a stable `notificationId`, derived from the session and complete saved role
identities, independent of whether creation or addition first selected them.
Explicit `roles/add` with already-saved roles can deliver a missing notification
(including a newly added module callback) without re-saving roles. An existing
receipt is recovered with its original ID and payload; already-delivered handlers
are not called again. The addition result remains `status: 'unchanged'` and
includes `notification: { notificationId, status: 'notified' | 'unchanged' |
'not-saved' }` when notification handling occurred.

After successful notification handling, the host emits a public
`session/invalidated` control event with `resources: ['identity']`, after the
assignment callback, module mutation lock, and this request's native lifecycle
guard have been released. This also covers unchanged-add recovery and explicit
`roles/notify` replay. Modules may fresh-read registration and native readiness
from that event before scheduling work; the event itself does not assert
readiness or authorize a prompt. Earlier creation/role events may precede the
callback and are not a substitute for this post-notification invalidation.

The host applies permission to both `session/new` and `roles/add`, not merely a
UI preflight. Conflicting module-role mutations serialize through permission,
save, and notification; unrelated modules can proceed. Denials surface through
ordinary host role selection as `ROLE_ASSIGNMENT_DENIED`. Callbacks can make
read-only host calls; recursive role mutations fail immediately with
`ROLE_ASSIGNMENT_REENTRANT`, rather than waiting on their own lock. Their signal
aborts on module shutdown or a host shutdown request, without waiting for module
code to finish before preserving a partial-effect receipt. Permission callbacks should be read-only: a later
module may deny, and the host does not roll back module business side effects.

Notifications describe saved selection, **not readiness**. They can register an
unloaded or unready session; no prepare/load/reload/model change is implicit.
Because create-time role assembly requires saving before native creation, failed
or unconfirmed creation defers notification. Recovery must confirm the exact
native identity exists before notifying; no replacement is created.

Notification failure returns HTTP 409 `ROLE_ASSIGNMENT_INCOMPLETE`, the actual
`sessionId`, and the SDK-exported `RoleAssignmentFailureDetails` in
`roleAssignment`: `notificationId`, `saved`, `roles`, `recovery`,
`notificationStatus: 'pending' | 'deferred' | 'failed' | 'notified'`,
`nativeCreation: 'confirmed' | 'unconfirmed' | 'not-applicable'`,
optional `nativeError`, and optional original returned `mutationResult`.
That result is `{ operation: 'create', result: { sessionId } }` or
`{ operation: 'add', result: RoleAdditionResult }`. It preserves a confirmed
creation result even if a later module notification fails. Absent returned
results remain unconfirmed rather than receiving a success-shaped fallback.
`RoleAssignmentFailure` types the common `code`/`sessionId`/`roleAssignment`
envelope for thrown host errors and HTTP errors (which additionally have `error`).
`saved` is `true` when confirmed and `null` when unconfirmed;
the error is not native rollback. Durable receipts under
`role-notifications/{pending,complete}/` fence conflicting assignments across
host restarts. After inspection, explicitly call `roles/notify` with the
`notificationId`. It only reconciles persisted roles and replays undelivered
module callbacks; it never repeats permission, save, creation, load, or reload.
Results are `notified`, `unchanged` (already delivered), or `not-saved` (a pending
write is confirmed to retain its previous selection, so no callback runs).
Unconfirmed native existence or changed saved roles remains an explicit failure.
`roles/add` recovery of an accepted unchanged selection does not repeat its
permission or native mutation. Callbacks must durably deduplicate IDs: a crash after module handling but before
the host receipt can require replay. There is no automatic retry or global
module-binding service.

Each asynchronous permission or saved callback has a 30-second deadline.
Timeout aborts its signal and rejects the operation; a saved callback timeout
retains the partial receipt and conflict fence for explicit recovery. Modules
must honor cancellation and must not commit late results. This bounds waiting
on asynchronous callbacks, not synchronous blocking by trusted same-process code.

### Passive session discovery and explicit load

Check `context.host.sessionDirectoryVersion === 1` before calling
`host.call('session/directory', { limit: 50, cursor? })`. The result contains
`sessions` (at most 100 per page) and optional continuation `cursor`. Entries
contain identity/title/cwd/current model when known, loaded/status/activity, and
saved/applied roles with reload flags, using the native session catalog. It reads
no chat/history, does not load or repair, and propagates native list/read failures.
Every candidate is reachable by continuation for an unchanged catalog. Catalog
identity changes reject the cursor; explicitly restart discovery rather than
accepting incomplete results. Activity and metadata are fresh reads, not an
atomic snapshot or a cached registry.

Check `context.host.sessionLoadVersion === 1` before
`host.call('session/load', { sessionId })`. This exposes the existing guarded
native load: `{ ok: true, sessionId }` on confirmed return, concurrent loads
coalesce, already-loaded handles are preserved, and missing identities or
lifecycle/native failures remain explicit. It does not close/resume an existing
loaded handle, create another session, send a prompt, or choose a new model.

`onReady?()` is called once for each successful cold activation after native `runtime.start()` and public HTTP `listen()` both succeed, unless shutdown has already started or the module scope is closed. The module's declared routes are already active, so `context.host.call` can reach HTTP MCP endpoints mounted by the
same module. `activate()`, Fastify `ready()`, injected requests, and earlier `agent/status: up` are not this signal. The callback promise does not block other modules, service startup, or graceful exit. Throws/rejections are reported through module errors and `/_modules.errors`; the host does not retry, unload, or send
an alternate event. Modules must check `serviceReadyVersion` before opening, creating, or migrating their own persistent data if they require this signal:
```ts
if (context.serviceReadyVersion !== 1) {
  throw new Error('This module requires a host with serviceReadyVersion: 1');
}
```
<a id="public-api-map"></a>
### 4.1 Public API map
"Public API" means the contracts the host explicitly passes to modules. Native HTTP/MCP product intents are a separate interface discovered through `/capabilities` in [apps/mcp/README](../apps/mcp/README.md); an intent's existence does not imply that frontend module context exposes it.
| Entry | Current contract | Scope |
| --- | --- | --- |
| Frontend runtime | `apiVersion: 3`, `menuVersion: 1`, `moduleId`, host `react`, `createPortal`, `signal`, `report` | Same module activation; native-only v2 adapter; no private DOM/store or separate React root. |
| UI capability | `uiVersion: 1`, `uiSurfaceVersion: 1` | Separate checks for public CSS classes/surfaces; not React/runtime or modal behavior. |
| Frontend HTTP/config | `apiBase`, public `config`, `request(path, init)` | Authenticated, digest-bound requests scoped to this module API. |
| Events | `onInvalidate(listener)`, `onEvent(listener)` | Same `/events` transport, scoped to this module; no replay or native chat subscription. |
| Host state | `context.state.host.getSnapshot()/subscribe()` | Only `sessionId`, `visible`, and `connected`. |
| Current chat window | `chatWindowVersion: 1`, `context.state.chatWindow` | Read-only loaded-window text projection; no history loading or write actions. |
| Module service | `context.state.register({ id, create, dispose })` | Synchronous service creation; queries/actions are module-defined. |
| Base draft | `context.state.bindDraft(reference)` | Stable draft lifecycle with text editing, blocks, guarded completion, and captured send only if declared. |
| Draft lifecycle | `draftLifecycleVersion: 1`, `editTextIfRevision`, `retired` | Atomic revision-guarded background completion and permanent retirement. |
| Draft owner | `draftOwnerVersion: 1`, `context.state.createDraft(options)` | Namespaced durable controller; business adapter owns request preparation, transport and receipt inspection. |
| Captured send | `draftSubmissionVersion: 2`, `sends: ['draft']`, `captureSend().send(expectedRevision)` | Same owner transaction as the button; one user-consent checkpoint, no caller-selected target or payload. |
| Draft schema | `context.state.registerDraft(...)` | Module owns validation, content test, projection, ACK, and optional persistence for its field only. |
| Menus | `menus`, `getState`, optional `subscribe`, `onSelect` | Global/session commands; native items remain first; no page/router registration. |
| Pages | `pageVersion: 1`, `pages`, `context.navigation.path/navigate/home` | This module's namespaced SPA pages and explicit homepage navigation; no arbitrary router access. |
| Components | `publicComponentsVersion: 1`, `context.components.get(name)`, `components`, `wrap(Base)` | Same public entry for host and module consumers; stable runtime/name identity and existing middleware. |
| Shared settings | `settingsVersion: 1`, `SettingsProps`, `components` with `boundary: 'settings'` | Append module-owned sections to host preference content; no generic settings store, native action or page registration. |
| Composer input | `composerInputVersion: 1`, `ComposerInputProps` | Actual controlled textarea; preserve value/onChange/events/ref and host submit gate. |
| Markdown | `markdown`, `matches(node)`, `component` | Already-parsed link/image occurrences only; not attachments or full Markdown parsing. |
| Worker | `context.worker?: { entry, scope }` | Narrow module worker URL/scope; module registers and unregisters itself. |
| Backend context | `apiVersion: 1`, `dataRoot`, `host`, `routes`, `events`, `publish`, `invalidate` | Module-private data and scoped host services; no SDK session handle. |
Calling `serviceHandle.get().getSnapshot()` first retrieves a module-created service; any `getSnapshot()` on that service is module code, not a host-provided chat reader.
<a id="public-data-boundaries"></a>
### 4.2 Public data boundaries
| Desired data | Public source | Not implied |
| --- | --- | --- |
| Current session/frontground/connection | `HostSnapshot` | No title, project directory, question, or messages. |
| Loaded window text | `ChatWindowSnapshot.messages` with `text/origin/complete/subtype/children` | Not full history; `ready` is not completeness; unknown origin is not guessed. |
| Draft text | `DraftReference` and `ModuleDraftSnapshot` | Snapshot is draft state, not chat history; attachments are module schema fields. |
| Current input operation | Composer `draft/operation/disabled/busy/sendBlocked`, editor ref, guarded callbacks | `purpose` identifies prompt/ask/plan/elicitation; ask context cannot bypass native free-text limits. |
| Rendered message | `MessageProps.identity/origin/complete/bodyRef/children/adornment` | Display identity is not native provenance; no raw transcript string or global ordering. |
| Markdown reference or attachment | `MarkdownNode` or `AttachmentProps` | No complete file library or automatic resource loading. |
| Backend native output/control fact | `events` `NativeObservation`, `controlEvents` `ServerEvent` | Not the browser's loaded window and not automatically forwarded to frontend. |
The host provides current-window reading, not `getLatestReply()`. A draft owner
may additionally supply bounded `referenceText` from already-visible eligible
content; it grants no history or routing access. Current ask question/choices
are exposed only through the matching draft's `askContext`. Modules must not use window reading to import private stores, query private DOM, read native home directories, or scan all history. A module may
use backend observation to maintain its own state, but that state is not equivalent to the public current-window contract.
<a id="window-context-proposal"></a>
### 4.3 Module-built context
```text
host state.chatWindow current read-only window
  -> module service selects messages and small excerpts
  -> component reads that context at the user action boundary
```
The host supplies state and native attribution; role selection, truncation, whether to include module draft data, and when to call external services are module policy. Consumers distinguish empty, unknown, stale, and error windows; capture original session/draft/request identities; and must not redirect late results to
a new target or overwrite later user edits. Reading text does not authorize sending.
<a id="role-http-mcp"></a>
### 4.4 Roles, resources, and module HTTP MCP

Backend API remains v1. `context.host.call` is optional; check concrete members or
capability flags, not `apiVersion`, Web API v2 or UI v1. Modules implement HTTP
MCP through ordinary `routes`; the host does not implement module business tools.

A manifest may declare up to 64 roles. Role IDs use the module ID regex; each
prompt file is package-relative and at most 64 KiB. Skill directories are package-
relative roots containing `SKILL.md`. MCP `path` starts with `/` and is relative
to the module API. Role sources sort by `moduleId/roleId`; identical resource
contributions are deduplicated. Reject conflicts: same skill name from different
sources, same MCP name from different modules, same MCP key with different
endpoints, or existing native user/workspace/plugin MCP with the same name.

```json
{"roles":[{"id":"executor","name":"Executor","instructions":"roles/executor.md","skillDirectories":["skills/executor"],"mcpServers":{"example-tools":{"type":"http","path":"/mcp","tools":["task_read"]}}}]}
```

Role instructions append to the main agent system message with headers for module,
role and native session ID. They do not replace base instructions, create custom
agents, use organization instruction fields or send initialization prompts. MCP
names are manifest keys. The host generates
`http://127.0.0.1:<host-port>/_modules/<moduleId>/<digest>/api<path>` and sets
`X-Cockpit-Module-Digest`. Same-module roles with the same endpoint union tool
lists; `['*']` means all tools and `[]` means none.

<a id="mcp-invocation-meta"></a>
#### MCP invocation metadata

For every `tools/call` sent to a module role MCP server, the host adds its native
observation of the caller to the request `_meta` under the key `cockpit/invocation`
(exported as `MCP_INVOCATION_META_KEY`, value type `McpInvocationMeta` in
`@cockpit/module-api`). The values come from the native runtime hook, not from tool
arguments, so the model cannot see or change them; any other `_meta` entries (such as
`progressToken`) are kept, and a value already under this key is replaced.

```json
{"_meta":{"progressToken":1,"cockpit/invocation":{"sessionId":"<main>","runtimeSessionId":"<caller>","subagent":true,"agentName":"general-purpose"}}}
```

| Field | Meaning |
| --- | --- |
| `sessionId` | Cockpit (native main) session that owns the MCP connection. |
| `runtimeSessionId` | Native runtime session that issued the call; equals `sessionId` for the main agent. |
| `subagent` | `true` when `runtimeSessionId` differs from `sessionId`, meaning a subagent (for example one started by the `task` tool) made the call. |
| `agentName` | Optional native internal agent name of that subagent (for example `general-purpose`), when the host observed its start event. Never set for the main agent. |

The host only labels calls; it never allows, denies or rewrites them, and it does not
know module tools. Modules decide how to use the label, for example rejecting a
subagent write that claims to be the main session. User-configured or other non-module
MCP servers never receive this key. Fields may be added later; ignore unknown fields.
Servers that do not read `_meta` behave as before. Requests without the key come from
an older host or a non-Cockpit client, not from a verified main agent.

<a id="default-instructions"></a>
#### Default instructions

A manifest may set top-level `"instructions": "instructions.md"`. While the module
is enabled, that file is appended to every Cockpit-created or resumed session
without any role selection. Cockpit composes one appended system message section
in this order: enabled module defaults sorted by module ID (header
`## Module <id> (<name>)`), then selected role instructions, then the optional
[Cockpit user instructions](install.md#user-instructions) file. It follows the
native system prompt and native instructions such as `AGENTS.md`, never replaces
them, writes no global configuration and does not affect the Copilot CLI. Each
section is listed in the session instruction sources panel.

The text is read and verified against the installed digest only at session
creation or resume (new session, reload, unload and load, host restart cold
resume). Loaded sessions are not changed mid-conversation and are not told to
reload; after disabling a module, its instructions are omitted from the next load.
Default instructions do not affect role readiness. Hosts that predate this field
reject such manifests, because the manifest schema is strict.

| Intent | Shape |
| --- | --- |
| `roles/list {}` | `{ roles: [{ moduleId, roleId, moduleName, name, description? }] }` |
| `roles/resources {}` | `{ modules: [{ id, name, roles: [{ id, name }], skills: [{ id, name, description?, roles }], mcpServers: [{ name, tools, roles }] }] }`; see below. |
| `roles/skill-read { moduleId, resourceId }` | Reads one verified packaged `SKILL.md` by the opaque identity from `roles/resources`; returns `{ id, name, description?, body, module }`. |
| `session/new { cwd, roles? }` | Creates one native session; result `{ sessionId }`. |
| `roles/readiness { sessionId, roles? }` | Passive readiness: `sessionId`, `loaded`, `ready`, `roles`, `reasons`, optional `appliedRoles`, `rolesNeedReload`. |
| `session/tools-initialize { sessionId }` | Initializes native tool table on a loaded idle session; `{ ok: true }`. |
| `session/resources-prepare { sessionId, skills?, mcpServers? }` | Narrow resource preparation; see below. |
| `roles/add { sessionId, roles }` | Saves roles for a future reload/cold load; see below. |

`context.host.call(name, body)` is limited to `session/new`, `session/get`,
`session/rename`, `roles/readiness`, `session/resources-prepare`, `prompt`,
`respondAsk`, and `session/chat`,
with `@cockpit/protocol` validation and shutdown admission. It exposes no Engine,
SDK objects, persistent stores, `session/tools-initialize`, resource toggles or
arbitrary intent passthrough. Creation failure may include a confirmed
`sessionId`; inspect before retrying and never blindly recreate.

<a id="native-conversation-bridge"></a>
#### Native ask responses and chat reads

Check `context.host?.askResponseVersion === 1` and
`context.host?.chatReadVersion === 1` before opening, creating or migrating
persistent module data when these capabilities are required. Older API v1 hosts
may omit them; SDK version or `apiVersion` alone is not support. The Rolling
descriptor advertises the same capabilities as `askResponse.v1` and `chatRead.v1`.

`host.call('respondAsk', { sessionId, requestId, answer, wasFreeform })` returns
`{ ok: boolean }` from the existing native decision adapter. All four fields are
required. Use the original session and pending request identity from `session/get`
or native control events, never a currently selected replacement session.
Native choice and `allowFreeform` checks still apply; stale or already answered
requests fail with `REQUEST_NOT_PENDING`. Failure does not send a prompt or retry
the answer. Ordinary `prompt` does not answer a pending ask.

`host.call('session/chat', body)` returns one native event page, not folded
messages, using the [native chat contract](native-chat.md). Its generated
`ModuleHostIntentBody<'session/chat'>` and `ModuleHostIntentResult<'session/chat'>`
come directly from the host schemas. The body carries `sessionId`, `source`,
`direction`, optional opaque `cursor`, `max`, `waitMs`, optional
`includeEphemeral`, `agentIds`, `agentScope`, `types`, and `bootstrap`. The result
preserves `sessionId`, `source`, `direction`, `events`, `cursor`, `cursorStatus`,
`hasMore`, optional `liveCursor`, and `read` counters.

`max` bounds events (1–256), not bytes. Passive `persisted` reads never load a
session; `live` reads require an existing loaded handle. Bootstrap adds a
`liveCursor` only for a live read; persisted bootstrap remains passive. Keep
source/direction/filter identity with cursors, and use `liveCursor` separately
for forward continuation after bootstrap. `cursorStatus: 'expired'` is not a
successful continuation; explicitly resynchronize rather than silently replacing
the cursor. Unknown sessions, invalid filters, native failures and malformed
results remain errors. No cache, replay, private history access, automatic load
or retry is added. Calls retain the existing module activation/shutdown guards.

`session/get` may include `nativeName` and `nativeNameUserSet` for loaded sessions
when native reads are consistent. `nativeName:null` means none; omission means
unknown. `session/rename` marks native workspace name user-set; modules override
only after verifying the user did not name it.

Saved role selections are stored by session ID and displayed while unloaded.
Labels refresh from installed manifests without migrating identity or loading a
session. Missing identities keep persisted labels but are not readiness evidence.
Cold resume assembles from current loaded modules; missing modules fail explicitly.
Loaded sessions show resources actually assembled.

`McpServerSession` and `SkillSession` may include verified `module:{id,name,roles?}`
provenance. It is not a prefix convention, authorization, connection, enablement,
readiness or complete-role proof. Skill provenance requires native name/path match;
MCP provenance records assembled role configuration, because live URL/config
identity is not exposed. Global `mcp/global`, `skills/global`, and `skills/read`
may include module sources only after verifying manifests by origin, digest,
endpoint or real `SKILL.md` path/SHA-256. A global native Skill source includes
the opaque role resource identity only when that exact verified path is declared
by a current role. Unknown resources stay unlabeled.
`mcp/global.connection.method` is `http`, `sse`, `stdio` or `unknown`; `target` is
only hostname or executable basename. `mcp/session` has no `connection` field.

`roles/resources` is the read-only catalog of what currently loaded modules' roles
assemble into sessions that select them: per module, every declared role, then each
Skill (opaque version-bound ID, name, optional frontmatter description) and MCP server (name, union of tool
subsets, `['*']` for all) with the IDs of the roles declaring it. Skill bodies are
verified against the installed digest; changed files fail the read. Modules without
role resources are omitted. It is not native global configuration, enablement,
connection or readiness and omits endpoints, digests and file paths. The classic global
MCP/Skills pages show it as a separate read-only "模块提供" group without switches;
the label names contributing roles unless every role of the module declares the
resource, and an item already listed in native global configuration with the same
verified opaque role resource identity stays only there. Module-only attribution
or a same-name packaged Skill is not enough to deduplicate it. Module resources
cannot be turned off globally.
Session MCP/Skills rows with verified `module` provenance show "随角色启用" instead of
a session switch, because role assembly restores them on reload or cold resume;
status and errors remain visible, and a module Skill that native reports disabled in
the session shows "本会话已停用". Other rows keep their session switch.

The classic global Skills page links module-provided rows to the same read-only
Markdown detail layout as native Skills. `roles/skill-read` accepts only a loaded
module ID and an opaque Skill identity issued by the current catalog. The server
resolves that identity through current role `skillDirectories`, rechecks the
installation inventory, real-path boundary and SHA-256, and returns only that
`SKILL.md`; it accepts no client path and exposes no installed path or module
digest. A disabled, unloaded or replaced module and an unknown or stale identity
fail with `MODULE_SKILL_NOT_FOUND`. Integrity and file read failures stay explicit
and never fall back to a same-name native Skill, another module or another version.
Related `references/`, `scripts/` and `assets/` are not listed or readable through
this intent.

Readiness is explicit only. `roles/readiness`, `cockpit_role_readiness`, and
`context.host.call('roles/readiness', ...)` check current assembly, native skill
paths/enabled state, MCP connection/policy status and native tool metadata. Lists,
snapshots, labels, details and panels do not calculate readiness and do not load,
apply roles, reload, enable resources or repair state.

Native `tools.getCurrentMetadata()` uses `null` for uninitialized/invalidated and
`[]` for initialized empty. Model changes and skill toggles may invalidate it;
MCP reconnects are not guaranteed to rebuild it. `session/tools-initialize` calls
native `tools.initializeAndValidate()` on a loaded idle session with no protected
work or concurrent operation. It preserves handle/model/temporary resource choices,
history and ID; it does not cold-load, apply saved roles, write global config,
enable disabled resources or send prompts. `{ok:true}` means metadata initialized;
check readiness separately. Failures may leave native side effects and are not
automatically retried.

<a id="session-resource-preparation"></a>
#### Explicit session resource preparation

`context.host.resourcePreparationVersion: 1` exposes the narrow
`session/resources-prepare` bridge. It has no separate toggles, tool-only
initialization or arbitrary intents.

Request:

```ts
{ sessionId: string; skills?: string[]; mcpServers?: Array<{ name: string; tools?: string[] }>; }
```

Names/sessionId are nonblank and at most 200 characters. Skills and MCP servers
are at most 64 unique names each; each `tools` list is at most 256 unique raw
`mcpToolName` values. `'*'` is rejected. Missing/empty `tools` requires at least
one offered tool and returns one witness tool. Missing/empty `skills` or
`mcpServers` selects none; both absent may still initialize a null table.

Result:

```ts
{ sessionId: string; ok: boolean; skills: Array<{ name: string; effect: 'not_attempted' | 'unchanged' | 'enabled' | 'unconfirmed'; enabled: boolean | null }>; mcpServers: Array<{ name: string; effect: 'not_attempted' | 'unchanged' | 'enabled' | 'unconfirmed'; enabled: boolean | null; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'stopped' | 'not_configured' | null; tools: string[] | null }>; tools: 'not_attempted' | 'unchanged' | 'initialized' | 'unconfirmed'; error?: string; }
```

The target must be loaded and idle. One lifecycle guard covers prechecks, native
mutations, initialization and readback while excluding prompt/reload/ordinary
resource modifications. Before mutation the host rechecks saved/applied roles and
assembly fingerprint; reload-needed, inconsistent or unknown assembly fails. It
enables only disabled selected resources, preserves unrelated temporary choices,
initializes tools once after a confirmed enable or null metadata, and does not
retry auth/connectors. `ok` requires requested skills enabled, requested MCP
connected with unfiltered offered tools, and initialized metadata. Partial and
unconfirmed receipts are module responsibilities.

All requested resources are verified from native lists before mutation; unknown,
duplicate or ambiguous identities/statuses fail first. MCP preparation continues
only for connected or clearly disabled servers; stopped, needs-auth, pending,
failed and not_configured servers are not restarted, authenticated or retried.
When metadata is null or any selected resource was confirmed enabled, the host
calls `initializeAndValidate()` once and reads back real
`tools.getCurrentMetadata()`; already enabled resources with non-null metadata do
not rebuild only because tools are empty/missing. `not_attempted` means no
mutation was attempted, `unchanged` confirmed already enabled, `enabled`
confirmed this call enabled it, and `unconfirmed` means attempted but not
confirmed. `enabled`/`status` keep last confirmed observations; null means
unknown. `tools:null` means unobserved, `[]` means observed but no matching
tools. `error` is capped at 2000 characters with explicit truncation; no retry,
rollback, receipt mirror or resource workflow is created.

#### Adding roles to existing sessions

`roles/add` appends selected roles only: it does not remove roles, change Task
responsibility, title, cwd or session ID, copy sessions, load, stop, close,
reload, resume, interrupt, prompt, initialize tools, or modify session-only
resource toggles. It is allowed while main turns, subagents, shells, queues, asks,
plans, elicitations or schedules exist; unloaded sessions stay unloaded. Native
lifecycle conflicts can reject it. Validation covers catalog IDs and the 64-role
post-merge limit; assembly/integrity/resource conflicts/readiness wait for
ordinary reload or cold load. Missing role resources fail loading explicitly; no
role-specific hot assembly or temporary-resource preservation layer is provided.

```ts
{ sessionId: string; status: 'saved' | 'unchanged' | 'uncertain'; roles: SessionRole[]; appliedRoles: SessionRole[]; loaded: boolean; rolesNeedReload: boolean; error?: string; recovery?: string; }
```

`roles` is saved selection; `appliedRoles` is current handle assembly. `saved`
means persisted, not applied or ready. `unchanged` does not load or repair.
`rolesNeedReload` is true only when a loaded session's saved/applied role ID sets
differ. Persistence uncertainty returns `uncertain` plus recovery when possible;
readback failure can throw `AggregateError` rather than returning a stale
snapshot. The result no longer has `applied`, `incomplete`, `phase` or embedded
`readiness`. Inspect `session/get` and, if needed, `roles/readiness` before
recovery.

## 5. HTTP, assets, events, and workers
<a id="http-assets-events"></a>
Current module HTTP entry points:
```text
GET /_modules
/_modules/<id>/<digest>/api/...
/_modules/assets/<id>/<digest>/<declared-path>
/_modules/workers/<id>/worker.js
```
`/_modules` returns successfully activated frontend modules, active state for all loaded
modules (`id`, `name`, `version`, `digest`, including backend-only modules), and errors.
This is a passive process inventory, not the installed or next-start selection.
`errors[].stage` is `activation` (not loaded) or `runtime` (lifecycle/background failures of a loaded module, such as `onReady`, event handlers or `context.report`); only the latest error per module and stage is kept. Module HTTP request failures (such as a 409 digest mismatch or a handler exception) are already returned to the caller, so they are only logged and not listed. Errors do not automatically mean a module stopped; actual runtime identity is in active/modules. API and asset URLs are digest-bound. Frontend entry/styles/assets must be declared roots. Old digest paths do
not fall back to newer packages.

Browser `context.request(path, init)` sends relative module API requests with host credentials and `x-cockpit-module-digest`. Mutating methods require the matching digest header. GET/HEAD may omit it for image/video-style fetches, but the URL still contains the digest; a wrong header is rejected. Digest binding is not
authentication; origin and auth remain host responsibilities.

Streaming uploads use declared stream bodies and accept only `application/octet-stream`, rejecting other types before parsing. JSON limits are not globally raised. If a module returns a Node `Readable`, the host owns response assignment, cancellation, and destruction, including streams returned after the client
disconnects. Module HTTP requests do not automatically become native busy work or graceful-shutdown blockers.

`context.invalidate()` sends `module/invalidated { moduleId }` on existing `/events` for active loaded modules. It is a hint to reread module state, not business data, native chat, persisted state, replay log, per-module SSE, or a graceful-shutdown condition. Consumers reconnect by reading current state.

`context.publish(payload)` sends `module/event { moduleId, payload }` on the same transport. The host binds `moduleId`, validates plain JSON data with finite dense structure up to 64 levels and 64 KiB, snapshots it immutably, and rejects invalid or oversized payloads instead of truncating or replacing them. Validation
codes are `MODULE_EVENT_INVALID` and `MODULE_EVENT_TOO_LARGE`; missing transport is `MODULE_EVENT_UNAVAILABLE`. Only active modules can publish. Web `context.onEvent(listener)` receives only that module's payloads; listeners are revoked on stop. The host does not interpret module schemas, unread state, file state,
push state, or per-message ACKs.

A module worker is served at a stable module-specific URL and same-directory scope with `Service-Worker-Allowed: ./`; it cannot control Chat or the root page. The host does not auto-register it, request notification permission, implement push/badges, or clean browser registrations/subscriptions after disable. Only the
currently loaded package that declares `worker` is served; each read verifies package size and digest and is not cached. The script receives `self.__cockpitModuleWorker` with `moduleId`, `digest`, and worker-relative `apiBase`; no module secret is included. Modules must bundle, register, unregister, and document
offline cleanup boundaries themselves.
<a id="frontend-registration"></a>
## 6. Frontend registration, state, and drafts
New frontend entries export `frontendApiVersion = 3` and `activate(context)`, with frontend context and return value requiring `apiVersion: 3`. This does not change manifest, backend context, or route API v1. The context supplies host React, `createPortal`, state, `components`, `apiBase`, public config, `request`, `signal`, `onInvalidate`, `onEvent`, optional
`worker`, and `report`. Modules must not create their own root or depend on private DOM/store. The host initializes frontend modules independently; timeout/error in one module does not block others, and late results cannot republish revoked contributions.

`context.uiVersion: 1` declares public semantic CSS and icon basics. `context.uiSurfaceVersion: 1` separately declares shared surface, heading, actions, badge, and modal CSS. Exact classes and patterns are maintained in the [module UI guide](module-ui-guide.md). `context.menuVersion: 1` separately declares menu
registration support. Consumers must check each capability they use; none is an alias for package version, Web API version, or old navigation APIs.

Module UI follows the interaction and structure rules in [development](development.md). These integration mechanisms are distinct:
| Mechanism | Responsibility |
| --- | --- |
| Menus | Declare actions and presentation for existing global/session menus. |
| Global components | Mount session-independent UI in the host React tree. |
| Pages | Register namespaced routes in the existing SPA; the host owns navigation and page lifetime. |
| Component middleware | Enhance real host components through props/children/ref. |
| State/service/draft | Own module business state, subscriptions, async actions, and draft schemas. |
| Markdown renderers | Replace parsed link/image rendering only. |
`context.createPortal(children, container)` is the host ReactDOM `createPortal`. It is not page registration or dialog management. Native dialogs may portal to `document.body`; modules must close/unmount on component unmount or scope revocation and must not mutate private host DOM.

`ModuleFrontend` fields: `apiVersion: 3`; optional `writes: ['text']`; optional `sends: ['draft']`; optional `menus`, `pages`, `globalComponents`, `components`, `markdown`; optional `dispose`. Text writes never grant send permission. Menus sort after native items. Markdown handles link/image only. State disposers are managed by the state system.

An entry without the version export is activated exactly once against the legacy
v2 context (`draftSubmissionVersion: 1`), without `components.get` or
`state.createDraft`. Its returned API version must match. Legacy composer and
schema contributions see only actual native-session drafts; message middleware
receives its original native identity only where that provenance exists.
Generic owners never fabricate a session to activate an old enhancement.
This is an activation/props adapter, not a second component library or a second
File/Speech activation. New consumers must explicitly check the v3 capabilities;
an SDK dependency alone does not establish host support.

<a id="module-pages"></a>
### Module pages and navigation

Web v3 provides the independent `context.pageVersion === 1` capability, advertised
as `page.v1` in the host deployment descriptor. Check it before using
`context.navigation` or returning `pages: readonly ModulePage[]`. Legacy v2
receives neither capability nor navigation and cannot register pages. Missing
support is an incompatibility, not permission to substitute a dialog or private
router.

A page is `{ id: string, component: React.ComponentType }`, with no host props.
Capture activation context and module services in the component closure. Page IDs
match `^[a-z][a-z0-9-]{0,63}$` and share the existing registration namespace with
services, schemas, menus, middleware, global components and Markdown renderers.
Malformed IDs, duplicates, arbitrary path declarations and invalid components
reject the entire activation with its existing rollback.

The host owns `/modules/:moduleId/:pageId` in the existing React Router tree.
Its built-in HTTP server serves the SPA for that exact path, with an optional
trailing slash, so direct URLs and refreshes work without a reverse proxy.
Unmatched module/API/asset paths are not a general SPA fallback.
Modules cannot claim a host path or access a private router/store. The public
navigation object has only:

| Method | Meaning |
| --- | --- |
| `path(pageId)` | Construct this module's namespaced URL from a valid page ID, including during activation. This does not establish page availability. |
| `navigate(pageId)` | Push this module's registered page through the host router after successful activation. Unknown pages or an absent router throw without navigating. |
| `home()` | Push the explicit host homepage `/`, never blind history-back to an external site. Requires successful activation and a connected host router. |

All methods reject after activation revocation. Do not use `window.location`,
another React root/router, hidden Chat, or a portal to simulate a page. A global
menu's `onSelect` can call `context.navigation.navigate('main')`; it does not need
a global component. Ordinary anchors can use `path` for direct URLs, while
`navigate` keeps interactive navigation inside the SPA.

Only the current page mounts, after successful activation. Direct URL entry and
refresh wait for asynchronous activation; the existing router owns history,
back and forward. The host gives the page a viewport-bounded flex column; the
module owns its layout and reading scroll area, not the root container or private
host CSS. A module route replaces the current workspace/Chat, releasing
visible session ownership and unmounting its editor, not covering it with an
overlay. Leaving the route unmounts the page but does not revoke its module,
dispose its services, clear an owner draft or cancel an already accepted write.
Keep durable business state in module services/owner drafts, not only page state.
Existing `globalComponents` retain their original navigation-independent lifetime.

Unknown, unavailable or failed pages provide an explicit homepage link and page
reload recovery; loading and lazy rendering have a local loading state. There is
no automatic retry or recreation of a failed module. Render, effect and cleanup
failures use the existing module error boundary and revoke only their owning
activation. Empty boundaries remain briefly after navigation or revocation so
cleanup failures cannot escape to the host or revoke a replacement activation.
Module stop/revocation unmounts pages; a later activation has a fresh React
lifetime even for the same digest. As with global components, services can already
be revoked during React cleanup; event handlers and asynchronous actions remain
the module's responsibility.

<a id="global-components"></a>
### Session-independent global components

Check `context.globalComponentVersion === 1` before registering
`globalComponents: readonly ModuleGlobalComponent[]`. Older hosts omit this
capability; reject them explicitly rather than creating another React root.
`ModuleGlobalComponent` is `{ readonly id: string; readonly component: React.ComponentType }`.
There are no host props, session target, route, dialog shell or extra permissions.
Capture the activation context and module-owned services in the component closure.
Use `context.react` for hooks/elements and `context.createPortal` for portals.

After the entire activation validates, the host mounts each component once per
activation lifetime outside its route switch, with no DOM wrapper. Modules sort
by ID; each module's components retain declaration order. The empty homepage,
menu open/close, session changes and management routes do not remount them.
Modules without the declaration gain no new UI. IDs share the existing module
registration namespace. Malformed/duplicate declarations fail activation
atomically, including registered-service cleanup.

React render/lifecycle errors revoke all contributions of the owning module,
report through the existing error owner and preserve the host and healthy peers.
Pending lazy components have local null Suspense fallbacks; rejected loads follow
the same module error path. During revocation, the host retains empty error
boundaries through layout/passive cleanup before discarding them, so cleanup
failures remain with the retiring activation and cannot revoke its replacement.
They do not automatically retry. Module revocation/runtime stop unmounts the
components and their portals; a later successful activation creates fresh React
state even for the same module digest. Services are disposed during revocation
before React finishes unmounting: cleanup must release resources without using
revoked handles or assuming live services. Event/async errors remain the module
action's responsibility; `context.report` reports but does not itself revoke.

The module owns `showModal()`, `close()`, state, CSS sizing, aborts and cleanup.
A global menu action can update a module-owned external store; a mounted
component observes it and opens its native dialog in a layout effect after the
menu selection handler has closed the menu and restored trigger focus. Do not
open synchronously in `onSelect` and then fight menu focus restoration, insert a
hidden menu icon renderer, scan host DOM or add a second React root.
See the runnable [global dialog example](../apps/web/src/dev/module-global-example.ts)
and its [module-local styles](../apps/web/src/dev/module-global-example.scss).

### 6.1 State and draft extension
`context.state.register({ id, create, dispose })` synchronously creates one module service during activation and returns a typed handle. `handle.get()` returns the instance and fails after revocation. Services may reuse stores or own keyed stores; snapshots, selectors, subscriptions, HTTP actions, and retries are
module responsibilities. `create` must not return a Promise.

`context.state.host` exposes only `sessionId`, `visible`, and `connected`. `context.state.chatWindow` is the separate current-window reader. `onInvalidate` and `onEvent` are module-scoped signals and cannot be injected into native stores. Module projections may extend views but must not overwrite native authority or
turn unloaded/read failures into false/zero facts.

Base draft state contains text, revision, pending, unconfirmed, blocks,
`hasContent`, `retired`, owner facts (`editable`, `submittable`,
`capabilities.attachments`, `actionRevision`), optional `submissionId`,
`askContext`, and `referenceText`. `DraftReference` identifies a host-issued
runtime lifetime with `id` and `purpose` (`prompt`, `ask`, `plan`, or
`elicitation`). Only the native compatibility adapter adds a real `sessionId`.
`bindDraft(reference)` exposes text edit, guarded completion, block leases, and
independently authorized captured send; never owner routing, reset, ACK or
arbitrary payload submission. An unavailable owner cannot be enabled by changing
presentation props. Reference text is a copied, read-only last 1,000 Unicode code
points of owner-supplied already-visible context, not a history/network reader.

`askContext?: { question: string; choices?: readonly string[] }` is a read-only, deep-frozen copy for the exact live ask draft when an authoritative current ask request with a question exists. It is undefined for prompt/plan/elicitation, ended/replaced asks, retired sessions, unloaded state, or unconfirmed connection.
No choices and empty choices are distinct. It is not persisted, restored, or a reply capability. Modules should capture it synchronously at operation start.

`registerDraft` adds a module schema with `id`, applicable `purposes`, `create`, `validate`, `hasContent`, `project`, `acknowledge`, and optional `persistence`. `forDraft(reference)` returns a stable field scope or `undefined` if purpose does not apply. The scope exposes immutable snapshot, subscription, and validated
updates only for that schema. Projection adds explicit content fields, not the
whole schema store. Core and business-control keys (`sessionId`, `text`, `mode`,
`requestId`, `answer`, `message`, `wasFreeform`, `action`, `target`, `request`,
`decision`, `topic`, `topicId`, `reply`, `replyTo`, `actionRevision`,
`submissionId`) are reserved. Cross-schema collisions and unknown adapter fields
are errors; adapters must strictly validate and never silently strip fields.

Unregistered serialized namespaces and legacy records remain opaque. They do not count as current content, render fallback UI, or get cleared by core. Unclaimed persisted data blocks native draft submission, including decision actions, with an explicit error rather than silently sending only the recognized fields.
Matching loaded schemas own restoration and migration; namespace ownership is rechecked before dispatch. Core does not enable missing modules or retry the submission automatically. Modules own restore, migration, tombstones after ACK, upload/file resources, and schema-specific persistence conflict checks.

<a id="draft-owners"></a>
#### Generic owners and durable submission

Check `draftOwnerVersion === 1`. In a service lifecycle, call
`state.createDraft<Request, Receipt>({key, purpose, facts, prepare,
validateRequest, validateReceipt, send, inspect, settle?})`. Do not create owners
in render. Active keys reuse one owner in the module namespace; use
`owner.update(facts)` for changing availability/target checkpoints, not new
closures. The owner exposes `reference`, `editText`, `update`, `submit`,
`reconcile(submissionId)` and `retire`. Module stop revokes runtime authority
without destroying the logical occurrence; explicit retirement permanently
ends it and preserves its evidence separately before same-key recreation.
Closing a dialog is neither module stop nor retirement.

`prepare` synchronously validates projected fields and captures the complete
immutable business request, stable request ID and action revision. `send` is the
only initial transport; `inspect` is an explicit query of that exact saved
request. Both return `accepted` with a receipt, `rejected` with a reason, or
`unknown` with a reason. Inspect must prove the entire request/content identity,
not merely find an ID or treat one 404 as safe to resend. `validateRequest` and
`validateReceipt` strictly validate stored JSON data without changing or dropping
fields. Synchronous, idempotent `settle` handles only business state captured in
the request (for example clearing a still-matching reply/action revision), never
network I/O or text/field ACK.

Before send, one storage write contains the logical occurrence, submission ID,
immutable request, captured text/revision/actionRevision, participating schema
encodings and settlement checkpoints. Missing storage, encoding or storage
failure prevents dispatch. Generic projected schemas require persistence.
Text/schema/target changes during prepare or pending publication invalidate that
capture. Button submission and `captureSend` use this same transaction.

Owner requests and receipts are not enhancer state. Generic schema restoration
receives only its encoded namespace plus legacy extension data; `legacyRecord`
does not expose the host-private transaction journal or business routing.
This read projection never removes unknown stored fields.

Accepted transport is persisted before settlement. Each schema ACK and its
encoded new state are stored with that field's checkpoint; text and owner
settlement have independent checkpoints. New text/fields/actions survive old
ACKs. A failed ACK remains `unconfirmed/settlement-failed`, never a reason to
resend an accepted request. Schema `acknowledge` must compare persistent item
identity/version, not JavaScript object identity; it must be idempotent.

Reload creates and persists a new runtime reference/generation claim, fencing
old callbacks even before the restored user edits anything. It restores unresolved transactions as unknown and sends/inspects
nothing automatically. `reconcile` validates the original request, explicitly
inspects it, and grants new settlement authority only for its same live logical
occurrence. Each participating schema restores its captured encoding through
its current validator, with an exact serialization round trip, before a new ACK
closure is created. Missing/incompatible schemas, retired occurrences, changed
storage and unproven receipts retain data and report uncertainty. Native Chat
keeps its existing storage keys and decision lifetimes. Its explicit local
reconciliation can finish an already-persisted native acceptance receipt, but
cannot invent acceptance for an unknown native request or resend it.
Legacy v2 schema callbacks did not promise persistent item identity and therefore
cannot receive reconstructed captured ACK objects; their live in-flight ACK
behavior is unchanged. Restored field settlement requires a compatible v3 schema.

Minimal text-owner adapter shape (business callbacks are supplied by the caller;
they must durably accept/query the exact request, not a current target):

```ts
import type {
  DraftOwnerOptions, DraftTransportOutcome, ModuleFrontendContext,
} from '@waksana/cockpit-module-sdk/frontend';

type Request = { requestId: string; text: string; actionRevision: number };
type Receipt = { requestId: string };
export const frontendApiVersion = 3;

export function createTextOwner(
  context: ModuleFrontendContext,
  business: Pick<DraftOwnerOptions<Request, Receipt>,
    'validateRequest' | 'validateReceipt' | 'send' | 'inspect' | 'settle'>,
) {
  if (context.apiVersion !== 3 || context.draftOwnerVersion !== 1
    || context.publicComponentsVersion !== 1) throw new Error('Web v3 is required');
  const checkReceipt = async (
    request: Request, invoke: typeof business.send,
  ): Promise<DraftTransportOutcome<Receipt>> => {
    const outcome = await invoke(request);
    if (outcome.status === 'accepted'
      && business.validateReceipt(outcome.receipt).requestId !== request.requestId) {
      throw new Error('Receipt does not identify this request');
    }
    return outcome;
  };
  return context.state.createDraft<Request, Receipt>({
    ...business, key: 'input', purpose: { kind: 'prompt' },
    facts: { editable: true, submittable: true, actionRevision: 0,
      capabilities: { attachments: false } },
    prepare(snapshot) {
      if (Object.keys(snapshot.fields).length) throw new Error('Text only');
      return { requestId: snapshot.id, text: snapshot.text,
        actionRevision: snapshot.base.actionRevision };
    },
    send: request => checkReceipt(request, business.send),
    inspect: request => checkReceipt(request, business.inspect),
  });
}
```

Use `context.components.get('composer')` with the owner's reference, ordinary
presentation props, `onTextChange: owner.editText`, and an `onSubmit` callback
that handles `owner.submit()`'s result. Enhancements bind the reference rather
than seeing `business`, the request, a topic or a final native session.
<a id="chat-window-state"></a>
#### Current-window read-only data
Use only after checking `context.chatWindowVersion === 1`. Read through `context.state.chatWindow.getSnapshot()` and `subscribe(listener)`. There is no session parameter, history loading, pagination API, refresh action, write action, extra HTTP/SSE channel, or SDK read. Only the currently active session is visible;
session switches never reuse old messages under a new identity.

`ChatWindowSnapshot` contains `sessionId`, `status` (`unavailable`, `loading`, `ready`, `stale`, `error`), `hasMore`, `partial`, optional `error`, and root `messages`. `ready` is not proof of complete history. Empty ready windows, unavailable/stale/error, and partial windows are distinct.
The current observer has a [reconnection freshness gap](architecture.md#implementation-gaps); `ready` alone does not establish that the current connection has received its session snapshot. This limitation does not grant modules access to private stores or extra native reads.

Each `ChatWindowMessage` projects only `id`, `origin`, `role`, `text`, `complete`, optional `subtype`, and ordered `children`. `id` is presentation identity; `origin` is native session/message/agent attribution or null. Unknown origin is not guessed from DOM order, timestamp, or message ID shape. `complete` does not
turn streaming or known-incomplete content into final content. `text` is existing message content only; thoughts, tool calls, attachments, private store, native session handles, and structured question bodies are not exported. Snapshots are frozen, stable by reference when unchanged, and subscriptions are revoked with
the module scope.
### 6.2 Component middleware
Boundaries are: `message`, `sessionStatus`, `composer`, `composerEditor`, `composerInput`, `button`, `attachment`, `managementHeader`, `managementDetailHeader`, and `settings`. They correspond to real existing host components: visible message body/current ask question; concurrent session activity summary; actual composer card; input row;
controlled textarea; historical attachment row; management headers; and shared preference content.

Middleware sorts by `(order ?? 0, moduleId, id)` with lower values outermost. The host composes only on registration/base changes, not every render. Enhancers must preserve inherited props, children, refs, actions, native identity, scroll and a11y anchors, and layout semantics. Composition and error boundaries add no
HTML. Empty production boundaries, fake slots, hidden dispatchers, or components that only return children are not allowed.

`components.get(name)` returns a stable typed proxy per runtime/name. Host and
module consumers use the same centrally defined bases and sorted enhancement
chain, including Composer's editor, input and button. Lookup never fetches,
activates a service or creates another React root. A base obtains semantic child
components through the same lookup; middleware calls its received `Base`, never
recursively looks up its own boundary. Unrelated rerenders do not call `wrap`.
An actual chain change can still remount its affected subtree; durable draft and
upload/recording state belongs in controllers/services, not middleware hooks.

Message display identity belongs to its owner/local ID; optional `origin`
identifies a real native source. `decisionOrigin` separately carries a real
native pending question's session and request ID, not a message origin.
Do not pass publication IDs as native message
IDs, attribute a multisource summary to one message, or fabricate a native
session for a generic message. Native-dependent legacy middleware is skipped
where actual native attribution is absent; attachments still use their own
descriptors and the same public attachment component.

`composerInput` requires `context.composerInputVersion === 1`. The `Base` is the controlled textarea and continues to own value, IME, Enter/Ctrl/Meta+Enter, and native `onKeyDown` behavior. Enhancers pass through value/onChange/native props, compose `editorRef` including callback cleanup, avoid private DOM queries, and
may render siblings such as a microphone after `Base`. Full-width status panels belong around the existing composer, not inside the input row.

`disabled` is native edit disabled; `sendBlocked`, pending, and draft blocks gate submit but should not disable an otherwise editable textarea. `sendBlocked` is the owner's gate, not empty-content or a module's own recording block. Choice-only asks and elicitation expose no editable text route; their native choice controls remain usable. Async input must capture exact draft id/revision/lease and never write a reused
request ID or new lifecycle. Background completion uses `editTextIfRevision(text, revision)`: it returns `false` without mutation on revision mismatch, pending/unconfirmed send, or any remaining block; throws on retirement, revocation, missing text permission, or persistence failure; `true` means text was synchronously
persisted and a new revision published.

Draft lifetimes are not component lifetimes. Session switch, hidden page, disconnect, unload, or temporary ask overlay does not retire the prompt. Decision end/replacement retires that decision snapshot permanently. Authoritative session deletion retires prompt and decisions. Late ACKs for retired prompts do not write
storage for a future same session ID. Modules release resources on retirement; temporary invisibility is not destruction.
#### One-time captured draft submission
Use only after checking `context.draftSubmissionVersion === 2` and declaring `sends: ['draft']` (legacy native-only v2 keeps version 1). Capture `draft.captureSend()` at explicit user send consent, not after asynchronous work. The captured intent has no session ID, request ID, attachments, or arbitrary payload parameter. Text write permission and send
permission are independent.

A module may stream text with its own `editText`, then release its own block, write final text with `editTextIfRevision`, and call `intent.send(expectedRevision)`. Any other writer's text change, schema addition/removal/update, or schema generation change since capture invalidates consent, including ABA changes; pure
release of this module's block and this module's expected streaming writes do not.
Owner actionRevision changes also invalidate consent. The host checks again at final dispatch.

The first `send()` consumes the intent even if blocked; later calls return the same promise/result. `cancel()` works only before dispatch. Results are `acknowledged`, `blocked` with a safe code (`revoked`, `retired`, `cancelled`, `revision-mismatch`, `draft-changed`, `pending`, `unconfirmed`, `peer-blocked`, `empty`,
`unavailable`, `read-only`, `decision-changed`, `unsupported`, `persistence-failed`,
`projection-failed`), `rejected` with an explicit business rejection, or
`unconfirmed` with `transport-unconfirmed`/`native-unconfirmed`/`settlement-failed`.
Acknowledged means business acceptance plus complete local settlement, not model
execution or reading. Blocked guarantees no dispatch; rejection does not make
that claim. Unconfirmed may have sent and must not be retried automatically or
replaced with fresh consent.

Dispatch uses the existing `SessionDraft` projection, native route construction, pending token, and schema ACK transaction. Prompt sends to the original session's prompt/enqueue route even if an ask later appears. Ask sends only to the original live free-text ask with `wasFreeform: true`; plan sends feedback;
elicitation has no text route. Retired decisions never turn into prompts. Module unload mid-send does not prove no send happened.

<a id="settings-content"></a>
#### Shared settings content

Check `context.settingsVersion === 1` before registering `boundary: 'settings'`.
Base is the host's actual default-model section; `SettingsProps` carries its DOM
props and content. Append module sections as siblings through
`<><Base {...props} /><ModulePreferences /></>`, preserving Base, props and children.
Do not insert module sections into `Base.children`: that places them inside another
module's error boundary and can blame a healthy peer for a crash.
This is existing component middleware, not
a separate menu, page, configuration registry or empty placeholder.

The host puts About after the composed preferences and owns the dialog, focus,
close action, the outer section spacing and single scroll area. Module sections use semantic
headings and public UI classes, without a second dialog, scroller or host-style
copy. Each module owns settings reads, storage, permissions, mutation results and
subscriptions; there is no host-wide module-settings save. Do not infer a session
target from the current chat or import private stores. Unmount releases UI
subscriptions, not an already-accepted operation; late errors retain an owner.

### 6.3 File-style draft input
The host stores ordinary prompt drafts per session and separate drafts for each native ask/plan/elicitation request. Decision drafts are selected by kind and request ID, not by clearing/copying the prompt. When a request ends, the prompt returns; replacement requests get new lifetimes; failed/unknown answers retain
their own input.

File schema is a prompt-only module schema. The file module renders complete ready/uploading lists as `composerEditor` children above the input row. Switching to an answer draft naturally hides prompt files; no core attachment hidden flag, warning, generated group, `onFiles`, picker transaction, file callback table, or
receive-files dispatcher exists. File modules capture the stable prompt draft when opening a picker; late results cannot retarget the current session or answer draft. Core handles text and native gates; modules own upload limits, order, server originals, persistence, and cleanup.
### 6.4 Markdown and lifecycle
Markdown rendering receives parsed link/image nodes with original unnormalized target, label, and message origin. It does not reparse full Markdown or receive native/draft attachments. No match keeps safe fallback. Multiple exclusive matches, predicate errors, or render errors report and fall back; download order does
not decide. Replacements must remain inline phrasing content; dialogs portal to body. Native history attachments use `attachment` middleware and `NativeAttachmentDescriptor`, preserving omitted blob reasons and basic fallback.

All module-local IDs across state services, draft schemas, components, global components, menus, and Markdown must be unique. The host stages activation and publishes only after full validation. On stop it revokes draft bindings, schemas, live fields, projections, and blockers; runs state disposers once in reverse registration order;
reports cleanup errors without blocking other disposers; then publishes final state. State scope is not component mount scope: switching sessions does not cancel an upload owned by an old prompt. Page cleanup is not push unsubscribe or backend shutdown.
### 6.5 Menu registration
`ModuleMenuRegistration`:
```ts
interface ModuleMenuRegistration {
  id: string;
  menu: 'global' | 'session';
  order?: number;
  getState(target: { menu: 'global' } | { menu: 'session'; sessionId: string }): ModuleMenuState;
  subscribe?(listener: () => void): () => void;
  onSelect(target: { menu: 'global' } | { menu: 'session'; sessionId: string }, context: { signal: AbortSignal }): void | Promise<void>;
}
interface ModuleMenuState {
  label: string;
  icon?: React.ReactNode;
  visible?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}
```
`order` must be finite and defaults to 0. Native menu items remain first; module items sort by `(order ?? 0, moduleId, id)`. The host normalizes separators and removes leading/trailing/consecutive separators. Modules cannot replace, reorder, or swallow native items.

Targets are frozen discriminated unions. State and actions use the captured target, never current navigation. Session actions require an up-to-date frontend snapshot, open connection, and target session present in that snapshot; unavailable or unknown targets are rejected without extra loading or metadata guesses. This
is lifecycle protection, not backend authorization.

`getState` is synchronous and side-effect-free. Network requests and mutations belong in module services/actions. `subscribe` belongs to module activation scope, not each menu open. Bad state omits that command and reports the error while keeping other contributions. Icon render failure drops only the icon. `icon` is
decorative, not nested interaction. On click the host rechecks target and latest visible/disabled state. `onSelect` gets an `AbortSignal`; host prevents duplicate concurrent execution per registration/target, aborts stale actions on module stop, target loss, or unknown connection, and releases its tracking immediately
on abort. Late results cannot republish revoked contributions. Return values do not mutate host state.
<a id="native-observation"></a>
## 7. Native observation and shutdown
Native notifications are exposed through `Engine.onNativeEvent` with declared type filters. Events with no interested observer are not additionally traversed. Workspace/cwd context follows verified root context changes; no per-event metadata RPC is added. Observation return values never replace native events, and
handler errors do not pollute native control state.

`controlEvents` receives filtered `ServerEvent` copies for existing control facts such as ask changes, session deletion, and history invalidation. It does not fetch extra snapshots or load sessions. Subscriptions and invalidation are revoked with module scope; side effects and persistence are module work.

`NativeObservation` is frozen and read-only. `cwd` and optional `workspacePath?: string | null` are independent. `workspacePath` is read from the SDK `CopilotSession.workspacePath`: a string is the native absolute workspace path, `null` means a handle exists but the SDK has no workspace, and omission means unknown (for
example early creation/resume before the handle is available). Invalid paths or getter errors are reported as observation failures and delivered with the field omitted; the host does not fall back to `cwd`, cache, infer, load other sessions, add RPCs, or parse files.

Observation covers existing SDK notifications for loaded sessions. It is not a background event-log reader. Native messages, context, queues, and configuration remain authoritative in Copilot. Graceful shutdown waits only for native work and necessary native in-flight operations. On shutdown, the host revokes module
scope, subscriptions, and streams; it does not wait for module business queues or close acknowledgements. Modules must persist during normal operation, not rely on exit callbacks.
<a id="future-work"></a>
## 8. Future work
The module model remains trusted main-process import with cold loading. Hot-load, hot-unload, hot-restart, and hot-update are not goals and should not be simulated through hidden prompts, private stores, or unknown API fields.

Planned but not implemented:

- Remote HTTPS signed release descriptors, publisher trust, and update selection;
  no code executes before verification.
- Pure content packages without a backend and next-start message modules; roles
  still ship with executable module packages.
- Read-only system pages for version/module status and safe shutdown boundaries as
  scoped in [R6](product-requirements.md), without replacing the module CLI.

Existing menu declarations are not arbitrary page/router registration. Scope is limited by this contract, the [module catalog](modules.md), and explicit product decisions.
