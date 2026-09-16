import type * as React from 'react';
import type { Readable } from 'node:stream';
import type { NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent } from '@cockpit/protocol';

export type { NativeAttachment, NativeAttachmentDescriptor, NativeChatEvent };

export interface ModuleManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  backend: string;
  frontend?: { entry: string; styles?: string[]; assets: string[] };
}

export interface NativeObservation {
  sessionId: string;
  cwd: string | null;
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
}

export interface ModuleBackend {
  routes: readonly ModuleRoute[];
  publicConfig?: Readonly<Record<string, unknown>>;
  events?: {
    types: readonly string[];
    handle(observation: NativeObservation): void | Promise<void>;
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
}

export interface DraftAttachment {
  id: string;
  value: NativeAttachment;
}

export interface ModuleDraftSnapshot {
  text: string;
  attachments: readonly DraftAttachment[];
  pending: boolean;
}

export interface ModuleDraft {
  readonly sessionId: string;
  getSnapshot(): ModuleDraftSnapshot;
  subscribe(listener: () => void): () => void;
  appendAttachments(values: readonly DraftAttachment[]): void;
  removeAttachment(id: string): void;
  editText(text: string): void;
  block(reason: string): () => void;
}

export interface ComposerContext {
  draft: ModuleDraft;
  operation: 'prompt' | 'ask' | 'plan' | 'elicitation';
  disabled: boolean;
}

export interface MessageOrigin {
  sessionId: string;
  messageId: string;
  agentId?: string;
}

export interface RenderNode {
  kind: 'link' | 'image' | 'attachment';
  origin: MessageOrigin;
  target?: string;
  label: string;
  attachment?: NativeAttachmentDescriptor;
}

export interface ModuleFrontendContext {
  apiVersion: 1;
  moduleId: string;
  react: typeof React;
  apiBase: string;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  request(path: string, init?: RequestInit): Promise<Response>;
  report(error: unknown): void;
}

export interface FrontendContribution {
  id: string;
  order?: number;
  component: React.ComponentType<ComposerContext>;
}

export interface FileInputHandler {
  id: string;
  accepts(files: readonly File[]): boolean;
  receive(files: readonly File[], context: ComposerContext): void;
}

export interface ChatRenderer {
  id: string;
  matches(node: RenderNode): boolean;
  component: React.ComponentType<{ node: RenderNode }>;
}

export interface ModuleFrontend {
  writes?: readonly ('text' | 'attachments')[];
  composerActions?: readonly FrontendContribution[];
  composerAbove?: readonly FrontendContribution[];
  fileInput?: readonly FileInputHandler[];
  chatRenderers?: readonly ChatRenderer[];
  dispose?(): void;
}

export type ActivateFrontend = (context: ModuleFrontendContext) => ModuleFrontend | Promise<ModuleFrontend>;
