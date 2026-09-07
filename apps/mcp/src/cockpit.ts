import { COCKPIT_URL, requestTimeoutMs } from './config.js';

// Thrown when cockpit's backend is unreachable or an intent fails. Carries an
// actionable message the agent can surface verbatim.
export class CockpitError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'connection' | 'backend' | 'protocol' = 'backend',
    readonly intentName?: string,
  ) {
    super(message);
    this.name = 'CockpitError';
  }
}

interface IntentError {
  error?: string;
}

// POST a validated intent to cockpit and return its JSON result. cockpit replies
// `{ error }` with a 4xx on failure; we translate that into a CockpitError.
export async function intent<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${COCKPIT_URL}/intent/${name}`;
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs(name);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`cockpit intent "${name}" timed out`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Keep the same deadline through body consumption. Clearing it after headers
    // allowed a stalled response body to hang an MCP tool forever.
    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new CockpitError(
          `cockpit intent "${name}" returned invalid JSON (HTTP ${res.status})`,
          'protocol',
          name,
        );
      }
    }

    if (!res.ok) {
      const msg = (data as IntentError)?.error ?? `HTTP ${res.status}`;
      throw new CockpitError(`cockpit intent "${name}" failed: ${msg}`, 'backend', name);
    }
    return data as T;
  } catch (e) {
    if (e instanceof CockpitError) throw e;
    if (timedOut || controller.signal.reason instanceof DOMException
      && controller.signal.reason.name === 'TimeoutError') {
      throw new CockpitError(
        `cockpit intent "${name}" timed out after ${timeoutMs}ms waiting for ${COCKPIT_URL}; `
          + 'the backend may still be processing it and no retry was attempted.',
        'timeout',
        name,
      );
    }
    const reason = errorChain(e);
    throw new CockpitError(
      `Cannot connect to the cockpit backend at ${COCKPIT_URL} (${reason}). `
        + 'Confirm the cockpit-server process is listening or set COCKPIT_URL / COCKPIT_PORT.',
      'connection',
      name,
    );
  } finally {
    clearTimeout(timer);
  }
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ') || 'unknown connection error';
}
