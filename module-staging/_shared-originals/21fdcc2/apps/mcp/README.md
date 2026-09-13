# Cockpit API/MCP session client (`@cockpit/mcp`)

A **stdio MCP server backed by the Cockpit API**: remote Copilot plus GUI-specific functions.
The backend owns one capability set, shared by the web UI and sessions using MCP.
This is not a maintainer-only database salvage service or a policy engine.

All session metadata, lists, transcripts and mutations come from HTTP.
The MCP process needs **no backend filesystem access, SDK, session database or event
logs**. Backend failures are errors, never successful local-state fallbacks.
Local files are accessed only for explicit upload/download operations.

This documents the checked-in source, not automatic deployment or hot replacement
of an already-running MCP process. See the [source delivery and paused work
status](../../docs/cockpit-plan.md#source-delivery-and-paused-work-2026-09-11).

Binary: `cockpit-mcp-server` → `dist/index.js`. Requires Node ≥22.12; raw Node 24 is
supported without a TypeScript loader. Canonical schemas and types come from
the `@cockpit/protocol` workspace dependency.

## Discover and invoke the API

`GET /capabilities` lists the actual protocol `Intents`, with names, descriptions,
and a transport inventory. `prefix`, `limit` (1–100), and `offset` bound the listing.
`GET /capabilities?name=session/chat` returns one intent's `inputSchema` and
`resultSchema`, generated from the backend's Zod protocol schemas as JSON Schema
draft-07. Name detail cannot be combined with listing parameters.

| MCP tool | Purpose |
| --- | --- |
| `cockpit_capabilities` | List names (default 50), filter/page, or request one `name` and its schemas |
| `cockpit_call_intent` | Invoke any published `name` with its exact API `body` |
| `cockpit_get_snapshot` | Read `runtime/snapshot`: agent readiness, models, sessions and permission policy |
| `cockpit_service_status` | Fixed `operation`: `health` or `status` |
| `cockpit_service_restart` | Arm/cancel a graceful restart with `pending` and mandatory `confirm:true` |

For consumer-owned installations, `system/consumer/status {operationId?}` is
the current launcher/runtime read and `system/consumer/restart
{operationId,confirm:true}` is the same safe restart used by Web. The semantic
`cockpit_service_restart` alias accepts `operation_id` and forwards it as
`operationId` through `/admin/restart`; consumer mode requires that stable ID.
It drains the owned module services/runner before native main shutdown and
restores captured module release pins after startup. An accepted receipt is not
a completed restart. Inspect the original operation on uncertainty; a started
or unknown module drain cannot be undone by `pending:false`. Source/private-CD
installations retain their existing restart behavior.

Example:

```json
{"name":"session/chat"}
```

Pass that to `cockpit_capabilities`, then call `cockpit_call_intent`:

```json
{"name":"session/chat","body":{"sessionId":"TARGET_SESSION_ID","source":"persisted","direction":"backward","max":64}}
```

The generic caller sends one POST directly, without a capability preflight or a
local intent catalog. Use explicit discovery when the API schema is unknown;
newly published intents need no new MCP wrapper or reconnect. There is no
arbitrary URL, HTTP method or path proxy. Invalid names and path traversal are
rejected locally; the authoritative backend rejects unknown/retired commands.
Redirects and mismatched explicit discovery responses fail. Bodies use the API's
**camelCase** field names; the backend validates both bodies and results, including
`confirm:true` on `session/purge`. No automatic retries are performed, even on
timeout or service errors. Generic results are complete JSON; use semantic pagination when
reading large histories. HTTP errors and results with `ok:false` are MCP errors,
not successful mutations; backend error/operation details remain visible.

`runtime/snapshot {}` returns `Snapshot` with `type:"snapshot"`, `agentStatus`,
`models`, `sessions`, optional nullable `vapidPublicKey`, and required
`permissionPolicy:"allow-all"`. **Always-auto-approve is retained.** Interactive,
plan and autopilot are interaction modes, not permission controls. MCP offers no
permission-policy mutation or additional approval dialogs. Existing ask/plan/
elicitation tools answer agent interaction requests, not tool-permission prompts.

## Semantic tools

All tools below wrap the same backend API; they do not introduce another domain
store or capability policy.

Creation is identical to Web: `cockpit_new_session` calls
`session/new {cwd}` once and returns the actual Copilot ID, using native
configuration discovery with **no message sent**. `cockpit_send_prompt` then calls
`prompt` for that ID. There is no virtual session, hidden launch message or
first-message-only creation API. An empty native session may disappear on unload;
neither transport silently recreates it. Both transports reject the retired
`modules` creation parameter. Module installation, service and session-role APIs
are removed, not success-shaped no-ops. Native MCP and skill controls remain.
The [basic module contract](../../docs/module-contract-draft.md) is a future
design, not discoverable running capability.

| Area | Tools |
| --- | --- |
| Session reads | `cockpit_get_snapshot`, `cockpit_list_sessions`, `cockpit_read_session`, `cockpit_get_session`, `cockpit_get_panels`, `cockpit_get_plan` |
| Lifecycle | `cockpit_new_session`, `cockpit_delete_session` (permanent), `cockpit_purge_session` (compatibility alias), `cockpit_unload_session`, `cockpit_reload_session`, `cockpit_rename_session`, `cockpit_set_session_pin` |
| Conversation | `cockpit_send_prompt`, `cockpit_cancel_turn`, `cockpit_remove_queued` |
| Interaction requests | `cockpit_respond_ask`, `cockpit_respond_plan`, `cockpit_plan_supersede`, `cockpit_respond_elicitation` |
| Model/session settings | `cockpit_set_model`, `cockpit_set_mode`, `cockpit_compact_session`, `cockpit_rewind_session` |
| Manual MCP settings | `cockpit_list_session_mcp`, `cockpit_set_session_mcp`, `cockpit_list_global_mcp`, `cockpit_set_global_mcp_default`, `cockpit_refresh_mcp`, `cockpit_reload_session_mcp` |
| Manual skills | `cockpit_list_session_skills`, `cockpit_set_session_skill`, `cockpit_list_global_skills`, `cockpit_refresh_skills` |
| Native Copilot schedules | `cockpit_schedule_add`, `cockpit_list_schedules`, `cockpit_stop_schedule` |
| Files | `cockpit_upload_file`, `cockpit_download_file`, `cockpit_list_dir` |

Generic invocation also covers surviving API operations without semantic wrappers,
such as `inbox/seen`, `push/subscribe`, `speech/token`, `session/refresh`, and
`skills/read`. `session/chat` returns one bounded native event page as JSON.

Deletion is irreversible native Copilot `deleteSession`, not a trash marker.
Both delete and purge require explicit `confirm:true`; the backend rejects old
soft-delete requests without confirmation even from stale loaded MCP tools.
Trash listing and restoration are retired. Legacy hidden sessions reappear in
the normal list without deleting native history. Managed files, associations and
workspaces remain intact. Never automatically retry an uncertain deletion.
Deletion never requires module unbind preview/approval or invokes module hooks.
Manual module unbind is a separate configuration operation. Modules discover
missing active targets on use, preserving business history and unknown effects.

`cockpit_get_session` defaults to a compact Markdown summary, including
queue/decision IDs but only queue text previews. For `availableModels`, complete
queue text or offered plan actions, request `response_format:"json"` on the first
read; the default summary intentionally omits those fields. JSON retains the
existing output-size limit and reports overflow rather than returning partial
JSON. `mcp/session` does not materialize an unloaded session.

`cockpit_compact_session` summarizes the model-facing context, not the retained
chat event history. There is no compaction undo; explicit `confirm:true` remains
required. It is distinct from conversation rewind or permanent deletion.

`cockpit_cancel_turn` / `POST /intent/cancel {sessionId}` follows native Stop
semantics: cancel current work and discard pending queued messages. It does not
start the next queued message, retain it for later, or replay discarded input.
A successful `{ok:true}` acknowledges cancellation, not immediate idle: native
work may still be settling, and `cockpit_get_session` / `session/get` plus session
events expose current activity. Queue-clear, abort and native-state read failures
still propagate; an error does not imply that earlier cancellation steps were
rolled back. Do not automatically retry or resend discarded messages.

To interrupt only the main turn **without discarding the existing queue**, call
`cockpit_call_intent` with `name:"session/interrupt"` and `body:{sessionId}`.
This requires a loaded session and directly uses the public native
`interruptMainTurn({flushQueued:true})` RPC; Cockpit does not save or replay
queued messages. `{ok:true,interrupted:true}` acknowledges the main-turn
interruption, not idle or completed queue processing. `interrupted:false`
means there was no main turn to interrupt. Background agents/shells keep running
and may delay the queue; interruption does not undo tool effects. Real failures
propagate and uncertain calls are never automatically retried. The Web exposes
the same action as "打断并继续" in a running session's queued-message area.
Ordinary sends, pending-question/plan replies and the existing Stop are unchanged.

Native idle cleanup is set to 30 minutes. History and metadata remain readable
without resuming. Plan, panels, session-skill and schedule details require a loaded
session; `409 SESSION_UNLOADED` asks the caller to explicitly use
`cockpit_reload_session`, not retry the read in a loop. A prompt resumes as needed.
UI pinning does not keep a runtime loaded. Native schedules persist but pause while
unloaded, and relative delays restart on resume; they are not an always-on scheduler.
Cockpit does not auto-resume scheduled sessions after service startup. External
schedulers/webhook services should own timing and delivery policy and call the
same prompt API explicitly.
MCP and skill selection belongs to Copilot. Global MCP defaults use native user
configuration, and `skills/global-toggle {name,enabled,cwd?}` changes the native global
skill setting through `cockpit_call_intent`. Cockpit does not persist or replay
per-session tool overrides. Session-level controls report native effective state;
their lifetime follows the SDK rather than a Cockpit persistence promise. Native
MCP reload and cold session resume restore the pinned configuration of explicitly
selected module roles. Other temporary native MCP/skill switches follow native
global defaults, not a Cockpit snapshot. Skill definition reload retains current
session choices. Global changes do not automatically mutate loaded sessions.
An unloaded MCP query returns no invented per-session choices; explicitly resume
for effective session settings or read the global catalog separately.
Failure/settling status and operation IDs remain visible.
The SDK's global disabled-skill list is read from native user settings and passed
into create/resume because runtime 1.0.83 does not apply it automatically. No
second persisted list is created.
For a project-only skill, pass the same `cwd` used for discovery; this validates
the target in that project without changing the setting's global scope.
Nullable model effort/context/mode, errors and requests remain null in JSON;
optional `loading`, `closing`, `cancelling` and todo `intent` are surfaced.
`cockpit_get_plan` renders canonical `planMarkdown` and `todos`; the old
history-derived changed-files list is retired. `cockpit_get_panels` renders
`label`, `sublabel` and `enabled`, for all five sections by default or only the
requested `section`.
`cockpit_list_global_skills` accepts optional backend `cwd`; omitting it uses the
**server home**, never the MCP client's working directory.

`cockpit_rewind_session` rewinds history with `confirm:true`; file changes are
left alone by default.
File rollback is a native runtime operation: semantic `rollback_files:true` and
generic `session/rewind {rollbackFiles:true,...}` delegate capability validation to
the backend. Unsupported operations and native conflicts must fail explicitly
rather than ignoring the requested file rollback.

## Native schedules

`schedule/add` (or `cockpit_schedule_add`) accepts exactly one deterministic
`interval` or one-shot epoch-millisecond `at`, with a delay of 1 second to 24 hours.
It uses native `every`/`after` commands and confirms the created entry; it is not a
public SDK `schedule.add` RPC or a model-prompt fallback. Plain single-line prompts
cannot contain command flags or a leading slash. Cron, timezone, display labels,
recurring absolute times and self-paced creation/rearming are not exposed.

`schedule/list` requires an already-loaded session and preserves native
`selfPaced`. When true, the model controls the next run; this is not an ordinary
fixed cadence or a missing interval to fill in. Optional `cron`, `tz`, `at` and
`displayPrompt` fields describe existing native entries, not accepted creation
options. Listing/stopping self-paced entries does not add a rearm API.

`schedule/stop {sessionId,id}` uses the native stop result directly, with no list
read to infer success. `{ok:false}` means native returned no stopped entry;
the semantic MCP tool presents that as an error. Native errors propagate.
Use a known ID directly, or list to find an unknown ID; do not add a redundant
preflight to every stop.

Neither future schedules nor UI pins prevent native idle cleanup. Timers pause
while unloaded, relative delays restart on resume, and startup does not restore
scheduled sessions automatically. These are user-controlled native timers, not
an always-on cron service.

## Native automatic naming

Cockpit can generate a short title with the current session's native no-tools
`ui.ephemeralQuery` and save it through `name.setAuto`. This is one additional
model request, not a new session or a prompt appended to ordinary chat history.
Manually assigned names are protected by Copilot.

Use the shared API through the existing generic tool:

```json
{"name":"session/auto-name","body":{"sessionId":"TARGET_SESSION_ID"}}
```

The result reports `{ok:true,applied,title,reason?}`. `applied:false` preserves the
current name, with `user-named`, `no-context` or `not-applied` explaining why.
Do not describe a skipped operation as a successful rename or retry it in a loop.
An explicit request may resume an unloaded session; busy work must settle first.
Manual and automatic naming remain available through HTTP/MCP, not a separate
Web menu action.

The first effective completed reply can trigger one automatic attempt after the
session settles. Historical replies are not retroactively named on startup or
history viewing. Progress and naming errors are transient UI state; the title's
only persistent owner is Copilot.

## Native event pagination

`cockpit_read_session` calls **`session/chat`**. It reads one native page without
server-folded messages, a history cache, or message-ID scans. The default passive
source works for loaded and unloaded native sessions without loading them.

```json
{"session_id":"TARGET_SESSION_ID","source":"persisted","direction":"backward","limit":16,"response_format":"json"}
```

The result contains `sessionId`, `events`, `cursor`, `cursorStatus`,
`hasMore`, `source`, `direction`, and `read:{rpc,events}`. `limit` is 1–256 native
events (MCP default 16), not display messages or a byte bound; generic HTTP uses
`max` and retains its default of 64. Backward pages contain the
latest events in append order. Pass the opaque cursor with the same source,
direction and filters for the next page. Event IDs and assistant message IDs are
identities, not sorting or seek keys. The runtime's expired cursor is returned
explicitly, not silently replaced by the latest page.

Titles, working directories and runtime metadata belong to `session/get` or
`session/list`, not every chat page or streaming poll.

Pages exceeding 25,000 serialized JSON characters with `limit>1` fail explicitly
with `NATIVE_PAGE_TOO_LARGE`. Retry with a smaller native `limit`, keeping the
**original input cursor** (or its absence), source, direction, filters and bootstrap.
The error does not deliver partial events or a next-page cursor that could skip
unread content. There is no automatic bisection, retry, or hidden multi-page scan.
An unanchored latest-page read can move when new events arrive.

With `limit:1`, a giant event instead returns a bounded
`{format:"json-fragment",json,pageVersion,pageOffset,nextPageOffset,pageCharacters,read}`
envelope without clipping event fields. A one-event request is not a small-payload
guarantee: the SDK has no event-body offset. Each fragment rereads the whole native
event page, serializes it and slices in memory; it does not save a copy or use an
LRU, artifact, or history cache. This is the user-accepted giant-event tradeoff,
not a pending requirement for a native-copy store or another automatic retry path.

Repeat the identical native query, still with `limit:1`, with `page_offset:nextPageOffset` and
`page_version:pageVersion` until the next offset is null. Concatenate the `json`
strings and parse once to recover the complete page, including its cursors.
Offsets and `pageCharacters` count JavaScript string code units, not UTF-8 bytes or
tokens. The version hashes the normalized native query and complete page, including
its boundaries and bootstrap cursor. Query/content changes and expired fragment
reads fail explicitly; discard earlier fragments and restart or explicitly
resynchronize rather than mixing snapshots. Offsets at or beyond the end are errors;
stop when `nextPageOffset` is null. Markdown uses the same overflow behavior.

Fragment `read:{rpc,events}` reports **this request's** native calls/event count,
not cumulative cost or local serialization work. For a stable page of S characters,
complete delivery takes `ceil(S/8000)` native page reads, serializing S characters
per fragment. Live bootstrap also repeats one native tail call per fragment;
that tail can change even if the event body is unchanged and invalidate the version.
For example, 51,378 characters take seven page reads and 359,646 page-serialization
characters (plus seven tail calls if live bootstrap). These are not measured wire
bytes, SDK-internal I/O, or model tokens. All reads still obey the existing MCP
transport's 25 MiB response limit; no arbitrary-size delivery is promised.

`source:"live"` requires an already loaded handle and supports native type/agent
filters. `bootstrap:true` on a fresh backward query captures a separate
`liveCursor` before reading the page. Use it with `direction:"forward"` to catch
up; duplicate event IDs may overlap the initial page. `include_ephemeral` defaults
false in MCP; enable it only for live forward reads. `wait_ms` is at most 1000.
There is no guaranteed replay of a missing ephemeral delta.

### Exact subagent reads

Use the native agent ID and, for older native envelope ownership, the spawning
tool call ID obtained from events:

```json
{"session_id":"TARGET_SESSION_ID","source":"live","agent_ids":["NATIVE_AGENT_ID","NATIVE_TOOL_CALL_ID"],"limit":16,"response_format":"json"}
```

This is native event filtering, not a tasks-list or whole-history scan. The
passive API has no equivalent filter, so such an unloaded request explicitly
requires loading rather than pretending to be an exact passive query. Child
details do not fabricate current task status or read the whole task registry.
The retired `operation`, `details`, `tool_call_id`, `before_message_id`, and
`after_message_id` inputs return a migration error. Retired HTTP history routes
return `410 CHAT_PROTOCOL_CHANGED`. See [the protocol lifecycle](../../docs/native-chat.md).

### Session A sends to and reads B

1. `cockpit_list_sessions` — find B.
2. `cockpit_send_prompt {session_id:"B",text:"From A: please review …"}`.
3. `cockpit_get_session {session_id:"B"}` — inspect progress/decisions.
4. `cockpit_read_session {session_id:"B",response_format:"json"}` — read B's reply.

Send defaults to `mode:"enqueue"`; acceptance is not turn completion.
No hook, flow, gate or shared local database is needed.

## Binary upload, download and images

`cockpit_upload_file {path:"/allowed/source/image.png",mime:"image/png"}` reads an
MCP-local file and streams its original bytes to `/upload` (no base64 or whole-video
buffer). Optional `source:"mcp"` is the default; `session_id` associates the file
without sending it. The backend need not share the
source filesystem. Returned `path` is a **backend path**, not an MCP-local path.
The shared `UploadedFile` result preserves `kind`, display `name`, `url`, `path`,
`mime`, `size` and optional `storedName`, `createdAt`, `sha256`, `source`, `sessionId`,
`sourceId` and `sessions`. The MCP result also includes `markdown`
and `attachment`.

**To show a generated file or image to the user:** upload it, then copy the
returned `markdown` into the assistant reply. Images use `![name](/uploads/...)`;
files use `[name](/uploads/...)`. For two images, upload both and include both
Markdown values. No extra skill or prompt sent back into the same session is
needed. A server path such as `/home/.../files/chart.png` is not a browser URL:
never invent local, `file:` or `sandbox:` links.

**To send the file as input to another session:** pass the returned `attachment`
object with the caption:

```json
{
  "session_id":"B",
  "text":"Review this image",
  "attachment":{"kind":"image","name":"image.png","url":"/uploads/safe-image.png"}
}
```

Pass this to `cockpit_send_prompt`; generic `prompt` uses the same `attachment`
with `sessionId` instead of `session_id`. Text may be empty with an attachment.
Only `/uploads/<safe-basename>` is accepted; never send arbitrary URLs or local
paths. The backend resolves authoritative metadata/path and supplies a **native
file attachment** to the agent; client metadata is not trusted as filesystem authority.
Native file delivery supplies a tagged path, not automatically read content; the
receiving agent must explicitly read/view it. The backend gives new stored media
a safe suffix derived from byte-verified MIME for native `view`, keeping the
original display filename separately. Do not infer authoritative MIME from the
display filename or URL: use returned metadata or `files/get`.

For multiple files, use `attachments:[attachment1,attachment2]` (1–20, in order
before `text`). For interleaved content use `text:""` with
`parts:[{type:"text",text:"Before"},{type:"file",attachment:attachment1},{type:"text",text:"After"}]`.
Parts preserve order, with 1–100 parts and at most 20 files. `attachment`,
`attachments` and `parts` are mutually exclusive. Media transport support does not
guarantee that the selected model can interpret each format.

### Find and reuse retained files

Use `cockpit_call_intent` with the known file contracts below. If needed,
`cockpit_capabilities {prefix:"files/"}` discovers names; a detail query with
`name` supplies a missing schema. Neither is a mandatory per-call preflight:

- `files/list {query?,sessionId?,limit?,offset?}` returns metadata `files`,
  `hasMore` and optional `nextOffset`; `limit` is at most 100. Optional bounded
  `errors:[{url,error}]` reports unreadable entries and is preserved by the generic tool.
- `files/get {url}` returns the selected file's authoritative metadata.
- `files/associate {url,sessionId}` adds an association without sending or copying.

To publish an image, upload an existing local original or reuse a managed URL.
The producing tool should save a local original when publication is needed.
Native-only tool-image lookup is retired: `session/tool-image` and
`files/from-tool-image` return HTTP 410 instead of scanning history. Chat reads
omit internal image bytes and never collect them. Existing retained images
remain usable; displaying their links again does not publish another copy.

Files have **no automatic expiry** and survive session deletion. They are not
anonymous public links: public-host `/uploads` downloads are protected by passkey
authentication, while MCP uses the configured internal backend/authentication
boundary. Existing local artifact-root restrictions still apply to uploads.

`cockpit_download_file` fetches **only this backend's** safe `/uploads/<basename>`:

```json
{
  "url":"/uploads/1788750000000-a1b2c3d4e5f6.png",
  "path":"/allowed/downloads/image.png",
  "name":"Display name.png",
  "response_format":"json"
}
```

The destination must be an absolute path under an allowed, existing local
download directory. Existing files are **never overwritten**. URLs with origins,
queries, fragments, escaping or traversal are rejected, as are redirects.
Source/destination symlink escapes are fenced. Secure filesystem anchoring fails
closed where descriptor-relative directories and `O_NOFOLLOW` are unavailable.
Transfers retain the explicit **25 MiB** byte limit and a deadline covering headers
and body; limits also count actual streamed bytes. Uploads read a pinned original
descriptor and reject observed size/timestamp changes. Downloads stream into a
private staging file under the pinned destination directory, verify length and
SHA-256 when the backend supplies a strong hash ETag, fsync, then atomically
hard-link the complete file into place without overwrite. Failures clean up only
their own staging files. Legacy downloads do not require a `files/get` lookup or
hash header. Return metadata includes the local `path`,
original backend `url`, `kind`, display `name`, `mime` and `size`.
Pass `name` from the attachment/upload response to retain a display name when the
download response lacks one. The backend persists original display names and MIME
in exclusive, atomically published metadata sidecars, sniffing actual media MIME
rather than trusting a filename or client MIME hint. Extensionless or mismatched
filenames retain their stored MIME when served. Existing legacy uploads without
sidecars remain readable using their stored basename and extension-based MIME;
they are not rewritten. Missing or corrupt metadata for new uploads fails explicitly.
Serving remains sandboxed, `nosniff`, and bounded to 25 MiB.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `COCKPIT_URL` | `http://127.0.0.1:8771`; use an authenticated gateway for remote access |
| `COCKPIT_PORT` | `8771`, used only when `COCKPIT_URL` is unset |
| `COCKPIT_API_TOKEN` | Optional gateway credential; `Authorization: Bearer …` on **every** HTTP request |
| `COCKPIT_TIMEOUT_MS` | Positive integer override; otherwise 10s routine/native-page/transfer requests and 45s load-aware intents |
| `COCKPIT_UPLOAD_DIRS` | Additional absolute local upload roots, separated by the platform path delimiter; defaults are system temp, `/tmp`, `/var/tmp`, `~/.copilot/session-state` and `~/.copilot/cockpit-uploads` |
| `COCKPIT_DOWNLOAD_DIRS` | Additional absolute local download roots, separated by the platform path delimiter; default root is MCP's working directory |

These source roots preserve existing session-artifact and temporary-file workflows.
They are publication boundaries for explicitly selected files, not locations used
to read session metadata or transcripts. Do not publish private logs or credentials.
Requests share credentials and timeout configuration; uncertain POSTs are **never
automatically retried**. A timeout may mean the backend is still processing the
operation: inspect state before deciding whether to retry.

The server remains loopback-only behind the operator's authenticated proxy; the
token is for that gateway, not a new Cockpit authentication platform.
Graceful restart retains backend busy/decision/subagent/MCP-operation safeguards.

## Build and register

```sh
pnpm --filter @cockpit/mcp build
pnpm --filter @cockpit/mcp test
```

The workspace dependency must be linked before typechecking. Tests use existing
`node:test`/`tsx`, mock HTTP/HTTPS and configuration before client imports, and
connect MCP through in-memory transports. They never listen or issue live HTTP
requests; file-transfer fixtures are created and cleaned inside the MCP package.

Example MCP configuration (replace paths/URL for your installation):

```json
{
  "mcpServers": {
    "cockpit": {
      "command": "node",
      "args": ["/path/to/cockpit/apps/mcp/dist/index.js"],
      "env": {"COCKPIT_URL":"http://127.0.0.1:8771"}
    }
  }
}
```

Enable the MCP manually on sessions that should use the backend. Supply credentials
through your environment/secret configuration, not committed source files.

## Breaking migration

- Removed Cockpit-owned `hook/*`, `flow/*`, `flow-schedule/*`, gate authoring and
  their `cockpit_hook_*` / `cockpit_flow_*` tools. Retired requests error rather
  than becoming silent no-ops. Native Copilot `schedule/add|list|stop` remains.
- Removed `session/set-spawned-by`. New sessions accept `cwd` only;
  `spawned_by`/`spawnedBy` is no longer a creation setting.
- Removed local transcript folding and the `COCKPIT_SESSION_STORE`,
  `COCKPIT_SESSION_STATE_DIR`, and backend-state `COCKPIT_HOME` configuration.
- `cockpit_read_session` no longer accepts turn `offset`, `assistant_view`, or
  `exclude_skill_context`, and no longer returns `turns`/local diagnostic fields.
  Migrate to native `events`, source/direction and opaque cursor pagination above.
- Both API and generic MCP `session/delete` and its `session/purge` alias require
  `confirm:true`. Semantic delete/purge tools use the already-destructive purge
  wire name for staggered releases. Trash/restore are retired; removing old trash
  marks unhides native sessions, without deleting their history or managed files.

## Native session fork

Use `cockpit_call_intent({name:"session/fork",body:{sessionId:"source-id",name:"Independent goal"}})`.
If the schema or backend publication is unknown, discover it explicitly with
`cockpit_capabilities({name:"session/fork"})`; invocation itself sends only one POST.
The source must already be loaded and idle without timers; inherited schedule
history is refused. Optional `toEventId` excludes that root user-message event
and later history. The returned `sessionId` belongs to an unloaded, independent
conversation, **not** an independent working directory. Do not retry an uncertain
fork automatically. See [native fork semantics](../../docs/session-fork.md).
