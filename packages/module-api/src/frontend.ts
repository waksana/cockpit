import type * as React from 'react';
import type { NativeAttachment, NativeAttachmentDescriptor, SessionStatus } from '@cockpit/protocol';

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

export interface DraftAttachment {
  readonly id: string;
  readonly value: ReadonlyData<NativeAttachment>;
}

export interface DraftBlock {
  readonly id: string;
  readonly reason: string;
  readonly orphaned: boolean;
}

export interface ModuleDraftSnapshot {
  readonly text: string;
  readonly attachments: readonly DraftAttachment[];
  readonly blocks: readonly DraftBlock[];
  /** Text edit revision; an acknowledged send clears only its captured revision. */
  readonly revision: number;
  readonly pending: boolean;
  /** Failure or unknown native outcome: retained content is not permission to retry. */
  readonly unconfirmed: boolean;
}

/**
 * A host-issued, stable reference to one captured draft, not a native store.
 * id identifies the draft lifetime, not just its session. Switching the active
 * session never retargets this reference. Snapshots include no mutable internals.
 */
export interface DraftReference extends ReadonlyState<ModuleDraftSnapshot> {
  readonly id: string;
  readonly sessionId: string;
}

export type DraftWrite = 'text' | 'attachments';

/**
 * Module-scoped actions, authorized by ModuleFrontend.writes. Attachment writes
 * validate native values, preserve ownership, and reject while pending; text
 * edits may continue during a send and advance revision. No submit/ack/reset or
 * raw patch action is exposed. Removal/replacement cannot take another module's
 * attachment. Unowned restored attachments remain removable.
 */
export interface ModuleDraft extends DraftReference {
  appendAttachments(values: readonly DraftAttachment[]): void;
  removeAttachment(id: string): void;
  editText(text: string): void;
  /**
   * Requires a declared draft write. The idempotent release applies only to this
   * module's lease. On module failure/disposal, unresolved leases first become
   * visible host recovery blocks; late cleanup cannot release those blocks.
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
   * Stable per-module binding for this exact host reference; rejects foreign or
   * revoked references. Binding does not create a module service or subscribe.
   * May be called by a stable middleware component without rebuilding its HOC.
   */
  bindDraft(reference: DraftReference): ModuleDraft;
}

export type ComposerOperation = 'prompt' | 'ask' | 'plan' | 'elicitation';

/** A captured input target. Recheck draft.pending before attachment mutation. */
export interface ComposerTarget {
  readonly draft: DraftReference;
  readonly operation: ComposerOperation;
  readonly disabled: boolean;
}

/** The same target with the calling module's authorized draft actions. */
export interface ComposerContext extends ComposerTarget {
  readonly draft: ModuleDraft;
}

export interface ComposerFileSelection {
  readonly id: string;
  readonly files: readonly File[];
  readonly source: 'picker' | 'paste' | 'drop';
  readonly target: ComposerTarget;
}

/**
 * Synchronous ownership handoff, not upload completion. Return true only after
 * EVERY selected file is retained in module state with a draft block
 * (or attached result); failures stay visible/blocking until explicitly removed.
 * Return false to decline. A middleware handles OR calls the inherited callback,
 * never both. Promises are not accepted; asynchronous uploads live in the service.
 */
export type ComposerFileCallback = (selection: ComposerFileSelection) => boolean;

export interface ComposerInteractions {
  /**
   * Opens one multi-file native picker. The host captures the draft, operation and composed
   * onFiles callback now, dispatches once on change, and retains them through
   * session switches/unmounts. Cancellation dispatches nothing. Late results for
   * unavailable modules become visible recovery blocks on the captured draft.
   */
  pickFiles(): void;
}

export interface ComposerProps extends ComposerTarget {
  readonly busy: boolean;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly sendBlocked: boolean;
  readonly statusInHeader?: boolean;
  /** Existing context/notices, followed by middleware content, before the input. */
  readonly children?: React.ReactNode;
  /** Existing draft attachment nodes. Compose rather than silently suppress them. */
  readonly attachments?: React.ReactNode;
  /** Ordinary render prop for controls inside the existing input row, without a container. */
  readonly actions?: (interactions: ComposerInteractions) => React.ReactNode;
  /** Host editor action; preserves captured-draft text revision semantics. */
  onTextChange(text: string): void;
  /** Host rechecks current pending/blocks/operation/disabled gates, even if invoked directly. */
  onSubmit(): void;
  /**
   * The base extracts picker/paste/drop files through this ONE callback chain.
   * It never consumes mixed clipboard text, changes IME behavior, or duplicates
   * keyboard submission. Each selection has a host guard until handoff; false,
   * throw, invalid result, or missing handler retains a named, visible recovery
   * block, never silently dropping files. A true result releases the host guard
   * only when backed by a module-owned block or newly attached results.
   * Async upload failure is module state.
   */
  readonly onFiles?: ComposerFileCallback;
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
  /** Actual nodes inside the existing body, alongside children (e.g. an absolute redline). */
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

export type AttachmentSource =
  | { readonly kind: 'draft'; readonly draft: DraftReference; readonly id: string }
  | { readonly kind: 'message'; readonly origin?: MessageOrigin; readonly index: number };

/**
 * One native/draft attachment, never a Markdown reference. The host owns the
 * surrounding list/layout. Replacement forwards core actions (especially remove)
 * and disabled state; unsupported values call Base with the original props.
 * A replacement may occupy the row itself without an intermediate HTML wrapper.
 */
export interface AttachmentProps {
  readonly source: AttachmentSource;
  readonly attachment: ReadonlyData<NativeAttachmentDescriptor>;
  readonly label: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
}

/** Base renders its children without introducing a module-placeholder container. */
export interface GlobalActionsProps {
  readonly children?: React.ReactNode;
}

export interface ModuleComponentProps {
  message: MessageProps;
  sessionStatus: SessionStatusProps;
  composer: ComposerProps;
  attachment: AttachmentProps;
  globalActions: GlobalActionsProps;
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
 * All IDs are nonempty and unique within this module across state, middleware
 * and Markdown registrations. The host stages/validates the entire activation
 * before publishing; old slot fields and frontend versions are rejected.
 *
 * Middleware sorts by (order ?? 0, moduleId, id), lowest first/outermost, and is
 * composed once per registration/base change, NOT per render/draft. Composition
 * and error boundaries add no HTML. Preserve inherited children, refs, actions,
 * native a11y and scroll anchors; a fault restores Base and revokes that module.
 *
 * Stopping revokes draft bindings and preserves unresolved input blocks before
 * aborting the signal or running cleanup. dispose and service disposers run once
 * (services in reverse registration order), including activation rollback;
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
