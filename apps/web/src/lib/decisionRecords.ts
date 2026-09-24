import { useSyncExternalStore } from 'react';
import type { ChatMessage } from '../net/types';

export type ElicitationAction = 'accept' | 'decline' | 'cancel';
// Native history keeps no elicitation answer. This browser-tab record only lets
// the transcript show that a request was handled; the chosen action is not persisted.
export interface ElicitationRecord {
  requestId: string;
  message: string;
  source?: string;
  anchor: string | null;
  timestamp: number;
  action?: ElicitationAction;
}

const LIMIT = 20;
const EMPTY: readonly ElicitationRecord[] = [];
const records = new Map<string, readonly ElicitationRecord[]>();
const listeners = new Set<() => void>();
const storageKey = (sessionId: string) => `cockpit:elicitation-records:${sessionId}`;

function storage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

function valid(value: unknown): value is ElicitationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.requestId === 'string' && typeof record.message === 'string' && typeof record.timestamp === 'number'
    && (record.anchor === null || typeof record.anchor === 'string')
    && (record.source === undefined || typeof record.source === 'string');
}

export function elicitationRecords(sessionId: string): readonly ElicitationRecord[] {
  const known = records.get(sessionId);
  if (known) return known;
  let restored: readonly ElicitationRecord[] = EMPTY;
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(storageKey(sessionId)) ?? '[]');
    if (Array.isArray(parsed)) restored = parsed.filter(valid).map(({ action: _action, ...record }) => record);
  } catch { /* An unreadable record only loses the handled marker. */ }
  records.set(sessionId, restored);
  return restored;
}

export function recordElicitation(sessionId: string, record: ElicitationRecord): void {
  const next = [...elicitationRecords(sessionId).filter(value => value.requestId !== record.requestId), record].slice(-LIMIT);
  records.set(sessionId, next);
  try {
    storage()?.setItem(storageKey(sessionId), JSON.stringify(next.map(({ action: _action, ...value }) => value)));
  } catch { /* Kept for this page only. */ }
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useElicitationRecords(sessionId: string): readonly ElicitationRecord[] {
  return useSyncExternalStore(subscribe, () => elicitationRecords(sessionId), () => EMPTY);
}

export const elicitationRecordId = (requestId: string) => `elicitation-${requestId}`;

// Place each record after the message that was last when it was answered.
export function withElicitationRecords(messages: ChatMessage[], list: readonly ElicitationRecord[]): ChatMessage[] {
  if (!list.length) return messages;
  const after = new Map<string | null, ChatMessage[]>();
  for (const record of list) {
    const message: ChatMessage = { id: elicitationRecordId(record.requestId), role: 'user', subtype: 'elicitation-reply',
      content: record.message, timestamp: record.timestamp };
    after.set(record.anchor, [...after.get(record.anchor) ?? [], message]);
  }
  const known = new Set(messages.map(message => message.id));
  if (![...after.keys()].some(anchor => anchor === null || known.has(anchor))) return messages;
  const result = [...after.get(null) ?? []];
  for (const message of messages) result.push(message, ...after.get(message.id) ?? []);
  return result;
}
