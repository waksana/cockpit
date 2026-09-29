import type {
  DraftAskContext, DraftNativeFields, DraftPurpose, DraftReference, DraftRestoreInput, DraftSubmission,
  DraftWrite, ModuleDraft, ModuleDraftSnapshot,
  CapturedDraftSend, DraftSendBlockReason, DraftSendResult,
  DraftOwner, DraftOwnerFacts, DraftOwnerOptions, DraftSubmissionSnapshot, DraftTransportOutcome,
} from '@cockpit/module-api/frontend';
import { CORE_DRAFT_FIELDS, nativeDraftRequest, type NativeDraftRequest } from './draft';
import { describeReason, reportUxError } from './errorReporter';
import { captureLocalSubmission } from './localSubmission';

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type DraftReport = (error: unknown) => void;
const reportDraft: DraftReport = error => reportUxError(`草稿操作未完成：${describeReason(error, false)}`);
const references = new WeakMap<DraftReference, DraftCore>();
let schemaHookDepth = 0;
export const draftIdentity = () => globalThis.crypto.randomUUID();
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

export function resolveDraft(reference: DraftReference): DraftCore {
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
  restoreAck(submission: DraftSubmission, encoded: string): () => void;
}

interface CapturedField {
  field: DraftField;
  acknowledge(): void;
}

export interface DraftSubmissionTransport {
  check(): DraftSendBlockReason | undefined;
  send?(request: NativeDraftRequest): Promise<boolean>;
}

interface DraftAdapter {
  prepare(snapshot: DraftSubmissionSnapshot): unknown;
  validateRequest(value: unknown): unknown;
  validateReceipt(value: unknown): unknown;
  send(request: unknown): Promise<DraftTransportOutcome<unknown>>;
  inspect(request: unknown): Promise<DraftTransportOutcome<unknown>>;
  settle(request: unknown, receipt: unknown): void;
  readonly native?: boolean;
}
interface Transaction {
  readonly version: 1;
  readonly occurrence: string;
  readonly id: string;
  readonly request: unknown;
  readonly base: ModuleDraftSnapshot;
  readonly fields: readonly { readonly namespace: string; readonly encoded?: string }[];
  readonly status: 'prepared' | 'unknown' | 'accepted' | 'settled' | 'rejected';
  readonly receipt?: unknown;
  readonly acknowledged: readonly string[];
  readonly textSettled: boolean;
  readonly ownerSettled: boolean;
}

/** JSON is also the durable wire format: reject lossy coercion before dispatch. */
function durableData<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Draft transactions require finite acyclic JSON data');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Draft transactions require plain JSON data');
  }
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Draft transaction symbols cannot be persisted');
  if (Array.isArray(value) && (Object.keys(value).length !== value.length
    || Object.keys(value).some((key, index) => key !== String(index)))) throw new Error('Draft transaction arrays must be dense JSON arrays');
  ancestors.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set || !descriptor.enumerable && !Array.isArray(value)) throw new Error('Invalid draft transaction property');
    durableData(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return value;
}
function copyDurable<T>(value: T): T {
  durableData(value);
  return immutableDraftData(JSON.parse(JSON.stringify(value)) as T);
}
function validatedData(value: unknown, validate: (value: unknown) => unknown): unknown {
  const result = copyDurable(validate(copyDurable(value)));
  if (!sameData(result, value)) throw new Error('Draft validator changed durable data');
  return result;
}
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameData(item, right[index]));
  if (!draftRecord(left) || !draftRecord(right)) return false;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}
function transportOutcome(value: unknown): DraftTransportOutcome<unknown> {
  if (!draftRecord(value)) throw new Error('Invalid draft transport outcome');
  if (value.status === 'accepted' && Object.hasOwn(value, 'receipt')
    && Object.keys(value).every(key => ['status', 'receipt'].includes(key))) return { status: 'accepted', receipt: value.receipt };
  if ((value.status === 'rejected' || value.status === 'unknown') && typeof value.reason === 'string'
    && Object.keys(value).every(key => ['status', 'reason'].includes(key))) return { status: value.status, reason: value.reason };
  throw new Error('Invalid draft transport outcome');
}
function facts(input: DraftOwnerFacts): DraftOwnerFacts {
  if (!draftRecord(input) || typeof input.editable !== 'boolean' || typeof input.submittable !== 'boolean'
    || Object.keys(input).some(key => !['editable', 'submittable', 'capabilities', 'actionRevision', 'askContext', 'referenceText'].includes(key))
    || !Number.isSafeInteger(input.actionRevision) || input.actionRevision < 0
    || !draftRecord(input.capabilities) || typeof input.capabilities.attachments !== 'boolean'
    || Object.keys(input.capabilities).some(key => key !== 'attachments')
    || (input.referenceText !== undefined && typeof input.referenceText !== 'string')
    || (input.askContext !== undefined && (!draftRecord(input.askContext) || typeof input.askContext.question !== 'string'
      || (input.askContext.choices !== undefined && (!Array.isArray(input.askContext.choices)
        || input.askContext.choices.some(choice => typeof choice !== 'string')))))) throw new Error('Invalid draft owner facts');
  return immutableDraftData({
    editable: input.editable, submittable: input.submittable, actionRevision: input.actionRevision,
    capabilities: { attachments: input.capabilities.attachments },
    ...(input.askContext ? { askContext: { question: input.askContext.question,
      ...(input.askContext.choices ? { choices: [...input.askContext.choices] } : {}) } } : {}),
    ...(input.referenceText !== undefined ? { referenceText: [...input.referenceText].slice(-1000).join('') } : {}),
  });
}

class BlockedDraftSend extends Error {
  readonly reason: DraftSendBlockReason;
  constructor(reason: DraftSendBlockReason) { super(`Draft submission blocked: ${reason}`); this.reason = reason; }
}
const blockedSend = (reason: DraftSendBlockReason): DraftSendResult => Object.freeze({ status: 'blocked', reason });

export class DraftCore {
  private snapshot: ModuleDraftSnapshot = Object.freeze({
    text: '', blocks: Object.freeze([]), hasContent: false, revision: 0, pending: false, unconfirmed: false, retired: false,
    editable: true, submittable: true, capabilities: Object.freeze({ attachments: true }), actionRevision: 0,
  });
  private readonly listeners = new Set<() => void>();
  private readonly blockOwners = new Map<string, string>();
  private readonly fields = new Map<string, DraftField>();
  private readonly legacyRestorers = new Set<string>();
  private persistedText = '';
  private persistedUnconfirmed = false;
  private record?: Record<string, unknown>;
  private storedBytes: string | null = null;
  private readError?: unknown;
  private pendingToken?: string;
  private transaction?: Transaction;
  private occurrence: string = draftIdentity();
  private suspended = false;
  private reconciling = false;
  private retired = false;
  private notificationDepth = 0;
  private notificationPending = false;
  private fieldRevision = 0;
  private submissionRevision = 0;
  private readonly textEdits = new Map<string, number>();
  readonly reference: DraftReference;
  readonly sessionId?: string;
  private readonly storage?: DraftStorage;
  private readonly key: string;
  private readonly report: DraftReport;
  private readonly adapter?: DraftAdapter;

  constructor(
    options: { sessionId?: string; storage?: DraftStorage; purpose: DraftPurpose; key: string;
      report?: DraftReport; facts?: DraftOwnerFacts; adapter?: DraftAdapter },
  ) {
    const { sessionId, storage, purpose, key, report = reportDraft } = options;
    this.sessionId = sessionId;
    this.storage = storage;
    this.key = key;
    this.report = report;
    this.adapter = options.adapter;
    this.snapshot = Object.freeze({ ...this.snapshot,
      capabilities: Object.freeze({ attachments: purpose.kind === 'prompt' }),
      ...(options.facts ? facts(options.facts) : {}),
    });
    this.reference = Object.freeze({
      id: `draft-${draftIdentity()}`, ...(sessionId ? { sessionId } : {}), purpose: Object.freeze({ ...purpose }),
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
      if (meta.retired === true) {
        // Preserve dispatched evidence before replacing a retired logical occurrence.
        storage?.setItem(`${key}:retired:${String(meta.occurrence)}`, stored);
        this.record = undefined;
        this.persist(this.snapshot, null);
        return;
      }
      if (typeof meta.occurrence === 'string') this.occurrence = meta.occurrence;
      if (meta.transaction !== undefined) this.transaction = this.readTransaction(meta.transaction);
      this.snapshot = Object.freeze({ ...this.snapshot, text: value.text, hasContent: !!value.text.trim(),
        revision: typeof meta.revision === 'number' ? meta.revision : 0,
        actionRevision: Math.max(this.snapshot.actionRevision, typeof meta.actionRevision === 'number' ? meta.actionRevision : 0),
        unconfirmed: value.unconfirmed || meta.pendingToken !== undefined
          || !!(this.transaction && !['settled', 'rejected'].includes(this.transaction.status)),
        ...(this.transaction && !['settled', 'rejected'].includes(this.transaction.status) ? { submissionId: this.transaction.id } : {}),
      });
      this.persistedText = this.snapshot.text;
      this.persistedUnconfirmed = this.snapshot.unconfirmed;
      // Claim a new runtime generation before exposing the restored controller.
      // An old completion whose successor has only read storage is still stale.
      this.persist(this.snapshot, typeof meta.pendingToken === 'string' ? meta.pendingToken : null);
    } catch (error) { this.readError = error; this.report(error); }
  }

  getSnapshot = (): ModuleDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  isRetired(): boolean { return this.retired; }
  supportsOwner(): boolean { return !!this.adapter; }
  hasAcceptedSubmission(): boolean { return this.transaction?.status === 'accepted'; }
  protected hasAcceptedRequest(request: unknown): boolean {
    return this.transaction?.status === 'accepted' && this.transaction.receipt === true
      && sameData(this.transaction.request, request);
  }
  suspend(): void {
    this.suspended = true;
    this.publish({ editable: false, submittable: false });
  }
  updateFacts(input: DraftOwnerFacts): void {
    if (this.retired || this.suspended) throw new Error('Draft owner has stopped');
    const next = facts(input);
    if (next.actionRevision < this.snapshot.actionRevision) throw new Error('Draft action revision cannot go backwards');
    if (next.actionRevision === this.snapshot.actionRevision && next.editable === this.snapshot.editable
      && next.submittable === this.snapshot.submittable && sameData(next.capabilities, this.snapshot.capabilities)
      && sameData(next.askContext, this.snapshot.askContext) && next.referenceText === this.snapshot.referenceText) return;
    if (next.actionRevision !== this.snapshot.actionRevision) this.persist({ ...this.snapshot, ...next });
    this.publish({ ...next, askContext: next.askContext, referenceText: next.referenceText });
  }
  hasUnpersistedChanges(): boolean {
    return this.snapshot.text !== this.persistedText || this.snapshot.unconfirmed !== this.persistedUnconfirmed;
  }
  hasUnclaimedStoredData(): boolean {
    if (this.readError) return true;
    if (!this.record) return false;
    const meta = this.metadata();
    const owns = (namespace: string) => {
      const field = this.fields.get(namespace);
      return field?.active && field.encoded !== undefined;
    };
    if (Object.keys((meta.schemas ?? {}) as Record<string, unknown>).some(namespace => !owns(namespace))) return true;
    if (Object.keys(meta).some(key => !['version', 'purpose', 'pendingToken', 'schemas',
      'occurrence', 'generation', 'revision', 'actionRevision', 'transaction', 'retired'].includes(key))) return true;
    const purposeKeys = this.reference.purpose.kind === 'prompt' ? ['kind'] : ['kind', 'requestId'];
    if (draftRecord(meta.purpose) && Object.keys(meta.purpose).some(key => !purposeKeys.includes(key))) return true;
    // The existing persistence.restore contract owns the complete legacyRecord,
    // not individually declared legacy keys. Only a live restoring field may
    // interpret it; merely sharing a module prefix does not own a namespace.
    return Object.keys(this.record).some(key => !['text', 'unconfirmed', META].includes(key))
      && ![...this.legacyRestorers].some(owns);
  }
  setAskContext(context?: DraftAskContext): void {
    const next = !this.retired && this.reference.purpose.kind === 'ask' ? context : undefined;
    const previous = this.snapshot.askContext;
    if (previous?.question === next?.question
      && JSON.stringify(previous?.choices) === JSON.stringify(next?.choices)) return;
    this.publish({ askContext: next === undefined ? undefined : immutableDraftData({
      question: next.question, ...(next.choices === undefined ? {} : { choices: [...next.choices] }),
    }) });
  }
  retire(): void {
    if (this.retired) return;
    try { this.persist({ ...this.snapshot, retired: true, editable: false, submittable: false }); }
    catch (error) { this.report(error); if (this.adapter) throw error; }
    this.retired = true;
    this.publish({ retired: true, editable: false, submittable: false, askContext: undefined });
  }
  assertEditable(): void {
    this.assertActive();
    if (!this.snapshot.editable) throw new Error('This draft is read-only');
  }
  private assertActive(): void {
    if (this.retired) throw new Error('This draft has retired');
    if (this.suspended) throw new Error('This draft runtime has stopped');
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
      || (meta.occurrence !== undefined && (typeof meta.occurrence !== 'string' || !meta.occurrence))
      || (meta.generation !== undefined && (typeof meta.generation !== 'string' || !meta.generation))
      || (meta.revision !== undefined && (!Number.isSafeInteger(meta.revision) || Number(meta.revision) < 0))
      || (meta.actionRevision !== undefined && (!Number.isSafeInteger(meta.actionRevision) || Number(meta.actionRevision) < 0))
      || (meta.retired !== undefined && typeof meta.retired !== 'boolean')
      || (meta.schemas !== undefined && !draftRecord(meta.schemas))) throw new Error('Invalid draft scope or submission checkpoint');
    return meta;
  }
  private readTransaction(value: unknown): Transaction {
    if (!draftRecord(value) || value.version !== 1 || value.occurrence !== this.occurrence
      || typeof value.id !== 'string' || !value.id || !Object.hasOwn(value, 'request')
      || !draftRecord(value.base) || typeof value.base.text !== 'string'
      || !Number.isSafeInteger(value.base.revision) || Number(value.base.revision) < 0
      || !Number.isSafeInteger(value.base.actionRevision) || Number(value.base.actionRevision) < 0
      || typeof value.base.editable !== 'boolean' || typeof value.base.submittable !== 'boolean'
      || !draftRecord(value.base.capabilities) || typeof value.base.capabilities.attachments !== 'boolean'
      || Object.keys(value.base.capabilities).some(key => key !== 'attachments')
      || value.base.pending !== false || value.base.unconfirmed !== false || value.base.retired !== false
      || typeof value.base.hasContent !== 'boolean' || !Array.isArray(value.base.blocks) || value.base.blocks.length !== 0
      || Object.keys(value.base).some(key => !['text', 'revision', 'actionRevision', 'editable', 'submittable',
        'capabilities', 'blocks', 'pending', 'unconfirmed', 'retired', 'hasContent'].includes(key))
      || !Array.isArray(value.fields) || !Array.isArray(value.acknowledged)
      || value.acknowledged.some(entry => typeof entry !== 'string')
      || typeof value.textSettled !== 'boolean' || typeof value.ownerSettled !== 'boolean'
      || !['prepared', 'unknown', 'accepted', 'settled', 'rejected'].includes(String(value.status))) {
      throw new Error('Invalid durable draft transaction');
    }
    const fields = value.fields.map((entry: unknown) => {
      if (!draftRecord(entry) || typeof entry.namespace !== 'string' || !entry.namespace
        || (entry.encoded !== undefined && typeof entry.encoded !== 'string')
        || Object.keys(entry).some(key => !['namespace', 'encoded'].includes(key))) throw new Error('Invalid captured draft field');
      return { namespace: entry.namespace, ...(typeof entry.encoded === 'string' ? { encoded: entry.encoded } : {}) };
    });
    if (new Set(fields.map(field => field.namespace)).size !== fields.length
      || value.acknowledged.some(namespace => !fields.some(field => field.namespace === namespace))
      || new Set(value.acknowledged).size !== value.acknowledged.length
      || Object.keys(value).some(key => !['version', 'occurrence', 'id', 'request', 'base', 'fields', 'status',
        'receipt', 'acknowledged', 'textSettled', 'ownerSettled'].includes(key))
      || (['accepted', 'settled'].includes(String(value.status)) && !Object.hasOwn(value, 'receipt'))) {
      throw new Error('Invalid draft settlement checkpoints');
    }
    durableData(value);
    // Full immutable snapshot was captured by this core. Only the content/revision
    // and facts above grant settlement authority; never trust stored pending flags.
    return immutableDraftData({
      version: 1, occurrence: this.occurrence, id: value.id, request: value.request,
      base: { text: value.base.text, revision: Number(value.base.revision), actionRevision: Number(value.base.actionRevision),
        editable: value.base.editable, submittable: value.base.submittable,
        capabilities: { attachments: value.base.capabilities.attachments },
        blocks: [], pending: false, unconfirmed: false, retired: false, hasContent: value.base.hasContent },
      fields, status: value.status as Transaction['status'],
      ...(Object.hasOwn(value, 'receipt') ? { receipt: value.receipt } : {}),
      acknowledged: value.acknowledged as string[], textSettled: value.textSettled, ownerSettled: value.ownerSettled,
    });
  }
  private persist(
    snapshot: ModuleDraftSnapshot,
    token: string | null = this.pendingToken ?? null,
    encoded: ReadonlyMap<string, string> = new Map(),
    transaction: Transaction | undefined = this.transaction,
  ): void {
    if (this.readError) throw this.readError;
    if (this.storage && this.storage.getItem(this.key) !== this.storedBytes) {
      throw new Error('Saved draft root has changed in another instance');
    }
    const previous = this.metadata();
    const schemas = { ...(previous.schemas as Record<string, unknown> | undefined) };
    for (const [namespace, value] of encoded) Object.defineProperty(schemas, namespace, { value, enumerable: true, configurable: true, writable: true });
    const meta: Record<string, unknown> = {
      ...previous, version: 1, purpose: { ...(previous.purpose as Record<string, unknown> | undefined), ...this.reference.purpose },
      occurrence: this.occurrence, generation: this.reference.id,
      revision: snapshot.revision, actionRevision: snapshot.actionRevision,
      ...(snapshot.retired ? { retired: true } : {}),
      ...(transaction ? { transaction } : {}),
      ...(Object.keys(schemas).length ? { schemas } : {}),
    };
    if (token) meta.pendingToken = token;
    else delete meta.pendingToken;
    const next = { ...this.record, text: snapshot.text, unconfirmed: snapshot.unconfirmed || !!token, [META]: meta };
    const bytes = JSON.stringify(next);
    this.storage?.setItem(this.key, bytes);
    this.record = immutableDraftData(next);
    this.storedBytes = bytes;
    if (this.storage) {
      this.persistedText = snapshot.text;
      this.persistedUnconfirmed = snapshot.unconfirmed;
    }
    this.transaction = transaction;
  }
  restoreInput(namespace: string): DraftRestoreInput | undefined {
    if (this.readError) throw this.readError;
    if (!this.record) return undefined;
    this.legacyRestorers.add(namespace);
    const schemas = this.metadata().schemas as Record<string, unknown> | undefined;
    return Object.freeze({
      stored: schemas && Object.hasOwn(schemas, namespace)
        ? Object.freeze({ present: true as const, value: schemas[namespace] }) : Object.freeze({ present: false as const }),
      // Generic business requests/receipts stay private to their owner. Legacy
      // extension fields remain available for migration and untouched on disk.
      legacyRecord: this.sessionId ? this.record
        : immutableDraftData(Object.fromEntries(Object.entries(this.record).filter(([key]) => key !== META))),
    });
  }
  assertCanAttach(field: DraftField): void {
    const previous = this.fields.get(field.namespace);
    if (previous && previous !== field) throw new Error(`Draft schema namespace already active: ${field.namespace}`);
  }
  attachField(field: DraftField): void {
    this.assertCanAttach(field);
    this.fields.set(field.namespace, field);
    this.fieldRevision++;
    this.publish();
  }
  detachField(field: DraftField): void {
    if (this.fields.get(field.namespace) !== field) return;
    this.fields.delete(field.namespace);
    this.fieldRevision++;
    this.publish();
  }
  commitField(field: DraftField, encoded: string | undefined, commit: () => void, submission?: DraftSubmission): void {
    if (!field.active || this.fields.get(field.namespace) !== field) throw new Error('Draft schema generation has stopped');
    if (submission) this.assertSubmission(submission.id);
    else this.assertEditable();
    const transaction = submission && this.transaction?.id === submission.id
      ? { ...this.transaction, acknowledged: [...this.transaction.acknowledged, field.namespace] } : this.transaction;
    if (encoded !== undefined || transaction !== this.transaction) this.persist(this.snapshot, this.pendingToken,
      encoded === undefined ? new Map() : new Map([[field.namespace, encoded]]), transaction);
    commit();
    this.fieldRevision++;
    this.publish();
  }
  edit = (text: string, owner?: string): void => {
    this.assertEditable();
    const next = { ...this.snapshot, text, revision: this.snapshot.revision + 1 };
    try { this.persist(next); } catch (error) { this.report(error); }
    if (owner) this.textEdits.set(owner, (this.textEdits.get(owner) ?? 0) + 1);
    this.publish(next);
  };
  dismissNotice = (): void => {
    if (this.transaction && (this.transaction.status === 'accepted'
      || (this.adapter && !['settled', 'rejected'].includes(this.transaction.status)))) {
      this.report(new Error('This submission requires explicit receipt reconciliation'));
      return;
    }
    const next = { ...this.snapshot, unconfirmed: false };
    try { this.persist(next); } catch (error) { this.report(error); return; }
    this.publish(next);
  };
  bindModule(owner: string, writes: readonly DraftWrite[], report: DraftReport = this.report, canBlock = () => false,
    transport?: DraftSubmissionTransport): { draft: ModuleDraft; dispose(): void } {
    let active = true;
    const subscriptions = new Set<() => void>();
    const draft: ModuleDraft = Object.freeze({
      ...this.reference,
      getSnapshot: () => {
        if (!active) throw new Error('Module draft binding has been revoked');
        return this.snapshot;
      },
      subscribe: (listener: () => void) => {
        if (!active) return () => {};
        const unsubscribe = this.subscribe(() => { try { listener(); } catch (error) { report(error); } });
        subscriptions.add(unsubscribe);
        return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
      },
      editText: (text: string) => {
        if (!active || !writes.includes('text')) throw new Error(`Module ${owner} cannot write text`);
        this.edit(text, owner);
      },
      editTextIfRevision: (text: string, revision: number) => {
        if (!active || !writes.includes('text')) throw new Error(`Module ${owner} cannot write text`);
        this.assertEditable();
        const snapshot = this.snapshot;
        if (snapshot.revision !== revision || snapshot.pending || snapshot.unconfirmed || snapshot.blocks.length) return false;
        const next = { ...snapshot, text, revision: snapshot.revision + 1 };
        this.persist(next);
        this.textEdits.set(owner, (this.textEdits.get(owner) ?? 0) + 1);
        this.publish(next);
        return true;
      },
      captureSend: (): CapturedDraftSend => {
        if (!active || !transport) throw new Error(`Module ${owner} cannot send this draft`);
        if (!this.adapter && !transport.send) throw new Error('Native draft transport is unavailable');
        this.assertEditable();
        const unavailable = transport.check();
        if (unavailable) throw new BlockedDraftSend(unavailable);
        const fields = this.fieldRevision, attempts = this.submissionRevision;
        const action = this.snapshot.actionRevision;
        const externalText = this.snapshot.revision - (this.textEdits.get(owner) ?? 0);
        let result: Promise<DraftSendResult> | undefined, cancelled = false;
        return Object.freeze({
          cancel: () => { cancelled = true; },
          send: (expectedRevision: number) => {
            result ??= Promise.resolve().then(() => this.submit(this.adapter ?? this.nativeAdapter(transport.send), () => true, ownPending => {
              if (!active) return 'revoked';
              if (this.retired) return 'retired';
              if (cancelled) return 'cancelled';
              if (this.snapshot.revision !== expectedRevision) return 'revision-mismatch';
              if (this.snapshot.revision - (this.textEdits.get(owner) ?? 0) !== externalText) return 'draft-changed';
              if (this.fieldRevision !== fields || this.submissionRevision !== attempts + (ownPending ? 1 : 0)) return 'draft-changed';
              if (this.snapshot.actionRevision !== action) return 'draft-changed';
              if (this.snapshot.pending && !ownPending) return 'pending';
              if (this.snapshot.unconfirmed) return 'unconfirmed';
              if (this.snapshot.blocks.length) return 'peer-blocked';
              return transport.check();
            }));
            return result;
          },
        });
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
    if (this.suspended || (this.retired && (!this.sessionId || this.reference.purpose.kind === 'prompt'))) throw new Error('This draft has retired or stopped');
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
  private begin(token: string, encoded: ReadonlyMap<string, string>, transaction?: Transaction): void {
    const next = { ...this.snapshot, pending: true, unconfirmed: false, submissionId: token };
    this.persist(next, token, encoded, transaction);
    this.pendingToken = token;
    this.submissionRevision++;
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
    const next = { ...this.snapshot, pending: false, unconfirmed: !acknowledged, submissionId: undefined,
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
    this.assertActive();
    if (!check()) throw new Error('The native draft/request is no longer current');
    return !this.snapshot.pending;
  }
  runAction = async (send: () => Promise<boolean> | undefined, check = () => true): Promise<boolean> => {
    const token = `action-${draftIdentity()}`;
    try {
      if (!this.allowed(check)) return false;
      if (this.hasUnclaimedStoredData()) throw new Error('草稿包含尚未由已加载模块恢复的数据；请启用对应模块恢复后再提交。');
      this.begin(token, new Map());
      if (!check()) throw new Error('The native decision has changed');
      if (this.hasUnclaimedStoredData()) throw new Error('Draft schema ownership changed before dispatch');
      const acceptedInView = this.sessionId ? captureLocalSubmission(this.sessionId) : () => {};
      const acknowledged = (await send()) === true;
      if (acknowledged) acceptedInView();
      return this.finish(token, acknowledged);
    } catch (error) {
      this.report(error);
      if (this.pendingToken === token) this.finish(token, false);
      return false;
    }
  };
  protected nativeAdapter(_send?: (request: NativeDraftRequest) => Promise<boolean>): DraftAdapter {
    throw new Error('This draft has no native submission adapter');
  }
  send = async (send: (request: NativeDraftRequest) => Promise<boolean>, check = () => true): Promise<boolean> =>
    (await this.submit(this.nativeAdapter(send), check)).status === 'acknowledged';
  ownerSubmit = async (): Promise<DraftSendResult> => {
    if (!this.adapter) throw new Error('This draft has no owner adapter');
    return this.submit(this.adapter, () => !this.suspended);
  };

  private submit = async (adapter: DraftAdapter, check: () => boolean,
    guard?: (ownPending: boolean) => DraftSendBlockReason | undefined): Promise<DraftSendResult> => {
    let submission: DraftSubmission | undefined;
    let dispatched = false, acknowledged = false;
    let failure: DraftSendBlockReason = 'projection-failed';
    try {
      const blocked = guard?.(false);
      if (blocked) return blockedSend(blocked);
      if (this.suspended) return blockedSend('revoked');
      if (this.retired) return blockedSend('retired');
      if (!this.snapshot.editable) return blockedSend('read-only');
      if (!this.snapshot.submittable) return blockedSend('unavailable');
      if (this.snapshot.unconfirmed || this.transaction?.status === 'accepted') return blockedSend('unconfirmed');
      if (!this.allowed(check)) return blockedSend('pending');
      if (this.hasUnclaimedStoredData()) {
        throw new Error('草稿包含尚未由已加载模块恢复的数据；请启用对应模块恢复后再提交。');
      }
      if (this.snapshot.blocks.length) return blockedSend('peer-blocked');
      if (!this.snapshot.hasContent) return blockedSend('empty');
      submission = Object.freeze({ id: `send-${draftIdentity()}`, draft: this.reference, base: this.snapshot });
      const checkpoint = this.fieldRevision;
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
        if (Object.hasOwn(projected, 'attachments') && !submission.base.capabilities.attachments) {
          throw new BlockedDraftSend('unsupported');
        }
        if (!adapter.native && field.encoded === undefined) throw new Error('Generic submitted fields require durable schema persistence');
        captured.push({ field, acknowledge: field.captureAck(submission) });
        if (field.encoded !== undefined) encoded.set(field.namespace, field.encoded);
        fieldContent ||= field.hasContent;
      }
      const text = submission.base.text.trim();
      if (!text && !fieldContent) throw new Error('The draft has no projected native content');
      const request = validatedData(adapter.prepare(Object.freeze({ ...submission, text, fields: immutableDraftData(fields) })),
        adapter.validateRequest);
      const unchanged = () => this.snapshot.revision === submission!.base.revision
        && this.snapshot.actionRevision === submission!.base.actionRevision && this.fieldRevision === checkpoint
        && this.snapshot.editable && this.snapshot.submittable && !this.retired && !this.suspended;
      const contentGate = (): DraftSendBlockReason | undefined => {
        if (this.snapshot.blocks.length) return 'peer-blocked';
        if (Object.hasOwn(fields, 'attachments') && !this.snapshot.capabilities.attachments) return 'unsupported';
      };
      const beforePersistence = contentGate();
      if (beforePersistence) return blockedSend(beforePersistence);
      if (!unchanged()) return blockedSend('draft-changed');
      // Optional context is not persisted: it confers no submission authority.
      const base: ModuleDraftSnapshot = {
        text: submission.base.text, revision: submission.base.revision, actionRevision: submission.base.actionRevision,
        editable: submission.base.editable, submittable: submission.base.submittable,
        capabilities: submission.base.capabilities, blocks: [], pending: false, unconfirmed: false,
        retired: false, hasContent: submission.base.hasContent,
      };
      const transaction: Transaction = copyDurable({
        version: 1, occurrence: this.occurrence, id: submission.id, request, base,
        fields: captured.map(({ field }) => ({ namespace: field.namespace,
          ...(field.encoded !== undefined ? { encoded: field.encoded } : {}) })),
        status: 'prepared', acknowledged: [], textSettled: false, ownerSettled: false,
      });
      failure = 'persistence-failed';
      if (!adapter.native && !this.storage) throw new Error('Persistent draft storage is unavailable');
      this.begin(submission.id, encoded, transaction);
      const changed = guard?.(true);
      if (changed) throw new BlockedDraftSend(changed);
      const beforeDispatch = contentGate();
      if (beforeDispatch) throw new BlockedDraftSend(beforeDispatch);
      if (!unchanged()) throw new BlockedDraftSend('draft-changed');
      if (!check()) throw new Error('The native draft/request changed before dispatch');
      if (this.hasUnclaimedStoredData()) throw new Error('Draft schema ownership changed before dispatch');
      dispatched = true;
      const acceptedInView = this.sessionId ? captureLocalSubmission(this.sessionId) : () => {};
      const outcome = transportOutcome(await adapter.send(request));
      if (outcome?.status === 'accepted') {
        acknowledged = true;
        acceptedInView();
        this.assertSubmission(submission.id);
        const receipt = validatedData(outcome.receipt, adapter.validateReceipt);
        this.assertSubmission(submission.id);
        this.persist(this.snapshot, this.pendingToken, new Map(), { ...transaction, status: 'accepted', receipt });
        return this.settle(adapter, submission, captured);
      }
      this.assertSubmission(submission.id);
      if (outcome?.status === 'rejected' && typeof outcome.reason === 'string') {
        this.completeTransaction('rejected', false);
        return Object.freeze({ status: 'rejected', reason: outcome.reason });
      }
      this.completeTransaction('unknown', true);
      return Object.freeze({ status: 'unconfirmed', reason: adapter.native ? 'native-unconfirmed' : 'transport-unconfirmed' });
    } catch (error) {
      if (!(error instanceof BlockedDraftSend)) this.report(error);
      if (submission && this.pendingToken === submission.id) {
        if (!dispatched) {
          const next = { ...this.snapshot, pending: false, unconfirmed: submission.base.unconfirmed };
          try { this.persist(next, null, new Map(), this.transaction ? { ...this.transaction, status: 'rejected' } : undefined); }
          catch (error) { next.unconfirmed = true; this.report(error); }
          this.pendingToken = undefined;
          this.publish(next);
        } else {
          try { this.completeTransaction(this.transaction?.status === 'accepted' ? 'accepted' : 'unknown', true); }
          catch (error) { this.pendingToken = undefined; this.publish({ pending: false, unconfirmed: true }); this.report(error); }
        }
      }
      return dispatched ? Object.freeze({ status: 'unconfirmed', reason: acknowledged ? 'settlement-failed'
        : adapter.native ? 'native-unconfirmed' : 'transport-unconfirmed' })
        : blockedSend(error instanceof BlockedDraftSend ? error.reason : failure);
    }
  };

  private completeTransaction(status: Transaction['status'], unconfirmed: boolean): void {
    if (this.pendingToken) this.assertSubmission(this.pendingToken);
    const next = { ...this.snapshot, pending: false, unconfirmed,
      submissionId: unconfirmed ? this.transaction?.id : undefined };
    this.persist(next, null, new Map(), this.transaction ? { ...this.transaction, status } : undefined);
    this.pendingToken = undefined;
    this.publish(next);
  }
  private settle(adapter: DraftAdapter, submission: DraftSubmission, captured: readonly CapturedField[]): DraftSendResult {
    this.assertSubmission(submission.id);
    let complete = true;
    for (const entry of captured) {
      if (this.transaction!.acknowledged.includes(entry.field.namespace)) continue;
      try {
        if (!entry.field.active || this.fields.get(entry.field.namespace) !== entry.field) throw new Error('Stale draft schema ACK generation');
        entry.acknowledge();
      } catch (error) { complete = false; this.report(error); }
    }
    if (!this.transaction!.textSettled) {
      const next = { ...this.snapshot,
        ...(this.snapshot.revision === submission.base.revision ? { text: '', revision: this.snapshot.revision + 1 } : {}),
      };
      try {
        this.assertSubmission(submission.id);
        this.persist(next, this.pendingToken, new Map(), { ...this.transaction!, textSettled: true });
        this.publish(next);
      } catch (error) { complete = false; this.report(error); }
    }
    if (!this.transaction!.ownerSettled) {
      try {
        this.assertSubmission(submission.id);
        adapter.settle(this.transaction!.request, this.transaction!.receipt);
        this.assertSubmission(submission.id);
        this.persist(this.snapshot, this.pendingToken, new Map(), { ...this.transaction!, ownerSettled: true });
      } catch (error) { complete = false; this.report(error); }
    }
    complete &&= this.transaction!.fields.every(field => this.transaction!.acknowledged.includes(field.namespace));
    this.completeTransaction(complete ? 'settled' : 'accepted', !complete);
    return Object.freeze(complete ? { status: 'acknowledged' } : { status: 'unconfirmed', reason: 'settlement-failed' });
  }
  reconcile = async (submissionId: string): Promise<DraftSendResult> => {
    const adapter = this.adapter ?? this.nativeAdapter();
    if (this.suspended) return blockedSend('revoked');
    if (this.retired) return blockedSend('retired');
    if (this.snapshot.pending || this.reconciling) return blockedSend('pending');
    const original = this.transaction;
    if (!original || original.id !== submissionId || original.occurrence !== this.occurrence) return blockedSend('draft-changed');
    if (original.status === 'settled') return Object.freeze({ status: 'acknowledged' });
    if (original.status === 'rejected') return blockedSend('cancelled');
    this.reconciling = true;
    let accepted = original.status === 'accepted';
    try {
      if (this.readError) throw this.readError;
      // Stored data is validated again, not an old in-memory ACK closure.
      const request = validatedData(original.request, adapter.validateRequest);
      const outcome = transportOutcome(await adapter.inspect(request));
      if (this.suspended || this.retired || this.transaction !== original) throw new Error('Draft changed during reconciliation');
      if (outcome?.status !== 'accepted') {
        if (outcome?.status === 'rejected' && original.status !== 'accepted' && typeof outcome.reason === 'string') {
          this.completeTransaction('rejected', false);
          return Object.freeze({ status: 'rejected', reason: outcome.reason });
        }
        return Object.freeze({ status: 'unconfirmed', reason: original.status === 'accepted' ? 'settlement-failed'
          : adapter.native ? 'native-unconfirmed' : 'transport-unconfirmed' });
      }
      const receipt = validatedData(outcome.receipt, adapter.validateReceipt);
      accepted = true;
      if (this.suspended || this.retired || this.transaction !== original) throw new Error('Draft changed during receipt validation');
      const submission = Object.freeze({ id: original.id, draft: this.reference, base: original.base });
      const next = { ...this.snapshot, pending: true, unconfirmed: false };
      this.persist(next, original.id, new Map(), { ...original, status: 'accepted', receipt });
      this.pendingToken = original.id;
      this.publish(next);
      const captured = original.fields.filter(field => !original.acknowledged.includes(field.namespace)).map(saved => {
        const field = this.fields.get(saved.namespace);
        if (!field?.active || saved.encoded === undefined) throw new Error('Captured schema is unavailable for recovery');
        return { field, acknowledge: field.restoreAck(submission, saved.encoded) };
      });
      return this.settle(adapter, submission, captured);
    } catch (error) {
      this.report(error);
      if (this.pendingToken === original.id) {
        try { this.completeTransaction('accepted', true); }
        catch (error) { this.pendingToken = undefined; this.publish({ pending: false, unconfirmed: true }); this.report(error); }
      }
      return Object.freeze({ status: 'unconfirmed', reason: accepted ? 'settlement-failed'
        : adapter.native ? 'native-unconfirmed' : 'transport-unconfirmed' });
    } finally { this.reconciling = false; }
  };
}

export class SessionDraft extends DraftCore {
  declare readonly sessionId: string;
  declare readonly reference: DraftReference & { readonly sessionId: string };
  constructor(sessionId: string, storage?: DraftStorage, purpose: DraftPurpose = { kind: 'prompt' },
    key = purpose.kind === 'prompt' ? `cockpit:chat-draft:${sessionId}`
      : `cockpit:decision-draft:${JSON.stringify([sessionId, purpose.kind, purpose.requestId, draftIdentity()])}`,
    report: DraftReport = reportDraft) {
    super({ sessionId, storage, purpose, key, report });
  }
  protected override nativeAdapter(send?: (request: NativeDraftRequest) => Promise<boolean>): DraftAdapter {
    const validate = (value: unknown): NativeDraftRequest => {
      if (!draftRecord(value) || !draftRecord(value.body)) throw new Error('Invalid native draft request');
      const { text, answer, message, sessionId, requestId: _requestId, wasFreeform: _wasFreeform, ...fields } = value.body;
      if (sessionId !== this.sessionId) throw new Error('Native draft session changed');
      return nativeDraftRequest(this.reference, String(text ?? answer ?? message ?? ''), fields);
    };
    return {
      native: true,
      prepare: submission => nativeDraftRequest(this.reference, submission.text, submission.fields),
      validateRequest: validate, validateReceipt: value => {
        if (value !== true) throw new Error('Invalid native acceptance receipt');
        return true;
      },
      send: async request => {
        if (!send) throw new Error('Native draft transport is unavailable');
        return (await send(copyDurable(validate(request)))) === true
          ? { status: 'accepted', receipt: true } : { status: 'unknown', reason: 'Native acceptance is unconfirmed' };
      },
      inspect: async request => this.hasAcceptedRequest(request)
        ? { status: 'accepted', receipt: true }
        : { status: 'unknown', reason: 'Native request lookup is unavailable' },
      settle: () => {},
    };
  }
}

export function createDraftOwner<Request, Receipt>(options: DraftOwnerOptions<Request, Receipt>,
  storage: DraftStorage | undefined, key: string, report: DraftReport = reportDraft): { owner: DraftOwner; core: DraftCore } {
  if (!draftRecord(options) || typeof options.key !== 'string' || !options.key.trim()
    || !draftRecord(options.purpose) || !['prompt', 'ask', 'plan', 'elicitation'].includes(options.purpose.kind)
    || Object.keys(options.purpose).some(key => key !== 'kind' && !(options.purpose.kind !== 'prompt' && key === 'requestId'))
    || (options.purpose.kind !== 'prompt' && (typeof options.purpose.requestId !== 'string' || !options.purpose.requestId.trim()))
    || (options.settle !== undefined && typeof options.settle !== 'function')
    || ['prepare', 'validateRequest', 'validateReceipt', 'send', 'inspect'].some(name => typeof options[name as keyof typeof options] !== 'function')) {
    throw new Error('Invalid draft owner registration');
  }
  const registration = Object.freeze({ ...options });
  const core = new DraftCore({ storage, key, purpose: options.purpose, report, facts: options.facts, adapter: {
    prepare: snapshot => registration.prepare(snapshot),
    validateRequest: value => registration.validateRequest(value),
    validateReceipt: value => registration.validateReceipt(value),
    send: request => registration.send(copyDurable(registration.validateRequest(request))),
    inspect: request => registration.inspect(copyDurable(registration.validateRequest(request))),
    settle: (request, receipt) => {
      const result = registration.settle?.(copyDurable(registration.validateRequest(request)), copyDurable(registration.validateReceipt(receipt)));
      if (result !== undefined) {
        void Promise.resolve(result).catch(report);
        throw new Error('Draft owner settlement must be synchronous and return void');
      }
    },
  } });
  const owner: DraftOwner = Object.freeze({
    reference: core.reference, editText: (text: string) => core.edit(text), update: (next: DraftOwnerFacts) => core.updateFacts(next),
    submit: core.ownerSubmit, reconcile: core.reconcile, retire: () => core.retire(),
  });
  return { owner, core };
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
