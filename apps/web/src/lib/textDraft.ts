import { acknowledge } from './draft';
import { reportUxError } from './errorReporter';

export interface SessionDraftSnapshot {
  text: string;
  revision: number;
  pending: boolean;
  error?: string;
}
export interface DraftSubmission { text: string; revision: number }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const UNCONFIRMED = '发送失败或结果尚未确认，草稿已保留；重发前请先检查会话。';

function browserStorage(): DraftStorage | undefined {
  try { return globalThis.localStorage; }
  catch (error) { reportUxError('草稿存储不可用，当前文字仅保留在页面内。', error); return undefined; }
}

export class SessionDraft {
  private snapshot: SessionDraftSnapshot = { text: '', revision: 0, pending: false };
  private listeners = new Set<() => void>();
  private readonly key: string;
  readonly sessionId: string;
  private readonly storage?: DraftStorage;

  constructor(sessionId: string, storage?: DraftStorage) {
    this.sessionId = sessionId;
    this.storage = storage;
    // The old rich draft stays untouched for later module migration.
    this.key = `cockpit:native-composer:${sessionId}`;
    try {
      const stored = storage?.getItem(this.key);
      if (!stored) return;
      const value: unknown = JSON.parse(stored);
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
        || !('text' in value) || typeof value.text !== 'string') throw new Error('Invalid text draft');
      this.snapshot.text = value.text;
      if ('pending' in value && value.pending) this.snapshot.error = UNCONFIRMED;
    } catch (error) { reportUxError('无法读取原文字草稿；存储内容未修改。', error); }
  }

  getSnapshot = (): SessionDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(change: Partial<SessionDraftSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    try {
      this.storage?.setItem(this.key, JSON.stringify({
        version: 1, text: this.snapshot.text, pending: this.snapshot.pending,
      }));
    } catch (error) { reportUxError('无法保存文字草稿，当前文字仍保留在页面内。', error); }
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

export function createSessionDrafts(storage: DraftStorage | undefined = browserStorage()) {
  const sessions = new Map<string, SessionDraft>();
  return (sessionId: string): SessionDraft => {
    let draft = sessions.get(sessionId);
    if (!draft) { draft = new SessionDraft(sessionId, storage); sessions.set(sessionId, draft); }
    return draft;
  };
}
export const getSessionDraft = createSessionDrafts();
