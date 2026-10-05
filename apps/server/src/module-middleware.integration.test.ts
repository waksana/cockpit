import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Fastify from 'fastify';
import { event, finishReply, harness } from '../../../packages/core/test-support/engine-harness.ts';
import { ModuleHost } from './module-host.ts';
import { installLocalModule } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';
import { GracefulShutdown } from './shutdown.ts';

process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
const { app, setTestDependencies, callModuleIntent } = await import('./index.ts');
after(() => app.close());

async function setup(t: TestContext, backend: string, observerBackend?: string) {
  const f = await moduleFixture(t);
  const h = harness(t);
  const installed = await installLocalModule(await f.package(moduleEntries('wrapper', backend)),
    { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  let observerProbe;
  if (observerBackend) {
    const observer = await installLocalModule(await f.package(moduleEntries('observer', observerBackend)),
      { trustLocalCode: true, enable: true });
    observerProbe = await import(pathToFileURL(join(observer.root, 'backend.mjs')).href);
  }
  const moduleApp = Fastify();
  const host = new ModuleHost({ hostRoot: f.hostRoot, observer: h.engine, host: { call: callModuleIntent } });
  await host.register(moduleApp);
  const closed = Promise.withResolvers<void>();
  const shutdownErrors: unknown[] = [];
  const shutdown = new GracefulShutdown({
    busyCount: () => h.engine.busyCount(), prepareStop: () => host.stop(),
    stopNative: beforeClose => h.engine.stop(beforeClose),
    closeTransport: () => host.close(), exit: () => { closed.resolve(); },
    report: error => { shutdownErrors.push(error); }, delayMs: 0,
  });
  setTestDependencies({ engine: h.engine, moduleHost: host, shutdown });
  t.after(h.engine.onFatal(error => shutdown.runtimeFailed(error)));
  t.after(() => shutdown.dispose());
  t.after(() => moduleApp.close());
  return { h, host, probe, observerProbe, moduleApp, shutdown, closed: closed.promise, shutdownErrors };
}

for (const kind of ['native', 'control', 'accepted']) {
  const declaration = kind === 'native' ? "events: { types: ['user.message'], handle: observe }"
    : kind === 'control' ? "controlEvents: { types: ['session/patch'], handle: observe }"
      : 'promptAccepted: observe';
  for (const deferred of [false, true]) {
    test(`${kind} observers send independent ${deferred ? 'microtask' : 'synchronous'} prompts through middleware`, async t => {
      const { h, host, probe, observerProbe } = await setup(t, `
        export const calls = [];
        export const recursion = [];
        export function activate(ctx) { return { routes: [], onStop() {}, middleware: {
          async prompt(invocation, next) {
            calls.push({ text: invocation.body.text, origin: invocation.origin, id: invocation.invocationId });
            const rejectRecursion = async () => {
              try { await ctx.host.call('prompt', invocation.body); recursion.push('allowed'); }
              catch (error) { recursion.push(error.code); }
            };
            await rejectRecursion();
            await next({ text: invocation.body.text + ' wrapped' });
            await rejectRecursion();
          }
        } }; }
      `, `
        export const completed = Promise.withResolvers();
        export const seen = [];
        let source, target, sent = false;
        export function configure(from, to) { source = from; target = to; }
        export function activate(ctx) {
          function observe(event) {
            if (event.sessionId !== source || sent) return;
            sent = true;
            seen.push(event);
            const send = () => ctx.host.call('prompt', { sessionId: target, text: 'notice', mode: 'enqueue' });
            try {
              const pending = ${deferred ? 'Promise.resolve().then(send)' : 'send()'};
              void pending.then(result => completed.resolve({ result }), error => completed.resolve({ error }));
            } catch (error) { completed.resolve({ error }); }
          }
          return { routes: [], onStop() {}, ${declaration} };
        }
      `);
      assert.equal(host.bootstrap().active.length, 2);
      const source = await h.load('source');
      const target = await h.load('target');
      observerProbe!.configure(source.id, target.id);
      const accepted: Array<{ sessionId: string; origin: string }> = [];
      h.engine.onPromptAccepted(value => { accepted.push(value); });
      source.sdk.send.mock.mockImplementation(async () => {
        source.emit(event('user.message', { content: 'original wrapped', messageId: 'source-receipt' }));
        return 'source-receipt';
      });
      const response = await app.inject({ method: 'POST', url: '/intent/prompt',
        payload: { sessionId: source.id, text: 'original' } });
      assert.equal(response.statusCode, 200);
      const observed = await observerProbe!.completed.promise;
      assert.equal(observed.error, undefined);
      assert.equal(observed.result.ok, true);
      assert.equal(observerProbe!.seen.length, 1);
      assert.deepEqual(probe.calls.map((call: { text: string; origin: string }) => [call.text, call.origin]),
        [['original', 'api'], ['notice', 'module']]);
      assert.equal(new Set(probe.calls.map((call: { id: string }) => call.id)).size, 2);
      assert.deepEqual(probe.recursion, Array(4).fill('MODULE_MIDDLEWARE_INVALID'));
      assert.equal(source.sdk.send.mock.callCount(), 1);
      assert.equal(target.sdk.send.mock.callCount(), 1);
      assert.equal(target.sdk.send.mock.calls[0]!.arguments[0]!.prompt, 'notice wrapped');
      assert.equal(accepted.find(value => value.sessionId === target.id)?.origin, 'module');
      assert.deepEqual(host.bootstrap().errors, []);
    });
  }

  test(`${kind} observer callbacks remain synchronous and joined by shutdown drain`, async t => {
    const { h, host, observerProbe } = await setup(t, `
      export function activate() { return { routes: [], onStop() {}, middleware: {
        async prompt(_invocation, next) { await next(); }
      } }; }
    `, `
      export const release = Promise.withResolvers();
      export const state = { observed: 0, settled: false, stopped: false, disposed: false };
      let source;
      export function configure(id) { source = id; }
      export function activate(ctx) {
        async function observe(event) {
          if (event.sessionId !== source) return;
          state.observed++;
          await release.promise;
          await ctx.host.call('session/get', { sessionId: source });
          try { await ctx.host.call('prompt', { sessionId: source, text: 'too late' }); }
          catch (error) { state.rejected = error.message; }
          state.settled = true;
        }
        return { routes: [], ${declaration}, onStop() { state.stopped = true; },
          dispose() { state.disposed = true; } };
      }
    `);
    t.after(() => observerProbe!.release.resolve());
    const source = await h.load();
    observerProbe!.configure(source.id);
    source.sdk.send.mock.mockImplementation(async () => {
      source.emit(event('user.message', { content: 'synthetic', messageId: 'receipt' }));
      if (kind === 'native') assert.equal(observerProbe!.state.observed, 1);
      return 'receipt';
    });
    const response = await app.inject({ method: 'POST', url: '/intent/prompt',
      payload: { sessionId: source.id, text: 'synthetic' } });
    assert.equal(response.statusCode, 200, 'emitter does not wait for the observer');
    assert.ok(observerProbe!.state.observed > 0);
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await nextTurn();
    assert.equal(observerProbe!.state.stopped, true);
    assert.equal(observerProbe!.state.disposed, false);
    assert.equal(closed, false);
    const observed = observerProbe!.state.observed;
    source.emit(event('user.message', { content: 'after stop' }));
    assert.equal(observerProbe!.state.observed, observed);
    observerProbe!.release.resolve();
    await closing;
    assert.equal(observerProbe!.state.settled, true);
    assert.equal(observerProbe!.state.disposed, true);
    assert.match(observerProbe!.state.rejected, /stopping/);
    assert.equal(source.sdk.send.mock.callCount(), 1);
    assert.deepEqual(host.bootstrap().errors, []);
  });
}

test('Web, API/MCP transport and module calls enter exactly once with true native receipts and origins', async t => {
  const { h, host, probe } = await setup(t, `
    export const calls = [];
    export let context;
    export function activate(ctx) {
      if (ctx.host.interfaceMiddlewareVersion !== 1) throw new Error('missing capability');
      context = ctx;
      return { routes: [], onStop() {}, middleware: { async prompt(invocation, next) {
        calls.push({ origin: invocation.origin, id: invocation.invocationId });
        await next({ text: invocation.body.text + ' wrapped', attachments: invocation.body.attachments?.map(
          attachment => attachment.type === 'file' ? { ...attachment, path: '/managed/synthetic' } : attachment) });
      } } };
    }
  `);
  assert.equal(host.bootstrap().active.length, 1);
  const s = await h.load();
  const accepted: Array<{ messageId: string; origin: string }> = [];
  h.engine.onPromptAccepted(event => { accepted.push(event); });
  const attachments = [
    { type: 'file', path: '/local/synthetic' }, { type: 'directory', path: '/directory' },
    { type: 'selection', filePath: '/selection', displayName: 'selected', text: 'text' },
    { type: 'blob', mimeType: 'text/plain', data: 'YQ==' },
  ];
  for (const origin of ['user', 'api', 'module']) {
    const payload = { sessionId: s.id, text: 'Synthetic', mode: 'enqueue', attachments };
    const response = origin === 'module'
      ? await probe.context.host.call('prompt', payload)
      : (await app.inject({ method: 'POST', url: '/intent/prompt', payload,
        headers: origin === 'user' ? { host: 'synthetic.test', origin: 'https://synthetic.test', 'sec-fetch-site': 'same-origin' } : {},
      })).json();
    assert.equal(response.messageId, accepted.at(-1)!.messageId);
    assert.equal(accepted.at(-1)!.origin, origin);
  }
  assert.deepEqual(probe.calls.map((call: { origin: string }) => call.origin), ['user', 'api', 'module']);
  assert.equal(new Set(probe.calls.map((call: { id: string }) => call.id)).size, 3);
  assert.equal(s.sdk.send.mock.callCount(), 3);
  for (const call of s.sdk.send.mock.calls) {
    assert.deepEqual(call.arguments[0], { prompt: 'Synthetic wrapped', mode: 'enqueue',
      attachments: [{ type: 'file', path: '/managed/synthetic' }, ...attachments.slice(1)] });
  }
  const rejected = await app.inject({ method: 'POST', url: '/intent/prompt',
    headers: { origin: 'https://evil.invalid', host: 'synthetic.test' }, payload: { sessionId: s.id, text: 'CSRF' } });
  assert.equal(rejected.statusCode, 403);
  assert.equal(probe.calls.length, 3);
});

test('Stop cancels only pending preparation; no delayed native send after Stop settles', async t => {
  const { h, probe } = await setup(t, `
    export const entered = Promise.withResolvers();
    export const release = Promise.withResolvers();
    export function activate() { return { routes: [], onStop() {}, middleware: {
      async prompt(_invocation, next) { entered.resolve(); await release.promise; await next(); }
    } }; }
  `);
  const s = await h.load();
  const sending = app.inject({ method: 'POST', url: '/intent/prompt', payload: { sessionId: s.id, text: 'delayed' } });
  void sending.then(() => {});
  await probe.entered.promise;
  const stopped = await app.inject({ method: 'POST', url: '/intent/cancel', payload: { sessionId: s.id } });
  assert.equal(stopped.statusCode, 200);
  probe.release.resolve();
  assert.equal((await sending).statusCode, 499);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('native admission is rechecked after enhancement, not inferred from pre-middleware state', async t => {
  const { h, probe } = await setup(t, `
    export const entered = Promise.withResolvers();
    export const release = Promise.withResolvers();
    export function activate() { return { routes: [], onStop() {}, middleware: {
      async prompt(_invocation, next) { entered.resolve(); await release.promise; await next(); }
    } }; }
  `);
  const s = await h.load();
  const sending = app.inject({ method: 'POST', url: '/intent/prompt', payload: { sessionId: s.id, text: 'delayed' } });
  void sending.then(() => {});
  await probe.entered.promise;
  await h.engine.deleteSession(s.id);
  probe.release.resolve();
  assert.equal((await sending).statusCode, 404);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

test('shutdown waits for wrapper persistence and native completion before module drain', { timeout: 10_000 }, async t => {
  const { h, probe, shutdown, closed, shutdownErrors } = await setup(t, `
    export const accepted = Promise.withResolvers();
    export const persisted = Promise.withResolvers();
    export let stopped = false;
    export let disposed = false;
    export function activate(ctx) { return { routes: [], async onStop() {
      stopped = true;
      await ctx.host.call('session/directory', { limit: 1 });
    },
      dispose() { disposed = true; }, middleware: {
        async 'session/get'(_invocation, next) { await next(); },
        async prompt(invocation, next) {
          const result = await next();
          accepted.resolve(result);
          await persisted.promise;
          await ctx.host.call('session/get', { sessionId: invocation.body.sessionId });
        }
      }
    }; }
  `);
  const s = await h.load();
  const sending = app.inject({ method: 'POST', url: '/intent/prompt', payload: { sessionId: s.id, text: 'synthetic' } });
  void sending.then(() => {});
  const receipt = await probe.accepted.promise;
  const stopping = await app.inject({ method: 'POST', url: '/intent/system/shutdown', payload: { confirm: true } });
  assert.equal(stopping.statusCode, 200);
  assert.equal(probe.stopped, false);
  s.emit(event('user.message', { content: 'synthetic', messageId: receipt.messageId }));
  await finishReply(s, 'Synthetic late reply');
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal(shutdown.snapshot().phase, 'waiting');
  assert.equal(probe.stopped, false);
  assert.equal(probe.disposed, false);
  probe.persisted.resolve();
  assert.deepEqual((await sending).json(), receipt);
  await closed;
  assert.equal(probe.stopped, true);
  assert.equal(probe.disposed, true);
  assert.deepEqual(shutdownErrors, []);
  assert.equal(s.sdk.send.mock.callCount(), 1);
});

test('confirmed native death during successful module drain still closes Host once', { timeout: 10_000 }, async t => {
  const { h, probe, shutdown, closed, shutdownErrors } = await setup(t, `
    export const draining = Promise.withResolvers();
    export const finish = Promise.withResolvers();
    export let disposed = false;
    export function activate() { return { routes: [], async onStop() {
      draining.resolve(); await finish.promise;
    }, dispose() { disposed = true; } }; }
  `);
  await h.load();
  shutdown.request();
  await probe.draining.promise;
  const fatal = new Error('Owned native child exited');
  h.runtime.emitFatal(fatal);
  probe.finish.resolve();
  await closed;
  assert.equal(shutdown.snapshot().phase, 'closed');
  assert.equal(probe.disposed, true);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.stop.mock.callCount(), 1);
  assert.deepEqual(shutdownErrors, [fatal]);
});

test('registration requires public names and opted-in drain; a failed module does not stop Host', async t => {
  const f = await moduleFixture(t);
  for (const [id, declaration] of [
    ['private', "{ routes: [], onStop() {}, middleware: { 'system/shutdown': async () => {} } }"],
    ['legacy', '{ routes: [], middleware: { prompt: async (_input, next) => { await next(); } } }'],
    ['good', '{ routes: [], onStop() {}, middleware: { prompt: async (_input, next) => { await next(); } } }'],
  ]) {
    await installLocalModule(await f.package(moduleEntries(id, `export function activate() { return ${declaration}; }`)),
      { trustLocalCode: true, enable: true });
  }
  const moduleApp = Fastify();
  const host = new ModuleHost({ observer: f.observer, hostRoot: f.hostRoot });
  t.after(() => moduleApp.close());
  await host.register(moduleApp);
  assert.deepEqual(host.bootstrap().active.map(module => module.id), ['good']);
  assert.deepEqual(host.bootstrap().errors.map(error => error.id).sort(), ['legacy', 'private']);
});
