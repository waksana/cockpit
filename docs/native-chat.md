# Native event chat transport

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
  `agentScope`, `agentIds` and `types` filters are available; main chat uses
  primary scope and delivery consumers can request just their required types.
  Passive reads reject unsupported filters instead of simulating them by a
  full read. A read never resumes a session to satisfy the request.
- `max` counts native events, not display messages: default 64, maximum 256.
  Each request makes one native page read. No loop fills a fixed message count.
- `direction` is forward or backward. Preserve it with the opaque cursor;
  changing the direction argument does not reverse a native cursor.
  Keep the source/filter information with the reading position.
- `waitMs` is at most 1000 and only available for live forward reads. It is a
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

## Browser reading

Initial loading targets roughly two viewport heights, not 30 messages.
Upward scrolling requests more native pages and preserves already loaded rows.
Browser backward reads use 32-event pages and stop initial filling after
at least 1.5 screen heights, targeting roughly two screens without another full
page for a small shortfall. One history action continues across native pages
until it adds a display message and resolves the loaded tool/agent records to
their owning messages. It does not wait for running tools to finish. Main chat
and child details share this boundary rule; metadata-only pages are not treated
as a finished message load. The initial live tail is captured only once.

Each action is limited to 8 native pages (at most 256 events). A missing
or very distant boundary stops with an explicit continue hint rather than
silently scanning the whole conversation; initial viewport filling does not
automatically retry that limit. Reaching the beginning without an owner is
reported as missing source history, not a promise that another page exists.
Forward streaming still drains up to 64 events per request and is not delayed
for a complete display message.

Initial viewport filling measures the incoming rows without exposing each
intermediate page, then reveals the accumulated initial content together.
Existing reading windows remain visible during older-page loads. History
controls occupy a full-width top area with reserved action-row height; their
loading/button transitions do not squeeze the transcript horizontally.

Only the selected visible view reads live chat. Disconnecting or changing views cancels
its request and stops subsequent reads. The public native long-poll RPC has no
per-call cancellation parameter, so one already-running read can finish within
its bounded wait; its obsolete response is discarded.

On reconnect, the browser retains its old content and cursor. New durable events
can be read forward without retransmitting the entire old display window.
Previously received tool ownership remains browser state.
The browser retains the existing capped tool details rather than duplicating
large raw outputs/arguments. Accepted user answers and message bodies remain
complete. This is browser retention, not an additional server chat cache or a
claim that native JSON-RPC can omit those fields.

Ephemeral delta replay is not guaranteed. If message C has a missing interval,
keep its existing text, indicate that the complete message is pending, and do
not append unknown-gap deltas as contiguous text. A later durable full
`assistant.message` replaces C; waiting for the whole task is unnecessary.
If native never saved that content before interruption, there is no promise
that the unsaved draft can be recovered.

`cursorStatus:"expired"` is not a successful continuation. The native boundary
returned with it may overlap or differ from the previous range. Preserve the
current view and require an explicit rebase rather than silently jumping to
latest. Rewind/compaction also emit `chat/invalidated` metadata signals without
embedding a history snapshot.

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
replace these contracts for Web, MCP and the Weixin consumer.

The session plan keeps native plan text and todos. The old changed-files list,
which depended on replaying the complete transcript, has been removed.
Queue, decisions, native tasks, stop protection, notifications and file APIs
retain their independent responsibilities.

First-reply naming uses a bounded native eligibility read, not a saved
already-named/history flag. Copilot's first-input preview and generated automatic
titles are both non-user names; a nonempty name is not proof of prior naming.
The first completed reply in the current native history may generate a title,
including after a cold rewind to empty. Native manual names always remain
protected. An ordinary later reply does not retrigger the naming model query.

An isolated runtime 1.0.83 fixture confirmed forward cursor reuse between live
and passive readers, including passive continuation after runtime restart,
without losing the fixture's user/assistant messages. Duplicate system-message
events need not be present on disk; shutdown adds its own event. The connector
uses this durable forward boundary when native unloads, and still treats native
expiry as an error rather than inventing a replacement cursor. This is not a
promise that every native cursor lasts forever or every live event is durable.

Cold native disk indexing and filtering I/O remain native implementation
properties. A bounded event response does not prove constant-time disk access.
Cost experiments distinguish native RPC count, returned event/byte volume,
client projection work and actual I/O.

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

The built browser, using synthetic HTTP events at 390×844, initially read eight
events (one page plus the bootstrap tail) and displayed 1.85 screen heights.
Browser interaction checks preserved the reading anchor on prepend and session
switch, kept a draft, froze partial C across a gap, replaced it exactly once on
completion, and stopped on expired cursors without discarding loaded rows.

Weixin delivery reads at most 64 native events per page. If that page contains
events after the first deliverable reply, one bounded prefix read obtains the
native cursor immediately after that reply. Empty/non-message pages advance too.
A not-yet-delivered reply keeps its pre-page position so final evidence can be
reread precisely without scanning the conversation. Existing legacy
checkpoints are drained through one bounded migration window before adopting a
native tail; an absent anchor stops migration instead of skipping or resending
unknown output.

This chat transport does not make inherently history-wide operations into
point queries. For example, existing fork safety preflight checks inherited
schedules and unfinished work before dispatching the native fork. Such explicit
control operations remain distinct from opening or paging a chat view.
