import type { Readable } from 'node:stream';
import type {
  ModuleEventPayload,
  ModuleHostIntent,
  ModuleHostIntentBody,
  ModuleHostIntentResult,
  NativeChatEvent,
  ServerEvent,
  RoleSelection,
  RoleAvailabilityReason,
  PromptAccepted,
} from './contract.ts';

export * from './contract.ts';

export interface ModuleHostApi {
  /** Role-only native resource discovery and connection policy. */
  readonly roleResourcePolicyVersion?: 1;
  /** Body-free native prompt acceptance observations with trusted Host ingress class. */
  readonly promptOriginVersion?: 1;
  /** Atomic role permission and durable saved-selection notifications. */
  readonly roleAssignmentVersion?: 1;
  /** Structural exclusive compatibility and bounded selection-time module checks. */
  readonly roleAvailabilityVersion?: 1;
  /** Bounded, passive native session metadata directory. */
  readonly sessionDirectoryVersion?: 1;
  /** Explicit load without closing or reloading an existing handle. */
  readonly sessionLoadVersion?: 1;
  /** Check before resource-aware creation/preparation; absent on older hosts. */
  readonly resourcePreparationVersion?: 1;
  /** Immutable native tool allowlist at creation and passive actual tool metadata. */
  readonly toolScopeVersion?: 1;
  /** Native respondAsk bridge; check before opening persistent module data. */
  readonly askResponseVersion?: 1;
  /** Bounded native session/chat reads; absent on older hosts. */
  readonly chatReadVersion?: 1;
  /** Successful prompt returns the native user.message.data.messageId acceptance receipt. */
  readonly promptReceiptVersion?: 1;
  call<Name extends ModuleHostIntent>(
    name: Name,
    body: ModuleHostIntentBody<Name>,
  ): Promise<ModuleHostIntentResult<Name>>;
}

export interface RoleAssignment {
  operation: 'create' | 'add';
  sessionId: string;
  /** Complete proposed selection, including roles belonging to other modules. */
  roles: RoleSelection[];
  previousRoles: RoleSelection[];
}

export interface RoleAssignmentNotification extends RoleAssignment {
  /** Stable across explicit notification-only replay; consumers must deduplicate. */
  notificationId: string;
}

export interface RoleAvailabilityCheck {
  operation: 'create' | 'add';
  /** Absent for a new-session preflight; present for mutations and additions. */
  sessionId?: string;
  roles: RoleSelection[];
  previousRoles: RoleSelection[];
}
export type ModuleRoleAvailabilityReason = Omit<RoleAvailabilityReason, 'source'>;

export interface NativeObservation {
  sessionId: string;
  cwd: string | null;
  readonly workspacePath?: string | null;
  event: NativeChatEvent;
}

export interface ModuleRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  signal: AbortSignal;
}

export interface ModuleResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown | Readable;
}

export interface ModuleRoute {
  method: 'GET' | 'HEAD' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  path: string;
  body?: 'json' | 'stream';
  bodyLimit?: number;
  handler(request: ModuleRequest): ModuleResponse | Promise<ModuleResponse>;
}

export interface ModuleBackendContext {
  /** Public validated host intents only; no native runtime or state-store access. */
  host: ModuleHostApi;
  apiVersion: 1;
  /**
   * Advertises ModuleBackend.onReady support; absent on older API v1 hosts.
   * Modules requiring readiness must check this before opening/migrating data.
   */
  readonly serviceReadyVersion: 1;
  /** Opt-in onStop drain, distinct from legacy best-effort disposal. */
  readonly shutdownVersion: 1;
  moduleId: string;
  dataRoot: string;
  apiBase: string;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  /** Aborted when shutdown begins; stop accepting business before any await. */
  readonly stopping: AbortSignal;
  report(error: unknown): void;
  invalidate(): void;
  /**
   * Best-effort delivery through the existing SSE, scoped to this module.
   * Inactive before activation/after stop, like invalidate(). Active calls throw
   * and report invalid/oversized data or an unavailable/failed transport.
   * Validation codes: MODULE_EVENT_INVALID / MODULE_EVENT_TOO_LARGE.
   * Missing transport: MODULE_EVENT_UNAVAILABLE. No implicit fallback is sent.
   * Only finite, dense, plain JSON data up to 64 nested levels is supported.
   * The host captures an immutable snapshot; no delivery ACK or replay is implied.
   */
  publish(payload: ModuleEventPayload): void;
}

export interface ModuleBackend {
  routes: readonly ModuleRoute[];
  /** Live acceptance facts only. Errors do not undo or retry an accepted native send. */
  promptAccepted?(event: PromptAccepted): void | Promise<void>;
  roleAssignments?: {
    /**
     * Explicit preflight and locked mutation recheck. No reservation or readiness.
     * May reconcile stale module bindings using authoritative passive existence
     * reads; never load/prompt/send. Honor signal and fence late cleanup writes.
     * Return all known reasons; [] means no module objection at this instant.
     * Throw/timeout becomes an unknown reason without erasing other checks.
     */
    availability?(selection: RoleAvailabilityCheck, signal: AbortSignal):
      { reasons: ModuleRoleAvailabilityReason[] } | Promise<{ reasons: ModuleRoleAvailabilityReason[] }>;
    /** Absent means allow. Called at mutation time, not just by a UI preflight. */
    permit?(assignment: RoleAssignment, signal: AbortSignal):
      { allowed: true } | { allowed: false; reason: string }
      | Promise<{ allowed: true } | { allowed: false; reason: string }>;
    /** Saved selection is not native readiness, existence, or permission to load. */
    saved?(notification: RoleAssignmentNotification, signal: AbortSignal): void | Promise<void>;
  };
  publicConfig?: Readonly<Record<string, unknown>>;
  /**
   * Called once after the runtime has started and public HTTP is listening,
   * unless the host is already stopping. Not awaited by startup. An onStop module's
   * pending callback is joined during shutdown; legacy callbacks remain best-effort.
   * Observe context.stopping for shutdown and context.signal for final revocation.
   * Throws/rejections are reported as module errors, without retry or unload.
   * Requires context.serviceReadyVersion === 1; apiVersion alone is not enough.
   */
  onReady?(): void | Promise<void>;
  /**
   * Opt in to awaited shutdown. Invoked once after stopping is aborted and new
   * HTTP/event ingress is gated, before native/transport teardown. Stop producers
   * and settle started external sends/persistence, including unknown outcomes.
   * Host joins pending onReady/HTTP/event callbacks. During drain only passive
   * session reads and respondAsk remain available through host.call.
   * Failure or the host's 60-second deadline prevents automatic teardown/exit.
   * Requires context.shutdownVersion === 1. Legacy dispose alone is not a drain.
   */
  onStop?(): void | Promise<void>;
  events?: {
    types: readonly string[];
    handle(observation: NativeObservation): void | Promise<void>;
  };
  controlEvents?: {
    types: readonly ServerEvent['type'][];
    handle(event: ServerEvent): void | Promise<void>;
  };
  /** Final resource release; awaited only when onStop opts into shutdownVersion 1. */
  dispose?(): void | Promise<void>;
}

export type ActivateBackend = (context: ModuleBackendContext) => ModuleBackend | Promise<ModuleBackend>;
