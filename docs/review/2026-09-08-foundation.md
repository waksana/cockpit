# Cockpit foundation: final modernization review

Date: 2026-09-08. Scope: the release deployed at 10:00:57 CST, using official
Copilot SDK 1.0.13 and runtime 1.0.83. This report supersedes the pre-modernization
findings in the other numbered review documents.

> Post-deployment correction, 10:08 CST: a real long-running conversation could
> not open because the history reader exhausted its event/byte budget. The
> short-message fixture did not cover long autonomous turns and cross-turn
> subagent work. The correction now pages the actual affected journal all the
> way to its beginning. The follow-up was deployed at 10:54:44 CST; actual HTTP
> reads returned consecutive pages while the target session remained unloaded.

## Verdict

The later SDK-native convergence changes described at the end of this report
were deployed at 12:35:13 CST.

The architecture now fits a single-operator remote Copilot GUI, with one API
shared by Web and MCP. The original blocking findings and the subsequent history regression were fixed
and deployed, including the follow-up described above.
This is not full CLI feature parity, a multi-tenant
platform, a penetration-test certification, or proof of unlimited uptime.

The useful simplification was removing duplicate ownership, not rewriting the
backend language or splitting it into more services. Retain TypeScript,
React/Zustand, HTTP commands/queries and SSE projections.

| Dimension | Assessment | Remaining qualification |
| --- | --- | --- |
| Architecture | Appropriate foundation boundary; governance removed | Native integration still has real lifecycle and event-adaptation complexity |
| CLI/API semantics | Supported operations use native outcomes, not optimistic success | Advanced SDK RPCs are experimental; some native features remain deliberately unexposed |
| Performance | Passive history and smaller UI subscriptions remove unnecessary work | No sustained production memory plateau or broad load-capacity claim |
| Reliability | Browser reconnect, accepted sends, native cleanup and supervisor recovery have distinct meanings | A crashed in-flight turn cannot be promised to survive |
| Security | Suitable for a trusted operator behind the authenticated gateway | Authentication grants powerful server-account control by explicit policy |
| Mobile usability | Simplified chat, attachments, settings and notification routing | Physical iPhone PWA scrolling and lock-screen delivery remain owner-device gates |

## 1. Architecture and ownership

```text
Web ---- HTTP commands/queries ----+
                                  +-- API -- Engine adapter -- official SDK
MCP ---- same HTTP API ------------+                |                |
                                                   |           native runtime
Web <-------------- SSE projections ----------------+
```

Copilot owns execution, conversation persistence, context construction,
automatic compaction, model transport, tools and native schedules. Cockpit owns
remote transport, display projections, uploads, preferences and unread receipts.
Web owns transient interaction state such as drafts and scroll position.

The shipped changes remove Cockpit Hook/Flow/Gate/fleet governance, private SDK
bootstrap access, local MCP transcript readers, manual journal/database repair,
forced GC, heap/image watchdogs, session-count caps and runtime recycling policy.
Explicit session-to-session interaction remains an ordinary API/MCP capability.

There is one out-of-process Copilot runtime, not a permanent process per chat.
Its native idle timeout is 1,800 seconds. Cockpit observes cleanup rather than
deciding eviction; opening history does not hydrate a session. Runtime-only
details require explicit resume when unavailable. Native automatic compaction
and model-transport defaults are not replaced with Cockpit policies.

The initial modernization's Engine was about 1,452 lines, versus about 2,553 at the first
acceptance audit. Size alone is not a quality metric: event folding, async
acknowledgments, native callbacks and UI truth still require adaptation.
`runtime.ts` and `history-reader.ts` separate process integration and passive
history from that adapter. Further generic managers would not improve this.

Two compatibility edges deserve continued scrutiny, not expansion: the pinned
SDK currently lacks a public child-exit subscription, and it may discard a
never-submitted empty session. The adapter uses a scoped Node process-lifecycle
observation and only reconstructs confirmed-absent local drafts with confirmed
initial settings. It never recreates historical sessions or retries uncertain
submitted work. Prefer replacing these edges with public SDK support when
available rather than growing a recovery framework.

## 2. Supported CLI behavior and shared API

The review found and corrected false-success HTTP responses, incomplete busy
guards, MCP plan/panel schema drift, cwd-insensitive skill discovery, stale
configuration results and ineffective file rollback.

The resulting contract:

- Prompts acknowledge acceptance, not completion; uncertain sends are not retried.
- Web and MCP consume the same schemas, model inventory, operation results and
  canonical history. Viewer-specific history pages are HTTP results, not SSE
  broadcasts to every device.
- File attachments use backend-issued URLs resolved to native attachments.
  Uploaded output returns usable Markdown rather than guessed filesystem links.
- Rewind uses native history/file semantics and reports conflicts or partial
  outcomes. It does not treat a successful RPC as proof of file restoration.
- Skill discovery is sessionless; configuration changes read back native state.
  MCP replacement requires an idle close/resume, not unsafe hot replacement.

Intentional limits: always-approve permissions are the owner's explicit choice;
structured/URL elicitation acceptance is not a general form renderer; new
schedules support simple delays/intervals up to 24 hours, not cron/timezone
creation. The capability endpoint and documentation describe these limits.

## 3. Performance and memory

The major improvements are avoiding work: passive history, bounded history caches,
caller-local pagination, narrow React subscriptions, stable sidebar metadata,
lazy secondary pages, and no repeated native-detail polling that extends idle
lifetimes. SSE disconnects slow consumers instead of accumulating unlimited
per-connection buffers. Static HTTP content is compressed, not SSE.

| Evidence | Observed result | What it does not establish |
| --- | --- | --- |
| Isolated native history, 20,000 messages / 8,267,780-byte journal | Latest 30 messages: about 101 ms; session stayed unloaded | Production p95/p99, arbitrary event distributions, or browser paint latency |
| Corrected history reader cache | 3 entries, 8 MiB compressed display-event snapshots, native batches up to 1,000 events | A hard bound on temporary decoded/nested-card memory or total read work |
| Final Web build | Entry 138.23 kB gzip; two initial shared chunks add about 36.22 kB gzip | Total page transfer or time-to-interactive; route chunks and other resources remain |
| PWA precache | About 1.58 MiB uncompressed resources | Lazy JavaScript execution does not mean zero installation/background download |
| Native lifecycle exercises | Actual cleanup/resume and owned-process shutdown observed | Days-long memory stability with every tool/provider combination |

There is no basis for claiming that total memory is now minimal, leak-free or
independent of active workload. SDK-owned idle cleanup is the chosen policy.
Uploads and persisted history also consume disk over time; no destructive
retention policy was silently introduced.

The follow-up used the actual affected mixed-version journal: 53,083 events,
435 root messages over 15 pages. Every returned field, including nested work,
matched canonical replay. Latest-page time was about 1.2 seconds; older pages
took 2.4-15 seconds, with about 5.52 MB peak compressed cache. This replaces the
short-message fixture as evidence for this failure shape, not as a guarantee of
instant history browsing. Full replay/reference comparison itself retains data
that an ordinary browser request does not, so its process RSS is not an API-memory
benchmark. The fix removes the total-history rejection, scopes dependency reads
to selected messages, and retains the shared fold's existing tool-detail policy.

The earlier "request too large" error was an old runtime 1.0.63 CAPI Responses
request of 5.1 MB against its 5.0 MB limit, not Fastify or upload ingress. Native
compaction reduced the affected context from 456,219 to 12,795 tokens.
Official runtime 1.0.74 notes increased the Responses request limit and downsized
oversized tool-result images. The shipped runtime includes those improvements,
but the exact new ceiling and immunity to all oversized requests are unproven.
Streaming, WebSocket transport and idle unloading do not create unlimited context.

## 4. Reliability and usability

The review fixes are implemented, not only recommendations:

| Earlier failure mode | Shipped correction |
| --- | --- |
| Unload cleared only Cockpit references | Native close/idle cleanup is reconciled; displayed unloaded state reflects native ownership |
| Runtime death stranded a nominally healthy API | Confirmed owned-child death triggers API exit for supervisor recovery; no mutation replay |
| Restart raced active work or hung on transport | Shared active-work guards, awaited native/push drain, closure of remaining HTTP connections |
| Empty renamed session could not resume | Narrow confirmed-absent draft recovery, preserving initial settings without synthetic prompts |
| Old HTTP history results replaced newer views | Caller ownership and generation/reconnect reconciliation |
| Reading completed history jumped toward the bottom | Explicit follow intent and visible-message anchoring instead of unconditional resize pinning |
| File selection sent immediately without its caption | Staged attachment, preview/remove and explicit caption-plus-file send |
| Failed send or late response lost user input | Draft retention and acknowledgment tied to the original submission |
| Notification state diverged across surfaces | Durable backend unread waterlines and observed-attention receipts |
| Selecting a chat marked unseen content read | Receipt requires fresh latest content or the actual choice to be visible |
| Notification taps failed outside chat pages | Root-level routing with service-worker acknowledgment/fallback |
| Notification permission looked like delivery readiness | Persisted subscription status, explicit test and expired-endpoint renewal |

Native constraints are visible rather than hidden by keepalive logic: future
schedules pause while unloaded and relative delays restart on resume. A
background shell can outlive cleanup without remaining accessible through
session task RPCs. Use an upper-layer scheduler for wall-clock execution guarantees.

## 5. Security assessment

This is an architectural/boundary review and dependency assessment, not an
independent penetration test. The deployment is a trusted single-operator system:
the API binds loopback; the authenticated HTTPS gateway protects remote API,
files and operational routes. Origin checks add CSRF protection, not identity.
An authorized user can execute tools as the service account because allow-all
was explicitly requested. This is not tenant isolation.

Implemented hardening includes validated intent bodies/results, upload-path and
MIME handling, download content protections, scoped file-transfer access,
safe image URLs, restricted SPA fallback, private durable push configuration,
and bounded network operations. The production dependency audit found two
`@fastify/static` advisories; upgrading to 10.1.3 removed them. The recorded final
audit reported zero known production dependency advisories, not zero application
vulnerabilities or a permanent guarantee.

Residual operational responsibilities remain: keep the raw backend private,
protect gateway/server credentials, restrict the service account appropriately,
maintain backups and disk capacity, and review operator-added MCP/skills. Uploads
have a per-file limit but no total retention quota or malware scanning. Do not add
automatic file deletion or a multi-tenant authorization subsystem without an
actual product requirement.

## 6. Completion evidence and remaining work

The release completed its native/API/browser acceptance and was deployed with
matching assets. The final repository run passed 1,942 tests, with one separate
opt-in native test skipped in that run. The isolated native run passed 14 cases;
actual HTTP/native E2E passed 27 cases; rendered desktop/mobile Chromium exercises
passed 18 checks. Native-child failure was also exercised with an unfinished HTTP
upload to establish that it cannot strand supervisor recovery.

Those results do not replace production observation or iPhone hardware behavior.
At cutover, push was configured but had zero device subscriptions.

| Priority | Remaining item | Appropriate next action |
| --- | --- | --- |
| Owner device | iPhone Home Screen PWA, lock-screen push, tap target and reading position | Enable permission/subscription explicitly and exercise on the actual phone |
| Observe | Long-lived native memory, unusually large histories and disk growth | Measure under real usage before adding any policy |
| Maintain | Experimental SDK compatibility and remaining adapter edges | Keep versions deliberate; prefer public native capabilities over new workarounds |
| Profile first | Initial shared Web chunks and PWA install traffic | Optimize only if cold-load measurements show a user-visible bottleneck |

The recommended direction is to stop expanding the foundation. Keep one native
execution authority, one application API and small client projections. No language
rewrite, custom context manager, Cockpit eviction scheduler or governance layer
is justified by the evidence from this review.

Related: [architecture](../cockpit-plan.md), [deployment](../DEPLOY-PORTABLE.md),
[existing checks](../cockpit-testing.md), and the
[official runtime size-limit improvement notes](https://github.com/github/copilot-cli/blob/05cdbb3ae04a839ffc465facdc0e0f207e37dbe0/changelog.md#L13-L19).

## SDK-native convergence follow-up

Status: deployed at 12:35:13 CST. The post-cutover observer recorded matching
Web assets, consecutive summary history pages and a child page while the target
session remained unloaded.

The follow-up removes the `scheduledSessions` startup/count policy. Old JSON
fields remain inert, and no native sessions are resumed merely to keep timers
alive. Reliable wall-clock schedules and external webhooks belong to an upper
layer calling the same API. Native after/every operations remain available.

Routine tool completion now makes no state-refresh RPCs instead of eight.
Work boundaries coalesce activity/queue/task reads, and native resource events
refresh the corresponding model, plan, schedule or MCP resource. Explicit
teardown still confirms native safety. The passive inventory/liveness fallback
remains because headless lifecycle events do not cover all cleanup paths.

Web root histories and SSE use subagent summary cards. Expanding a card requests
its own passive, paginated transcript; nested cards follow the same rule. Default
full HTTP history remains backward compatible, and MCP exposes both forms.
Navigating away releases the previous browser transcript and invalidates its
pending responses, while retaining drafts, attachments and authoritative metadata.
This never closes a native session.

Measured against the actual complex journal, the sampled root response fell from
669,045 bytes to 86,871 bytes. The selected 53-message child fell from about
1.894 MB to 214 KB using nested summaries, with canonical content available on
demand. Reusing native checkpoints from the already-visible parent reduced that
child's expansion from 64.1 to 14.8 seconds; a recent visible child took 3 seconds.
An unrelated append refresh read 202 new events rather than rescanning 55,939.

The isolated actual HTTP fixture compared all 75 child messages exactly, confirmed
inclusive refresh, missing-child errors, passive access and inert legacy schedule
preferences. The coherent workspace run passed 2,018 cases with one opt-in native
case skipped; the separate native run passed 43 cases including actual idle,
schedule and fault-recovery scenarios. Desktop/mobile Chromium covered 24 rendered scenarios. A clean PWA
build prevents obsolete hashed chunks from entering its precache.

This is a reduction in repeated work and state ownership, not a claim that every
file became shorter. The Engine is now about 1,521 lines and the history adapter
824 lines because scoped historical views need cursor/ownership reconciliation.
The SDK has active-session agent filters but no equivalent filter on its passive
global journal RPC. Direct child-ID reads without a cached parent may therefore
still scan a large journal; MCP gives those reads a bounded 120-second deadline.
Active Engine initialization still uses a full native event replay. Temporary
decode/fold memory and large explicit full-history reads are not bounded by the
8 MiB compressed cache limit. Replacing those remaining adapters with native
support is preferable to adding another indexing or runtime-management subsystem.

## Active display initialization follow-up

Status: deployed at 13:22:21 CST. The post-restart observer confirmed the new
process was up and historical messages remained readable.

The next change replaces Engine's full-array `getEvents()` initialization with
the SDK's early `onEvent` subscription and typed durable event pages. A captured
tail event bounds the initialization snapshot; later events use the subscription.
Live/replayed overlap is reconciled without appending old streaming deltas onto
already-final messages. Failed initialization does not replay a prompt or
silently recreate a historical session.

Active folding now uses summary scope as well as summary transport. Child
transcripts therefore do not accumulate again after initialization. Root messages,
tool status and requested-file provenance remain available, and the independent
full/summary/child history APIs are unchanged.

Correctness takes precedence over an attractive filtering benchmark. Native
primary-agent filtering omits child task messages that can be the only parent
link in legacy nested histories. The final implementation keeps typed all-agent
pages and discards unneeded child content during summary folding instead.

In a complete native fixture with 442 root messages, all projected root messages
matched canonical full replay, including legacy task-only nested ownership.
The old full transfer was 5,675,169 bytes in one RPC; the replacement transferred
4,823,984 bytes over eight bounded history RPCs, with a largest page of 755,091
bytes. Serialized retained fold data fell from 4,696,988 to 70,211 bytes. These are
fixture transfer/projection figures, not production RSS or Copilot model-context
memory. The separate 51 KB latest-200-message probe is not a like-for-like
measurement of complete initialization.

This step still reads all selected historical events incrementally and retains
historical root messages. It removes the full raw-array and nested-display
duplication, not every historical byte or every adapter state. The Engine grew
from about 1,521 to 1,614 lines to handle early callbacks, native snapshot
boundaries and failure races; the benefit is less retained data and correct native
integration, not a claim of fewer source lines.

Final review identified a reasoning-only snapshot boundary that could append
buffered reasoning deltas twice before a final message existed. The correction
matches the authoritative reasoning segment by owner and reasoning ID, preserving
later segments. Core and HTTP compatibility coverage passed after that correction;
the isolated native/API exercises preserved session lifecycle, history and
supervisor recovery behavior.

## Native tool configuration ownership

Status: deployed at 14:11:09 CST. Native global configuration readback and
matching Web assets were confirmed without migrating old Cockpit choices.

The SDK exposes persistent MCP user defaults, global disabled-skill settings,
native configuration discovery and per-session tool controls. These should not
be shadowed by a Cockpit preferences file. The next change removes the
Cockpit-owned defaults, per-session MCP selections and skill allowlists/disabled
sets, while leaving obsolete JSON inert rather than rewriting user data.

The owner explicitly chose to follow the existing Copilot configuration, not
copy old Cockpit choices into it. At that decision, native configuration enabled
the Cockpit MCP server by default, whereas the old Cockpit default list was
empty. This behavior difference is intentional, not a migration fallback.
Global changes must use native configuration APIs; per-session changes must
reflect native readback and native cold-resume semantics. A missing unloaded
runtime must not be represented as a confirmed per-session enabled/disabled state.

An isolated native probe confirmed 51 configuration/lifetime checks. MCP global
discovery works without host-supplied definitions; personal skill discovery needs
the native configuration-discovery option. Global defaults persist, whereas
per-session choices do not survive cold resume. MCP reload also restores global
defaults; skill definition reload preserves the current session choice.

One native integration requirement remains: runtime 1.0.83 does not automatically
apply globally disabled skills at session startup. Read the native
`user.settings.get().settings.disabledSkills.value` and pass it to the SDK's
`disabledSkills` option. This uses the same authoritative native configuration;
it is not a Cockpit override or a new persistence mechanism.

The existing settings pages now expose native global controls and require an
explicit resume for effective per-session MCP state. A private actual-HTTP
fixture confirmed that legacy Cockpit defaults are ignored, native global
changes persist only in Copilot, loaded connections are not silently changed,
native MCP reload restores defaults, and disabled global skills apply to startup.
The coherent workspace run passed 2,066 cases with one opt-in native skip;
rendered desktop/mobile settings coverage passed 20 scenarios.

Final review corrections preserve the discovery `cwd` when globally configuring
a project-only skill, and reject unknown MCP targets before mutation so a bad
name cannot leave a phantom busy flag. The actual HTTP/native fixture covers
both cases. Cockpit preferences now contain only trash, UI pins and unread state;
legacy tool-choice fields are inert. Across Engine, preferences and the remaining
display-only MCP helper, runtime source decreased by 144 physical lines relative
to the prior release; no replacement tool-selection store was introduced.

## Automatic naming feature

Status: deployed at 15:21:28 CST. The cutover observer confirmed matching Web
assets and passive history access without issuing a production naming query.

The owner selected one automatic naming attempt after the first effective
completed response, plus an explicit UI/API action. It uses the public
`ui.ephemeralQuery` and `name.setAuto` APIs rather than CLI private bindings,
another persisted session or an ordinary chat prompt. The native transient-query
probe established unchanged conversation messages and session count, no tools,
and no persistent ephemeral-query events. `setAuto` protects manual names but
does not itself enforce once-only generation; automatic eligibility must be
derived from the first response lifecycle without a second title database.

Name generation is an additional model request, not a free local operation.
Automatic errors must remain separate from chat execution failures, and
historical sessions must not trigger a naming sweep when opened or resumed.

The native implementation produced the first reply/unread signal before its
auxiliary naming request, left ordinary chat IDs and session count unchanged,
and protected a manual rename racing the query. Cold replay and later turns did
not start another automatic query. This is not a global exactly-once guarantee
across crashes or lost history. Manual requests can regenerate an automatic name;
identical native results may report `not-applied`.

The initial rendered UI pass found keyboard focus escaping the new modal.
Existing notification-dialog containment was extracted into a shared hook for
both dialogs. An uncertain transport error now says the outcome is unconfirmed,
not that the original title definitely remained unchanged. Native title state is
always authoritative.

The final core review also found a delayed preflight response from an old native
handle could overwrite a newer resumed title. The naming path now rechecks handle
ownership immediately after that read. The regression reproduces the old failure
and preserves the newer manual title after correction. Rendered follow-up covered
all 16 naming scenarios and both notification-dialog focus scenarios without
confirmed defects. Core coverage passed 499 cases with one opt-in native skip;
the separate native naming exercise established the unchanged chat/session
invariants above. No production naming request was used for acceptance.

## Conservative long-thread rendering

Status: deployed at 16:51:42 CST. The independent observer confirmed matching
rendering assets, passive history access and the Chrome DevTools native global
default without making a model request.

The owner chose to preserve already-loaded text, browser find and cross-message
selection rather than introduce a virtual list or evict active scrollback.
The message list now has its own memoized boundary, and one shared resize observer
allows supporting browsers to skip offscreen layout/paint only after measuring a
completed message's actual height. Width changes invalidate the old measurement;
live messages, unfinished tools and subagent cards retain normal layout.

The scroll adapter locates outer message frames before measuring the visible
semantic anchor, avoiding layout reads through every skipped subtree. Review
found an offscreen message could still be selected when its bottom margin was
visible. The corrected lookup advances to the next intersecting semantic anchor.
Actual browser margin-growth cases preserved the next message within one pixel.
An existing oversized-reply case also exposed native End scrolling reaching the
bottom without rejoining follow mode; End now uses the explicit follow action,
while Shift+End and text-field keys keep their native behavior.

The same Chromium 145 fixture retained all 300 root messages and 8,974 DOM
elements. Median scripting for 30 metadata updates fell from about 41.5 to
16.6 ms; the sampled long-chat streaming paint phase fell from 42.1 to 5.1 ms.
Other timings varied and the single oversized Markdown reply was not materially
faster. These are isolated workload observations, not general speedup or memory
bounds. Loaded data/DOM still grow with explicit scrollback, and this change does
not alter Copilot context, passive native scans, mode controls or API contracts.
Physical iPhone/Safari behavior remains a separate device gate.

The final focused oversized-reply follow-up kept a zero-pixel bottom gap after
all eight updates, while Shift+End selection and text-field End behavior remained
native. The installed Chrome DevTools MCP was also exercised against an isolated
local build with Chrome 152: real tool calls covered retained text, native find,
End-follow streaming, a performance trace and screenshot. No live session,
notification or model request was needed; both browser exercises released their
owned processes.

## Navigation and cancellation release

Status: deployed at 17:49:48 CST. The release observer completed at 17:49:51 CST,
confirming the new backend, all candidate assets and retained old hashed assets.

The Web now uses one reusable global hamburger on the session list and
global management pages, removing the duplicate MCP/Skills/trash strip. Sidebar
context/long-press and chat-kebab menus use one session-ID-bound action catalog
with direct Settings, MCP and Skills entries. Settings no longer fetches plan or
MCP data; plans/tasks, context materials, schedules and runtime maintenance remain
available under More and through direct URLs. Mode controls, allow-all permissions,
draft/attachment ownership, unread routing and native idle behavior are unchanged.

Independent result review found that unrelated session updates could reset an
open menu's keyboard selection. The corrected menu initializes focus only on
first display, preserves a valid selected item and falls back when that item is
removed or disabled. The final candidate includes this correction.

Stop retains native cancellation semantics: current work is cancelled and queued
messages are discarded, not preserved or automatically replayed. When messages
are queued, the existing button explicitly says that stopping clears the queue.
The backend no longer reports acknowledged cancellation as HTTP 500 merely
because native activity needs time to settle. Actual queue-clear, abort and
native read failures remain visible; successful acceptance is not immediate idle.
The corresponding API/MCP documentation describes those same outcomes.

The coherent release preserves allow-all, native MCP defaults and passive
unloaded history access. Its observer invoked no live cancellation, model or
notification operation. Fresh executable MCP registration reflects the updated
description; this does not assert that every existing session refreshed its
cached tool description.

## UX journey and contextual navigation follow-up

Status: deployed at 18:24:54 CST. The original UX owner completed implementation,
focused review, safe activation and post-restart observation. The final release
preserves the backend inputs and native configuration.

Ordinary dialogs now reuse focus containment so keyboard navigation cannot
escape to background controls. Sidebar context menus derive actions from the
current target session rather than freezing their opening state; changes to
connection, activity or pinning update availability and preserve valid focus.
Removing the target or changing chats closes the stale menu.

The session-list and chat-workspace hamburger no longer repeats a redundant
"session list" destination. Global management pages retain a return to sessions,
and narrow chat views retain their existing Back button. Existing deep links,
draft ownership, mode controls and queue semantics remain unchanged.

The journey coverage included isolated desktop/narrow navigation, dynamic
menus, modal focus, attachment/late-acknowledgement handling and history recovery.
These are application-level observations, not physical iPhone badge,
rotation or long-background acceptance. An earlier transient ResizeObserver
notification had no reproduced functional failure and was not addressed with
speculative scrolling changes.

## Native interruption, hierarchical navigation and notification M1 release

Status: deployed. The backend started at 19:59:18 CST; the coherent cutover
completed at 19:59:21 CST. The original notification owner integrated the
accepted component changes, performed activation and completed the post-restart
readback. All 122 new and retained static files matched the frozen inputs.

The queue now offers a separate "Interrupt and continue" action backed by the
public `interruptMainTurn({flushQueued:true})` RPC. It preserves the native
queue and accepted message IDs without copying or resending messages.
Existing Stop still cancels and discards queued work. Interruption only stops
the main turn: background work can continue and delay queue processing.
Acknowledgement is not an idle barrier, and completed tool effects are not undone.
Old decision callbacks are reconciled without discarding questions raised by a
newly dequeued turn.

Global navigation now follows the owner's intended hierarchy rather than the
earlier peer-section menu design. The session list is home and owns the
hamburger. MCP, Skills and trash lists have Back navigation; item details return
to their parent list. Deep links, normal browser history and drafts retain their
existing semantics. The later proposal to move every session page into the
three-dot menu and remove the panel navigation bar is not part of this release.

Notification M1 is corrected: projecting a new unread badge revision no longer
counts as evidence that the corresponding alert has been seen or displayed.
Badge ordering, native per-session observations and notification deduplication
are separated within the existing browser transport store. First unseen ready
and choice notifications retain their alert intent, while genuine seen,
duplicate, stale and removed-session cases retain suppression and badge fences.
This establishes application behavior, not physical OS sound, Focus handling
or iPhone icon-badge delivery guarantees.

The release preserves native configuration, allow-all and passive unloaded
history access. Its completion used one graceful restart and one owner callback,
without production interrupt, cancel, push or read-receipt diagnostics.

## First behavior-preserving code reduction

Status: accepted source cleanup at 20:17 CST. No API restart or Web replacement
is required: every freshly built candidate static file is byte-identical to the
currently served version.

The obsolete draft-send and marker-rebase implementation was removed while
preserving the live SessionDraft owner, legacy draft reads and acknowledgement
behavior. MCP validators now derive from five canonical protocol schemas with
their existing passthrough semantics. The unused result argument and discarded
payload construction were removed without changing tool names, outputs,
confirmation boundaries or awaited effects.

Net handwritten product source decreased by 189 physical lines, from 20,073 to
19,884 under the same inventory rule: 122 draft lines and 67 MCP lines. Test
changes are accounted separately. This removes unused and duplicate maintenance
responsibilities; it is not a Web bundle-size or runtime-latency improvement.

The reduced MCP executable is built on disk and will be used by subsequent MCP
process starts. Existing connections were not forcibly refreshed and may retain
the previous equivalent implementation. The dormant release observer was not
started. Broader structural-necessity analysis remains a separate ongoing round
with the same owner.

## Structural ownership analysis

The subsequent read-only analysis found concrete overlapping responsibilities,
not a basis for deleting every long function. An isolated trace of the actual
Engine methods allowed an older scoped model read to overwrite a newer full
read; a synchronous burst of 20 model events caused 20 serial reads. This
establishes an allowed adapter interleaving, not an observed production incident.

Other confirmed structural duplication includes transport/store presentation of
the same command failure, a trash-preview store wrapped by a second accepted
resource result, and separate list/detail owners fetching the same MCP catalog.
These are candidates for removing redundant ownership rather than introducing
another general manager or merely splitting files.

The original owner implemented resource-readback ordering and coalescing in an
isolated candidate, then integrated the same two-file change. It was deployed
with the refined Logo at 22:40:48 CST, as recorded below.
The necessary distinctions between accepted sends, journal events, callback
resolvers, visible decision cards, native cursors and browser windows remain;
notification ordering locks and old-history routing must not be removed solely
to reduce line counts.

## Single-level session menu release

Status: deployed at 21:47:06 CST; the independent observer completed at
21:47:08 CST and the original owner finished its post-restart readback.

The chat three-dot and session-row menus share a single level containing all
seven session pages and four actions. The right panel no longer has tabs or a
More navigation menu: it presents the owning session, one Close/Back control,
page-specific actions and lazy-loaded content. Short-screen menus scroll without
dismissing themselves; keyboard navigation, layered Escape, target ownership,
drafts and native-resource loading boundaries remain intact.

The change removes 24 net product lines by deleting the duplicate panel
navigation and its prop/style plumbing, separately from the earlier 189-line
source cleanup. No new navigation framework or dependency was added.

The initial 30-minute release attempt expired before any file switch; its
orphaned pending restart was cancelled. An isolated follow-up established that
static serving reads files on request, but a mutable service-worker stat/open
interleaving can produce an incomplete response during an uncoordinated hot
swap. A fresh five-minute graceful attempt after other work settled therefore
used the existing request-stop boundary and completed normally. This is not a
claim that all static releases require a backend restart or that the simulated
interleaving had occurred in production.

The accepted index, service worker and all 133 candidate/retained files matched.
Old documents were not forcibly refreshed; a normal reload loads the new UI.
Logo candidates and the isolated resource-readback correction were not part of
this release. No additional iPhone/Safari hardware result is claimed.

## Refined Logo and resource-readback release

Status: deployed at 22:40:48 CST. The original Logo owner integrated its accepted
assets with the core owner's accepted change and completed the safe cutover and
post-restart readback. The 152 served files and frozen startup inputs matched.

The Logo uses the user-selected R4 REFINED asymmetric wiper-cleared view with
the small sweep's natural pointed end, not the earlier flat-ended design.
Versioned favicon, PWA and Apple icons share that geometry; the 16px favicon
has its documented spacing adjustment. Notification badges use a separate
transparent monochrome image. Existing URLs remain available for compatibility.
Installed iPhone home-screen icon updates remain platform-controlled; page
reload alone is not a guarantee.

Within the existing Engine, five resource kinds now share bounded read-ticket
and valid-commit rules across scoped, full, initialization and explicit-command
readbacks. A newer read or invalidation prevents an obsolete response from
overwriting the projection; each caller still receives its own result or error.
Same-wave invalidations coalesce without merging real commands or retrying
failed reads. Native MCP pending state remains distinct from local operations.

This correction adds 33 product lines rather than claiming line-count reduction.
It replaces overlapping commit logic and the per-event serial read chain while
preserving native execution, decision, queue and lifecycle boundaries. Its
behavioral evidence is isolated/shared Engine fixtures; publication did not
exercise races or notifications against real sessions.

The isolated UX-loop error-feedback fixes and the newly assigned PWA top-drag
investigation are not included in this release.

## Menu, scrolling, error feedback and plan-contract follow-up

Status: deployed at 23:47:24 CST. The original frontend owner completed the
coherent release after independent candidate rechecks; the main session
confirmed the new process and served index.

Open menus now distinguish explicit outside scrolling intent from scroll
events caused by message growth and automatic following. Stable action IDs
preserve valid focus through label updates, and all eleven action/page entries
use existing UI glyphs. Normal outside clicks, keyboard dismissal and target
removal retain their meaning.

The history correction delays only a newly received older prefix's DOM
insertion while the existing scroll owner reports an active gesture. Previously
mounted messages and live tail updates remain available. Once that gesture
settles, the complete prefix is displayed with the existing anchor correction.
This addresses the reproduced application race and repeated top-load cascade;
the evidence does not establish every physical iPhone rubber-band event order.

Error notices reserve bounded space instead of covering panel navigation.
Their dismiss controls participate in the appropriate keyboard scope. A failed
request now produces one primary, source-labelled notice without swallowing its
exception; separate failed requests remain distinguishable.

The native plan adapter also normalizes a null or missing todo description to
the canonical absent field. Empty and nonempty strings remain unchanged, and
invalid types still fail validation. This is one production expression, not a
change to user task data or the shared protocol. A passive read in the main
completion turn returned HTTP200 with 205 unique todos, 13 omitted descriptions,
the plan text and a changedFiles array. The earlier HTTP500 result was not a
readable complete response for a full content comparison.

All 163 candidate and retained static files were covered by the release
observer. The following all-page copy and layout improvements remain separate;
no cosmetic recommendations were silently included in this fault-fix release.

## Page layout and copy refinement

Status: deployed on 2026-09-09 at 01:03:23 CST. The original frontend owner
completed activation and readback after the fixed auditor accepted the exact
E1-E5 candidate. The main session confirmed the new process and served index;
all 175 candidate and retained files matched the release record.

MCP and Skills pages now use concise, local scope explanations instead of
repeated storage and implementation narration. Long secondary paths occupy
their own line rather than squeezing primary names. Runtime actions precede
lengthy explanation, and scheduled message text is visually distinct from its
time and identifier metadata. Redundant or inaccurate helper copy was removed
without removing consequential warnings.

Notification settings prioritize readiness, current blockers and actions.
Complete diagnostic fields remain available through an accessible local
disclosure, while errors and delivery results stay visible. This does not
change permission, subscription, delivery, provider or unread-state ownership.

The 17-file change adds 37 net product lines and introduces no new resource or
global state owner; it is an information-hierarchy improvement, not a code-size
reduction claim. Existing menu, scrolling, plan-contract and Logo behavior
remain. Chinese visual evidence used a private fixture font fallback, and
notification props evidence is not physical OS or iPhone delivery acceptance.

## Schedule form feedback

Status: deployed on 2026-09-09 at 01:44:57 CST, after the fixed auditor accepted
the exact candidate. The original frontend owner completed activation and
post-restart readback; the main session confirmed the new process and index.

Known interval and prompt validation failures now provide concise Chinese
guidance while retaining the user's input and the existing canonical limits.
Both interval and one-shot paths validate the original prompt before the
existing successful-input trim. Unknown validation failures remain diagnostic.

A valid negative acknowledgement from schedule creation now retains its
meaningful server reason instead of replacing it with a generic message.
When no reason is supplied, add and stop have distinct fallback messages.
Promise rejection, original session attribution, single-report behavior and
late-result ownership remain unchanged; no native scheduler capability or
protocol was broadened.

The five-file Web change adds 17 product lines and introduces no new state or
resource owner. All 185 new and retained static files matched the release.
Evidence used controlled browser/API boundaries, not real scheduled work or
physical OS date-picker and iPhone behavior.

## Trash preview recovery and measurement scheduling

Status: deployed on 2026-09-09 at 02:59:17 CST after the fixed auditor accepted
the exact combined candidate. The original frontend owner completed activation
and readback, and the main session confirmed the live process and served index.

Failed older-page reads now retain accepted preview content and expose an
explicit retry for the current failed cursor. A refreshed, replaced or closed
window invalidates the old recovery action. Preview data and reconnect reads
have one store owner instead of a second resource result and subscription bridge,
removing duplicate snapshot-triggered dispatch while preserving late-result
isolation and existing restore behavior.

The initial candidate exposed a ResizeObserver delivery interaction during
latest-window replacement. Matched browser inputs isolated synchronous
containment writes inside observer delivery as the actionable cause. The
correction batches only affected measurements into one owner-local animation
frame, with cancellation on unobserve/dispose; it does not suppress errors,
introduce another scroll writer or continually schedule idle frames.

The combined change removes 30 net product lines. All 195 new and retained
static files matched publication. The evidence covers controlled browser
interactions, not real deleted-session restoration, every browser's observer
ordering or physical iPhone behavior.

## Faithful display of current model settings

Status: deployed on 2026-09-09 at 03:46:57 CST after fixed-auditor acceptance.
The original frontend owner completed the safe cutover and readback; the main
session confirmed the new process and served index.

When a confirmed model or reasoning effort is absent from the advertised
options, its select now displays that raw current value with a not-listed
explanation instead of silently displaying the first available alternative.
When the matching option returns, its normal label is restored. Available
choices remain usable through the existing explicit user action.

The two-line product correction adds no selection state, automatic mutation
or new capability/default policy. Existing pending locks, metadata versus
acknowledgement semantics, source-session errors and offline behavior remain.
All 205 candidate and retained static files matched publication. No real
session model was changed as a diagnostic, and the release does not establish
new physical iPhone or native picker behavior.

## Creation feedback and directory-picker focus

Status: deployed on 2026-09-09 at 04:38:41 CST after fixed-auditor acceptance
of the exact three-finding candidate. The original frontend owner completed
activation and readback; the main session confirmed the live process and index.

Creation errors retain their useful reason in the picker and have one primary
global report. The duplicate creation action and generic error conversions were
removed while preserving route/connection guards for late results. Directory
read errors identify their original requested path instead of appearing to
refer to a newly opened location.

Lazy and loaded directory pickers now use the existing modal focus facilities
with a picker-specific, notice-aware scope and background isolation. Busy and
removed controls retain a valid focus destination, and ordinary close behavior
returns focus to an available trigger. A mount-scoped MutationObserver supports
that branch and is disconnected on unmount; default modal consumers do not
enable it.

The 11-file change adds 44 product lines, removes one creation action owner and
adds no persistent state. All 216 new and retained static files matched the
release. An unchanged AutoName SSR copy expectation remains a documented
baseline test failure, not a newly introduced modal regression or an all-green
suite claim. No real session creation, filesystem enumeration or model change
was used as a production diagnostic; native persistence and iPhone behavior
remain outside the browser-fixture evidence.

## Global-setting failure attribution

Status: deployed on 2026-09-09 at 05:14:46 CST after fixed-auditor acceptance.
The original frontend owner completed activation and readback; the main session
confirmed the actual new process and served index.

Global MCP and Skill negative acknowledgements now identify the original item
by its dispatch-time name, including when the user has moved to another detail
page. Existing HTTP error reporting, rejected promises, current-page ownership
and native configuration semantics remain unchanged.

The production change replaces two operation strings without adding state,
callbacks or requests. All 226 new and retained static files matched publication.
The separately observed paired MCP catalog reads remain a distinct optimization;
this release did not suppress their diagnostics or claim native configuration
effects from browser mocks.

## Shared workspace MCP catalog

Status: deployed on 2026-09-09 at 05:41:33 CST after fixed-auditor acceptance.
The original frontend owner completed activation and readback; the main session
confirmed the current process, served index and service worker.

The global MCP list and detail now consume one parent-owned catalog resource.
Opening another item reuses the accepted catalog. Snapshot refreshes, explicit
refresh and mutation readback issue one current catalog request rather than
two, while newer invalidations still supersede older reads. Leaving the MCP
workspace releases that owner; unrelated pages do not fetch the catalog.

Accepted content, failure visibility, write availability and original mutation
targeting remain intact. This removes a duplicate result/reload responsibility
without adding a cross-page cache or changing native configuration semantics.
The two-file change adds two product lines; the measured reduction is browser
fetch dispatch, not a claim about completed native work or CPU savings.
All 236 new and retained static files matched the release record.
