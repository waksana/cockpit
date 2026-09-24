# Module contract
This document defines the current Cockpit module host contract. Version numbers in this file are API capability versions, not release pairings: manifest/backend API v1, Web API v2, public UI v1, `menuVersion: 1`, `uiSurfaceVersion: 1`, `chatWindowVersion: 1`, `composerInputVersion: 1`, `draftLifecycleVersion: 1`,
`draftSubmissionVersion: 1`, and `context.serviceReadyVersion: 1`. Host/module release pairings belong in the [module catalog](modules.md) and GitHub Releases.

Product boundaries are in [R1-R8](product-requirements.md). Business contracts for individual modules, such as File or Notification, stay in their own repositories; this document only defines host/module integration.

## 1. Supported scope
The host verifies trusted local `.tgz` packages into immutable install directories, imports built backend JavaScript in the main Node process, serves digest-bound module API/assets, and lets same-package ESM/CSS reuse host React, theme, state and public component boundaries without creating another SPA root. Loaded
modules may observe declared native SDK projections for loaded sessions, declare global/session menus, wrap real semantic components, register module state/services and draft schemas, and render parsed Markdown link/image nodes. The host owns base prompt/decision draft state and native send/ACK; modules extend drafts
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
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/module-cli.ts ...
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
The source of truth is [`packages/module-api/src/index.ts`](../packages/module-api/src/index.ts) for backend/manifest types and [`frontend.ts`](../packages/module-api/src/frontend.ts) for Web API v2. Modules should build against exported public types instead of copying declarations:
```sh
node scripts/export-module-api.mjs /absolute/new/sdk-directory
```
The export contains `module-api` and its protocol dependency; it does not contain SDK credentials, native data, or a second runtime authority.

Backend packages export `activate(context)` and return `ModuleBackend`:
| Field | Contract |
| --- | --- |
| `context` | `apiVersion: 1`, `serviceReadyVersion: 1`, `moduleId`, `dataRoot`, `apiBase`, read-only `config`, `signal`, `report`, `invalidate`, `publish`, and `host.call`. |
| `routes` | Validated `method`/`path` plus optional JSON or stream body and `bodyLimit`; handlers receive params/query/headers/body/signal and return status/headers/body or a stream. |
| `publicConfig` | Explicit browser-readable config only; the host never exposes all `config` by default. |
| `events` | Declared native event type filters and read-only handlers. |
| `controlEvents` | Declared `ServerEvent` type filters for existing native control projections; no extra native reads. |
| `onReady` | Optional service-ready callback; requires `context.serviceReadyVersion === 1`. |
| `dispose` | Non-blocking cleanup; it is not part of the host graceful-shutdown wait chain. |
A module never receives the root Fastify instance, Engine internals, native session handles, or a security sandbox. Routes are validated before registration; failure or timeout is attributed to the module. Same-process modules can still block synchronously, exhaust memory, or call process-level APIs.

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
| Frontend runtime | `apiVersion: 2`, `menuVersion: 1`, `moduleId`, host `react`, `createPortal`, `signal`, `report` | Same module activation; no private DOM/store or separate React root. |
| UI capability | `uiVersion: 1`, `uiSurfaceVersion: 1` | Separate checks for public CSS classes/surfaces; not React/runtime or modal behavior. |
| Frontend HTTP/config | `apiBase`, public `config`, `request(path, init)` | Authenticated, digest-bound requests scoped to this module API. |
| Events | `onInvalidate(listener)`, `onEvent(listener)` | Same `/events` transport, scoped to this module; no replay or native chat subscription. |
| Host state | `context.state.host.getSnapshot()/subscribe()` | Only `sessionId`, `visible`, and `connected`. |
| Current chat window | `chatWindowVersion: 1`, `context.state.chatWindow` | Read-only loaded-window text projection; no history loading or write actions. |
| Module service | `context.state.register({ id, create, dispose })` | Synchronous service creation; queries/actions are module-defined. |
| Base draft | `context.state.bindDraft(reference)` | Stable draft lifecycle with text editing, blocks, guarded completion, and captured send only if declared. |
| Draft lifecycle | `draftLifecycleVersion: 1`, `editTextIfRevision`, `retired` | Atomic revision-guarded background completion and permanent retirement. |
| Captured send | `draftSubmissionVersion: 1`, `sends: ['draft']`, `captureSend().send(expectedRevision)` | One explicit user-consent checkpoint; no caller-selected target or payload. |
| Draft schema | `context.state.registerDraft(...)` | Module owns validation, content test, projection, ACK, and optional persistence for its field only. |
| Menus | `menus`, `getState`, optional `subscribe`, `onSelect` | Global/session commands; native items remain first; no page/router registration. |
| Components | `components`, `wrap(Base)` | Middleware around real public components; preserve props, children, refs, identity, and accessibility. |
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
| Rendered message | `MessageProps.identity/complete/bodyRef/children/adornment` | No raw transcript string or global ordering; DOM order is not a latest-reply API. |
| Markdown reference or attachment | `MarkdownNode` or `AttachmentProps` | No complete file library or automatic resource loading. |
| Backend native output/control fact | `events` `NativeObservation`, `controlEvents` `ServerEvent` | Not the browser's loaded window and not automatically forwarded to frontend. |
The host provides current-window reading, not speech context or `getLatestReply()`. Current ask question/choices are exposed only through the matching draft's `askContext`. Modules must not use window reading to import private stores, query private DOM, read native home directories, or scan all history. A module may
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
| `session/new { cwd, roles? }` | Creates one native session; result `{ sessionId }`. |
| `roles/readiness { sessionId, roles? }` | Passive readiness: `sessionId`, `loaded`, `ready`, `roles`, `reasons`, optional `appliedRoles`, `rolesNeedReload`. |
| `session/tools-initialize { sessionId }` | Initializes native tool table on a loaded idle session; `{ ok: true }`. |
| `session/resources-prepare { sessionId, skills?, mcpServers? }` | Narrow resource preparation; see below. |
| `roles/add { sessionId, roles }` | Saves roles for a future reload/cold load; see below. |

`context.host.call(name, body)` is limited to `session/new`, `session/get`,
`session/rename`, `roles/readiness`, `session/resources-prepare`, and `prompt`,
with `@cockpit/protocol` validation and shutdown admission. It exposes no Engine,
SDK objects, persistent stores, `session/tools-initialize`, resource toggles or
arbitrary intent passthrough. Creation failure may include a confirmed
`sessionId`; inspect before retrying and never blindly recreate.

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
may include `modules: ModuleSource[]` only after verifying manifests by origin,
digest, endpoint or real `SKILL.md` path/SHA-256. Unknown resources stay unlabeled.
`mcp/global.connection.method` is `http`, `sse`, `stdio` or `unknown`; `target` is
only hostname or executable basename. `mcp/session` has no `connection` field.

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
`/_modules` returns successfully activated frontend modules, backend-only active state, and errors. `errors[].stage` is `activation` (not loaded) or `runtime` (lifecycle/background failures of a loaded module, such as `onReady`, event handlers or `context.report`); only the latest error per module and stage is kept. Module HTTP request failures (such as a 409 digest mismatch or a handler exception) are already returned to the caller, so they are only logged and not listed. Errors do not automatically mean a module stopped; actual runtime identity is in active/modules. API and asset URLs are digest-bound. Frontend entry/styles/assets must be declared roots. Old digest paths do
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
Frontend entry also exports `activate(context)`, with frontend context and return value requiring `apiVersion: 2`. This does not change manifest, backend context, or route API v1. The context supplies host React, `createPortal`, state, `apiBase`, public config, `request`, `signal`, `onInvalidate`, `onEvent`, optional
`worker`, and `report`. Modules must not create their own root or depend on private DOM/store. The host initializes frontend modules independently; timeout/error in one module does not block others, and late results cannot republish revoked contributions.

`context.uiVersion: 1` declares public semantic CSS and icon basics. `context.uiSurfaceVersion: 1` separately declares shared surface, heading, actions, badge, and modal CSS. Exact classes and patterns are maintained in the [module UI guide](module-ui-guide.md). `context.menuVersion: 1` separately declares menu
registration support. Consumers must check each capability they use; none is an alias for package version, Web API version, or old navigation APIs.

Module UI follows the interaction and structure rules in [development](development.md). Four integration mechanisms are distinct:
| Mechanism | Responsibility |
| --- | --- |
| Menus | Declare actions and presentation for existing global/session menus. |
| Component middleware | Enhance real host components through props/children/ref. |
| State/service/draft | Own module business state, subscriptions, async actions, and draft schemas. |
| Markdown renderers | Replace parsed link/image rendering only. |
`context.createPortal(children, container)` is the host ReactDOM `createPortal`. It is not page registration or dialog management. Native dialogs may portal to `document.body`; modules must close/unmount on component unmount or scope revocation and must not mutate private host DOM.

`ModuleFrontend` fields: `apiVersion: 2`; optional `writes: ['text']`; optional `sends: ['draft']`; optional `menus`, `components`, `markdown`; optional `dispose`. Text writes never grant send permission. Menus sort after native items. Markdown handles link/image only. State disposers are managed by the state system.
### 6.1 State and draft extension
`context.state.register({ id, create, dispose })` synchronously creates one module service during activation and returns a typed handle. `handle.get()` returns the instance and fails after revocation. Services may reuse stores or own keyed stores; snapshots, selectors, subscriptions, HTTP actions, and retries are
module responsibilities. `create` must not return a Promise.

`context.state.host` exposes only `sessionId`, `visible`, and `connected`. `context.state.chatWindow` is the separate current-window reader. `onInvalidate` and `onEvent` are module-scoped signals and cannot be injected into native stores. Module projections may extend views but must not overwrite native authority or
turn unloaded/read failures into false/zero facts.

Base draft state contains text, revision, pending, unconfirmed, blocks, `hasContent`, `retired`, and optional `askContext`. `DraftReference` identifies a stable lifetime with `id`, `sessionId`, and `purpose` (`prompt`, `ask`, `plan`, or `elicitation`). `bindDraft(reference)` exposes text edit, guarded completion, block
leases, and optional captured send; it does not expose private stores, attachments, arbitrary native patches, reset, ACK, or generic submit.

`askContext?: { question: string; choices?: readonly string[] }` is a read-only, deep-frozen copy for the exact live ask draft when an authoritative current ask request with a question exists. It is undefined for prompt/plan/elicitation, ended/replaced asks, retired sessions, unloaded state, or unconfirmed connection.
No choices and empty choices are distinct. It is not persisted, restored, or a reply capability. Modules should capture it synchronously at operation start.

`registerDraft` adds a module schema with `id`, applicable `purposes`, `create`, `validate`, `hasContent`, `project`, `acknowledge`, and optional `persistence`. `forDraft(reference)` returns a stable field scope or `undefined` if purpose does not apply. The scope exposes immutable snapshot, subscription, and validated
updates only for that schema. Projection adds explicit fields to existing native routes; core fields such as `sessionId`, `text`, `mode`, `requestId`, `answer`, `message`, `wasFreeform`, and `action` are reserved. Unknown native route fields and cross-schema collisions are errors.

Unregistered serialized namespaces and legacy records remain opaque. They do not count as current content, render fallback UI, block sends, or get cleared by core. Modules own restore, migration, tombstones after ACK, upload/file resources, and schema-specific persistence conflict checks.
<a id="chat-window-state"></a>
#### Current-window read-only data
Use only after checking `context.chatWindowVersion === 1`. Read through `context.state.chatWindow.getSnapshot()` and `subscribe(listener)`. There is no session parameter, history loading, pagination API, refresh action, write action, extra HTTP/SSE channel, or SDK read. Only the currently active session is visible;
session switches never reuse old messages under a new identity.

`ChatWindowSnapshot` contains `sessionId`, `status` (`unavailable`, `loading`, `ready`, `stale`, `error`), `hasMore`, `partial`, optional `error`, and root `messages`. `ready` is not proof of complete history. Empty ready windows, unavailable/stale/error, and partial windows are distinct.

Each `ChatWindowMessage` projects only `id`, `origin`, `role`, `text`, `complete`, optional `subtype`, and ordered `children`. `id` is presentation identity; `origin` is native session/message/agent attribution or null. Unknown origin is not guessed from DOM order, timestamp, or message ID shape. `complete` does not
turn streaming or known-incomplete content into final content. `text` is existing message content only; thoughts, tool calls, attachments, private store, native session handles, and structured question bodies are not exported. Snapshots are frozen, stable by reference when unchanged, and subscriptions are revoked with
the module scope.
### 6.2 Component middleware
Boundaries are: `message`, `sessionStatus`, `composer`, `composerEditor`, `composerInput`, `attachment`, `managementHeader`, and `managementDetailHeader`. They correspond to real existing host components: visible message body/current ask question; concurrent session activity summary; actual composer card; input row;
controlled textarea; historical attachment row; and management headers.

Middleware sorts by `(order ?? 0, moduleId, id)` with lower values outermost. The host composes only on registration/base changes, not every render. Enhancers must preserve inherited props, children, refs, actions, native identity, scroll and a11y anchors, and layout semantics. Composition and error boundaries add no
HTML. Empty production boundaries, fake slots, hidden dispatchers, or components that only return children are not allowed.

`composerInput` requires `context.composerInputVersion === 1`. The `Base` is the controlled textarea and continues to own value, IME, Enter/Ctrl/Meta+Enter, and native `onKeyDown` behavior. Enhancers pass through value/onChange/native props, compose `editorRef` including callback cleanup, avoid private DOM queries, and
may render siblings such as a microphone after `Base`. Full-width status panels belong around the existing composer, not inside the input row.

`disabled` is native edit disabled; `sendBlocked`, pending, and draft blocks gate submit but should not disable the textarea. Routes without free-text ask/elicited answers keep normal editing while module controls disable their own actions. Async input must capture exact draft id/revision/lease and never write a reused
request ID or new lifecycle. Background completion uses `editTextIfRevision(text, revision)`: it returns `false` without mutation on revision mismatch, pending/unconfirmed send, or any remaining block; throws on retirement, revocation, missing text permission, or persistence failure; `true` means text was synchronously
persisted and a new revision published.

Draft lifetimes are not component lifetimes. Session switch, hidden page, disconnect, unload, or temporary ask overlay does not retire the prompt. Decision end/replacement retires that decision snapshot permanently. Authoritative session deletion retires prompt and decisions. Late ACKs for retired prompts do not write
storage for a future same session ID. Modules release resources on retirement; temporary invisibility is not destruction.
#### One-time captured draft submission
Use only after checking `context.draftSubmissionVersion === 1` and declaring `sends: ['draft']`. Capture `draft.captureSend()` at explicit user send consent, not after asynchronous work. The captured intent has no session ID, request ID, attachments, or arbitrary payload parameter. Text write permission and send
permission are independent.

A module may stream text with its own `editText`, then release its own block, write final text with `editTextIfRevision`, and call `intent.send(expectedRevision)`. Any other writer's text change, schema addition/removal/update, or schema generation change since capture invalidates consent, including ABA changes; pure
release of this module's block and this module's expected streaming writes do not. The host checks again at final dispatch.

The first `send()` consumes the intent even if blocked; later calls return the same promise/result. `cancel()` works only before dispatch. Results are `acknowledged`, `blocked` with a safe code (`revoked`, `retired`, `cancelled`, `revision-mismatch`, `draft-changed`, `pending`, `unconfirmed`, `peer-blocked`, `empty`,
`unavailable`, `read-only`, `decision-changed`, `unsupported`, `persistence-failed`, `projection-failed`), or `unconfirmed` with `native-unconfirmed`/`settlement-failed`. Blocked guarantees no native dispatch; unconfirmed may have sent and must not be retried automatically or replaced with fresh consent.

Dispatch uses the existing `SessionDraft` projection, native route construction, pending token, and schema ACK transaction. Prompt sends to the original session's prompt/enqueue route even if an ask later appears. Ask sends only to the original live free-text ask with `wasFreeform: true`; plan sends feedback;
elicitation has no text route. Retired decisions never turn into prompts. Module unload mid-send does not prove no send happened.
### 6.3 File-style draft input
The host stores ordinary prompt drafts per session and separate drafts for each native ask/plan/elicitation request. Decision drafts are selected by kind and request ID, not by clearing/copying the prompt. When a request ends, the prompt returns; replacement requests get new lifetimes; failed/unknown answers retain
their own input.

File schema is a prompt-only module schema. The file module renders complete ready/uploading lists as `composerEditor` children above the input row. Switching to an answer draft naturally hides prompt files; no core attachment hidden flag, warning, generated group, `onFiles`, picker transaction, file callback table, or
receive-files dispatcher exists. File modules capture the stable prompt draft when opening a picker; late results cannot retarget the current session or answer draft. Core handles text and native gates; modules own upload limits, order, server originals, persistence, and cleanup.
### 6.4 Markdown and lifecycle
Markdown rendering receives parsed link/image nodes with original unnormalized target, label, and message origin. It does not reparse full Markdown or receive native/draft attachments. No match keeps safe fallback. Multiple exclusive matches, predicate errors, or render errors report and fall back; download order does
not decide. Replacements must remain inline phrasing content; dialogs portal to body. Native history attachments use `attachment` middleware and `NativeAttachmentDescriptor`, preserving omitted blob reasons and basic fallback.

All module-local IDs across state services, draft schemas, components, menus, and Markdown must be unique. The host stages activation and publishes only after full validation. On stop it revokes draft bindings, schemas, live fields, projections, and blockers; runs state disposers once in reverse registration order;
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
