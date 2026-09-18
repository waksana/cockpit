import type * as React from 'react';
import type { NativeAttachmentDescriptor, SessionStatus } from '@cockpit/protocol';

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

export type DraftPurpose =
  | { readonly kind: 'prompt' }
  | { readonly kind: 'ask' | 'plan' | 'elicitation'; readonly requestId: string };

export interface DraftBlock {
  readonly id: string;
  readonly reason: string;
}

export interface ModuleDraftSnapshot {
  readonly text: string;
  readonly blocks: readonly DraftBlock[];
  /** Nonblank text or content declared by an active applicable schema, not schema presence. */
  readonly hasContent: boolean;
  /** Text edit revision; an acknowledged send clears only its captured revision. */
  readonly revision: number;
  readonly pending: boolean;
  /** Failure or unknown native outcome: retained content is not permission to retry. */
  readonly unconfirmed: boolean;
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

/**
 * Base capabilities only. Text edits require ModuleFrontend.writes and may
 * continue during a send, advancing revision. Schema data/actions belong to the
 * schema's own handle, never this base draft. No native store patch, attachment
 * model, submit, ACK, or reset action is exposed.
 */
export interface ModuleDraft extends DraftReference {
  editText(text: string): void;
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

/** The actual input row: the existing text editor and submit control, not an empty slot. */
export interface ComposerEditorProps extends ComposerProps,
  Omit<React.HTMLAttributes<HTMLDivElement>, keyof ComposerProps> {}

/** The existing global navigation button and its menu; children extend that component. */
export interface GlobalNavigationProps {
  readonly children?: React.ReactNode;
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

/** Base retains native replying/error/needs-decision indications and adds children. */
export interface SessionStatusProps {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly needsDecision: boolean;
  /** Phrasing-only, noninteractive badges inside the session's existing button. */
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
  attachment: AttachmentProps;
  globalNavigation: GlobalNavigationProps;
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

export interface ModuleFrontendContext {
  /** Web contract only. Module manifest, backend context and route API remain v1. */
  readonly apiVersion: 2;
  readonly uiVersion: 1;
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
  /** Unchanged narrow module-worker metadata; never authority over the page/root scope. */
  readonly worker?: { entry: string; scope: string };
}

/**
 * All IDs are nonempty and unique within this module across state services,
 * draft schemas, middleware and Markdown. The host stages the entire activation
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
  readonly components?: readonly ModuleComponentMiddleware[];
  readonly markdown?: readonly MarkdownRenderer[];
  dispose?(): void;
}

export type ActivateFrontend = (context: ModuleFrontendContext) => ModuleFrontend | Promise<ModuleFrontend>;
