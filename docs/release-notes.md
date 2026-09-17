# Cockpit 0.2.2

Release summary for v0.2.2, relative to v0.2.1. The checked runtime archive and
checksum are published only after the immutable tag's Release workflow succeeds.

- [#24](https://github.com/waksana/cockpit/pull/24): simplify the independent
  session settings, MCP and Skills panels, removing redundant notices while
  preserving native controls and state readback.
- Empty Skills panels no longer offer a global management entry.
- Resource rows keep stable state layouts without automatic height changes or
  separate error boxes. Long text and error details expand only on demand.
- MCP connecting and disconnecting states use the existing off/on controls;
  this release does not introduce a reconnect operation.
- Decorative hover effects are removed while keyboard focus indicators and
  selected-state styling remain available.

## Unchanged compatibility and runtime baseline

- Web, backend and MCP must come from this same release. This is a presentation
  update: API contracts, native session ownership and runtime behavior are unchanged.
- The supported package baseline remains Node **24.20.0**, Linux x64/glibc,
  SDK **1.0.13**, bundled native runtime **1.0.83** / protocol **3**.
- Module API v1 and Module UI v1 are unchanged, including `context.uiVersion: 1`
  and `context.createPortal`. The
  [public Module UI guide](https://github.com/waksana/cockpit/blob/v0.2.2/docs/module-ui-guide.md)
  documents the shared host visual roles and compatibility contract.
- The separate, compatible **Cockpit File 0.1.6** package is not bundled or
  repinned by this host release. Existing module selection and data remain unchanged;
  this release requires no module update or user-data migration.

Publishing follows the same fixed-commit CI and immutable tag process.
Publication alone does not restart or modify an installed service.
