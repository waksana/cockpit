import { acknowledge } from './draft';
import { describeReason, reportUxError } from './errorReporter';

interface SessionDraftSnapshot {
  text: string;
  revision: number;
  pending: boolean;
  unconfirmed: boolean;
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): DraftStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try { return window.sessionStorage; }
  catch (error) {
    reportUxError(`标签页草稿存储不可用，刷新后可能丢失文字：${describeReason(error, false)}`);
    return undefined;
  }
}

export class SessionDraft {
  private snapshot: SessionDraftSnapshot = { text: '', revision: 0, pending: false, unconfirmed: false };
  private readonly listeners = new Set<() => void>();
  private readonly key: string;
  private readonly storage?: DraftStorage;

  constructor(sessionId: string, storage?: DraftStorage) {
    this.storage = storage;
    this.key = `cockpit:chat-draft:${sessionId}`;
    try {
      const stored = storage?.getItem(this.key);
      if (stored == null) return;
      const value: unknown = JSON.parse(stored);
      if (!value || typeof value !== 'object'
        || !('text' in value) || typeof value.text !== 'string'
        || !('unconfirmed' in value) || typeof value.unconfirmed !== 'boolean') {
        throw new Error('Invalid draft record');
      }
      this.snapshot = { ...this.snapshot, text: value.text, unconfirmed: value.unconfirmed };
    } catch (error) {
      reportUxError(`无法读取标签页草稿，存储内容未修改：${describeReason(error, false)}`);
    }
  }

  getSnapshot = (): SessionDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(change: Partial<SessionDraftSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    const { text, pending, unconfirmed } = this.snapshot;
    try {
      // An interrupted request is unknown after reload, never still in flight.
      if (text || pending || unconfirmed) {
        this.storage?.setItem(this.key, JSON.stringify({ text, unconfirmed: pending || unconfirmed }));
      } else this.storage?.removeItem(this.key);
    } catch (error) {
      reportUxError(`无法保存标签页草稿，刷新后可能丢失最新状态；当前文字仍在页面内：${describeReason(error, false)}`);
    }
    for (const listener of this.listeners) listener();
  }
  edit = (text: string): void => { this.update({ text, revision: this.snapshot.revision + 1 }); };
  dismissNotice = (): void => { this.update({ unconfirmed: false }); };
  runAction = async (send: () => Promise<boolean> | undefined): Promise<boolean> => {
    if (this.snapshot.pending) return false;
    this.update({ pending: true, unconfirmed: false });
    const sent = await acknowledge(send);
    this.update({ pending: false, unconfirmed: !sent });
    return sent;
  };
  send = (send: (text: string) => Promise<boolean>): Promise<boolean> => {
    const { text, revision, pending } = this.snapshot;
    if (pending || !text.trim()) return Promise.resolve(false);
    return this.runAction(async () => {
      const sent = await send(text.trim());
      if (sent === true && this.snapshot.revision === revision) {
        this.update({ text: '', revision: revision + 1 });
      }
      return sent;
    });
  };
}

export function createSessionDrafts(storage?: DraftStorage) {
  const sessions = new Map<string, SessionDraft>();
  return (sessionId: string): SessionDraft => {
    let draft = sessions.get(sessionId);
    if (!draft) { draft = new SessionDraft(sessionId, storage); sessions.set(sessionId, draft); }
    return draft;
  };
}

let browserDrafts: ReturnType<typeof createSessionDrafts> | undefined;
export const getSessionDraft = (sessionId: string): SessionDraft => {
  browserDrafts ??= createSessionDrafts(browserStorage());
  return browserDrafts(sessionId);
};
