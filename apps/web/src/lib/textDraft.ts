import type {
  DraftNativeFields, DraftPurpose, DraftReference, DraftRestoreInput, DraftSubmission,
  DraftWrite, ModuleDraft, ModuleDraftSnapshot,
} from '@cockpit/module-api';
import { CORE_DRAFT_FIELDS, nativeDraftRequest, type NativeDraftRequest } from './draft';
import { describeReason, reportUxError } from './errorReporter';

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type DraftReport = (error: unknown) => void;
const reportDraft: DraftReport = error => reportUxError(`草稿操作未完成：${describeReason(error, false)}`);
const references = new WeakMap<DraftReference, SessionDraft>();
let sequence = 0;
let schemaHookDepth = 0;
export const draftIdentity = () => `${Date.now().toString(36)}-${++sequence}`;
const META = '__cockpitDraft';

export function draftRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function immutableDraftData<T>(value: T, seen = new Set<object>()): T {
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object') throw new Error('Draft snapshots must contain data, not resources or actions');
  if (seen.has(value)) return value;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Draft snapshots must contain plain immutable data');
  }
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw new Error('Draft snapshot accessors are not supported');
    immutableDraftData(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export function resolveDraft(reference: DraftReference): SessionDraft {
  const draft = references.get(reference);
  if (!draft) throw new Error('Unknown or revoked host draft reference');
  return draft;
}

export function browserDraftStorage(): DraftStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try { return window.sessionStorage; }
  catch (error) {
    reportDraft(error);
    return { getItem() { throw error; }, setItem() { throw error; }, removeItem() { throw error; } };
  }
}

export interface DraftField {
  readonly owner: string;
  readonly namespace: string;
  readonly hasContent: boolean;
  readonly encoded: string | undefined;
  readonly active: boolean;
  project(submission: DraftSubmission): DraftNativeFields | undefined;
  captureAck(submission: DraftSubmission): () => void;
}

interface CapturedField {
  field: DraftField;
  acknowledge(): void;
}

export class SessionDraft {
  private snapshot: ModuleDraftSnapshot = Object.freeze({
    text: '', blocks: Object.freeze([]), hasContent: false, revision: 0, pending: false, unconfirmed: false, retired: false,
  });
  private readonly listeners = new Set<() => void>();
  private readonly blockOwners = new Map<string, string>();
  private readonly fields = new Map<string, DraftField>();
  private record?: Record<string, unknown>;
  private storedBytes: string | null = null;
  private readError?: unknown;
  private pendingToken?: string;
  private retired = false;
  private notificationDepth = 0;
  private notificationPending = false;
  readonly reference: DraftReference;
  readonly sessionId: string;
  private readonly storage?: DraftStorage;
  private readonly key: string;
  private readonly report: DraftReport;

  constructor(
    sessionId: string,
    storage?: DraftStorage,
    purpose: DraftPurpose = { kind: 'prompt' },
    key = purpose.kind === 'prompt' ? `cockpit:chat-draft:${sessionId}`
      : `cockpit:decision-draft:${JSON.stringify([sessionId, purpose.kind, purpose.requestId, draftIdentity()])}`,
    report: DraftReport = reportDraft,
  ) {
    this.sessionId = sessionId;
    this.storage = storage;
    this.key = key;
    this.report = report;
    this.reference = Object.freeze({
      id: `draft-${draftIdentity()}`, sessionId, purpose: Object.freeze({ ...purpose }),
      getSnapshot: this.getSnapshot, subscribe: this.subscribe,
    });
    references.set(this.reference, this);
    try {
      const stored = storage?.getItem(key);
      this.storedBytes = stored ?? null;
      if (stored === null || stored === undefined) return;
      const value: unknown = JSON.parse(stored);
      if (!draftRecord(value) || typeof value.text !== 'string' || typeof value.unconfirmed !== 'boolean') {
        throw new Error('Invalid saved draft record');
      }
      this.record = immutableDraftData(value);
      const meta = this.metadata();
      this.snapshot = Object.freeze({ ...this.snapshot, text: value.text, hasContent: !!value.text.trim(),
        unconfirmed: value.unconfirmed || meta.pendingToken !== undefined });
    } catch (error) { this.readError = error; this.report(error); }
  }

  getSnapshot = (): ModuleDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  isRetired(): boolean { return this.retired; }
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    if (this.reference.purpose.kind === 'prompt') {
      try {
        if (this.storage && this.storage.getItem(this.key) === this.storedBytes) this.storage.removeItem(this.key);
      } catch (error) { this.report(error); }
    }
    this.publish({ retired: true });
  }
  assertEditable(): void {
    if (this.retired) throw new Error('This draft has retired');
    if (schemaHookDepth) throw new Error('Draft schema hooks must not mutate drafts');
  }
  pure<T>(callback: () => T): T {
    schemaHookDepth++;
    try { return callback(); } finally { schemaHookDepth--; }
  }
  private publish(change: Partial<ModuleDraftSnapshot> = {}): void {
    const next = { ...this.snapshot, ...change };
    this.snapshot = Object.freeze({ ...next,
      blocks: Object.freeze(next.blocks),
      hasContent: !!next.text.trim() || [...this.fields.values()].some(field => field.active && field.hasContent),
    });
    if (this.notificationDepth) {
      this.notificationPending = true;
      return;
    }
    this.notify();
  }
  private notify(): void {
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) {
      try { listener(); } catch (error) { this.report(error); }
    }
  }
  // Teardown can revoke fields immediately and notify only after services unsubscribe.
  deferNotifications(): () => void {
    this.notificationDepth++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.notificationDepth--;
      if (!this.notificationDepth && this.notificationPending) {
        this.notificationPending = false;
        this.notify();
      }
    };
  }
  private metadata(): Record<string, unknown> {
    const meta = this.record?.[META];
    if (meta === undefined) return {};
    if (!draftRecord(meta) || meta.version !== 1 || !draftRecord(meta.purpose)
      || meta.purpose.kind !== this.reference.purpose.kind
      || (this.reference.purpose.kind !== 'prompt' && meta.purpose.requestId !== this.reference.purpose.requestId)
      || (meta.pendingToken !== undefined && typeof meta.pendingToken !== 'string')
      || (meta.schemas !== undefined && !draftRecord(meta.schemas))) throw new Error('Invalid draft scope or submission checkpoint');
    return meta;
  }
  private persist(
    snapshot: ModuleDraftSnapshot,
    token: string | null = this.pendingToken ?? null,
    encoded: ReadonlyMap<string, string> = new Map(),
  ): void {
    if (this.readError) throw this.readError;
    if (this.storage && this.storage.getItem(this.key) !== this.storedBytes) {
      throw new Error('Saved draft root has changed in another instance');
    }
    const previous = this.metadata();
    const schemas = { ...(previous.schemas as Record<string, unknown> | undefined) };
    for (const [namespace, value] of encoded) Object.defineProperty(schemas, namespace, { value, enumerable: true, configurable: true, writable: true });
    const meta: Record<string, unknown> = {
      ...previous, version: 1, purpose: this.reference.purpose,
      ...(Object.keys(schemas).length ? { schemas } : {}),
    };
    if (token) meta.pendingToken = token;
    else delete meta.pendingToken;
    const next = { ...this.record, text: snapshot.text, unconfirmed: snapshot.unconfirmed || !!token, [META]: meta };
    const hasOpaque = Object.keys(next).some(key => !['text', 'unconfirmed', META].includes(key))
      || Object.keys(schemas).length > 0 || Object.keys(meta).some(key => !['version', 'purpose'].includes(key));
    if (!snapshot.text && !snapshot.unconfirmed && !token && !hasOpaque) {
      this.storage?.removeItem(this.key);
      this.record = undefined;
      this.storedBytes = null;
    } else {
      const bytes = JSON.stringify(next);
      this.storage?.setItem(this.key, bytes);
      this.record = immutableDraftData(next);
      this.storedBytes = bytes;
    }
  }
  restoreInput(namespace: string): DraftRestoreInput | undefined {
    if (this.readError) throw this.readError;
    if (!this.record) return undefined;
    const schemas = this.metadata().schemas as Record<string, unknown> | undefined;
    return Object.freeze({
      stored: schemas && Object.hasOwn(schemas, namespace)
        ? Object.freeze({ present: true as const, value: schemas[namespace] }) : Object.freeze({ present: false as const }),
      legacyRecord: this.record,
    });
  }
  assertCanAttach(field: DraftField): void {
    const previous = this.fields.get(field.namespace);
    if (previous && previous !== field) throw new Error(`Draft schema namespace already active: ${field.namespace}`);
  }
  attachField(field: DraftField): void {
    this.assertCanAttach(field);
    this.fields.set(field.namespace, field);
    this.publish();
  }
  detachField(field: DraftField): void {
    if (this.fields.get(field.namespace) !== field) return;
    this.fields.delete(field.namespace);
    this.publish();
  }
  commitField(field: DraftField, encoded: string | undefined, commit: () => void, submission?: DraftSubmission): void {
    if (!field.active || this.fields.get(field.namespace) !== field) throw new Error('Draft schema generation has stopped');
    if (submission) this.assertSubmission(submission.id);
    else this.assertEditable();
    if (encoded !== undefined) this.persist(this.snapshot, this.pendingToken, new Map([[field.namespace, encoded]]));
    commit();
    this.publish();
  }
  edit = (text: string): void => {
    this.assertEditable();
    const next = { ...this.snapshot, text, revision: this.snapshot.revision + 1 };
    try { this.persist(next); } catch (error) { this.report(error); }
    this.publish(next);
  };
  dismissNotice = (): void => {
    const next = { ...this.snapshot, unconfirmed: false };
    try { this.persist(next); } catch (error) { this.report(error); return; }
    this.publish(next);
  };
  bindModule(owner: string, writes: readonly DraftWrite[], report: DraftReport = this.report, canBlock = () => false): { draft: ModuleDraft; dispose(): void } {
    let active = true;
    const subscriptions = new Set<() => void>();
    const draft: ModuleDraft = Object.freeze({
      ...this.reference,
      subscribe: (listener: () => void) => {
        if (!active) return () => {};
        const unsubscribe = this.subscribe(() => { try { listener(); } catch (error) { report(error); } });
        subscriptions.add(unsubscribe);
        return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
      },
      editText: (text: string) => {
        if (!active || !writes.includes('text')) throw new Error(`Module ${owner} cannot write text`);
        this.edit(text);
      },
      editTextIfRevision: (text: string, revision: number) => {
        if (!active || !writes.includes('text')) throw new Error(`Module ${owner} cannot write text`);
        this.assertEditable();
        const snapshot = this.snapshot;
        if (snapshot.revision !== revision || snapshot.pending || snapshot.unconfirmed || snapshot.blocks.length) return false;
        const next = { ...snapshot, text, revision: snapshot.revision + 1 };
        this.persist(next);
        this.publish(next);
        return true;
      },
      block: (reason: string) => {
        this.assertEditable();
        if (!active || (!writes.includes('text') && !canBlock())) throw new Error('Module cannot block this draft');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('A draft block needs a reason');
        const id = `block-${draftIdentity()}`;
        this.blockOwners.set(id, owner);
        this.publish({ blocks: [...this.snapshot.blocks, Object.freeze({ id, reason })] });
        return () => {
          if (this.blockOwners.get(id) !== owner) return;
          this.blockOwners.delete(id);
          this.publish({ blocks: this.snapshot.blocks.filter(block => block.id !== id) });
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
      const removed = new Set([...this.blockOwners].filter(([, value]) => value === owner).map(([id]) => id));
      for (const id of removed) this.blockOwners.delete(id);
      if (removed.size) this.publish({ blocks: this.snapshot.blocks.filter(block => !removed.has(block.id)) });
    } };
  }
  private assertSubmission(token: string): void {
    if (this.retired && this.reference.purpose.kind === 'prompt') throw new Error('This prompt draft has retired');
    if (this.pendingToken !== token || !this.snapshot.pending) throw new Error('Stale draft submission token');
    if (this.storage) {
      const bytes = this.storage.getItem(this.key);
      const current: unknown = bytes === null ? undefined : JSON.parse(bytes);
      if (!draftRecord(current) || !draftRecord(current[META]) || current[META].pendingToken !== token) {
        throw new Error('Saved draft submission token has changed');
      }
      if (bytes !== this.storedBytes) throw new Error('Saved draft root has changed in another instance');
    }
  }
  private begin(token: string, encoded: ReadonlyMap<string, string>): void {
    const next = { ...this.snapshot, pending: true, unconfirmed: false };
    this.persist(next, token, encoded);
    this.pendingToken = token;
    this.publish(next);
  }
  private finish(token: string, acknowledged: boolean, revision?: number): boolean {
    try { this.assertSubmission(token); }
    catch (error) {
      if (this.pendingToken === token) {
        this.pendingToken = undefined;
        this.publish({ pending: false, unconfirmed: true });
      }
      this.report(error);
      return false;
    }
    const next = { ...this.snapshot, pending: false, unconfirmed: !acknowledged,
      ...(acknowledged && revision === this.snapshot.revision ? { text: '', revision: revision + 1 } : {}),
    };
    try { this.persist(next, null); }
    catch (error) {
      this.pendingToken = undefined;
      this.publish({ pending: false, unconfirmed: true });
      this.report(error);
      return false;
    }
    this.pendingToken = undefined;
    this.publish(next);
    return acknowledged;
  }
  private allowed(check: () => boolean): boolean {
    this.assertEditable();
    if (!check()) throw new Error('The native draft/request is no longer current');
    return !this.snapshot.pending;
  }
  runAction = async (send: () => Promise<boolean> | undefined, check = () => true): Promise<boolean> => {
    const token = `action-${draftIdentity()}`;
    try {
      if (!this.allowed(check)) return false;
      this.begin(token, new Map());
      if (!check()) throw new Error('The native decision has changed');
      const acknowledged = (await send()) === true;
      return this.finish(token, acknowledged);
    } catch (error) {
      this.report(error);
      if (this.pendingToken === token) this.finish(token, false);
      return false;
    }
  };
  send = async (send: (request: NativeDraftRequest) => Promise<boolean>, check = () => true): Promise<boolean> => {
    let submission: DraftSubmission | undefined;
    try {
      if (!this.allowed(check) || this.snapshot.blocks.length || !this.snapshot.hasContent) return false;
      submission = Object.freeze({ id: `send-${draftIdentity()}`, draft: this.reference, base: this.snapshot });
      const fields: Record<string, unknown> = Object.create(null);
      const captured: CapturedField[] = [];
      const encoded = new Map<string, string>();
      let fieldContent = false;
      for (const field of this.fields.values()) {
        if (!field.active) continue;
        const projected = field.project(submission);
        if (projected === undefined) continue;
        if (!draftRecord(projected) || 'then' in projected) throw new Error('Draft projection must synchronously return native fields');
        const keys = Object.keys(projected);
        if (!keys.length) continue;
        for (const key of keys) {
          if (CORE_DRAFT_FIELDS.has(key)) throw new Error(`Draft schema cannot overwrite native field ${key}`);
          if (Object.hasOwn(fields, key)) throw new Error(`Conflicting draft field projection: ${key}`);
          Object.defineProperty(fields, key, { value: projected[key], enumerable: true });
        }
        captured.push({ field, acknowledge: field.captureAck(submission) });
        if (field.encoded !== undefined) encoded.set(field.namespace, field.encoded);
        fieldContent ||= field.hasContent;
      }
      const text = submission.base.text.trim();
      if (!text && !fieldContent) throw new Error('The draft has no projected native content');
      const request = immutableDraftData(nativeDraftRequest(this.reference, text, fields));
      this.begin(submission.id, encoded);
      if (!check()) throw new Error('The native draft/request changed before dispatch');
      const acknowledged = (await send(request)) === true;
      this.assertSubmission(submission.id);
      let complete = acknowledged;
      if (acknowledged) for (const entry of captured) {
        try {
          if (!entry.field.active || this.fields.get(entry.field.namespace) !== entry.field) throw new Error('Stale draft schema ACK generation');
          entry.acknowledge();
        } catch (error) { complete = false; this.report(error); }
      }
      // Native success still owns this text revision even if one field's cleanup failed.
      const result = this.finish(submission.id, acknowledged, acknowledged ? submission.base.revision : undefined);
      if (result && !complete) {
        const next = { ...this.snapshot, unconfirmed: true };
        try { this.persist(next); } catch (error) { this.report(error); }
        this.publish(next);
      }
      return result && complete;
    } catch (error) {
      this.report(error);
      if (submission && this.pendingToken === submission.id) this.finish(submission.id, false);
      return false;
    }
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

export { getSessionDraft } from './draftSelection';
