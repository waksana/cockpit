import { acknowledge } from './draft';
import { describeReason, reportUxError } from './errorReporter';

export interface SessionDraftSnapshot {
  text: string;
  revision: number;
  pending: boolean;
  error?: string;
}
export interface DraftSubmission { text: string; revision: number }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const UNCONFIRMED = '发送失败或结果尚未确认，草稿已保留；重发前请先检查会话。';

function browserStorage(name: 'sessionStorage' | 'localStorage'): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try { return window[name]; }
  catch (error) {
    reportUxError(`${name === 'localStorage' ? '浏览器持久草稿存储' : '标签页草稿恢复存储'}不可用：${describeReason(error, false)}`);
    return undefined;
  }
}

export class SessionDraft {
  private snapshot: SessionDraftSnapshot = { text: '', revision: 0, pending: false };
  private listeners = new Set<() => void>();
  private readonly key: string;
  readonly sessionId: string;
  private readonly storage?: DraftStorage;

  constructor(sessionId: string, storage?: DraftStorage, legacy?: Pick<Storage, 'getItem'>) {
    this.sessionId = sessionId;
    this.storage = storage;
    // The storage adapter owns writes; this original key is only a read-only
    // legacy import in localStorage.
    this.key = `cockpit:native-composer:${sessionId}`;
    try {
      const owned = storage?.getItem(this.key);
      const stored = owned ?? legacy?.getItem(this.key);
      if (stored) {
        const value: unknown = JSON.parse(stored);
        if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
          || !('text' in value) || typeof value.text !== 'string') throw new Error('Invalid text draft');
        this.snapshot.text = value.text;
        if ('pending' in value && value.pending) this.snapshot.error = UNCONFIRMED;
      }
      // Adopt into the current document's own record, including empty imports.
      // This also prevents reload from importing a legacy copy again.
      this.persist();
    } catch (error) { reportUxError(`无法读取原文字草稿；存储内容未修改：${describeReason(error, false)}`); }
  }

  getSnapshot = (): SessionDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private persist() {
    try {
      this.storage?.setItem(this.key, JSON.stringify({
        version: 1, text: this.snapshot.text, pending: this.snapshot.pending || this.snapshot.error === UNCONFIRMED,
      }));
    } catch (error) { reportUxError(`无法保存文字草稿，当前文字仍保留在页面内：${describeReason(error, false)}`); }
  }
  private update(change: Partial<SessionDraftSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.persist();
    for (const listener of this.listeners) listener();
  }
  edit = (text: string) => { this.update({ text, revision: this.snapshot.revision + 1 }); };
  dismissError = () => { this.update({ error: undefined }); };
  runAction = async (send: () => Promise<boolean> | undefined): Promise<boolean> => {
    if (this.snapshot.pending) return false;
    this.update({ pending: true, error: undefined });
    try {
      const sent = await acknowledge(send);
      if (!sent) this.update({ error: UNCONFIRMED });
      return sent;
    } finally { this.update({ pending: false }); }
  };
  captureSubmission = (): DraftSubmission => ({ text: this.snapshot.text, revision: this.snapshot.revision });
  acknowledgeSubmission = (submitted: DraftSubmission) => {
    const current = this.snapshot;
    if (current.revision === submitted.revision && current.text === submitted.text) {
      this.update({ text: '', revision: current.revision + 1 });
    }
  };
  send = (send: (text: string) => Promise<boolean>): Promise<boolean> => {
    const submission = this.captureSubmission();
    if (this.snapshot.pending || !submission.text.trim()) return Promise.resolve(false);
    return this.runAction(async () => {
      const sent = await acknowledge(() => send(submission.text.trim()));
      if (sent) this.acknowledgeSubmission(submission);
      return sent;
    });
  };
}

export function createSessionDrafts(storage?: DraftStorage, legacy?: Pick<Storage, 'getItem'>) {
  const sessions = new Map<string, SessionDraft>();
  return (sessionId: string): SessionDraft => {
    let draft = sessions.get(sessionId);
    if (!draft) { draft = new SessionDraft(sessionId, storage, legacy); sessions.set(sessionId, draft); }
    return draft;
  };
}

export function createDocumentDrafts(owner: string, persistent?: DraftStorage, tab?: DraftStorage) {
  const recordKey = (documentOwner: string, key: string) =>
    `cockpit:native-composer-document:${JSON.stringify([documentOwner, key])}`;
  return createSessionDrafts({
    getItem(key) {
      const stored = tab?.getItem(key);
      if (!stored) return null;
      const pointer: unknown = JSON.parse(stored);
      // The earlier tab-only format remains a valid read-only migration source.
      if (!pointer || typeof pointer !== 'object' || !('version' in pointer) || pointer.version !== 2) return stored;
      if (!('owner' in pointer) || typeof pointer.owner !== 'string'
        || !('draft' in pointer) || typeof pointer.draft !== 'string') throw new Error('Invalid draft owner record');
      if ('saved' in pointer && pointer.saved) {
        try { return persistent?.getItem(recordKey(pointer.owner, key)) ?? pointer.draft; }
        catch (error) { reportUxError(`无法读取持久草稿，已使用标签页副本：${describeReason(error, false)}`); }
      }
      return pointer.draft;
    },
    setItem(key, value) {
      let saved = false;
      try {
        persistent?.setItem(recordKey(owner, key), value);
        saved = !!persistent;
      } catch (error) { reportUxError(`无法持久保存草稿，将尝试保留标签页副本：${describeReason(error, false)}`); }
      try {
        tab?.setItem(key, JSON.stringify({ version: 2, owner, saved, draft: value }));
      } catch (error) { reportUxError(`无法更新草稿恢复指针，刷新可能无法恢复最新文字；当前文字仍在页面内：${describeReason(error, false)}`); }
    },
  }, persistent);
}

let browserDrafts: ReturnType<typeof createSessionDrafts> | undefined;
export const getSessionDraft = (sessionId: string) => {
  if (!browserDrafts) {
    const tab = browserStorage('sessionStorage');
    const persistent = browserStorage('localStorage');
    // Never reuse an owner copied by Duplicate Tab. Each document adopts the
    // tab's saved pointer into a fresh key before its first write; no CAS needed.
    const owner = globalThis.crypto?.randomUUID?.();
    if (owner) browserDrafts = createDocumentDrafts(owner, persistent, tab);
    else {
      reportUxError('无法生成独立草稿标识，仅使用标签页存储；关闭标签页后可能无法恢复。');
      browserDrafts = createSessionDrafts(tab, persistent);
    }
  }
  return browserDrafts(sessionId);
};
