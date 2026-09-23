# Module UI guide

Presentation contract for module frontend UI. **Module UI v1** style lives in
[`public-ui.scss`](../apps/web/src/styles/primitives/public-ui.scss); shared surfaces live
in [`surfaces.scss`](../apps/web/src/styles/primitives/surfaces.scss). The
[module contract](module-contract.md) owns loading, contributions, drafts and native
attachment delivery. Read the [frontend guidelines](frontend-guidelines.md) before UI
work. For host data, use the [public API map](module-contract.md#public-api-map) and
[data boundaries](module-contract.md#public-data-boundaries). `state.chatWindow` requires
its explicit capability.

## Compatibility and ownership

Hosts implementing this contract pass **`context.uiVersion === 1`** to activation.
Modules needing these styles must reject unsupported hosts:

```ts
if (context.uiVersion !== 1) throw new Error('This module requires Cockpit Module UI v1');
```

Current Web exposes these independent frontend capabilities:

| Capability | Meaning |
| --- | --- |
| `apiVersion: 2` | Web frontend declaration/activation. Module manifests, backend API and backend manifests remain v1. |
| `menuVersion: 1` | Declarative global/session menu actions. Check separately. |
| `chatWindowVersion: 1` | Read-only current-window text projection; check before `state.chatWindow`. |
| `composerInputVersion: 1` | Middleware around the actual controlled textarea. |
| `uiVersion: 1` | Public base classes, variables and control behavior here. |
| `uiSurfaceVersion: 1` | Public `ck-surface`, `ck-heading`, `ck-actions`, `ck-badge`, `ck-modal`. |

Modules declaring menus must reject missing/unsupported `context.menuVersion === 1`; no
legacy navigation fallback is provided. Consumers of shared surfaces must reject
missing/unsupported `context.uiSurfaceVersion === 1` before registering contributions.
`context.createPortal(children, container)` comes from host ReactDOM; check it is a
function and do not bundle another ReactDOM. For release pairing, use the
[module catalog](modules.md) and GitHub Releases.

Public classes/variables are compatibility commitments. Additions may extend v1; removal,
changed meaning or incompatible structure requires a new UI version and migration. Do not
infer support from private selectors or ship fallback host CSS.

Shared surfaces are CSS compositions, not a React component SDK. Modules own dialog
lifecycle, `showModal()`, `close()`, portal mounting and resource binding. Only `--ck-*`
variables are module APIs; override them locally only for real surface/size variants, with
foreground/background contrast preserved.

The host loads base CSS; modules declare business CSS in `frontend.styles`. Both run in
one document: no Shadow DOM/sandbox. Use a unique prefix (`cf-`, `example-`). Do not
redefine `.ck-*`, reset `html`/`body`, depend on host ancestors, or use private
`.btn-icon`, `.chat-*`, `.dialog-*` selectors. Loading order is not a theme API.

Session MCP/Skills and global MCP/Skills pages keep row-local progress, actual native
status/error text, 40px/44px switch targets, provenance badges that wrap inline, and
keyboard/touch disclosures for full errors or overflowing text; individual MCP reconnect
uses the existing off/on switch, not a reload-all action. Session MCP has no
connection-method presentation because the native session API does not provide it; errors
show the actual first-line summary, capped at 160 characters. Global detail headers
preserve `item`, `actions` and optional `titlePrefix`; MCP details show structured
connection summary plus redacted `连接配置`, Skills details show Skill Markdown, and
settled list mutations invalidate both list and detail reads.

## Public classes

| Class | Supported element / meaning |
| --- | --- |
| `ck-button` | Native `button`, or `a[href]`; text/action baseline, aligned children, padding and keyboard focus. |
| `ck-icon-button` | Native `button` or `a[href]`; centered round icon target. Provide accessible name and tooltip. |
| `ck-input` | Text-like `input`, `textarea`, `select`; shared field appearance/focus. Not checkbox/radio/file reset; keep native labels and types. |
| `ck-icon`; `ck-icon-sm` / `ck-icon-md` / `ck-icon-lg` | Decorative `svg` or `span` with one SVG; `currentColor`, shared stroke/alignment; sizes 16 / 20 / 24px, default 24px; use one size within an action group. |
| `ck-text-primary` / `ck-text-secondary` | Primary/secondary ink for phrasing or flow text, not heading semantics. |
| `ck-danger`; `ck-primary` | Danger ink; filled accent action. Combine for filled destructive action and keep explanatory text/name. |
| `ck-input-hint`; `ck-status-text` | Input hint with input font/UI leading; metadata-sized auxiliary status text. |
| `ck-input-row`; `ck-input-status` | Full-width input/control row; adjacent module status row with fixed 32px height and no behavior. |
| `ck-status-marker`; `ck-status-label`; `ck-status-action` | 12px status icon region; single-line ellipsis label with full accessible text/title; trailing 32px-high status icon action. |
| `ck-surface` | Flow container or native dialog with common ink/background, border, radius, body typography and inset. Consumer owns positioning, size and scrolling. |
| `ck-heading` | Native heading with shared title typography, zero margin and wrapping. Choose the correct level. |
| `ck-actions` | Wrapping flex row for sibling actions with shared gap/trailing alignment; not a dispatcher. |
| `ck-badge` | Noninteractive status/count text with metadata typography and neutral fill; keep accessible label and semantic state. |
| `ck-modal` | On native `dialog`: backdrop and modal shadow. Dialog may itself be `ck-surface` or have a direct `ck-surface` child; does not call `showModal`, size or focus. |

CSS never disables behavior: use real `disabled` where native controls support it, and
guard focusable `aria-disabled` controls or unavailable links. `aria-busy` announces
pending work but does not replace mutation guards. Keep failures visible. Default target
is 40px, 44px for coarse pointers, separate from 16/20/24px drawing. Do not shrink
targets to SVG size. Density exceptions: process/thought rows (28px), dense queue rows
(`--ck-control-size` = 32px), queue copy/remove and status actions. Ordinary send, stop,
delete and standalone actions keep public geometry. Dense row hit areas must not overlap
adjacent rows; queue text remains clickable without an extra arrow, and narrow execution
rows wrap actions without changing font, radius or spacing. Shared host controls do not
add decorative hover fills or recolor text on pointer entry.

`ck-input-status` has no background or state policy: content, visibility, icon, elapsed
time and actions belong to the module, while its dense 32px status action remains aligned
to the ordinary 40px/44px input controls.

## Public variables

Public variables: `--ck-color-text`, `--ck-color-muted`, `--ck-color-surface`,
`--ck-color-border`, `--ck-color-accent`, `--ck-color-on-accent`, `--ck-color-danger`,
`--ck-color-success`, `--ck-color-hover`; `--ck-icon-size` (`24px`),
`--ck-icon-stroke` (`2`), `--ck-control-size` (`40px`, `44px` coarse),
`--ck-input-font-min` (`0px`, `16px` with any coarse pointer), `--ck-space` (`8px`),
`--ck-radius` (`12px`), `--ck-disabled-opacity` (`0.3`), `--ck-text-title` /
`--ck-text-body` / `--ck-text-meta` (`16px` / `14px` / `12px`), `--ck-leading-ui`
(`1.5`), and `--ck-radius-surface` (`16px`). Use them for text/surface/border/accent,
filled-action contrast, danger/success text, compatible hover fill, Lucide drawing,
control size, mobile input font floor, spacing/radius, disabled feedback, shared surface
type/leading and surface radius. Do not override root values, single themes, touch-target
size, or per-path stroke to compensate for alignment.

## Icons and packaging

The host statically imports **Lucide 1.46.0**. Modules use needed SVG nodes from that
release with `context.react.createElement`. Keep `viewBox="0 0 24 24"`, full paths,
rounded joins/caps and public stroke; do not crop, redraw or transform paths. SVGs are
decorative (`aria-hidden="true"`, `focusable="false"`); name the containing action and
distinguish success/failure/unknown without color alone.

Do not import private host components, bring another React runtime, dynamically load whole
icon libraries, use CDNs, or depend on removed `tgico` codepoints. Product logos, emoji,
thumbnails and media controls keep their provenance. Copy the exact upstream Lucide
license into packages and notices; host copy:
[`public/licenses/lucide.txt`](../apps/web/public/licenses/lucide.txt). Cockpit remains
GPL-3.0-only. Lucide is ISC, with additional Feather/MIT provenance for the icons listed
in its license.

## Executable minimal frontend

The maintained runnable example is
[`module-ui-example.ts`](../apps/web/src/dev/module-ui-example.ts), typechecked by the Web
build and covered by
[`module-ui-example.test.ts`](../apps/web/src/dev/module-ui-example.test.ts). Package it
normally per the [module contract](module-contract.md). It exports `activate`, requires
`context.uiVersion === 1`, uses host React, declares `writes: ['text']`, wraps the real
`composerEditor`, subscribes to scoped draft state and appends text through that draft. It
never sends messages or copies baseline button styles. Add only business placement:

```css
.example-draft-action { align-self: end; }
```

## File module and valid composition

The file module composes public UI with pinned Lucide nodes and `ck-icon-button`.
File-owned `.cf-*` rules still own row geometry, columns, references, truncation, upload
progress, placement, operations, IDs, storage and native ACK. Public CSS owns shared
appearance, variables and disabled/pending feedback.

A row preview button contains file icon, name and status. Download/remove/retry controls
are siblings, never nested interactive children. Keep the main area clickable without
triggering secondary actions. Transparent overlays are allowed only when they preserve
equivalent semantic ownership.

Component middleware wraps React components, not arbitrary HTML. Preserve original node
structure, props, refs, children, actions, accessibility and scroll anchors; do not add
placeholder containers, nested interactive controls or visual indentation. Markdown
replacements use the separate inline renderer. Management-header middleware preserves
navigation/focus. Message middleware keeps `bodyRef`, ask body, thresholds, unread marks
and red-line policy. Other boundaries remain session status, composer/editor (including
paste/drop), native attachments and management headers. File selection, picker and
dispatch lifecycle belong entirely to the file module's state services.

`composerInput` wraps the actual controlled textarea; Base owns editing, IME, Enter,
`value`, `onChange`, native events, captured draft and `editorRef`. Return Base plus
sibling controls; do not duplicate editor, send or keyboard behavior. Full-width
status/recovery wraps existing `composer` Base and follows the input row. `disabled` gates
editing; `sendBlocked`, pending and module blocks gate submission. Speech/freeform
modules honor native free-text restrictions. Data consumers check `chatWindowVersion: 1`
and use [read-only window state](module-contract.md#chat-window-state). Keep DOM,
keyboard and visual order identical; no placeholder or position slot is provided.

## Menu declarations

Menus, semantic middleware, state/service/draft and Markdown rendering are separate.
Global/session menu actions belong in `ModuleFrontend.menus`, not navigation HOCs, empty
component boundaries or router registration. Exact types and lifecycle rules live in the
[module contract](module-contract.md).

Use `getState(target)` for synchronous display state and subscribe during activation, not
each opening. The host renders labels/icons, keeps native actions first, normalizes
separators, and owns keyboard navigation, disabled behavior, closing and trigger focus
return. Do not place another button, link or menu inside the icon. Availability is a
current view check; session actions need an applied snapshot, open connection and visible
target.

Actions receive the frozen target and an abort signal. Recheck after each `await`; never
redirect to the active session. The host rechecks availability at selection, rejects stale
callbacks, aborts accepted work when module/target/connection disappears, and busy-guards
each registration-target pair. Route changes do not cancel accepted work. Failed state
reads omit only that command; icon failures keep the command; action errors do not revoke
healthy contributions. Subscription setup failure rolls back activation; unsubscribe
errors must not stop cleanup. Aborting an accepted action frees host busy tracking
immediately without waiting for its Promise.

## Markdown and modal composition

Markdown renderers can occur inside paragraphs, emphasis, lists or headings. Return
phrasing-compatible content; `span` does not legalize `dialog`. Mount dialogs with
`context.createPortal(dialog, document.body)`, own `showModal()`/`close()`, close on
replacement/unmount/abort, and bind callbacks to the original resource. Linked images
stay noninteractive fallbacks inside links if module rendering would create an interactive
card; unlinked images may use module rendering.

## Author checklist

Use the [frontend review checklist](frontend-guidelines.md). Also check capability
versions, public-only styles, icon provenance, composed DOM/accessibility,
drag/drop/paste ownership, and original-resource binding. Exercise Tab/Shift+Tab,
Enter/Space, Escape and focus return. Use tests, Chat Lab or module-isolated fixtures,
not production sessions. Inspect assets for used icons only, no icon fonts/CDN, no second
React and complete licenses. Update example/tests when the contract changes.
