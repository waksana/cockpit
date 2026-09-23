# Product requirements

Confirmed product requirements and accepted trade-offs, numbered for design,
review and acceptance. This is not an implementation inventory or a release
record; see [architecture](architecture.md) for the current implementation and
[native chat](native-chat.md) / [MCP](../apps/mcp/README.md) for interfaces.
A suggestion becomes a requirement only after explicit confirmation; existing
code never retroactively becomes a product decision.

<a id="r1"></a>
## R1 · Thin base, bounded extensions

Cockpit is a thin access and interaction base for native agent/session
capabilities. Copilot is the authority for capabilities and native state. The
backend faithfully turns selected Copilot capabilities into an API; the Web UI
uses a subset of that API for chat; MCP is another consumer of the same API.
Neither the backend nor the Web UI must cover everything. TypeScript, HTTP POST
and SSE are used, with one explicit contract for Web, API and MCP. The host
provides native operation adapters, a text Web UI, necessary host resource
management and graceful exit. Copilot's `assistant` messages and `task`
subagents are native capabilities.

Enhancements and business features are modules ([catalog](modules.md)) that follow
the [module contract](module-contract.md). The frontend is also extended through a
versioned public UI composition contract (including composer file/speech
interaction and file presentation in chat). Menu action declarations, real semantic
component middleware, state/service/draft and Markdown are four distinct
mechanisms; menus never wrap navigation and grant no arbitrary page/router
registration. Each module capability is implemented and verified against the
shared contract.

<a id="single-service-target"></a>
### Confirmed targets

Implementation status is tracked in [architecture](architecture.md#target-gap).

| Target | Boundary |
| --- | --- |
| One service package | Backend entry, built Web and runtime dependencies; starting it serves everything. Building, testing and packaging are development engineering. |
| Host-managed installation and start | The operator chooses where and how the package runs; restarting after exit is manual or up to host facilities. |
| Modules follow the host lifecycle | Frontend and backend ship as one module package served by the host; separate repositories, versions, configuration and business data may remain. The first backend model is trusted main-process import, with no process-level fault isolation. |
| Failed modules are disabled locally | A module that fails to start is disabled and reported; the host and other modules keep serving. |
| Cold module loading | Installation, version and enable choices change only what the next start loads. No hot loading, hot enable/disable or hot update, and no framework reserved for hot switching or changes to the trusted import model. |
| Per-module MCP entries | Under the same port, each module path offers its own MCP tools/resources/prompts and protocol connection, not one large shared tool table. |
| Graceful exit waits only for sessions | Exit follows native session idleness; module business, background connections and close receipts are not wait conditions. |
| Optional next-start message | A module may save a one-time continuation prompt through its own MCP and send it to a chosen native session once the next host is ready. It is not a hidden host welcome, deployment receipt or native state mirror. |

"One service process" does not exclude the SDK's out-of-process runtime or native
MCP/tool subprocesses, and the browser is not a host process. Modules load and end
with the host; exit may interrupt module work, and modules handle recovery and
unknown results. "One package" does not mean zero prerequisites: platform, Node
and native dependencies must be stated; bundling Node is undecided. An MCP path is
a protocol/tool namespace, not a permission system. Native per-session MCP
switches are not module hot loading.

<a id="r2"></a>
## R2 · One authority for native state

The backend keeps no short- or long-lived copy of native chat or session state,
does no background sync, private database traversal or cache fallback.
Per-request results and local indexes are released after use; SDK internal caches
are distinct from Cockpit-built copies.

Necessary, lifecycle-bound control callbacks, connections and in-flight resources
are allowed; the frontend may hold its current display window. Text drafts and the
display window are frontend interaction state. Managed files, pinning and
notifications belong to their modules. Module role content, business identities
and records belong to modules; the host keeps only load metadata (installation
selection, actual import references, generic registrations, owned resources).
Business and native data ownership are explicit; product changes never authorize
deleting or migrating user data.

<a id="r3"></a>
## R3 · Use SDK contracts faithfully

Check each capability's calls, adapters and consumers against the installed
version's public contract; do not rebuild what native already does. Not every SDK
function must be wired. Choosing not to offer a capability differs from changing
the meaning of an offered one; the latter cannot hide behind "thin adapter" or
"simpler UI". Naming, validation, transport and projection may adapt, but must not
invent decisions, alter native side effects or lose the information that separates
accepted, applied, failed and unknown.

Keep MCP connection/auth/stopped states, schedule kinds, model effort/context tier
and queue semantics. Missing, unsupported and unknown values stay distinct; model
tiers and defaults are never hard-coded or guessed, and queued/accepted never means
applied. An unrelated later read failure must not turn a successful change into a
reported failure.

Web, MCP and other consumers share native create/send semantics:
`session/new(cwd) → real native ID → prompt`. Creation sends no hidden initial
message, and no virtual session, reserved chat address or first-message lifecycle
replaces the native object. MCP maps the API directly; renaming and formatting do
not change semantics, conditions or side effects. Directory selection is only an
unsubmitted form; an empty native session may vanish after unload and is not recreated.

Confirmation requirements follow installed Copilot's public contract. The Web UI
may add human anti-mistake confirmations but never turns them into extra API/MCP
gates. Real native ask/plan/elicitation decisions must be preserved.

Errors are returned explicitly: no silent home fallback, mixed-source repair,
swallowed exceptions or faked success. Missing native capabilities are stated;
significant experience substitutes are agreed with the user first.

<a id="r4"></a>
## R4 · Read and compute only what consumers need

Avoid reading whole panels for a list or single field, full refreshes from
unrelated invalidation, duplicate requests and repeated whole-window computation.
Per-request results and local indexes may be reused; cross-request native copies
may not.

Account for cost per complete user action or reconnection — no per-batch budget
resets, bigger pages or treating events as messages to look better. Report
HTTP/MCP round trips, SDK calls, provable RPCs, events/bytes and repeated CPU work
separately; do not conflate them with tokens, disk I/O or production latency. When
the SDK only offers list, a necessary list is not a defect by itself. Optimizations
must reduce real cost, not just text or code.

<a id="r5"></a>
## R5 · Consistent history, live updates and reconnection

Main and sub-agents use one `all` scope from the start of reading, sharing the
frontend reading window and native cursor. Collapsed subagent views keep updating;
expanding needs no extra read or refresh. SSE pushes actual content, not
invalidations followed by cumulative refetches.

Ordinary reconnection continues from the valid same-scope cursor, backfilling
durable messages, tools and lifecycle and showing completed messages promptly.
Keep event deduplication, real ownership, full-message replacement of partials and
bootstrap race protection. Expired cursors and rewinds resynchronize explicitly,
never through a hidden full-history fallback.

Lossless token-by-token replay of transient deltas, recoverable unfinished text
prefixes and permanent cursors are not promised. Cancelling a read must not
interrupt the main model.

<a id="r6"></a>
## R6 · Natural interaction, explicit product choices

The ordinary session list is ordered by native activity; pinning belongs to a
session-organization module. Natural layout with a single scroll owner: re-entering
lands at the latest message; scrolling up is never forcibly interrupted. Load by
message, not whole turn; keep complete messages, auto-fill at least two screens,
prefetch near the top and show loading explicitly.

First-reply auto-naming belongs to the session-organization module; the backend
keeps native manual naming and title reads without a title copy. Whether the Web UI
offers a rename button is its own subset choice. The host provides ordinary text
input; drafts keep their identity, submission and late-result protection.

HTTP/MCP may pass SDK-native `file/directory/selection/blob` attachments through
faithfully, but the host offers no browser upload/download, managed file library,
module reference resolution or file rendering. File paths belong to the Copilot
runtime side and must not pose as browser or other-machine paths. Deleting a session
does not clean independently managed files or workspaces. Significant interaction
trade-offs are confirmed first.

The confirmed future system page is a full page entered from the host's main menu.
Its first version shows, read-only, the Cockpit version and every installed module
with its version and actual load state, with safe exit at the bottom showing
progress (R7 semantics). It offers no add/disable/configure actions. It is a page
requirement independent of menu registration and grants modules no page
registration; it is not implemented yet.

<a id="r7"></a>
## R7 · Truthful safety and lifecycle

Keep native decisions, permission/configuration provenance, active work/queue
protection, late-result isolation, backpressure and release. Permanent deletion
uses the native API; confirmation follows R3 and the Web UI states it is
irreversible. Deletion does not depend on module unbinding or callbacks. External
applications handle stale IDs; unloaded, timeouts and permission errors are not deletion.

Normal shutdown waits only for native session idleness. Native turns, accepted
queue items, user decisions and related native work settle by their real state;
then the host closes the SDK/network and exits. Module activity, sends, background
connections, busy declarations or close callbacks add no wait condition; work a
module starts through a native session still belongs to that session. Modules end
with the host and may be interrupted; recovery is their persistence strategy, not
host draining or resending. Idle does not mean every saved session disappears from
the list; pending schedules do not keep sessions alive. During shutdown new
independent work is closed off while paths needed to finish existing questions and
in-flight operations remain; queues are not cleared, busy is not erased, and
completion is not claimed while safety is unknown. The MCP/API request that
initiated shutdown returns on acceptance and its native turn must be able to end.
The exit entry is a discoverable public API with existing authentication that
distinguishes accepted/waiting from completed; see [shutdown](architecture.md#shutdown).
Graceful control belongs to the host; restarting belongs to the environment or
operator. Error exit after confirmed native process death is fault handling, not a
bypass of safety. Documentation changes never authorize restart, reset, module
enablement or production data migration.

Unknown side effects are never replayed automatically. Mode is not permission;
enabled is not connected; a UI marker is not keep-alive; process idle is not work
completion.

State the single-user local trust boundary and the separate external authentication
layer honestly; do not claim strong isolation between same-user agents. Remote
entry authentication is the installer's; Origin/Referer checks are source
protection only. Copilot sign-in belongs to the native runtime. Presentation
features must not bypass permission requirements of pages, APIs or files.

<a id="r8"></a>
## R8 · Traceable documentation, versions and delivery

Documentation and MCP descriptions match real capabilities and distinguish current
implementation, confirmed targets and designs under discussion. Current text
focuses on product and usage contracts; migration history, retirement lists,
deployment history and old reviews are kept outside the project. Report
development, commit, integration, deployment and runtime effect separately; a
healthy `/health` is not SHA proof and finished source is not production.

Use independent worktrees when needed, integrate safely and preserve others'
work; never force-stop busy sessions or publish from an untidy dirty tree. Keep
traceable source, build and [package identity](releasing.md). Changing documented
targets never performs host operations or moves user data.

## Accepted costs, deferrals and open items

| Kind | Boundary |
| --- | --- |
| Accepted | Complete messages, ownership and two-screen fill may read extra events; a full reading session has no fixed page cap, and extreme low visible density is not an acceptance gate. |
| Accepted | No per-page ACK; slight tail rereads under extreme disconnection or slow consumers are acceptable, with no strict one-unacknowledged-page limit. |
| Accepted | A single giant event may be read whole and sliced by offset/hash; ordinary multi-event overflow requires an explicitly smaller page — no automatic bisection, caching, spooling or opt-in. |
| Accepted | Collapsed subagents still stream: a bandwidth cost of continuous updates and completeness. |
| Accepted | Graceful exit does not wait for module business or close receipts; modules handle their unknown side effects. |
| Confirmed | Cold loading only, frontend and backend in one package, trusted main-process import; per-module MCP paths remain a future target. |
| Confirmed | A module failing to start is disabled locally with a visible error; the host keeps running. |
| Accepted boundary | The next-start message only promises to record the automatic send attempt and its result; without a receiver idempotency key, local markers cannot guarantee no loss or duplicate across crashes. |

Conformance reviews mark each item **conforms, partially conforms, does not
conform, accepted exception or unknown**, with the actual baseline, evidence and
uncovered boundaries. Source reasoning, synthetic tests, real SDK evidence and
production facts cannot stand in for one another.
