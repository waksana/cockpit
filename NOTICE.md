# Cockpit - attribution and licensing

Cockpit is a single-operator Web/API/MCP interface to native GitHub Copilot
sessions, licensed under **GPL-3.0-only**; see [LICENSE](LICENSE).

## Telegram Web K

[Telegram Web K / tweb](https://github.com/morethanwords/tweb), copyright
Telegram / morethanwords, is licensed GPL-3.0-only.

Cockpit includes the tweb-derived structural style layer and the vendored
`tgico` font/codepoints, not only abstract design inspiration. Relevant source
attribution remains in
[`styles/tgico.scss`](apps/web/src/styles/tgico.scss),
[`styles/tokens.scss`](apps/web/src/styles/tokens.scss),
[`styles/base.scss`](apps/web/src/styles/base.scss) and component/primitives
styles. Cockpit uses its own Solarized color mapping and product-specific
interaction behavior; this is not a claim of current upstream UI parity.

The [historical design study](docs/archive/telegram-study.md) and
[historical difference registry](docs/archive/cockpit-tweb-diff.md) preserve
design background, not a second current licensing or implementation statement.

Retained dependencies keep their respective licenses and notices. Parking
original source in the [external extraction archive](docs/extractions.md) does not erase its attribution or license,
and this document does not relicense third-party packages.
