# Unreleased source: append roles to an existing session

Adds `roles/add`, `cockpit_add_roles` and a Web session-settings action for
explicit append-only role assembly on the same session ID. Loaded sessions must
be idle; unloaded sessions resume directly. No hidden prompt, copied session,
busy waiting or automatic retry. Existing roles use the original composition and
module-provenance rules; this does not change Task ownership or delegation.

The operation separates saved selection, acknowledged handle assembly and
on-demand readiness. Native temporary Skill/MCP choices are carried through this
reload, without a persistent resource mirror. Preflight rejects unreconstructable
session-only resources, unsafe work, schedules and empty unsaved conversation
history. Persistence/native partial failures remain explicit and recoverable by
inspection, not an assumed atomic rollback. See the
[role contract](module-contract-draft.md#已有会话显式追加) for limitations.
No Task package adaptation, release, deployment or real-session mutation is implied.

---

# Unreleased source: explicit role capability checks

Simplifies the development role integration from #68 without creating a release
or authorizing deployment. `roles/readiness`, `cockpit_role_readiness` and the
typed module `context.host.call('roles/readiness', ...)` bridge remain explicit,
on-demand checks. Ordinary session metadata, lists, snapshots and Web panels no
longer carry `roleReadiness`; consumers must explicitly request capability
evidence and check busy/pending/subagent state separately.

The automatic `session/advance-queue` intent, `cockpit_advance_queue` tool and
`QueueAdvanceOperation` type are removed without aliases or receipt recovery.
Single main-turn interruption preserving the queue, per-ID pending removal,
prompt, ordinary Stop/cancel and lifecycle protections remain unchanged.
Role selection labels are not capability proof; readiness badges are deferred.
Creation-time role System Prompts, native Skill roots, shared MCP tool unions
and selected-role persistence/current-resource cold resume remain supported.
See the [module contract](module-contract-draft.md#44-创建时角色与模块-http-mcp).

---

# Cockpit 0.2.6

Adds public UI v1 input/status classes for paired Speech 0.3.1. The native
composer uses the same `ck-input-row` geometry available to consumers.
`ck-input-hint` follows the host input size; `ck-status-text` uses the auxiliary
text role. Full-width status rows, marker alignment and trailing status actions
are host-owned styles, not speech-specific slots or business dispatchers.
See [Module UI guide](module-ui-guide.md#public-classes).

Speech remains responsible for recording, timing, errors, retry and clear.
Queue/question layout and scrolling remain unchanged and host-owned.
No new font-size variable or private `.chat-*` dependency is required.
Existing UI v1 controls and modules remain compatible; Speech 0.3.1 requires
this paired host's additive styles. All workspace and MCP versions are 0.2.6.
This source change does not itself create a tag, Release or deployment.

---

# Cockpit 0.2.5

Unreleased source summary relative to 0.2.4. Workspace packages and MCP identify
as 0.2.5; this document does not create a tag, Release, installation or deployment.
Published assets and earlier summaries remain in their corresponding GitHub Releases.

## Breaking Composer contract

[#51](https://github.com/waksana/cockpit/issues/51) removes
`ComposerEditorProps.actions` and `composerActionsVersion`, without aliases or a
replacement position slot. Consumers of that contract must migrate together with
the host, even though this experimental 0.x release uses a patch version.

The new `composerInput` component middleware wraps the actual controlled textarea.
`composerInputVersion: 1` is checked independently of Web API v2 and UI v1.
Base retains native editing, IME, Enter shortcuts, controlled props/events and
the public textarea ref, including React 19 callback cleanup. The host retains
the independent native send button and rechecks captured draft/submission gates.
Editing remains available during pending sends; disabling submission does not
silently disable the textarea.

File's existing prompt-only leading content is unchanged. Natural DOM, keyboard
and visual order is File, textarea, input enhancement, native send. Modules can
put full-width feedback after the existing composer Base, not in an empty slot
or inside another interactive control.

## Paired consumers

**Cockpit Speech 0.1.1** requires this input contract and the independent
`chatWindowVersion: 1` read-only projection. Speech 0.1.0 and hosts lacking
`composerInputVersion: 1` are not compatible with the new pairing.
The speech repository's `tooling/host-sdk.json` records the exact reachable host
source SHA and SDK package version 0.2.5; its build receipt records that export.
Merge the host API before the paired speech PR. Neither merge authorizes deployment.

Speech owns recording, Azure transcription, context selection, leases and conflict
recovery. The host adds no speech backend, business dispatcher or button registry.
Menu/header/attachment actions and File 0.1.7 / Notification 0.1.5 contracts remain
unchanged; those modules are not rereleased here.

## Unchanged boundaries

Manifest/backend API v1, Web API v2, public UI v1 and menu capability 1 remain
independently versioned. Web/backend/MCP must come from the same release.
Node 24.20.0, pnpm 10.34.5, SDK 1.0.13, native runtime 1.0.83/protocol 3 and
Linux x64/glibc remain the supported baseline.

Modules are trusted, local and cold-loaded. Copilot remains authoritative for
native sessions/history. No automatic migration, release, restart or production
configuration change is included.
