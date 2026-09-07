# Deploying cockpit on a fresh machine (portable / loopback, no reverse proxy)

This runbook stands up a **second, independent cockpit** on a new machine — notably a
locally-managed **Windows** box — with the **full generic butler suite** but **zero
session content** (a clean-slate install). It is the companion to the portability
refactor (`refactor(portability): …`, commit `3810cb4`): the code now de-hardcodes
paths, runs gates by interpreter, and can serve the web UI itself, so no nginx /
systemd / `/home/honglai` assumptions remain.

The canonical Linux deploy is **unchanged** by any of this: every new behavior is
either backward-compatible (`homedir()` still resolves the same path; `.sh`/`.py`
gates still run) or opt-in via an environment variable that is **off by default**.

---

## 1. Privacy model (no content leaks to the public network)

- The server binds **`127.0.0.1` only** (hard-coded `HOST`). Nothing listens on a
  routable interface. With `COCKPIT_SERVE_WEB=1` the page + API are both served from
  that loopback port, so **no nginx, no TLS, no public hostname** is involved.
- The **only** unavoidable outbound traffic is the Copilot model API to GitHub
  (required for the agent to think) — same as any Copilot client. No cockpit content
  is sent anywhere else.
- **Transfer the code privately** (the repo has no git remote on purpose). Use a USB
  drive, an internal share, SSH, or a `git bundle` — never a public host.
- **Never copy secrets or session content** (see §2). Run
  `skill-inbox/scripts/scrub_secrets.py` over anything you do hand-carry.

---

## 2. What moves, what regenerates, what stays behind

| Carry (machine persona) | Regenerate on the new box | Leave behind (exclude) |
|---|---|---|
| `cockpit` repo (this code) | All Copilot/GitHub auth (re-login) | `session-store.db`, `session-state/`, `cockpit-uploads/` (session content) |
| `~/.copilot/skills/` (generic skills) | A fresh **commander** session + its hooks/schedules (§7) | Domain skills: `crypto-*`, `options-covered-call`, `ledger-reconstruction` |
| `~/.copilot/flows/` generic flows + gates (§7) | `cockpit-prefs.json` **fresh** (sessions start empty) | Domain flows: `binance-review`, `ledger-sync-flow`; domain MCPs: `binance`, `onchain-data` |
| `~/.copilot/mcp-config.json` (generic servers only) | `vapid.json`, Azure speech, nginx cookie/htpasswd — **not needed** local-only | The old machine's session UUIDs in prefs (`mcpBySession`, `welcomedSessions`, …) |

`cockpit-prefs.json` is **mixed**: its `hooks` / `flowSchedules` are butler persona
(recreate them in §7, rebound to the *new* commander session id), but
`mcpBySession` / `skillsDisabledBySession` / `trashed` / `pinnedSessions` /
`welcomedSessions` / `spawnedBySession` / `scheduledSessions` are session content —
**start them empty**. Do not copy prefs wholesale.

---

## 3. Prerequisites on the new machine

- **Node ≥ 23.4** (the repo runs the server/core via `tsx` directly from source; only
  `apps/mcp` and `apps/web` build to `dist/`). 23.4 is the floor because the butler's
  distillation scanner (`scan_heuristic.mjs`) reads the session store through the
  built-in `node:sqlite` module, which is **flagless from 23.4** (on Node 22.5–23.3 it
  runs only with `--experimental-sqlite`; Node 25 — what the source box runs — is
  flagless, emitting one `ExperimentalWarning` to stderr only). On Windows, `homedir()`
  resolves to `%USERPROFILE%` automatically — no `HOME` needed.
- **pnpm** (`npm i -g pnpm`).
- **git** on `PATH` — several butler gates shell out to it.
- **Python 3** is **not** required for the butler itself. The whole runtime loop — all 9
  generic gates + the skill-inbox distillation pipeline + its deepest deps
  (`scan_heuristic`, `mcp_health`) — is now **Node-only `.mjs`**. Python is needed
  **only** for the skill-*authoring* path (skill-creator's eval toolchain
  `quick_validate.py` / `run_eval.py` / …, and skill-monitor's `skill_usage.py` /
  `ask_rate.py`); those never run on the live butler loop and can be added later if you
  author skills on this box.
- A logged-in Copilot/GitHub session (run the Copilot CLI once and authenticate, or
  have `gh auth login` done — `bootstrap.ts` falls back to `gh auth token`).

---

## 4. Transfer the code (privately)

On the source machine:

```bash
cd ~/cockpit
git bundle create /tmp/cockpit.bundle --all      # one file, whole history
```

Carry `cockpit.bundle` over a private channel. On the new machine:

```bash
git clone /path/to/cockpit.bundle cockpit
cd cockpit
```

(`apps/web/dist` is git-ignored — you rebuild it in §5, so nothing stale travels.)

---

## 5. Install and build

```bash
pnpm install
pnpm --filter @cockpit/web build      # produces apps/web/dist (served in §6)
pnpm --filter @cockpit/mcp build      # produces apps/mcp/dist (the cockpit MCP)
pnpm -r build                         # optional: typecheck every package
```

---

## 6. Run (single process, loopback)

```bash
pnpm start        # = node scripts/start.mjs
```

`scripts/start.mjs` runs the same server entry systemd uses, but with
`COCKPIT_SERVE_WEB=1` so the one process serves **both** the SPA and the API. Open
**http://127.0.0.1:8771**. Deep links (`/session/<id>`) work via the SPA fallback.

Environment knobs (all optional; set before `pnpm start`):

| Var | Default | Purpose |
|---|---|---|
| `COCKPIT_PORT` | `8771` | Listen port |
| `COCKPIT_HOME` | `~/.copilot` | **Single knob** to relocate the whole state root (prefs, flows, sessions, uploads) |
| `COCKPIT_SERVE_WEB` | `1` (via launcher) | Serve the SPA from the server; unset/`0` = API only (the nginx-fronted mode) |
| `COCKPIT_WEB_DIR` | `apps/web/dist` | Built SPA location |
| `COCKPIT_FLOWS_DIR` | `<COCKPIT_HOME>/flows` | Flow definitions + gate scripts |
| `COCKPIT_SKILL_INBOX` | `<COCKPIT_HOME>/skill-inbox` | Distillation pipeline root (driver/scripts the `.mjs` gates call) |
| `COCKPIT_SKILLS_DIR` | `<COCKPIT_HOME>/skills` | Skills root (`scan_heuristic.mjs` / `mcp_health.mjs` live here) |
| `COCKPIT_SESSION_DB` | `<COCKPIT_HOME>/session-store.db` | SQLite the scanner reads (read-only, via `node:sqlite`) |
| `COCKPIT_PYTHON` | `python` (Win) / `python3` | Fallback interpreter — used only if a legacy `.py` gate/script is kept instead of its `.mjs` twin |

Verify: `curl http://127.0.0.1:8771/health` → `{"ok":true,"login":"<you>"}`.

---

## 7. First-boot: bring up the generic butler

The butler is hosted **inside a session** (the commander) plus a set of flows, gate
scripts, hooks, and schedules. On a fresh box none of those exist yet — recreate
them, **rebound to the new commander session id** (the old machine's UUIDs are
meaningless here).

**a. Create the commander session** in the web UI (cwd = the `cockpit` repo). Send it
one message so it materializes, then copy its session id from the info panel.

**b. Lay down the generic flows + gates** into `<COCKPIT_HOME>/flows/`. The 8 butler
flows + their `*-gate.mjs` + `_gatelib.mjs` are versioned under
`skill-inbox/butler/flows/` — copy them across. `review-master` ships separately,
**beside its skill** at `skills/review-master/flows/` (copy both files into the flows
dir and rebind the two abs paths — see that dir's README). Keep the generic set, drop
the domain set:

- keep: `welcome`, `patrol`, `harvest`, `build`, `flow-review`, `library-steward`,
  `meta-review`, `watchdog` (and optionally `review-master` for generic code review).
- drop: `binance-review`, `ledger-sync-flow`.

**Gate interpreter convention (the portability point).** `runGate` launches a gate
**by file extension**, not by shebang:

- `*.js` / `*.mjs` / `*.cjs` → the **Node** binary (works on every OS, **no extra
  runtime**). **This is what ships** — all 9 generic gates are `*-gate.mjs`.
- `*.py` → Python (`COCKPIT_PYTHON`) — legacy fallback only.
- `*.sh` / extension-less → spawned directly (POSIX shebang) — **does not work on
  Windows**.

The gates *and* the distillation pipeline they call were migrated to Node-only `.mjs`,
so **nothing needs converting on the new machine** — copy the `.mjs` gates as-is and
they run on Linux, macOS and Windows with only Node. The gate contract is
interpreter-agnostic: read the event from `COCKPIT_EVENT` (env) / stdin, `exit 0` = GO,
stdout JSON → `{gate.*}` params. (The old `.sh`/`.py` twins still sit beside the `.mjs`
in the source repos as a burn-in fallback; you don't need to carry them.)

> **Dependency note for harvest/build.** Those two gates drive
> `<COCKPIT_SKILL_INBOX>/driver/decide.mjs` → `session-distillation/scripts/
> scan_heuristic.mjs`, which reads the session store via `node:sqlite` (hence the
> **Node ≥ 23.4** floor in §3). The full self-improving butler therefore means carrying
> the `skill-inbox` tree too — but **no Python**. For the *lighter* butler
> (welcome / patrol / watchdog / flow-review / meta-review / library-steward) without
> the auto-distillation loop, omit `harvest`/`build` and skip `skill-inbox`.

**c. Register the triggers against the new commander id** (use the cockpit MCP tools
from the commander session, or the loopback intents):

- the welcome hook: `event = session.first-turn-complete`, `flow = welcome-flow`,
  `owner = <new commander id>`, `once = true`.
- the boot→watchdog hook: `event = engine.boot-complete`, `flow = watchdog-flow`.
- the trashed→harvest hook (if keeping harvest): `event = session.trashed`,
  `flow = harvest-flow`, `owner = <new commander id>`.
- the steady-state schedules (server-level flow schedules), e.g. watchdog daily,
  patrol daily, build 6h backstop, harvest daily, steward weekly — mirror
  `~/.copilot/skill-inbox/butler/expected-triggers.json` but with the **new** ids.

**d. Mirror the baseline.** Recreate `expected-triggers.json` for the new machine so
the watchdog knows what to guard. Exclude any domain flows from its scope (they carry
a `_domain_flows_note`).

---

## 8. Keep it running (replaces systemd)

cockpit must stay up across logout/reboot. There is no systemd on Windows; pick one:

- **Windows Task Scheduler** — “At log on” (or “At startup”, run whether logged on or
  not) → `Program: node`, `Arguments: scripts\start.mjs`, `Start in: <repo>`.
- **NSSM** (a tiny service wrapper) — `nssm install cockpit node <repo>\scripts\start.mjs`.
- A terminal you leave open (dev only).

On Linux/macOS the same `pnpm start` works under systemd, launchd, `pm2`, or `tmux`.

**Graceful redeploy** (any OS): never hard-kill. `POST /admin/restart` arms a restart
that fires once all turns go idle; your supervisor (Task Scheduler “restart on exit”,
NSSM, systemd `Restart=always`) brings it back. The engine replays history on start,
and any scheduled session is auto-reloaded.

---

## 9. Smoke test

1. `curl http://127.0.0.1:8771/health` → `{"ok":true,...}`.
2. Open the UI, create a session, send a message — confirm the welcome flow fires
   (the commander gets a welcome worker), proving hooks + gate execution work.
3. `POST /admin/restart` once idle; confirm it comes back (new PID) and the
   `engine.boot-complete` → watchdog hook fires.
