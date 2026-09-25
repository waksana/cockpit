import type {
  DraftNativeFields, DraftReference, DraftSchemaHandle, DraftSchemaRegistration, DraftSchemaScope, DraftSubmission,
} from '@cockpit/module-api/frontend';
import { draftRecord, immutableDraftData, resolveDraft, type DraftField, type DraftReport, type SessionDraft } from './textDraft';

export interface RuntimeDraftSchema {
  readonly owner: string;
  prepare(draft: SessionDraft): void;
  ready(draft: SessionDraft): boolean;
  applies(draft: SessionDraft): boolean;
  activate(): void;
  dispose(): void;
}

function synchronous<T>(value: T, report: DraftReport): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    void Promise.resolve(value).catch(report);
    throw new Error('Draft schema hooks must be synchronous');
  }
  return value;
}

class SchemaScope<State extends object> implements DraftField {
  private state: State;
  private content: boolean;
  private encoding?: string;
  private live = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  readonly api: DraftSchemaScope<State>;
  readonly owner: string;
  readonly namespace: string;
  private readonly draft: SessionDraft;
  private readonly definition: DraftSchemaRegistration<State>;
  private readonly report: DraftReport;
  constructor(
    owner: string,
    namespace: string,
    draft: SessionDraft,
    definition: DraftSchemaRegistration<State>,
    report: DraftReport,
  ) {
    this.owner = owner;
    this.namespace = namespace;
    this.draft = draft;
    this.definition = definition;
    this.report = report;
    const initial = draft.pure(() => {
      const restore = definition.persistence ? draft.restoreInput(namespace) : undefined;
      return this.validate(restore ? definition.persistence!.restore(restore, draft.reference) : definition.create(draft.reference));
    });
    this.state = initial.state;
    this.content = initial.content;
    this.encoding = initial.encoding;
    this.api = Object.freeze({
      draft: draft.reference,
      getSnapshot: () => this.state,
      subscribe: (listener: () => void) => {
        if (this.disposed) return () => {};
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
      update: (change: (current: Readonly<State>) => State) => {
        try {
          this.assertLive();
          draft.assertEditable();
          const next = draft.pure(() => this.validate(change(this.state)));
          this.commit(next);
          return this.state;
        } catch (error) { report(error); throw error; }
      },
    });
  }
  get active(): boolean { return this.live; }
  get hasContent(): boolean { return this.content; }
  get encoded(): string | undefined { return this.encoding; }
  private validate(input: State) {
    synchronous(input, this.report);
    const state = synchronous(this.definition.validate(input), this.report);
    if (!state || typeof state !== 'object') throw new Error('A draft schema snapshot must be an object');
    immutableDraftData(state);
    const content = synchronous(this.definition.hasContent(state), this.report);
    if (typeof content !== 'boolean') throw new Error('Draft schema hasContent must return a boolean');
    const encoding = this.definition.persistence
      ? synchronous(this.definition.persistence.serialize(state), this.report) : undefined;
    if (this.definition.persistence && typeof encoding !== 'string') throw new Error('Draft schema serialization must return a string');
    return { state, content, encoding };
  }
  private assertLive(): void {
    if (!this.live) throw new Error('Draft schema generation has stopped');
  }
  private commit(next: ReturnType<SchemaScope<State>['validate']>, submission?: DraftSubmission): void {
    this.draft.commitField(this, next.encoding, () => {
      this.state = next.state;
      this.content = next.content;
      this.encoding = next.encoding;
    }, submission);
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) {
      try { listener(); } catch (error) { this.report(error); }
    }
  }
  project(submission: DraftSubmission): DraftNativeFields | undefined {
    this.assertLive();
    return this.draft.pure(() => synchronous(this.definition.project(this.state, submission), this.report));
  }
  captureAck(submission: DraftSubmission): () => void {
    const captured = this.state;
    return () => {
      this.assertLive();
      const next = this.draft.pure(() => this.validate(this.definition.acknowledge(this.state, captured, submission)));
      this.commit(next, submission);
    };
  }
  checkAttach(): void { this.draft.assertCanAttach(this); }
  activate(): void {
    if (this.live) return;
    this.live = true;
    try { this.draft.attachField(this); }
    catch (error) { this.live = false; throw error; }
  }
  dispose(): void {
    this.live = false;
    this.disposed = true;
    this.listeners.clear();
    this.draft.detachField(this);
  }
}

export class RegisteredDraftSchema<State extends object> implements RuntimeDraftSchema {
  private readonly scopes = new Map<SessionDraft, SchemaScope<State>>();
  private active = false;
  private alive = true;
  private readonly definition: DraftSchemaRegistration<State>;
  readonly handle: DraftSchemaHandle<State>;
  readonly owner: string;
  constructor(owner: string, moduleId: string, input: DraftSchemaRegistration<State>, report: DraftReport) {
    this.owner = owner;
    if (!draftRecord(input)
      || Object.keys(input).some(key => !['id', 'purposes', 'create', 'validate', 'hasContent', 'project', 'acknowledge', 'persistence'].includes(key))
      || !Array.isArray(input.purposes)
      || input.purposes.some(purpose => !['prompt', 'ask', 'plan', 'elicitation'].includes(purpose))
      || ['create', 'validate', 'hasContent', 'project', 'acknowledge'].some(key => typeof input[key as keyof typeof input] !== 'function')) {
      throw new Error('Invalid draft schema registration');
    }
    if (input.persistence !== undefined && (!draftRecord(input.persistence)
      || Object.keys(input.persistence).some(key => !['serialize', 'restore'].includes(key))
      || typeof input.persistence.serialize !== 'function' || typeof input.persistence.restore !== 'function')) {
      throw new Error('Invalid draft schema persistence');
    }
    this.definition = Object.freeze({ ...input, purposes: Object.freeze([...input.purposes]),
      ...(input.persistence ? { persistence: Object.freeze({ ...input.persistence }) } : {}),
    });
    const namespace = JSON.stringify([moduleId, input.id]);
    this.prepareScope = draft => {
      const scope = new SchemaScope(owner, namespace, draft, this.definition, report);
      scope.checkAttach();
      this.scopes.set(draft, scope);
      if (this.active) scope.activate();
    };
    this.handle = Object.freeze({
      id: input.id,
      forDraft: (reference: DraftReference) => {
        if (!this.alive) throw new Error('Draft schema registration has stopped');
        const draft = resolveDraft(reference);
        if (draft.isRetired()) throw new Error('This decision draft has retired');
        if (!this.applies(draft)) return undefined;
        const scope = this.scopes.get(draft);
        if (!scope) throw new Error('Draft schema was not prepared before rendering');
        return scope.api;
      },
    });
  }
  private readonly prepareScope: (draft: SessionDraft) => void;
  applies(draft: SessionDraft): boolean { return this.alive && this.definition.purposes.includes(draft.reference.purpose.kind); }
  ready(draft: SessionDraft): boolean { return !this.applies(draft) || this.scopes.has(draft); }
  prepare(draft: SessionDraft): void {
    if (!this.alive || draft.isRetired() || this.ready(draft)) return;
    this.prepareScope(draft);
  }
  activate(): void {
    if (!this.alive) throw new Error('Draft schema registration has stopped');
    for (const scope of this.scopes.values()) scope.checkAttach();
    this.active = true;
    for (const scope of this.scopes.values()) scope.activate();
  }
  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.active = false;
    for (const scope of this.scopes.values()) scope.dispose();
    this.scopes.clear();
  }
}
