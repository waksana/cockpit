# Module UI guide

This is the authoritative guide to the **implemented Module UI v1** primitives.
The source of truth is
[`public-ui.scss`](../apps/web/src/styles/primitives/public-ui.scss); the
[module contract](module-contract-draft.md) owns loading, contributions, drafts
and native attachment delivery. All UI follows the
[interaction semantics requirement](DEVELOPMENT.md#interaction-semantics-and-structural-correctness).

## Compatibility and ownership

Module API v1 hosts implementing this contract pass **`context.uiVersion === 1`**
to frontend activation. Earlier 0.2.0 source builds did not expose this field;
the package version alone is not sufficient evidence. A module requiring these
styles must reject activation explicitly when the field is missing or unsupported:

```ts
if (context.uiVersion !== 1) throw new Error('This module requires Cockpit Module UI v1');
```

This host also exposes `context.createPortal(children, container)` from its
existing ReactDOM. Modules using it must check that it is a function before
registering their contributions. Do not bundle a separate ReactDOM implementation.

This is an additive frontend capability, not a new manifest field or backend API.
Existing modules remain loadable by the new host. A newly migrated module is
paired with a UI-v1 host: deliver the host first, then the module, using the
existing explicit cold-start procedure. Building or merging either repository
does not authorize installation, deployment or restart.

Public classes and variables below are compatibility commitments. Additions may
extend v1; removal, changed meaning or incompatible structure requires a new UI
version and a documented paired migration. Internal stylesheet refactors cannot
silently break these names. Modules should not infer support from a private
selector or duplicate a fallback copy of the host stylesheet.

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
the right. Only the operated row shows switching progress; other switches remain
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
| `ck-button` | Native `button`, or `a[href]` for navigation; text/action baseline, aligned children, padding, hover and focus. |
| `ck-icon-button` | Native `button` or `a[href]`; centered icon, round target, muted default ink. Provide an accessible name and tooltip. |
| `ck-input` | Text-like `input`, `textarea`, `select`; shared field appearance and focus. Not a checkbox/radio/file input reset. Keep native labels and types. |
| `ck-icon` | Decorative `svg`, or a `span` containing one SVG. Shared dimensions, currentColor, stroke and alignment. |
| `ck-icon-sm` / `ck-icon-md` / `ck-icon-lg` | On `ck-icon`: 16 / 20 / 24 CSS px. Defaults to 24px. Use the same size within an action group. |
| `ck-text-primary` / `ck-text-secondary` | Phrasing or flow text elements; primary and secondary theme ink, not a heading or label substitute. |
| `ck-danger` | Dangerous action ink; combine with `ck-primary` for a filled destructive action. Always retain explanatory text/name. |
| `ck-primary` | On a button/link: filled accent action with contrasting foreground. |

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
It declares `writes: ['text']`, registers a `composerActions` button, renders the
fixed Lucide SquarePen nodes with the host React, and subscribes to the actual
draft snapshot. Its real `disabled` includes host availability, pending and
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
rules retain card width/height, columns, thumbnails, long-name truncation, upload
progress and message/draft placement. The module still owns upload/resolve/
download/remove/retry; public CSS does not own file IDs, storage or native ACK.
The same public variables govern disabled/pending feedback and theme appearance.

A card's preview button can contain its visible thumbnail, name and status.
Download/remove/retry controls remain **siblings**, never nested interactive
children. Keep the entire main area clickable without making the secondary
actions trigger preview. A transparent overlay button is not inherently invalid,
but should not be retained when direct semantic ownership gives equivalent
geometry and behavior.

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

Review actual composed DOM and the accessibility tree, not just a screenshot or
isolated JSX. Exercise long names, narrow widths, light/dark themes, idle/loading/
failure/retry/disabled states and disappearance while work is pending. Confirm
no cropped glyphs, overflow, card-size shifts or duplicate accessible names.

Use keyboard Tab/Shift+Tab, Enter/Space, Escape and focus return as well as pointer
and touch. Inspect main versus secondary actions, drag/drop/paste ownership,
native disabled behavior, late callbacks and resource/session switching. Do not
hide ownership bugs with blur calls or broad event suppression. Use existing
component tests, Chat Lab and the module's isolated fixtures; never send synthetic
inputs to production sessions. State which browsers/input methods were actually
exercised rather than claiming all-platform compliance.

Inspect the built assets too: only used icons, no icon fonts/CDN requests, no
bundled second React, and a complete distributed license. Update the example and
its tests whenever its public contract changes.
