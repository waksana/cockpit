# Native session fork

Cockpit exposes the installed SDK's experimental `sessions.fork` RPC as
`session/fork`. The validated pair is **SDK 1.0.13 / bundled runtime 1.0.83,
protocol 3**. The separately installed `copilot` CLI is not the server runtime.
Cockpit delegates history copying to native.
This is the canonical fork behavior guide. See the [documentation index](README.md).

## Call paths

Fork is available through HTTP, the generic MCP caller, and **Session settings →
Session operations** in the Web UI. The Web action forks the full current
history; it does not offer a per-message boundary or alter Task responsibility.
Its confirmation explains the shared workspace and cold-resume configuration.
The backend creates an **unloaded** child and emits
the normal `session/added` event; it sends no prompt. The child can subsequently
be selected from the ordinary session list or the explicit **Open new session**
link after a confirmed result. Settings stay on the parent until that selection.
An unconfirmed response retains a warning instead of claiming creation or
automatically retrying.

API discovery: `GET /capabilities?name=session/fork`.

```http
POST /intent/session/fork
Content-Type: application/json

{"sessionId":"source-id","toEventId":"root-user-event-id","name":"Independent goal"}
```

Response: `{"sessionId":"new-child-id"}`. Only `sessionId` is required.
Omitting `toEventId` includes the full persisted history. When supplied it must
be a **root user-message event ID**, obtainable as that user message's `id` in
the `events` array of `session/chat`. The event itself and everything after it are
**excluded**. Assistant IDs, nested-agent user messages, unknown IDs, empty
prefixes and boundaries containing unfinished work are rejected.

MCP uses the same registry, with no separate history implementation:

```json
{"name":"session/fork","body":{"sessionId":"source-id","name":"Independent goal"}}
```

Pass that to `cockpit_call_intent`. If the schema or backend publication is
unknown, first read `cockpit_capabilities({name:"session/fork"})`; this is
explicit discovery, not a mandatory preflight for each call. Discover the child through the
normal session list, read its history passively, and send its **new goal**
explicitly when ready. A prompt or explicit reload resumes it.

### MCP connection behavior

The existing `cockpit_call_intent` tool accepts a generic `name` and JSON `body`.
It sends **one POST**, without reading `/capabilities` first. The backend
authoritatively validates the intent name, body and result. It neither caches a tool-name
allowlist nor requires a dedicated `cockpit_fork_session` tool. Backend publication
is enough for an already-connected client to discover and invoke `session/fork`;
no MCP discovery refresh, forced reconnect, or discussion-session migration is
required to acquire this intent.

For an existing MCP client, use:

1. If publication or schema is unknown, read `cockpit_capabilities({name:"session/fork"})`.
   A 404 means the backend has not published the change; refreshing MCP
   configuration cannot fix that. Skip this discovery when the contract is known.
2. Inspect the intended **source session** with `cockpit_get_session`. It must be loaded
   and idle without timers. Do not use the currently running initiating session
   itself as the source, and do not cancel a busy source to make it forkable.
3. `cockpit_call_intent({name:"session/fork",body:{sessionId:"source-id",name:"New independent goal"}})`.
4. Send any intended new message to the returned ID through `cockpit_send_prompt`.
   Fork itself sends none. Inherited text is conversation context, not a new
   instruction or authorization to act.

Fork requests use the normal 45-second long-operation deadline unless the
client has an explicit timeout override. Do not force-reload a busy session or
blindly retry a timed-out fork.

`mcp/refresh` rereads native MCP definitions; it does not restart the Cockpit
backend or replace code in running MCP processes. `mcp/reload-session` reconnects
an idle session's MCP servers and reapplies native global defaults, potentially
changing temporary per-session choices. Neither is required for this dynamic
intent. Any separately authorized graceful **backend** restart is distinct: its
runtime connections end, and a later ordinary session resume reconnects using
native configuration; this must not be described as every existing connection
automatically receiving a hot update.

## Safety and inheritance

| Surface | Actual behavior and Cockpit boundary |
| --- | --- |
| Source activity | Cockpit requires an already loaded, idle source: no turn, decision, active task, queue, steering, timer or protected operation. It never auto-resumes, aborts, unloads or cancels the source. Native RPC itself also permits some busy sources; Cockpit deliberately does not. |
| Parent history | Existing events are unchanged. Native fork appends one `session.info` fork provenance record to the loaded source. |
| Conversation | Native copies the selected event prefix. Parent and child can subsequently receive independent turns. The child ID is new. |
| Model and mode | Native persisted model/mode are restored on cold resume, at the chosen event boundary. They are not copied from Cockpit's current sidebar projection. |
| cwd and files | The child retains the same working directory. This does **not** create a Git branch, worktree, filesystem snapshot or credential sandbox. `cwd` overrides are rejected rather than silently ignored. For an isolated workspace, use an independently prepared worktree and `session/new`; this fork API does not relocate native sessions. |
| Skills and MCP | Cold-resume discovery/configuration applies. The fixture confirms source session-only disabled skill/MCP choices do not carry over; global configuration still applies. This is not a full runtime-settings clone. |
| Plans and todos | Native copies the current `plan.md`, **even when the event boundary predates that plan**. The fixture's SQL todo row does not carry over. Treat inherited plans as context, not a new assignment or a point-in-time filesystem snapshot. |
| Tasks and queue | The fixture's active shell task and paused queued prompt do not carry into the child's live task/queue registries; the parent's registries are not changed by fork. Cockpit copies no pending callback or decision, and sends no automatic message. Business notification receipts and scheduling policy are outside this adapter. |
| Schedules | Native **does** recreate inherited schedules on resume. Cockpit therefore rejects any selected prefix containing `session.schedule_created`, even if that schedule was later stopped. It also rejects sources with currently active timers. A boundary before schedule creation is supported once the source has no live timers. No journal rewriting or post-resume cancellation race is used. |

The operation is **non-idempotent**. Neither API nor MCP automatically
retries it. On a timeout or lost acknowledgement, a child may already exist:
inspect the authoritative session list before deciding what to do. A unique
optional `name` helps identify the result. Errors preserve the native reason;
an uncertain response is not proof that no child was created.

### History preflight reads

The preflight uses the loaded source's native `eventLog.read`, forward from the
beginning, with all agents and durable events only. Its fixed type filter follows
the safety reducer rather than the chat display:

| Event types | Safety dependency |
| --- | --- |
| `user.message` | Existing root conversation and exclusive root-user boundary, including legacy ownership markers |
| `assistant.turn_start`, `assistant.turn_end`, `abort` | Unfinished root turn; a child abort must not settle the root turn |
| `tool.execution_start`, `tool.execution_complete` | Pending tool-call IDs across all agents |
| `subagent.started`, `subagent.completed`, `subagent.failed` | Pending spawn tool-call IDs, including cancelled completions |
| `session.schedule_created` | Any inherited timer creation, including self-paced timers; cancellation/rearming never makes an unsafe prefix safe |

Each continuation retains this exact filter and passes the opaque native cursor
back unchanged. There is no history cap, wildcard retry or persisted-read
fallback. Invalid boundaries, expired/stalled cursors and read failures still
fail closed; an ID of an excluded event type is not found, not accepted.
Fresh activity/lifecycle checks around the scan and the final queue/timer checks
remain independent of history filtering.

Unrelated assistant bodies and other unused event types no longer cross the
preflight read boundary. This is **not an ID-only API**: required user/tool
events still include their full native payloads and can be large. Calls decrease
when fewer returned events need pagination; native internal filtering/scanning
cost is not measured or claimed to decrease.

## Local regression fixture

From `packages/core`, run:

```bash
COCKPIT_NATIVE_FORK=1 node --import tsx --test src/fork-native.test.ts
```

This uses an isolated temporary HOME/state/cwd, an ephemeral loopback-only
deterministic BYOK provider, a synthetic local MCP server, and no logged-in
credentials. It covers native inheritance and the Engine API, distinct history
boundaries, passive child discovery, separate continuation and schedule refusal.
It never forks a real user conversation or connects to production data/ports.

The full MCP-to-native regression runs from `apps/mcp`:

```bash
pnpm build
COCKPIT_NATIVE_FORK=1 node --import tsx --test src/fork-native.test.ts
```

It starts the built stdio MCP executable, real Fastify intent server, Engine and
bundled native runtime against an isolated local deterministic provider. One MCP
connection first observes fork as unpublished, then discovers it without changing
its tool catalog or reconnecting. It creates a real native child through
`cockpit_call_intent`, checks the returned ID and exclusive history boundary, and
continues parent and child separately through `cockpit_send_prompt`.
