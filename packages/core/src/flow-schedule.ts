// flow-schedule.ts — the server-level (engine-global) time-trigger registry that
// fires FLOWS. It is the sibling of the SDK's per-session ScheduleRegistry, but
// lives in the always-on cockpit-server process, so it fires even with ZERO
// sessions loaded. Same timing model as the SDK schedule (interval | cron | at)
// so the mental model is familiar.
//
// This module owns the PURE timing logic (interval parsing + a hand-rolled,
// DST-safe cron next-fire calculator — no third-party cron dependency, per the
// owner's "self-built = trusted" rule) and the registry that arms a single timer.
// The Engine owns the side effect: on a tick it runs the flow (engine.runFlow).

import type { FlowScheduleEntry, InlineScheduleTarget } from '@cockpit/protocol';

// setTimeout caps delays at ~24.8 days (2^31-1 ms); clamp longer waits and re-arm.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MINUTE_MS = 60_000;

// ── Interval parsing ─────────────────────────────────────────────────────────
// Mirror the SDK's relative-interval strings: "10s" / "5m" / "2h" / "1d". Returns
// milliseconds, or null if malformed. Minimum 10s (matches the SDK floor).
export function parseIntervalMs(s: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  const ms = n * unit;
  return ms < 10_000 ? 10_000 : ms;
}

// ── Cron ─────────────────────────────────────────────────────────────────────
// A standard 5-field cron: minute hour day-of-month month day-of-week.
//   *  any           5      a single value
//   a-b range        */n    step over the whole range
//   a,b,c list       a-b/n  step over a range
// day-of-week: 0 or 7 = Sunday. Both DOM and DOW restricted ⇒ either may match
// (standard Vixie-cron OR semantics).
interface CronFields { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function parseField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const stepM = /^(.+?)\/(\d+)$/.exec(part);
    const step = stepM ? Number(stepM[2]) : 1;
    const body = stepM ? stepM[1]! : part;
    if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step in cron field: ${part}`);
    let lo: number, hi: number;
    if (body === '*') { lo = min; hi = max; }
    else {
      const rangeM = /^(\d+)-(\d+)$/.exec(body);
      if (rangeM) { lo = Number(rangeM[1]); hi = Number(rangeM[2]); }
      else { const v = Number(body); if (!Number.isFinite(v)) throw new Error(`bad cron value: ${body}`); lo = hi = v; }
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(cron: string): CronFields {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron must have exactly 5 fields');
  const [fMin, fHour, fDom, fMonth, fDow] = f as [string, string, string, string, string];
  const dow = parseField(fDow, 0, 7);
  if (dow.has(7)) { dow.delete(7); dow.add(0); } // 7 and 0 are both Sunday
  return {
    minute: parseField(fMin, 0, 59),
    hour: parseField(fHour, 0, 23),
    dom: parseField(fDom, 1, 31),
    month: parseField(fMonth, 1, 12),
    dow,
    domStar: fDom.trim() === '*',
    dowStar: fDow.trim() === '*',
  };
}

// The wall-clock fields of an epoch ms in a given IANA tz (DST-correct because we
// always go epoch → tz wall-clock via Intl, never the reverse).
function wallClockInTz(ms: number, tz: string): { minute: number; hour: number; dom: number; month: number; dow: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24
  return { minute: Number(get('minute')), hour, dom: Number(get('day')), month: Number(get('month')), dow: WD[get('weekday')] ?? 0 };
}

function cronMatches(f: CronFields, w: { minute: number; hour: number; dom: number; month: number; dow: number }): boolean {
  if (!f.minute.has(w.minute) || !f.hour.has(w.hour) || !f.month.has(w.month)) return false;
  // DOM/DOW: if both are restricted (not '*'), match either (Vixie OR semantics).
  if (f.domStar && f.dowStar) return true;
  if (f.domStar) return f.dow.has(w.dow);
  if (f.dowStar) return f.dom.has(w.dom);
  return f.dom.has(w.dom) || f.dow.has(w.dow);
}

// The next epoch ms (strictly after `fromMs`) at which the cron fires, evaluated
// in `tz`. Minute resolution. Searches up to ~366 days; returns null if none
// (e.g. an impossible date like Feb 31). DST-safe by construction.
export function cronNextFire(cron: string, fromMs: number, tz = 'UTC'): number | null {
  const fields = parseCron(cron);
  // Start at the next whole minute strictly after fromMs.
  let t = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const horizon = fromMs + 366 * 86_400_000;
  for (; t <= horizon; t += MINUTE_MS) {
    let w;
    try { w = wallClockInTz(t, tz); } catch { return null; } // bad tz
    if (cronMatches(fields, w)) return t;
  }
  return null;
}

// ── Adding: compute an entry's first fire ────────────────────────────────────
// Exactly one ACTION (flowId | target) and exactly one TIMING (interval|cron|at).
export interface AddInput {
  flowId?: string;
  target?: InlineScheduleTarget;
  interval?: string; cron?: string; at?: number; recurring?: boolean; tz?: string; label?: string;
}

// Validate action + timing inputs and compute the initial nextRunAt. Returns the
// entry minus its id (the registry assigns that), or an error string.
export function buildEntry(input: AddInput, now: number): { entry?: Omit<FlowScheduleEntry, 'id'>; error?: string } {
  const actions = [input.flowId, input.target].filter((v) => v !== undefined).length;
  if (actions !== 1) return { error: 'provide exactly one of flowId or target' };
  const kinds = [input.interval, input.cron, input.at].filter((v) => v !== undefined).length;
  if (kinds !== 1) return { error: 'provide exactly one of interval, cron, or at' };
  const base = {
    ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  if (input.interval !== undefined) {
    const ms = parseIntervalMs(input.interval);
    if (ms == null) return { error: `bad interval: ${input.interval}` };
    const recurring = input.recurring ?? true;
    return { entry: { ...base, recurring, intervalMs: ms, nextRunAt: now + ms } };
  }
  if (input.cron !== undefined) {
    const tz = input.tz || 'UTC';
    let next: number | null;
    try { next = cronNextFire(input.cron, now, tz); } catch (e) { return { error: `bad cron: ${(e as Error).message}` }; }
    if (next == null) return { error: 'cron never fires (within a year) or bad timezone' };
    const recurring = input.recurring ?? true;
    return { entry: { ...base, recurring, cron: input.cron, tz, nextRunAt: next } };
  }
  // at: one-shot absolute time.
  const at = input.at!;
  if (!Number.isFinite(at)) return { error: 'bad at timestamp' };
  const recurring = input.recurring ?? false;
  return { entry: { ...base, recurring, at, nextRunAt: at } };
}

// Recompute the next fire after a tick, for a recurring entry. Returns null for a
// one-shot (which the registry then drops). `now` is the tick time.
export function reschedule(entry: FlowScheduleEntry, now: number): number | null {
  if (!entry.recurring) return null;
  if (entry.intervalMs != null) return now + entry.intervalMs;
  if (entry.cron != null) return cronNextFire(entry.cron, now, entry.tz || 'UTC');
  if (entry.at != null) return now + Math.max(entry.at - now, MINUTE_MS); // recurring 'at' is unusual; re-arm a minute out
  return null;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Holds the entries, arms a single timer at the earliest nextRunAt, and on each
// tick fires every due entry then re-arms. Persists through an injected saver so
// schedules survive restart (re-armed on engine.start). `fire` performs the
// entry's action (the engine branches on flowId vs inline target).
export class FlowScheduleRegistry {
  private entries: FlowScheduleEntry[];
  private readonly persist: (entries: FlowScheduleEntry[]) => void;
  private readonly fire: (entry: FlowScheduleEntry) => void;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private armed = false;

  constructor(
    initial: FlowScheduleEntry[],
    persist: (entries: FlowScheduleEntry[]) => void,
    fire: (entry: FlowScheduleEntry) => void,
    log: (msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {
    this.entries = [...initial];
    this.persist = persist;
    this.fire = fire;
    this.log = log;
    for (const e of this.entries) if (e.id > this.seq) this.seq = e.id;
  }

  list(): FlowScheduleEntry[] { return [...this.entries]; }

  // Begin firing (called once at engine.start). Idempotent.
  arm(): void { this.armed = true; this.scheduleNext(); }

  // Stop the timer (e.g. on shutdown). Entries are kept (persisted).
  disarm(): void { this.armed = false; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  add(input: AddInput, now: number = Date.now()): { entry?: FlowScheduleEntry; error?: string } {
    const built = buildEntry(input, now);
    if (built.error || !built.entry) return { error: built.error ?? 'could not build schedule' };
    const entry: FlowScheduleEntry = { ...built.entry, id: ++this.seq };
    this.entries.push(entry);
    this.persist(this.entries);
    this.scheduleNext();
    return { entry };
  }

  stop(id: number): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removed = this.entries.length < before;
    if (removed) { this.persist(this.entries); this.scheduleNext(); }
    return removed;
  }

  // Arm a single timer for the earliest upcoming entry (clamped to setTimeout's max).
  private scheduleNext(): void {
    if (!this.armed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.entries.length === 0) return;
    const now = Date.now();
    const soonest = Math.min(...this.entries.map((e) => e.nextRunAt));
    const delay = Math.max(0, Math.min(soonest - now, MAX_TIMEOUT_MS));
    this.timer = setTimeout(() => this.onTick(), delay);
    this.timer.unref?.();
  }

  // Fire every entry whose time has come; re-arm or drop each; persist; reschedule.
  private onTick(): void {
    const now = Date.now();
    const due = this.entries.filter((e) => e.nextRunAt <= now + 1_000);
    if (due.length === 0) { this.scheduleNext(); return; } // woke early (clamped long wait)
    const drop: number[] = [];
    for (const e of due) {
      try { this.fire(e); } catch (err) { this.log('flow schedule fire failed', { id: e.id, action: e.flowId ?? 'inline', err: String(err) }); }
      const next = reschedule(e, now);
      if (next == null) drop.push(e.id);
      else e.nextRunAt = next;
    }
    if (drop.length) this.entries = this.entries.filter((e) => !drop.includes(e.id));
    this.persist(this.entries);
    this.scheduleNext();
  }
}
