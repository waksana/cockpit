import { acknowledge } from './draft';
import { describeReason, reportUxError } from './errorReporter';
import { NativeAttachment } from '@cockpit/protocol';
import type { DraftAttachment, DraftReference, DraftWrite, ModuleDraft, ModuleDraftSnapshot } from '@cockpit/module-api';

type SessionDraftSnapshot = ModuleDraftSnapshot;
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const references = new WeakMap<DraftReference, SessionDraft>();
let draftSequence = 0;

export function resolveDraft(reference: DraftReference): SessionDraft {
  const draft = references.get(reference);
  if (!draft) throw new Error('Unknown host draft reference');
  return draft;
}

function browserStorage(): DraftStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try { return window.sessionStorage; }
  catch (error) {
    reportUxError(`标签页草稿存储不可用，刷新后可能丢失文字：${describeReason(error, false)}`);
    return undefined;
  }
}

export class SessionDraft {
  private snapshot: SessionDraftSnapshot = Object.freeze({ text: '', attachments: Object.freeze([]), blocks: Object.freeze([]), revision: 0, pending: false, unconfirmed: false });
  private readonly attachmentOwners = new Map<string, string>();
  private readonly blockOwners = new Map<string, string>();
  private sequence = 0;
  readonly sessionId: string;
  readonly reference: DraftReference;
  private readonly listeners = new Set<() => void>();
  private readonly key: string;
  private readonly storage?: DraftStorage;

  constructor(sessionId: string, storage?: DraftStorage) {
    this.sessionId = sessionId;
    this.reference = Object.freeze({
      id: `draft-${++draftSequence}`, sessionId,
      getSnapshot: this.getSnapshot, subscribe: this.subscribe,
    });
    references.set(this.reference, this);
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
      const attachments = 'attachments' in value ? this.validateAttachments(value.attachments) : [];
      this.snapshot = Object.freeze({ ...this.snapshot, text: value.text, attachments, unconfirmed: value.unconfirmed });
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
    this.snapshot = Object.freeze({ ...this.snapshot, ...change,
      ...(change.attachments ? { attachments: Object.freeze(change.attachments) } : {}),
      ...(change.blocks ? { blocks: Object.freeze(change.blocks) } : {}),
    });
    const { text, attachments, pending, unconfirmed } = this.snapshot;
    try {
      // An interrupted request is unknown after reload, never still in flight.
      if (text || attachments.length || pending || unconfirmed) {
        this.storage?.setItem(this.key, JSON.stringify({ text, ...(attachments.length ? { attachments } : {}), unconfirmed: pending || unconfirmed }));
      } else this.storage?.removeItem(this.key);
    } catch (error) {
      reportUxError(`无法保存标签页草稿，刷新后可能丢失最新状态；当前文字仍在页面内：${describeReason(error, false)}`);
    }
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try { listener(); } catch (error) { reportUxError(`草稿订阅失败：${describeReason(error, false)}`); }
    }
  }
  edit = (text: string): void => { this.update({ text, revision: this.snapshot.revision + 1 }); };
  private validateAttachments(values: unknown): readonly DraftAttachment[] {
    if (!Array.isArray(values) || values.length > 20) throw new Error('Invalid draft attachments');
    const ids = new Set<string>();
    return Object.freeze(values.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Invalid attachment ID');
      ids.add(item.id);
      const value = NativeAttachment.parse(item.value);
      // No caller may mutate a captured attachment while its native send is settling.
      if (value.type === 'selection' && value.selection) {
        Object.freeze(value.selection.start); Object.freeze(value.selection.end); Object.freeze(value.selection);
      }
      return Object.freeze({ id: item.id, value: Object.freeze(value) });
    }));
  }
  removeAttachment = (id: string): void => {
    this.attachmentOwners.delete(id);
    this.update({ attachments: this.snapshot.attachments.filter(item => item.id !== id) });
  };
  dismissOrphanedBlock = (id: string): void => {
    if (this.snapshot.blocks.some(block => block.id === id && block.orphaned)) {
      this.update({ blocks: this.snapshot.blocks.filter(block => block.id !== id) });
    }
  };
  hasModuleBlock(): boolean {
    return this.snapshot.blocks.some(block => this.blockOwners.has(block.id));
  }
  recoverFiles(files: readonly File[], reason: string): void {
    this.update({ blocks: [...this.snapshot.blocks, Object.freeze({
      id: `block-${++this.sequence}`, orphaned: true,
      reason: `${reason}：${files.map(file => file.name || '文件').join('、')}。请移除本次选择后重试。`,
    })] });
  }
  holdFiles(): () => void {
    const id = `block-${++this.sequence}`;
    this.update({ blocks: [...this.snapshot.blocks, Object.freeze({ id, reason: '正在接收文件选择', orphaned: false })] });
    return () => this.update({ blocks: this.snapshot.blocks.filter(block => block.id !== id) });
  }
  bindModule(owner: string, writes: readonly DraftWrite[], report: (error: unknown) => void = error => reportUxError(describeReason(error, false))): { draft: ModuleDraft; dispose(): void } {
    const permissions = new Set(writes);
    const subscriptions = new Set<() => void>();
    let active = true;
    const assertWrite = (field: 'attachments' | 'text') => {
      if (!active || !permissions.has(field)) throw new Error(`Module ${owner} cannot write ${field}`);
      if (field === 'attachments' && this.snapshot.pending) throw new Error('Draft attachments are pending native submission');
    };
    const draft: ModuleDraft = Object.freeze({
      id: this.reference.id,
      sessionId: this.sessionId,
      getSnapshot: this.getSnapshot,
      subscribe: (listener: () => void) => {
        if (!active) return () => {};
        const unsubscribe = this.subscribe(() => { try { listener(); } catch (error) { report(error); } });
        subscriptions.add(unsubscribe);
        return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
      },
      appendAttachments: (values: readonly DraftAttachment[]) => {
        assertWrite('attachments');
        const incoming = this.validateAttachments(values);
        for (const item of incoming) {
          const previousOwner = this.attachmentOwners.get(item.id);
          if (previousOwner && previousOwner !== owner) throw new Error('Attachment belongs to another module');
        }
        const replaced = new Set(incoming.map(item => item.id));
        const attachments = [...this.snapshot.attachments.filter(item => !replaced.has(item.id)), ...incoming];
        if (attachments.length > 20) throw new Error('最多可发送 20 个附件，请先移除多余附件。');
        for (const item of incoming) this.attachmentOwners.set(item.id, owner);
        this.update({ attachments: Object.freeze(attachments) });
      },
      removeAttachment: (id: string) => {
        assertWrite('attachments');
        const previousOwner = this.attachmentOwners.get(id);
        if (previousOwner && previousOwner !== owner) throw new Error('Attachment belongs to another module');
        this.removeAttachment(id);
      },
      editText: (text: string) => { assertWrite('text'); this.edit(text); },
      block: (reason: string) => {
        if (!active || !permissions.size) throw new Error('Module cannot block this draft');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('A draft block needs a reason');
        const id = `block-${++this.sequence}`;
        this.blockOwners.set(id, owner);
        this.update({ blocks: [...this.snapshot.blocks, Object.freeze({ id, reason, orphaned: false })] });
        let released = false;
        return () => {
          if (released) return;
          released = true;
          // Revocation transfers unresolved selections to a visible host-owned notice.
          if (this.blockOwners.get(id) !== owner) return;
          this.blockOwners.delete(id);
          this.update({ blocks: this.snapshot.blocks.filter(block => block.id !== id) });
        };
      },
    });
    references.set(draft, this);
    return { draft, dispose: () => {
      if (!active) return;
      active = false;
      references.delete(draft);
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      this.update({ blocks: this.snapshot.blocks.map(block => {
        if (this.blockOwners.get(block.id) !== owner) return block;
        this.blockOwners.delete(block.id);
        return Object.freeze({ ...block, orphaned: true, reason: `模块已停止，未完成的附件未发送：${block.reason}` });
      }) });
    } };
  }
  dismissNotice = (): void => { this.update({ unconfirmed: false }); };
  runAction = async (send: () => Promise<boolean> | undefined): Promise<boolean> => {
    if (this.snapshot.pending) return false;
    this.update({ pending: true, unconfirmed: false });
    const sent = await acknowledge(send);
    this.update({ pending: false, unconfirmed: !sent });
    return sent;
  };
  send = (send: (text: string, attachments?: NativeAttachment[]) => Promise<boolean>): Promise<boolean> => {
    const { text, attachments, revision, pending, blocks } = this.snapshot;
    if (pending || blocks.length || (!text.trim() && !attachments.length)) return Promise.resolve(false);
    return this.runAction(async () => {
      const sent = await send(text.trim(), attachments.length ? attachments.map(item => item.value) : undefined);
      if (sent === true) {
        const captured = new Set(attachments);
        const remaining = this.snapshot.attachments.filter(item => !captured.has(item));
        for (const item of attachments) if (!remaining.some(value => value.id === item.id)) this.attachmentOwners.delete(item.id);
        this.update({ attachments: remaining,
          ...(this.snapshot.revision === revision ? { text: '', revision: revision + 1 } : {}) });
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
