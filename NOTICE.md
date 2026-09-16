# Cockpit - attribution and licensing

Cockpit is a single-operator Web/API/MCP interface to native GitHub Copilot
sessions, licensed under **GPL-3.0-only**; see [LICENSE](LICENSE).

## Telegram Web K

[Telegram Web K / tweb](https://github.com/morethanwords/tweb), copyright
Telegram / morethanwords, is licensed GPL-3.0-only.

Cockpit includes the tweb-derived structural style layer, not only abstract
design inspiration. The former `tgico` font and codepoints have been replaced
with Lucide; this does not remove the structural styles' attribution:
[`styles/tokens.scss`](apps/web/src/styles/tokens.scss),
[`styles/base.scss`](apps/web/src/styles/base.scss) and component/primitives
styles. Cockpit uses its own Solarized color mapping and product-specific
interaction behavior; this is not a claim of current upstream UI parity.

## Lucide

UI icons use the explicitly pinned `lucide-react` **1.46.0** release.
Lucide is ISC-licensed, with the upstream Feather-derived icons covered by the
additional MIT notice. The complete upstream license is distributed with the
Web assets at [`licenses/lucide.txt`](apps/web/public/licenses/lucide.txt),
including in the built runtime package. Only statically imported icons are bundled;
no icon font, external CDN or runtime icon lookup is used.

Retained dependencies keep their respective licenses and notices.
This document does not relicense third-party packages.
