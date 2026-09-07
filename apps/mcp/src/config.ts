import { homedir } from 'node:os';
import { join } from 'node:path';

// The cockpit state root (default ~/.copilot, overridable as a whole with
// COCKPIT_HOME) — resolved via homedir() so it is correct on every OS. This MCP
// package is deliberately decoupled from @cockpit/core, so it carries its own tiny
// copy of the resolver; the individual paths below keep their finer-grained env
// overrides which take precedence.
export function cockpitHome(): string {
  return process.env.COCKPIT_HOME ?? join(homedir(), '.copilot');
}

// Where cockpit's loopback HTTP intent API lives. Mutations (restore/purge) and the
// authoritative trash enumeration go through here so they use the exact same code path
// the web UI uses — never a hand-edit of session-store.db.
export const COCKPIT_URL =
  process.env.COCKPIT_URL ?? `http://127.0.0.1:${process.env.COCKPIT_PORT ?? '8771'}`;

// The Copilot SDK's session store. Read-only here, only for transcript/metadata reads
// (list_sessions, read_session) that cockpit has no synchronous HTTP path for.
export const SESSION_STORE =
  process.env.COCKPIT_SESSION_STORE ?? join(cockpitHome(), 'session-store.db');

// Where the SDK persists each session's authoritative append-per-event log
// (`<dir>/<sessionId>/events.jsonl`). read_session folds THIS (not the lossy
// `turns` summary table, whose `assistant_response` is frequently NULL) so a
// salvage read never under-reports content.
export const SESSION_STATE_DIR =
  process.env.COCKPIT_SESSION_STATE_DIR ?? join(cockpitHome(), 'session-state');

const configuredTimeout = process.env.COCKPIT_TIMEOUT_MS;
if (configuredTimeout !== undefined && (
  !/^\d+$/.test(configuredTimeout.trim())
  || Number(configuredTimeout) <= 0
  || !Number.isSafeInteger(Number(configuredTimeout))
)) {
  throw new Error(`COCKPIT_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(configuredTimeout)}`);
}

// A single 10s deadline is too short for intents that intentionally materialize
// an SDK session and its stdio MCPs. Keep fast reads (including mcp/session)
// bounded at 10s, but give known load-aware and orchestration operations a
// deadline matching their server-side work. COCKPIT_TIMEOUT_MS remains an
// explicit operator override for every intent.
export const REQUEST_TIMEOUT_MS = configuredTimeout === undefined ? 10_000 : Number(configuredTimeout);
const LOAD_AWARE_TIMEOUT_MS = 45_000;
const ORCHESTRATION_TIMEOUT_MS = 90_000;

const LOAD_AWARE_INTENTS = new Set([
  'prompt',
  'session/new',
  'session/plan',
  'session/panels',
  'session/reload',
  'session/compact',
  'session/rewind',
  'setModel',
  'setMode',
  'mcp/session-toggle',
  'skills/session',
  'skills/session-toggle',
  'skills/global',
  'schedule/add',
  'schedule/list',
  'schedule/stop',
  'mcp/reload-session',
  'mcp/refresh',
]);

export function requestTimeoutMs(name: string): number {
  if (configuredTimeout !== undefined) return REQUEST_TIMEOUT_MS;
  if (name === 'flow/run') return ORCHESTRATION_TIMEOUT_MS;
  if (LOAD_AWARE_INTENTS.has(name)) return LOAD_AWARE_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}

// Cap a single tool response so a huge transcript can't blow the agent's context.
export const CHARACTER_LIMIT = 25000;
