// Runtime config. The browser talks to the cockpit server (same origin, proxied
// by nginx): an SSE stream at `/events` for server→client domain events, and
// `POST /intent/*` for client→server intents. TLS + auth terminate upstream.

const DEV = import.meta.env?.DEV;

function override(): string | null {
  try { return localStorage.getItem('cockpit:base-url'); } catch { return null; }
}

// Same origin unless the user explicitly selects another backend. The isolated
// component lab never inherits that override.
export const BASE_URL = DEV && import.meta.env?.COCKPIT_CHAT_LAB === true
  ? '' : override() ?? '';
export const EVENTS_URL = `${BASE_URL}/events`;
export const CHAT_STREAM_URL = `${BASE_URL}/chat/stream`;
export const intentUrl = (name: string): string => `${BASE_URL}/intent/${name}`;
