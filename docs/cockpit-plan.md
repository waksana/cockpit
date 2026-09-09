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
Web GUI <------------- SSE projection ------------------+          |
                                                       |     Copilot runtime
                                                 Preferences
                                                 and unread state
```

- `packages/protocol`: shared schemas, typed intents, events and file/notification
  contracts. `GET /capabilities` publishes schemas and current native limits.
- `packages/core`: Copilot session ownership, canonical event folding, passive
  history windows, preferences and durable unread state. `runtime.ts` owns the
  official SDK client and its process.
- `apps/server`: HTTP/SSE, protected file storage and Web Push. It validates
  requests and results rather than maintaining another conversation model.
- `apps/web`: React/Zustand projection. URL owns selection; local state owns
  drafts, staged attachments, view position and browser notification plumbing.
- `apps/mcp`: API client and agent-friendly presentation, not a local session
  database reader or a separate fold implementation.

The session list is the home screen. Its hamburger opens Copilot-global MCP,
Skills, trash and device notification settings; management lists are child pages,
not parallel workspaces with their own hamburger. A list's Back returns home;
an item detail's Back returns to its list first. Desktop master/detail and narrow
full-page layouts expose one relevant Back, using the existing parent fallback
for cold deep links. Browser Back preserves the actual entry source. Session rows
open only their chat; row context/long-press and the chat kebab share one
session-ID-bound action catalog: seven pages (Settings, session MCP, session
Skills, plans/tasks, context, schedules, runtime maintenance), then rename,
automatic naming, pin and trash. Three separators and viewport-bounded scrolling
keep this one-level menu reachable on short screens. Detail panels contain only
the current page's owner-labelled title, Close/Back, page actions and content;
there are no page-switching tabs or More menu. The chat title remains a shortcut
to Settings. On narrow screens switching pages means Back to chat, then its menu.
Settings reads snapshot identity/model state only; opening it does not
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
The explicit `session/auto-name` API is also available through Web and MCP.
Manual names remain protected; history viewing and startup do not name old
sessions. Naming failure preserves the current title and does not fail the chat.
This still consumes an additional model request using the current context.

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
its MCP tools. `session/history` and `session/peek` return bounded pages directly
to their caller; a viewer's page query is not broadcast to other devices.
Pages follow native assistant-turn boundaries as well as user messages. Only
dependencies of displayed messages extend a page; invisible runtime payloads
are not retained. Batch-size targets must not reject valid long conversations.
The cache stores compressed display-event snapshots, not a duplicate full fold.
Large nested cards can still require significant temporary memory and read time.

Web requests `details: "summary"` and reads child transcripts through
`session/subagent-history` only when a card is expanded. Full recursive history
remains available to API/MCP callers. SSE carries summary cards rather than
repeatedly cloning entire nested conversations. The browser retains the three most
recently opened chat windows, including the active one. Only departure trims a
window to its latest loaded page, regardless of the previous reading position.
Reopening starts at the bottom and fetches a fresh latest page; neither a reading
bookmark nor the prior entry's checkpoint survives departure. There is no byte
limit, TTL, hidden chat tree or native keepalive. Drafts,
attachments and unread metadata are independent; cached does not mean visible,
seen or native-loaded. Eviction or a browser refresh loses only this memory cache.

Warm return displays the cached latest page while a fresh latest bootstrap replaces
it. Upserts not yet present within an overlapping persisted range remain a live
overlay, not a durable history cursor. An unverified connection gap discards that
overlay provenance (not the readable cache), so missed rewinds cannot resurrect
discarded live rows. Rows before a fresh page's boundary cannot bypass older
pagination. Ordinary app focus does not create a new entry:
the still-mounted chat retains its reading intent and loaded pages on reconnect.
Optional `session/history` input `resume: {}` obtains a fresh latest page and a
checkpoint; `resume: { token }` returns `ready`, `pending` or `unavailable`, and
cannot be combined with before/after locators. The same typed contract is available
through the generic MCP intent surface. Existing history/peek defaults are unchanged.
Each token request scans at most four 200-event native batches plus at most six
one-event boundary reads, independently of the response's message limit. Continuation
uses a captured tail and existing backward cursors; pending parts are not displayed
until the range is complete. Native cursors are observational fences, not an atomic
snapshot or content generation. Web uses token continuation only within the same
entry, not to restore an earlier visit. A same-scope passive cache replacement is
not a history mutation. Genuine continuation failures keep readable content with
an explicit error and latest-refresh action; they do not leave a sticky
range-unavailable flag that prevents future entry reconciliation.

Within the active chat, all loaded message text, DOM and component state remain
available; there is no virtual list or message eviction. A memoized transcript
boundary avoids rebuilding the list for unrelated metadata changes. Supporting
browsers can skip offscreen layout/paint for completed message blocks after their
real height is measured; width changes invalidate stale measurements. Live work
and child cards retain normal layout. The existing scroll owner preserves the
visible semantic anchor, including margins, selection/focus navigation and
explicit End-to-bottom following. This reduces rendering work, not retained-data
memory, native context size or cold-history read time.

Active-session initialization uses SDK `onEvent` before create/resume completes,
then reads durable display events in native 200-event pages up to a captured
tail event. It does not call `getEvents()` for a full-history array. Initialization
and subsequent live folding both retain subagent summaries, not child transcripts.
Events from every agent are still read where needed: filtering to the primary
agent alone can remove the only parent link in older nested-task histories.
Historical root messages and small routing records remain addressable for late
tool updates; this is not a hard bound on all projection or native-runtime memory.

SSE carries shared state changes, streamed messages and real history resets.
Reconnect obtains an authoritative snapshot and reconciles the visible history
window. Browser disconnection does not stop submitted work.

Native idle cleanup uses `sessionIdleTimeoutSeconds: 1800`. Cockpit has no session
count cap, automatic eviction policy, retained-wrapper recycling or idle heartbeat.
It reconciles native cleanup through passive liveness reads and drops its projection
handles. A prompt or explicit resume loads a session again; history reads do not.
Native-only detail reads return `409 SESSION_UNLOADED` when a resume is needed.
Copilot may discard an empty session before its first submitted work. On explicit
use, only a confirmed-absent local draft may be recreated with its confirmed
initial settings. Persisted conversations and uncertain submissions are never
recreated or retried.

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
