# cockpit MCP server (`@cockpit/mcp`)

A small **stdio** MCP server that lets a designated maintainer session drive cockpit's
**session lifecycle** and **per-session metadata** from inside an agent: scan/salvage/purge the
trash bin, and rename sessions or choose which MCP servers & skills each session runs.

It exposes two powers the cockpit web UI deliberately keeps out of reach: **permanent purge**, and
**programmatic per-session capability control**.

Binary: `cockpit-mcp-server` → `dist/index.js`.

## Why it exists

In cockpit, deleting a session is a *soft* delete: it moves the session to a trash bin
(`~/.copilot/cockpit-prefs.json` → `trashed: { [sessionId]: { at, reason? } }`), hides it from the
list, but keeps the data. The
web UI can **restore** but cannot **purge** — purge is irreversible and must be deliberate. This
MCP server is the purge path, and also wraps cockpit's rename + per-session MCP/skill toggles so an
agent can curate a session's capabilities. Because cockpit enables MCP servers *per session* (off by
default), only the session you explicitly enable `cockpit` on gets these tools — i.e. only the
maintainer gets purge + metadata-control power.

## Tools

**Trash & lifecycle**

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_list_sessions` | read-only | cockpit intent `session/list` (authoritative live list) |
| `cockpit_list_trash` | read-only | cockpit intent `session/trash-list` (authoritative) |
| `cockpit_read_session` | read-only | `events.jsonl` fold when present, else session-store.db (read-only) — transcript turns |
| `cockpit_restore_session` | mutating | cockpit intent `session/restore` |
| `cockpit_purge_session` | **destructive** | cockpit intent `session/purge` (requires `confirm=true`) |

**Per-session metadata control**

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_rename_session` | mutating | cockpit intent `session/rename` |
| `cockpit_list_session_mcp` | read-only | cockpit intent `mcp/session` (never materializes an unloaded session; returns `loaded:false` / `status:"unloaded"`) |
| `cockpit_set_session_mcp` | mutating | cockpit intent `mcp/session-toggle` (bounded server-side; returns target status + operation id, and never persists a failed enable) |
| `cockpit_list_session_skills` | read-only | cockpit intent `skills/session` |
| `cockpit_set_session_skill` | mutating | cockpit intent `skills/session-toggle` |

**Scheduled prompts** (`/every` recurring + `/after` one-shot, per-session)

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_schedule_add` | mutating | cockpit intent `schedule/add` |
| `cockpit_list_schedules` | read-only | cockpit intent `schedule/list` |
| `cockpit_stop_schedule` | destructive | cockpit intent `schedule/stop` |

**Event hooks** (Butler/Flow trigger layer — schedule's sibling, fired by an ecosystem EVENT)

A hook says "when event E fires on any real (non-worker) session, deliver a prompt into the OWNER
(butler) session, carrying the source event's context". Hooks are **engine-global and cross-session**
(one butler reacts to the whole fleet) — cockpit-native, with no SDK analog; they coexist additively
with the per-session schedule registry. v1 event: `session.first-turn-complete`. **R1**: a `spawnedBy`
worker is a non-trigger-source, so its lifecycle never fires a hook (no welcome fork-bomb).

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_hook_add` | mutating | cockpit intent `hook/add` |
| `cockpit_hook_list` | read-only | cockpit intent `hook/list` |
| `cockpit_hook_stop` | destructive | cockpit intent `hook/stop` |

**Flows** (TRIGGER → FLOW → ACTION — the reusable middle layer)

A Flow = an optional cheap **gate** script (deterministic, no LLM — the cost gate) plus an **action**:
`spawn-session` (a fresh, *born-configured* worker — a configured `title`, tight skills/MCP set, model,
mode applied before its first turn, marked `spawnedBy=flowId` per R1) or `prompt-existing` (deliver a
prompt to an existing session). Definitions live in `~/.copilot/flows/*.json`; the maintainer MCP can both
list/run them AND author them (`cockpit_flow_add` / `cockpit_flow_write_gate` / `cockpit_flow_remove`). A
hook points at a `flowId`; the same Flow can be driven by a schedule too. **Gate security:** the gate script runs as a
subprocess; a non-zero exit or a timeout means "skip" (fail-safe, no agent spent). Authoring confines all
writes to the flows dir (path-traversal rejected); the owner accepted agent-authored gate scripts on the
maintainer-only MCP.

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_flow_list` | read-only | cockpit intent `flow/list` |
| `cockpit_flow_run` | mutating | cockpit intent `flow/run` (run gate then action; summon/debug) |
| `cockpit_flow_add` | mutating | cockpit intent `flow/add` (write a flow definition) |
| `cockpit_flow_write_gate` | mutating | cockpit intent `flow/write-gate` (write a gate script) |
| `cockpit_flow_remove` | destructive | cockpit intent `flow/remove` (delete a flow definition) |

**Flow schedules** (server-level time triggers — fire a flow even with 0 sessions loaded)

The engine-global sibling of the per-session schedule: a native trigger in the always-on
cockpit-server that fires a **flow** on a time cadence (interval / cron / at), independent of any
session being loaded. Cron is evaluated by a hand-rolled, DST-safe, timezone-aware calculator (no
third-party cron dependency). Persisted; re-armed on restart.

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_flow_schedule_add` | mutating | cockpit intent `flow-schedule/add` |
| `cockpit_flow_schedule_list` | read-only | cockpit intent `flow-schedule/list` |
| `cockpit_flow_schedule_stop` | destructive | cockpit intent `flow-schedule/stop` |

**Skills maintenance**

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_refresh_skills` | mutating | cockpit intent `skills/refresh` (arms a graceful restart to re-scan `~/.copilot/skills`) |

**Conversation** — drive a session's turn

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_send_prompt` | mutating | cockpit intent `prompt` (default `mode=enqueue`) |
| `cockpit_cancel_turn` | mutating | cockpit intent `cancel` |
| `cockpit_remove_queued` | destructive | cockpit intent `queue/remove` |

**Respond** — unblock a session waiting on the user

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_respond_ask` | mutating | cockpit intent `respondAsk` |
| `cockpit_respond_plan` | mutating | cockpit intent `respondPlan` |
| `cockpit_respond_elicitation` | mutating | cockpit intent `respondElicitation` |

**Settings** — how a session runs

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_set_model` | mutating | cockpit intent `setModel` |
| `cockpit_set_mode` | mutating | cockpit intent `setMode` |
| `cockpit_compact_session` | **destructive** | cockpit intent `session/compact` (requires `confirm=true`) |
| `cockpit_rewind_session` | **destructive** | cockpit intent `session/rewind` (requires `confirm=true`) |

**Lifecycle**

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_new_session` | mutating | cockpit intent `session/new` |
| `cockpit_delete_session` | destructive | cockpit intent `session/delete` (soft, restorable) |
| `cockpit_unload_session` | mutating | cockpit intent `session/unload` |
| `cockpit_reload_session` | mutating | cockpit intent `session/reload` |
| `cockpit_set_session_pin` | mutating | cockpit intent `session/pin` (keep-loaded) |

**Read** — what a person sees

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_get_session` | read-only | cockpit intent `session/get` (full meta incl. queue/ask/plan ids) |
| `cockpit_get_panels` | read-only | cockpit intent `session/panels` |
| `cockpit_get_plan` | read-only | cockpit intent `session/plan` |

**Global config**

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_list_global_mcp` | read-only | cockpit intent `mcp/global` |
| `cockpit_set_global_mcp_default` | mutating | cockpit intent `mcp/global-default` |
| `cockpit_refresh_mcp` | mutating | cockpit intent `mcp/refresh` (re-spawns stdio servers → loads new code, all sessions) |
| `cockpit_reload_session_mcp` | mutating | cockpit intent `mcp/reload-session` (re-spawn one session's MCP processes → load new server code) |
| `cockpit_list_global_skills` | read-only | cockpit intent `skills/global` |

**Files**

| Tool | Kind | Path |
| --- | --- | --- |
| `cockpit_upload_file` | mutating | `POST /upload` (returns `/uploads` URL + attachment marker) |
| `cockpit_list_dir` | read-only | cockpit intent `fs/listDir` |

Tools are split by concern under `src/tools/*.ts` (each exports a `register*Tools(server)` called
from `index.ts`); shared helpers/types live in `src/shared.ts`.

Everything except `cockpit_read_session` goes through cockpit's loopback HTTP intents (the exact
same code path the web UI uses — never a hand-edit of `session-store.db`). Transcript reads prefer
the per-session `events.jsonl` (the authoritative event log) and fall back to `session-store.db`
read-only only when no event log exists, because cockpit has no synchronous HTTP transcript path.

> **Transcript-view caveat.** `cockpit_read_session` now prefers the authoritative `events.jsonl`
> replay, but the default assistant view still preserves a compatibility fallback: when an
> `assistant.message` has empty real content and only tool requests, the reader synthesizes visible
> `【tool】 ...` lines so tool-only incomplete workers do not replay as a blank assistant turn. Pass
> `assistant_view="authoritative_text"` to suppress those synthesized tool summaries and return only
> parent-session real `assistant.message` content plus parent `session.task_complete` summaries;
> sub-agent / child completion echoes are excluded. If the reader falls
> back to the SDK `turns` table (`source: "turns"` in the result), there is no tool-summary synthesis
> to suppress.

## Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `COCKPIT_URL` | `http://127.0.0.1:8771` | cockpit backend base URL |
| `COCKPIT_PORT` | `8771` | used only if `COCKPIT_URL` is unset |
| `COCKPIT_SESSION_STORE` | `~/.copilot/session-store.db` | Copilot SDK session store (read-only) |
| `COCKPIT_TIMEOUT_MS` | unset | positive-integer override for every request; otherwise 10s for routine reads, 45s for load-aware operations, and 90s for `flow/run` |

## Build & register

```sh
pnpm --filter @cockpit/mcp build      # emits dist/
```

Register in `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "cockpit": { "command": "node", "args": ["/home/honglai/cockpit/apps/mcp/dist/index.js"] }
  }
}
```

Then enable the `cockpit` MCP **only** on the maintainer session (cockpit hamburger → MCP →
toggle on). New sessions default it off.

## Workflows

**Salvage-then-purge:**
1. `cockpit_list_trash` — see the salvage queue (title, cwd, when, reason).
2. `cockpit_read_session { session_id }` — read turns; pass `assistant_view:"authoritative_text"`
   when you need only parent-session real assistant text + task-complete summaries, with no
   synthesized `【tool】` fallback lines or child/sub-agent completion echoes.
3. `cockpit_purge_session { session_id, confirm: true }` — irreversibly delete once salvaged.
   (Or `cockpit_restore_session` to put it back.)

**Curate a session's capabilities:**
1. `cockpit_list_sessions` — find the session id (optionally `cockpit_read_session` to understand it).
2. `cockpit_rename_session { session_id, name }` — give it a clear, descriptive title.
3. `cockpit_list_session_skills` / `cockpit_list_session_mcp` — see what's enabled.
4. `cockpit_set_session_skill` / `cockpit_set_session_mcp { enabled }` — turn the right capabilities
   on/off for that session. MCP changes persist only after the SDK reaches the requested live state;
   a target auth/network failure is returned with its operation id/status and remains visible in
   `cockpit_list_session_mcp` while uncancellable SDK cleanup is settling.

Requires Node ≥ 22 (uses built-in `node:sqlite`).
