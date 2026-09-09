// Runtime config. The browser talks to the cockpit server (same origin, proxied
// by nginx): an SSE stream at `/events` for server→client domain events, and
// `POST /intent/*` for client→server intents. TLS + auth terminate upstream.

const DEV = import.meta.env?.DEV;

function override(): string | null {
  try { return localStorage.getItem('cockpit:base-url'); } catch { return null; }
}

// Same origin in production; an explicit dev target so `vite dev` can run
// against the deployed server.
export const BASE_URL = override() ?? (DEV ? 'https://acp.rbym47.com' : '');
export const EVENTS_URL = `${BASE_URL}/events`;
export const intentUrl = (name: string): string => `${BASE_URL}/intent/${name}`;
export const uploadUrl = (name: string, mime: string): string =>
  `${BASE_URL}/upload?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`;
