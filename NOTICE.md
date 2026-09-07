# cockpit — attribution & licensing

cockpit is a personal, single-user web console for driving GitHub Copilot CLI
agent sessions. It is licensed under the **GNU General Public License v3.0**
(see [`LICENSE`](./LICENSE)).

## Third-party design/interaction attribution

The session-list and interaction design (context menu, list-row information
density, search, pinning, responsive master–detail breakpoints) is **derived
from and inspired by Telegram Web K**:

- **Telegram Web K** — <https://github.com/morethanwords/tweb> — © Telegram /
  morethanwords, licensed **GPL-3.0-only**.

cockpit borrows Telegram Web K's *structural* design language and interaction
patterns (studied in [`docs/telegram-study.md`](./docs/telegram-study.md)) while
substituting its own Solarized color palette and a zero-animation presentation
doctrine. Because Telegram Web K is GPL-3.0-only, cockpit is distributed under
the same GPL-3.0 license.

No Telegram Web K source code is copied verbatim; the influence is on layout,
information organization, and interaction logic.
