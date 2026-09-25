import * as React from 'react';
import { createPortal } from 'react-dom';
import type {
  ComponentMiddleware,
  HostSnapshot, ChatWindowSnapshot, MarkdownNode, MarkdownRenderer, ModuleAsset, ModuleComponentProps,
  DraftSchemaRegistration, ModuleEventPayload, ModuleFrontend, ModuleFrontendContext, ModuleStateRegistration,
  ModuleMenuRegistration, ModuleMenuState, ModuleMenuTarget,
  DraftReference, DraftSendBlockReason,
} from '@cockpit/module-api/frontend';
import { resolveDraft, type SessionDraft } from './textDraft';
import { RegisteredDraftSchema, type RuntimeDraftSchema } from './draftSchemas';
import { describeReason, reportUxError } from './errorReporter';
import { EMPTY_CHAT_WINDOW } from './moduleChatWindow';
import { useCockpit } from '../net/store';
import type { NativeDraftRequest } from './draft';

interface RuntimeOptions {
  baseUrl?: string;
  pageUrl?: string;
  fetch?: typeof fetch;
  load?: (url: string) => Promise<{ activate?: unknown }>;
  style?: (url: string) => () => void;
  report?: (error: unknown) => void;
  activationTimeoutMs?: number;
  draftSubmission?: {
    check(draft: SessionDraft): DraftSendBlockReason | undefined;
    send(request: NativeDraftRequest): Promise<boolean>;
  };
}
export interface LoadedModule {
  readonly asset: ModuleAsset;
  readonly frontend: ModuleFrontend;
  readonly signal: AbortSignal;
  readonly bindings: Map<SessionDraft, ReturnType<SessionDraft['bindModule']>>;
  readonly schemas: readonly RuntimeDraftSchema[];
  stop(): void;
}
export interface RegisteredRenderer { module: LoadedModule; renderer: MarkdownRenderer }
type Boundary = keyof ModuleComponentProps;
const BOUNDARIES = new Set<Boundary>(['message', 'sessionStatus', 'composer', 'composerEditor', 'composerInput', 'attachment',
  'managementHeader', 'managementDetailHeader']);
const EMPTY_VIEW: HostSnapshot = Object.freeze({ sessionId: null, visible: false, connected: false });
let moduleSequence = 0;

// Backend errors are activation failures or loaded-module runtime failures; request errors are not listed.
function bootstrapError(error: unknown): unknown {
  if (!record(error)) return error;
  const kind = error.stage === 'runtime' ? 'runtime error' : 'load failed';
  return `${String(error.id ?? 'module')}: ${kind}: ${String(error.error ?? error.message ?? 'unknown error')}`;
}

export class ModuleErrorBoundary extends React.Component<{
  children: React.ReactNode; fallback: React.ReactNode; onFailure(error: unknown): void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onFailure(error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

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
  const resolveUrl = (input: unknown): URL => {
    if (!nonempty(input) || !safePath(input)) throw new Error('Unsafe module URL');
    // Server manifests are deployment-relative; the configured backend owns their prefix.
    const url = input.startsWith('/_modules/') ? new URL(input.slice(1), backend) : new URL(input, backend);
    if (url.origin !== backend.origin || url.username || url.password || url.search || url.hash) throw new Error('Module URL escaped its backend scope');
    return url;
  };
  const resolve = (input: unknown, asset: boolean): string => {
    const url = resolveUrl(input);
    if (asset ? !url.pathname.startsWith(assets.pathname) || url.pathname === assets.pathname
      : url.pathname !== `${root.pathname}api`) throw new Error('Module URL is not bound to its manifest');
    return url.href;
  };
  let worker: ModuleAsset['worker'];
  if (value.worker !== undefined) {
    if (!record(value.worker) || Object.keys(value.worker).some(key => key !== 'entry' && key !== 'scope')) throw new Error('Invalid module worker');
    const scope = new URL(`_modules/workers/${value.id}/`, backend);
    const entry = resolveUrl(value.worker.entry);
    const advertisedScope = resolveUrl(value.worker.scope);
    if (entry.href !== `${scope.href}worker.js` || advertisedScope.href !== scope.href) throw new Error('Module worker URL is not bound to its manifest');
    worker = Object.freeze({ entry: entry.href, scope: scope.href });
  }
  return Object.freeze({
    id: value.id, name: value.name, version: value.version, digest: value.digest,
    apiBase: resolve(value.apiBase, false), entry: resolve(value.entry, true),
    styles: value.styles.map(style => resolve(style, true)), config: Object.freeze({ ...value.config }),
    ...(worker ? { worker } : {}),
  });
}

function component(value: unknown): boolean {
  return typeof value === 'function' || (record(value) && '$$typeof' in value);
}
function claimId(ids: Set<string>, id: unknown): void {
  if (!nonempty(id) || ids.has(id)) throw new Error(`Invalid or duplicate module registration ID: ${String(id)}`);
  ids.add(id);
}
function validateFrontend(input: unknown, ids: Set<string>): ModuleFrontend {
  if (!record(input) || input.apiVersion !== 2) throw new Error('Module frontend API v2 is required');
  const allowed = new Set(['apiVersion', 'writes', 'sends', 'components', 'markdown', 'menus', 'dispose']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported module frontend field: ${key}`);
  if (input.writes !== undefined && (!Array.isArray(input.writes)
    || input.writes.some(value => value !== 'text'))) throw new Error('Invalid module writes declaration');
  if (input.sends !== undefined && (!Array.isArray(input.sends)
    || input.sends.some(value => value !== 'draft'))) throw new Error('Invalid module sends declaration');
  for (const key of ['components', 'markdown', 'menus'] as const) {
    const entries = input[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Invalid module ${key}`);
    for (const entry of entries) {
      if (!record(entry)) throw new Error(`Invalid module ${key} registration`);
      claimId(ids, entry.id);
      const fields = key === 'components' ? ['id', 'boundary', 'order', 'wrap']
        : key === 'menus' ? ['id', 'menu', 'order', 'getState', 'subscribe', 'onSelect'] : ['id', 'matches', 'component'];
      if (Object.keys(entry).some(field => !fields.includes(field))) throw new Error(`Unsupported module ${key} registration field`);
      if (key === 'components') {
        if (!BOUNDARIES.has(entry.boundary as Boundary) || typeof entry.wrap !== 'function') throw new Error('Invalid component middleware');
        if (entry.order !== undefined && (typeof entry.order !== 'number' || !Number.isFinite(entry.order))) throw new Error('Invalid module order');
      } else if (key === 'menus') {
        if ((entry.menu !== 'global' && entry.menu !== 'session') || typeof entry.getState !== 'function'
          || typeof entry.onSelect !== 'function' || (entry.subscribe !== undefined && typeof entry.subscribe !== 'function')) {
          throw new Error('Invalid module menu registration');
        }
        if (entry.order !== undefined && (typeof entry.order !== 'number' || !Number.isFinite(entry.order))) throw new Error('Invalid module order');
      } else {
        if (!component(entry.component) || typeof entry.matches !== 'function') throw new Error('Invalid Markdown renderer');
      }
    }
  }
  if (input.dispose !== undefined && typeof input.dispose !== 'function') throw new Error('Invalid module dispose');
  return Object.freeze({
    ...input,
    ...(input.writes ? { writes: Object.freeze([...input.writes as string[]]) } : {}),
    ...(input.sends ? { sends: Object.freeze([...input.sends as string[]]) } : {}),
    components: Object.freeze((input.components as object[] ?? []).map(entry => Object.freeze({ ...entry }))),
    markdown: Object.freeze((input.markdown as object[] ?? []).map(entry => Object.freeze({ ...entry }))),
    menus: Object.freeze((input.menus as object[] ?? []).map(entry => Object.freeze({ ...entry }))),
  }) as unknown as ModuleFrontend;
}

export interface MenuTargetSource {
  isCurrent(): boolean;
  subscribe(listener: () => void): () => void;
}
export interface RegisteredMenuItem extends ModuleMenuState {
  readonly id: string;
  onClick(): void;
}

function menuState(entry: ModuleMenuRegistration, target: ModuleMenuTarget): ModuleMenuState {
  const state = entry.getState(target);
  if (!record(state) || !nonempty(state.label)
    || Object.keys(state).some(key => !['label', 'icon', 'visible', 'disabled', 'destructive', 'separatorBefore'].includes(key))
    || ['visible', 'disabled', 'destructive', 'separatorBefore'].some(key => state[key] !== undefined && typeof state[key] !== 'boolean')) {
    throw new Error(`Invalid menu state: ${entry.id}`);
  }
  return state;
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
  private view: HostSnapshot = EMPTY_VIEW;
  private readonly viewListeners = new Set<() => void>();
  private readChatWindow: () => ChatWindowSnapshot = () => EMPTY_CHAT_WINDOW;
  private readonly chatWindowListeners = new Set<() => void>();
  private readonly invalidationListeners = new Map<string, Set<() => void>>();
  private readonly eventListeners = new Map<string, Set<(payload: ModuleEventPayload) => void>>();
  private controller?: AbortController;
  private readonly reports = new Set<string>();
  private readonly componentCache = new Map<object, { boundary: Boundary; entries: readonly object[]; component: unknown }>();
  private readonly knownDrafts = new Set<SessionDraft>();
  private readonly readOnlySessions = new Map<string, boolean>();
  private menuRevision = 0;
  private readonly menuListeners = new Set<() => void>();
  private readonly menuFlights = new Map<ModuleMenuRegistration, Set<string>>();
  constructor(options: RuntimeOptions = {}) {
    if (options.activationTimeoutMs !== undefined
      && (!Number.isFinite(options.activationTimeoutMs) || options.activationTimeoutMs <= 0)) throw new Error('Invalid module activation timeout');
    this.options = options;
  }
  getSnapshot = (): readonly LoadedModule[] => this.snapshot;
  getViewSnapshot = (): HostSnapshot => this.view;
  getChatWindowSnapshot = (): ChatWindowSnapshot => this.readChatWindow();
  updateChatWindow(read: () => ChatWindowSnapshot): void {
    this.readChatWindow = read;
    for (const listener of [...this.chatWindowListeners]) if (this.chatWindowListeners.has(listener)) listener();
  }
  updateView(view: HostSnapshot): void {
    if (view.sessionId === this.view.sessionId && view.visible === this.view.visible && view.connected === this.view.connected) return;
    this.view = Object.freeze({ ...view });
    for (const listener of [...this.viewListeners]) if (this.viewListeners.has(listener)) listener();
  }
  invalidate(moduleId: string): void {
    const listeners = this.invalidationListeners.get(moduleId);
    if (listeners) for (const listener of [...listeners]) if (listeners.has(listener)) listener();
  }
  receiveEvent(moduleId: string, payload: ModuleEventPayload): void {
    const listeners = this.eventListeners.get(moduleId);
    if (listeners) for (const listener of [...listeners]) if (listeners.has(listener)) listener(payload);
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getMenuRevision = (): number => this.menuRevision;
  subscribeMenus = (listener: () => void): (() => void) => {
    this.menuListeners.add(listener);
    return () => { this.menuListeners.delete(listener); };
  };
  private menusChanged = (): void => {
    this.menuRevision++;
    for (const listener of this.menuListeners) listener();
  };
  private publish(modules: readonly LoadedModule[]) {
    this.snapshot = modules;
    const registrations = new Set(modules.flatMap(module => module.frontend.components ?? []));
    for (const [base, cached] of this.componentCache) {
      if (cached.entries.some(entry => !registrations.has(entry as NonNullable<ModuleFrontend['components']>[number]))) this.componentCache.delete(base);
    }
    for (const listener of this.listeners) listener();
    this.menusChanged();
  }
  report = (error: unknown): void => {
    const message = describeReason(error, false);
    if (this.reports.has(message)) return;
    this.reports.add(message);
    if (this.options.report) this.options.report(error);
    else reportUxError(`模块反馈：${message}。Copilot 聊天仍可使用。`);
  };
  private batchDraftChanges(change: () => void, additional: Iterable<SessionDraft> = []): void {
    const drafts = new Set([...this.knownDrafts, ...additional,
      ...this.snapshot.flatMap(module => [...module.bindings.keys()])]);
    const releases = [...drafts].map(draft => draft.deferNotifications());
    try { change(); } finally { for (const release of releases) release(); }
  }
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
      if (controller.signal.aborted || this.controller !== controller) return;
      if (!record(bootstrap) || !Array.isArray(bootstrap.modules) || !Array.isArray(bootstrap.errors)
        || ('apiVersion' in bootstrap && bootstrap.apiVersion !== 1)) throw new Error('Invalid module bootstrap');
      for (const error of bootstrap.errors) this.report(bootstrapError(error));
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
      if (!controller.signal.aborted) this.publish(this.snapshot);
    } catch (error) { if (!controller.signal.aborted) this.report(error); }
  }
  private async activate(asset: ModuleAsset, fetcher: typeof fetch, parentSignal: AbortSignal) {
    const controller = new AbortController();
    const owner = `${asset.id}@${asset.digest}:${++moduleSequence}`;
    const bindings: LoadedModule['bindings'] = new Map();
    const styles: (() => void)[] = [];
    const subscriptions = new Set<() => void>();
    const ids = new Set<string>();
    const services: (() => void)[] = [];
    const schemas: RuntimeDraftSchema[] = [];
    let registering = true;
    let registrationError: unknown;
    let frontend: ModuleFrontend | undefined;
    let disposeFrontend: (() => unknown) | undefined;
    const stop = () => this.batchDraftChanges(() => {
      registering = false;
      for (const schema of schemas) schema.dispose();
      for (const binding of bindings.values()) binding.dispose();
      bindings.clear();
      for (const unsubscribe of subscriptions) unsubscribe();
      controller.abort();
      for (const remove of styles.splice(0)) {
        try { remove(); } catch (error) { this.report(error); }
      }
      const cleanup = disposeFrontend;
      disposeFrontend = undefined;
      try { if (cleanup) void Promise.resolve(cleanup()).catch(this.report); } catch (error) { this.report(error); }
      for (const dispose of services.splice(0).reverse()) {
        try { void Promise.resolve(dispose()).catch(this.report); } catch (error) { this.report(error); }
      }
      frontend = undefined;
      parentSignal.removeEventListener('abort', stop);
    }, bindings.keys());
    const subscribe = <Args extends unknown[]>(listeners: Set<(...args: Args) => void>, listener: (...args: Args) => void, onEmpty?: () => void): (() => void) => {
      if (controller.signal.aborted) return () => {};
      const notify = (...args: Args) => { try { listener(...args); } catch (error) { this.report(error); } };
      const unsubscribe = () => {
        if (!subscriptions.has(unsubscribe)) return;
        listeners.delete(notify);
        subscriptions.delete(unsubscribe);
        if (!listeners.size) onEmpty?.();
      };
      listeners.add(notify);
      subscriptions.add(unsubscribe);
      return unsubscribe;
    };
    parentSignal.addEventListener('abort', stop, { once: true });
    const context: ModuleFrontendContext = {
      apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1, menuVersion: 1, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
      moduleId: asset.id, react: React, createPortal, apiBase: asset.apiBase,
      config: asset.config, signal: controller.signal, report: this.report,
      state: Object.freeze({
        host: Object.freeze({ getSnapshot: this.getViewSnapshot, subscribe: (listener: () => void) => subscribe(this.viewListeners, listener) }),
        chatWindow: Object.freeze({
          getSnapshot: () => {
            controller.signal.throwIfAborted();
            return this.getChatWindowSnapshot();
          },
          subscribe: (listener: () => void) => subscribe(this.chatWindowListeners, listener),
        }),
        register: <Service extends object>(registration: ModuleStateRegistration<Service>) => {
          if (!registering || controller.signal.aborted) throw new Error('Module state registration is activation-only');
          try {
            if (!record(registration) || typeof registration.create !== 'function' || typeof registration.dispose !== 'function'
              || Object.keys(registration).some(key => !['id', 'create', 'dispose'].includes(key))) throw new Error('Invalid module state registration');
            claimId(ids, registration.id);
            const service = registration.create();
            if (!service || (typeof service !== 'object' && typeof service !== 'function')
              || 'then' in service) {
              if (service && 'then' in Object(service)) void Promise.resolve(service).catch(this.report);
              throw new Error('Module state must be created synchronously');
            }
            const dispose = registration.dispose;
            services.push(() => dispose.call(registration, service));
            return Object.freeze({ id: registration.id, get: () => {
              if (controller.signal.aborted) throw new Error('Module state has stopped');
              return service;
            } });
          } catch (error) {
            registrationError = error;
            throw error;
          }
        },
        registerDraft: <State extends object>(registration: DraftSchemaRegistration<State>) => {
          if (!registering || controller.signal.aborted) throw new Error('Draft schema registration is activation-only');
          try {
            claimId(ids, registration?.id);
            const schema = new RegisteredDraftSchema(owner, asset.id, registration, this.report);
            schemas.push(schema);
            for (const draft of this.knownDrafts) schema.prepare(draft);
            return schema.handle;
          } catch (error) {
            registrationError = error;
            throw error;
          }
        },
        bindDraft: (reference: DraftReference) => {
          if (controller.signal.aborted || !frontend) throw new Error('Module draft binding is not active');
          const source = resolveDraft(reference);
          let binding = bindings.get(source);
          if (!binding) {
            binding = source.bindModule(owner, frontend.writes ?? [], this.report,
              () => schemas.some(schema => schema.applies(source) && schema.ready(source)),
              frontend.sends?.includes('draft') ? {
                check: () => {
                  if (this.readOnlySessions.get(source.sessionId)) return 'read-only';
                  if (!this.isDraftPrepared(source) || !this.knownDrafts.has(source) || !this.options.draftSubmission) return 'unavailable';
                  return this.options.draftSubmission.check(source);
                },
                send: request => this.options.draftSubmission!.send(request),
              } : undefined);
            bindings.set(source, binding);
          }
          return binding.draft;
        },
      }),
      onInvalidate: listener => {
        if (controller.signal.aborted) return () => {};
        let listeners = this.invalidationListeners.get(asset.id);
        if (!listeners) this.invalidationListeners.set(asset.id, listeners = new Set());
        return subscribe(listeners, listener, () => { this.invalidationListeners.delete(asset.id); });
      },
      onEvent: listener => {
        if (controller.signal.aborted) return () => {};
        let listeners = this.eventListeners.get(asset.id);
        if (!listeners) this.eventListeners.set(asset.id, listeners = new Set());
        return subscribe(listeners, listener, () => { this.eventListeners.delete(asset.id); });
      },
      ...(asset.worker ? { worker: asset.worker } : {}),
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
      registering = false;
      if (registrationError) throw registrationError;
      frontend = validateFrontend(activated, ids);
      for (const entry of frontend.menus ?? []) {
        if (!entry.subscribe) continue;
        let active = true;
        const unsubscribe = entry.subscribe(() => {
          if (active && !controller.signal.aborted) this.menusChanged();
        });
        if (typeof unsubscribe !== 'function') throw new Error(`Invalid menu unsubscribe: ${entry.id}`);
        const release = () => {
          active = false;
          subscriptions.delete(release);
          try { unsubscribe(); } catch (error) { this.report(error); }
        };
        subscriptions.add(release);
      }
      for (const style of asset.styles) styles.push((this.options.style ?? installStyle)(style));
      for (const schema of schemas) for (const draft of this.knownDrafts) schema.prepare(draft);
      for (const schema of schemas) schema.activate();
      const loaded: LoadedModule = { asset, frontend, bindings, schemas: Object.freeze(schemas), signal: controller.signal, stop };
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
    this.batchDraftChanges(() => {
      this.controller?.abort();
      this.controller = undefined;
      this.publish([]);
    });
  }
  unregister(module: LoadedModule): void {
    if (!this.snapshot.includes(module)) return;
    this.batchDraftChanges(() => {
      module.stop();
      this.publish(this.snapshot.filter(loaded => loaded !== module));
    });
  }
  fail(module: LoadedModule, error: unknown): void {
    this.report(error);
    this.unregister(module);
  }
  menuItems(target: ModuleMenuTarget, source: MenuTargetSource, isOpen: () => boolean): RegisteredMenuItem[] {
    const captured = Object.freeze({ ...target });
    const key = JSON.stringify(captured);
    const entries = this.snapshot.filter(module => !module.signal.aborted).flatMap(module => (module.frontend.menus ?? [])
      .filter(entry => entry.menu === captured.menu).map(entry => ({ module, entry })))
      .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0)
        || a.module.asset.id.localeCompare(b.module.asset.id) || a.entry.id.localeCompare(b.entry.id));
    return entries.flatMap(({ module, entry }) => {
      try {
        const state = menuState(entry, captured);
        if (state.visible === false) return [];
        return [{
          ...state, id: JSON.stringify(['module', module.asset.id, entry.id]),
          disabled: !!state.disabled || !source.isCurrent() || !!this.menuFlights.get(entry)?.has(key),
          onClick: () => {
            try {
              if (!isOpen() || module.signal.aborted || !this.snapshot.includes(module) || !source.isCurrent()) {
                throw new Error(`Menu target is no longer available: ${module.asset.id}/${entry.id}`);
              }
              const latest = menuState(entry, captured);
              if (latest.visible === false || latest.disabled || this.menuFlights.get(entry)?.has(key)) {
                throw new Error(`Menu action is unavailable: ${module.asset.id}/${entry.id}`);
              }
              this.runMenuAction(module, entry, captured, source, key);
            } catch (error) { this.reportMenu(module, entry, error); }
          },
        }];
      } catch (error) { this.reportMenu(module, entry, error); return []; }
    });
  }
  private reportMenu(module: LoadedModule, entry: ModuleMenuRegistration, error: unknown): void {
    this.report(new Error(`Menu ${module.asset.id}/${entry.id}: ${describeReason(error, false)}`, { cause: error }));
  }
  private runMenuAction(module: LoadedModule, entry: ModuleMenuRegistration, target: ModuleMenuTarget,
    source: MenuTargetSource, key: string): void {
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let finished = false;
    const abort = () => controller.abort();
    const finish = () => {
      if (finished) return;
      finished = true;
      module.signal.removeEventListener('abort', abort);
      try { unsubscribe?.(); } catch (error) { this.report(error); }
      unsubscribe = undefined;
      const flights = this.menuFlights.get(entry);
      flights?.delete(key);
      if (!flights?.size) this.menuFlights.delete(entry);
      this.menusChanged();
    };
    let flights = this.menuFlights.get(entry);
    if (!flights) this.menuFlights.set(entry, flights = new Set());
    flights.add(key);
    module.signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', finish, { once: true });
    try {
      unsubscribe = source.subscribe(() => { if (!source.isCurrent()) abort(); });
      if (finished) { unsubscribe(); unsubscribe = undefined; }
      if (module.signal.aborted || !source.isCurrent()) abort();
      controller.signal.throwIfAborted();
      this.menusChanged();
      // No await before invocation: browser permission APIs require the gesture.
      const result = entry.onSelect(target, { signal: controller.signal });
      void Promise.resolve(result).catch(error => this.reportMenu(module, entry, error)).finally(() => {
        controller.signal.removeEventListener('abort', finish);
        finish();
      });
    } catch (error) {
      controller.signal.removeEventListener('abort', finish);
      finish();
      this.reportMenu(module, entry, error);
    }
  }
  isDraftPrepared(draft: SessionDraft): boolean {
    return !draft.isRetired() && this.snapshot.every(module => module.schemas.every(schema => schema.ready(draft)));
  }
  prepareDraft(draft: SessionDraft, readOnly?: boolean): void {
    if (readOnly !== undefined) this.readOnlySessions.set(draft.sessionId, readOnly);
    if (draft.isRetired()) return;
    this.knownDrafts.add(draft);
    for (const module of [...this.snapshot]) {
      try { for (const schema of module.schemas) schema.prepare(draft); }
      catch (error) { this.fail(module, error); }
    }
    for (const listener of this.listeners) listener();
  }
  compose<Key extends Boundary>(boundary: Key, Base: React.ComponentType<ModuleComponentProps[Key]>): React.ComponentType<ModuleComponentProps[Key]> {
    const entries = this.snapshot.flatMap(module => (module.frontend.components ?? [])
      .filter(entry => entry.boundary === boundary).map(entry => ({ module, entry })))
      .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0)
        || a.module.asset.id.localeCompare(b.module.asset.id) || a.entry.id.localeCompare(b.entry.id));
    const cached = this.componentCache.get(Base);
    if (cached?.boundary === boundary && cached.entries.length === entries.length
      && entries.every(({ entry }, index) => cached.entries[index] === entry)) {
      return cached.component as React.ComponentType<ModuleComponentProps[Key]>;
    }
    let Composed = Base;
    for (const { module, entry } of entries.toReversed()) {
      const Next = Composed;
      try {
        const Enhanced = (entry.wrap as unknown as ComponentMiddleware<ModuleComponentProps[Key]>)(Next);
        if (!component(Enhanced)) throw new Error('Middleware must return a React component');
        Composed = (props: ModuleComponentProps[Key]) => {
          const fallback = React.createElement(Next, props);
          return module.signal.aborted ? fallback : React.createElement(ModuleErrorBoundary, {
            fallback, onFailure: (error: unknown) => this.fail(module, error),
            children: React.createElement(Enhanced, props),
          });
        };
      } catch (error) {
        this.fail(module, error);
      }
    }
    this.componentCache.set(Base, { boundary, entries: entries.map(({ entry }) => entry), component: Composed });
    return Composed;
  }
  renderer(node: MarkdownNode): RegisteredRenderer | undefined {
    let selected: RegisteredRenderer | undefined;
    let failed = false, claims = 0;
    for (const module of this.snapshot) for (const renderer of module.frontend.markdown ?? []) {
      try {
        if (!renderer.matches(node)) continue;
        claims++;
        selected = { module, renderer };
      }
      catch (error) { this.report(error); failed = true; }
    }
    if (claims > 1) {
      this.report(`多个模块渲染规则同时匹配 ${node.kind}，已保留默认显示。`);
      return;
    }
    return failed ? undefined : selected;
  }
}

// Importing/rendering components never starts network activity (including Chat Lab).
export const moduleRuntime = new ModuleRuntime({
  draftSubmission: {
    check: draft => useCockpit.getState().canSendDraft(draft.reference),
    send: request => useCockpit.getState().sendDraft(request),
  },
});
