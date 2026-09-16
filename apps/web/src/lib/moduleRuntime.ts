import * as React from 'react';
import type { ChatRenderer, ComposerContext, FrontendContribution, ModuleAsset, ModuleFrontend, ModuleFrontendContext, RenderNode } from '@cockpit/module-api';
import type { SessionDraft } from './textDraft';
import { describeReason, reportUxError } from './errorReporter';

interface RuntimeOptions {
  baseUrl?: string;
  pageUrl?: string;
  fetch?: typeof fetch;
  load?: (url: string) => Promise<{ activate?: unknown }>;
  style?: (url: string) => () => void;
  report?: (error: unknown) => void;
  activationTimeoutMs?: number;
}
export interface LoadedModule {
  readonly asset: ModuleAsset;
  readonly frontend: ModuleFrontend;
  readonly signal: AbortSignal;
  readonly bindings: Map<SessionDraft, ReturnType<SessionDraft['bindModule']>>;
  stop(): void;
}
export interface RegisteredRenderer { module: LoadedModule; renderer: ChatRenderer }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && !!value.trim(); }

function backendUrl(base: string, page: string): URL {
  const url = new URL(`${base.replace(/\/+$/, '')}/`, page);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid module backend URL');
  return url;
}
function safePath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  if ([...path].some(character => character.charCodeAt(0) <= 32 || character === '\\')
    || /%2f|%5c|%2e/i.test(pathname)) return false;
  return !pathname.split('/').some(segment => segment === '.' || segment === '..');
}

export function validateModuleAsset(value: unknown, backend: URL): ModuleAsset {
  if (!record(value) || !nonempty(value.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)
    || !nonempty(value.name) || !nonempty(value.version) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || !record(value.config) || !Array.isArray(value.styles) || value.styles.some(style => typeof style !== 'string')
    || ('apiVersion' in value && value.apiVersion !== 1)) throw new Error('Invalid module asset manifest');
  const root = new URL(`_modules/${value.id}/${value.digest}/`, backend);
  const assets = new URL(`_modules/assets/${value.id}/${value.digest}/`, backend);
  const resolve = (input: unknown, asset: boolean): string => {
    if (!nonempty(input) || !safePath(input)) throw new Error('Unsafe module URL');
    // Server manifests are deployment-relative; the configured backend owns their prefix.
    const url = input.startsWith('/_modules/') ? new URL(input.slice(1), backend) : new URL(input, backend);
    if (url.origin !== backend.origin || url.username || url.password || url.search || url.hash) throw new Error('Module URL escaped its backend scope');
    if (asset ? !url.pathname.startsWith(assets.pathname) || url.pathname === assets.pathname
      : url.pathname !== `${root.pathname}api`) throw new Error('Module URL is not bound to its manifest');
    return url.href;
  };
  return Object.freeze({
    id: value.id, name: value.name, version: value.version, digest: value.digest,
    apiBase: resolve(value.apiBase, false), entry: resolve(value.entry, true),
    styles: value.styles.map(style => resolve(style, true)), config: Object.freeze({ ...value.config }),
  });
}

function validateFrontend(input: unknown): ModuleFrontend {
  if (!record(input)) throw new Error('Module activate must return contributions');
  const allowed = new Set(['writes', 'rendersDraftAttachments', 'composerActions', 'composerAbove', 'fileInput', 'chatRenderers', 'dispose']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported module contribution: ${key}`);
  if (input.writes !== undefined && (!Array.isArray(input.writes)
    || input.writes.some(value => value !== 'text' && value !== 'attachments'))) throw new Error('Invalid module writes declaration');
  for (const key of ['composerActions', 'composerAbove', 'fileInput', 'chatRenderers'] as const) {
    const entries = input[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Invalid module ${key}`);
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!record(entry) || !nonempty(entry.id) || ids.has(entry.id)) throw new Error(`Invalid module ${key} ID`);
      ids.add(entry.id);
      if (key === 'fileInput') {
        if (typeof entry.accepts !== 'function' || typeof entry.receive !== 'function') throw new Error('Invalid file input handler');
      } else {
        if (typeof entry.component !== 'function' && !(record(entry.component) && '$$typeof' in entry.component)) throw new Error('Invalid module component');
        if (key === 'chatRenderers' && typeof entry.matches !== 'function') throw new Error('Invalid chat renderer');
        if (entry.order !== undefined && (typeof entry.order !== 'number' || !Number.isFinite(entry.order))) throw new Error('Invalid module order');
      }
    }
  }
  if (input.dispose !== undefined && typeof input.dispose !== 'function') throw new Error('Invalid module dispose');
  if (input.rendersDraftAttachments !== undefined && typeof input.rendersDraftAttachments !== 'boolean') {
    throw new Error('Invalid draft attachment rendering declaration');
  }
  if (input.rendersDraftAttachments && (!Array.isArray(input.composerAbove) || !input.composerAbove.length)) {
    throw new Error('Draft attachment rendering requires a composerAbove contribution');
  }
  return input as ModuleFrontend;
}

function installStyle(url: string): () => void {
  const element = document.createElement('link');
  element.rel = 'stylesheet'; element.href = url;
  element.onerror = () => reportUxError(`模块样式加载失败：${url}`);
  document.head.appendChild(element);
  return () => element.remove();
}

export class ModuleRuntime {
  private readonly options: RuntimeOptions;
  private snapshot: readonly LoadedModule[] = [];
  private readonly listeners = new Set<() => void>();
  private controller?: AbortController;
  private readonly reports = new Set<string>();
  constructor(options: RuntimeOptions = {}) {
    if (options.activationTimeoutMs !== undefined
      && (!Number.isFinite(options.activationTimeoutMs) || options.activationTimeoutMs <= 0)) throw new Error('Invalid module activation timeout');
    this.options = options;
  }
  getSnapshot = (): readonly LoadedModule[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(modules: readonly LoadedModule[]) {
    this.snapshot = modules;
    for (const listener of this.listeners) listener();
  }
  report = (error: unknown): void => {
    const message = describeReason(error, false);
    if (this.reports.has(message)) return;
    this.reports.add(message);
    if (this.options.report) this.options.report(error);
    else reportUxError(`模块反馈：${message}。原生聊天仍可使用。`);
  };
  async start(baseUrl = this.options.baseUrl ?? ''): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const backend = backendUrl(baseUrl, this.options.pageUrl ?? window.location.href);
      const fetcher = this.options.fetch ?? globalThis.fetch;
      const response = await fetcher(new URL('_modules', backend), { credentials: 'include', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error(`Module bootstrap HTTP ${response.status}`);
      const bootstrap: unknown = await response.json();
      if (!record(bootstrap) || !Array.isArray(bootstrap.modules) || !Array.isArray(bootstrap.errors)
        || ('apiVersion' in bootstrap && bootstrap.apiVersion !== 1)) throw new Error('Invalid module bootstrap');
      for (const error of bootstrap.errors) this.report(record(error) ? `${String(error.id ?? 'module')}: ${String(error.error ?? error.message ?? 'load failed')}` : error);
      const counts = new Map<string, number>();
      for (const item of bootstrap.modules) if (record(item) && typeof item.id === 'string') counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      const pending: Promise<void>[] = [];
      for (const item of bootstrap.modules) {
        if (controller.signal.aborted) break;
        try {
          const asset = validateModuleAsset(item, backend);
          if (counts.get(asset.id) !== 1) throw new Error(`Duplicate module ${asset.id}`);
          pending.push(this.activate(asset, fetcher, controller.signal)
            .catch(error => { if (!controller.signal.aborted) this.report(error); }));
        } catch (error) { if (!controller.signal.aborted) this.report(error); }
      }
      await Promise.all(pending);
    } catch (error) { if (!controller.signal.aborted) this.report(error); }
  }
  private async activate(asset: ModuleAsset, fetcher: typeof fetch, parentSignal: AbortSignal) {
    const controller = new AbortController();
    const bindings: LoadedModule['bindings'] = new Map();
    const styles: (() => void)[] = [];
    let frontend: ModuleFrontend | undefined;
    let disposeFrontend: (() => unknown) | undefined;
    const stop = () => {
      // Capture unresolved selections before plugin abort listeners release their leases.
      for (const binding of bindings.values()) binding.dispose();
      bindings.clear();
      controller.abort();
      for (const remove of styles.splice(0)) remove();
      const cleanup = disposeFrontend;
      disposeFrontend = undefined;
      try { if (cleanup) void Promise.resolve(cleanup()).catch(this.report); } catch (error) { this.report(error); }
      frontend = undefined;
      parentSignal.removeEventListener('abort', stop);
    };
    parentSignal.addEventListener('abort', stop, { once: true });
    const context: ModuleFrontendContext = {
      apiVersion: 1, moduleId: asset.id, react: React, apiBase: asset.apiBase,
      config: asset.config, signal: controller.signal, report: this.report,
      request: async (path, init = {}) => {
        controller.signal.throwIfAborted();
        if (!safePath(path)) throw new Error('Unsafe module request path');
        const base = new URL(`${asset.apiBase}/`);
        const url = new URL(path.replace(/^\/(?!\/)/, ''), base);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash) throw new Error('Module request escaped its API');
        const headers = new Headers(init.headers);
        headers.set('x-cockpit-module-digest', asset.digest);
        const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        return fetcher(url, { ...init, headers, signal, credentials: 'include', redirect: 'error', mode: 'cors' });
      },
    };
    const prepare = async () => {
      const imported = await (this.options.load ?? (url => import(/* @vite-ignore */ url)))(asset.entry);
      if (controller.signal.aborted || parentSignal.aborted) return;
      if (typeof imported.activate !== 'function') throw new Error(`Module ${asset.id} has no activate export`);
      const activated: unknown = await imported.activate(context);
      if (record(activated) && typeof activated.dispose === 'function') {
        const dispose = activated.dispose;
        disposeFrontend = () => dispose.call(activated);
      }
      if (controller.signal.aborted || parentSignal.aborted) { stop(); return; }
      frontend = validateFrontend(activated);
      for (const style of asset.styles) styles.push((this.options.style ?? installStyle)(style));
      const loaded: LoadedModule = { asset, frontend, bindings, signal: controller.signal, stop };
      this.publish([...this.snapshot, loaded].sort((a, b) => a.asset.id.localeCompare(b.asset.id)));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = () => {};
    const cancellation = new Promise<void>(resolve => {
      cancelled = resolve;
      if (parentSignal.aborted) resolve();
      else parentSignal.addEventListener('abort', cancelled, { once: true });
    });
    try {
      await Promise.race([prepare(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { stop(); reject(new Error(`Module ${asset.id} activation timed out`)); },
          this.options.activationTimeoutMs ?? 10_000);
      }), cancellation]);
    } catch (error) { stop(); throw error; }
    finally { clearTimeout(timer); parentSignal.removeEventListener('abort', cancelled); }
  }
  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.publish([]);
  }
  unregister(module: LoadedModule): void {
    if (!this.snapshot.includes(module)) return;
    module.stop();
    this.publish(this.snapshot.filter(loaded => loaded !== module));
  }
  context(module: LoadedModule, draft: SessionDraft, operation: ComposerContext['operation'], disabled: boolean): ComposerContext {
    let binding = module.bindings.get(draft);
    if (!binding) {
      if (module.signal.aborted) throw new Error('Module has stopped');
      binding = draft.bindModule(`${module.asset.id}@${module.asset.digest}`, module.frontend.writes ?? []);
      module.bindings.set(draft, binding);
    }
    return { draft: binding.draft, operation, disabled };
  }
  contributions(slot: 'composerActions' | 'composerAbove'): { module: LoadedModule; contribution: FrontendContribution }[] {
    return this.snapshot.flatMap(module => (module.frontend[slot] ?? []).map(contribution => ({ module, contribution })))
      .sort((a, b) => (a.contribution.order ?? 0) - (b.contribution.order ?? 0)
        || a.module.asset.id.localeCompare(b.module.asset.id) || a.contribution.id.localeCompare(b.contribution.id));
  }
  renderer(node: RenderNode): RegisteredRenderer | undefined {
    let selected: RegisteredRenderer | undefined;
    for (const module of this.snapshot) for (const renderer of module.frontend.chatRenderers ?? []) {
      try {
        if (!renderer.matches(node)) continue;
        if (selected) {
          this.report(`多个模块渲染规则同时匹配 ${node.kind}，已保留默认显示。`);
          return;
        }
        selected = { module, renderer };
      }
      catch (error) { this.report(error); }
    }
    return selected;
  }
  receive(files: readonly File[], draft: SessionDraft, operation: ComposerContext['operation'], disabled: boolean): boolean {
    if (!files.length || disabled || draft.getSnapshot().pending) return false;
    const handlers = this.snapshot.flatMap(module => (module.frontend.fileInput ?? []).flatMap(handler => {
      try { return handler.accepts(files) ? [{ module, handler }] : []; }
      catch (error) { this.report(error); return []; }
    }));
    if (handlers.length > 1) this.report('多个模块接受相同文件，已使用排序最先的处理器。');
    const chosen = handlers[0];
    if (!chosen) { this.rejectFiles(draft, files, '没有可用的文件模块'); return false; }
    const context = this.context(chosen.module, draft, operation, disabled);
    const failed = (error: unknown) => {
      this.report(error);
      if (chosen.module.signal.aborted) return;
      this.unregister(chosen.module);
      this.rejectFiles(draft, files, '文件模块处理失败');
    };
    try {
      // The bound context is captured now, not looked up after asynchronous work/session switches.
      const outcome = chosen.handler.receive(files, context);
      Promise.resolve(outcome).catch(failed);
      return true;
    } catch (error) { failed(error); return false; }
  }
  private rejectFiles(draft: SessionDraft, files: readonly File[], reason: string) {
    const binding = draft.bindModule('host-rejected-input', ['attachments']);
    binding.draft.block(`${reason}：${files.map(file => file.name).join('、')}。请移除本次选择后重试。`);
    binding.dispose();
  }
}

// Importing/rendering components never starts network activity (including Chat Lab).
export const moduleRuntime = new ModuleRuntime();
