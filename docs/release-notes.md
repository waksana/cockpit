# Cockpit 0.2.4

Release summary for v0.2.4, relative to published v0.2.3.
**0.2.4 配套 / 发布资产以对应 Release 为准**：
[Cockpit v0.2.4](https://github.com/waksana/cockpit/releases/tag/v0.2.4) and
[Cockpit Notification v0.1.5](https://github.com/waksana/cockpit-notification/releases/tag/v0.1.5).
The checked runtime archive and checksum become available only after the
immutable tag's Release workflow succeeds; this document does not assert that
publication has completed. Historical v0.2.3 facts remain in its
[tag and Release](https://github.com/waksana/cockpit/releases/tag/v0.2.3),
including its Notification 0.1.0 pairing. Its assets are not redefined here.

## Scoped module payload events

- [#30](https://github.com/waksana/cockpit/pull/30), implementing
  [#28](https://github.com/waksana/cockpit/issues/28), adds backend
  `context.publish(payload)` and frontend `context.onEvent(listener)`.
  Real module-owned JSON payloads travel over the existing `/events` SSE as
  `module/event { moduleId, payload }`, rather than only an invalidation hint.
- The host binds the module identity, captures an immutable snapshot and enforces
  a **64 KiB serialized UTF-8 JSON** limit and strict JSON validation.
  Listeners receive only their own module's payloads and are revoked with the
  module scope. The original `invalidate` / `onInvalidate` hint remains available.
- There is no additional connection, native event/history insertion, replay log,
  per-message ACK or host-owned business state. Delivery and reconnect recovery
  remain module concerns; payload publication does not add graceful-shutdown work.

## Independent menus; removed navigation middleware

- [#45](https://github.com/waksana/cockpit/pull/45), addressing
  [#33](https://github.com/waksana/cockpit/issues/33), adds
  `ModuleFrontend.menus` for the existing **global and session menus**.
  Modules must check the independent **`context.menuVersion === 1`** capability;
  Web API v2 or UI v1 alone does not imply menu support.
- **Breaking for navigation middleware consumers:** the legacy
  `globalNavigation` component HOC and its props contract are removed, with no
  compatibility alias or fallback. Menu declarations, real semantic component
  middleware, state/service/draft and Markdown rendering are distinct mechanisms.
  This is not arbitrary page/router registration.
- Native menu items remain first; module commands have stable ordering and
  normalized separators. The host owns keyboard navigation, focus, closing and
  focus return. Display state comes from the module's existing service.
- Selection rechecks visibility, disabled state and target availability. Actions
  retain the frozen original session target, never the subsequently active route.
  Module/target loss or unknown connection aborts the signal; ordinary menu close
  and navigation do not cancel accepted work. Stale callbacks and late results
  cannot restore revoked host contributions. Command failures are isolated;
  activation-owned subscriptions are cleaned up with their module.

## Presentation and documentation

- [#32](https://github.com/waksana/cockpit/pull/32) makes pending session status
  a single **待回答** label, with module status/count decorations trailing the
  native indication. Its intermediate navigation-HOC composition is superseded
  by #45's menu registry, not retained as a second extension path.
- [#43](https://github.com/waksana/cockpit/pull/43) explains core versus modules,
  updates the module catalog and installation guidance, and updates screenshots
  made from real components with synthetic data. Installation guidance introduces
  optional modules one at a time rather than enabling everything by default.

## Paired modules and compatibility

- **Cockpit Notification 0.1.5** is the 0.2.4 pairing, distributed separately.
  Its UI is the this-device menu toggle, message redline, reading of the actual
  message/current-ask `bodyRef`, and trailing session count. There is no standalone
  bell, page-wide unread total, notification dialog or header control.
  Web Push and application badges remain module-owned and device/permission dependent.
- Notification's exact SDK source pin is
  **`e6b0b8d7c4ba7b21a0b627dc21fd61c0c53f6ac0`**, recorded in its
  `tooling/host-sdk.json`. That export comes from host **0.2.3 development source**
  (0.2.3-development), not the published release, and already contains the
  equivalent compatible public API; the host's 0.2.4
  patch-version change does not alter those exported types. The old label does
  not make published Cockpit 0.2.3 compatible with the new menu/payload pairing.
  See the [canonical pairing](module-contract-draft.md).
- Existing **Cockpit File 0.1.7** remains compatible: it does not consume the
  removed `globalNavigation` HOC. It is **not being rereleased**.
  Modules are neither bundled nor automatically installed. Download and
  version-specific instructions are in the [module catalog](module-catalog.md).
- Module manifests/backend API remain **v1**, Web API **v2**, public UI **v1**,
  and menu capability **1**, checked independently. See the
  [module contract](module-contract-draft.md) and [UI guide](module-ui-guide.md).

## Unchanged runtime and product boundaries

- Web, backend and MCP must come from the same host release. The supported
  baseline remains **Node 24.20.0**, **Linux x64/glibc**, **pnpm 10.34.5**,
  **SDK 1.0.13**, bundled native **runtime 1.0.83 / protocol 3**.
  This release does not upgrade dependencies.
- Modules are **cold-loaded only**: installation, version selection and
  enable/disable selection take effect on the next cold start, not in the current
  process. Hot loading, hot enable/disable and hot updates are not future goals;
  no framework or process-model change is reserved for them.
- The full native system page remains a **separate future scope**: read-only host
  version, all installed module versions and actual loaded state, plus safe
  shutdown at the bottom. It is not implemented by this menu work.
- Copilot remains the authority for native sessions, history, queues and settings.
  Graceful shutdown waits only for native work and protected native operations,
  not module business activity. Trusted main-process imports and user-owned
  deployment/process management are unchanged.

Publishing follows fixed-commit CI and immutable tags. Publication is not
installation, deployment or restart and does not alter any running service,
module selection or user data.
