import type { Readable } from 'node:stream';
import type {
  ModuleEventPayload,
  ModuleHostIntent,
  ModuleHostIntentBody,
  ModuleHostIntentResult,
  NativeChatEvent,
  ServerEvent,
} from './contract.ts';

export * from './contract.ts';

export interface ModuleHostApi {
  /** Check before resource-aware creation/preparation; absent on older hosts. */
  readonly resourcePreparationVersion?: 1;
  call<Name extends ModuleHostIntent>(
    name: Name,
    body: ModuleHostIntentBody<Name>,
  ): Promise<ModuleHostIntentResult<Name>>;
}

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
  moduleId: string;
  dataRoot: string;
  apiBase: string;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
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
  publicConfig?: Readonly<Record<string, unknown>>;
  /**
   * Called once after the runtime has started and public HTTP is listening,
   * unless the host is already stopping. Not awaited by startup or shutdown.
   * Use context.signal for cancellation; recheck it after awaits.
   * Throws/rejections are reported as module errors, without retry or unload.
   * Requires context.serviceReadyVersion === 1; apiVersion alone is not enough.
   */
  onReady?(): void | Promise<void>;
  events?: {
    types: readonly string[];
    handle(observation: NativeObservation): void | Promise<void>;
  };
  controlEvents?: {
    types: readonly ServerEvent['type'][];
    handle(event: ServerEvent): void | Promise<void>;
  };
  dispose?(): void;
}

export type ActivateBackend = (context: ModuleBackendContext) => ModuleBackend | Promise<ModuleBackend>;
