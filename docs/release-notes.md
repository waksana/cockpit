# Cockpit 0.2.3

Release summary for v0.2.3, relative to v0.2.2. The checked runtime archive and
checksum are published only after the immutable tag's Release workflow succeeds.
This is the historical release summary, not the unreleased source feature list.
The new menu registry and Notification 0.1.5 source pairing are documented in the
[current module contract](module-contract-draft.md); they do not change this
release's Notification 0.1.0 pairing or add functionality to its assets.

## BREAKING: Module Web API v2

- [#26](https://github.com/waksana/cockpit/pull/26) replaces legacy frontend
  contribution slots with module state services, module-owned draft schemas,
  middleware around actual components and separate Markdown link/image renderers.
  Frontend activation and declarations now require `apiVersion: 2`; old frontend
  slots are rejected, without a compatibility shim.
- When using the file or notification modules, the paired **Cockpit File 0.1.7**
  and **Cockpit Notification 0.1.0** releases are required for this new frontend
  contract. Older frontend packages are not compatible. These modules are
  distributed separately, not bundled or installed by this host release.
- The base draft contains no attachments. Ordinary prompt drafts and native
  ask/plan/elicitation decision drafts have separate identities and lifecycles;
  switching back restores the prompt instead of overwriting it. Field projection,
  acknowledgement (ACK) and persistence remain generic schema-driven mechanisms.
- The file module owns the complete file-input lifecycle: picker, paste/drop,
  captured draft identity, uploads, attachment state, persistence and cleanup.
  The host has no file dispatcher or fallback attachment UI; late file results
  cannot be redirected to a different session or decision draft.
- Component middleware (HOCs) enhances the actual editor, navigation and management
  headers, preserving their existing controls and behavior. There are no empty
  global-action placeholders. Markdown registration remains separate from native
  attachment rendering.
- Module worker serving and invalidation are generic host facilities. Notification,
  unread/read state, push and file policies remain module-owned; the host does not
  register workers or request notification permission on a module's behalf.

## Frontend presentation

- [#27](https://github.com/waksana/cockpit/pull/27) groups MCP name/source text
  compactly, with 8px top/bottom row padding. Switch targets remain 40px/44px.
- Normal frontend geometry is preserved apart from the explicit prompt/decision
  draft switch and this MCP row adjustment. Existing native controls, focus
  behavior and session-page boundaries remain.

## Unchanged compatibility and runtime baseline

- Web, backend and MCP must come from this same release. The breaking change is
  the module frontend contract, not the native backend API or session ownership.
- Module manifests and backend API remain **v1**; Module UI remains **v1**,
  including `context.uiVersion: 1` and `context.createPortal`. See the
  [module contract](https://github.com/waksana/cockpit/blob/v0.2.3/docs/module-contract-draft.md)
  and [public Module UI guide](https://github.com/waksana/cockpit/blob/v0.2.3/docs/module-ui-guide.md).
- The supported package baseline remains Node **24.20.0**, Linux x64/glibc,
  pnpm **10.34.5**, SDK **1.0.13**, bundled native runtime **1.0.83** / protocol **3**.
  This release does not upgrade dependencies.
- Copilot remains the authority for native sessions, history, queues and settings.
  Graceful shutdown still waits only for native work and required native in-flight
  operations, not module business activity. Module selection remains an explicit
  cold-start operation; deployment and process management remain user-owned.

Publishing follows the same fixed-commit CI and immutable tag process.
Publication is not installation, deployment or restart and does not modify an
installed service, module selection or user data.
