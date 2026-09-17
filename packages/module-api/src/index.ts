import type { Readable } from 'node:stream';
import type { NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent, ServerEvent } from '@cockpit/protocol';

export type { NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent, ServerEvent };
export type * from './frontend.ts';

export interface ModuleManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  backend: string;
  frontend?: { entry: string; styles?: string[]; assets: string[]; worker?: string };
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
  apiVersion: 1;
  moduleId: string;
  dataRoot: string;
  apiBase: string;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  report(error: unknown): void;
  invalidate(): void;
}

export interface ModuleBackend {
  routes: readonly ModuleRoute[];
  publicConfig?: Readonly<Record<string, unknown>>;
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
  config: Readonly<Record<string, unknown>>;
  worker?: { entry: string; scope: string };
}
