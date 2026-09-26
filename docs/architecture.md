# Architecture

Cockpit is a single Web/API service that drives native GitHub Copilot through the
official SDK. This page describes the current source; requirements are in
[R1–R8](product-requirements.md). A running instance's identity is its
`/version`, `/health` and package.

<a id="source-status"></a>
## Overview

```text
browser ── authenticated HTTPS gateway ──┐
                                         ├─ Cockpit HTTP/SSE ── Engine ── official SDK
MCP client ── same backend API ──────────┘                                  │
                                                                   JSON-RPC / stdio
                                                                            │
                                                                native Copilot runtime
```

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Input/result schemas, typed `Intents`, native events and the shared Web fold. |
| `packages/core` | The `Engine` facade: SDK handles, real callbacks, in-flight operations, native adapters and safety guards. `SessionKernel` (`kernel.ts`) owns per-session handles, admission and transition gates; focused services (roles, skills, MCP, schedules, resource reads, native events, decisions, controls, settings, preparation) share it. |
| `packages/module-api` | Public TypeScript interfaces between host and modules; holds no business or native state. |
| `apps/server` | Fastify HTTP/SSE, static Web, module host and CLI, instance info and graceful shutdown. |
| `apps/web` | React UI: current event window, drafts, reading position, native controls and local error feedback. |
| `apps/mcp` | Generic stdio-to-HTTP MCP client; not a per-module MCP host and never reads native databases. |

The SDK and native runtime versions are pinned in `packages/core/package.json` and
checked at startup in [`runtime.ts`](../packages/core/src/runtime.ts); the runtime
is out of process and may spawn MCP and tool subprocesses. Server and core run as
TypeScript through an explicit loader; Web and MCP are built.

Runtime calls share one connection. Only connect/stop are exclusive; the runtime
orders create/resume/attach/close/delete per session, and Engine admits one
create/resume/fork at a time. Read-only probes (list, metadata, auth, models) take
no lifecycle gate, so a slow resume does not delay snapshot, status or `/health`.
The reasons live beside the gates in `runtime.ts`.

The backend exposes a chosen subset of native capabilities; the Web UI uses a
subset of the API, and MCP is another API consumer. Neither needs one-to-one
coverage. The authoritative API list is the `Intents` registry and a running
instance's `GET /capabilities`.

Modules are trusted local packages imported into the host process and loaded
cold: installation, version selection and enable/disable apply at the next start.
There is no hot loading, hot enable/disable or hot update, and no framework
reserved for it. See the [module contract](module-contract.md).

### What the thin layer keeps

| Layer | Purpose |
| --- | --- |
| Native operation adapters | Sessions, models, messages, queue, decisions, plans, schedules, MCP/skills — calling real SDK capabilities without a second authoritative state. |
| Remote access and interaction | HTTP/schema, SSE, Web, reading window, text drafts, errors, and `fs/listDir` for choosing a cwd (a host filesystem adapter, not a file-transfer feature). |
| Service resources | Package version, instance/health, activity queries, request protection and graceful exit. |

Snapshots, resource projections, cursors and response-size adaptation use
request- or connection-scoped state only. Adapters never report a queued
acceptance as applied, and a failed follow-up read never erases a confirmed effect.

<a id="native-authority"></a>
## Native authority

Copilot alone owns sessions, history, model context, execution and queues. The
backend keeps no chat window, resource snapshot, native switch copy or private
database fallback. It retains only live SDK handles/subscriptions, call and
shutdown promises, send/interaction identities, pending decision callbacks,
version/instance info, bounded HTTP buffers and concurrency guards — all released
with their request or connection.

- Metadata is read on demand; resource events only invalidate consumers.
  `session/list`, snapshot, `session/resources`, single panels and details keep
  their projection granularity. An unrequested field is not "empty", unloaded
  sessions carry no cached runtime state, and an unknown cwd is never guessed.
- Model choices come from native candidates and capabilities; explicit empty/false
  is never widened by fallback. A model switch sends one explicit parameter set;
  omitted options take native meaning, not the old current value.
- Model, mode, compaction and rewind responses keep the native `result`: outer
  `ok:true` only means the native call returned. `deferred:true` wins over
  `status:"applied"` — the change is still queued and `modelState` may be old.
  Rejections, needs-action, persistence errors and partial rewinds are reported
  as such; no follow-up prompt is sent automatically.
- `session/new` returns the real native ID and sends nothing. An empty,
  never-messaged session may vanish when unloaded and is not recreated.
  All callers use the [Cockpit default new-session model](#session-default-model);
  resume, reload and fork do not apply this preset.
- Native idle timeout is 30 minutes; future schedules do not keep a session
  loaded. Unloading pauses schedules and relative delays restart on resume.
- Global MCP/skill settings and cold resume follow native configuration; the
  global disabled-skill list is read from native user settings for create/resume,
  not stored separately.
- Schedule creation validates the raw single-line prompt first; if creation
  cannot be confirmed, the result says it may have been created and is never retried.

<a id="error-codes"></a>
## Error codes

A failed intent responds `{ error, code? }`. `error` is human-readable and may
change; clients branch on `code` and the HTTP status. Every code and its status
live in `ErrorCodes` (`packages/protocol/src/errors.ts`); Engine throws
`CockpitError` (`packages/core/src/errors.ts`), whose status comes from that table.

| Status | Codes | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_INTENT_BODY`, `INVALID_DIRECTORY_PATH` | Invalid input; nothing was attempted. |
| 404 | `SESSION_NOT_FOUND`, `SKILL_NOT_FOUND`, `MCP_NOT_FOUND`, `ROLE_NOT_FOUND`, `QUEUE_ITEM_NOT_FOUND`, `UNKNOWN_INTENT` | The addressed item does not exist. |
| 409 | `SESSION_BUSY`, `SESSION_TRANSITION`, `SESSION_UNLOADED`, `REQUEST_NOT_PENDING`, `STALE_SESSION_CONTROLS`, `STATE_CONFLICT` | Current state rejects the request; retry only after it changes. |
| 409 | `SESSION_CREATION_INCOMPLETE`, `SESSION_CREATION_UNCERTAIN` | Creation effect is uncertain; the body carries `sessionId`. Inspect it, never retry blindly. |
| 499 | `REQUEST_ABORTED` | The client disconnected during a read. |
| 500 | `INVALID_INTENT_RESULT` | Cockpit's result failed its own schema. |
| 501 | `UNSUPPORTED` | The public SDK adapter cannot do this; nothing changed. |
| 503 | `ENGINE_STOPPED`, `UNAVAILABLE`, `SERVICE_CLOSING`, `SERVICE_SHUTTING_DOWN` | Engine, roles or service cannot accept work now. |

A 500 without a code is an unexpected or native-unconfirmed failure: read state
before acting. Intent results that already report uncertainty (for example
`possiblyCreated`, `unconfirmed`) are unchanged. `fs/listDir` filesystem failures
keep their errno code (`ENOENT` 404, `ENOTDIR` 400, `EACCES`/`EPERM` 403), and
module routes use their own `MODULE_*` codes.

<a id="authentication"></a>
## Authentication and trust

Cockpit has no accounts or login. Remote Web/API authentication is the operator's
external gateway; Copilot sign-in belongs to the native runtime; neither replaces
the other. The server listens on loopback. The origin check accepts the same Host,
loopback and `COCKPIT_ALLOWED_ORIGINS`: it is CSRF protection, not authentication.

Native tool permission is always `allow-all`; interactive/plan/autopilot are
interaction modes. Real ask/plan/elicitation decisions and busy guards are kept;
permanent deletion uses the native API. API/MCP add no confirmation fields for
compact, rewind or delete (see [confirmation boundaries](../apps/mcp/README.md#confirmation-boundaries));
the Web UI adds human confirmations. Custom providers (BYOK) are not configurable:
core's `RuntimeOptions.sessionConfig` is a code-level integration point, not a
server setting. This is a single-operator, same-user model — not multi-tenant and
not a sandbox for modules ([security policy](../SECURITY.md)).

<a id="shutdown"></a>
## Graceful shutdown

The service is started directly; restarting after exit is the operator's or
process manager's job. `SIGTERM`, `SIGINT` and

```json
{"name":"system/shutdown","body":{"confirm":true}}
```

(via `POST /intent/system/shutdown` or `cockpit_call_intent`; `confirm:true` is
required) request the same graceful exit. Repeated requests return the accepted
state while running/waiting; a second signal never forces exit. `ok:true` means
accepted, not exited.

States: `running → waiting → closing → closed`, or `failed`. `system/status` and
`GET /status` return fresh native activity plus host shutdown state
(`requestedAt`, errors, protected in-flight HTTP count). In `closing`/`failed`
the global request gate returns HTTP 503 `SERVICE_CLOSING` with shutdown fields;
after exit HTTP is unreachable. `closed` is internal — observe the process for exit.

While waiting, new independent prompts, session creation, fork and configuration
or schedule additions are refused. Answers to existing decisions, queue removal,
Stop/interrupt and schedule stop remain available, as do native reads; accepted
native queue items complete normally. The host waits for native turns,
queue/steering, decisions, subagents, MCP operations and protected calls to
settle, rechecks, then closes idle handles, the SDK and connections. Browser
streams are not waited for; closing a view does not cancel model work.

A known busy race returns to waiting. Unknown close effects or close failure are
not retried or reported as a clean exit; confirmed SDK death or startup failure
records the error, cleans owned resources and exits non-zero, without replaying
possibly accepted input. A session that requests shutdown must end its turn
rather than wait for the exit. Unanswered questions or running work can block
exit indefinitely: there is no cancel, timeout or auto-answer.

Per [R7](product-requirements.md#r7), only native session idleness is waited for;
module activity, sends and close receipts never block exit. The current native
in-flight request protection stays.

`/health` and `/version` share the process instance ID; `/version` reports the
package version and manifest `sourceSha`. Development checkouts instead report
`dev+<shortSHA>` from their own Git root; unversioned source reports
`dev+unknown` and a null SHA. The Web About dialog reads this backend identity.
These are provenance, not authentication or proof of deployment.

## Web client

The Web UI is served by the same package and service. It provides text chat,
Markdown, tools, thinking, subagents, decisions, queue and model settings, plus
session settings, MCP, Skills, and **Session settings → Session operations**:
reload (`session/reload`), unload, compaction and full-history
[fork](../apps/mcp/README.md#session-fork). Sessions are ordered by native activity.
It does not show or switch interaction modes (new sessions use the native default
and opening/sending never rewrites a session's mode), and has no plans/todos,
context/usage, schedules or maintenance pages; the HTTP/MCP capabilities remain.

Interaction rules:

- Operations are limited by known work/connection state and rechecked on click;
  the backend lifecycle guard is authoritative. Closing settings or navigating
  does not cancel submitted work; pending state and errors stay with their target.
- Reload closes and resumes a loaded session, or resumes an unloaded one under the
  same ID; it never creates a replacement, stops work, clears the queue or retries
  an unknown result. Pages that must resume an unloaded session use `session/load`.
- Model controls edit a complete combination and apply it once; the current native
  value and the last submission result are shown separately, and late results do
  not overwrite newer edits.
- Text drafts live only in memory and `sessionStorage`, one record per session
  (text plus an unconfirmed-result flag). A draft is cleared only on explicit
  acceptance with no newer edit; failures and unknown results keep the text and are
  never resent automatically. No `localStorage` or legacy import.
- Chat text uses the browser's native context menu; code and tool details keep copy buttons.

<a id="session-default-model"></a>
### Default model for new sessions

**Global menu → 默认新会话模型** selects the model used only for future new
sessions. Cockpit owns this preference in `$COCKPIT_HOME/config.json`
(`~/.cockpit/config.json` when unset), in `values.sessionDefaults`:

```json
{ "schemaVersion": 1, "revision": 1, "values": { "sessionDefaults": { "modelId": "gpt-6-astra" } } }
```

An absent file or unset `values.sessionDefaults` means `gpt-6-astra`. Saving
under the host storage writer lease preserves unrelated `values`, increments the
revision and atomically replaces the file; it survives refresh and restart.
The earlier flat `{ "modelId": "..." }` format is still read without changing
the selected model and becomes versioned only on explicit save. Reads never
rewrite configuration. Invalid settings, unsupported versions and storage errors
are explicit, not a reset. Copilot's own user configuration is never written.

`settings/session-defaults` returns the saved ID, fresh native model candidates
and `modelError`. A catalog failure returns `models:null` with the saved ID and
error; an unavailable/disabled saved ID stays visible without a substitute.
`settings/session-defaults-set` accepts only `{modelId}` and returns it after a
durable save. A failed or uncertain acknowledgement is not success; read settings
before deciding whether to retry. MCP exposes both through `cockpit_call_intent`.

`Engine.newSession` captures and validates the default once per creation and
passes it explicitly to the SDK, including Web, HTTP/MCP and module callers
(such as Task). Concurrent saves cannot change an already captured selection.
Unavailable models or catalog failures prevent creation, and an unexpected native
model readback yields `SESSION_CREATION_INCOMPLETE` with the created identity:
inspect it, never automatically retry. Model selection still follows native
policy; no claim is made that the preference grants access to a model.

Existing sessions are not visited or switched when saving. Resume/reload/cold
resume and fork keep their native model semantics. Per-session switching remains
available. Only the model ID is preset, not reasoning effort, context tier, mode
or permission policy.

`/events` carries control/invalidation; `/chat/stream` carries the shared
all-agent event window. History, reconnection and media are specified in
[native chat](native-chat.md); frontend extension composition in the
[module contract](module-contract.md).

<a id="target-gap"></a>
## Gaps against confirmed requirements

| Capability | Current | Confirmed target |
| --- | --- | --- |
| Shutdown | Waits for native activity and protected in-flight calls. | Wait only for native sessions; module work and receipts excluded. |
| Module delivery | Local trusted packages, main-process import, cold load; HTTP/static routes, data events, four frontend extension kinds, module-owned HTTP MCP via creation-time roles. | Remote signed installation, per-module MCP paths on one port, content packages. |
| System page | Not implemented. | A full host page from the main menu showing versions and installed/loaded modules read-only, with safe exit ([R6](product-requirements.md#r6)). |
| Next-start message | Not implemented. | An optional module saves a prompt for the next start and makes one send attempt. |
