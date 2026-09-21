# Module UI guide

This is the authoritative guide to module presentation contracts. The classic
**Module UI v1** styling source of truth is
[`public-ui.scss`](../apps/web/src/styles/primitives/public-ui.scss); the
[module contract](module-contract-draft.md) owns loading, contributions, drafts
and native attachment delivery. Before any host or module UI work, read and follow
the [frontend guidelines](frontend-guidelines.md). They own the shared principles;
this guide owns the public styling, icon and composition contract, not a second
theme or a claim that existing modules already conform.
For available methods and exactly which host data they expose, use the
[public API map](module-contract-draft.md#public-api-map) and
[data boundaries](module-contract-draft.md#public-data-boundaries).
Registering module state does not itself inject chat data or expose the private
host store. Read the explicit `state.chatWindow` capability where needed.

## Independent new UI

Classic and new presentation are separate document entries, not two themes
applied to the same component tree. A module may provide both:

```json
{
  "frontend": {
    "entry": "web/index.js",
    "styles": ["web/styles.css"],
    "assets": ["web"],
    "next": {
      "entry": "web/next/index.js",
      "styles": ["web/next/styles.css"]
    }
  }
}
```

The installer validates both entries and their styles against the same immutable
archive and declared asset roots. Classic loads only `entry`/`styles`; the new
runtime loads only `next.entry`/`next.styles`. Missing `next` means the module
does not provide this presentation: it is listed as classic-only, not silently
rendered with legacy CSS. This affects frontend presentation, not whether the
module backend is running.

The new entry exports `activate(context: ModuleNextFrontendContext)`. It uses
`context.ui.version === 1` and the actual React components in `context.ui`.
The available names and supported props are defined by
[`ModuleUi`](../packages/module-api/src/ui.ts). It does not receive classic
`uiVersion` or `uiSurfaceVersion` claims. `ModuleFrontendServices` contains the
shared state/draft/request/menu capabilities so business logic need not depend
on either presentation. Both entries return the same Web API v2 declaration.
The new runtime waits for declared styles to load before activating or
publishing module components; failed styles disable that presentation locally.

The host sources live in `packages/ui`: only components actually used by the
host belong there. Modules reuse those public components first. A component
needed only by a module belongs in that module's own component directory, with
its upstream license and intentional local modifications maintained there.
Do not make the host bundle a module-only widget or import private host paths.

Module-local components use the host React and inherited new-UI theme variables,
such as `--background`, `--foreground`, `--muted`, `--muted-foreground`,
`--border`, `--primary` and `--destructive`. Their business CSS keeps a unique
module prefix. Do not ship a second global Tailwind preflight, redefine the
host theme, or rely on the host scanning external module source for utility
classes. Any local utility CSS must be built into the module's own stylesheet
without global resets and with isolation from peer modules.

Composite component parts (for example Dialog root/content/close) must come
from one implementation instance. Copying one part from another dependency
instance does not share its context. Public component reuse does not grant
access to private stores or change business-state ownership.

Switching entries replaces the document. Persisted drafts share their existing
encoding, but browser Files, uploads, recording/recovery resources and pending
operations do not transfer. Each activation protects its own nonpersisted work,
including hidden drafts, with a conditional native `beforeunload` handler and
releases that handler on disposal. The host protects its native pending/unsaved
work separately. Leave confirmation must not itself cancel or mutate work.
Do not promise that browser teardown can always be prevented or that mobile OS
termination preserves in-memory resources.

## Compatibility and ownership

The following sections describe classic Module UI v1.

Hosts implementing this style contract pass **`context.uiVersion === 1`**
to frontend activation. The package version alone is not sufficient evidence.
A module requiring these
styles must reject activation explicitly when the field is missing or unsupported:

```ts
if (context.uiVersion !== 1) throw new Error('This module requires Cockpit Module UI v1');
```

This host also exposes `context.createPortal(children, container)` from its
existing ReactDOM. Modules using it must check that it is a function before
registering their contributions. Do not bundle a separate ReactDOM implementation.

UI v1 is separate from **Web API v2** (`context.apiVersion` and the returned
declaration are both 2); module manifests and backend API remain v1.
Menus add the independent **`context.menuVersion === 1`** capability.
Modules declaring menus must check it explicitly; neither Web v2 nor UI v1
implies menu support, and no legacy navigation fallback is provided:

```ts
if (context.menuVersion !== 1) throw new Error('This module requires Cockpit menu v1');
```

These capabilities are included in the **Cockpit 0.2.4** release preparation;
**0.2.4 配套 / 发布资产以对应 Release 为准**, not a claim that publication is
complete. Its pairing is **Cockpit File 0.1.7 / Cockpit Notification 0.1.5**.
File 0.1.7 does not consume the removed `globalNavigation` HOC, remains compatible
and is not being rereleased. Historical **0.2.3 / Notification 0.1.0** assets
are unchanged. See the [module catalog](module-catalog.md) for release-specific downloads.
Notification's `tooling/host-sdk.json` records its exact compatible SDK source pin.
That export comes from development source still numbered 0.2.3
(0.2.3-development); the host's 0.2.4 patch-version change
does not change those exported API types or retroactively add capabilities to the
0.2.3 Release. The [module contract](module-contract-draft.md) owns the full SHA
and authoritative pairing; package labels alone cannot establish capabilities.
Use the existing explicit cold-start procedure. Building or merging any repository
does not authorize installation, deployment or restart.

Public classes and variables below are compatibility commitments. Additions may
extend v1; removal, changed meaning or incompatible structure requires a new UI
version and a documented paired migration. Internal stylesheet refactors cannot
silently break these names. Modules should not infer support from a private
selector or duplicate a fallback copy of the host stylesheet.

The shared surface compositions additionally expose **`context.uiSurfaceVersion === 1`**.
This is an independent capability of the current source, not a retroactive claim
about a released UI-v1 host. Consumers of `ck-surface`, `ck-heading`, `ck-actions`,
`ck-badge` or `ck-modal` must reject missing/unsupported capability before
registering contributions, and build against the actual paired host source pin:

```ts
if (context.uiVersion !== 1 || context.uiSurfaceVersion !== 1) {
  throw new Error('This module requires Cockpit UI v1 and shared surfaces v1');
}
```

These are CSS compositions, not a public React component SDK. They provide no
dialog lifecycle, focus trap, routing, loading state or optimistic mutation.
Keep native dialog/portal ownership in the existing consumer. A normal panel
using `ck-surface` does not become modal.

The host's internal visual foundations live in `styles/tokens.scss`: the
`--host-*` roles own shared spacing (4/8/12/16/24px), UI typography
(16px title / 14px body / 12px metadata, 1.5 leading), and control/dialog radii.
They preserve the original tweb structural namespace and Solarized palette.
Chat aliases these foundations while retaining its 16px / 1.7 prose role and
explicit dense-control exceptions. Session settings, session MCP and session
Skills remain separate pages with flat sections; they share visual roles, not
navigation or mutation policy. **`--host-*` and `--chat-*` are not module APIs**;
modules continue to use only the public `--ck-*` variables below.

Session MCP rows pair name/source on the left with switch/connection status on
the right. Name/source form a compact, vertically centered group independent of
the switch's height; MCP rows use 8px top/bottom insets without shrinking the
40px/44px switch target. Only the operated row shows switching progress; other switches remain
disabled during native serialization without repeated explanatory notices.
The three session pages omit static instructional text, and an empty Skills
page only reports that no skills were found. Actual failures, native results and
unavailable-session recovery remain visible. Reconnecting an individual MCP uses
its existing off/on switch, not an additional reload-all action.
MCP and Skills reuse their status slot for connection/disconnection or
enable/disable progress and a discoverable, underlined failure action. No progress
line or error box opens automatically. Names and sources occupy one line; Skills
reserve two description lines even before descriptions arrive. Overflowing text
itself is a keyboard-accessible disclosure, without an extra arrow or button row.
Only explicit activation expands full text or error details inline; replacement
text/errors start collapsed. These dense reading/status disclosures keep their
line-height targets and visible focus, while switches retain 40px/44px targets.
Expanded content has no fixed height or clipping.

The host loads its base stylesheet; a module declares its business stylesheet in
`frontend.styles`. Both live in the **same document**, without Shadow DOM or a
style sandbox. Modules keep a unique prefix, such as `cf-` or `example-`, for their
own layout. Do not redefine `.ck-*`, reset `body`/`html`, depend on host page
ancestors, or use private `.btn-icon`, `.chat-*`, `.dialog-*` selectors. Loading
order is not a theme API.

## Public classes

| Class | Supported element / meaning |
| --- | --- |
| `ck-button` | Native `button`, or `a[href]` for navigation; text/action baseline, aligned children, padding and keyboard focus. |
| `ck-icon-button` | Native `button` or `a[href]`; centered icon, round target, muted default ink. Provide an accessible name and tooltip. |
| `ck-input` | Text-like `input`, `textarea`, `select`; shared field appearance and focus. Not a checkbox/radio/file input reset. Keep native labels and types. |
| `ck-icon` | Decorative `svg`, or a `span` containing one SVG. Shared dimensions, currentColor, stroke and alignment. |
| `ck-icon-sm` / `ck-icon-md` / `ck-icon-lg` | On `ck-icon`: 16 / 20 / 24 CSS px. Defaults to 24px. Use the same size within an action group. |
| `ck-text-primary` / `ck-text-secondary` | Phrasing or flow text elements; primary and secondary theme ink, not a heading or label substitute. |
| `ck-danger` | Dangerous action ink; combine with `ck-primary` for a filled destructive action. Always retain explanatory text/name. |
| `ck-primary` | On a button/link: filled accent action with contrasting foreground. |
| `ck-input-hint` | Input-adjacent hint text, using the host input font size (including the user's message-size setting) and UI leading. |
| `ck-status-text` | Auxiliary status text with the host metadata size and UI leading; combine with semantic ink classes. |
| `ck-input-row` | A real input/control row: full width, shared inset and control gap, bottom-aligned children. Used by the native composer itself. |
| `ck-input-status` | A module-owned, normal-flow status row adjacent to an input row; full width and fixed 32px height. Does not render content or register actions. |
| `ck-status-marker` | A 12px decorative status icon region aligned to the first input control's center. |
| `ck-status-label` | Single-line status content with ellipsis; preserve the full accessible text and provide its full title. |
| `ck-status-action` | On `ck-icon-button`: a trailing status action aligned to the native input row's last control, with a 32px-high target. |
| `ck-surface` | Flow container or native dialog: common surface ink/background, border, surface radius, body typography and content inset. Consumer owns positioning, available size and scrolling. |
| `ck-heading` | Native heading: shared title typography, zero margin and full wrapping. Choose the correct heading level for the surrounding content. |
| `ck-actions` | Flow container for sibling actions: wrapping flex row, shared gap, trailing alignment. Not a role or action dispatcher. |
| `ck-badge` | Noninteractive status/count text: metadata typography, neutral fill and small inset. Consumer retains the accessible label and truthful semantic state; color alone is not a status. |
| `ck-modal` | On native `dialog`: shared backdrop and modal-surface shadow. Supports a dialog that is itself `ck-surface` or has a direct `ck-surface` child. Does not call `showModal`, size the dialog or move focus. |

The input/status classes are additive UI v1 styles introduced in Cockpit 0.2.6.
Consumers must pair with that host or newer; a previous UI v1 host does not
retroactively acquire these classes. No additional component slot or host
business dispatcher is introduced. Modules wrap the existing `composerEditor`
Base, place their own status row in normal flow, and leave queue/question
placement, available height and scrolling to the host. Do not copy `.chat-*`
rules to adjust those ancestors. The status row has no background or state
policy; content, visibility, icon, elapsed time and actions belong to its module.
Its dense 32px status action is an explicit exception to ordinary control height;
its horizontal target remains aligned to the 40px/44px input controls.

`disabled`, `aria-disabled`, `hidden` and focus-visible are styled consistently.
**CSS does not disable behavior.** Use real `disabled` on native buttons and
fields. A deliberately focusable `aria-disabled` control still needs an event
guard. A link has no native `disabled`: remove its action or explicitly guard
activation when unavailable. `aria-busy` announces actual pending work, but does
not replace disabling mutations. Keep failures visible and preserve retry input.

The default click target is 40px, at least 44px for coarse pointers; it is separate
from the 16/20/24px drawing. Business CSS may control layout and geometry but
must not shrink the target to the SVG size. Dense host tool/thought disclosure
and process-summary rows are an explicit reading-density exception: their
single-line height stays 28px for all pointer types, with the whole row clickable.
Their hit areas do not overlap adjacent rows; this trades touch target height
for compact process reading. Multiline content can still grow. Dense queue rows
are another explicit exception: a queue-local `--ck-control-size` resolving to 32px keeps
message summaries and their copy/remove controls aligned at 32px on all pointers.
The text remains clickable to expand without an extra arrow. Copy controls
outside the queue retain 32px desktop geometry and expand to 44px for coarse pointers.
The input-card header, full-plan disclosure and unfinished-module recovery action
also expand to 44px for coarse pointers. They do not inherit the dense queue
exception. Narrow execution rows wrap their actions instead of changing their
font, radius or spacing scale.
This private layout is not another public button appearance or a blanket
exception for send, stop, session deletion, or other standalone actions.
Public selectors do not depend on a
host ancestor. Avoid changing border/padding or swapping differently sized icons
on hover, pending or confirmation.

Host controls do not add decorative hover fills or recolor text on pointer entry.
Selected rows, primary/destructive action colors, disabled/busy feedback and
keyboard `:focus-visible` remain distinct. The public `--ck-color-hover` token
is retained for module compatibility, but the shared controls do not apply it
automatically.

## Public variables

| Variable | Default / units | Intended use |
| --- | --- | --- |
| `--ck-color-text` | Host primary ink; color | Reading and action foreground. |
| `--ck-color-muted` | Host secondary ink; color | Supporting text and neutral icons. |
| `--ck-color-surface` | Host theme surface; color | Module panels and previews. |
| `--ck-color-border` | Host theme border; color | Business separators and outlines. |
| `--ck-color-accent` | Host accent; color | Primary action and keyboard focus. |
| `--ck-color-on-accent` | Host contrasting surface ink; color | Filled-action text. |
| `--ck-color-danger` | Host danger ink; color | Errors/destructive actions, with text. |
| `--ck-color-success` | Host success ink; color | Success, with text or a named status. |
| `--ck-color-hover` | Host translucent hover fill; color | Neutral hover appearance. |
| `--ck-icon-size` | `24px` | Drawing dimensions; prefer the size classes. |
| `--ck-icon-stroke` | `2`, unitless SVG units | Lucide line width; do not override per path. |
| `--ck-control-size` | `40px`, `44px` for coarse pointers | Minimum button/field block size and icon target inline size. |
| `--ck-space` | `8px` | Common button gap/padding unit. |
| `--ck-radius` | `12px` | Common button/field radius; icon targets are round. |
| `--ck-disabled-opacity` | `0.3`, unitless | Disabled feedback, not state ownership. |
| `--ck-text-title` / `--ck-text-body` / `--ck-text-meta` | `16px` / `14px` / `12px` | Shared-surfaces v1 title/body/metadata roles; not a prose-size override. |
| `--ck-leading-ui` | `1.5`, unitless | Shared-surfaces v1 UI line height. |
| `--ck-radius-surface` | `16px` | Shared-surfaces v1 surface radius, distinct from controls. |

Colors follow the host light/dark palette; Chat supplies its local readable ink
through the same public names. Modules consume the inherited values, not the
private tokens they alias. Module-owned surfaces may locally override public
variables for a genuine surface/size variant, keeping contrasting foreground and
background together. Do not override root values, override only one theme, shrink
touch targets, or use different stroke widths to compensate for icon alignment.

## Icons and packaging

The host's thin `Icon` adapter statically imports **Lucide 1.46.0**. Module authors
use only the necessary SVG nodes from that same fixed release, rendered with
`context.react.createElement`. Keep `viewBox="0 0 24 24"`, full paths, rounded
joins/caps and the public stroke. Do not crop, redraw or transform individual
paths to align them. SVGs are decorative (`aria-hidden="true"`,
`focusable="false"`); name the containing action. A visible status label must
still distinguish success, failure and unknown without color.

Do not import a private host component, bring another React runtime, use dynamic
whole-library icon lookup, load a CDN, or depend on removed tgico codepoints.
Product/third-party logos, user emoji, file thumbnails and native media controls
are not generic UI icons and keep their own provenance.

Lucide is **ISC**, with additional **Feather/MIT** provenance for the icons listed
in its license. Copy the complete exact upstream license into your distributed
module package and reference it in your notice. The host ships the same license
in [`public/licenses/lucide.txt`](../apps/web/public/licenses/lucide.txt).
Replacing Telegram's icon font does not erase the host's remaining tweb-derived
structural styles or change Cockpit's GPL-3.0-only license.

## Executable minimal frontend

[`module-ui-example.ts`](../apps/web/src/dev/module-ui-example.ts) is the complete
maintained example, typechecked by the existing Web build and exercised through
the real module runtime by
[`module-ui-example.test.ts`](../apps/web/src/dev/module-ui-example.test.ts).
It declares `writes: ['text']`, enhances the actual composer editor row, renders the
fixed Lucide SquarePen nodes with the host React, and subscribes to the actual
scoped draft state. Its real `disabled` includes host availability, pending and
operation; clicking appends text through the scoped draft, never sends a message.

Use that file as your module frontend source and compile it with your normal
module build. The `@cockpit/module-api` import is type-only; obtain those types
using the [existing export command](module-contract-draft.md#4-公共-typescript-契约).
Your package still needs the ordinary backend entry and manifest from the module
contract. No alternate bootstrap, standalone root or demo application is needed.

The important composition is:

```html
<button type="button" class="ck-icon-button example-draft-action"
        aria-label="Append example text" title="Append example text" disabled>
  <svg class="ck-icon ck-icon-lg" viewBox="0 0 24 24"
       aria-hidden="true" focusable="false"><!-- exact Lucide paths --></svg>
</button>
```

Business classes can add placement, not another copy of baseline button CSS:

```css
.example-draft-action { align-self: end; }
```

## File module and valid composition

The paired file migration replaces its bespoke action SVGs and generic button
appearance with pinned Lucide nodes and `ck-icon-button`. File-owned `.cf-*`
rules retain compact row width/height, columns, inline references, long-name truncation,
upload progress and message/draft placement. The module still owns upload/resolve/
download/remove/retry; public CSS does not own file IDs, storage or native ACK.
The same public variables govern disabled/pending feedback and theme appearance.

A row's preview button contains its file icon, name and status.
Download/remove/retry controls remain **siblings**, never nested interactive
children. Keep the entire main area clickable without making the secondary
actions trigger preview. A transparent overlay button is not inherently invalid,
but should not be retained when direct semantic ownership gives equivalent
geometry and behavior.

Component middleware wraps React components, not their HTML. Preserve the
original node structure and public styling; do not introduce module-placeholder
containers, nested interactive controls, or visual indentation. Real controls
and adornments compose through the base component's ordinary props/children.
Markdown link/image replacements use their separate inline renderer contract.
An empty component inserted only to receive module children is still a slot,
not enhancement of an existing semantic component. Management-header middleware
must wrap the actual controls and preserve their original navigation and focus.
Message middleware retains the real `bodyRef`, including the current ask body;
reading thresholds, unread marks and red-line policy remain module-owned.
The other real component boundaries remain session status, composer/editor
(including ordinary paste/drop events), native attachments and management headers.
Ordinary DOM event props are public component behavior; file selection and its
picker/dispatch lifecycle belong entirely to the file module's state services.

Cockpit 0.2.5 source exposes `composerInputVersion: 1`. The `composerInput`
middleware wraps the actual controlled textarea, whose Base owns editing and
IME/Enter handling. Return Base followed by a microphone sibling; do not duplicate
the editor, native send, or keyboard implementation. Preserve value/onChange,
native events, captured draft and editorRef (including React 19 ref cleanup).
File's existing `composerEditor.children` stays on the left, independently of
input enhancement. Full-width status/recovery content wraps the existing
`composer` Base and follows the entire input row, never inside the textarea or
an interactive control. No placeholder or position slot is provided.
Keep DOM, keyboard and visual order identical. `disabled` gates editing;
`sendBlocked`, draft pending and blocks gate submission without disabling typing.
Speech must also honor native free-text restrictions. This is the breaking
Speech 0.1.1 pairing, not a capability of the historical 0.2.4 release.
Data consumers separately check `chatWindowVersion: 1` and use the
[read-only window state](module-contract-draft.md#chat-window-state), not private
DOM, React children traversal or a second history reader.

## Menu declarations

Menu declarations, semantic component middleware, state/service/draft and
Markdown rendering are four distinct extension mechanisms. Global/session menu
actions belong in the returned `ModuleFrontend.menus` array, not in a navigation
HOC, an empty component boundary or an arbitrary page/router registration.
The [menu contract](module-contract-draft.md#65-菜单注册) owns exact types,
ordering, target availability and lifecycle rules.

Use `getState(target)` for pure synchronous display state, and subscribe to the
module's existing service rather than copying native state. Subscriptions belong
to activation, not each menu opening. The host renders
labels and decorative icons, retains native actions first, normalizes separators
and owns keyboard navigation, disabled behavior, closing and trigger focus return.
Do not put another button, link or menu inside the icon. Menu availability is a
current frontend-view check, not API authorization. Session module actions require
an applied current snapshot, an open connection and a target present in that view;
native navigation keeps its existing offline behavior.

Actions receive the frozen original global/session target and an abort signal.
Recheck that signal after each `await` before applying module-owned results;
never redirect an action to whichever session is now active. The host rechecks
availability and disabled state at selection, rejects stale menu callbacks, and
aborts accepted work when the module stops, the target disappears or the connection
becomes unknown. Normal menu closing and route changes do not cancel accepted work.
Each registration/target pair is busy-guarded. Aborting frees host tracking
immediately without waiting for the Promise; returned data is not applied by the host.

A failed/malformed state read omits and reports only that command; an icon render
failure keeps the command without its icon. Ordinary action errors are reported
without revoking healthy contributions. Subscription setup failure instead rolls
back activation; unsubscribe errors must not prevent remaining cleanup.

## Markdown and modal composition

Markdown renderers may occur inside paragraphs, emphasis, lists or headings.
Returning a `span` does not legalize flow-only children such as `dialog`. Modal
mounting and React ownership must be considered separately; opening a native
dialog in the browser top layer does not repair an invalid DOM content model.
The file module uses `context.createPortal(dialog, document.body)`: the DOM mount
is flow-valid while the dialog remains owned by the original React component.
It uses native `showModal()`/`close()`, closes on replacement/unmount/abort, and
keeps preview/download callbacks bound to their original resource. The host
function does not create another root or supply a focus trap. This is a generic
presentation capability, not private host DOM or a file-specific exception.

An image embedded in a Markdown link also needs care: a module-rendered image
may become a card with buttons and download links. The host keeps linked images
as noninteractive image fallbacks inside their original links rather than
activating an interactive module card beneath an anchor. Ordinary unlinked
images can still use module rendering. Modules must return phrasing-compatible
card content; portals do not relax the content model for anything still
physically inside the card.

## Author checklist

Use the shared [frontend review checklist](frontend-guidelines.md#轻量-review-清单).
For modules, also check explicit capability versions, public-only styles and icon
provenance, the actual host-composed DOM/accessibility tree, drag/drop/paste
ownership, and original-resource binding across session/resource replacement.
Exercise Tab/Shift+Tab, Enter/Space, Escape and focus return through the composed
controls. Use the existing component tests, Chat Lab or module-isolated fixtures,
never production sessions; report the browsers and input methods actually covered.

Inspect the built assets too: only used icons, no icon fonts/CDN requests, no
bundled second React, and a complete distributed license. Update the example and
its tests whenever its public contract changes.
