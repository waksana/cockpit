# Historical Butler / Flow examples

These files preserve the retired [Butler design](../../butler.md), not runnable
instructions for the current foundation. Cockpit no longer reads or arms Flow
definitions from `~/.copilot/flows`, and `cockpit_hook_add`, `cockpit_flow_run` and
the corresponding governance intents are not current capabilities. Do not copy
or execute these examples as an installation step.

The current [API/MCP contract](../../../apps/mcp/README.md) exposes explicit
session operations and native per-session timers, not a resident Flow scheduler.
Neither pinning nor native schedules keep a session loaded; idle unload pauses
native timers. No replacement governance service is supplied by these examples.

## `welcome.json` + `welcome-gate.sh`

- **Historical trigger**: `session.first-turn-complete` (a real session finished its first
  turn with content).
- **Historical gate**: `welcome-gate.sh` — a cheap, no-LLM cost gate (exit 0 = go, non-zero =
  skip; stdout JSON = interpolation params). The example always goes.
- **Historical action**: `spawn-session` — a fresh, born-configured worker (a configured
  `title` "迎新 · {event.title}", tight skill set
  `session-outfitter`/`session-distillation`, `cockpit` MCP, autopilot mode)
  whose prompt instructs it to read the source session and rename + outfit it.

The historical R1 `spawnedBy` guard belongs to that retired design. These retained
files do not establish any current trigger, worker-creation or delivery guarantee.
