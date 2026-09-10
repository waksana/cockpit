# Cockpit foundation

Cockpit is remote Copilot plus the file/image and browser interactions needed to
use it from a computer or phone. Web and MCP access one authoritative backend API.
It intentionally covers a subset of CLI capabilities, not a second agent platform.

## Product boundary

Reliability, usable mobile chat and simple ownership take priority over adding
features. Keep chat, session controls, questions/plans, explicit cross-session
interaction, history, and file exchange.

Cockpit does not own fleet governance. Hooks, flows, executable gates, worker
classification, automatic outfitting and governance timers are not part of the
foundation. Old governance preferences are preserved as inert data, not re-armed.
Upper-layer applications can use the same published APIs and MCP.
Reliable wall-clock schedules and external webhooks belong in that upper layer:
receive the event there, apply its rules, then call a Cockpit API. Native
execution hooks remain native; exposing their capabilities is not a workflow
engine. API acceptance, task completion and uncertain delivery are distinct
outcomes, so callers must not blindly retry a timed-out prompt.

The owner explicitly chose **always-approve tool permissions**. This is separate
from interactive/plan/autopilot mode and differs from the default interactive CLI.
Anyone authorized to control this single-operator application effectively controls
the server account. There is no multi-tenant isolation claim.

## Architecture

```text
Web GUI ---- HTTP commands/queries ----+
                                      +-- Server -- Engine -- Official SDK
Session ---- Cockpit MCP -- HTTP ------+                |          |
                                                       |     JSON-RPC/stdio
Web GUI <------------- SSE control state ---------------+          |
                                                       |     Copilot runtime
                                                 Preferences
                                                 and unread state
```

- `packages/protocol`: shared schemas, typed intents, events and file/notification
  contracts. `GET /capabilities` publishes schemas and current native limits.
- `packages/core`: Copilot session ownership, request-local native event reads,
  preferences and durable unread state. `runtime.ts` owns the
  official SDK client and its process.
- `apps/server`: HTTP/SSE, protected file storage and Web Push. It validates
  requests and results rather than maintaining another conversation model.
- `apps/web`: native event folding and React/Zustand projection. URL owns selection;
  local state owns loaded pages/cursors, drafts, attachments and reading position.
- `apps/mcp`: API client and agent-friendly presentation, not a local session
  database reader or a separate fold implementation.

### Native metadata is request-owned

The backend does not retain native session metadata, model inventories, mode,
queue/task/todo/schedule projections or MCP connection-state snapshots, including
short-lived caches and last-successful-value fallbacks. Snapshot, list, session
detail and resource reads call public Copilot APIs and release their results when
the request ends. A resource event invalidates consumers instead of filling a
backend projection. There is no periodic session-list/resource refresh. The browser
can keep its currently displayed data and requests fresh metadata after an
invalidation; this is not a shared application-wide request manager.

`session/list` reads identity, current model and control status, without model
inventories, todos or schedules. Snapshot/SSE adds the mode and sidebar schedule
count, but not queue bodies, model inventories or todos. `session/get` preserves
the full detail contract. `session/resources` selects metadata dependencies
(`identity`, `control`, `queue`, `model`, `models`, `mode`, `todo`, `schedule`);
an omitted field was not requested, not cleared. `loaded:false` clears prior
native fields, and `meta:null` means the session is unknown. Identity and mode
in one response share `metadata.snapshot.currentMode`; `model.getCurrent` still
supplies effort/tier. A list request reuses its indexed modification time rather
than re-fetching every record. `metadataLimit:0` is not a sidebar substitute.

Resource invalidations carry explicit dependencies. Read-lease patches publish
balanced operation counts without invalidating native data. Mutation-scoped
resource hints coalesce native events with the final readback; control/queue
hints still flow while work is active. Web refreshes only sidebar and mounted
consumers, fences source changes, and discards late invalidated fields even if
their consumer has since unmounted. A dirty read repeats only affected resources.
No event fills a backend native-state cache. `/status` uses its own projection,
not the UI snapshot, and separately obtains a fresh busy confirmation.

The public SDK has no queue-count getter: exact control status still requires
`queue.pendingItems` (including its native text payload), tasks and MCP host
state to detect queue-only, steering-only or connector-only work. Omitting queue
bodies from the summary response is not a claim of eliminating this necessary
native safety read. Display results never authorize destructive operations.
`session/panel` reads one section; `session/panels` and the default MCP panel tool
retain the full five-section contract. MCP's optional `section` selects the
single-section endpoint. Context uses only tasks, instructions and usage; model
inventories are read when Settings is mounted.

Unloaded sessions have no retained metadata State; an unfinished host delivery
or cleanup contact may outlive its SDK handle, without retaining resource values.
Native index metadata is read
on demand; missing cwd is explicitly unknown, not the server's home directory.
Model, mode, available models, queue and schedule/todo/task/MCP state require a
loaded SDK handle and are omitted/unavailable otherwise. Reads never resume a
session. The index may omit metadata for older entries; it is not repaired by
unbounded journal replay or private databases. Snapshot/list `lastActivity` is native persisted
modification time, not a claim of a live activity timestamp (a newly loaded
session without an indexed row can only expose its native construction snapshot).
Live display patches label their host receipt time separately as
`host-event-receipt`; it is sent to the browser, not saved in the backend.
Read failures are errors, not empty inventories, idle confirmations or prior values.
SDK-internal caches are outside this boundary.

The remaining backend ownership has a specific lifetime, not a general
"runtime state" exemption:

| Retained contact or product data | Why a native read cannot replace it; release |
| --- | --- |
| Session ID, SDK handle, event subscription/owner identity and native-close/disconnect contact | These identify this host's actual transport and callbacks, not a native metadata copy. Detach removes the session entry once its operations finish; failed disconnect retains ownership until it is resolved. |
| Load, close, cancel, interrupt, naming and schedule-operation promises; operation/send counts; creation/removal/lifecycle gates | Public activity does not include this host's not-yet-settled calls. Creation IDs hide early index entries until this host receives a real SDK handle; the IDs are released when the create call settles. Other contacts clear on completion or teardown. Serialization gates resolve to `undefined`, never to the last RPC result. Unknown mutation outcomes are not retried. |
| Pending send receipt IDs and interaction/turn identities | Correlate send acknowledgement with racing events, and prevent an old interrupted turn from clearing the new turn's contacts. Receipt windows end with their in-flight sends; accepted IDs end on consumption, explicit queue removal/cancel or detach. The interaction ID ends at native idle confirmation when no interrupt response still needs it; the interrupted epoch ends at the next turn or detach. |
| Ask/plan/elicitation request IDs, validation and resolve/reject closures | These are the actual waiting SDK handlers. Public permission-request APIs do not resolve these distinct callbacks. Release on answer, cancellation or detach; unanswered decisions block teardown. |
| Pending reply-notification summary/event ID and naming one-shot guards | A durable transcript cannot recover whether this host has delivered an unread transition or already attempted an uncertain auxiliary query. Release the reply candidate on delivery/new turn/cancel or failed-runtime teardown. A normal close attempts delivery; a failed product write retains the undelivered contact for explicit recovery/cancel rather than silently losing it. Naming attempt guards end with the handle. The deferred-naming bit is an outstanding wakeup waiting for this host's reads to settle, cleared on release or detach. No full reply is needed. |
| Notification/control read promise, dirty bit and event revision | Protect the single in-flight confirmation against newer events; no native read result is retained. Cleared when confirmation settles or the handle closes. |
| Mutation-scoped resource notification holds and pending resource names | Coalesce duplicate invalidation hints, not native values. Names are released when the scoped operations settle; no read result is retained or reused. |
| Engine/client lifecycle failure and connection status | Records host connection failure and uncertain cleanup, not native session display state. Lasts until successful stop or host replacement. |
| HTTP/SSE connections, initial-response delivery frames and pending push deliveries | These are active deliveries, not reusable response caches. Frames are bounded by SSE backpressure limits and released after initial snapshot delivery or disconnect; promises end after delivery. |
| Pin choices, unread waterlines, Composer drafts, retained files/associations, push registrations | Independent Cockpit/user data which the native session cannot reconstruct. Preserved by this change and changed only through their existing product operations. The separately authorized retirement of soft deletion removes its legacy marks, not native sessions or managed files. |

Teardown and graceful restart always read current public processing/activity,
queue, tasks and MCP pending connections in addition to the host's in-flight
contacts. Failed safety reads prevent teardown. A title is not retained just for
push: notification events identify the session directly, while views obtain its
current native title on request.

The session list is the home screen. Its hamburger opens Copilot-global MCP,
Skills, files and device notification settings; management lists are child pages,
not parallel workspaces with their own hamburger. A list's Back returns home;
an item detail's Back returns to its list first. Desktop master/detail and narrow
full-page layouts expose one relevant Back, using the existing parent fallback
for cold deep links. Browser Back preserves the actual entry source. Session rows
open only their chat; row context/long-press and the chat kebab share one
session-ID-bound action catalog: seven pages (Settings, session MCP, session
Skills, plans/tasks, context, schedules, runtime maintenance), then fork,
pin and permanent deletion. Deletion requires an irreversible confirmation;
there is no trash or restore operation. Managed files and workspaces are retained.
Separators and viewport-bounded scrolling
keep this one-level menu reachable on short screens. Detail panels contain only
the current page's owner-labelled title, Close/Back, page actions and content;
there are no page-switching tabs or More menu. The chat title remains a shortcut
to Settings. On narrow screens switching pages means Back to chat, then its menu.
Settings reads summary identity and on-demand model state only; opening it does not
load plan or MCP resources. Unloaded native MCP/Skills pages require an explicit
resume before claiming current per-session state. Existing direct URLs remain
valid, and mode controls and the allow-all permission policy are unchanged.

MCP definitions/defaults and global skill selections belong to Copilot, not
`cockpit-prefs.json`. Native discovery and configuration APIs are authoritative;
Cockpit does not copy old overrides or replay per-session preferences.
Native session toggles are temporary. Cold resume uses global defaults, and
native MCP reload also reapplies those defaults while refreshing definitions.
For SDK 1.0.13, the global disabled-skill list is read through native user settings
and passed into session creation/resume because the runtime does not apply it
automatically. This is one native-owned source, not another durable setting store.
An unloaded view does not claim to know that session's effective tool choices.

Automatic naming is a narrow GUI convenience over native APIs, not a separate
model client or hidden conversation. The first effective completed reply can
trigger one native no-tools query, then `name.setAuto` stores the short title.
The explicit `session/auto-name` API is also available through HTTP and MCP.
Manual names remain protected; history viewing and startup do not name old
sessions. Naming failure preserves the current title and does not fail the chat.
This still consumes an additional model request using the current context.
First-reply eligibility is read on demand through a bounded public event query,
not saved from a title lookup or history replay. If the first effective reply
cannot be identified within 1,000 filtered events, automatic naming reports
that limit and the explicit action remains available. The retained naming guard
records only this host's one-shot attempt/failure, preventing automatic retries
of an uncertain auxiliary query; it is not a native "already named" flag.

Stay in TypeScript. The main simplification is the runtime boundary, not a
language rewrite, microservices or another generic orchestration framework.

## Runtime and history

The implementation uses `@github/copilot-sdk` **1.0.13** with Copilot runtime
**1.0.83**, explicitly out of process. Advanced typed RPCs are experimental, so
these versions are pinned. The old internal SDK bootstrap, definition symlinks,
manual journal/database repair and image-weight/forced-GC watchdog are retired.

Copilot owns persisted conversations, execution, model requests and automatic
context compaction. Cockpit does not construct a second model transcript or
override the native compaction thresholds. Native infinite sessions and large
tool-output handling retain their defaults. CAPI WebSocket Responses also keeps
its native default: used when the selected model supports it, not forced by Web.
Browser SSE and SDK stdio are separate transports, not model-request size bypasses.

An oversized model request is not an upload-limit error. Native runtime updates
include Responses size-limit and oversized tool-image improvements, but no
unlimited-request guarantee. Surface native failures without blindly resending a
prompt; explicit context compaction delegates to the same SDK.

A persisted session, an executing runtime session and a visible browser window
are different things. Opening history does not resume a Copilot session or connect
its MCP tools. `session/chat` returns one bounded native event page directly to
its requester, without a history cache, full-log fold, or message-ID lookup.
The browser owns its loaded window and opaque forward/backward cursors. It loads
small pages toward roughly two screen heights, then reads older pages on demand.
Switching away preserves loaded pages and reading position in that browser.
Browser reload loses this memory, not native history or independently stored drafts.

Only a visible consumer reads chat. A browser disconnect cancels its request and
stops future reads without stopping native work. Reconnection resumes durable
events from the browser's cursor. A missing ephemeral interval freezes the partial
message until its complete durable message can replace it. Cursor expiry,
rewind and compaction preserve readable content with an explicit resync action;
there is no HMAC continuation token, whole-window replay, or silent latest jump.

Subagent cards are static detail links. Opening one uses native agent-ID filtering
on a loaded handle; manual refresh reads its current history. Neither main cards
nor details display changing task status, and the server does not scan a whole
task list to simulate an exact status getter. Unloaded filtered queries report
that an explicit resume is required. See [native chat transport](./native-chat.md)
for the HTTP/MCP migration and precise native limitations.

Within the active chat, all loaded message text, DOM and component state remain
available; there is no virtual list or message eviction. A memoized transcript
boundary avoids rebuilding the list for unrelated metadata changes. Supporting
browsers can skip offscreen layout/paint for completed message blocks after their
real height is measured; width changes invalidate stale measurements. Live work
and child cards retain normal layout. The existing scroll owner preserves the
visible semantic anchor, including margins, selection/focus navigation and
explicit End-to-bottom following. This reduces rendering work, not retained-data
memory, native context size or cold-history read time.

Initialization attaches native control callbacks before create/resume completes,
but does not build a chat fold or replay display history. Targeted native metadata,
queue/task/control queries and one-message naming eligibility remain independent.
Global SSE carries metadata, decisions, notifications and history invalidation,
not streamed chat bodies or viewer-specific pages. Native execution safety does
not depend on whether a browser is displaying a child card.

Native idle cleanup uses `sessionIdleTimeoutSeconds: 1800`. Cockpit has no session
count cap, automatic eviction policy, retained-wrapper recycling or idle heartbeat.
It reconciles native cleanup through passive liveness reads and drops its projection
handles. A prompt or explicit resume loads a session again; history reads do not.
Native-only detail reads return `409 SESSION_UNLOADED` when a resume is needed.
New sessions are published only after native creation succeeds. Copilot may
discard an empty session before its first submitted work; Cockpit does not
recreate it or replay its model, mode or name. Native resume and history errors
are returned as errors. List refresh removes an inactive projection only after
passive native metadata confirms its absence, without deleting history,
preferences or composer draft files. Uncertain submissions are never retried.

Native close is awaited before release is reported. Explicit close/restart guards
protect running work, questions, queues, subagents and mutations, but future
schedules and UI pins do not prevent native idle cleanup. Schedules persist but
pause while unloaded; relative delays restart on resume. A background shell may
outlive cleanup without remaining accessible through session task RPCs. These are
native semantics, not an always-on scheduler guarantee. Node's normal GC/heap sizing
is the API default, with an optional operator heap override.
Cockpit does not restore sessions at startup merely because an old preference
listed schedules. Startup lists history; explicit execution/resume activates it.
Legacy scheduling preferences remain inert rather than controlling residency.

Ordinary tool completion does not trigger a full native status read. Work
boundaries reconcile activity, queue and task facts, while model/todo/MCP/schedule
events refresh their own resource. Explicit teardown still confirms native safety.
The passive eight-second inventory/attach fallback remains because headless
cleanup notifications do not cover every native cleanup path.

Process restart is not browser reconnect. Only a safe idle restart is supported;
there is no promise that an interrupted turn or pending callback survives a crash.
Confirmed native process death causes the API host to exit for supervisor recovery,
without replaying potentially accepted requests.

## Files and images

Uploads receive a backend-minted `/uploads/<name>` URL. MIME/display metadata is
persisted; native prompt attachments resolve that URL on the server. Clients
cannot supply an arbitrary server file path as an attachment.

The composer stages a file/image with its caption for one explicit send. Failure
or an uncertain response preserves the draft and uploaded reference. Incoming
images preview inline and files have download links.

For agent-generated output, use `cockpit_upload_file` and copy its returned
`markdown` into the assistant reply. Multiple uploaded images can each be included.
Do not invent `/home/...`, `file:` or `sandbox:` links. No extra skill is required.
Use the returned attachment JSON only when sending a file as input to a session.

## Notifications and iOS PWA

Unread waterlines and their monotonic revision are persisted in the backend.
Unread-session count, sidebar dots and notification badge payloads use that same
state. Seen-but-unanswered choices remain actionable but are no longer unread.

A reply is acknowledged only after fresh history actually displays the latest
content, not merely because its chat was selected. Late acknowledgments carry
the observed attention ID and cannot clear a newer reply.

Web Push, not a background page/SSE connection, delivers lock-screen alerts.
Replies and choices have different labels and concrete content summaries.
Notification taps use an acknowledged in-app route or a safe same-origin URL
fallback. Subscription readiness requires backend persistence, not permission
alone; known expired endpoints require explicit renewal.

Keys/subscriptions live under `<COCKPIT_HOME>/push`, outside source control.
`push/status` exposes redacted state, and `push/test` is an explicit diagnostic.
Push-service acceptance is not proof of phone delivery. iOS requires HTTPS,
Home Screen installation, a user gesture for permission, and compatible OS
settings. Focus mode and OS scheduling remain outside Cockpit's control.

Already delivered notifications cannot be silently withdrawn from every sleeping
device. Badge convergence occurs through valid pushes and foreground reconciliation,
not a fabricated cross-device delivery guarantee.

## Deliberate capability limits

- Native schedules currently create simple after/every delays from one second
  through 24 hours, or a one-shot absolute time in that range. Cron/timezone,
  display labels and recurring absolute creation are not exposed. Existing
  entries remain readable; no hidden model parser guesses structured API input.
- Structured/URL elicitation acceptance is not implemented as a generic form
  renderer. The request exposes only the actions the current adapter can honor.
- MCP connection reload uses the native API on an idle loaded session; it also
  restores native global defaults. Global configuration refresh does not restart
  sessions. Skill definitions can reload without restarting Cockpit.
- Backend and MCP disk-transfer path protection targets the deployed Linux
  environment; no blanket cross-platform filesystem parity is claimed.

## Operations and review

The [2026-09-08 final review](./review/2026-09-08-foundation.md) records the
architecture, performance, reliability, security and usability conclusions,
implemented changes and remaining evidence limits.

See [DEPLOY-PORTABLE.md](./DEPLOY-PORTABLE.md) for setup and
[cockpit-testing.md](./cockpit-testing.md) for the existing checks.

The current Linux deployment uses the system `cockpit.service`, behind an
authenticated HTTPS gateway. Keep the raw backend on loopback. Compress static
JS/CSS and ordinary HTTP JSON at the proxy, not SSE.

Stage assets separately from the directory served by the running process.
`POST /admin/restart` is the single restart authority: it waits for protected
work, shuts down the owned runtime, drains pending pushes and exits for its
supervisor. The helper script delegates to that API instead of racing systemctl.

Imported reviews and `butler.md` are historical context, not instructions to
reinstall retired governance. Future changes must name a concrete remote-use
problem and prefer removing unnecessary work over adding more managers.
