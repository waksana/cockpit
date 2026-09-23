import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { z } from 'zod';
import { cockpitHome, type Engine } from '@cockpit/core';
import { ServerEvent, snapshotModuleEventPayload } from '@cockpit/protocol';
import type { ModuleAsset, ModuleBackend, ModuleBackendContext, ModuleEventPayload, ModuleRoute, NativeObservation, ModuleHostApi } from '@cockpit/module-api';
import { ModuleRoles } from './module-roles.ts';
import { isDeclaredAsset, moduleDataRoot, MODULE_WORKER_LIMIT, readModuleInstallation, readModuleSettings, safeModulePath, type ModuleInstallation } from './module-install.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const routeSchema = z.object({
  method: z.enum(['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH']),
  path: z.string().max(1024).refine(path => path === '/' || /^\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*(?:\/\*)?$/.test(path),
    'Module routes must be absolute relative-to-api paths with simple parameters'),
  body: z.enum(['json', 'stream']).optional(),
  bodyLimit: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
  handler: z.custom<ModuleRoute['handler']>(value => typeof value === 'function'),
}).strict().refine(route => !route.path.split('/').some(part => part === '.' || part === '..'), 'Dot route segments are forbidden')
  .refine(route => route.body !== 'stream' || !['GET', 'HEAD'].includes(route.method), 'GET/HEAD cannot accept stream bodies')
  .refine(route => route.body === 'stream' || (route.bodyLimit ?? DEFAULT_BODY_LIMIT) <= 16 * 1024 * 1024, 'JSON body limit cannot exceed 16 MiB');
const backendSchema = z.object({
  routes: z.array(routeSchema).max(256),
  publicConfig: z.record(z.unknown()).optional(),
  onReady: z.custom<NonNullable<ModuleBackend['onReady']>>(value => typeof value === 'function').optional(),
  events: z.object({
    types: z.array(z.string().min(1).max(128)).min(1).max(128),
    handle: z.custom<NonNullable<ModuleBackend['events']>['handle']>(value => typeof value === 'function'),
  }).strict().optional(),
  controlEvents: z.object({
    types: z.array(z.string().refine((type): type is ServerEvent['type'] => ServerEvent.options.some(event => event.shape.type.value === type)))
      .min(1).max(64),
    handle: z.custom<NonNullable<ModuleBackend['controlEvents']>['handle']>(value => typeof value === 'function'),
  }).strict().optional(),
  dispose: z.custom<NonNullable<ModuleBackend['dispose']>>(value => typeof value === 'function').optional(),
}).strict();

/** activation: the module did not load; runtime: a loaded module's lifecycle/background failure. */
export interface ModuleHostError { id: string; stage: 'activation' | 'runtime'; code: string; error: string }
type ReportStage = ModuleHostError['stage'] | 'request';
interface Loaded {
  installation: ModuleInstallation;
  backend: ModuleBackend;
  controller: AbortController;
  apiBase: string;
  streams: Set<Readable>;
  replies: Set<FastifyReply>;
  unsubscribe?: () => void;
  unsubscribeControl?: () => void;
}
interface RequestScope {
  controller: AbortController;
  signal: AbortSignal;
  reply: FastifyReply;
  responseFinished: boolean;
  releaseUpload?: () => void;
}
export interface ModuleBootstrap {
  modules: ModuleAsset[];
  active: Array<{ id: string; version: string; digest: string }>;
  errors: ModuleHostError[];
}

function failure(error: unknown): { status: number; code: string; error: string } {
  const value = error && typeof error === 'object' ? error as { statusCode?: unknown; code?: unknown; message?: unknown } : {};
  const status = typeof value.statusCode === 'number' && Number.isInteger(value.statusCode) && value.statusCode >= 400 && value.statusCode <= 599 ? value.statusCode : 500;
  const code = typeof value.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(value.code) ? value.code : 'MODULE_ERROR';
  return { status, code, error: code !== 'MODULE_ERROR' && typeof value.message === 'string' ? value.message : 'Module request failed' };
}
function sendFailure(reply: FastifyReply, error: unknown): void {
  if (reply.sent || reply.raw.destroyed) return;
  const result = failure(error);
  reply.code(result.status).send({ code: result.code, error: result.error });
}
const moduleError = (code: string, message: string, statusCode: number) => Object.assign(new Error(message), { code, statusCode });
const mimeTypes: Record<string, string> = {
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm',
};

export class ModuleHost {
  readonly roles: ModuleRoles;
  private readonly loaded: Loaded[] = [];
  private readonly errors = new Map<string, ModuleHostError>();
  private readonly scopes = new Set<AbortController>();
  private readonly disposed = new WeakSet<object>();
  private closed = false;
  private initialized = false;
  private app?: FastifyInstance;
  private readyNotified = false;
  constructor(private readonly options: {
    hostRoot?: string;
    observer: Pick<Engine, 'onNativeEvent'> & Partial<Pick<Engine, 'onEvent'>>;
    onInvalidate?: (id: string) => void;
    onEvent?: (id: string, payload: ModuleEventPayload) => void;
    report?: (id: string, error: unknown) => void;
    activationTimeoutMs?: number;
    host?: ModuleHostApi;
    origin?: string;
  }) {
    this.roles = new ModuleRoles(options.hostRoot ?? cockpitHome(), options.origin ?? 'http://127.0.0.1:8771',
      () => this.closed ? [] : this.loaded.map(module => module.installation));
  }

  // Request-level failures already reach their caller as HTTP errors; they are logged,
  // never stored with activation/runtime failures in /_modules.errors.
  private report(id: string, error: unknown, stage: ReportStage = 'runtime'): void {
    if (stage !== 'request') {
      const code = failure(error).code;
      this.errors.set(`${stage}:${id}`, { id, stage, code, error: error instanceof Error ? error.message.slice(0, 2000) : 'Module failed' });
    }
    try { this.options.report?.(id, error); } catch { /* Reporting never changes native or module lifecycle. */ }
  }

  bootstrap(): ModuleBootstrap {
    return {
      modules: this.loaded.flatMap(module => {
        const { manifest, digest } = module.installation;
        if (!manifest.frontend) return [];
        const asset = (path: string) => `/_modules/assets/${manifest.id}/${digest}/${path.split('/').map(encodeURIComponent).join('/')}`;
        return [{
          id: manifest.id, name: manifest.name, version: manifest.version, digest, apiBase: module.apiBase,
          entry: asset(manifest.frontend.entry), styles: (manifest.frontend.styles ?? []).map(asset),
          config: module.backend.publicConfig ?? {},
          ...(manifest.frontend.worker ? { worker: {
            entry: `/_modules/workers/${manifest.id}/worker.js`, scope: `/_modules/workers/${manifest.id}/`,
          } } : {}),
        }];
      }),
      active: this.loaded.map(({ installation: { manifest, digest } }) => ({ id: manifest.id, version: manifest.version, digest })),
      errors: [...this.errors.values()],
    };
  }

  async register(app: FastifyInstance): Promise<void> {
    if (this.initialized) throw new Error('Module host can only cold-load once');
    this.initialized = true;
    this.app = app;
    app.addHook('preClose', async () => { this.close(); });
    app.get('/_modules', async (_request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return this.bootstrap();
    });
    app.get('/_modules/assets/:id/:digest/*', async (request, reply) => this.asset(request, reply));
    app.get('/_modules/workers/:id/worker.js', async (request, reply) => this.worker(request, reply));
    const hostRoot = this.options.hostRoot ?? cockpitHome();
    let settings;
    try { settings = await readModuleSettings(hostRoot); }
    catch (error) { this.report('host', error, 'activation'); return; }
    for (const [id, selected] of Object.entries(settings.selected)) {
      if (this.closed) break;
      if (!selected.enabled) continue;
      const controller = new AbortController();
      this.scopes.add(controller);
      let backend: ModuleBackend | undefined;
      let activated: ModuleBackend | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const installation = await readModuleInstallation(id, selected, hostRoot);
        const apiBase = `/_modules/${id}/${installation.digest}/api`;
        const context: ModuleBackendContext = Object.freeze({
          host: Object.freeze({ resourcePreparationVersion: 1, call: (name, body) => {
            if (controller.signal.aborted || this.closed) throw new Error('Module is stopped');
            if (!this.loaded.some(module => module.controller === controller)) throw new Error('Module host intents are not active');
            if (!['session/new', 'session/get', 'session/rename', 'roles/readiness', 'session/resources-prepare', 'prompt'].includes(name)) throw new Error('Module host intent is not allowed');
            if (!this.options.host) throw new Error('Module host intents are unavailable');
            return this.options.host.call(name, body);
          } } satisfies ModuleHostApi),
          apiVersion: 1, serviceReadyVersion: 1, moduleId: id, apiBase, dataRoot: await moduleDataRoot(id, hostRoot),
          config: Object.freeze(structuredClone(selected.config)), signal: controller.signal,
          report: (error: unknown) => this.report(id, error),
          invalidate: () => {
            if (controller.signal.aborted || this.closed || !this.loaded.some(module => module.controller === controller)) return;
            try { this.options.onInvalidate?.(id); }
            catch (error) { this.report(id, error); }
          },
          publish: (payload: ModuleEventPayload) => {
            if (controller.signal.aborted || this.closed || !this.loaded.some(module => module.controller === controller)) return;
            try {
              if (!this.options.onEvent) throw moduleError('MODULE_EVENT_UNAVAILABLE', 'Module event transport is unavailable', 503);
              const snapshot = snapshotModuleEventPayload(payload, types.isProxy);
              this.options.onEvent(id, snapshot);
            } catch (error) {
              this.report(id, error);
              throw error;
            }
          },
        });
        const preparation = (async () => {
          const imported = await import(pathToFileURL(join(installation.root, installation.manifest.backend)).href) as { activate?: unknown };
          if (typeof imported.activate !== 'function') throw new Error('Module backend must export activate(context)');
          const value: unknown = await imported.activate(context);
          if (value && typeof value === 'object') activated = value as ModuleBackend;
          backend = backendSchema.parse(value);
          if (controller.signal.aborted) { this.dispose(id, activated!); throw controller.signal.reason; }
          if (backend.publicConfig) {
            const encoded = JSON.stringify(backend.publicConfig);
            if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error('Module public config exceeds 64 KiB');
            backend.publicConfig = JSON.parse(encoded) as Record<string, unknown>;
          }
          // Modules contribute data, not Fastify plugins. Only this disposable candidate
          // can fail during route compilation; activation runs exactly once.
          const candidate = Fastify();
          try {
            for (const route of backend.routes) candidate.route({
              method: route.method, url: `${apiBase}${route.path}`, bodyLimit: route.bodyLimit ?? DEFAULT_BODY_LIMIT,
              exposeHeadRoute: false,
              handler: async () => null,
            });
            await candidate.ready();
          } finally { await candidate.close(); }
          return backend;
        })();
        void preparation.catch(() => {
          if (controller.signal.aborted && activated) this.dispose(id, activated);
        });
        backend = await Promise.race([
          preparation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('Module activation timed out');
              controller.abort(error);
              reject(error);
            }, this.options.activationTimeoutMs ?? 10_000);
          }),
        ]);
        if (this.closed) throw new Error('Module host is closing');
        const loaded: Loaded = { installation, backend, controller, apiBase, streams: new Set(), replies: new Set() };
        if (backend.events) {
          const events = backend.events;
          const types = new Set(events.types);
          loaded.unsubscribe = this.options.observer.onNativeEvent((observation: NativeObservation) => {
            if (controller.signal.aborted || !types.has(observation.event.type)) return;
            try { void Promise.resolve(events.handle(observation)).catch(error => this.report(id, error)); }
            catch (error) { this.report(id, error); }
          }, { types: events.types });
        }
        if (backend.controlEvents) {
          if (!this.options.observer.onEvent) {
            loaded.unsubscribe?.();
            throw new Error('Module requires native control event observation');
          }
          const events = backend.controlEvents;
          const types = new Set(events.types);
          try {
            loaded.unsubscribeControl = this.options.observer.onEvent(event => {
              if (controller.signal.aborted || !types.has(event.type)) return;
              try { void Promise.resolve(events.handle(structuredClone(event))).catch(error => this.report(id, error)); }
              catch (error) { this.report(id, error); }
            });
          } catch (error) {
            loaded.unsubscribe?.();
            throw error;
          }
        }
        app.register(router => this.registerRouter(router, loaded));
        this.loaded.push(loaded);
      } catch (error) {
        controller.abort(error);
        this.scopes.delete(controller);
        if (activated) this.dispose(id, activated);
        this.report(id, error, 'activation');
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  /** The server calls this only after runtime.start() and HTTP listen succeed. */
  ready(): void {
    if (this.closed || this.readyNotified) return;
    if (!this.app?.server.listening) throw new Error('Module service readiness requires a listening HTTP server');
    this.readyNotified = true;
    for (const module of this.loaded) {
      if (this.closed) break;
      if (module.controller.signal.aborted || !module.backend.onReady) continue;
      const id = module.installation.manifest.id;
      try { void Promise.resolve(module.backend.onReady()).catch(error => this.report(id, error)); }
      catch (error) { this.report(id, error); }
    }
  }

  private async registerRouter(router: FastifyInstance, module: Loaded): Promise<void> {
    const scopes = new WeakMap<FastifyRequest, RequestScope>();
    const id = module.installation.manifest.id;
    router.addHook('onRequest', async (request, reply) => {
      if (module.controller.signal.aborted) throw moduleError('MODULE_CLOSING', 'Module is closing', 503);
      const digest = request.headers['x-cockpit-module-digest'];
      const mediaRead = request.method === 'GET' || request.method === 'HEAD';
      if ((digest !== undefined || !mediaRead) && digest !== module.installation.digest) {
        throw moduleError('MODULE_VERSION_MISMATCH', 'Module version changed or digest is missing; reload the page', 409);
      }
      const controller = new AbortController();
      const scope: RequestScope = { controller, reply, responseFinished: false, signal: AbortSignal.any([controller.signal, module.controller.signal]) };
      scopes.set(request, scope);
      module.replies.add(reply);
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      const cleanup = () => {
        controller.abort();
        module.replies.delete(reply);
        request.raw.off('aborted', abort);
        reply.raw.off('finish', finish);
        reply.raw.off('close', cleanup);
        scope.releaseUpload?.();
      };
      const finish = () => { scope.responseFinished = true; cleanup(); };
      reply.raw.once('finish', finish);
      reply.raw.once('close', cleanup);
      if ((request.routeOptions.config as { moduleBody?: string }).moduleBody === 'stream'
        && request.mediaType !== 'application/octet-stream') {
        // Reject before buffered parsers can use the much larger upload limit.
        reply.header('Connection', 'close');
        scope.releaseUpload = () => { request.raw.destroy(); };
        throw moduleError('MODULE_CONTENT_TYPE', 'Expected application/octet-stream', 415);
      }
    });
    router.addContentTypeParser('application/octet-stream', (request, payload, done) => {
      const scope = scopes.get(request)!;
      const limit = request.routeOptions.bodyLimit;
      let received = 0;
      const stream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > limit ? moduleError('MODULE_BODY_TOO_LARGE', 'Module upload exceeds body limit', 413) : null, chunk);
        },
      });
      let released = false;
      let draining = false;
      let discarded = 0;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanupSource = () => {
        if (drainTimer) clearTimeout(drainTimer);
        payload.off('data', discard);
        payload.off('error', sourceError);
        payload.off('end', cleanupSource);
        payload.off('close', sourceClosed);
        module.streams.delete(payload);
      };
      const sourceError = (error: Error) => {
        if (!released) stream.destroy(error);
        else if (!module.controller.signal.aborted) this.report(id, error, 'request');
        cleanupSource();
      };
      const sourceClosed = () => {
        if (!released && !payload.readableEnded) stream.destroy(moduleError('MODULE_UPLOAD_CLOSED', 'Module upload source closed', 400));
        cleanupSource();
      };
      const discard = (chunk: Buffer) => {
        discarded += chunk.length;
        if (discarded > Math.min(limit, DEFAULT_BODY_LIMIT)) payload.destroy();
      };
      scope.releaseUpload = () => {
        if (released) return;
        released = true;
        payload.unpipe(stream);
        stream.destroy();
        if (payload.readableEnded || payload.destroyed) { cleanupSource(); return; }
        if (!scope.responseFinished || module.controller.signal.aborted) {
          payload.destroy();
          cleanupSource();
          return;
        }
        // An early response must release upstream backpressure. Discard at most
        // 1 MiB for at most one second; otherwise close this request's connection.
        draining = true;
        drainTimer = setTimeout(() => { payload.destroy(); cleanupSource(); }, 1000);
        drainTimer.unref();
        payload.on('data', discard);
        payload.resume();
      };
      module.streams.add(payload);
      payload.once('error', sourceError);
      payload.once('end', cleanupSource);
      payload.once('close', sourceClosed);
      this.trackStream(module, stream);
      stream.once('error', error => {
        if (draining) return;
        scope.controller.abort(error);
        sendFailure(scope.reply, error);
      });
      if (scope.signal.aborted) {
        payload.destroy();
        scope.releaseUpload();
        done(moduleError('MODULE_UPLOAD_CLOSED', 'Module upload request is closed', 400));
        return;
      }
      if ((request.routeOptions.config as { moduleBody?: string }).moduleBody !== 'stream') {
        done(moduleError('MODULE_CONTENT_TYPE', 'This route accepts JSON, not an upload stream', 415));
        return;
      }
      const declaredLength = request.headers['content-length'];
      if (declaredLength && Number(declaredLength) > limit) {
        done(moduleError('MODULE_BODY_TOO_LARGE', 'Module upload exceeds body limit', 413));
        return;
      }
      payload.pipe(stream);
      done(null, stream);
    });
    router.setErrorHandler((error, _request, reply) => {
      this.report(id, error, 'request');
      sendFailure(reply, error);
    });
    for (const route of module.backend.routes) {
      router.route({
        method: route.method, url: `${module.apiBase}${route.path}`, bodyLimit: route.bodyLimit ?? DEFAULT_BODY_LIMIT,
        exposeHeadRoute: false,
        config: { moduleBody: route.body ?? 'json' },
        handler: async (request, reply) => {
          const scope = scopes.get(request)!;
          let responseStream: Readable | undefined;
          let sentStream = false;
          let releaseStream: (() => void) | undefined;
          try {
            if (route.body === 'stream' && !(request.body instanceof Readable)) throw moduleError('MODULE_CONTENT_TYPE', 'Expected application/octet-stream', 415);
            const result = await route.handler({
              params: request.params as Record<string, string>, query: request.query as Record<string, unknown>,
              headers: request.headers, body: request.body, signal: scope.signal,
            });
            const body = result && typeof result === 'object' ? result.body : undefined;
            if (body instanceof Readable) {
              responseStream = body;
              this.trackStream(module, body);
              const destroy = () => body.destroy();
              releaseStream = () => {
                scope.signal.removeEventListener('abort', destroy);
                reply.raw.off('close', destroy);
                body.off('close', releaseStream!);
                body.off('end', releaseStream!);
              };
              scope.signal.addEventListener('abort', destroy, { once: true });
              reply.raw.once('close', destroy);
              body.once('close', releaseStream);
              body.once('end', releaseStream);
            }
            if (scope.signal.aborted || reply.sent || reply.raw.destroyed) return reply;
            if (!result || typeof result !== 'object') throw new Error('Module handler returned an invalid response');
            if (result.status !== undefined) {
              if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw new Error('Module handler returned an invalid status');
              reply.code(result.status);
            }
            if (result.headers !== undefined) {
              if (!result.headers || typeof result.headers !== 'object' || Array.isArray(result.headers)) throw new Error('Module handler returned invalid headers');
              for (const [name, value] of Object.entries(result.headers)) {
                if (typeof value !== 'string') throw new Error('Module handler returned an invalid header value');
                validateHeaderName(name);
                validateHeaderValue(name, value);
              }
              reply.headers(result.headers);
            }
            reply.header('X-Cockpit-Module-Digest', module.installation.digest);
            if (responseStream && request.method === 'HEAD') return reply.send();
            reply.send(body ?? null);
            sentStream = !!responseStream;
            return reply;
          } catch (error) {
            this.report(id, error, 'request');
            sendFailure(reply, error);
            return reply;
          } finally {
            if (responseStream && !sentStream) {
              releaseStream?.();
              responseStream.destroy();
              module.streams.delete(responseStream);
            }
          }
        },
      });
    }
  }

  private trackStream(module: Loaded, stream: Readable): void {
    if (module.streams.has(stream)) return;
    stream.on('error', error => { if (!module.controller.signal.aborted) this.report(module.installation.manifest.id, error, 'request'); });
    if (stream.destroyed || module.controller.signal.aborted) { stream.destroy(); return; }
    module.streams.add(stream);
    stream.once('close', () => module.streams.delete(stream));
    stream.once('end', () => module.streams.delete(stream));
  }

  private async asset(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const { id, digest, '*': relative } = request.params as Record<string, string>;
    const module = this.loaded.find(value => value.installation.manifest.id === id && value.installation.digest === digest);
    if (!module || !relative || module.controller.signal.aborted) return reply.code(404).send({ code: 'MODULE_ASSET_NOT_FOUND', error: 'Module asset not found' });
    let file;
    try {
      safeModulePath(relative);
      if (!isDeclaredAsset(module.installation.manifest, relative) || !Object.hasOwn(module.installation.files, relative)) throw new Error('Undeclared asset');
      const path = join(module.installation.root, relative);
      if (await realpath(path) !== path) throw new Error('Asset symlinks are forbidden');
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== module.installation.files[relative]!.bytes) throw new Error('Invalid asset');
      reply.header('Content-Type', mimeTypes[relative.split('.').at(-1)!] ?? 'application/octet-stream');
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      reply.header('X-Content-Type-Options', 'nosniff');
      if (request.method === 'HEAD') { await file.close(); return reply.send(); }
      const stream = file.createReadStream();
      this.trackStream(module, stream);
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    } catch {
      await file?.close();
      return reply.code(404).send({ code: 'MODULE_ASSET_NOT_FOUND', error: 'Module asset not found' });
    }
  }

  private async worker(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const { id } = request.params as { id: string };
    const module = this.loaded.find(value => value.installation.manifest.id === id && !value.controller.signal.aborted);
    const relative = module?.installation.manifest.frontend?.worker;
    reply.header('Cache-Control', 'no-store');
    if (!module || !relative) return reply.code(404).send({ code: 'MODULE_WORKER_NOT_FOUND', error: 'Module worker unavailable' });
    const path = join(module.installation.root, relative);
    if (await realpath(path) !== path) throw new Error('Module worker symlinks are forbidden');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      const expected = module.installation.files[relative];
      if (!expected || !stat.isFile() || stat.size !== expected.bytes || stat.size > MODULE_WORKER_LIMIT || stat.nlink !== 1) {
        throw new Error('Invalid module worker artifact');
      }
      bytes = await file.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Module worker digest mismatch');
    } finally { await file.close(); }
    if (module.controller.signal.aborted) return reply.code(503).send({ error: 'Module is closing' });
    const config = { moduleId: id, digest: module.installation.digest,
      apiBase: `../../${id}/${module.installation.digest}/api` };
    reply.header('Content-Type', 'text/javascript; charset=utf-8');
    reply.header('X-Content-Type-Options', 'nosniff');
    // The script's own directory is the maximum scope; it cannot control Chat.
    reply.header('Service-Worker-Allowed', './');
    return reply.send(Buffer.concat([Buffer.from(`self.__cockpitModuleWorker=${JSON.stringify(config)};\n`), bytes]));
  }

  private dispose(id: string, backend: ModuleBackend): void {
    if (this.disposed.has(backend)) return;
    this.disposed.add(backend);
    try {
      if (typeof backend.dispose === 'function') void Promise.resolve(backend.dispose()).catch(error => this.report(id, error));
    }
    catch (error) { this.report(id, error); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const scope of this.scopes) scope.abort();
    this.scopes.clear();
    for (const module of this.loaded) {
      try { module.unsubscribe?.(); } catch (error) { this.report(module.installation.manifest.id, error); }
      try { module.unsubscribeControl?.(); } catch (error) { this.report(module.installation.manifest.id, error); }
      for (const stream of module.streams) stream.destroy();
      module.streams.clear();
      for (const reply of module.replies) reply.raw.destroy();
      this.dispose(module.installation.manifest.id, module.backend);
    }
  }
}
