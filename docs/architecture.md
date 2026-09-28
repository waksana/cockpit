# Architecture

Cockpit is a thin Web/API access and interaction layer over native GitHub Copilot,
with a generic module host. It uses the official SDK rather than owning native
capabilities or state. This page describes the current source; requirements are in
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
is out of process and may spawn MCP and tool subprocesses. Source development runs
server/core TypeScript through an explicit loader; Web and MCP are built.
[Runtime packages](releasing.md#package-contents) ship compiled JavaScript for
server, core, protocol and MCP, plus the built Web UI; no TypeScript loader is needed.

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
| Generic module integration | Verified local packages, installation selections, registrations, role/resource assembly and public Web extension points; module business remains outside the host. |

Backend snapshots, resource projections, cursors and response-size adaptation use
request- or connection-scoped state, not a cross-request native-state mirror.
Preserving accepted/applied/unknown distinctions and confirmed effects after later
read failures is required by [R3](product-requirements.md#r3); the
[implementation gaps](#implementation-gaps) below identify paths that do not yet
meet it.

<a id="native-authority"></a>
## Native authority

Copilot alone owns sessions, history, model context, execution and queues. The
backend keeps no chat window, resource snapshot, native switch copy or private
database fallback. Its in-memory control state is tied to the owning request,
connection, loaded session or service lifetime: SDK handles/subscriptions,
call/shutdown promises, send/interaction identities, pending decision callbacks,
version/instance info, bounded HTTP buffers and concurrency guards.
Host-owned settings such as the [new-session model](#session-default-model) and
[module load metadata](module-contract.md#storage-config) are not copies of native
state. Frontend display windows and drafts are interaction state allowed by
[R2](product-requirements.md#r2), not a backend history cache.

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
| 409 | `ROLE_ASSIGNMENT_DENIED`, `ROLE_ASSIGNMENT_REENTRANT`, `ROLE_ASSIGNMENT_INCOMPLETE` | Module role permission, recursive mutation, or saved-notification recovery failure; see the [role assignment contract](module-contract.md#role-assignment-lifecycle). |
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
`dev+unknown` and a null SHA. The About section of Web Settings reads this backend identity.
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
- Host text drafts live in memory and `sessionStorage`, keyed by session and
  prompt/decision lifetime. Text is cleared only on explicit acceptance with no
  newer edit; failures and unknown results retain input and are never resent
  automatically. Module field persistence, legacy-data restoration and unclaimed
  data protection follow the [draft contract](module-contract.md#61-state-and-draft-extension);
  core does not interpret module data or use `localStorage`.
- Chat text uses the browser's native context menu; code and tool details keep copy buttons.

<a id="global-settings"></a>
### Global settings

**Global menu → 设置** opens one native dialog with the default model, module-owned
preference sections and About. Global MCP and Skills remain separate navigation
entries. Each section owns its reads, changes and feedback; there is no combined
save that claims to commit module settings. The model requires an explicit save
and stays open afterwards. The selector and Save share a wrapping row. About reads
backend version/source and the current host's loaded module names, IDs and versions
on opening and explicit refresh, not build-time constants or latest Release versions.
The existing `/_modules` inventory includes backend-only modules and activation/runtime
errors; installed but unloaded packages are not listed. Empty, failed and unknown
version states remain explicit, and connection changes invalidate earlier results.

Modules join the real preference content through
[settings middleware](module-contract.md#settings-content), not a host notification
or configuration service. The host owns the dialog, focus and one scroll area;
modules own their controls, storage and operations. Closing the dialog releases
reads without cancelling already-submitted changes. Host model editing and save
ownership survive module removal.

<a id="session-default-model"></a>
### Default model for new sessions

**Global menu → 设置 → 默认模型** selects the model used only for future new
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
## Implementation status and gaps

The thin-host and native-state boundaries are implemented, but they do not imply
that every adapter or UI projection meets every requirement. The limitations below
are current implementation gaps, not accepted exceptions or completed fixes.

<a id="implementation-gaps"></a>
### Fidelity and read-cost gaps

| Requirement | Current limitation | Source |
| --- | --- | --- |
| R3: preserve confirmed effects | `cancel`, `session/interrupt`, `queue/remove` and `session/rename` can return an error when a follow-up read fails after a successful native operation, without returning the already-confirmed effect. This is distinct from the result-preserving model/mode/compaction adapters and per-step `session/control` results. | [Controls](../packages/core/src/session-controls.ts), [settings](../packages/core/src/session-settings.ts) |
| R3: preserve explicit failures | The Web fold hides ordinary rows for `task`, `skill` and `exit_plan_mode`. A failure before a replacement card exists can be hidden with the row, including its error text. This loses displayed evidence, not the native event itself. | [Chat fold](../packages/protocol/src/chat.ts) |
| R3: distinguish unknown values | Plan/todo projection maps missing or unrecognized native todo status to `pending`; it does not preserve that uncertainty. | [Resource reader](../packages/core/src/resource-reader.ts) |
| R3/R5: distinguish stale windows | The module current-window observer uses connection-open state without the Web store's `snapshotReady` guard. On reconnect, a retained materialized window can change from `stale` to `ready` before the current session snapshot arrives. This is not proof of freshness or complete history. | [Module view](../apps/web/src/lib/moduleView.ts), [window projection](../apps/web/src/lib/moduleChatWindow.ts) |
| R4: narrow read dependencies | Sending a prompt to an already-loaded session first reads all five control inputs: processing, activity, queue, native tasks and MCP. An unrelated MCP read failure can prevent `sdk.send`. These are adapter/RPC dependencies, not a measurement of total user-action cost or production latency. | [Prompt adapter](../packages/core/src/session-controls.ts), [control reads](../packages/core/src/kernel.ts) |
| R4: reuse request-local work | A loaded-session readiness check with no explicit role subset assembles the same roles twice, repeating packaged-resource reads and verification within one request. This is local assembly work, not a native-state cache. | [Role service](../packages/core/src/role-service.ts), [assembly](../apps/server/src/module-roles.ts) |

Reducing these costs means narrowing dependencies or reusing request-local work,
not adding a native-state cache or removing lifecycle protection. An error from a
mutation is not proof that nothing happened; inspect current native state before
deciding on another action, never automatically replay it.

### Confirmed capability targets

| Capability | Current | Confirmed target |
| --- | --- | --- |
| Shutdown | Implemented: waits for native activity and protected in-flight calls, not module work or close receipts. | Native-session-based exit ([R7](product-requirements.md#r7)). |
| Module delivery | Implemented: local trusted packages, main-process import, cold load, HTTP/static routes, data events and four frontend extension kinds. Modules implement their own HTTP MCP on digest-bound paths under the host port; roles supply those endpoints to native sessions. | Cold module packages and per-module MCP paths ([R1](product-requirements.md#r1)); supported package forms are in the [module contract](module-contract.md#1-supported-scope). |
| System page | Not implemented. | A full host page from the main menu showing versions and installed/loaded modules read-only, with safe exit ([R6](product-requirements.md#r6)). |
| Next-start message | Not implemented. | An optional module saves a prompt for the next start and makes one send attempt. |
