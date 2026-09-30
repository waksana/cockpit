import type * as React from 'react';
export type * from './contract.ts';
export type { ModuleAsset, ModuleManifest, ModuleRole } from './manifest.ts';
import type {
  ModuleEventPayload,
  NativeAttachmentDescriptor,
  PublicSessionMeta,
  SessionStatus,
} from './contract.ts';

type ReadonlyData<T> = { readonly [Key in keyof T]: ReadonlyData<T[Key]> };

/** Stable, immutable snapshots suitable for React.useSyncExternalStore. */
export interface ReadonlyState<Snapshot> {
  getSnapshot(): Readonly<Snapshot>;
  subscribe(listener: () => void): () => void;
}

export interface HostSnapshot {
  readonly sessionId: string | null;
  readonly visible: boolean;
  readonly connected: boolean;
}

/** Text projection of an already-loaded window; each array retains its native display order. */
export interface ChatWindowMessage {
  /** Presentation identity; use origin for native identity and attribution. */
  readonly id: string;
  readonly origin: Readonly<MessageOrigin> | null;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly text: string;
  readonly complete: boolean;
  readonly subtype?: 'ask-reply' | 'plan-reply' | 'elicitation-reply' | 'subagent' | 'skill';
  readonly children: readonly ChatWindowMessage[];
}

export interface ChatWindowSnapshot {
  readonly sessionId: string | null;
  readonly status: 'unavailable' | 'loading' | 'ready' | 'stale' | 'error';
  readonly hasMore: boolean;
  readonly partial: boolean;
  readonly error?: string;
  /** Root messages; nested agents stay in children, not a synthetic global ordering. */
  readonly messages: readonly ChatWindowMessage[];
}

export type DraftPurpose =
  | { readonly kind: 'prompt' }
  | { readonly kind: 'ask' | 'plan' | 'elicitation'; readonly requestId: string };

export interface DraftBlock {
  readonly id: string;
  readonly reason: string;
}

/** Copied native question data for this exact live ask draft, never persisted. */
export interface DraftAskContext {
  readonly question: string;
  readonly choices?: readonly string[];
}

export interface ModuleDraftSnapshot {
  readonly editable: boolean;
  readonly submittable: boolean;
  readonly capabilities: { readonly attachments: boolean };
  /** Owner action/target checkpoint, independent of text edits. Monotonically increasing. */
  readonly actionRevision: number;
  /** Optional already-visible context; at most 1,000 Unicode code points, never a history reader. */
  readonly referenceText?: string;
  /** Original unresolved transaction, including after a reload. Not send permission. */
  readonly submissionId?: string;
  /**
   * Present only for an authoritative live ask with an available question.
   * Absent for other purposes, retirement, unload or lost authority. Capture
   * synchronously at operation start; later updates never mutate prior snapshots.
   * Context-only changes notify subscribers without advancing text revision.
   */
  readonly askContext?: DraftAskContext;
  readonly text: string;
  readonly blocks: readonly DraftBlock[];
  /** Nonblank text or content declared by an active applicable schema, not schema presence. */
  readonly hasContent: boolean;
  /** Text edit revision; an acknowledged send clears only its captured revision. */
  readonly revision: number;
  readonly pending: boolean;
  /** Unknown transport or incomplete local settlement: retained content is not retry permission. */
  readonly unconfirmed: boolean;
  /** Irreversible end of this lifetime: decision ended or session authoritatively deleted. */
  readonly retired: boolean;
}

/**
 * A host-issued, stable reference to one captured draft, not a native store.
 * id identifies its runtime lifetime, not a business routing target. Generic
 * owners do not require a session. In the native adapter, the ordinary prompt
 * and each decision have distinct identities and independent storage.
 *
 * A pending decision selects a fresh request-keyed draft without copying,
 * clearing or borrowing prompt data. The prompt remains cached and writable by
 * its captured services while inactive. Switch only on actual decision state;
 * restore the prompt when no blocking decision remains. Failed/unknown answers
 * remain in their own draft. Replacements never inherit old answers, including
 * a request ID reused after retirement.
 * A late completion may settle only its original authorized draft/token, never
 * reactivate it or modify the current prompt/another decision. Retired decision
 * references cannot authorize new edits or sends. Saved answers are restored
 * only for the same live request occurrence, never a retired/reused request ID.
 */
export interface DraftReference extends ReadonlyState<ModuleDraftSnapshot> {
  readonly id: string;
  /** Legacy native adapter only; generic owners never fabricate a session. */
  readonly sessionId?: string;
  readonly purpose: DraftPurpose;
}

export type DraftWrite = 'text';

/** Safe pre-dispatch codes only: never response text, payloads or module content. */
export type DraftSendBlockReason =
  | 'revoked' | 'retired' | 'cancelled' | 'revision-mismatch' | 'draft-changed'
  | 'pending' | 'unconfirmed' | 'peer-blocked' | 'empty' | 'unavailable'
  | 'read-only' | 'decision-changed' | 'unsupported' | 'persistence-failed' | 'projection-failed';

export type DraftSendResult =
  | { readonly status: 'acknowledged' }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'blocked'; readonly reason: DraftSendBlockReason }
  | { readonly status: 'unconfirmed'; readonly reason: 'native-unconfirmed' | 'transport-unconfirmed' | 'settlement-failed' };

export interface DraftOwnerFacts {
  readonly editable: boolean;
  readonly submittable: boolean;
  readonly capabilities: { readonly attachments: boolean };
  readonly actionRevision: number;
  readonly askContext?: DraftAskContext;
  readonly referenceText?: string;
}

/** Captured content only. Business routing stays in prepare's owner closure. */
export interface DraftSubmissionSnapshot extends DraftSubmission {
  readonly text: string;
  readonly fields: DraftFields;
}

export type DraftTransportOutcome<Receipt> =
  | { readonly status: 'accepted'; readonly receipt: Receipt }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string };

/**
 * Request and Receipt must be finite, plain JSON data. Validators strictly check
 * persisted values, including version and complete request identity; they must not
 * silently strip fields. Creation/update never invokes send or inspect.
 */
export interface DraftOwnerOptions<Request, Receipt> {
  /** Stable module-local storage key; the host namespaces it by module ID. */
  readonly key: string;
  readonly purpose: DraftPurpose;
  readonly facts: DraftOwnerFacts;
  /** Synchronous: validates projected fields and captures an immutable business request. */
  prepare(snapshot: DraftSubmissionSnapshot): Request;
  validateRequest(value: unknown): Request;
  validateReceipt(value: unknown): Receipt;
  send(request: Request): Promise<DraftTransportOutcome<Receipt>>;
  /**
   * Explicit read of this exact original request only. Return accepted only after
   * proving complete request/content identity; lack of evidence remains unknown.
   * Never resend here or treat a missing response as a safe retry.
   */
  inspect(request: Request): Promise<DraftTransportOutcome<Receipt>>;
  /**
   * Synchronous, idempotent business cleanup, never network dispatch. Compare
   * captured actionRevision before clearing owner state. Core owns text/field ACK.
   */
  settle?(request: Request, receipt: Receipt): void;
}

export interface DraftOwner {
  readonly reference: DraftReference;
  editText(text: string): void;
  update(facts: DraftOwnerFacts): void;
  submit(): Promise<DraftSendResult>;
  /** Inspect and settle the original transaction; never calls send. */
  reconcile(submissionId: string): Promise<DraftSendResult>;
  /** Permanent logical retirement; preserves already-dispatched evidence. */
  retire(): void;
}

/**
 * One consent checkpoint for an immutable captured draft lifetime and its full
 * schema generation/mutation checkpoint. No caller-selected target or payload.
 */
export interface CapturedDraftSend {
  /**
   * Supply the current text revision after this module's own streaming edits.
   * Any other writer's edit or schema mutation/generation change since capture
   * invalidates consent, including ABA changes. Block release is not content.
   * The first call consumes this intent, including a blocked result. All later
   * calls return the same promise/result, never another business dispatch.
   * blocked guarantees no dispatch; unconfirmed may have sent or failed local
   * ACK settlement. Never automatically retry either an uncertain dispatch or
   * a consumed intent by capturing replacement consent.
   */
  send(expectedRevision: number): Promise<DraftSendResult>;
  /** Prevents dispatch if not yet started; cannot unsend an in-flight request. */
  cancel(): void;
}

/**
 * Base capabilities only. Text edits require ModuleFrontend.writes and may
 * continue during a send, advancing revision. Schema data/actions belong to the
 * schema's own handle, never this base draft. Captured submission requires
 * independent sends permission. No native store patch, attachment model,
 * arbitrary-payload send, ACK, or reset action is exposed.
 */
export interface ModuleDraft extends DraftReference {
  editText(text: string): void;
  /**
   * Atomic completion for this captured lifetime, including inactive prompts.
   * Requires text write capability. Returns false without mutation on a revision
   * mismatch, pending/unconfirmed submission, or any block (release your own
   * lease first). Throws on retirement, revocation or persistence failure; true
   * means the text was persisted and published with an incremented revision.
   * Ordinary editText retains its existing concurrent/memory-edit semantics.
   */
  editTextIfRevision(text: string, revision: number): boolean;
  /**
   * Requires the separate ModuleFrontend.sends: ['draft'] declaration.
   * Capture at explicit user consent, before waiting for background completion.
   * Throws on missing permission, revoked/retired or unavailable draft scope.
   * Own blocks may still be held at capture; release them before send.
   * Uses this draft owner's original adapter with all applicable schema fields
   * and ACK rules. Native adapters retain prompt/ask/plan routing, including
   * completion of an inactive prompt; enhancements never choose the target.
   */
  captureSend(): CapturedDraftSend;
  /**
   * Requires a text write or an active schema applicable to this draft. Leases
   * belong to this module/draft and release idempotently. Module/schema loss
   * releases its leases, never creating orphan notices or missing-file UI;
   * other active modules' leases are unaffected.
   */
  block(reason: string): () => void;
}

/** Preserves the concrete service's selectors, keyed stores, actions and resources. */
export interface ModuleStateHandle<Service extends object> {
  readonly id: string;
  /** Returns the already-created instance, including during activation; throws after revocation. */
  get(): Service;
}

export interface ModuleStateRegistration<Service extends object> {
  readonly id: string;
  /** Called synchronously once at registration, never in render. Async work belongs inside the service. */
  create(): Service & { readonly then?: never };
  dispose(service: Service): void;
}

/** Immutable field data for one schema generation and exact draft lifetime. */
export interface DraftSchemaScope<State extends object> extends ReadonlyState<State> {
  readonly draft: DraftReference;
  /**
   * Synchronous, validated replacement of ONLY this schema's data. Modules build
   * their domain actions/selectors around this operation. Concurrent edits are
   * allowed; the module decides its own pending/ownership/ordering/limit rules.
   * Throws on validation, persistence failure, retirement or revoked generation;
   * failed updates retain the previous snapshot and serialized namespace.
   */
  update(change: (current: Readonly<State>) => State): Readonly<State>;
}

export interface DraftSchemaHandle<State extends object> {
  readonly id: string;
  /**
   * Stable scoped store, or undefined for an inapplicable purpose. This is a
   * lookup, never an initializer/hook. Foreign or revoked references/handles
   * throw. An inactive cached prompt is still valid; retirement is distinct.
   */
  forDraft(reference: DraftReference): DraftSchemaScope<State> | undefined;
}

export interface DraftRestoreInput {
  /** This module/schema namespace only; absence is distinct from invalid data. */
  readonly stored:
    | { readonly present: false }
    | { readonly present: true; readonly value: unknown };
  /**
   * Read-only legacy extension data for THIS draft, or undefined when none exists.
   * Modules may migrate their old unnamespaced fields here. The host neither
   * interprets nor consumes those fields, and never supplies a prompt's legacy
   * record to a decision draft or another session.
   * Generic owners omit host-private metadata, including business request,
   * receipt, routing and settlement journals. Stored bytes remain unchanged.
   */
  readonly legacyRecord: unknown;
}

export interface DraftSchemaPersistence<State extends object> {
  /**
   * Opaque module-owned encoding (e.g. JSON text), not a native send payload.
   * Must return a string or throw. Persist an explicit empty value/tombstone
   * after ACK so legacy fields cannot be imported again on a later restore.
   * Live File objects/uploads/resources belong in services, not this encoding.
   */
  serialize(state: Readonly<State>): string;
  /**
   * Called instead of create when this draft has a saved record. It owns format
   * checks, versioning and legacy migration; the result passes validate.
   * Failure is reported, not silently replaced with create/empty data.
   */
  restore(input: DraftRestoreInput, draft: DraftReference): State & { readonly then?: never };
}

/**
 * Captured host transaction identity; never itself forwarded to the backend.
 * The host also binds each participating field to its exact schema generation.
 */
export interface DraftSubmission {
  readonly id: string;
  readonly draft: DraftReference;
  readonly base: Readonly<ModuleDraftSnapshot>;
}

type CoreDraftField = 'sessionId' | 'text' | 'mode' | 'requestId' | 'answer' | 'message' | 'wasFreeform' | 'action'
  | 'target' | 'request' | 'decision' | 'topic' | 'topicId' | 'reply' | 'replyTo' | 'actionRevision' | 'submissionId';

/** Explicit content projection, not arbitrary schema-store serialization or routing. */
export type DraftFields = Readonly<Record<string, unknown>> & { readonly [Field in CoreDraftField]?: never };
/** Native v2 name retained for schema source compatibility. */
export type DraftNativeFields = DraftFields;

/**
 * A draft-data extension in the state registry, not another component registry.
 * Factories/hooks are synchronous; snapshots are immutable data. Keep keyed
 * resources/HTTP (UploadStore, FileProbes, etc.) in registered state services.
 *
 * Before dispatch, the host captures text revision, applicable schema snapshots
 * and a unique pending token, publishing pending before native transport. It
 * merges only explicit project results, validates through the owner adapter,
 * and rejects ALL peer-field collisions and core/business routing keys.
 * Unknown fields are errors, not silently stripped. Empty text
 * additionally requires schema-declared content with an actual projection.
 *
 * Rejected/unknown results preserve captured data without retry. Confirmed
 * success clears text only at its captured revision and calls acknowledge only
 * for participating projections, with current AND captured field data. Native
 * choice actions never implicitly submit another draft's fields.
 *
 * ACK checks the original draft/submission/schema-generation tokens before any
 * write. Stale callbacks cannot clean a replacement scope. A stale/failed ACK
 * is reported and its field retained, not represented as successful cleanup;
 * independently valid fields can still ACK. It never retries an accepted
 * business request. Projection/serialization/storage failures are explicit, never
 * fallback success or empty payloads. Failed persistence keeps prior bytes.
 */
export interface DraftSchemaRegistration<State extends object> {
  readonly id: string;
  readonly purposes: readonly DraftPurpose['kind'][];
  create(draft: DraftReference): State & { readonly then?: never };
  /** Owns data shape, validation and normalization; no file rules exist in core. */
  validate(value: unknown): State & { readonly then?: never };
  /** Pure content test for the base snapshot's aggregate hasContent. */
  hasContent(state: Readonly<State>): boolean;
  /** Pure projection of captured data; undefined/{} contributes no content fields. */
  project(state: Readonly<State>, submission: DraftSubmission): DraftNativeFields | undefined;
  /**
   * Pure, idempotent cleanup of captured items only. Compare persistent item
   * identity/version, not object identity: reload restores a new captured object.
   */
  acknowledge(current: Readonly<State>, captured: Readonly<State>, submission: DraftSubmission): State & { readonly then?: never };
  readonly persistence?: DraftSchemaPersistence<State>;
}

export interface ModuleStateRegistry {
  /**
   * Create/restore an owner in a service lifecycle, never during render. An active
   * key reuses its owner; use update for facts, not replacement closures. Retiring
   * and recreating starts a new logical occurrence. Module stop revokes runtime
   * authority but retains durable recovery data. No implicit network calls.
   */
  createDraft<Request, Receipt>(options: DraftOwnerOptions<Request, Receipt>): DraftOwner;
  readonly host: ReadonlyState<HostSnapshot>;
  /** Read-only current loaded window, never a history reader or native state mutation API. */
  readonly chatWindow: ReadonlyState<ChatWindowSnapshot>;
  /**
   * Activation-only registration, staged until the whole frontend validates.
   * No required global snapshot shape, hooks, persistence, or automatic retries.
   * A service may reuse an existing store or own multiple stores keyed by draft
   * id/URL. Failed activation rolls back all created services.
   */
  register<Service extends object>(registration: ModuleStateRegistration<Service>): ModuleStateHandle<Service>;
  /**
   * Activation-only, staged with services/components. IDs share this module's
   * registration namespace. The host prepares applicable scopes synchronously
   * when registering a schema/creating a draft, before exposing them to render.
   * No render-time factory, cross-module lookup, or arbitrary host store write.
   *
   * Storage is namespaced by module/schema and exact draft scope, not digest.
   * Inactive/unregistered serialized namespaces and legacy records stay opaque
   * and untouched: they are not projected, deleted, restored, or shown as file
   * fallback UI. Losing a schema drops its live contribution/blockers only;
   * persisted unclaimed fields block submission rather than silently sending
   * only text. Generic projected fields require persistence for recovery.
   */
  registerDraft<State extends object>(registration: DraftSchemaRegistration<State>): DraftSchemaHandle<State>;
  /**
   * Stable per-module binding for this exact host reference; rejects foreign or
   * revoked references. Binding does not create a module service or subscribe.
   * May be called by a stable middleware component without rebuilding its HOC.
   */
  bindDraft(reference: DraftReference): ModuleDraft;
}

export type ComposerOperation = DraftPurpose['kind'];

/** A captured input target. operation must agree with draft.purpose.kind. */
export interface ComposerTarget {
  readonly draft: DraftReference;
  readonly operation: ComposerOperation;
  readonly disabled: boolean;
}

/** The same target with the calling module's authorized draft actions. */
export interface ComposerContext extends ComposerTarget {
  readonly draft: ModuleDraft;
}

export interface ComposerProps extends ComposerTarget {
  readonly busy: boolean;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly sendBlocked: boolean;
  readonly statusInHeader?: boolean;
  /** Ref to the existing text editor; preserve it when composing a replacement view. */
  readonly editorRef?: React.Ref<HTMLTextAreaElement>;
  /**
   * Existing context followed by real module content directly above the editor.
   * A file module owns its ENTIRE ready+pending list here, or renders null.
   * The host supplies no draft attachment group or schema-presence placeholder.
   */
  readonly children?: React.ReactNode;
  /** Host editor action; preserves captured-draft text revision semantics. */
  onTextChange(text: string): void;
  /**
   * Rechecks active draft/purpose/request, pending token, hasContent, blocks and
   * disabled gates, even when called directly. The owner adapter captures routing;
   * the presentation never invents a native session or submission route.
   * Schema projections, not serialized fields, enter the send.
   */
  onSubmit(): void;
}

/** The actual input row: leading children, the text input and the native submit control. */
export interface ComposerEditorProps extends ComposerProps,
  Omit<React.HTMLAttributes<HTMLDivElement>, keyof ComposerProps> {}

/**
 * The controlled textarea itself. Base owns native editing and IME/Enter handling,
 * even without middleware. Preserve native props/events and compose editorRef,
 * including React 19 callback cleanup. Sibling enhancements render after Base;
 * full-width feedback belongs around the existing composer, not inside this row.
 */
export interface ComposerInputProps extends ComposerTarget,
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, keyof ComposerTarget | 'value' | 'onChange' | 'onSubmit' | 'children' | 'defaultValue'> {
  readonly value: string;
  readonly onChange: React.ChangeEventHandler<HTMLTextAreaElement>;
  readonly editorRef?: React.Ref<HTMLTextAreaElement>;
  /** Submission gate, not textarea disabled: pending/blocks also gate onSubmit. */
  readonly sendBlocked: boolean;
  /** Same captured, rechecked host submit action as ComposerProps.onSubmit. */
  onSubmit(): void;
}

export type ModuleMenuTarget =
  | { readonly menu: 'global' }
  | { readonly menu: 'session'; readonly sessionId: string };

/** Pure presentation derived from the module's existing state/service. */
export interface ModuleMenuState {
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly visible?: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly separatorBefore?: boolean;
}

export interface ModuleMenuRegistration {
  readonly id: string;
  readonly menu: ModuleMenuTarget['menu'];
  readonly order?: number;
  /** Synchronous and side-effect-free; never a hook or a native-store replica. */
  getState(target: ModuleMenuTarget): ModuleMenuState;
  /** Notify when presentation changes. Owned and revoked by the module scope. */
  subscribe?(listener: () => void): () => void;
  /**
   * Invoked synchronously in the user gesture, after availability is rechecked.
   * The immutable target never follows navigation. Normal menu close does not
   * cancel accepted work; module/target loss aborts signal. Check it after awaits.
   * Returned promises carry no host mutation or navigation instruction. API
   * conditions/authorization remain authoritative, regardless of disabled UI.
   */
  onSelect(target: ModuleMenuTarget, context: { readonly signal: AbortSignal }): void | Promise<void>;
}

/** Existing global resource-list header, including back/title/refresh controls. */
export interface ManagementHeaderProps {
  readonly section: 'mcp' | 'skills';
  readonly item: string | null;
  readonly onRefresh?: () => void;
  readonly actions?: React.ReactNode;
  readonly onBack?: () => void;
  readonly refreshDisabled?: boolean;
  readonly refreshing?: boolean;
  readonly error?: string;
}

/** Existing resource-detail header with back navigation and its focused title. */
export interface ManagementDetailHeaderProps {
  readonly item: string;
  /** Optional resource provenance before the unchanged item title. */
  readonly titlePrefix?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly onBack?: () => void;
}

export interface MessageOrigin {
  readonly sessionId: string;
  readonly messageId: string;
  readonly agentId?: string;
}

export type MessageIdentity = {
  readonly owner: string;
  /** Presentation identity; never native routing authority. */
  readonly id: string;
} & (
  | { readonly kind: 'message'; readonly role?: 'user' | 'assistant' | 'system' | 'tool' }
  | { readonly kind: 'ask' }
);

/**
 * The existing visible message body or pending ask question, not its scroll
 * frame/byline/choice controls. All content uses this public boundary; only real
 * native origin/decision attribution enables legacy native middleware.
 */
export interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly identity: MessageIdentity;
  readonly origin?: MessageOrigin;
  /** Real pending native decision attribution, not a message origin. */
  readonly decisionOrigin?: { readonly sessionId: string; readonly requestId: string };
  /** Actual completion fact: final message or present pending ask, never inferred from session idle. */
  readonly complete: boolean;
  /**
   * Attached to the actual visible body element, including attachment-only
   * messages, with null on unmount/replacement. Middleware must compose inherited
   * refs. No selector lookup, decoration placeholder, or extra measuring element.
   */
  readonly bodyRef?: React.Ref<HTMLDivElement>;
  /** Actual nodes beside the body in its existing presentation parent (e.g. an absolute redline). */
  readonly adornment?: React.ReactNode;
}

/** Shared Chat reading viewport and width. Owns presentation, not history or scroll following. */
export interface MessageListProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly viewportRef?: React.Ref<HTMLDivElement>;
  readonly contentRef?: React.Ref<HTMLDivElement>;
  /** History/loading controls before the message rows, inside the same reading column. */
  readonly before?: React.ReactNode;
  readonly children?: React.ReactNode;
}

/** Chat's page composition. Header is outside the thread; notices share the input dock. */
export interface ConversationFrameProps extends React.HTMLAttributes<HTMLElement> {
  readonly header?: React.ReactNode;
  readonly notices?: React.ReactNode;
  readonly composer: React.ReactNode;
}

/** The same header geometry as native Chat; controls and title are caller-owned content. */
export interface ConversationHeaderProps {
  readonly leading?: React.ReactNode;
  readonly title: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

/** Shared messageList plus Chat's return-to-latest control. No history or request routing. */
export interface ConversationTranscriptProps extends MessageListProps {
  readonly awayFromBottom: boolean;
  readonly hasNewContent: boolean;
  readonly followContent?: React.ReactNode;
  onFollow(): void;
}

export interface ConversationScrollOptions<Item> {
  /** Stable reading-view identity. Changing it starts a new reading position. */
  readonly key: string;
  readonly items: readonly Item[];
  itemKey(item: Item): string;
}

export interface ConversationScrollController<Item> {
  /** Existing rows stay visible; new prepends wait until the active reading gesture settles. */
  readonly items: readonly Item[];
  readonly prependHeld: boolean;
  readonly viewportRef: React.RefCallback<HTMLDivElement>;
  readonly contentRef: React.RefCallback<HTMLDivElement>;
  readonly viewport: HTMLDivElement | null;
  readonly content: HTMLDivElement | null;
  readonly awayFromBottom: boolean;
  readonly hasNewContent: boolean;
  isFollowing(): boolean;
  follow(): void;
  /** Call after a content commit. Metadata-only patches must not set newContent. */
  changed(change: { readonly contentReady?: boolean; readonly newContent?: boolean }): void;
}

export interface ConversationPresentation {
  /** React hook using Chat's single scroll owner; never call outside a component/hook. */
  useScroll<Item>(options: ConversationScrollOptions<Item>): ConversationScrollController<Item>;
}

/** One ordinary conversation row using the same bubble/byline/Markdown/attachment presentation as Chat. */
export interface ChatMessageProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role' | 'children'> {
  readonly identity: MessageIdentity;
  readonly origin?: MessageOrigin;
  readonly decisionOrigin?: MessageProps['decisionOrigin'];
  readonly complete: boolean;
  readonly bodyRef?: React.Ref<HTMLDivElement>;
  readonly rowRef?: React.Ref<HTMLDivElement>;
  readonly role: 'user' | 'assistant';
  /** Epoch milliseconds; presentation only, not a native event identity. */
  readonly timestamp: number;
  readonly body: string;
  readonly attachments?: readonly ReadonlyData<NativeAttachmentDescriptor>[];
  /** Previous visible conversation row; owns date separators, speaker gaps and assistant timestamp grouping. */
  readonly previous?: { readonly role: 'user' | 'assistant'; readonly timestamp: number };
  readonly showTimestamp?: boolean;
  /** Optional midnight epoch for deterministic date labels; defaults to the current local day. */
  readonly today?: number;
  /** In-row business heading, after date/speaker spacing and before the message byline/body. */
  readonly header?: React.ReactNode;
  /** Necessary choices/actions after the content. No implicit reply or native routing authority. */
  readonly children?: React.ReactNode;
  readonly [attribute: `data-${string}`]: string | number | boolean | undefined;
}

/** Browser-only presentation memory. Never use these fields to authorize actions. */
export interface SessionActivityDisplay {
  readonly previous?: {
    readonly status: SessionStatus;
    readonly activity: ReadonlyData<NonNullable<PublicSessionMeta['activity']>>;
  };
  readonly error?: string;
}

/** Base renders concurrent native activity facts followed by children. */
export interface SessionStatusProps {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly needsDecision: boolean;
  readonly compacting?: boolean;
  readonly error?: string | null;
  /** Missing activity is unknown, not idle. Legacy status remains a safety aggregate. */
  readonly activity?: ReadonlyData<PublicSessionMeta['activity']>;
  /** A browser-owned control read is pending; not evidence of native processing. */
  readonly activityRefreshing?: boolean;
  /** Retains the previous appearance during reconciliation, separate from native facts. */
  readonly activityDisplay?: SessionActivityDisplay;
  readonly loaded?: boolean;
  /** False until the current connection has received its snapshot. */
  readonly connected?: boolean;
  /** Trailing phrasing-only, noninteractive badges inside the session's existing button. */
  readonly children?: React.ReactNode;
}

/**
 * One historical native message attachment, never draft data or Markdown.
 * The host owns its surrounding transcript layout. Unsupported values call
 * Base with original props; replacement preserves any additional host actions.
 * A replacement may occupy the row itself without an intermediate HTML wrapper.
 */
export interface AttachmentProps {
  readonly origin?: MessageOrigin;
  readonly index: number;
  readonly attachment: ReadonlyData<NativeAttachmentDescriptor>;
  readonly label: string;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
}

/**
 * The real native preference section inside the host's Settings dialog. Preserve
 * Base, its DOM props and children; append module sections as siblings after Base,
 * not inside its children, so each module retains its own error boundary.
 * The host owns section spacing, the dialog, scrolling and About. No settings store,
 * session identity, native action or page registration is exposed.
 */
export interface SettingsProps extends React.HTMLAttributes<HTMLElement> {
  readonly children: React.ReactNode;
}

export interface ModuleComponentProps {
  message: MessageProps;
  messageList: MessageListProps;
  chatMessage: ChatMessageProps;
  conversationFrame: ConversationFrameProps;
  conversationHeader: ConversationHeaderProps;
  conversationTranscript: ConversationTranscriptProps;
  sessionStatus: SessionStatusProps;
  composer: ComposerProps;
  composerEditor: ComposerEditorProps;
  composerInput: ComposerInputProps;
  attachment: AttachmentProps;
  managementHeader: ManagementHeaderProps;
  managementDetailHeader: ManagementDetailHeaderProps;
  settings: SettingsProps;
  button: PublicButtonProps;
}

export interface PublicButtonProps extends React.ComponentPropsWithRef<'button'> {
  readonly variant?: 'default' | 'primary';
  readonly danger?: boolean;
  readonly appearance?: 'button' | 'icon';
}

export interface PublicComponents {
  /** Stable runtime/name component type. Base registration and middleware composition are host-owned. */
  get<Name extends keyof ModuleComponentProps>(name: Name): React.ComponentType<ModuleComponentProps[Name]>;
}

export type ComponentMiddleware<Props> =
  (Base: React.ComponentType<Props>) => React.ComponentType<Props>;

export type ModuleComponentMiddleware = {
  [Boundary in keyof ModuleComponentProps]: {
    readonly id: string;
    readonly boundary: Boundary;
    readonly order?: number;
    readonly wrap: ComponentMiddleware<ModuleComponentProps[Boundary]>;
  };
}[keyof ModuleComponentProps];

/** One already-parsed link/image occurrence; no whole-Markdown parser API. */
export interface MarkdownNode {
  readonly kind: 'link' | 'image';
  readonly origin: MessageOrigin;
  /** Original, unnormalized Markdown target, before host URL safety transforms. */
  readonly target: string;
  readonly label: string;
}

export interface MarkdownRendererProps {
  readonly node: MarkdownNode;
  /** Ordinary safe host rendering, preserving formatted labels and link/image nesting. */
  readonly fallback: React.ReactNode;
}

/**
 * Separate, exclusive replacement registry. Evaluate all predicates: overlapping
 * claims or predicate/render failure report a conflict/error and use safe host
 * fallback, not first-match selection. Preserve target/provenance; replacements
 * must be truly inline phrasing content (dialogs may portal to document.body).
 * Never route native/draft attachments here or reparse the complete Markdown.
 */
export interface MarkdownRenderer {
  readonly id: string;
  matches(node: MarkdownNode): boolean;
  readonly component: React.ComponentType<MarkdownRendererProps>;
}

export interface ModuleFrontendContext {
  /** Web contract only. Module manifest, backend context and route API remain v1. */
  readonly apiVersion: 3;
  readonly publicComponentsVersion: 1;
  /** Full conversation rows and the shared Chat reading viewport; independently capability-gated. */
  readonly messagePresentationVersion: 1;
  /** Shared Chat composition and reading-position owner. Web v3 only. */
  readonly conversationPresentationVersion: 1;
  readonly conversation: ConversationPresentation;
  readonly draftOwnerVersion: 1;
  readonly components: PublicComponents;
  /** Namespaced pages in the existing host SPA. Check independently of Web v3. */
  readonly pageVersion: 1;
  readonly navigation: ModuleNavigation;
  /** Declarative global/session menu capability; not a component boundary. */
  readonly menuVersion: 1;
  /** Component middleware for the shared Settings preference content. */
  readonly settingsVersion: 1;
  /** Session-independent components in the host React tree; absent on older hosts. */
  readonly globalComponentVersion?: 1;
  /** Read-only current-window text projection. Check independently of Web API v2. */
  readonly chatWindowVersion: 1;
  /** Middleware around the actual controlled textarea, independently of the input row. */
  readonly composerInputVersion: 1;
  /** Observable permanent retirement and atomic revision-guarded text completion. */
  readonly draftLifecycleVersion: 1;
  /** Explicitly authorized captured draft submission through its owner adapter. */
  readonly draftSubmissionVersion: 2;
  readonly moduleId: string;
  readonly react: typeof React;
  createPortal(children: React.ReactNode, container: Element | DocumentFragment): React.ReactPortal;
  readonly apiBase: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly state: ModuleStateRegistry;
  /** Authenticated, digest-bound, module-API-scoped request; no automatic retry. */
  request(path: string, init?: RequestInit): Promise<Response>;
  report(error: unknown): void;
  /** Existing generic SSE invalidation hint, automatically unsubscribed on module stop. */
  onInvalidate(listener: () => void): () => void;
  /** Immutable payloads for this module only; subscriptions are revoked on stop. No replay. */
  onEvent(listener: (payload: ModuleEventPayload) => void): () => void;
  /** Unchanged narrow module-worker metadata; never authority over the page/root scope. */
  readonly worker?: { entry: string; scope: string };
  readonly uiVersion: 1;
  /** Shared surface/heading/actions/badge/modal CSS. Check separately from base UI v1. */
  readonly uiSurfaceVersion: 1;
}

/**
 * All IDs are nonempty and unique within this module across state services,
 * draft schemas, menus, pages, global components, middleware and Markdown. The host stages the entire activation
 * before publishing; old slot fields are rejected. Export frontendApiVersion = 3
 * from the bundle to select this context before the single activate call.
 *
 * Middleware sorts by (order ?? 0, moduleId, id), lowest first/outermost, and is
 * composed once per registration/base change, NOT per render/draft. Composition
 * and error boundaries add no HTML. Preserve inherited children, refs, actions,
 * native a11y and scroll anchors; a fault restores Base and revokes that module.
 *
 * Stopping revokes draft/schema bindings and removes only this module's live
 * fields/projections/blockers before aborting the signal or running cleanup.
 * Serialized namespaces remain opaque; no orphan file UI is manufactured.
 * dispose and service disposers run once (services in reverse registration
 * order), including activation rollback;
 * cleanup failure is reported without preventing remaining disposers.
 */
export interface ModuleFrontend {
  readonly apiVersion: 3;
  readonly writes?: readonly DraftWrite[];
  /** Independent native-send permission; text writes alone never grant this. */
  readonly sends?: readonly 'draft'[];
  /** Native commands remain first; additions sort by (order ?? 0, moduleId, id). */
  readonly menus?: readonly ModuleMenuRegistration[];
  /** Stable across navigation/menu changes; requires globalComponentVersion: 1. */
  readonly globalComponents?: readonly ModuleGlobalComponent[];
  /** Route-owned components; requires pageVersion: 1. Not global overlays. */
  readonly pages?: readonly ModulePage[];
  readonly components?: readonly ModuleComponentMiddleware[];
  readonly markdown?: readonly MarkdownRenderer[];
  dispose?(): void;
}

/**
 * One session-independent component mounted after successful activation in the
 * host React tree, without a DOM wrapper or host props. Capture activation context
 * and module services in its closure; use host React and createPortal for dialogs.
 * IDs share the module registration namespace. Components retain declaration
 * order within each module (modules sort by ID). A render/effect failure revokes
 * the owning module, not the host or healthy peers. Revocation/stop unmounts them;
 * a later activation is a fresh React lifetime, even for the same digest.
 */
export interface ModuleGlobalComponent {
  readonly id: string;
  readonly component: React.ComponentType;
}

/** The host owns /modules/:moduleId/:pageId. IDs match ^[a-z][a-z0-9-]{0,63}$. */
export interface ModulePage {
  readonly id: string;
  /** No host props; capture activation context and services in the closure. */
  readonly component: React.ComponentType;
}

export interface ModuleNavigation {
  /** Pure namespaced URL construction, including during activation. */
  path(pageId: string): string;
  /** Push a registered page after successful activation through the host router. */
  navigate(pageId: string): void;
  /** Navigate to the host homepage, not arbitrary browser history. */
  home(): void;
}

export type ActivateFrontend = (context: ModuleFrontendContext) => ModuleFrontend | Promise<ModuleFrontend>;

export type LegacyMessageIdentity = {
  readonly sessionId: string;
  readonly id: string;
  readonly agentId?: string;
} & ({ readonly kind: 'message'; readonly role: 'user' | 'assistant' | 'system' | 'tool' } | { readonly kind: 'ask' });
export interface LegacyMessageProps extends Omit<MessageProps, 'identity' | 'origin' | 'decisionOrigin'> {
  readonly identity: LegacyMessageIdentity;
}
export type LegacyModuleComponentProps = Omit<ModuleComponentProps, 'message' | 'button' | 'messageList' | 'chatMessage'
  | 'conversationFrame' | 'conversationHeader' | 'conversationTranscript'> & { message: LegacyMessageProps };
export type LegacyModuleComponentMiddleware = {
  [Name in keyof LegacyModuleComponentProps]: {
    readonly id: string;
    readonly boundary: Name;
    readonly order?: number;
    readonly wrap: ComponentMiddleware<LegacyModuleComponentProps[Name]>;
  };
}[keyof LegacyModuleComponentProps];
export interface LegacyModuleFrontendContext extends Omit<ModuleFrontendContext,
  'apiVersion' | 'publicComponentsVersion' | 'messagePresentationVersion' | 'conversationPresentationVersion' | 'conversation'
  | 'draftOwnerVersion' | 'components' | 'draftSubmissionVersion' | 'state' | 'pageVersion' | 'navigation'> {
  readonly apiVersion: 2;
  readonly draftSubmissionVersion: 1;
  readonly state: Omit<ModuleStateRegistry, 'createDraft'>;
}
export interface LegacyModuleFrontend extends Omit<ModuleFrontend, 'apiVersion' | 'components' | 'pages'> {
  readonly apiVersion: 2;
  readonly components?: readonly LegacyModuleComponentMiddleware[];
}
export type ActivateLegacyFrontend = (context: LegacyModuleFrontendContext) => LegacyModuleFrontend | Promise<LegacyModuleFrontend>;
