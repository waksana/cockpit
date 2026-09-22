import type { DraftPurpose } from '@cockpit/module-api';
import { browserDraftStorage, draftIdentity, draftRecord, SessionDraft, type DraftStorage } from './textDraft';
import { describeReason, reportUxError } from './errorReporter';

export interface NativeDraftDecisions {
  loaded?: boolean;
  ask?: { requestId: string; question?: string; choices?: readonly string[] } | null;
  planRequest?: { requestId: string } | null;
  elicitation?: { requestId: string } | null;
}
type DecisionPurpose = Exclude<DraftPurpose, { kind: 'prompt' }>;
interface Occurrence { id: string; retired: boolean }
const decisionKey = (purpose: DecisionPurpose) => JSON.stringify([purpose.kind, purpose.requestId]);
export function draftPurposes(decisions: NativeDraftDecisions): DecisionPurpose[] {
  return [
    ...(decisions.ask ? [{ kind: 'ask' as const, requestId: decisions.ask.requestId }] : []),
    ...(decisions.planRequest ? [{ kind: 'plan' as const, requestId: decisions.planRequest.requestId }] : []),
    ...(decisions.elicitation ? [{ kind: 'elicitation' as const, requestId: decisions.elicitation.requestId }] : []),
  ];
}

export class DraftSession {
  private readonly requests = new Map<string, { occurrence: string; draft: SessionDraft }>();
  private readonly listeners = new Set<() => void>();
  private live = new Set<string>();
  private selected: SessionDraft;
  private revision = 0;
  private occurrences: Record<string, Occurrence> = {};
  private error?: unknown;
  private readonly key: string;
  readonly prompt: SessionDraft;
  private readonly storage?: DraftStorage;
  constructor(prompt: SessionDraft, storage?: DraftStorage) {
    this.prompt = prompt;
    this.storage = storage;
    this.selected = prompt;
    this.key = `cockpit:draft-requests:${prompt.sessionId}`;
    prompt.subscribe(this.notify);
    try {
      const bytes = storage?.getItem(this.key);
      if (bytes === null || bytes === undefined) return;
      const parsed: unknown = JSON.parse(bytes);
      if (!draftRecord(parsed) || Object.values(parsed).some(value => !draftRecord(value)
        || typeof value.id !== 'string' || !value.id || typeof value.retired !== 'boolean')) {
        throw new Error('Invalid native decision draft index');
      }
      this.occurrences = parsed as Record<string, Occurrence>;
    } catch (error) { this.error = error; this.report(error); }
  }
  private report(error: unknown): void { reportUxError(`请求草稿未确认：${describeReason(error, false)}`); }
  private notify = (): void => {
    this.revision++;
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener();
  };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): number => this.revision;
  hasUnpersistedChanges(): boolean {
    return this.prompt.hasUnpersistedChanges()
      || [...this.requests.values()].some(({ draft }) => draft.hasUnpersistedChanges());
  }
  candidate(purpose: DraftPurpose): SessionDraft {
    if (purpose.kind === 'prompt') return this.prompt;
    const key = decisionKey(purpose);
    const existing = this.requests.get(key);
    if (this.prompt.isRetired()) {
      if (existing) return existing.draft;
      throw new Error('This draft session has retired');
    }
    if (existing && !existing.draft.isRetired()) return existing.draft;
    const previous = this.occurrences[key];
    const occurrence = previous && !previous.retired && !this.error ? previous.id : draftIdentity();
    const storageKey = `cockpit:decision-draft:${JSON.stringify([this.prompt.sessionId, purpose.kind, purpose.requestId, occurrence])}`;
    const draft = new SessionDraft(this.prompt.sessionId, this.storage, purpose, storageKey);
    this.requests.set(key, { occurrence, draft });
    draft.subscribe(this.notify);
    return draft;
  }
  current(decisions: NativeDraftDecisions, authoritative = true): SessionDraft {
    if (this.prompt.isRetired()) return this.selected;
    if ((!authoritative || decisions.loaded === false) && this.selected.reference.purpose.kind !== 'prompt') return this.selected;
    return this.candidate(draftPurposes(decisions)[0] ?? { kind: 'prompt' });
  }
  synchronize(decisions: NativeDraftDecisions, authoritative = true): void {
    if (this.prompt.isRetired()) return;
    if (!authoritative || decisions.loaded === false) {
      for (const { draft } of this.requests.values()) draft.setAskContext();
      return;
    }
    const purposes = draftPurposes(decisions);
    const live = new Set(purposes.map(decisionKey));
    const selected = this.candidate(purposes[0] ?? { kind: 'prompt' });
    const next = { ...this.occurrences };
    for (const [key, value] of Object.entries(next)) if (!live.has(key) && !value.retired) next[key] = { ...value, retired: true };
    for (const purpose of purposes) {
      const draft = this.candidate(purpose);
      const key = decisionKey(purpose);
      next[key] = { id: this.requests.get(key)!.occurrence, retired: draft.isRetired() };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.occurrences);
    if (changed && !this.error) {
      try { this.storage?.setItem(this.key, JSON.stringify(next)); }
      catch (error) { this.error = error; this.report(error); }
    }
    this.occurrences = next;
    const selectionChanged = this.selected !== selected || [...this.live].join() !== [...live].join();
    const ended = [...this.requests].filter(([key]) => !live.has(key)).map(([, value]) => value.draft);
    const releases = [...this.requests.values()].map(({ draft }) => draft.deferNotifications());
    try {
      this.live = live;
      this.selected = selected;
      for (const draft of ended) draft.retire();
      if (decisions.ask) {
        const ask = decisions.ask;
        this.candidate({ kind: 'ask', requestId: ask.requestId }).setAskContext(
          typeof ask.question === 'string' ? { question: ask.question, choices: ask.choices } : undefined,
        );
      }
    } finally {
      for (const release of releases) release();
    }
    if (changed || selectionChanged) this.notify();
  }
  retire(): void {
    if (this.prompt.isRetired()) return;
    const drafts = [this.prompt, ...[...this.requests.values()].map(value => value.draft)];
    const releases = drafts.map(draft => draft.deferNotifications());
    try {
      const next = Object.fromEntries(Object.entries(this.occurrences).map(([key, value]) => [key, { ...value, retired: true }]));
      if (!this.error) {
        try { this.storage?.setItem(this.key, JSON.stringify(next)); }
        catch (error) { this.error = error; this.report(error); }
      }
      this.occurrences = next;
      for (const draft of drafts) draft.retire();
    } finally {
      for (const release of releases) release();
    }
  }
  // The storage index governs restoration, not authority over the current native request.
  isCurrent(draft: SessionDraft): boolean {
    return !draft.isRetired() && this.selected === draft;
  }
  isLive(draft: SessionDraft): boolean {
    const purpose = draft.reference.purpose;
    return !draft.isRetired() && (purpose.kind === 'prompt'
      ? this.selected === draft : this.live.has(decisionKey(purpose)) && this.requests.get(decisionKey(purpose))?.draft === draft);
  }
}

export class DraftCache {
  private readonly sessions = new Map<string, DraftSession>();
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions = new Map<string, () => void>();
  private notify = (): void => { for (const listener of this.listeners) listener(); };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  hasUnpersistedChanges = (): boolean => [...this.sessions.values()].some(session => session.hasUnpersistedChanges());
  private readonly storage?: DraftStorage;
  constructor(storage?: DraftStorage) {
    this.storage = storage;
  }
  prompt(sessionId: string): SessionDraft { return this.session(sessionId).prompt; }
  session(sessionId: string): DraftSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new DraftSession(new SessionDraft(sessionId, this.storage), this.storage);
      this.sessions.set(sessionId, session);
      this.subscriptions.set(sessionId, session.subscribe(this.notify));
      this.notify();
    }
    return session;
  }
  retire(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    session?.retire();
    this.subscriptions.get(sessionId)?.();
    this.subscriptions.delete(sessionId);
    this.notify();
  }
  observe(sessions: readonly (NativeDraftDecisions & { sessionId: string })[], authoritative: boolean): void {
    for (const [id, cached] of [...this.sessions]) {
      const session = sessions.find(value => value.sessionId === id);
      if (!authoritative) {
        cached.synchronize({}, false);
      } else if (session) {
        cached.synchronize(session);
      } else {
        this.retire(id);
      }
    }
  }
}

let browserCache: DraftCache | undefined;
function cache() { return browserCache ??= new DraftCache(browserDraftStorage()); }
export const getSessionDraft = (sessionId: string): SessionDraft => cache().prompt(sessionId);
export const hasUnpersistedDraftChanges = (): boolean => browserCache?.hasUnpersistedChanges() ?? false;
export const subscribeDraftChanges = (listener: () => void): (() => void) => cache().subscribe(listener);
export const getDraftSession = (sessionId: string): DraftSession => cache().session(sessionId);
export const retireDraftSession = (sessionId: string): void => browserCache?.retire(sessionId);
export function observeDraftDecisions(sessions: readonly (NativeDraftDecisions & { sessionId: string })[], authoritative: boolean): void {
  browserCache?.observe(sessions, authoritative);
}
