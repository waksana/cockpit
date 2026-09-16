# Native event chat transport

This describes the current event transport. See the
[source status](cockpit-plan.md#source-status) and [module boundary](module-catalog.md).

Copilot owns durable history and model context. The Cockpit backend does not keep chat
windows, a live message fold, a message-ID index, resume checkpoints, or a
second conversation store. The browser owns its loaded messages, tool/agent
relationships, scroll position, and native cursors.

The global `/events` connection carries session metadata, control state and
resource invalidations, not chat message upserts. A chat reader exists only for
an actual consumer request. Ending that request never aborts the agent.
Native SDK callbacks still handle control/resource events; registering no
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

### Ordered presentation

The browser uses one native-event projection for history, streaming and reconnect.
Within a response, reasoning always precedes text. This is a fixed reading layout,
not a reconstruction of token-generation order. Text can appear before reasoning
arrives; later reasoning is inserted above that same response's text, naturally
moving it down. Missing content has no empty placeholder. Completion does not
switch to a different layout, create another thought or move tools above speech.
There is no provisional tail or separate temporary-content region.

Native message IDs identify text updates. Reasoning IDs identify thinking updates;
their native response references associate thinking with the corresponding text.
The final message's `reasoningText` must be retained: complete
`assistant.reasoning` notifications can be ephemeral and absent from history.
Neither reasoning ownership nor completeness is inferred from equal or similar
text. A complete snapshot replaces the corresponding incremental content.

Tool execution starts create independent rows, with names and arguments from
`tool.execution_start`. Results update those rows by scoped invocation ID, without
moving them to the completion event's position. Ordinary `toolRequests` embedded
in an assistant message do not create duplicate execution rows or determine tool
placement. Bounded windows can lack a start or completion; missing metadata and
unknown outcomes remain explicit. Dedicated decisions, agent lifecycle and
system events retain their own semantics.

Tool headers always occupy one line, both collapsed and expanded: one status
glyph on the left, an optional native description in the middle, and a small
tool name tag at the far right (leading ellipsis preserves its suffix). Tool headers
and overviews use compact 13px monospace text and 28px rows; name tags use 12px
text. They do not infer an intention from arguments.
Input and output appear only after expansion, including for failed tools. Only
actually clipped name/description fields are repeated in full in the details.
Complete header fields are not repeated. The whole header is a keyboard-operable
disclosure without a trailing arrow, hover fill or expanded container frame.

Consecutive process items are grouped only by the renderer. User speech,
assistant text and dedicated system/agent records end a process group; empty
message starts and skill activations do not. A response can contribute thinking
to the preceding process overview and text to the next speech row. The renderer
references the same response object rather than maintaining another history.
A group contains direct reasoning/tool/skill rows, not an extra hierarchy
of rounds or messages. Its counts describe visible tool and reasoning items;
skill activations are counted separately and remain discoverable in mixed groups.
Recorded failures and simultaneous active/unknown states remain visible as
separate glyph/count pairs in the single-line collapsed summary. There is no elapsed
time estimate, round count or generated summary.

The last overview defaults open. A reasoning item defaults open only while it
is the latest visible item in that agent's transcript, not merely the last thought.
A subsequent tool, assistant body or user message closes its automatic selection.
Explicit user choices take priority, including closing the latest item. These
choices are local to the mounted session view; older-page extension preserves
the group's mounted identity. They are not a second native state or history store.
Transcript spacing is derived once per visible boundary: 8px between related
speech rows, 12px between process and speech, and 16px when the speaker changes.
User timestamps sit 4px below their bubble. Empty events create no spacing;
date separators own their boundary. Prose rhythm and compact process-header
geometry remain distinct from those boundaries. There are no group divider lines, timestamp changes or
additional scroll-position writers.
Activity disclosure keeps its header height and icon slots fixed. Long tool
titles do not wrap on expansion; clipped fields wrap only in the details below.
Process headers share one text column. Expanded tool and thought details share
a single 24px inset, without accumulated nesting indents or progressively smaller
text. Markdown's first/last blocks have no outside margins, including class-based
paragraphs used by module renderers; the bubble's own padding is unchanged.
Initial history loading is a pane-level status
outside the measured rows; older-page refresh status stays inline.
Right-clicking chat content uses the browser's native context menu, not a custom
message-copy menu. Code and tool-detail copy buttons remain available.

Pending questions, plans and tool confirmations occupy their own framed cards
above a separate compact execution/queue panel. Both share a bounded dock above
the composer, with 8px between regions. Long decisions and queue contents remain
scrollable rather than overlapping the input. Execution status and available
actions use the same panel with or without a decision; a pending question does
not hide Stop. Stop retains its native queue-clearing behavior and stays disabled
while disconnected, closing, cancelling or another protected operation is active.
There is no queue-count heading or repeated composer explanation. The input
placeholder and submit label identify the active operation; muted placeholder
text remains distinct from entered text, including on focus. Existing attachment
and unconfirmed-send notices remain explicit. Queue items can be expanded to read
their full text independently of removal; there is no editing, reordering or new
steering mode.

### Chat spacing ownership

`styles/components/chat-spacing.scss` defines Chat-local relationship and inset
tokens, not a global numeric scale. A boundary has one owner:

| Relationship | Owner and rule |
| --- | --- |
| Reading column | 52rem maximum, responsive outer gutter (12px on narrow screens). Transcript scrollbar gutters are symmetric so the column stays centered with the dock and composer; classic scrollbars reserve extra space on both sides at constrained widths. |
| Transcript / dock / composer | The Chat parent owns an 8px region gap. The transcript has a 16px top inset and no bottom padding; neither the dock nor input adds another outside gap. Missing regions reserve no space. |
| Messages / process / speaker change | Visible row frames own 8 / 12 / 16px respectively. Metadata is separated by 4px. Empty history controls reserve no height. |
| Message interior | User bubbles retain 0.65rem by 0.85rem padding. Paragraphs/lists use 0.65em rhythm; code, tables and quotes use 0.85em. Headings retain their typographic margins. First/last blocks have no outside margin. Text-to-attachment separation is 12px, absent for attachment-only messages. |
| Expanded process details | Shared 24px inset, 4px after the header and 8px after details. Header dimensions and behavior do not change. |
| Cards | Ordinary panel inset and content separation are 12px; compact execution panels use 8px inset and 4px row spacing. Controls use an 8px gap. Decision body typography is unchanged. |
| Composer context | Notices, module-above contributions and native attachment fallback share one bounded, scrollable stack with 8px gaps. Children have no outside margins. An empty stack is hidden without unmounting module contributions. |
| Input and safe area | Field inset is 8px by 12px; the send target remains 40px square. Only the bottom bar adds 4px plus the safe-area inset. The read-only footer owns the equivalent inset when there is no composer. |

The host controls contribution placement, not a module's internal visual design.
Adding/removing notices or attachments does not replace the editor or scoped
module instances. No viewport-measurement controller, history reads or scrolling
compensation is introduced by the spacing system.

Persisted question replies show the original question above the answer in the
user bubble, without an emoji or a duplicate option list. Association uses
explicit native invocation references within the agent scope, not the nearest
question or the current pending card. Missing question records stay explicit;
older history can enrich the same reply without adding another message.

The opt-in lab's `ordered-events` scenario feeds isolated native inputs through
the actual `NativeWindow`, including repeated pages, older prefixes, new speech
and reasoning, disconnected partial text followed by a full event, and a cold
projection of the same durable events. Its step-by-step stream action replays
a normalized capture produced by SDK 1.0.13 / native runtime 1.0.83 using an
isolated synthetic provider: body first, later reasoning, final message, then
ephemeral complete reasoning. It exposes each transition separately rather than
batching away intermediate layout changes. It does not initialize a native client.

### Paging and live updates

An authoritative complete session snapshot releases browser reading windows for
IDs no longer present, including sessions deleted while this browser was offline.
Opening the control connection alone is not an authoritative session list.
Before its complete snapshot is applied, the browser shows synchronization rather
than declaring an absent row deleted.
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
An away-from-bottom viewport always offers a return-to-latest action. Text
increments and recorded tool updates can mark new content without requiring a
new message ID; unchanged pages and older history prefixes do not count as new
messages. The existing scroll owner remains the only writer of scroll position.

Initial loading fills at least two viewport heights when sufficient history is
available, not a fixed number of messages.
Having a materialized page does not mean the current viewport is filled. Re-entering
with a short retained window continues from its existing cursor when more history
is available, while keeping that retained content visible.
Upward reading prefetches older messages when the remaining loaded history above
the viewport falls to about one current viewport. After insertion, the reading
anchor is restored before deciding whether another bounded batch is needed.
There is at most one older read in flight per window; exhausted, failed, expired,
or unresolved-boundary windows do not automatically continue.
Browser backward reads use 32-event pages and stop initial filling once the
accumulated content reaches two screen heights (a complete batch can exceed
that minimum). One history action continues across native pages
until it adds visible content and resolves missing child/task ownership.
Ordinary tool starts are self-contained. Result-only windows show missing-start
metadata rather than reading backward just to recover an owning message.
It does not wait for running tools to finish. Main chat
and nested child messages share one window; metadata-only pages are not treated
as a finished message load. The initial live tail is captured only once.
Hidden tool rows, including skill and plan-mode calls, retain invocation identity;
suppressing duplicate presentation must not trigger extra history reads.

Older pages are folded as a prefix, not by replaying the entire loaded window.
Browser-local indexes point into retained display events: message/tool
dependents, native response references and agent aliases.
A newly supplied start repairs its waiting results; a newly supplied child owner
repairs that child's events. Those results merge
into the existing fold in native append order, preserving untouched message
objects, ownership indexes, live partials, and reading-anchor IDs. Bootstrap
adoption appends only events beyond the last overlap; empty/duplicate pages
advance positions without folding or replacing the view.
Body rows retain the native message ID. Thinking that arrives before that ID
uses the reasoning ID temporarily, then adopts the referenced response identity
without moving. The native response-parent event ID (`thoughtKey`) keeps its
disclosure choice stable through that adoption. Tool rows retain invocation IDs.

The supported producer links streamed reasoning and the final message through
their shared response-parent event. A complete reasoning notification references
the final message event. These references are scoped per agent, never inferred
from temporal adjacency or matching text. If a bounded record has no supported
link, its thinking is retained with an explicit association warning, not attached
to an arbitrary response. No extra history read or guessed content match repairs it.

Message-level `reasoningText` is a complete snapshot, not another delta or another
thought row. Its associated stream identities are finalized together, so repeated
pages or late deltas cannot resurrect an earlier fragment. Existing disconnect,
partial-stream and scoped event-ID guards remain: an unknown suffix after a gap
is not silently appended to an incomplete prefix. A full native snapshot resolves
that incomplete stream.

Projection calls are proportional to new events plus the dependency frontier
actually replayed, not the full loaded suffix on every page. A distant missing
child owner can still have a large frontier; immutable
message-array assembly and existing agent routing also have their own costs.
This is a local projection optimization, not a reduction in all native reads,
a fixed action budget, a truncated reading window, or a server chat cache.

Resolving child ownership and filling two screens can require
multiple pages, especially with low visible density or a distant parent task.
Consequently the whole history action has no universal event
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
cancelling in-flight reads. Actual native cursor expiry is still handled above;
manual compaction failures remain visible as operation errors.

## Media

Native tool binary payloads are removed from chat responses, without generating
image locators or maintaining a chat/image cache. The current thin Web has no
file cards, image/video previews or managed download service. Ordinary
text/Markdown remains; unsupported media syntax is not a reason to fetch,
retain or republish native images.

Enhanced file rendering belongs to a future frontend plugin, including both
new and historical messages in the same shared native event window. There is
no installed renderer ABI yet. The planned module owns its file references and
content delivery, as described in the [module catalog](module-catalog.md).

Native prompt attachments are separate from chat presentation. HTTP/MCP can
forward SDK file/directory/selection/blob inputs; this neither uploads a
browser-local file nor promises a renderer or model support for every format.
The exact client shape is documented under
[native attachment input](../apps/mcp/README.md#native-attachment-input).

Native binary results arrive as event JSON/base64, not a public byte stream or
a confirmed single-part asset getter. The adapter cannot avoid bytes that
native already included. It must not advertise zero-copy or source-side field
projection. There is no separate native-image history lookup or tail scan.

## Native cursor and cost boundaries

Queue, decisions, native tasks and stop protection remain independent of chat display.

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
events need not be present on disk; shutdown adds its own event. The chat reader
uses this durable forward boundary when native unloads, and still treats native
expiry as an error rather than inventing a replacement cursor. This is not a
promise that every native cursor lasts forever or every live event is durable.

Cold native disk indexing and filtering I/O remain native implementation
properties. A bounded event response does not prove constant-time disk access.
Cost experiments distinguish native RPC count, returned event/byte volume,
client projection work and actual I/O.

MCP adds a smaller output window and explicit single-event JSON fragments,
not a different native history source or a body-offset API. Its bounds and
reread cost are maintained only in
[MCP pagination](../apps/mcp/README.md#native-event-pagination).

Commands and evidence requirements are maintained in the [testing guide](cockpit-testing.md).

This chat transport does not make inherently history-wide operations into
point queries. For example, existing fork safety preflight checks inherited
schedules and unfinished work before dispatching the native fork. Such explicit
control operations remain distinct from opening or paging a chat view.
