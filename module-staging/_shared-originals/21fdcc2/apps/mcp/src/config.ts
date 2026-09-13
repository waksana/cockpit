// All cockpit data is accessed through this HTTP backend, never local session stores.
export const COCKPIT_URL =
  process.env.COCKPIT_URL ?? `http://127.0.0.1:${process.env.COCKPIT_PORT ?? '8771'}`;
export const COCKPIT_API_TOKEN = process.env.COCKPIT_API_TOKEN;

const configuredTimeout = process.env.COCKPIT_TIMEOUT_MS;
if (configuredTimeout !== undefined && (
  !/^\d+$/.test(configuredTimeout.trim())
  || Number(configuredTimeout) <= 0
  || !Number.isSafeInteger(Number(configuredTimeout))
)) {
  throw new Error(`COCKPIT_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(configuredTimeout)}`);
}

// A single 10s deadline is too short for native session loading.
// Keep bounded reads (including chat pages and mcp/session)
// bounded at 10s, but give known long operations a
// deadline matching their server-side work. COCKPIT_TIMEOUT_MS remains an
// explicit operator override for every request.
export const REQUEST_TIMEOUT_MS = configuredTimeout === undefined ? 10_000 : Number(configuredTimeout);
const LOAD_AWARE_TIMEOUT_MS = 45_000;

const LOAD_AWARE_INTENTS = new Set([
  'prompt',
  'session/new',
  'session/fork',
  'session/plan',
  'session/panels',
  'session/panel',
  'session/reload',
  'session/load',
  'session/compact',
  'session/auto-name',
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
  if (LOAD_AWARE_INTENTS.has(name)) return LOAD_AWARE_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}

// Cap a single tool response so a huge transcript can't blow the agent's context.
export const CHARACTER_LIMIT = 25000;
