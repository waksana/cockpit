import type { Readable } from 'node:stream';
import type { ModuleEventPayload, NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent, ServerEvent } from '@cockpit/protocol';
import type { IntentBody, IntentResult } from '@cockpit/protocol';

export type { NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent, ServerEvent };
export { MAX_MODULE_EVENT_BYTES } from '@cockpit/protocol';
export type { ModuleEventPayload } from '@cockpit/protocol';
export type * from './frontend.ts';
export type * from './ui.ts';

export interface ModuleManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  backend: string;
  roles?: ModuleRole[];
  frontend?: {
    entry: string;
    styles?: string[];
    assets: string[];
    worker?: string;
    /** Independent new-UI entry; its files must use the same declared asset roots. */
    next?: { entry: string; styles?: string[] };
  };
}

export interface ModuleRole {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  skillDirectories?: string[];
  mcpServers?: Record<string, { type: 'http'; path: string; tools: string[] }>;
}

export type ModuleHostIntent = 'session/new' | 'session/get' | 'session/rename' | 'roles/readiness' | 'session/resources-prepare' | 'prompt';
export interface ModuleHostApi {
  /** Check before resource-aware creation/preparation; absent on older hosts. */
  readonly resourcePreparationVersion?: 1;
  call<N extends ModuleHostIntent>(name: N, body: IntentBody<N>): Promise<IntentResult<N>>;
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

export interface ModuleAsset {
  id: string;
  name: string;
  version: string;
  digest: string;
  apiBase: string;
  entry: string;
  styles: string[];
  next?: { entry: string; styles: string[] };
  config: Readonly<Record<string, unknown>>;
  worker?: { entry: string; scope: string };
}
