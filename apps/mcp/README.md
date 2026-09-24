# Cockpit API/MCP session client (`@cockpit/mcp`)
A stdio MCP server backed by the Cockpit HTTP API. It is a thin remote Copilot adapter: Web and MCP
consume the same backend API, and neither transport is a separate authority or a promise of full UI
parity.

All session metadata, lists, transcripts and mutations come from HTTP. The MCP process needs no
backend filesystem access, SDK, session database or event logs, and it never falls back to local
state. Attachment paths are passed to the native runtime as paths; the client does not read or write
local files for them.

This page documents the checked-in source. See [source
status](../../docs/architecture.md#source-status), the [documentation index](../../docs/README.md),
[modules](../../docs/modules.md), and the [module contract](../../docs/module-contract.md). Module
HTTP MCP tools can be published through host routes, but module business tools do not enter this
stdio registry; module roles, cold loading and native per-session MCP switches remain separate
operations.

Entry: `dist/index.js`. From the package root use `pnpm start:mcp`, or from the workspace use the
built command shown in [Register with Copilot](#register-with-copilot). Do not rely on implicit
TypeScript stripping in an arbitrary Node version.
## Discover and invoke the API
`GET /capabilities` lists published protocol intents with names, descriptions and transport
inventory. Use `prefix`, `limit` (1-100) and `offset` to page. Detail lookup, for example `GET
/capabilities?name=session/chat`, returns one intent's `inputSchema` and `resultSchema` as JSON
Schema draft-07. Detail lookup cannot be combined with listing parameters.
| MCP tool | Purpose |
| --- | --- |
| `cockpit_capabilities` | List/filter/page intent names (default 50), or return one `name` and schemas. |
| `cockpit_call_intent` | POST any published `name` with the exact camelCase API `body`. |
| `cockpit_get_snapshot` | Read `runtime/snapshot`: agent readiness, models, sessions and `permissionPolicy`. |
| `cockpit_service_status` | Read `system/status` or `/health`. |
Example:
```json
{"name":"session/chat"}
```
Pass that to `cockpit_capabilities`, then invoke:
```json
{"name":"session/chat","body":{"sessionId":"TARGET_SESSION_ID","source":"persisted","direction":"backward","max":64}}
```
The generic caller sends one POST without a capability preflight, local intent catalog, arbitrary
URL proxy or automatic retry. Invalid names and path traversal are rejected locally; the backend
remains authoritative for schemas, result validation and unknown commands. Redirects and mismatched
discovery responses fail. HTTP errors and results classified as failed or partially failed are MCP
errors with the backend JSON preserved; successful-looking native envelopes must still be inspected
for status, warnings, deferral or persistence errors. Generic invocation also covers published API
operations without semantic wrappers, including `session/refresh` and `skills/read`.

`system/shutdown` is available through the generic caller and requires `confirm:true`; session
compact, rewind and delete do not add an MCP confirmation parameter. During shutdown, the host may
return `503 SERVICE_CLOSING` with `code`, `shutdown.phase`, `shutdown.requestedAt` and
`shutdown.error`. See the [shutdown boundary](../../docs/architecture.md#shutdown).

`runtime/snapshot {}` returns `Snapshot` with `type:"snapshot"`, `agentStatus`, `models`, `sessions`
and required `permissionPolicy:"allow-all"`. Always-auto- approve is retained. Interactive, plan and
autopilot are interaction modes, not permission controls; MCP adds no approval dialogs.
Ask/plan/elicitation response tools answer native interaction requests, not tool-permission prompts.
## Semantic tools
All semantic tools wrap the same backend API. They do not introduce a local store, capability
policy, retry loop or confirmation layer.
| Area | Tools |
| --- | --- |
| Sessions/read | `cockpit_list_sessions`, `cockpit_get_session`, `cockpit_read_session`, `cockpit_get_panels`, `cockpit_get_plan`, `cockpit_get_snapshot` |
| Lifecycle | `cockpit_new_session`, `cockpit_delete_session`, `cockpit_unload_session`, `cockpit_reload_session`, `cockpit_rename_session` |
| Conversation/queue | `cockpit_send_prompt`, `cockpit_cancel_turn`, `cockpit_remove_queued` |
| Interaction requests | `cockpit_respond_ask`, `cockpit_respond_plan`, `cockpit_plan_supersede`, `cockpit_respond_elicitation` |
| Model/session settings | `cockpit_set_model`, `cockpit_set_mode`, `cockpit_compact_session`, `cockpit_rewind_session` |
| Manual MCP settings | `cockpit_list_session_mcp`, `cockpit_set_session_mcp`, `cockpit_list_global_mcp`, `cockpit_set_global_mcp_default`, `cockpit_refresh_mcp`, `cockpit_reload_session_mcp` |
| Manual skills | `cockpit_list_session_skills`, `cockpit_set_session_skill`, `cockpit_list_global_skills`, `cockpit_refresh_skills` |
| Roles | `cockpit_list_roles`, `cockpit_add_roles`, `cockpit_role_readiness` |
| Schedules | `cockpit_schedule_add`, `cockpit_list_schedules`, `cockpit_stop_schedule` |
| Backend directory | `cockpit_list_dir` |
| Generic/API | `cockpit_capabilities`, `cockpit_call_intent`, `cockpit_service_status` |
Creation is identical to Web: `cockpit_new_session` calls `session/new {cwd}` once and returns the
native ID; no hidden prompt is sent. `cockpit_send_prompt` then calls `prompt` for that ID. Empty
native sessions can disappear on unload; no transport silently recreates them.

`cockpit_get_session` defaults to compact Markdown with queue/decision IDs and queue previews. Use
`response_format:"json"` on the first read for complete queue text, `availableModels` and plan
actions. `mcp/session`, plan, panels, session skill and schedule reads require loaded handles when
the backend says so; `409 SESSION_UNLOADED` asks callers to use `cockpit_reload_session`, not to
materialize sessions implicitly.

Roles are metadata until applied. `cockpit_list_roles` discovers catalog roles.
`cockpit_new_session` accepts `roles:[{moduleId,roleId}]`, and `cockpit_add_roles` appends saved
roles to an existing session without loading, reloading, prompting or stopping it. Saved roles apply
on explicit idle reload or next cold load under normal native/global defaults. `status` is `saved`,
`unchanged` or `uncertain`; none means applied or ready. `rolesNeedReload` compares saved and
applied IDs on a loaded handle. `cockpit_role_readiness` is the separate passive check for role
assembly, native skills/MCP and tool visibility. If native tool metadata becomes uninitialized,
hosts that publish `session/tools-initialize` can be called through `cockpit_call_intent`; follow
with a separate readiness check. Resource preparation (`session/resources-prepare`) is likewise an
explicit backend intent on a loaded, idle session; tools are exact native `mcpToolName` identities
and `"*"` is rejected there; its per-request errors are capped at 2000 characters. See the
[module contract](../../docs/module-contract.md).

Queue control is explicit. `cockpit_cancel_turn` / `POST /intent/cancel {sessionId}` follows Stop
semantics: abort current work and discard queued messages; `{ok:true}` acknowledges the request,
not idle completion.
`cockpit_remove_queued` removes only the selected queued item. For interrupt-without-discard, call `session/interrupt` generically with `body:{sessionId}`; it
uses native `interruptMainTurn({flushQueued:true})`. `{ok:true,interrupted:true}` acknowledges the
interrupt request, `interrupted:false` means no main turn was interrupted, and no queued input is
replayed.

Native idle cleanup is 30 minutes. History and metadata stay passively readable; prompts or explicit
reload resume as needed. Schedules pause while unloaded, and relative delays restart on resume;
Cockpit does not auto-resume scheduled sessions after service startup. External schedulers own
delivery policy.

Global MCP defaults use native user configuration. Session-level MCP/skill toggles report and mutate
the native effective state only for that session; Cockpit does not persist or replay temporary
overrides. `mcp/refresh` rereads native MCP definitions, and `mcp/reload-session` reconnects one
idle loaded session while reapplying native global defaults. Global skill toggling is available
through the published `skills/global-toggle` intent. Configuration ownership is described in the
[architecture](../../docs/architecture.md).

`cockpit_list_dir` lists backend directories. Omitting `path` uses the server home; missing,
non-directory or inaccessible paths fail. Large JSON listings retain the resolved `path` and
`parent` while explicitly compacting entries; `_returned` reports retained entry count.
<a id="confirmation-boundaries"></a>
### Native outcomes and irreversible operations
`cockpit_compact_session` compacts model-facing context only; retained chat events remain. There is
no undo. `cockpit_rewind_session` discards conversation history from the chosen user message, and
`cockpit_delete_session` permanently deletes a native session through native `deleteSession` /
`session/delete`. File rollback is opt-in through
`rollback_files:true` / `rollbackFiles:true` and is validated by the backend. Cockpit does not
delete workspace files for session deletion.

These tools send the current schema once, without cached option merging, automatic follow-up
prompts, verification reads or retries. Native busy/decision protections remain in force. Unknown
parameters are rejected. Use irreversible operations only when intended, and never treat an MCP
timeout or unknown native status as proof that nothing happened.

Model/mode/compact/rewind wrappers return the backend native JSON unchanged. `ok:true` acknowledges
that the native call returned, not that every requested effect completed. For models, `deferred:true`
takes precedence over `status:"applied"`. Inspect model `status`, `deferred`, `modelState`, confirmation, persistence errors and warnings; mode confirmation/defer
details; compact `success`, removal counts and summaries; rewind outcome, restored/skipped files and
errors. Explicit native failures, compact `success:false`, known rewind failures and persistence
errors set MCP `isError:true` while preserving the body. Queued and needs-action outcomes are not
failures; missing or unfamiliar statuses remain unknown.

Errors preserve structured backend details subject to limits: response bodies are bounded to 25 MiB,
HTTP error bodies to 64 KiB, and MCP error text to 25,000 characters with explicit compaction
markers. Non-JSON backend errors remain visible as quoted text. Backend failures are not rewritten
as successful local state.
## Native schedules
`schedule/add` / `cockpit_schedule_add` accepts exactly one deterministic `interval` or one-shot
epoch-millisecond `at`, with a delay from 1 second through 24 hours. Prompts are plain single-line
text with no leading slash or command flags. Cron, timezone labels, recurring absolute times and
self-paced creation or rearming are not exposed. A returned `entry` establishes creation even
alongside an error; `possiblyCreated:true` means acknowledgement/readback was inconclusive. Do not
infer that no schedule exists from a missing entry or retry automatically.

`schedule/list` requires a loaded session and preserves native `selfPaced`; optional `cron`, `tz`,
`at` and `displayPrompt` describe existing entries, not accepted creation options. Listing/stopping
does not add a rearm API. `schedule/stop {sessionId,id}` uses the native stop result directly:
`{ok:false}` means no stopped entry and is surfaced as an error. Future schedules do not prevent
idle cleanup.
## Native event pagination

`cockpit_read_session` calls `session/chat` for one native event page. It is not a folded message
API or cache. Passive persisted reads work without loading.

```json
{"session_id":"TARGET_SESSION_ID","source":"persisted","direction":"backward","limit":16,"response_format":"json"}
```

Key rules (details in [native chat](../../docs/native-chat.md)):

| Topic | Contract |
| --- | --- |
| Counts | `limit` is 1-256 events (MCP default 16); generic HTTP uses `max` default 64. |
| Result | JSON includes `sessionId`, `events`, `cursor`, `cursorStatus`, `hasMore`, `source`, `direction`, and `read:{rpc,events}`. |
| Cursors | Preserve opaque cursor, source, direction, filters and bootstrap. Event/message IDs are identities, not order keys; unanchored latest-page reads can move. |
| Oversize | JSON pages over 25,000 characters with `limit>1` fail `NATIVE_PAGE_TOO_LARGE`; retry manually with a smaller limit and the original cursor. |
| Giant event | `limit:1` may return `{format:"json-fragment",json,pageVersion,pageOffset,nextPageOffset,pageCharacters,read}`. Repeat the identical query with `page_offset:nextPageOffset` / `page_version:pageVersion` until `nextPageOffset` is null, concatenate `json`, then parse. `pageCharacters` and offsets count JavaScript string code units, not UTF-8 bytes or tokens. |
| Fragment cost | Each fragment rereads and serializes the whole native page; complete delivery takes `ceil(S/8000)` native page reads for S code units. |
| Live | `source:"live"` requires a loaded handle; `bootstrap:true` returns `liveCursor`; use it with `direction:"forward"`; `include_ephemeral` defaults false; `wait_ms` is at most 1000. |
| Subagents | Exact reads use native `agent_ids`, e.g. `["NATIVE_AGENT_ID","NATIVE_TOOL_CALL_ID"]` for older envelopes needing the spawning tool-call ID; passive history has no equivalent filter. |

### Session A sends to and reads B

1. `cockpit_list_sessions` — find B.
2. `cockpit_send_prompt {session_id:"B",text:"From A: please review …"}`.
3. `cockpit_get_session {session_id:"B"}` — inspect progress/decisions.
4. `cockpit_read_session {session_id:"B",response_format:"json"}` — read B's reply.

Send defaults to `mode:"enqueue"`; acceptance is not turn completion.

`cockpit_rename_session` writes the native title; lists and metadata read native titles, including
native-generated names.

## Native attachment input
`cockpit_send_prompt` accepts up to 20 SDK-native attachments. Generic `prompt` uses the same array
with camelCase `sessionId`.
```json
{
  "session_id":"B",
  "text":"Read this native-host file",
  "attachments":[{"type":"file","path":"/native-host/work/example.txt","displayName":"Example"}]
}
```
| Native kind | Fields |
| --- | --- |
| `file` | `type`, `path`, optional `displayName` |
| `directory` | `type`, `path`, optional `displayName` |
| `selection` | `type`, `filePath`, `displayName`, optional `text` and `selection:{start:{line,character},end:{line,character}}` |
| `blob` | `type`, `data`, `mimeType`, optional `displayName` |
Paths belong to the Copilot runtime filesystem, not the browser or MCP client. The adapter does not
upload files, obtain URLs, resolve module references, attach file-library records or rewrite inputs.
Acceptance does not prove bytes were read or that every media format is supported. Chat reads omit
internal image bytes; binary transfer and enhanced rendering belong to the separate file module.
## Configuration
| Variable | Default / meaning |
| --- | --- |
| `COCKPIT_URL` | `http://127.0.0.1:8771`; use an authenticated gateway for remote access. |
| `COCKPIT_PORT` | `8771`, used only when `COCKPIT_URL` is unset. |
| `COCKPIT_API_TOKEN` | Optional gateway credential; when set, sent as `Authorization: ******` on every HTTP request; when unset, no Authorization header is sent. |
| `COCKPIT_TIMEOUT_MS` | Positive integer override for every request; otherwise 10s routine/native-page requests and 45s load-aware intents. |
Load-aware intents include `prompt`, `session/new`, `session/fork`, plan/panel reads,
load/reload/compact/rewind, model/mode changes, MCP/skill toggles and schedule operations. Requests
use fresh HTTP(S) connections, `accept-encoding: identity`, a 25 MiB transfer cap and no automatic
retry. A timeout can mean the backend is still processing; inspect state before retrying.

The token is for the operator's gateway, not a new Cockpit authentication system. The backend
remains loopback-only unless the operator publishes an authenticated proxy; see [remote
access](../../docs/install.md#remote-access). Native lifecycle busy/decision/subagent/MCP-operation
safeguards remain on the backend.
## Build
```sh
pnpm --filter @cockpit/mcp build
pnpm --filter @cockpit/mcp test
```
The workspace dependency must be linked before typechecking. Tests use existing `node:test`/`tsx`,
mock HTTP/HTTPS and configuration before client imports, and connect MCP through in-memory
transports by default. The native fork fixture below uses isolated real SDK/loopback transports and
is not a mock-only run.
<a id="register-with-copilot"></a>
## Register with Copilot
Copilot CLI documents MCP configuration under `~/.copilot/mcp-config.json` and loads additional
workspace/plugin sources. In an isolated probe, setting `COPILOT_HOME` made `copilot mcp add` write
`mcp-config.json` under that directory; no local bundled SDK/runtime document verified an XDG
override. Prefer the CLI where possible:
```sh
copilot mcp add cockpit \
  --env COCKPIT_URL=http://127.0.0.1:8771 \
  --env COCKPIT_API_TOKEN=REPLACE_WITH_GATEWAY_TOKEN \
  -- node --enable-source-maps /path/to/cockpit/apps/mcp/dist/index.js
```
For manual edits, merge a server entry into the existing `mcpServers` object; never replace the
whole file or discard other servers:
```json
{
  "mcpServers": {
    "cockpit": {
      "type": "local",
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/path/to/cockpit/apps/mcp/dist/index.js"
      ],
      "tools": ["*"],
      "env": {
        "COCKPIT_URL": "http://127.0.0.1:8771",
        "COCKPIT_API_TOKEN": "REPLACE_WITH_GATEWAY_TOKEN"
      }
    }
  }
}
```
`type:"local"`, `command`, `args`, `tools:["*"]` and `env` match `copilot mcp add --json` output.
Omit `COCKPIT_API_TOKEN` only when the backend/gateway does not require it. `/path/to/cockpit` is an
extracted runtime package root, whose `start:mcp` script is the same command and which ships no
TypeScript loader. Registrations made for older packages used
`--import …/apps/mcp/node_modules/tsx/dist/loader.mjs`; update them when deploying a newer package
([entry points](../../docs/releasing.md#entry-point-upgrade)). A source checkout resolves
`@cockpit/protocol` to TypeScript, so there insert
`"--import", "/path/to/checkout/apps/mcp/node_modules/tsx/dist/loader.mjs"` before the entry, as
root `pnpm start:mcp` does; `pnpm --filter @cockpit/mcp start` runs `node --import tsx dist/index.js`.

After editing user configuration, new sessions pick it up through native MCP discovery. For a
running backend, `cockpit_refresh_mcp` (`mcp/refresh`) rereads native MCP definitions, and
`cockpit_reload_session_mcp` (`mcp/reload-session`) reconnects one idle loaded session while
reapplying native global defaults. Neither command restarts Cockpit or rewrites the installed MCP
process.
<a id="session-fork"></a>

## Session fork

`session/fork` delegates history copying to native. It is available through HTTP,
`cockpit_call_intent`, and Web **Session settings → Session operations** full-history fork. The Web
action forks the full current history and explains shared workspace/cold-resume behavior. It creates
an unloaded child, emits `session/added`, sends no prompt, and leaves Web settings on the parent
until the child is selected from the session list or explicit **Open new session** link. An
unconfirmed response keeps a warning instead of claiming creation or retrying.
Inherited history is conversation context, not a new instruction or authorization to act.

API discovery: `GET /capabilities?name=session/fork`.

```http
POST /intent/session/fork
Content-Type: application/json

{"sessionId":"source-id","toEventId":"root-user-event-id","name":"Independent goal"}
```

Response: `{"sessionId":"new-child-id"}`. Only `sessionId` is required. Omitting `toEventId` copies
full persisted history. If supplied, `toEventId` must be a root `user.message` event ID from
`session/chat`; that event and later history are excluded. Assistant IDs, nested-agent user
messages, unknown IDs, empty prefixes and boundaries with unfinished work are rejected.

MCP uses the same dynamic registry, with no dedicated `cockpit_fork_session` tool and no separate
history implementation. Backend publication is enough for already-connected clients; no MCP refresh,
forced reconnect or discussion-session migration is required. MCP steps: if publication/schema is
unknown, discover `cockpit_capabilities({name:"session/fork"})` (`404` means backend unpublished;
MCP refresh cannot fix it); verify the source with `cockpit_get_session` as loaded, idle and
timer-free; call
`cockpit_call_intent({name:"session/fork",body:{sessionId:"source-id",name:"New independent
goal"}})`; then list/read/send to the returned child explicitly. Do not fork the initiating running
session, cancel a busy source, or force-reload to make it forkable. Fork uses the 45s load-aware
deadline unless overridden. It is non-idempotent: on timeout/lost acknowledgement, inspect
`session/list` and source fork records before any retry. `mcp/refresh` only rereads native MCP
definitions, and `mcp/reload-session` reconnects an idle session's MCP servers while reapplying
native global defaults; neither is required for fork. A backend restart ends runtime connections and
later ordinary resume reconnects them; do not describe it as every existing connection receiving a
hot update.

| Surface | Behavior |
| --- | --- |
| Source | Must be loaded and idle: no turn, decision, active task, queue, steering, timer or protected operation. Cockpit never auto-resumes, aborts, unloads or cancels it, even though native RPC itself may permit some busy sources. |
| History | Parent events remain; native appends one source `session.info` fork record. Child gets the selected prefix and a new ID. |
| Model/mode | Restored from native persisted history at the chosen boundary, not copied from the sidebar. |
| cwd/files | Same working directory; no Git branch/worktree/filesystem snapshot/credential sandbox. `cwd` overrides are rejected; use `session/new` in a prepared worktree for isolation. |
| Skills/MCP | Cold-resume discovery/config applies. Session-only disabled choices do not carry over; global config still applies. |
| Plans/todos | Current `plan.md` is copied even if the boundary predates it; fixture SQL todos do not carry over. Treat inherited plans as context, not a new assignment or a point-in-time filesystem snapshot. |
| Tasks/queue | Active tasks, queued prompts, callbacks and decisions do not enter child registries; parent registries are unchanged. |
| Schedules | Prefixes containing `session.schedule_created` and currently active timers are rejected; a boundary before schedule creation is allowed once no live timers remain. |

Preflight scans loaded native `eventLog.read` forward, all agents, durable events only, with the
fixed safety filter `user.message`, `assistant.turn_start`, `assistant.turn_end`, `abort`,
`tool.execution_start`, `tool.execution_complete`, `subagent.started`, `subagent.completed`,
`subagent.failed`, and `session.schedule_created`. Each continuation reuses that filter and opaque
cursor. No history cap, wildcard retry or persisted fallback exists; invalid boundaries,
expired/stalled cursors and read failures fail closed. This is not an ID-only API: required
user/tool events still carry full native payloads.

Regression fixtures:

```bash
cd packages/core && COCKPIT_NATIVE_FORK=1 node --import tsx --test src/fork-native.test.ts
cd apps/mcp && pnpm build && COCKPIT_NATIVE_FORK=1 node --import tsx --test src/fork-native.test.ts
```

CI also runs `pnpm --filter @cockpit/mcp exec node --import tsx --test src/fork-native.test.ts` with
`COCKPIT_NATIVE_FORK=1`. Fixtures use isolated HOME/state/cwd, loopback-only deterministic BYOK
providers, a synthetic local MCP server and local transports; no logged-in credentials, real user
conversation, production data or port is used.
