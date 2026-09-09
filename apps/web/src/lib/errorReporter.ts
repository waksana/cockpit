// Ephemeral, local-only diagnostics. No network, session state, or persistence.
const MAX_LEN = 1500;
const DEDUP_WINDOW_MS = 30_000;
const MAX_NOTIFICATIONS = 3;
const MAX_RECENT = 50;

export interface UxError {
  readonly id: number;
  readonly message: string;
}

let errors: readonly UxError[] = Object.freeze([]);
let nextId = 0;
let publishing = false;
const listeners = new Set<() => void>();
const recent = new Map<string, number>();

export function getUxErrors(): readonly UxError[] {
  return errors;
}

export function subscribeUxErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken observer must not cause another diagnostic or hide other notices.
    }
  }
}

export function dismissUxError(id: number): void {
  if (publishing) return;
  const remaining = errors.filter((error) => error.id !== id);
  if (remaining.length === errors.length) return;
  publishing = true;
  try {
    errors = Object.freeze(remaining);
    notifyListeners();
  } finally {
    publishing = false;
  }
}

// Turn an arbitrary thrown/rejected value into a human-readable string. The naive
// `String(reason)` yields a useless "[object Object]" for anything that isn't an
// Error or primitive (plain rejection objects, DOMException, event-like payloads),
// throwing away every actionable detail. This recovers it:
//  - Error               → message (+ a short stack when includeStack).
//  - string/number/etc.  → String(value).
//  - object              → JSON, or, when JSON is empty/circular (e.g. DOMException
//                          whose message/name are non-enumerable), its message/name,
//                          and as a last resort its constructor name — never a bare
//                          "[object Object]".
export function describeReason(reason: unknown, includeStack = true): string {
  if (reason instanceof Error) {
    if (!includeStack) return reason.message;
    const stack = reason.stack ? `\n${reason.stack.split('\n').slice(0, 4).join('\n')}` : '';
    return `${reason.message}${stack}`;
  }
  if (reason === null || reason === undefined || typeof reason !== 'object') {
    return String(reason);
  }
  const obj = reason as Record<string, unknown>;
  try {
    const json = JSON.stringify(reason);
    if (json && json !== '{}') return json;
  } catch {
    // circular or otherwise non-serializable — fall through to field extraction
  }
  const parts: string[] = [];
  if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
  if (typeof obj.name === 'string' && obj.name) parts.push(`(${obj.name})`);
  if (parts.length) return parts.join(' ');
  const ctor = (obj.constructor && obj.constructor.name) || 'Object';
  return `[${ctor}]`;
}

// Publish a UX/API failure to the console and local notification UI. Never throws.
export function reportUxError(raw: string, { deduplicate = true }: { deduplicate?: boolean } = {}): void {
  if (publishing) return;
  publishing = true;
  try {
    const msg = raw.trim();
    if (!msg) return;
    const message = msg.length > MAX_LEN ? `${msg.slice(0, MAX_LEN)}…（已截断）` : msg;
    const sig = message.replace(/\s+/g, ' ');
    const now = Date.now();
    for (const [key, ts] of recent) {
      if (now - ts >= DEDUP_WINDOW_MS) recent.delete(key);
    }
    if (deduplicate && recent.has(sig)) return;
    if (deduplicate) recent.set(sig, now);
    for (const key of recent.keys()) {
      if (recent.size <= MAX_RECENT) break;
      recent.delete(key);
    }

    errors = Object.freeze([
      ...errors.slice(-(MAX_NOTIFICATIONS - 1)),
      Object.freeze({ id: ++nextId, message }),
    ]);
    try {
      console.error('[cockpit] local error:', message);
    } catch {
      // Console failures must not prevent the visible notification.
    }
    notifyListeners();
  } catch {
    // Diagnostics must never create another uncaught error.
  } finally {
    publishing = false;
  }
}
