# Native event chat transport

This describes checked-in source, not a deployment receipt. In particular, the
all-agent SSE and subsequent SDK remediation changes remain local at the
[2026-09-11 source status](cockpit-plan.md#source-delivery-and-paused-work-2026-09-11).

Copilot owns durable history and model context. Cockpit does not keep chat
windows, a live message fold, a message-ID index, resume checkpoints, or a
second conversation store. The browser owns its loaded messages, tool/agent
relationships, scroll position, and native cursors.

The global `/events` connection carries session metadata, control state and
notification signals, not chat message upserts. A chat reader exists only for
an actual consumer request. Ending that request never aborts the agent.
Native SDK callbacks still handle control/notification work; registering no
chat handler does not promise that the SDK transport stops receiving all native
notifications.

## `POST /intent/session/chat`

The published capability schema is authoritative:

```json
{
  "sessionId": "session-id",
  "source": "live",
  "direction": "backward",
  "max": 64,
  "waitMs": 0,
  "bootstrap": true
}
```

- `source:"persisted"` uses `client.rpc.sessions.readPersistedEvents`. It works
  without loading the target. It cannot filter agents or wait for new events.
- `source:"live"` uses an existing handle's `rpc.eventLog.read`. Native
  `agentScope`, `agentIds` and `types` filters are available; the browser uses
  all-agent scope and delivery consumers can request just their required types.
  Default live chat types include only events consumed by the message projection,
  not unused tool-argument deltas or metadata already carried by `/events`.
  Passive reads reject unsupported filters instead of simulating them by a
  full read. A read never resumes a session to satisfy the request.
- `max` counts native events, not display messages: default 64, maximum 256.
  Each request makes one native page read. No loop fills a fixed message count.
- `direction` is forward or backward. Preserve it with the opaque cursor;
  changing the direction argument does not reverse a native cursor.
  Keep the source/filter information with the reading position.
- `waitMs` is at most 30000 and only available for live forward reads. It is a
  bounded request, not a permanent server chat collector.
- `includeEphemeral:false` makes a live forward read durable-only, suitable for
  delivery consumers. Otherwise live forward includes ephemeral events; passive
  and backward reads are always durable-only.
- Fresh backward `bootstrap:true` on a live source captures `eventLog.tail()`
  **before** reading the page and returns that additional `liveCursor`.
  Following it may overlap the page; it must not leave a gap.

The result contains `sessionId`, `events`, `cursor`, `cursorStatus`, `hasMore`,
source, direction and `read:{rpc,events}`. Titles, directories and runtime
metadata belong to `session/get` and the session list, not every chat page.
An initial request without a live handle or cursor makes one additional native
metadata lookup to confirm existence. Cursor continuation does not repeat that
lookup. The counters describe event-log reads (one page, or page plus bootstrap
tail), not this existence lookup or every transport operation.
Only native session existence is authoritative; Cockpit does not synthesize a
missing draft session or its history. Do not send an empty cursor back as a
nonempty locator.

Backward arrays are chronological within the returned page. Forward reads can
interleave durable and ephemeral events. Process a whole page before advancing
the saved cursor. Event IDs deduplicate overlap; assistant `messageId` identifies
the message to replace on its authoritative full event. UUID lexical order is
not conversation order.

## `POST /chat/stream`

The selected visible browser window opens one authenticated, CSRF-protected
stream with `{sessionId,cursor,max:64,agentScope:"all"}`. The cursor field is
required; an explicit empty native tail sentinel is distinct from an omitted
reconnect position. Optional native `agentIds` and `types` filters remain
available to other consumers.

This endpoint sends actual `{type:"page",page:NativeChatPage}` SSE frames, not
invalidations asking the browser to re-fetch its accumulated history.
It first drains durable events after the saved cursor with zero wait, then
continues from that same position with ephemeral events enabled and a native
wait of up to 30 seconds. It never takes a fresh tail during that transition.
Cursor-advancing empty pages are delivered; unchanged idle results only send a
heartbeat. Empty or duplicate pages do not rebuild the browser's message tree
or publish an unchanged display snapshot.

The server owns only the connection, its current native read and bounded HTTP
write buffers. It waits for socket backpressure before starting another page,
chunks large messages without splitting Unicode pairs, and closes stalled
consumers. There is no per-page acknowledgement or replay cache. Normal
reconnection uses the last fully applied page cursor; a disconnect with bytes
still in flight can re-read an undelivered tail. TCP backpressure is not proof
that the browser has applied a frame, so this is not a strict one-page
unacknowledged-read guarantee.

Native errors are terminal error frames; expiry is a terminal expired page.
Neither silently substitutes another cursor. Failed live reads can passively
confirm native idle cleanup once and report `SESSION_UNLOADED`; ordinary pages
do not pay for metadata or liveness checks. Closing a view does not call the
model's abort method. Native's per-read wait has no cancellation parameter:
one already-running request can finish after HTTP disconnect, but cannot
deliver obsolete data or continue reading.

## Browser reading

An authoritative complete session snapshot releases browser reading windows for
IDs no longer present, including sessions deleted while this browser was offline.
An authoritative single-session `meta:null` or removal event releases the same
window and pending read contacts. Unloaded sessions, partial resource responses,
filtered lists and transient failures are not deletion signals. Surviving
windows retain their cursors, nested agent ownership and current reading state;
this is not an LRU policy and does not delete Composer drafts or retained files.

Entering a chat view lands at its latest loaded content. Leaving and re-entering
does not restore the previous cross-view reading position; retained history and
native cursors still avoid a fresh history read. Within the same mounted view,
rerenders, live updates and older-page insertion preserve the active reading
anchor and gestures rather than forcing the reader to the bottom.

Initial loading fills at least two viewport heights when sufficient history is
available, not a fixed number of messages.
Upward reading prefetches older messages when the remaining loaded history above
the viewport falls to about one current viewport. After insertion, the reading
anchor is restored before deciding whether another bounded batch is needed.
There is at most one older read in flight per window; exhausted, failed, expired,
or unresolved-boundary windows do not automatically continue.
Browser backward reads use 32-event pages and stop initial filling once the
accumulated content reaches two screen heights (a complete batch can exceed
that minimum). One history action continues across native pages
until it adds a display message and resolves the loaded tool/agent records to
their owning messages. It does not wait for running tools to finish. Main chat
and nested child messages share one window; metadata-only pages are not treated
as a finished message load. The initial live tail is captured only once.
Hidden tool rows, including skill and plan-mode calls, retain their ownership;
suppressing duplicate presentation must not trigger extra history reads.

Older pages are folded as a prefix, not by replaying the entire loaded window.
Browser-local indexes point into the retained display events: message/tool
dependents, agent aliases, and each agent's leading reasoning/turn boundary.
A newly supplied owner repairs its waiting tool/child events; a leading thought
replays only the dependent boundary and its tool updates. Those results merge
into the existing fold in native append order, preserving untouched message
objects, ownership indexes, live partials, and reading-anchor IDs. Bootstrap
adoption appends only events beyond the last overlap; empty/duplicate pages
advance positions without folding or replacing the view.
Reasoning-only rows use their closing native event ID rather than the earliest
reasoning segment as their stable identity, so prepending earlier thought
segments extends one row without duplicating it or losing its reading anchor.

Projection calls are proportional to new events plus the dependency frontier
actually replayed, not the full loaded suffix on every page. A distant missing
owner or an unbroken reasoning chain can still have a large frontier; immutable
message-array assembly and existing agent routing also have their own costs.
This is a local projection optimization, not a reduction in all native reads,
a fixed action budget, a truncated reading window, or a server chat cache.

There is no eight-page hard stop. Completing a message/ownership boundary and
filling two screens can require more than one page, especially with low visible
density or a distant parent task. The user explicitly chose to preserve these
behaviors rather than use fixed pages with incomplete messages or a short
initial screen. Consequently the whole history action has no universal event
ceiling; a single bounded native request must not be advertised as one.
Cancellation, errors, expiry, nonadvancing cursors and authoritative exhaustion
still terminate automatic reading. Reaching the beginning without an owner is
reported as missing source history, not a promise that another page exists.
Forward streaming still drains up to 64 events per request and is not delayed
for a complete display message.

Initial viewport filling measures the incoming rows without exposing each
intermediate page, then reveals the accumulated initial content together.
Existing reading windows remain visible during older-page loads. The normal
loading indicator sits in a reserved-height slot at the beginning of the
scrolling transcript, not a fixed or sticky viewport toolbar. There is no normal
load-more button; explicit failure retry and rebase remain available. The
reserved slot prevents loading visibility from shifting rows. Child cards
render the shared nested projection. Expanding a card makes no request, needs
no refresh button, and automatically shows new messages and lifecycle changes.
Collapsed children also travel over the all-agent stream; this is the user's
chosen completeness/bandwidth tradeoff. The parent scroll owner anchors the
visible child row during a prepend. Switching sessions or hiding the page
releases the shared read; closing a child card changes presentation only.

Child headers display **recorded execution evidence**, not the native task
registry's current state: started, this execution ended, failed, cancelled,
or subsequent activity. A cancellation remains distinct from failure. A later
durable child message, model-turn boundary, reasoning or tool event supersedes
an older terminal label; a failed tool alone does not fail the child, and a
parent turn ending does not end its children. A completed invocation may belong
to a reusable agent, so the label never means its overall goal is complete.
Unknown evidence stays unknown. Duplicate events and older-page insertion do
not overwrite newer execution evidence. These labels add no SDK query, history
request or poll; they use the same all-agent window even while collapsed.
They remain historical evidence during disconnect or a missing stream interval,
not a claim that the child is still running. Ephemeral fragments alone do not
establish a new execution boundary; normal durable catch-up supplies the record.

Only the selected visible view reads live chat. Disconnecting or changing views cancels
its request and stops subsequent reads. The public native long-poll RPC has no
per-call cancellation parameter, so one already-running read can finish within
its bounded wait; its obsolete response is discarded.

On reconnect, the browser retains its old content and cursor. New durable events
can be read forward without retransmitting the entire old display window.
Ordinary reconnect publishes each durable page without waiting for the whole
gap to drain. Only a fresh bootstrap needs temporary overlap reconciliation
between its captured tail and backward page.
Previously received tool ownership remains browser state.
The browser retains the existing capped tool details rather than duplicating
large raw outputs/arguments. Accepted user answers and message bodies remain
complete. This is browser retention, not an additional server chat cache or a
claim that native JSON-RPC can omit those fields.
Passive history cannot filter at the source, but the browser discards unrelated
event bodies rather than retaining another metadata log. Child updates copy
only changed message/ancestor branches, preserving unrelated message objects.

Ephemeral delta replay is not guaranteed. If message C has a missing interval,
keep its existing text, indicate that the complete message is pending, and do
not append unknown-gap deltas as contiguous text. A later durable full
`assistant.message` replaces C; waiting for the whole task is unnecessary.
If native never saved that content before interruption, there is no promise
that the unsaved draft can be recovered.

`cursorStatus:"expired"` is not a successful continuation. The native boundary
returned with it may overlap or differ from the previous range. Preserve the
current view and require an explicit rebase rather than silently jumping to
latest. Rewind emits a `chat/invalidated` metadata signal without embedding a
history snapshot, because even a still-valid cursor can coexist with deleted
rows already displayed by the browser.

Context compaction is not a chat-history rewrite. Successful manual and
automatic compaction on runtime 1.0.83 preserved original event IDs/content and
same-source backward/forward/tail cursors, including subsequent new replies.
Compaction therefore updates operation status without invalidating chat or
cancelling in-flight reads. The Web also ignores legacy compaction invalidation
signals from older hosts. Actual native cursor expiry is still handled above;
manual compaction failures remain visible as operation errors.

## Media

Native tool binary payloads are removed from chat responses, without generating
image locators or maintaining a chat/image cache.

Only agent-published images appear in chat. Before posting an image link, upload
an existing local original or select an existing managed file. Reuse its URL:
viewing the link does not publish another copy. Native-only image lookup was
explicitly rejected, including bounded searches; `session/tool-image` and
`files/from-tool-image` return `410 NATIVE_IMAGE_LOOKUP_RETIRED`. Existing
managed uploads, including previously retained native images, remain available.

Native binary results arrive as event JSON/base64, not a public byte stream or
a confirmed single-part asset getter. The adapter cannot avoid bytes that
native already included. It must not advertise zero-copy or source-side field
projection. There is no separate native-image history lookup or tail scan.

## Protocol migration

`session/history`, `session/peek` and `session/subagent-history` are retired.
Their HTTP requests return `410 CHAT_PROTOCOL_CHANGED`; message IDs and old
HMAC resume tokens are not translated by scanning history. Native event pages
replace these contracts for Web, MCP and other API consumers.

The session plan keeps native plan text and todos. The old changed-files list,
which depended on replaying the complete transcript, has been removed.
Queue, decisions, native tasks, stop protection, notifications and file APIs
retain their independent responsibilities.

First-reply naming uses native eligibility pages of at most 32 filtered events,
stopping at the first effective reply within a shared 1,000-event budget, not a
saved already-named/history flag. Conversation presence is still a separate
one-event read; neither read limits the ephemeral naming model's native context.
Copilot's first-input preview and generated automatic
titles are both non-user names; a nonempty name is not proof of prior naming.
The first completed reply in the current native history may generate a title,
including after a cold rewind to empty. Native manual names always remain
protected. An ordinary later reply does not retrigger the naming model query.

An isolated runtime 1.0.83 fixture confirmed forward cursor reuse between live
and passive readers, including passive continuation after runtime restart,
without losing the fixture's root/child messages, tools or lifecycle events.
The cursor advances with consumption; it is not a fixed session identifier.
Starting with primary scope and later changing to all does not recover child
events already skipped before that position. The browser starts with all scope.
`includeSubAgentStreamingEvents:true` controls SDK push forwarding; it is not a
substitute for `eventLog.read` scope or a replay contract. A real root `task`
fixture exercised all-agent HTTP/SSE and recovered a completed child response
after a consumer disconnect. The tested background-child path did not emit
child text deltas, so it does not establish token-by-token child replay.
Duplicate system-message
events need not be present on disk; shutdown adds its own event. The connector
uses this durable forward boundary when native unloads, and still treats native
expiry as an error rather than inventing a replacement cursor. This is not a
promise that every native cursor lasts forever or every live event is durable.

Cold native disk indexing and filtering I/O remain native implementation
properties. A bounded event response does not prove constant-time disk access.
Cost experiments distinguish native RPC count, returned event/byte volume,
client projection work and actual I/O.

The semantic MCP reader has a separate default of 16 events and a 25,000-character
page threshold. Oversized multi-event pages require explicit narrowing with the
original input cursor; only `limit:1` offers 8,000-code-unit JSON fragments.
Each fragment rereads the complete native page (and bootstrap tail when requested).
Query/page hashes prevent mixing changing pages, but do not make a moving tail
stable or provide a native body offset. This is the accepted giant-event cost,
not a saved native copy or a new caching requirement. The existing 25 MiB MCP
transport limit still applies. See [MCP pagination](../apps/mcp/README.md#native-event-pagination).

An isolated 1.0.83 runtime with a local synthetic model produced the following
single-run samples (not production latency guarantees or disk-index proofs):

| Native query | RPCs | Events / JSON bytes | Elapsed |
| --- | ---: | ---: | ---: |
| Cold latest 64 after runtime restart | 1 | 64 / 23,071 | 17.09 ms |
| Warm latest 64 | 1 | 64 / 23,071 | 9.70 ms |
| Browser-size latest page | 1 | 8 / 3,293 | 12.50 ms |
| Next older browser page, known cursor | 1 | 8 / 2,925 | 4.53 ms |
| Forward continuation, known cursor | 1 | 64 / 22,685 | 3.02 ms |

The same fixture delivered one message start, four deltas and one complete
message through native forward polling, and accepted backward cursors across
the live/passive readers without repeating their latest rows. Smaller returned
pages are not automatically faster in every individual sample.

The unified built browser's synthetic HTTP/SSE fixture initially read 32 events
in one page and exceeded two viewport heights. At 390×844, opening a child made
zero requests, its next message arrived over the existing connection, and
reconnection delivered two new child events with no old history read. An upward
prefetch read the remaining 15 events once. Reconnection preserved its reading
anchor exactly; the older prepend differed by 0.27 CSS pixels after layout.
These are browser/transport fixtures, not native disk-I/O measurements.

This chat transport does not make inherently history-wide operations into
point queries. For example, existing fork safety preflight checks inherited
schedules and unfinished work before dispatching the native fork. Such explicit
control operations remain distinct from opening or paging a chat view.
