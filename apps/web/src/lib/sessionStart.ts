import { Intents, ModuleSelections, SessionStartOperation } from '@cockpit/protocol';
import type { IntentBody, ModuleSelection } from '@cockpit/protocol';
import { SessionDraft, type DraftSubmission } from './attachmentSend';
import { resourceError } from './keyedAsync';
import { browserOperationLock, type BrowserOperationLock } from './browserOperationLock';

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StartRequest = IntentBody<'session/start'>;
export type StartSession = (body: StartRequest) => Promise<SessionStartOperation>;
export type ReadSessionStart = (operationId: string, signal?: AbortSignal) => Promise<SessionStartOperation | null>;
export type StartLock = BrowserOperationLock;

interface StartAttempt {
  request: StartRequest;
  submission: DraftSubmission;
  operation?: SessionStartOperation;
}
export interface ArchivedStart {
  operationId: string;
  operation?: SessionStartOperation;
  archivedAt: number;
  error?: string;
}
interface StartSnapshot {
  cwd?: string;
  modules: ModuleSelection[];
  attempt?: StartAttempt;
  draftId?: string;
  archives?: ArchivedStart[];
  error?: string;
}
const STORAGE_KEY = 'cockpit:new-session-start:v1';
const DRAFT_KEY = 'gui-new-session-first-message';

const browserStartLock: StartLock = claim => browserOperationLock(STORAGE_KEY, claim);

function submission(value: unknown): DraftSubmission {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string'
    || !('revision' in value) || !Number.isSafeInteger(value.revision) || typeof value.revision !== 'number'
    || value.revision < 0 || !('attachments' in value) || !Array.isArray(value.attachments)) {
    throw new Error('创建草稿的确认信息无效；不会丢弃原操作或重新发送。');
  }
  return { text: value.text, revision: value.revision, attachments: value.attachments.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('generation' in item) || typeof item.generation !== 'number'
      || !Number.isSafeInteger(item.generation) || item.generation < 1 || !('url' in item) || typeof item.url !== 'string') {
      throw new Error('创建草稿的附件确认信息无效。');
    }
    return { generation: item.generation, url: item.url };
  }) };
}

function decode(raw: string): StartSnapshot {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('modules' in value) || ('cwd' in value && typeof value.cwd !== 'string')) {
    throw new Error('本地创建记录无效；请先核对，不能自动替换原操作。');
  }
  const cwd = 'cwd' in value ? value.cwd : undefined;
  const result: StartSnapshot = { modules: ModuleSelections.parse(value.modules),
    ...(typeof cwd === 'string' ? { cwd } : {}) };
  if ('draftId' in value) {
    if (typeof value.draftId !== 'string' || !/^gui-new-session-after-[a-zA-Z0-9_-]{8,120}$/.test(value.draftId)) {
      throw new Error('本地独立草稿标识无效；不能恢复为旧草稿。');
    }
    result.draftId = value.draftId;
  }
  if ('archives' in value) {
    if (!Array.isArray(value.archives)) throw new Error('本地创建归档记录无效。');
    result.archives = value.archives.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('operationId' in entry) || !('archivedAt' in entry)
        || typeof entry.archivedAt !== 'number' || !Number.isSafeInteger(entry.archivedAt) || entry.archivedAt < 0
        || ('error' in entry && typeof entry.error !== 'string')) throw new Error('本地创建归档条目无效。');
      const { operationId } = Intents['session/start/get'].body.parse({ operationId: entry.operationId });
      const operation = 'operation' in entry ? SessionStartOperation.parse(entry.operation) : undefined;
      if (operation && operation.operationId !== operationId) throw new Error('本地创建归档标识不一致。');
      return { operationId, archivedAt: entry.archivedAt, ...(operation ? { operation } : {}),
        ...('error' in entry && typeof entry.error === 'string' ? { error: entry.error } : {}) };
    });
    if (new Set(result.archives.map(entry => entry.operationId)).size !== result.archives.length) {
      throw new Error('本地创建归档存在重复操作标识。');
    }
  }
  if ('attempt' in value && value.attempt !== undefined) {
    const attempt = value.attempt;
    if (!attempt || typeof attempt !== 'object' || !('request' in attempt) || !('submission' in attempt)) {
      throw new Error('本地创建操作记录无效。');
    }
    const request = Intents['session/start'].body.parse(attempt.request);
    const operation = 'operation' in attempt && attempt.operation !== undefined
      ? SessionStartOperation.parse(attempt.operation) : undefined;
    if (operation && operation.operationId !== request.operationId) throw new Error('本地创建操作标识不一致。');
    result.attempt = { request, submission: submission(attempt.submission), ...(operation ? { operation } : {}) };
    if (result.archives?.some(entry => entry.operationId === request.operationId)) throw new Error('归档操作不能再次成为待发送操作。');
  }
  return result;
}

// This is one browser-owned outgoing attempt and draft, not native session state.
// Its GUI draft key is never supplied to upload, prompt, or native creation APIs.
export class NewSessionStart {
  private currentDraft: SessionDraft;
  private snapshot: StartSnapshot = { modules: [] };
  private listeners = new Set<() => void>();
  private storageInvalid = false;
  private readonly storage?: BrowserStorage;
  private readonly newId: () => string;
  private readonly withLock: StartLock;

  constructor(storage?: BrowserStorage, newId: () => string = () => crypto.randomUUID(), withLock: StartLock = browserStartLock) {
    this.storage = storage;
    this.newId = newId;
    this.withLock = withLock;
    this.currentDraft = new SessionDraft(DRAFT_KEY, storage, { persistRevisions: true, associateUploads: false });
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) this.publish(decode(raw));
    } catch (error) {
      this.storageInvalid = true;
      this.snapshot = { modules: [], error: resourceError(error) };
    }
  }

  get draft() { return this.currentDraft; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: StartSnapshot) {
    const draftId = next.draftId ?? DRAFT_KEY;
    if (draftId !== this.currentDraft.sessionId) {
      this.currentDraft = new SessionDraft(draftId, this.storage, { persistRevisions: true, associateUploads: false });
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private save(next: StartSnapshot) {
    if (!this.storage || this.storageInvalid) throw new Error('无法持久保存创建操作；尚未发送。请先恢复浏览器存储。');
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...next }));
    this.publish(next);
  }
  private fail(error: unknown) { this.publish({ ...this.snapshot, error: resourceError(error) }); }
  private stored(): StartSnapshot {
    if (!this.storage || this.storageInvalid) throw new Error('无法读取持久创建记录；未发送，请先恢复浏览器存储。');
    const raw = this.storage.getItem(STORAGE_KEY);
    return raw ? decode(raw) : { modules: [] };
  }
  private recordOperation(operationId: string, result: unknown): Promise<SessionStartOperation | null> {
    const operation = SessionStartOperation.parse(result);
    if (operation.operationId !== operationId) {
      throw new Error('创建回执标识不匹配；原操作待核对，草稿已保留。');
    }
    return this.withLock(() => {
      const stored = this.stored();
      const current = stored.attempt;
      if (current?.request.operationId !== operation.operationId) {
        const archived = stored.archives?.find(entry => entry.operationId === operationId);
        if (archived) {
          const observed = this.observe(archived.operation, operation);
          this.save({ ...stored, archives: stored.archives?.map(entry => entry.operationId === operationId
            ? { ...entry, operation: observed, error: observed.error } : entry) });
        } else this.publish(stored);
        return null;
      }
      const observed = this.observe(current.operation, operation);
      this.save({ ...stored, attempt: { ...current, operation: observed },
        error: observed.state === 'accepted' ? undefined : observed.error ?? '首条消息尚未获确认，请读取原操作；不会重新发送。' });
      return observed;
    });
  }
  private observe(previous: SessionStartOperation | undefined, operation: SessionStartOperation) {
    if (previous && previous.sessionId !== operation.sessionId) throw new Error('同一创建操作返回了不同会话标识；未采纳回执。');
    // Passive readback may confirm acceptance before the original POST resolves.
    return previous?.state === 'accepted' ? previous : operation;
  }
  private recordError(operationId: string, error: unknown) {
    return this.withLock(() => {
      const current = this.stored();
      const message = resourceError(error);
      if (current.attempt?.request.operationId === operationId) this.save({ ...current, error: message });
      else if (current.archives?.some(entry => entry.operationId === operationId)) {
        this.save({ ...current, archives: current.archives.map(entry => entry.operationId === operationId
          ? { ...entry, error: message } : entry) });
      } else this.publish(current);
    });
  }

  configure = async (cwd: string | undefined, modules: ModuleSelection[]) => {
    if (this.snapshot.attempt) return;
    try {
      await this.withLock(() => {
        const current = this.stored();
        if (current.attempt || current.draftId !== this.snapshot.draftId) this.publish(current);
        else this.save({ ...current, cwd, modules: ModuleSelections.parse(modules), error: undefined });
      });
    }
    catch (error) { this.fail(error); }
  };

  send = async (cwd: string, modules: ModuleSelection[], start: StartSession): Promise<boolean> => {
    if (this.snapshot.attempt || this.draft.getSnapshot().pending || this.storageInvalid) return false;
    const submitted = this.draft.captureSubmission();
    return this.draft.send(async (text, attachment, attachments) => {
      let operationId: string | undefined;
      try {
        const attempt = await this.withLock(() => {
          const current = this.stored();
          if (current.draftId !== this.snapshot.draftId) {
            this.publish({ ...current, error: '原本地草稿已被归档；已切到独立草稿，请重新输入新内容，未发送旧内容。' });
            return null;
          }
          if (current.attempt) {
            this.publish({ ...current, error: '已有创建操作，请读取原操作状态；未重新发送。' });
            return null;
          }
          const request = Intents['session/start'].body.parse({
            operationId: this.newId(), cwd, ...(modules.length ? { modules } : {}), text,
            ...(attachments ? { attachments } : attachment ? { attachment } : {}),
          });
          if (current.archives?.some(entry => entry.operationId === request.operationId)) throw new Error('新操作不能复用归档 ID。');
          const claimed: StartAttempt = { request, submission: submitted };
          this.save({ ...current, cwd, modules, attempt: claimed, error: undefined });
          return claimed;
        });
        if (!attempt) return false;
        operationId = attempt.request.operationId;
        const operation = await this.recordOperation(operationId, await start(attempt.request));
        return operation?.state === 'accepted';
      } catch (error) {
        if (operationId) await this.recordError(operationId, error);
        else this.fail(error);
        return false;
      }
    });
  };

  read = async (load: ReadSessionStart, signal?: AbortSignal): Promise<SessionStartOperation | null> => {
    const attempt = this.snapshot.attempt;
    const draft = this.draft;
    if (!attempt) throw new Error('尚无已提交的创建操作。');
    try {
      const result = await load(attempt.request.operationId, signal);
      if (signal?.aborted) return null;
      if (result === null) {
        await this.recordError(attempt.request.operationId, '服务器尚未记录此操作；这不证明在途请求未执行。原操作保留，不会重新发送。');
        return null;
      }
      const operation = await this.recordOperation(attempt.request.operationId, result);
      if (signal?.aborted) return null;
      if (operation?.state === 'accepted') draft.acknowledgeSubmission(attempt.submission);
      return operation;
    } catch (error) {
      if (!signal?.aborted) await this.recordError(attempt.request.operationId, error);
      throw error;
    }
  };

  archive = async (operationId: string, confirm: (message: string) => boolean) => {
    const draft = this.draft, discarded = draft.getSnapshot();
    if (!confirm(`确认放弃当前本地草稿（包括后来编辑的文字和暂存附件），并归档操作 ${operationId}？这不取消后台请求、不删除服务器回执，也不证明原生会话未创建或消息未提交。保留原操作 ID 和已知预留会话 ID 供只读核对；下一份草稿为空白，不复制或重发旧内容。这不是重试。`)) return false;
    try {
      await this.withLock(() => {
        const current = this.stored(), attempt = current.attempt;
        if (attempt?.request.operationId !== operationId || current.draftId !== this.snapshot.draftId) {
          this.publish(current);
          throw new Error('当前操作已改变；未归档其他操作，请重新核对。');
        }
        if (attempt.operation?.state === 'accepted') throw new Error('原操作已确认接受，请使用已接受操作的新建入口。');
        if (draft !== this.draft || draft.getSnapshot() !== discarded) throw new Error('确认期间草稿已改变；未丢弃新编辑，请重新确认。');
        const archived: ArchivedStart = { operationId, archivedAt: Date.now(),
          ...(attempt.operation ? { operation: attempt.operation } : {}),
          ...(this.snapshot.error ? { error: this.snapshot.error } : {}) };
        this.save({ cwd: current.cwd, modules: [], draftId: `gui-new-session-after-${operationId}`,
          archives: [...(current.archives ?? []), archived] });
        draft.edit('');
        draft.removeAttachment();
        draft.dismissError();
      });
      return true;
    } catch (error) { this.fail(error); return false; }
  };

  readArchived = async (operationId: string, load: ReadSessionStart, signal?: AbortSignal) => {
    if (!this.snapshot.archives?.some(entry => entry.operationId === operationId)) throw new Error('没有这个本地归档操作。');
    try {
      const result = await load(operationId, signal);
      if (signal?.aborted) return;
      if (result === null) {
        await this.recordError(operationId, '服务器未找到原操作记录；这不证明原生会话未创建或消息未提交。归档仅解除本地表单占用，不重发旧请求。');
      } else await this.recordOperation(operationId, result);
    } catch (error) {
      if (!signal?.aborted) await this.recordError(operationId, error);
      throw error;
    }
  };

  newIndependent = (options: { keepUnconfirmed?: boolean } = {}) => this.withLock(() => {
    const current = this.stored();
    this.publish(current);
    if (current.attempt?.operation?.state !== 'accepted' || this.draft.getSnapshot().pending) {
      if (options.keepUnconfirmed) return;
      throw new Error('请先核对原操作，不能把未确认的尝试替换成新会话。');
    }
    this.save({ ...current, attempt: undefined, error: undefined });
  });

  openNewForm = async () => {
    try { await this.newIndependent({ keepUnconfirmed: true }); }
    catch (error) { this.fail(error); }
  };
}

let browserStart: NewSessionStart | undefined;
export function getNewSessionStart() {
  if (!browserStart) {
    let storage: BrowserStorage | undefined;
    try { storage = globalThis.localStorage; }
    catch { /* Sending remains disabled by the durable-write guard, with a visible error. */ }
    browserStart = new NewSessionStart(storage);
  }
  return browserStart;
}
