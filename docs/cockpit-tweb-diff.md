# cockpit ↔ Telegram Web K — diff registry

cockpit's UI **inherits** Telegram Web K's (tweb) design layer rather than
imitating it: real structural tokens (`src/styles/tokens.scss` ← tweb
`variables.scss`/`base.scss`), the real `tgico` icon font, and component CSS
ported near-verbatim from tweb partials. Components render tweb's DOM/class
contract so the vendored CSS resolves.

This is a historical design reference, not a requirement to match every tweb
behavior. Current Cockpit product constraints take precedence. Session menus use
one shared, flat seven-page/four-action catalog; detail panels have no cross-page
tabs or More navigation. Telegram's row/topbar menus differ, so their shared
Cockpit catalog is an intentional simplification, not a claimed source parity.

## Deviations (cockpit on purpose)

1. **Assistant replies are NOT bubbles.** The LLM answer renders as a full-width
   *document* (`.message.is-doc`) with a light byline (`✎ Copilot · time`),
   grouped so consecutive assistant messages share one byline. Only the user's
   own messages are bubbles (`.message.is-out`, tweb's outgoing bubble). This is
   cockpit's signature — an agent console reads answers like docs, not chat.

2. **Colors = Solarized.** Only the *color* custom properties are overridden
   (tokens.scss color block). All structural tokens (spacing, radius, font
   ladder, timing, sizes) use tweb's real values. tweb's color *variable names*
   (`--primary-color`, `--surface-color`, `--secondary-text-color`, …) are kept
   and pointed at Solarized values so ported CSS inherits.

3. **Avatars = project identity, not people.** `.dialog-avatar` is a
   cwd-derived colored monogram (hash→hue, basename initials), since sessions
   map to working directories, not contacts.

4. **Domain features ADDED** (no tweb analog): session queue (`.chat-queue`),
   `ask_user` choices (`.chat-ask`), model + reasoning-effort + context-length
   picker (`.model-select` in the topbar subtitle), connection state
   (`.conn-pill`), voice input (mic), Web Push, deferred-delete + undo toast,
   a needs-a-decision list badge (`.dialog-choice` "选", shown when a session's
   authoritative `attention==='choice'` — stronger than the unread `新` dot),
   a scheduled-prompts list indicator (`.dialog-schedule`, the tweb `schedule`
   clock glyph, shown when `SessionMeta.scheduleCount > 0`) next to the pin badge,
   a topbar **mode control** (`.chat-topbar-mode`, a tweb-style `.btn-icon` showing
   the current mode's glyph — interactive `mode_interactive` ⇄, plan `mode_plan`
   clipboard, autopilot `mode_autopilot` ▶▶ — tinted per mode) opening a
   `ModeMenu` (icon-only segmented popover, mid-turn capable), **file/image attachments** — both *user uploads* and *agent-sent* multimedia:
   a `<cockpit-attachment>` marker in the message text (parsed by the fold) renders
   an inline image or a tap-to-download file card. In a user message it sits in the
   outgoing bubble; in an assistant reply it renders as a figure inside the
   document (shared `.attach-image`/`.attach-file` styling, see the
   `cockpit-multimedia` skill for the agent-side format). The **info panel**
   (tweb `#column-right`) also carries read-mostly domain sections with no tweb
   analog — sub-agents, instruction files, schedules, and an **MCP servers**
   section showing each server's per-session connection status (`.mcp-status`
   pill: 已连接/连接中/失败/待授权/未配置/已关闭/未加载) with a reason line when
   not connected. 未加载 is a read-only projection: status inspection does not
   materialize the session. The vocabulary is shared with the MCP management page
   via `net/mcp-status.ts`.

5. **Domain features DROPPED** (Telegram-only, meaningless for an agent
   console): stickers, reactions, polls, media viewer, voice/video calls,
   stories, folders, profile pane, emoji picker, read receipts, forward/reply/
   edit, chat wallpaper, the 3rd info column, archive (we use *unload* instead).

6. **Keyboard model** = evo-chat's **pure CSS** `position:fixed; inset:0;
   height:100dvh` + `interactive-widget=resizes-content` (owner ruling: "keyboard =
   evo-chat, 无可妥协" — the shell is NOT JS-positioned; the earlier `--vvh`/
   `--app-*` visualViewport-tracking shell hook was deliberately removed, turn 37 of
   session 3ef01f4f). On Android Chrome the keyboard shrinks the layout viewport
   from the bottom, `100dvh` shrinks with it, the composer rides up and the top bar
   stays pinned — zero JS. **Known iOS gap (open):** iOS Safari/WebKit ignores
   `interactive-widget` and its keyboard is an overlay that does *not* shrink
   `100dvh`, leaving a gap between the composer and the keyboard. A minimal iOS-only
   composer-inset fix (`lib/iosKeyboard.ts`, `--kb-inset`) was trialed and reverted
   at the owner's call — so this remains an accepted iOS-only limitation of the
   pure-CSS model.

7. **Motion policy = NO animation effects, REMOVED** (reverses rev26). All
   decorative micro-motion was stripped: the ripple primitive (deleted entirely —
   `lib/ripple.ts` + `styles/primitives/ripple.scss` are gone; `.rp` survives only
   as a `position:relative; overflow:hidden` press-host utility in `base.scss`),
   menu scale-in (`btn-menu-in`), FAB back-out, dialog `dialog-fade`/`dialog-pop`,
   the info-panel slide/scrim/squeeze transitions, switch/search hover transitions,
   and smooth scroll (`Thread` now pins instantly). The motion timing tokens
   (`--transition-*`, `--*-transition`, `--ripple-duration/-max-opacity`) were
   deleted from `tokens.scss`; `--ripple-color` stays (it's the hover fill, not the
   animation). **The only motion kept** is the functional loading feedback — the
   search/inline `.spinner` rotate and the skeleton `.shimmer` sweep — which is not
   a decorative effect (the spinner kept spinning even under `prefers-reduced-motion`
   before). tweb's animations are therefore an intentional non-inheritance.

8. **Notification + plan-mode domain behaviors ADDED** (no tweb analog):
   - **App-icon badge = sessions awaiting the user.** `navigator.setAppBadge(n)` /
     `clearAppBadge()` where `n` = count of sessions with authoritative
     `attention != null` (NOT unread-message total). Foreground: the store
     mirrors it on every `session/patch` (`lib/badge.ts`); background (screen
     off): the Web Push payload carries `badge` and `sw.ts` sets it. Distinct
     from the per-device sidebar `新`/`选` dots, which are local read-state.
   - **Notification click soft-routes, never reloads.** `sw.ts` `notificationclick`
     `postMessage({type:'open-session',sessionId})` to an open client → the store
     flips `activeId` (no SSE reconnect); falls back to `navigate(url)` /
     `openWindow(url)` only when no client is open.
   - **User-cancel raises no attention.** A user-initiated `running→idle`
     (`engine.cancel`) threads `{silent:true}` through `patch`→`nextAttention`,
     so cancelling a turn never fires a "ready" notification/badge.
   - **Plan pending card** (`.chat-pending`): the agent's `exit_plan_mode` summary
     renders as **markdown** (reuses `MessageBody`) in a height-capped scroll box
     (`.chat-pending-summary`), the full plan stays folded (`查看完整计划`), and a
     quiet hint (`.chat-pending-hint`) says the plan can be answered with free
     text/voice, not only the action buttons. The raw `exit_plan_mode` tool call
     is suppressed in the fold (like `task`/`skill`) so the internal tool name and
     dumped args never appear as a tool row.
   - **Freeform send during a pending plan = a one-off new instruction (owner's
     choice).** Sending a composer message while a plan is pending is NOT a normal
     queued prompt and NOT plan feedback — it routes to `planSupersede`: the engine
     dismisses the plan (`respondToExitPlanMode {approved:true, exit_only}`, so the
     proposed plan is NOT executed), temporarily leaves plan mode to run the
     message as a fresh direct instruction, then **auto-returns to plan mode** once
     that turn goes idle (`restorePlanOnIdle`) — the user was deliberately planning,
     the override is one-off. Mirrors how a composer send answers `ask_user`.

9. **Navigation = the URL, with a hierarchical "Up" policy** (tweb uses an
   in-memory `appNavigationController` history stack and no URLs). cockpit is a
   single `<BrowserRouter>` (react-router-dom v7): every screen is a real path
   (`/`, `/session/:id`, `/session/:id/{info,mcp,skills}`, `/mcp`·`/skills`·`/trash`
   and their `/:item` detail), the URL is the single source of truth, and one
   `<Workspace/>` element renders all the `/session*` routes so the master-detail
   shell never remounts across navigation. The cockpit routes form a strict tree,
   so each screen's parent is computable from the URL alone (`lib/nav.ts`
   `parentOf`). **In-app back/close/scrim controls go "Up", not "push back".**
   `useUp()` pops the real history entry (`navigate(-1)`) when the entry directly
   behind is already the hierarchical parent (tracked per `window.history.state.idx`
   in `recordLocation`), else synthesizes the parent with `replace` — so it never
   pushes a duplicate. Navigation discipline keeps the real history stack mirroring
   the hierarchy: **drill-down pushes; lateral moves replace** (switching to another
   session, opening a top-level section from inside a chat, deleting the focused
   session). The result: the system/PWA Back button equals Up for every normal flow,
   killing the old "from the list, Back dives into a random chat" bug. Matters
   doubly for iOS standalone PWAs, which have no system Back button at all.

10. **Butler/Flow trigger layer surfaces ADDED** (no tweb analog). The event-hook /
    Flow orchestration (TRIGGER → FLOW → ACTION; see `docs/butler.md`) gets two
    cockpit-only UI surfaces, both built in the inherited visual language:
    - **Per-session 自动化 sub-page** (kebab → 自动化, route `/session/:id/automation`):
      read-mostly collapsible sections that reuse the `CollapsibleSection`/`.info-*-row`
      pattern of the schedule/MCP sections — **定时任务** (`ScheduleSection`), **事件钩子**
      (`HookSection`: the event hooks this session OWNS, i.e. it's the butler/receiver —
      event + filter + action) and **流程** (`FlowSection`: the engine-global flows from
      `~/.copilot/flows/*.json` — gate?/action shape). These used to live inline in the
      info panel; they were moved out to keep the panel a high-frequency glance (see
      item 11). The sub-page self-fetches `schedule/list` + `hook/list` + `flow/list`.
    - **Sidebar / 自动会话 page**: Flow-spawned worker sessions (`SessionMeta.spawnedBy`,
      R1 mark) are KEPT (not deleted) so they would flood the list; they are
      **excluded from the main list entirely** and collected on their own page
      (hamburger → 自动会话, route `/workers`) — like the trash bin, a list opened
      from the menu. Unlike trash they are LIVE, so a row **opens the real session**
      (`/session/:id`), not a read-only preview. A *pinned* worker is the exception:
      it stays in the main list's pin group (the user deliberately kept it up top).
      The list is the store's pure session projection (no fetch).
    - **Flows page** (hamburger → 流程, route `/flows` · `/flows/:item`): a global
      management section rendered by the same `ManageWorkspace` master-detail as
      MCP/Skills/Trash — the left pane lists `flow/list` (name, action summary, a
      `gate` tag, and a trigger-count tag), the right pane shows one flow's
      **触发器** (the event hooks + server-level schedules pointing at it, joined
      from `hook/list` + `flow-schedule/list`), gate (script + timeout + the
      exit-code contract), action (cwd/skills/mcp/model/mode), and full prompt.

11. **Session info panel SLIMMED to a high-frequency glance + per-session detail
    sub-pages ADDED** (no tweb analog; cockpit IA decision). The right column
    (`#column-right`) used to stack ~12 sections (identity, pin, model, todos,
    changed files, plan.md, MCP, schedules, hooks, flows, sub-agents, instruction
    sources) and felt over-full. The panel now keeps only what the owner glances at
    often — **identity (title/cwd/id/pin) + model picker + TODO checklist + MCP
    status summary** — and the low-frequency heavy detail moved into two per-session
    sub-pages reached from the chat kebab, **reusing the exact same URL + panel-slot
    mechanism as the MCP/Skills pages** (`/session/:id/<page>`, rendered into the
    `.info-panel` slot, closed via `useUp()`; `parentOf` already maps any
    `/session/:id/:panel` → `/session/:id`, so Back/Up and cold deep-links work with
    no new history plumbing):
    - **自动化** (`/session/:id/automation`) — schedules + hooks + flows (see item 10).
    - **上下文** (`/session/:id/context`) — plan.md + changed files + instruction
      sources + sub-agents.
    Each sub-page self-fetches only its own data (mirroring `SessionMcp`/`SessionSkills`).
    Shared primitives (`CollapsibleSection`, `PanelPageShell`) live in
    `components/SessionPanelKit.tsx`; the pages in `components/SessionPages.tsx`. The
    panel's own structure/visual language is unchanged — only its contents were split.

## Inheritance map (where each piece comes from)

| cockpit | tweb source |
| --- | --- |
| `styles/tokens.scss` | `variables.scss` + `base.scss` (:root custom props) |
| `styles/base.scss` | `base.scss` (reset, user-select policy, scrollbar) |
| `styles/tgico.scss` + `public/assets/fonts/tgico.*` | `scss/tgico/*` + `assets/fonts/tgico.*` |
| `styles/primitives/button.scss` | `_button.scss` (.btn/.btn-icon/.btn-corner/.btn-primary) |
| `styles/primitives/menu.scss` | `_button.scss` (.btn-menu/.btn-menu-item) |
| `styles/primitives/scrollable.scss` | `_scrollable.scss` |
| `styles/primitives/preloader.scss` | `_preloader.scss` / `_shimmer.scss` |
| `styles/components/sidebar.scss` | `_leftSidebar.scss` + `_chatlist.scss` + `_row.scss` + `_inputSearch.scss` |
| `styles/components/chat.scss` | `_chatTopbar.scss` + `_chat.scss` + `_chatBubble.scss` + `_input.scss` |
| `styles/components/shell.scss` | left-sidebar dock math (`$floating-left-sidebar` 925px) |
| `lib/longpress.ts` | long-press → context-menu gesture |

## Global interaction primitives (one-time, not per-component)

- **Long-press never selects text**: `body { user-select: none }` globally;
  re-enabled only on `.message-body`, inputs, `.selectable` (base.scss).
- **No motion**: all transitions/animations removed (deviation #7); `.rp` is now
  just a `position:relative; overflow:hidden` press-host utility (base.scss).
- **Context menu**: `useLongPress(open)` — right-click (desktop) / long-press
  (touch), shared by the chat list and the chat topbar kebab.
- **Hierarchical Up**: `useUp()` (`lib/nav.ts`) — every in-app back arrow / panel
  close / scrim goes one level up the route tree (pop when the entry behind is the
  parent, else replace), so system/PWA Back == Up (deviation #9).

## Source

tweb @ commit `c29dfcf` (GPL-3.0). cockpit is GPL-3.0 (see `NOTICE.md`).
