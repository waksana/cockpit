# Cockpit API/MCP session client (`@cockpit/mcp`)

A **stdio MCP server backed by the Cockpit API**: remote Copilot plus GUI-specific functions.
The backend owns one capability set, shared by the web UI and sessions using MCP.
This is not a maintainer-only database salvage service or a policy engine.

All session metadata, lists, trash, transcripts and mutations come from HTTP.
The MCP process needs **no backend filesystem access, SDK, session database or event
logs**. Backend failures are errors, never successful local-state fallbacks.
Local files are accessed only for explicit upload/download operations.

Binary: `cockpit-mcp-server` → `dist/index.js`. Requires Node ≥22.12; raw Node 24 is
supported without a TypeScript loader. Canonical wire types come from the
`@cockpit/protocol` workspace dependency using **type-only imports**.

## Discover and invoke the API

`GET /capabilities` lists the actual protocol `Intents`, with names, descriptions,
and a transport inventory. `prefix`, `limit` (1–100), and `offset` bound the listing.
`GET /capabilities?name=session/peek` returns one intent's `inputSchema` and
`resultSchema`, generated from the backend's Zod protocol schemas as JSON Schema
draft-07. Name detail cannot be combined with listing parameters.

| MCP tool | Purpose |
| --- | --- |
| `cockpit_capabilities` | List names (default 50), filter/page, or request one `name` and its schemas |
| `cockpit_call_intent` | Invoke any published `name` with its exact API `body` |
| `cockpit_get_snapshot` | Read `runtime/snapshot`: agent readiness, models, sessions and permission policy |
| `cockpit_service_status` | Fixed `operation`: `health` or `status` |
| `cockpit_service_restart` | Arm/cancel a graceful restart with `pending` and mandatory `confirm:true` |

Example:

```json
{"name":"session/peek"}
```

Pass that to `cockpit_capabilities`, then call `cockpit_call_intent`:

```json
{"name":"session/peek","body":{"sessionId":"TARGET_SESSION_ID","limit":20}}
```

The generic caller checks the named capability on the backend before each POST.
There is no arbitrary URL, HTTP method or path proxy. Unknown/retired commands,
path traversal, redirects and mismatched capability responses fail. New published
intents need no new MCP wrapper. Bodies use the API's **camelCase** field names;
the backend remains the validation authority, including `confirm:true` on
`session/purge`. Generic results are complete JSON; use semantic pagination when
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

| Area | Tools |
| --- | --- |
| Session reads | `cockpit_get_snapshot`, `cockpit_list_sessions`, `cockpit_list_trash`, `cockpit_read_session`, `cockpit_get_session`, `cockpit_get_panels`, `cockpit_get_plan` |
| Lifecycle | `cockpit_new_session`, `cockpit_delete_session` (trash), `cockpit_restore_session`, `cockpit_purge_session`, `cockpit_unload_session`, `cockpit_reload_session`, `cockpit_rename_session`, `cockpit_set_session_pin` |
| Conversation | `cockpit_send_prompt`, `cockpit_cancel_turn`, `cockpit_remove_queued` |
| Interaction requests | `cockpit_respond_ask`, `cockpit_respond_plan`, `cockpit_plan_supersede`, `cockpit_respond_elicitation` |
| Model/session settings | `cockpit_set_model`, `cockpit_set_mode`, `cockpit_compact_session`, `cockpit_rewind_session` |
| Manual MCP settings | `cockpit_list_session_mcp`, `cockpit_set_session_mcp`, `cockpit_list_global_mcp`, `cockpit_set_global_mcp_default`, `cockpit_refresh_mcp`, `cockpit_reload_session_mcp` |
| Manual skills | `cockpit_list_session_skills`, `cockpit_set_session_skill`, `cockpit_list_global_skills`, `cockpit_refresh_skills` |
| Native Copilot schedules | `cockpit_schedule_add`, `cockpit_list_schedules`, `cockpit_stop_schedule` |
| Files | `cockpit_upload_file`, `cockpit_download_file`, `cockpit_list_dir` |

Generic invocation also covers surviving API operations without semantic wrappers,
such as `inbox/seen`, `push/subscribe`, `speech/token`, `session/refresh`, and
`skills/read`. Both `session/history` and `session/peek` return synchronous JSON.

`cockpit_get_session` returns current backend state and the queue/decision IDs used
by action tools. `mcp/session` does not materialize an unloaded session.

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
MCP reload and cold session resume restore global defaults. Skill definition
reload retains current session choices, but cold resume restores native global
selection. Global changes do not automatically mutate loaded sessions.
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
`cockpit_get_plan` renders canonical `planMarkdown`, `todos` and optional
`changedFiles`; `cockpit_get_panels` renders `label`, `sublabel` and `enabled`.
`cockpit_list_global_skills` accepts optional backend `cwd`; omitting it uses the
**server home**, never the MCP client's working directory.

`cockpit_rewind_session` rewinds history with `confirm:true`; file changes are
left alone by default.
File rollback is a native runtime operation: semantic `rollback_files:true` and
generic `session/rewind {rollbackFiles:true,...}` delegate capability validation to
the backend. Unsupported operations and native conflicts must fail explicitly
rather than ignoring the requested file rollback.

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
The UI also offers the action beside manual renaming.

The first effective completed reply can trigger one automatic attempt after the
session settles. Historical replies are not retroactively named on startup or
history viewing. Progress and naming errors are transient UI state; the title's
only persistent owner is Copilot.

## Canonical transcript pagination

`cockpit_read_session` calls **`session/peek`**, which reads a loaded session's live
fold or the backend's read-only preview for an unloaded/trashed session. It does
not restore a trashed session or create an active session.

```json
{"session_id":"TARGET_SESSION_ID","limit":40,"response_format":"json"}
```

The JSON result contains `sessionId`, backend `title`/`cwd`, canonical `messages`,
`hasMore`, `returned`, `source:"api"`, and `nextBeforeMsgId`.
The first page is the newest messages, ordered oldest-first within that page.
Pass `nextBeforeMsgId` as `before_message_id` to read older pages.
Messages preserve their IDs, timestamps, roles, tools, attachments, thought fields
and nested subagent messages; MCP does not fold or synthesize transcript content.

Oversized pages return a bounded `{format:"json-fragment",json,pageVersion,pageOffset,
nextPageOffset,pageCharacters}` envelope instead of clipping message fields.
Repeat the same session/cursor/limit with `page_offset:nextPageOffset` and
`page_version:pageVersion` until the next offset is null. Concatenate the `json`
strings and parse once to recover the complete page. The version hashes the
complete canonical page; if it changes, continuation fails explicitly. Discard
earlier fragments and restart from offset zero rather than mixing snapshots.
Prefer a smaller `limit` when reading an actively changing transcript.
Markdown mode presents the same canonical JSON and also uses fragments on overflow.

For a live session, use `operation:"history"` to call `session/history` instead.
Both reads are passive: no runtime loading or SSE query broadcasts. `HistoryPage` has `sessionId`,
`messages`, `hasMore`, optional `latest` and `append`, **not** peek's `title`/`cwd`.
The semantic result adds the same pagination helpers plus `nextAfterMsgId` for
resuming a tail via `after_message_id`. Before/after cursors are mutually
exclusive; `after_message_id` requires history. `limit` is an integer from 1–200.
Generic calls use `beforeMsgId`/`afterMsgId` and return the unwrapped HistoryPage.
There is no `session/history-page` event to wait for.

### Summary cards and explicit subagent reads

Pass `details:"summary"` to avoid downloading nested transcripts and task prompts
with the root conversation. A subagent summary carries `subagent.toolCallId`:

```json
{"session_id":"TARGET_SESSION_ID","details":"summary","response_format":"json"}
```

Use that exact ID to read the child transcript on demand:

```json
{"session_id":"TARGET_SESSION_ID","operation":"subagent","tool_call_id":"NATIVE_TOOL_CALL_ID","limit":30,"response_format":"json"}
```

This wraps `session/subagent-history` with camelCase `sessionId` and `toolCallId`.
The result includes the child's metadata and a page of direct messages; nested
children are summaries by default. Cursor and JSON-fragment continuation work as
for root history. Both modes are passive, including unloaded and trashed sessions.
Omitting `details` on root reads preserves the previous full-transcript behavior;
explicit `details:"full"` also includes descendants in a child read.
Child reads reuse native cursor checkpoints when the parent was already read.
A direct child-ID query without that cache may require a full passive scan; its
default MCP deadline is 120 seconds, with no automatic retry. `COCKPIT_TIMEOUT_MS`
still overrides all deadlines.

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

Use `cockpit_capabilities {prefix:"files/"}` and `cockpit_call_intent`:

- `files/list {query?,sessionId?,limit?,offset?}` returns metadata `files`,
  `hasMore` and optional `nextOffset`; `limit` is at most 100. Optional bounded
  `errors:[{url,error}]` reports unreadable entries and is preserved by the generic tool.
- `files/get {url}` returns the selected file's authoritative metadata.
- `files/associate {url,sessionId}` adds an association without sending or copying.
- `files/from-tool-image {sessionId,image,name?}` explicitly retains one native
  tool image selected from history. `image` contains `eventId`, `toolCallId`,
  `part`, and optional `cursor`/`count` from its reference, not image bytes or
  presentation fields such as `mime`. Inspect the capability for the exact schema.
  The returned `kind/name/url/size/mime` can be used as an attachment or downloaded.
  This operation does not rewrite native history or retain unrelated tool images.

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
| `COCKPIT_TIMEOUT_MS` | Positive integer override; otherwise 10s routine/transfer requests, 45s load-aware intents including `session/peek` |
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
  Migrate to canonical `messages` and `before_message_id` pagination above.
- Both API and generic MCP `session/purge` require `confirm:true`. The confirmed
  semantic purge tool forwards it. Trash/restore and existing history/files remain
  available; this refactor does not migrate or delete stored session data.

## Native session fork

Use `cockpit_capabilities({name:"session/fork"})`, then
`cockpit_call_intent({name:"session/fork",body:{sessionId:"source-id",name:"Independent goal"}})`.
The source must already be loaded and idle without timers; inherited schedule
history is refused. Optional `toEventId` excludes that root user-message event
and later history. The returned `sessionId` belongs to an unloaded, independent
conversation, **not** an independent working directory. Do not retry an uncertain
fork automatically. See [native fork semantics](../../docs/session-fork.md).
