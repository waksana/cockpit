// UX error reporter. Any uncaught frontend error or API failure is turned into a
// prompt to the CURRENT session ("我在使用中发现了一个错误：…") so the agent can see
// and fix it. The engine auto-queues the prompt when the session is busy.
//
// This module is intentionally standalone (no store/client imports) to avoid an
// import cycle — the store registers a `sink` that performs the actual send.
//
// STORM SAFETY (critical — a self-reporting system must never feed itself):
//  - `sink` excludes the `prompt` intent at the call site, so a failed error
//    report can't trigger another report (the report IS a prompt).
//  - `reporting` guard ignores errors thrown synchronously during a send.
//  - dedup: the same message isn't re-sent within DEDUP_WINDOW_MS.
//  - cooldown: minimum gap between any two sends.
//  - rate cap: at most MAX_PER_WINDOW sends per WINDOW_MS.

const PREFIX = '我在使用中发现了一个错误：';
const MAX_LEN = 1500; // cap the error text so a giant stack can't bloat the prompt
const DEDUP_WINDOW_MS = 30_000;
const COOLDOWN_MS = 4_000;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

// Returns true if the report was actually dispatched (a session was available
// and connected); false otherwise.
type Sink = (promptText: string) => boolean;

let sink: Sink | null = null;
let reporting = false;
let lastSentAt = 0;
const recent = new Map<string, number>(); // signature -> last sent ts
let sentTimes: number[] = [];

export function setErrorReportSink(s: Sink | null): void {
  sink = s;
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

function signature(msg: string): string {
  return msg.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function prune(now: number): void {
  for (const [sig, ts] of recent) if (now - ts > DEDUP_WINDOW_MS) recent.delete(sig);
  sentTimes = sentTimes.filter((t) => now - t < WINDOW_MS);
}

// Report a UX/API error to the current session. Never throws.
export function reportUxError(raw: string): void {
  try {
    if (reporting || !sink) return;
    const msg = (raw ?? '').toString().trim();
    if (!msg) return;
    const now = Date.now();
    if (now - lastSentAt < COOLDOWN_MS) return;
    prune(now);
    const sig = signature(msg);
    if (recent.has(sig)) return;
    if (sentTimes.length >= MAX_PER_WINDOW) return;

    const text = PREFIX + (msg.length > MAX_LEN ? `${msg.slice(0, MAX_LEN)}…（已截断）` : msg);

    reporting = true;
    let dispatched = false;
    try {
      dispatched = sink(text);
    } finally {
      reporting = false;
    }
    if (dispatched) {
      lastSentAt = now;
      recent.set(sig, now);
      sentTimes.push(now);
    }
  } catch {
    // A reporter must never throw — that would be the worst kind of feedback loop.
  }
}
