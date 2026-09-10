# Native session fork

Cockpit exposes the installed SDK's experimental `sessions.fork` RPC as
`session/fork`. The validated pair is **SDK 1.0.13 / bundled runtime 1.0.83,
protocol 3**. The separately installed `copilot` CLI is not the server runtime.
There is no dependency upgrade, transcript reconstruction, database copying by
Cockpit, or summary-as-fork fallback.

## Call paths

The session menu in both the sidebar and chat has **分叉为独立会话**. It forks
the full conversation after the existing confirmation dialog explains shared
files. The backend creates an **unloaded** child and emits the normal
`session/added` event; the UI navigates to its history without sending a prompt.

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

Pass that to `cockpit_call_intent`, after reading
`cockpit_capabilities({name:"session/fork"})`. Discover the child through the
normal session list, read its history passively, and send its **new goal**
explicitly when ready. A prompt or explicit reload resumes it.

### Already-connected discussion sessions

The existing `cockpit_call_intent` tool accepts a generic `name` and JSON `body`.
It reads `/capabilities?name=...` on **each invocation**, then sends the original
body to the backend for authoritative validation. It neither caches a tool-name
allowlist nor requires a dedicated `cockpit_fork_session` tool. Backend publication
is enough for an already-connected client to discover and invoke `session/fork`;
no MCP discovery refresh, forced reconnect, or discussion-session migration is
required to acquire this intent.

For an existing discussion session, use:

1. `cockpit_capabilities({name:"session/fork"})`. A 404 means the backend has not
   published the change; refreshing MCP configuration cannot fix that.
2. Inspect the intended **old owner** with `cockpit_get_session`. It must be loaded
   and idle without timers. Do not use the currently running discussion session
   itself as the source, and do not cancel a busy source to make it forkable.
3. `cockpit_call_intent({name:"session/fork",body:{sessionId:"old-owner-id",name:"New independent goal"}})`.
4. Send the explicit new assignment to the returned ID through
   `cockpit_send_prompt`, including the new goal/workstream and
   its actual discussion session ID as `caller_session_id`. Inherited historical
   assignments and callback obligations are not renewed authorization.

The MCP build also gives fork requests the normal 45-second long-operation
deadline. An already-running older MCP process retains its previous timeout
(10 seconds unless configured otherwise); it does **not** hot-load rebuilt
JavaScript. This is not a schema blocker. A future normal connection gets the new
deadline. Do not force-reload a busy discussion or blindly retry a timed-out fork.

`mcp/refresh` rereads native MCP definitions; it does not restart the Cockpit
backend or replace code in running MCP processes. `mcp/reload-session` reconnects
an idle session's MCP servers and reapplies native global defaults, potentially
changing temporary per-session choices. Neither is required for this dynamic
intent. The already-authorized graceful **backend** restart is separate: its
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
| Tasks and queue | The fixture's active shell task and paused queued prompt do not carry into the child's live task/queue registries; the parent's registries are not changed by fork. Cockpit copies no pending callback, decision, attention receipt or scheduling preference, and sends no automatic task or old receipt. |
| Schedules | Native **does** recreate inherited schedules on resume. Cockpit therefore rejects any selected prefix containing `session.schedule_created`, even if that schedule was later stopped. It also rejects sources with currently active timers. A boundary before schedule creation is supported once the source has no live timers. No journal rewriting or post-resume cancellation race is used. |

The operation is **non-idempotent**. Neither Web, API nor MCP automatically
retries it. On a timeout or lost acknowledgement, a child may already exist:
inspect the authoritative session list before deciding what to do. A unique
optional `name` helps identify the result. Errors preserve the native reason;
an uncertain response is not proof that no child was created.

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
