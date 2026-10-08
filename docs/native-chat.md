# Native event chat transport

Internal spec for current chat transport. See [architecture](architecture.md) and the
[module catalog](modules.md) for adjacent boundaries.
Known projection and module-window freshness limitations are tracked with the
[current implementation gaps](architecture.md#implementation-gaps).

Copilot owns durable history and model context. Cockpit backend has no chat cache, message
fold/index, resume checkpoints or second conversation store. The browser owns loaded
display rows, tool/agent relationships, scroll position and native cursors. `/events`
carries session metadata, control state and resource invalidations, not chat upserts. Chat
readers exist only for consumers; ending a reader never aborts the agent.
Native SDK callbacks still handle control/resource events; not registering a chat handler
does not mean the SDK transport stops receiving native notifications.

## Native activity in existing control summaries

`POST /intent/session/resources` with `{"sessionId":"...","resources":["control"]}`
includes `meta.activity`. The same summary is used by `session/get`, `session/list`,
`runtime/snapshot` and global SSE snapshot/`session/added`. There is no
`session/activity`; actionable task details use the `controls` resource below.

One control pass reads `metadata.isProcessing`, `metadata.activity`, `tasks.list`,
`queue.pendingItems` and `mcp.list`; `control` + `queue` reuses the queue read. No chat
scan, implicit load, polling, inference, cross-request cache or extra native call is
introduced. `sampledAt` is the completion time of these non-atomic reads.

| Field | Boundary |
| --- | --- |
| `processing` | Native turn or background continuation; not model-generation proof. |
| `hasActiveWork` | Broad native flag; can lack a specific explanation. |
| `abortable` | Sampled native capability, not a promise an abort succeeds. |
| `tasks.activeAgents`, `tasks.activeShells` | Tracked matching tasks with native status `running`. |
| `tasks.unknown` | Unrecognized task types/statuses. |
| `queue.pendingCount` | Native pending items, including commands/model changes. |
| `queue.steeringCount` | Immediate steering entries, including in-flight entries. |
| `queue.inFlightSteeringCount` | Subset of `steeringCount`; never add both. |
| `mcp.pendingConnectionCount` | Connecting MCP entries, not all MCP operations/readiness. |

SDK task statuses are `running`, `idle`, `completed`, `failed`, `cancelled`. Idle/terminal
tracked tasks are not active. Unknown statuses keep legacy busy protection. Legacy
`status`, `nativeProcessing` and `activeSubagents` keep safety semantics: first two
aggregate busy work; `activeSubagents` counts all non-idle and non-terminal tasks,
including shells and unknown statuses. Display uses typed counts; lifecycle gates read
fresh state.

`activity:null` means unloaded, unavailable or invalidated. Omission means `control` was
not requested. Unknown sessions return `meta:null`. Failed/malformed reads reject and emit
an `activity:null` patch. Control/task/queue/MCP invalidations, unload and native events
during a read clear the sample. Consumers reconcile control after relevant invalidations
and reconnect, not after `activeOperations` read-lease patches.

The summary contains no task IDs, descriptions, prompts/results, shell commands, queue
text or MCP names. UI uses a one-line icon summary. On-demand `session/panel`
(`section:"tasks"`), queue and MCP reads stay separate and may include details. MCP
list/get Markdown spells out sampled facts, unavailable state and steering subset.

### Full synthetic control exchanges

Synthetic examples cover these protocol shapes: loaded shell work has `processing:false`,
`hasActiveWork:true`, `activeShells:1`, `activeSubagents:1`; coexisting processing,
shell/agent work, decisions, queue and MCP facts are concurrent; unknown task status
increments `tasks.unknown`; indexed unloaded session returns `loaded:false`,
`activity:null`; missing ID returns `meta:null`. The JSON shape is the ordinary
`session/resources` control projection.

## Native activity controls

Mounted conversations read `session/resources` with `controls`; sidebars use `control`.
Combined `control` / `controls` / `queue` reads reuse the activity pass. `controls`
contains the loaded-handle token, active native agent/shell IDs and titles, and only
steering messages not yet folded into the turn. Queue batches keep canonical queue item
IDs; `canSteer` is explicit.

`POST /intent/session/control` takes `{sessionId, token, action}`. `token` is the loaded
native handle identity, not an authorization credential. Operations never implicitly
resume sessions; targets are rechecked so unload/reload, obsolete handles, ended tasks and
replaced decisions do not redirect actions.

| Action | Scope |
| --- | --- |
| `stop-task` with `id` | Cancel that native task; transcript/output remain. |
| `clear-tasks` with `kind` and `ids` | Cancel captured IDs; remove tracking only where native terminal state allows; never delete chat history. |
| `clear-queue` | Clear native pending queued work, not context-consumed messages. |
| `remove` with `id` | Remove one canonical pending queue item. |
| `steer` with `id` | Move an eligible queued message into live main-turn steering, not another prompt. |
| `cancel-decision` with `kind` and `requestId` | Resolve the identified native decision through the matching cancel/exit/interrupt path. Ask interruption preserves queued prompts/background work; runtime controls later queue execution. |
| `stop-all` | Request cancellation of current work and queue, including background tasks and compaction through public native APIs. Not a process kill/restart. |

Results include every attempted native outcome, partial failure and uncertainty. Rows hide
only after invalidation and fresh reads. Confirmed errors stay visible; uncertain writes
are not retried. Legacy `cancel` keeps queue-clear plus abort semantics. Refreshes retain
previous appearance separately from current facts and disable stale operations.
Disconnect, handle replacement and unmount block late publication; read failure has
explicit retry.

Steering acceptance does not create a local user bubble; native `user.message` with
`delivery:"steering"` does that when consumed. In-flight steering is not counted again as
queued. Prompt acceptance and control writes share a short per-session ACK gate. Clearing
pending steering retires receipts without deleting newer prompts. Global Stop binds the
original main-turn identity before asynchronous preparation.

## `POST /intent/session/chat`

Capability schema:

```json
{"sessionId":"session-id","source":"live","direction":"backward","max":64,"waitMs":0,"bootstrap":true}
```

| Input | Rules |
| --- | --- |
| `source:"persisted"` | Uses `client.rpc.sessions.readPersistedEvents`; works unloaded; no agent/type filters or wait. |
| `source:"live"` | Uses existing handle `rpc.eventLog.read`; supports native `agentScope`, `agentIds`, `types`; browser uses all-agent scope. Default live chat types are projection-consumed events only, excluding unused tool-argument deltas and metadata already on `/events`; unsupported passive filters reject; reads never resume sessions. |
| `max` | Native events, not display messages; default 64, public max 256. One request = one native page read. |
| `direction` | `forward` or `backward`; keep direction/source/filter data with opaque cursor. |
| `waitMs` | Max 30000, only live forward. |
| `includeEphemeral` | Only live forward can include ephemeral events; `false` makes durable-only. Passive/backward are durable-only. |
| `bootstrap:true` | Fresh live backward only; captures `eventLog.tail()` before the page and returns `liveCursor`. Following it may overlap but must not gap. |

Results contain `sessionId`, `events`, `cursor`, `cursorStatus`, `hasMore`, `source`,
`direction`, `read:{rpc,events}`. Titles/directories/runtime metadata belong to
`session/get` and lists. Initial request without live handle/cursor makes one existence
lookup; cursor continuation does not. Counters describe event-log reads. Native session
existence is authoritative; do not send an empty cursor as a nonempty locator. Backward
arrays are chronological within the page. Forward reads can interleave durable and
ephemeral events. Process whole pages before advancing saved cursors. Event IDs
deduplicate overlap; assistant `messageId` identifies authoritative replacement.
UUID lexical order is not conversation order.

## Bounded text view

`POST /intent/session/chat/text` and the raw MCP tool name
`cockpit_read_session_text` provide a separate opt-in body view. Existing
`session/chat`, `cockpit_read_session`, Web Chat and module SDK contracts are
unchanged. Modules can select this MCP tool without an SDK publication.

```json
{"sessionId":"session-id","source":"persisted","direction":"backward","max":16,"maxBytes":16384,"scanPages":4}
```

MCP uses `session_id`, `limit`, `max_bytes`, `scan_pages`; `source`, `direction`,
`cursor`, `since` and `bootstrap` keep their names. It returns compact JSON, without a
Markdown wrapper or a duplicate structured copy.

| Bound | Default / maximum | Meaning |
| --- | --- | --- |
| `max` | 16 / 64 | Returned message fragments, not native events. |
| `maxBytes` | 16384 / 65536 (minimum 8192) | UTF-8 bytes of the entire compact JSON result, including cursors and metadata. Not the MCP envelope. |
| `scanPages` | 4 / 16 | Native page reads, including partial-page replay; each requests at most 16 events. |

Results contain `view:"text"`, exact `sessionId`/`source`/`direction`, `messages`,
`cursor`, `hasMore`, `scanLimited` and `read:{rpc,pages,events}`. Counters include
replayed events and bootstrap's extra tail RPC, but not metadata existence
lookups or SDK-internal work. `events` counts events returned by native pages,
not internal scans (especially for live filters). Backward messages are **newest-first**, forward
messages **oldest-first**. An empty filtered page is not necessarily the end:
continue with its cursor when `hasMore` is true. `scanLimited` marks exhaustion
of the native-page budget, not output-message or byte limits.

Only primary durable `user.message` and `assistant.message` nonblank `content`
is selected. Text beside tool calls is retained verbatim; reasoning, encrypted
fields, tool arguments/results, ephemeral tokens and subagent text are excluded.
Persisted reads filter bounded native pages locally; live reads also request
native primary/body filters. Pending asks and current activity belong to
`session/get`, not inferred text or completion summaries.

Each fragment preserves `eventId`, native `messageId` when present, role and
timestamp. `offset`, `nextOffset` and `totalCharacters` count UTF-16 code units;
splits never divide a surrogate pair. `nextOffset:null` finishes that message.
To read its remainder, pass **the returned cursor**, not a guessed message ID or
offset. It also preserves all unreturned messages in that native page. Four
attachment descriptors at most expose only short type/display-name/path/MIME
fields; `omittedFields` and `omittedAttachments` disclose omissions. Long paths
are omitted, never truncated into misleading references. No files, blob bytes,
image bytes or attachment selections are fetched.

Cursors are caller-owned, versioned position descriptions (`ct2.` plus base64url
JSON), bound to session/source/direction and this fixed view/filter version.
Save and pass them unchanged; limits may change on continuation. They are not
authorization credentials or server-maintained read state. Normal authentication,
scope and session checks apply on every request, even when a caller constructs a
description. Strict schemas bound every field, native cursor, index and body
offset; unknown fields and incompatible versions fail. No filesystem paths are
resolved from positions. Ordinary Host restart does not expire them.
Partial native pages are reread from their original cursor and
checked against their full-page hash before using the saved index/body offset.
Native expiry, nonadvancement and changed partial pages fail explicitly without
fallback. Appending to an unanchored latest partial page can also invalidate it;
explicitly repeat the original `since` without `cursor` to recover that incremental
range under the same per-call budgets, deduplicating `eventId`/offset fragments.
Do not advance `since` until the entire range is delivered. Fragment sizes can
change on replay: use offsets to reconcile overlapping text rather than blindly
concatenating fragments. If the text itself changed, invalidate the old assembly
and reread it. Initial historical pagination has no business checkpoint: restart
that explicitly selected historical traversal and deduplicate, not an automatic
recent-only reset. Between complete
pages, history invalidation follows the SDK's native cursor contract; this is
not a transaction or a global history snapshot/version service. No claim is
made to detect an upstream mutation that the native cursor API does not expose.

Fresh live backward `bootstrap:true` captures a tail before reading and returns
a separate text `liveCursor` for forward increments. History and increments may
overlap; deduplicate by `eventId`/fragment offset and handle native message
replacement by `messageId`. Forward reads at the current end retain a cursor
for later increments. This reader does not wait, poll or load sessions.

### Passive incremental checkpoints

The SDK has no passive tail snapshot or public event-ID seek. Backward cursors
cannot become forward cursors, nor can live positions be relabeled persisted.
Instead, the text API supports a generic **backward incremental range** with
`since`: a caller-owned checkpoint records one actual native boundary event
and its hash, not a stored transcript, numeric seek or timestamp ordering.

1. Establish a baseline with `{"session_id":"S","source":"persisted","limit":16}`.
   Consume all returned text and, if no `checkpoint` is returned, keep reading
   its `cursor` until the bounded native page/fragment is complete and a
   checkpoint is available. Older history remains separately pageable.
2. When notified of new activity, call
   `{"session_id":"S","source":"persisted","since":"CHECKPOINT"}` without cursor.
   This starts at the newest native page and reads backward toward that exact
   boundary. Returned new text is newest-first, not chronological forward.
3. If `hasMore:true`, continue with the same `since` plus the returned `cursor`.
   Empty filtered pages and incomplete long-body fragments do not advance the
   processed boundary. Only after reaching the old boundary does the result
   expose a new `checkpoint` and `hasMore:false` for this incremental range.
   Save that checkpoint **after** processing every fragment/page in the range.
4. An append during older-page traversal is not lost: the new checkpoint uses
   this range's original newest event, so the next `since` call includes later
   appends. Partial-page mutation can explicitly reject the read; restart the
   range from its previous checkpoint and deduplicate delivered event/offsets.

The initial baseline selects recent history, not a promise to process all older
history. A notification's newest event ID is **not** a checkpoint or proof that
its text has been read. The host stores no business read/notification position.
`since` requires backward direction, cannot combine with bootstrap, and remains
bound to the exact source/session. A missing or changed anchor rejects the
range (including rewind/deletion), never succeeds with an empty update.
An initially empty session's checkpoint explicitly covers its empty baseline.

Persisted checkpoints remain usable after the source session unloads, the
native child runtime restarts, or the **complete Host process exits and a new
process opens the same native persistence**. The agent decides when a range is
processed; Assistant or another caller persists the position. The Host stores
no per-caller checkpoint, read table, signing key, index or transcript mirror.
Native cursor expiry and history mutation are separate from Host lifetime:
recover a partial incremental range with its original `since` as above; a
missing/changed checkpoint anchor requires an explicit caller decision about
the history gap, never a success-shaped empty update or recent-only reset.
The SDK does not supply global snapshot isolation or stable event-ID seek.
Loaded consumers can instead use the separate live bootstrap /
forward `liveCursor` path, which is not a passive checkpoint.

Legacy v1 tokens carried a random process-key signature. A lost key cannot be
recovered, and the new Host does **not** authenticate that old signature.
For one-time migration it accepts the strictly validated legacy payload as
caller-supplied coordinates, binds its original query, and checks the actual
native anchor/page exactly as for v2. Successful reads emit only v2 positions.
Keep the original legacy `since` during that range's pagination, then save the
returned v2 checkpoint after processing the range. This can recover unchanged
history without manufacturing authentication or silently selecting a new
baseline. Invalid legacy shape, missing/changed anchors or unusable native
cursors fail with the same explicit recovery requirements.

These are **output and RPC bounds**, not upstream event-body memory/time bounds:
the SDK can materialize huge native events before host filtering. Large-message
fragments reread and hash the entire native page, without a chat cache/index or
native body-offset API. Exceptionally oversized native identity/cursor metadata
fails explicitly with a raw-reader path rather than returning an invalid
reference or overflowing the byte budget.

## `POST /chat/stream`

The selected visible browser window opens one authenticated, CSRF-protected SSE stream
with `{sessionId,cursor,max:64,agentScope:"all"}`. `cursor` is required; the explicit
empty native tail sentinel differs from omitted reconnect position. Other consumers may
use `agentIds` and `types` filters.

The endpoint sends `{type:"page",page:NativeChatPage}` frames. It drains durable events
after the saved cursor with zero wait, then continues from that cursor with ephemeral
events and native wait up to 30s. It never takes a fresh tail during transition.
Cursor-advancing empty pages are delivered; unchanged idle results send heartbeat
comments. Empty/duplicate pages do not rebuild display snapshots.

Server ownership is limited to the connection, current native read and bounded HTTP write
buffers. It waits for backpressure, chunks large messages without splitting Unicode pairs,
closes stalled consumers, and keeps no per-page ACK/replay cache. Reconnection uses the
last fully applied cursor; disconnect with bytes in flight can re-read an undelivered
tail. TCP backpressure does not prove the browser has applied an SSE frame.

Native errors are terminal error frames; expiry is a terminal expired page. Failed live
reads can confirm idle cleanup once and report `SESSION_UNLOADED`. Closing a view does not
abort the model. Native per-read wait has no cancellation parameter, so a completed
obsolete response is discarded and cannot trigger another read.

## Browser reading

### Ordered presentation

The browser uses one native-event projection for history, stream and reconnect. Within a
response, reasoning displays before text; late reasoning inserts above that response text,
while completion never moves tools above speech. Complete snapshots replace increments.
Native message IDs update text; reasoning IDs update thinking, with response references
associating thinking to text. Final message `reasoningText` is retained because complete
`assistant.reasoning` can be ephemeral and absent from history; equal text is never
ownership or completeness evidence.

Tool rows come from `tool.execution_start` and update by scoped invocation ID; embedded
assistant `toolRequests` do not duplicate rows or place them. Bounded windows may lack
starts/completions, so missing metadata and unknown outcomes stay explicit. Headers are
one-line disclosures with status glyph, optional native description and right tag
(`mcpServerName` or clipped tool name). Arguments and output appear only after expansion,
failures included. The header is keyboard-operable; no trailing arrow, hover fill or
expanded frame is added.

Process grouping is renderer-only. User speech, assistant text and dedicated system/agent
records end a group; empty starts and skill activations do not. Groups contain direct
reasoning/tool/skill rows. Counts describe visible tools and reasoning; skill activations
are counted separately. Failures and simultaneous active/unknown states keep separate
glyph/count pairs; no elapsed estimate, round count or generated summary is added.

The last overview defaults open. A reasoning item defaults open only while it is the
latest visible item in that agent transcript; later tool/body/user content closes that
automatic selection. User choices win locally for the mounted session view and are not
native state. Activity disclosures keep fixed header height and icon slots; long titles
clip in headers and wrap only in details. Thinking uses the safe Markdown renderer;
first/last Markdown blocks have no outside margins. Right-click uses the browser menu;
code/tool copy buttons remain.

Pending decisions (ask_user, plan confirmation, MCP elicitation) are one card at the end
of the transcript, not part of the input card: native callbacks carry no tool call
position. Several pending requests share that card as tabs in arrival order
(`SessionMeta.decisions`); a new arrival never steals the selection, and the composer
answers the selected tab (ask: answer; plan: feedback; elicitation: card buttons only).
Answered requests stay in the transcript as done cards: ask and plan replies come from
native history (`ask-reply`, `plan-reply`); elicitation answers are not in native history,
so the browser tab keeps a local "handled" marker whose chosen action is lost on refresh.

<a id="elicitation"></a>
MCP elicitation supports explicit acceptance of simple confirmations and flat
forms from the pinned SDK: strings (including enums and titled choices), numbers,
integers, booleans and string-choice arrays. The pending request exposes
`requestedSchema`; the card displays labels, descriptions and defaults, and returns
typed `content` with `respondElicitation`. Defaults never submit automatically.
Optional fields have an explicit omit action, distinct from an empty string.
Required fields, types, choices, bounds and supported string formats are checked
again before resolving the native callback. Invalid content leaves it pending;
decline/cancel omit content and do not require a valid form. Empty forms accept
with `{}`. The browser keeps form edits only in memory while the decision card is
mounted, including across its tabs; it does not persist form content in handled
markers or local storage.

URL flows and schemas with unknown fields or constraints remain decline/cancel-only
with an explicit `unsupportedReason`. The host does not open URLs, invent missing
values or weaken a schema to make Accept available. This is independent of
`allow-all`, which approves tool execution permissions, not elicitation answers.

Ask questions and their recorded originals use the existing chat Markdown renderer,
including lists, links, code and tables. Each choice remains one full clickable button,
with a noninteractive label produced by the same Markdown parser. Emphasis, strikeout
and code stay formatted; links retain their text, media references and task-list states
remain text, and block content is flattened into readable lines. Labels contain no
navigation, copy controls, media, module replacements or nested tab stops.
Clicking any part of the choice or pressing Enter/Space on its button sends the complete
original choice string, not rendered text or HTML.
The pending question keeps its ask message identity for module presentation; Markdown
does not invent a native message origin for callbacks or historical question text.
Missing original questions retain the explicit unavailable notice.

Execution status/actions, queue and composer share one default-open input card
when a header is needed. The header is a shared [disclosure](frontend-guidelines.md#disclosure)
row with a leading chevron; it folds content below but leaves status and Stop/interrupt
controls as siblings. Header
minimum is 32px desktop and 44px coarse pointer. Idle input has no header; long content
and streaming do not auto-fold. The input stays in normal flow at the bottom with one flex
budget capping notices/queue/editor at 70% of Chat height; the card body
participates in that flex layout. Questions and choices wrap
continuous identifiers at their component boundary without clipping or widening. Choices
submit the complete original value; freeform uses existing send; choice-only questions
block freeform. Module action rows use a 4px row gap plus 4px icon-facing text inset, with
8px text clearance from module and send hit areas. Different request IDs or
ordinary/decision transitions use distinct editor/draft identities; late callbacks cannot
edit or submit replacements. Collapse preserves drafts and attachments.

Submission progress shares the status line when present. Busy labels report local
submission, not native success. Session errors, uncertain sends/answers, attachment
notices and interrupt results stay outside disclosure. Stop keeps native queue-clearing
behavior and cannot dispatch while disconnected, closing, cancelling or protected.
Focusable pending controls may use guarded `aria-disabled`.

Session rows and input headers use the compact `SessionActivity` projection: Terminal
shell, Wrench tool, Bot agent, CircleHelp decision. Concurrent facts use separate
icons/counts. Overall activity means session activity, not proven model generation.
Retained samples are labeled previous until fresh; unload/removal/ reconnect discards
them. Stop/interrupt acknowledgements have no success banner; remaining shell/agent facts
and failures stay visible. MCP tools are tagged by exact `mcpServerName`; matching is
exact, optionally stripping `functions.`, never substring guessing. Expanded MCP details
list the full tool name, server, and differing native `mcpToolName`. Queue rows expose
keyboard-accessible copy beside remove; there is no queue-count heading, editing,
reordering or new steering mode.

### Chat layout and typography

`styles/components/chat-design.scss` maps Chat layout, typography, relationships and
insets to host foundations. Controls use public radius; flat process/queue rows do not
become cards.

| Role | Treatment |
| --- | --- |
| Main content | 16px message prose, reasoning, questions and input. Prose 1.7; decision text 1.6; editable controls 1.5. |
| Secondary | 14px choices, plan summaries and task prompt inside an agent card; agent response remains main content. |
| Process/labels | 13px labels/code; tool headers remain 28px rows with UI line height. |
| Metadata/queue | 12px; timestamps use 18px line box/tabular numerals; queue density independent of type size. |
| Markdown hierarchy | At 16px context, headings 24 / 20 / 18 / 16 / 14px; scale locally. |

User time is 4px below the bubble, right-aligned. Assistant time starts its document
group, left-aligned with text and separated by 4px. `time` keeps native timestamp, full
local date/time/timezone title and accessible label. Decision dock, process groups and
agent overviews use their own inline-size containers so narrow desktop Chat behaves like
phone width without shrinking reading text. Copy controls reserve confirmation width; old
copy results cannot label new values.

### Spacing ownership

Each boundary has one owner:

| Relationship | Owner and rule |
| --- | --- |
| Reading column | 52rem `--chat-reading-width`; responsive 12px narrow gutter; symmetric scrollbar gutters keep column centered. |
| Transcript/dock/composer | Parent owns an 8px region gap; transcript top inset is 16px; missing regions reserve no space. |
| Messages/process/speaker | Visible rows own 8 / 12 / 16px; metadata 4px; empty controls no height. |
| Message interior | User bubbles 0.65rem × 0.85rem; paragraphs/lists 0.65em; code/tables/quotes 0.85em; first/last blocks no outside margin; text-to-attachment 12px. |
| Expanded process details | 24px inset, 4px after header, 8px after details; header dimensions unchanged. |
| Cards | Ordinary panels 12px inset/separation; compact execution 8px inset and 4px rows; controls 8px gap. |
| Composer context | Notices, module-above contributions and attachment fallback share one bounded stack with 8px gaps; during questions it also contains question/choices. Empty stack hides without unmounting modules. |
| Input/safe area | Field inset 8px × 12px; send 40px square; ordinary bottom bar adds 4px plus safe area; answer mode outer card owns bottom spacing. |

Host owns placement, not module internal design. Native fallback is omitted when an active
module renders draft attachments. Notices/attachments do not replace the editor or module
instances. Persisted question replies show original question above the answer, using
explicit native invocation references scoped by agent. Missing question records remain
explicit.

The opt-in lab's `ordered-events` scenario feeds isolated native inputs through
`NativeWindow`: repeated pages, older prefixes, speech/reasoning, disconnected partial
text followed by full event, and cold projection. It replays a normalized SDK/runtime
capture with body first, later reasoning, final message and ephemeral complete reasoning.

### Paging and live updates

Authoritative complete session snapshots release browser windows for removed IDs. Unloaded
sessions, partial resources, filtered lists and transient failures are not deletion
signals. Surviving windows keep cursors, nested-agent ownership and reading state; this is
not LRU and does not delete drafts/files.

Entering a chat view lands at latest loaded content. Re-entry does not restore a previous
cross-view scroll position, though retained history/cursors avoid fresh reads. The single
scroll owner positions first committed layout before paint, coalesces DOM notifications
and corrects after `ResizeObserver`. Rerenders, live updates and older-page insertion
preserve the active reading anchor and gestures.

Successful submissions from the mounted page resume bottom-follow only for the send
button, keyboard, module captured-draft sends and native decision answers/ actions after
strict native ACK. Failed, blocked, unknown or pre-dispatch- cancelled sends, edits,
remote messages and streaming updates do not initiate follow. Return-to-latest appears
only at least one current transcript viewport from bottom; unchanged pages and older
prefixes do not mark new content.

Upward reading prefetches older messages at about one viewport remaining. At most one
older read is in flight per window; exhausted, failed, expired or unresolved- boundary
windows do not auto-continue. Browser backward reads request 200 events, within the public
per-page bound 256. Native cursor, `hasMore` and `cursorStatus` are authoritative: event
limit, not message/byte/height. One API page delegates to one native read plus one-time
live-tail bootstrap; no full-journal prefetch.

Initial filling stops after accumulated content reaches two screen heights; one history
action can cross native pages until it adds visible content and resolves missing
child/task ownership, but it does not wait for running tools. Result-only windows show
missing-start metadata instead of reading backward only for owners. Main and child
messages share one window. Older pages fold as a prefix, not by replaying the loaded
window; local indexes point into retained display events. New starts/child owners repair
waiting results in native append order while preserving untouched messages, indexes,
partials and anchors.
Thinking that adopts a referenced response identity keeps the native response-parent
`thoughtKey` so disclosure choices remain stable.

Supported producers link streamed reasoning and final message through shared
response-parent events; references are scoped per agent, never inferred from adjacency or
matching text. Unlinked bounded thinking stays with an association warning.
`reasoningText` is a complete snapshot; repeated pages/late deltas cannot resurrect old
fragments. Projection work is proportional to new events plus the dependency frontier
replayed, not the full loaded suffix. Resolving child ownership and filling two screens
has no universal event ceiling.

Incoming rows display progressively while follow/anchor is maintained. Existing windows
stay visible during older loads; the history-start hint stays normal flow until earliest
history is reached. Failure retry and rebase are explicit. Child cards use shared nested
projection; expanding a card makes no request. Child headers display recorded evidence
(started, ended, failed, cancelled or later activity), not current task registry state;
cancellation differs from failure. Later durable child activity supersedes older terminal
labels; failed tools alone and parent turn end do not end a child, and ephemeral fragments
alone do not establish a new execution boundary.

Only the selected visible view reads live chat. Disconnect/view change cancels its request
and stops subsequent reads; a completed obsolete native long-poll is discarded. Reconnect
keeps content/cursor and reads new durable events forward. Passive history cannot filter
at source; browser discards unrelated bodies. Ephemeral delta replay is not guaranteed:
missing intervals keep existing text and wait for a later durable full
`assistant.message`. `cursorStatus:"expired"` is not continuation; preserve the view and
require explicit rebase. Rewind emits `chat/invalidated`; compaction is not a chat-history
rewrite.

## Media

Native tool binary payloads are removed from chat responses without image locators or a
chat/image cache. The base Web UI renders text/Markdown and native attachment metadata;
the host owns no managed file library or browser upload/download service.

Loaded modules already extend new and historical messages in the same event window.
The public [Markdown and attachment contract](module-contract.md#64-markdown-and-lifecycle)
supports parsed link/image replacements and native attachment component middleware.
These are generic extension points, not a host file service: modules own enhanced file
presentation, reference resolution and delivery. Availability depends on the loaded
module; unmatched or failed replacements retain the base fallback. See the
[module catalog](modules.md) for file capabilities.

Native prompt attachments are separate from chat presentation. HTTP/MCP can forward SDK
file/directory/selection/blob inputs; this neither uploads browser-local files nor
promises renderer/model support for every format. Shape: [native attachment
input](../apps/mcp/README.md#native-attachment-input).

Native binary results arrive as event JSON/base64, not a public byte stream or confirmed
single-part asset getter. The adapter cannot avoid bytes native already included and must
not advertise zero-copy/source-side field projection.

## Native cursor and cost boundaries

Queue, decisions, native tasks and stop protection remain independent of chat display.

Runtime 1.0.83 fixtures confirmed forward cursor reuse between live/passive readers,
including passive continuation after restart, without losing root/child messages, tools or
lifecycle events. Cursor advances with consumption. Starting primary scope then switching
to all does not recover skipped child events; browser starts all-scope.
`includeSubAgentStreamingEvents:true` controls SDK push forwarding, not `eventLog.read`
scope or replay. A root `task` fixture exercised all-agent HTTP/SSE and recovered a
completed child response after disconnect. The tested background-child path did not emit
child text deltas, so token-by-token child replay is not established. Duplicate system
messages need not exist on disk; shutdown adds its own event. Reader uses durable forward
boundaries on native unload and treats expiry as an error.

Cold disk indexing and filtering I/O are native implementation properties. A bounded event
response does not prove constant-time disk access. Cost experiments separate native RPC
count, returned event/byte volume, client projection work and actual I/O. MCP uses a
smaller output window and explicit single-event JSON fragments; see [MCP
pagination](../apps/mcp/README.md#native-event-pagination).

Commands and evidence requirements are in the [testing guide](testing.md). History-wide
operations remain explicit control operations; opening or paging chat does not turn fork
safety preflight checks into point queries.
