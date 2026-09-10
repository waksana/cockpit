import type { Attachment, UploadedFile } from '@cockpit/protocol';
import { acknowledge } from './draft';
import { reportUxError } from './errorReporter';
import { uploadedAttachment, uploadFile } from './upload';

export interface StagedAttachment {
  generation: number;
  kind: Attachment['kind'];
  name: string;
  size?: number;
  status: 'uploading' | 'ready' | 'failed';
  attachment?: Attachment;
  error?: string;
}

export interface SessionDraftSnapshot {
  text: string;
  revision: number;
  staged?: StagedAttachment;
  stagedAttachments?: StagedAttachment[];
  pending: boolean;
  error?: string;
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type UploadFile = (file: File) => Promise<UploadedFile>;
export type SendPrompt = (text: string, attachment?: Attachment, attachments?: Attachment[]) => Promise<boolean>;

export function stagedAttachments(snapshot: SessionDraftSnapshot): StagedAttachment[] {
  return snapshot.stagedAttachments ?? (snapshot.staged ? [snapshot.staged] : []);
}

const UNCONFIRMED = '发送失败或结果尚未确认，草稿已保留；重发前请先检查会话。';

function browserStorage(): DraftStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

// The session, not a mounted Composer, owns edits and in-flight operations.
// Unsubscribing only releases the view; a late acknowledgement still reconciles
// the same session's latest revisions, including edits made after remount.
export class SessionDraft {
  private snapshot: SessionDraftSnapshot;
  private generation = 0;
  private listeners = new Set<() => void>();
  private selectedFiles = new Map<number, File>();
  private readonly key: string;
  private readonly storage?: DraftStorage;
  readonly sessionId: string;

  constructor(sessionId: string, storage?: DraftStorage) {
    this.sessionId = sessionId;
    this.key = `cockpit:composer:${sessionId}`;
    this.storage = storage;
    this.snapshot = { text: '', revision: 0, pending: false };
    try {
      storage?.removeItem(`cockpit:draft:${sessionId}`);
    } catch {
      reportUxError('无法清理旧版草稿存储；旧草稿不会恢复，当前草稿不受影响。');
    }
    try {
      const stored = storage?.getItem(this.key);
      if (stored) {
        const value = JSON.parse(stored);
        if (value?.version === 1 && typeof value.text === 'string') {
          this.snapshot.text = value.text;
          if (value.pending) this.snapshot.error = UNCONFIRMED;
          // Cached metadata is GUI state, never a server filesystem authority.
          if (value.attachments || value.attachment) {
            const attachments = (value.attachments ?? [value.attachment]).slice(0, 20)
              .map((file: Attachment) => {
                const attachment = uploadedAttachment(file);
                return { ...attachment, attachment, generation: ++this.generation, status: 'ready' as const };
              });
            this.snapshot.staged = attachments[0];
            if (attachments.length > 1) this.snapshot.stagedAttachments = attachments;
          }
        }
      }
    } catch { /* Storage is optional; invalid cached attachments are not restored. */ }
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
        version: 1,
        text: this.snapshot.text,
        attachment: this.snapshot.staged?.attachment,
        attachments: this.snapshot.stagedAttachments?.flatMap(item => item.attachment ? [item.attachment] : []),
        pending: this.snapshot.pending,
      }));
    } catch { /* Keep the in-memory session owner when browser storage is unavailable. */ }
    for (const listener of this.listeners) listener();
  }

  edit = (text: string) => {
    this.update({ text, revision: this.snapshot.revision + 1 });
  };

  dismissError = () => { this.update({ error: undefined }); };

  private setAttachments(items: StagedAttachment[]) {
    this.update({ staged: items[0], stagedAttachments: items.length > 1 ? items : undefined });
  }

  removeAttachment = (generation?: number) => {
    if (generation === undefined) this.selectedFiles.clear();
    else this.selectedFiles.delete(generation);
    this.setAttachments(generation === undefined ? [] : stagedAttachments(this.snapshot).filter(item => item.generation !== generation));
  };

  addManagedAttachment = (file: Attachment): boolean => {
    const items = stagedAttachments(this.snapshot);
    if (items.length >= 20) {
      this.update({ error: '最多暂存 20 个附件，请先移除部分附件。' });
      return false;
    }
    const attachment = uploadedAttachment(file);
    this.setAttachments([...items, { ...attachment, attachment, generation: ++this.generation, status: 'ready' }]);
    return true;
  };

  selectAttachment = async (file: File, upload: UploadFile = uploadFile): Promise<boolean> => {
    this.removeAttachment();
    return this.addAttachment(file, upload);
  };

  addAttachment = async (file: File, upload: UploadFile = (file) => uploadFile(file, this.sessionId)): Promise<boolean> => {
    if (stagedAttachments(this.snapshot).length >= 20) {
      this.update({ error: '最多暂存 20 个附件，请先移除部分附件。' });
      return false;
    }
    const generation = ++this.generation;
    const staged: StagedAttachment = {
      generation, name: file.name, size: file.size,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
      status: 'uploading',
    };
    this.selectedFiles.set(generation, file);
    this.setAttachments([...stagedAttachments(this.snapshot), staged]);
    this.update({ error: undefined });
    return this.uploadStaged(file, staged, upload);
  };

  retryAttachment = async (generation: number, upload: UploadFile = (file) => uploadFile(file, this.sessionId)): Promise<boolean> => {
    const item = stagedAttachments(this.snapshot).find(item => item.generation === generation);
    const file = this.selectedFiles.get(generation);
    if (!file || item?.status !== 'failed') return false;
    const staged: StagedAttachment = { ...item, status: 'uploading', error: undefined };
    this.setAttachments(stagedAttachments(this.snapshot).map(item => item.generation === generation ? staged : item));
    return this.uploadStaged(file, staged, upload);
  };

  private async uploadStaged(file: File, staged: StagedAttachment, upload: UploadFile): Promise<boolean> {
    const { generation } = staged;
    try {
      const attachment = uploadedAttachment(await upload(file));
      if (!stagedAttachments(this.snapshot).some(item => item.generation === generation)) return false;
      this.selectedFiles.delete(generation);
      this.setAttachments(stagedAttachments(this.snapshot).map(item => item.generation === generation
        ? { ...attachment, attachment, generation, status: 'ready' } : item));
      return true;
    } catch (error) {
      if (!stagedAttachments(this.snapshot).some(item => item.generation === generation)) return false;
      this.setAttachments(stagedAttachments(this.snapshot).map(item => item.generation === generation ? {
          ...staged, status: 'failed',
          error: error instanceof Error ? error.message : '上传失败，请重新选择文件。',
        } : item));
      return false;
    }
  }

  runAction = async (send: () => Promise<boolean> | undefined): Promise<boolean> => {
    if (this.snapshot.pending) return false;
    this.update({ pending: true, error: undefined });
    try {
      const sent = await acknowledge(send);
      if (!sent) this.update({ error: UNCONFIRMED });
      return sent;
    } finally {
      this.update({ pending: false });
    }
  };

  send = (send: SendPrompt): Promise<boolean> => {
    const submitted = this.snapshot;
    const items = stagedAttachments(submitted);
    if (submitted.pending || items.some(item => item.status !== 'ready')
      || (!submitted.text.trim() && !items.length)) return Promise.resolve(false);
    return this.runAction(async () => {
      const attachments = items.flatMap(item => item.attachment ? [item.attachment] : []);
      const sent = await acknowledge(() => attachments.length > 1
        ? send(submitted.text.trim(), undefined, attachments)
        : send(submitted.text.trim(), attachments[0]));
      if (sent) {
        const current = this.snapshot;
        const unchangedText = current.revision === submitted.revision;
        const generations = new Set(items.map(item => item.generation));
        const remaining = stagedAttachments(current).filter(item => !generations.has(item.generation));
        this.update({
          text: unchangedText ? '' : current.text,
          revision: current.revision + (unchangedText ? 1 : 0),
          staged: remaining[0],
          stagedAttachments: remaining.length > 1 ? remaining : undefined,
        });
      }
      return sent;
    });
  };
}

export function createSessionDrafts(storage: DraftStorage | undefined = browserStorage()) {
  const sessions = new Map<string, SessionDraft>();
  return (sessionId: string): SessionDraft => {
    let draft = sessions.get(sessionId);
    if (!draft) {
      draft = new SessionDraft(sessionId, storage);
      sessions.set(sessionId, draft);
    }
    return draft;
  };
}

export const getSessionDraft = createSessionDrafts();
