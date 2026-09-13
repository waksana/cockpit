# Thin Cockpit and its capability modules

This catalog records the agreed extraction boundary. It is not an installed
module registry or a promise that the parked code is usable as a plugin.
The immediate work is **document, preserve, detach**. Module adaptation comes
later, one capability at a time, under the
[frontend/backend plugin contract](module-contract-draft.md).

## Foundation boundary

Cockpit remains a remote interface to the native Copilot runtime: real session
identities, messages and event history, models, tools/subagents, MCP, skills,
queues, plans, user decisions and native schedules. Native rename, compaction,
rewind, load/unload and fork remain native adapters, not module business.
Native attachment parameters may be accepted by the API without implementing a
browser file library or interpreting a module's file references.

The remaining non-native infrastructure must have a concrete hosting purpose:
authenticated transport boundaries, API/schema publication, HTTP/SSE, native
connection and in-flight ownership, the ordinary text editor, safe shutdown,
actual process identity, immutable packaging and the external launcher.
Future generic module loading and public UI composition belong at this layer;
they are not implemented as part of parking the old code.

The foundation does not keep module business state or replicas of native
session/chat/model/queue/MCP/skill state. A pending native callback or request
is an owned in-flight resource, not a reusable native-state cache.

## Capability catalog

All ten entries below are **future module identities / parked source**, not
installed plugins. Their pre-extraction built-in implementations are distinct
from that future status. Folder names organize source ownership and are not
a host module-ID allowlist.

| Folder | Purpose and capabilities | Frontend contribution | Backend / native interaction |
| --- | --- | --- | --- |
| `files` | Receive, retain, describe, browse and download files; preserve originals and associations; resolve module-owned references. | File selection, clipboard/drop handling, upload progress, staged items, library page, chat-stream cards, image/video previews and downloads. | Own HTTP file transfer/storage/validation. Produce SDK-native attachment input when needed; do not own native history, cursor or send scheduling. |
| `notifications` | Inbox attention, unread/seen waterlines, notification deduplication, subscriptions and Web Push. | Inbox/settings, unread markers and application badges. | Observe native events without a second conversation database; own notification state and push delivery. Real ask/plan decisions remain native. |
| `voice` | Dictation, language settings, recognition providers, audio capture and token/secret handling. | Microphone action, recording state and transcript feedback. | Supply recognition services/tokens where needed. Insert text into the original draft; do not own message sending. Dictation does not require the file module. |
| `session-organization` | Pinning and Cockpit's first-reply automatic naming policy. | Optional ordering/marks and organization controls. | Own pin choices and naming policy. Use native name/ephemeral-query APIs; no title/history mirror. Native manual rename and native-generated titles are not removed. |
| `system-status` | Optional runtime/version and deployment status presentation, including the external CI/CD viewer. | System/version dashboard and explicit status refresh. | Read actual identity and the relevant external authority. No fabricated success from Git HEAD or cached display state. Not the generic module installer. |
| `graceful-restart` | User/agent restart controls, convenience commands, retained-operation presentation and explicit recovery interaction. | Restart action and progress/reason display. | Request the host's protected lifecycle or owned launcher. The module cannot supply the only implementation of safe shutdown or force a busy host to exit. |
| `context-reset` | The existing `self-context-reset` workflow: prepare/reread a local handoff, invoke self-only context clearing and resume with a recovery prompt. | An optional control only if later implemented; no page is required. | Own the contributed tool/skill and workflow guards. Invoke native `history.clearContext` in its supported context. Preserve the original session ID/history; do not confuse reset with delete, reload or compaction. |
| `assistant` | Optional assistant role instructions, skills and public templates. | No page or service is required. | Append explicitly selected content without replacing workspace instructions or automatically initializing personal files. |
| `task` | Goals, authorization, Commander/Owner roles, task identities, dispatch, progress and results. Commander and Owner are roles of this one module, not foundation concepts. | Its own task views and controls. | Own business records, scoped credentials and task lifecycle; consume real native session APIs. Do not replace native queues or inherit Assistant implicitly. |
| `wechat` | Channel binding, inbound/outbound messages, media and uncertain-delivery handling. | Its own channel configuration and status. | Own channel protocol, credentials, business identity and recovery. No automatic resend of unknown outcomes or activation of a paused channel. |

Other capabilities may be designed later. Historical Butler/Flow material is
parked as retired governance background, not a decision to revive another
module. Native `assistant` messages and `task` subagent tools are unrelated to
the business names in this catalog and remain supported.

## What moves, and what must remain

| Area | Park / detach from the active product | Keep in the foundation |
| --- | --- | --- |
| Files | Managed upload/download/library APIs, source metadata, module file markers, file UI/renderers and client transfer tools. | Supported SDK-native attachment inputs, native file tools/events and ordinary text/link transport; no substitute managed-file implementation. |
| Notifications | Durable inbox and seen counters, pin-independent attention badges, push configuration/registrations, notification UI and server delivery policy. | Native decisions and actual busy/queue/task status. Removing an unread mark must not remove a pending question. |
| Organization | Pins and automatic naming triggers/prompts/guards. | Native manual rename and native metadata/title reads. |
| Voice | Capture/recognition controller, browser SDK dependency and token service. | Text editing and native prompt submission. |
| System dashboard | Optional system UI, delivery-viewer adapter and its client wiring. | Minimal `/health`, `/version` and lifecycle status used by process ownership and delivery. |
| Graceful restart | Optional Web/MCP/CLI control surfaces and their module-owned interaction. | Native safe-idle checks, normal signal handling, draining/closing owned resources, the deployment control primitive and external launcher. No circular dependency on a plugin that exits first. |
| Reset | Contributed self-clear tool, bundled skill, handoff workflow and their tests. | Native history/context operations in the SDK, ordinary reload/compaction/rewind adapters and their independent guards. No cross-session self-clear endpoint is invented. |
| Earlier business modules | Public content and host-specific integration code previously removed from the repository. | No old registration list, business route, role binding, issuer or compatibility layer. |

The protected internal restart primitive must remain available to the existing
external deployment controller. Detaching a convenience module is not permission
to break future deployment, remove native activity protection or introduce a
force-stop shortcut. Likewise, native context clearing is not reimplemented in
the reset module; its existing integration/workflow is what is parked.

## Frontend cooperation

Each module may supply separately compiled frontend and backend entries.
The frontend exports a plugin registration entry rather than taking ownership
of the App root. It composes against public, versioned UI objects and draft
interfaces, not private DOM selectors or private stores.

There are no predeclared file/voice slots or hidden fallback implementations.
Existing public components can be combined with plugin contributions at
runtime. Module appearance, lifecycle and native-message input use the generic
contract; business rendering and state remain in the module.

The file module owns **all enhanced file presentation in the chat stream**,
not just the input button and library. Native messages, identities, parent/child
ownership, the current event window, paging and reconnect remain shared
foundation responsibilities. A renderer does not open another whole-history
reader or mutate the native event log.

Trusted enabled modules use the same authenticated public API and its existing
confirmation/busy/unknown rules. No `hostAccess` or `hostGrant` layer is added.
Frontend code of the same trust level is not a malicious-code sandbox.

## Parking procedure and provenance

`module-staging/` is outside active workspace packages, builds, tests and
published runtime payloads. It is intentionally **not** a collection of
installable plugins. Preserve original repository-relative paths below each
capability folder. Do not repair parked imports, add drivers, reorganize
business internals or claim that the parked tests run.

For a file wholly owned by a capability, retain its original source, tests,
fixtures, styles and directly related documentation in that folder. For a file
containing both native foundation and extracted features, retain a complete
original snapshot in `_shared-originals/` and record the relevant consumers;
then remove only the feature sections from the active file. A snapshot is not
an assertion that the whole original file belongs to a module.

Use fixed public Git commits as provenance:

| Source | Meaning |
| --- | --- |
| `21fdcc264de347467e4cf42b44af114902878177` | Active pre-extraction code and the agreed frontend-plugin design. |
| `33696b81c5d2ebe073e4700410c1cc4adabc4c1b` | Public source before the earlier official-module removal; used only to retain previously removed content and integration material. |

Earlier shared module-host code belongs in `_legacy-host/`, not in the new
foundation. Historical governance material belongs in `_retired-governance/`.
Do not copy private session artifacts, unmerged experiments, credentials,
business databases or native homes into this public repository.
The parked-source inventory records source SHA, original path, destination and
content digest; it is source provenance, not a task ledger.

## Interim behavior and adoption

This is the required post-extraction behavior, not a statement that a currently
deployed installation changed when this document was written.

Until adapted modules are explicitly installed later, the active product has
ordinary native chat and controls but no parked enhancement: no browser
managed-file UI or download service, unread/push system, dictation, pinning,
Cockpit auto-name workflow, optional deployment dashboard or contributed reset
tool. Native attachment API clients can still use the supported native input
contract. Missing enhancement must be explicit, not silently substituted.

Existing native conversations, workspace files, credentials, preferences,
uploads and module business data are not deleted, copied, migrated or replayed
by source extraction. Old preferences are inert; removing their writer is not
permission to rewrite their stored file. Future file access and data migration
need an explicit design rather than deletion or native-history rewriting.

The text-only composer uses `cockpit:native-composer:<sessionId>`. Existing
`cockpit:composer:<sessionId>` rich drafts remain untouched and are not loaded
or silently converted. Users must not expect old staged attachments or their
captions to appear in the thin composer. Old native messages remain readable,
but module-specific file markers/URLs have no enhanced renderer or download
service. Existing device push registrations are not remotely revoked by this
source change; the new worker and backend contain no push handlers/delivery.

There is no published `files/*`, `inbox/seen`, `push/*`, `speech/token`,
`session/pin`, `session/auto-name` or `system/consumer/*` intent. The upload,
download and system-dashboard transports and the MCP file/pin/restart helpers
are removed. Native message APIs and the private process lifecycle primitives
are not substitutes for those retired enhancements.

Source integration is not production activation. This extraction does not
deploy, restart, reset a session or enable any module. The independent review
of its own fixed baseline is not silently redirected to this new scope.
Future adaptation must prove each complete frontend/backend capability,
including failure/uninstall behavior, before advertising it as available.
