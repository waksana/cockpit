# Cockpit 0.2.1

Release summary for v0.2.1, relative to v0.2.0. The checked runtime archive and
checksum are published only after the immutable tag's Release workflow succeeds.

- [#21](https://github.com/waksana/cockpit/pull/21): remove initial hamburger
  autofocus on page entry and route remount. Native keyboard focus indicators
  and explicit menu focus handling remain available.
- [#22](https://github.com/waksana/cockpit/pull/22): unify session-list row gaps
  and chat composer spacing. Input-card insets are symmetric, with consistent
  spacing between the editor, execution, queue and decision content.
- Compact tool controls use 28px targets and queue rows use 32px targets, without
  a decorative disclosure arrow. Coarse-pointer controls retain their explicit
  44px accessibility exceptions.
- Session information shows the full session ID with a separate copy control.
  Copy confirmation and clipboard errors remain explicit without changing the ID.
- Session information, MCP and skills remain three independent, flat panels,
  sharing visual roles for surfaces, spacing, typography, controls and feedback.
  Model drafts and native mutation/readback behavior are preserved.
- Long decision questions wrap within the input card. Narrow execution rows
  wrap without clipping status text or hiding actions.

## Unchanged compatibility and runtime baseline

- Web, backend and MCP must come from this same release. This is a presentation
  update: API contracts, native session ownership and runtime behavior are unchanged.
- The supported package baseline remains Node **24.20.0**, Linux x64/glibc,
  SDK **1.0.13**, bundled native runtime **1.0.83** / protocol **3**.
- Module API v1 and Module UI v1 are unchanged, including `context.uiVersion: 1`
  and `context.createPortal`. The
  [public Module UI guide](https://github.com/waksana/cockpit/blob/v0.2.1/docs/module-ui-guide.md)
  documents the shared host visual roles and compatibility contract.
- The separate, compatible **Cockpit File 0.1.6** package is not bundled or
  repinned by this host release. Existing module selection and data remain unchanged;
  this release requires no module update or user-data migration.

Publishing follows the same fixed-commit CI and immutable tag process.
Publication alone does not restart or modify an installed service.
