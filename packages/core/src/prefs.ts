// Cockpit owns only UI preferences and durable attention. Native MCP/skill
// settings, including opaque legacy copies in this file, are never replayed.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Attention } from '@cockpit/protocol';
import { applySeen } from './attention.ts';
import { copilotPath } from './paths.ts';

// Reports durability problems in addition to throwing on failed reads/writes.
export type PrefsLogger = (msg: string) => void;

export interface TrashedMark { at: string; reason?: string }

export interface InboxEntry {
  attention: Attention | null;
  attnId: number;
  seenId: number;
  eventId?: string;
}

export interface Inbox {
  revision: number;
  counter: number;
  sessions: Record<string, InboxEntry>;
}

export interface CockpitPrefs {
  trashed: Record<string, TrashedMark>;
  // A UI mark, not a keep-loaded directive.
  pinnedSessions: string[];
  inbox: Inbox;
}

// Unknown fields are carried through saves without becoming supported preferences.
type StoredPrefs = CockpitPrefs & Record<string, unknown>;

const PREFS_FILE = copilotPath('cockpit-prefs.json');

function emptyInbox(): Inbox {
  return { revision: 0, counter: 0, sessions: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateInbox(value: unknown): asserts value is Inbox {
  if (!isRecord(value) || !isId(value.revision) || !isId(value.counter) ||
      value.revision < value.counter || !isRecord(value.sessions)) {
    throw new Error('Invalid inbox: expected monotonic revision/counter and session records');
  }
  for (const entry of Object.values(value.sessions)) {
    if (!isRecord(entry) || !isId(entry.attnId) || !isId(entry.seenId) ||
        entry.attnId > value.counter || entry.seenId > entry.attnId ||
        ![null, 'ready', 'choice'].includes(entry.attention as Attention | null) ||
        (entry.attention !== null && entry.attnId === 0) ||
        (Object.hasOwn(entry, 'eventId') && typeof entry.eventId !== 'string')) {
      throw new Error('Invalid inbox: inconsistent session attention/IDs');
    }
  }
}

function nextInboxId(id: number): number {
  if (id === Number.MAX_SAFE_INTEGER) throw new Error('Inbox ID space exhausted');
  return id + 1;
}

function empty(): StoredPrefs {
  return {
    trashed: {}, pinnedSessions: [], inbox: emptyInbox(),
  };
}

export class Prefs {
  private data: StoredPrefs;
  private readonly file: string;
  private readonly log: PrefsLogger;

  // `file` is injectable for tests; defaults to ~/.copilot/cockpit-prefs.json.
  // `log` surfaces durability failures; failed saves also throw to their caller.
  constructor(file: string = PREFS_FILE, log: PrefsLogger = (m) => console.error(m)) {
    this.file = file;
    this.log = log;
    this.data = this.load();
  }

  private load(): StoredPrefs {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      this.log(`cockpit-prefs.json load FAILED: ${(e as Error).message}`);
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Preferences must be a JSON object');
      }
    } catch (e) {
      // Moving the file aside would make the next startup reset durable IDs.
      this.log(`cockpit-prefs.json is CORRUPT — refusing to reset; original bytes unchanged: ${(e as Error).message}`);
      throw e;
    }
    const inbox = Object.hasOwn(parsed, 'inbox') ? parsed.inbox : emptyInbox();
    try {
      validateInbox(inbox);
    } catch (e) {
      // Invalid metadata must never reset monotonic IDs.
      this.log(`cockpit-prefs.json load FAILED — refusing to reset inbox: ${(e as Error).message}`);
      throw e;
    }
    return {
      ...parsed,
      trashed: parsed.trashed ?? {},
      pinnedSessions: Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions : [],
      inbox,
    };
  }

  private save(update: Partial<CockpitPrefs>): void {
    // Atomic write: serialize to a sibling .tmp, then rename it over the live
    // file. rename(2) is atomic on the same filesystem, so a crash / power loss /
    // ENOSPC mid-write can never truncate the live prefs — a reader either sees
    // the whole old file or the whole new one, never a partial document.
    const next = { ...this.data, ...update };
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`cockpit-prefs.json save FAILED — in-memory preferences are unchanged: ${(e as Error).message}`);
      throw e;
    }
    this.data = next;
  }

  // ── Durable inbox ──────────────────────────────────────────────────────────
  get inbox(): Inbox { return structuredClone(this.data.inbox); }

  setAttention(sessionId: string, attention: Attention | null, eventId?: string): boolean {
    const inbox = this.data.inbox;
    const current = Object.hasOwn(inbox.sessions, sessionId) ? inbox.sessions[sessionId] : undefined;
    let entry: InboxEntry;
    let counter = inbox.counter;
    if (attention === null) {
      if (!current || current.attention === null) return false;
      entry = { ...current, attention: null };
    } else {
      if (eventId !== undefined ? current?.eventId === eventId : current?.attention === attention) return false;
      counter = nextInboxId(counter);
      entry = { ...current, attention, attnId: counter, seenId: current?.seenId ?? 0 };
      if (eventId === undefined) delete entry.eventId;
      else entry.eventId = eventId;
    }
    this.save({ inbox: {
      ...inbox, revision: nextInboxId(inbox.revision), counter,
      sessions: { ...inbox.sessions, [sessionId]: entry },
    } });
    return true;
  }

  markSeen(sessionId: string, observedId?: number): boolean {
    const inbox = this.data.inbox;
    const current = Object.hasOwn(inbox.sessions, sessionId) ? inbox.sessions[sessionId] : undefined;
    if (!current) return false;
    const observed = observedId ?? current.attnId;
    if (!isId(observed)) return false;
    const { seenId, attention } = applySeen(current, observed);
    if (seenId <= current.seenId) return false;
    this.save({ inbox: {
      ...inbox, revision: nextInboxId(inbox.revision),
      sessions: { ...inbox.sessions, [sessionId]: { ...current, attention, seenId } },
    } });
    return true;
  }

  // Engine startup only: persisted choices have no surviving decision callbacks.
  reconcileInboxChoices(): boolean {
    const inbox = this.data.inbox;
    if (!Object.values(inbox.sessions).some((entry) => entry.attention === 'choice')) return false;
    const sessions = Object.fromEntries(Object.entries(inbox.sessions).map(([id, entry]) => [
      id, entry.attention === 'choice' ? { ...entry, attention: null } : entry,
    ]));
    this.save({ inbox: { ...inbox, revision: nextInboxId(inbox.revision), sessions } });
    return true;
  }

  private inboxWithoutSession(sessionId: string): Inbox {
    const inbox = this.data.inbox;
    if (!Object.hasOwn(inbox.sessions, sessionId)) return inbox;
    const sessions = { ...inbox.sessions };
    delete sessions[sessionId];
    return { ...inbox, revision: nextInboxId(inbox.revision), sessions };
  }

  // ── Trash (soft delete) ──────────────────────────────────────────────────────
  trashSession(sessionId: string, reason?: string): void {
    this.save({
      trashed: {
        ...this.data.trashed,
        [sessionId]: { at: new Date().toISOString(), ...(reason ? { reason } : {}) },
      },
      inbox: this.inboxWithoutSession(sessionId),
    });
  }

  restoreSession(sessionId: string): void {
    const trashed = { ...this.data.trashed };
    delete trashed[sessionId];
    this.save({ trashed });
  }

  isTrashed(sessionId: string): boolean {
    return sessionId in this.data.trashed;
  }

  // The set of trashed session ids (for filtering the main list).
  trashedIds(): Set<string> {
    return new Set(Object.keys(this.data.trashed));
  }

  // Full trash entries: id + mark. Title/cwd are joined in by the engine.
  trashedEntries(): Array<{ sessionId: string } & TrashedMark> {
    return Object.entries(this.data.trashed).map(([sessionId, mark]) => ({ sessionId, ...mark }));
  }

  // ── Pinned ──────────────────────────────────────────────────────────────────
  isPinned(sessionId: string): boolean {
    return this.data.pinnedSessions.includes(sessionId);
  }

  pinnedIds(): Set<string> {
    return new Set(this.data.pinnedSessions);
  }

  setPinned(sessionId: string, pinned: boolean): void {
    const set = new Set(this.data.pinnedSessions);
    if (pinned) set.add(sessionId); else set.delete(sessionId);
    this.save({ pinnedSessions: [...set] });
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────
  forgetSession(sessionId: string): void {
    const trashed = { ...this.data.trashed };
    delete trashed[sessionId];
    this.save({
      trashed,
      pinnedSessions: this.data.pinnedSessions.filter((id) => id !== sessionId),
      inbox: this.inboxWithoutSession(sessionId),
    });
  }
}
