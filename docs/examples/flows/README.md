# Butler / Flow examples

Reference Flow definitions for the cockpit Butler/Flow trigger layer (see
[`../../butler.md`](../../butler.md) for the full design and
[`../../../apps/mcp/README.md`](../../../apps/mcp/README.md) for the tools).

These are **examples**, committed here for documentation. Live Flow definitions
are read from `~/.copilot/flows/*.json` (outside this repo — owner config). To use
one, copy it there and make the gate executable:

```sh
mkdir -p ~/.copilot/flows
cp docs/examples/flows/welcome.json        ~/.copilot/flows/
cp docs/examples/flows/welcome-gate.sh     ~/.copilot/flows/
chmod +x ~/.copilot/flows/welcome-gate.sh
```

Then register a hook that drives it (via the cockpit MCP), so a real session
finishing its first turn spawns a one-shot butler-worker that names + outfits it:

```
cockpit_hook_add {
  owner_session: "<butler session id>",   # receiver of record; the flow spawns the worker
  event: "session.first-turn-complete",
  flow_id: "welcome-flow",
  once: true
}
```

R1 holds: the spawned butler-worker is marked `spawnedBy=welcome-flow`, so it is a
non-trigger-source — its own first-turn never re-fires the welcome (no fork bomb).

## `welcome.json` + `welcome-gate.sh`

- **Trigger**: `session.first-turn-complete` (a real session finished its first
  turn with content).
- **Gate**: `welcome-gate.sh` — a cheap, no-LLM cost gate (exit 0 = go, non-zero =
  skip; stdout JSON = interpolation params). The example always goes.
- **Action**: `spawn-session` — a fresh, born-configured worker (a configured
  `title` "迎新 · {event.title}", tight skill set
  `session-outfitter`/`session-distillation`, `cockpit` MCP, autopilot mode)
  whose prompt instructs it to read the source session and rename + outfit it.

Run it manually to debug (without waiting for the event):

```
cockpit_flow_run { flow_id: "welcome-flow", source_session: "<id>", source_cwd: "<cwd>", source_title: "<title>" }
```
