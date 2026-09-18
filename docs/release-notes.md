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
