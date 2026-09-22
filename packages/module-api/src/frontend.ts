import type * as React from 'react';
import type { ModuleEventPayload, NativeAttachmentDescriptor, SessionMeta, SessionStatus } from '@cockpit/protocol';
import type { ModuleUi } from './ui.ts';

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
  readonly subtype?: 'ask-reply' | 'subagent' | 'skill';
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
  /** Failure or unknown native outcome: retained content is not permission to retry. */
  readonly unconfirmed: boolean;
  /** Irreversible end of this lifetime: decision ended or session authoritatively deleted. */
  readonly retired: boolean;
}

/**
 * A host-issued, stable reference to one captured draft, not a native store.
 * id identifies its lifetime, not just its session/request. The ordinary prompt
 * and each native decision have distinct identities and independent storage.
 *
 * A pending decision selects a fresh request-keyed draft without copying,
 * clearing or borrowing prompt data. The prompt remains cached and writable by
 * its captured services while inactive. Switch only on actual decision state;
 * restore the prompt when no blocking decision remains. Failed/unknown answers
 * remain in their own draft. Replacements never inherit old answers, including
 * a request ID reused after retirement.
 * A late completion may settle only its original in-flight draft/token, never
 * reactivate it or modify the current prompt/another decision. Retired decision
 * references cannot authorize new edits or sends. Saved answers are restored
 * only for the same live request occurrence, never a retired/reused request ID.
 */
export interface DraftReference extends ReadonlyState<ModuleDraftSnapshot> {
  readonly id: string;
  readonly sessionId: string;
  readonly purpose: DraftPurpose;
}

export type DraftWrite = 'text';

/** Safe codes only: never native response text, payloads or module content. */
export type DraftSendBlockReason =
  | 'revoked' | 'retired' | 'cancelled' | 'revision-mismatch' | 'draft-changed'
  | 'pending' | 'unconfirmed' | 'peer-blocked' | 'empty' | 'unavailable'
  | 'read-only' | 'decision-changed' | 'unsupported' | 'persistence-failed' | 'projection-failed';

export type DraftSendResult =
  | { readonly status: 'acknowledged' }
  | { readonly status: 'blocked'; readonly reason: DraftSendBlockReason }
  | { readonly status: 'unconfirmed'; readonly reason: 'native-unconfirmed' | 'settlement-failed' };

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
   * calls return the same promise/result, never another native dispatch.
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
   * Sends through the original prompt/ask/plan native route with all applicable
   * schema fields and ACK rules, even when the original prompt is inactive.
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
   * Read-only original parsed record for THIS draft, or undefined when none exists.
   * Modules may migrate their old unnamespaced fields here. The host neither
   * interprets nor consumes those fields, and never supplies a prompt's legacy
   * record to a decision draft or another session.
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

type CoreDraftField = 'sessionId' | 'text' | 'mode' | 'requestId' | 'answer' | 'message' | 'wasFreeform' | 'action';

/** Explicit additions to the selected EXISTING native route, not arbitrary slice serialization. */
export type DraftNativeFields = Readonly<Record<string, unknown>> & { readonly [Field in CoreDraftField]?: never };

/**
 * A draft-data extension in the state registry, not another component registry.
 * Factories/hooks are synchronous; snapshots are immutable data. Keep keyed
 * resources/HTTP (UploadStore, FileProbes, etc.) in registered state services.
 *
 * Before dispatch, the host captures text revision, applicable schema snapshots
 * and a unique pending token, publishing pending before native transport. It
 * merges only explicit project results, validates against the existing native
 * route, and rejects ALL peer-field collisions and
 * core-owned keys (sessionId, text, mode, requestId, answer, message, wasFreeform,
 * action). Unknown route fields are errors, not silently stripped. Empty text
 * additionally requires schema-declared content with an actual projection.
 *
 * False/unknown native results preserve captured data without retry. Confirmed
 * success clears text only at its captured revision and calls acknowledge only
 * for participating projections, with current AND captured field data. Native
 * choice actions never implicitly submit another draft's fields.
 *
 * ACK checks the original draft/submission/schema-generation tokens before any
 * write. Stale callbacks cannot clean a replacement scope. A stale/failed ACK
 * is reported and its field retained, not represented as successful cleanup;
 * independently valid fields can still ACK. It never retries an acknowledged
 * native request. Projection/serialization/storage failures are explicit, never
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
  /** Pure projection of captured data; undefined/{} contributes no native fields. */
  project(state: Readonly<State>, submission: DraftSubmission): DraftNativeFields | undefined;
  /** Pure cleanup of captured items only, preserving concurrent additions/replacements. */
  acknowledge(current: Readonly<State>, captured: Readonly<State>, submission: DraftSubmission): State & { readonly then?: never };
  readonly persistence?: DraftSchemaPersistence<State>;
}

export interface ModuleStateRegistry {
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
   * ordinary text and other active schemas remain usable.
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
   * disabled gates, even when called directly. Uses captured native routing, not
   * a stale SDK callback. A decision without a free-text route cannot fall
   * through to prompt. Schema projections, not serialized fields, enter the send.
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
}

/** Existing resource-detail header with back navigation and its focused title. */
export interface ManagementDetailHeaderProps {
  readonly item: string;
  readonly actions?: React.ReactNode;
}

export interface MessageOrigin {
  readonly sessionId: string;
  readonly messageId: string;
  readonly agentId?: string;
}

export type MessageIdentity = {
  readonly sessionId: string;
  /** Native message id, or the host's current AskRequest.requestId. Never a DOM/row id. */
  readonly id: string;
  /** Native attribution, never a synthesized nested-session identifier. */
  readonly agentId?: string;
} & (
  | { readonly kind: 'message'; readonly role: 'user' | 'assistant' | 'system' | 'tool' }
  | { readonly kind: 'ask' }
);

/**
 * The existing visible message body or pending ask question, not its scroll
 * frame/byline/choice controls. Unattributed content uses the core fallback.
 */
export interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly identity: MessageIdentity;
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

/** Base renders concurrent native activity facts followed by children. */
export interface SessionStatusProps {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly needsDecision: boolean;
  /** Missing activity is unknown, not idle. Legacy status remains a safety aggregate. */
  readonly activity?: ReadonlyData<SessionMeta['activity']>;
  /** A browser-owned control read is pending; not evidence of native processing. */
  readonly activityRefreshing?: boolean;
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

export interface ModuleComponentProps {
  message: MessageProps;
  sessionStatus: SessionStatusProps;
  composer: ComposerProps;
  composerEditor: ComposerEditorProps;
  composerInput: ComposerInputProps;
  attachment: AttachmentProps;
  managementHeader: ManagementHeaderProps;
  managementDetailHeader: ManagementDetailHeaderProps;
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

export interface ModuleFrontendServices {
  /** Web contract only. Module manifest, backend context and route API remain v1. */
  readonly apiVersion: 2;
  /** Declarative global/session menu capability; not a component boundary. */
  readonly menuVersion: 1;
  /** Read-only current-window text projection. Check independently of Web API v2. */
  readonly chatWindowVersion: 1;
  /** Middleware around the actual controlled textarea, independently of the input row. */
  readonly composerInputVersion: 1;
  /** Observable permanent retirement and atomic revision-guarded text completion. */
  readonly draftLifecycleVersion: 1;
  /** Explicitly authorized captured one-shot native draft submission. */
  readonly draftSubmissionVersion: 1;
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
}

export interface ModuleFrontendContext extends ModuleFrontendServices {
  readonly uiVersion: 1;
  /** Classic shared surfaces, independent of the new React component library. */
  readonly uiSurfaceVersion: 1;
}

export interface ModuleNextFrontendContext extends ModuleFrontendServices {
  readonly ui: ModuleUi;
}

/**
 * All IDs are nonempty and unique within this module across state services,
 * draft schemas, menus, middleware and Markdown. The host stages the entire activation
 * before publishing; old slot fields and frontend versions are rejected.
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
  readonly apiVersion: 2;
  readonly writes?: readonly DraftWrite[];
  /** Independent native-send permission; text writes alone never grant this. */
  readonly sends?: readonly 'draft'[];
  /** Native commands remain first; additions sort by (order ?? 0, moduleId, id). */
  readonly menus?: readonly ModuleMenuRegistration[];
  readonly components?: readonly ModuleComponentMiddleware[];
  readonly markdown?: readonly MarkdownRenderer[];
  dispose?(): void;
}

export type ActivateFrontend = (context: ModuleFrontendContext) => ModuleFrontend | Promise<ModuleFrontend>;
export type ActivateNextFrontend = (context: ModuleNextFrontendContext) => ModuleFrontend | Promise<ModuleFrontend>;
