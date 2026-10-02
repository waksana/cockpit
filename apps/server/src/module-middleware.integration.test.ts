import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Fastify from 'fastify';
import { harness } from '../../../packages/core/test-support/engine-harness.ts';
import { ModuleHost } from './module-host.ts';
import { installLocalModule } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';
import { GracefulShutdown } from './shutdown.ts';

process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
const { app, setTestDependencies, callModuleIntent } = await import('./index.ts');
after(() => app.close());

async function setup(t: TestContext, backend: string) {
  const f = await moduleFixture(t);
  const h = harness(t);
  const installed = await installLocalModule(await f.package(moduleEntries('wrapper', backend)),
    { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const moduleApp = Fastify();
  const host = new ModuleHost({ hostRoot: f.hostRoot, observer: h.engine, host: { call: callModuleIntent } });
  await host.register(moduleApp);
  const shutdown = new GracefulShutdown({
    busyCount: () => h.engine.busyCount(), prepareStop: () => host.stop(),
    stopNative: async () => { throw new Error('Fixture must not tear down native'); },
    closeTransport: async () => {}, exit: () => { throw new Error('Fixture must not exit'); },
    report: () => {},
  });
  setTestDependencies({ engine: h.engine, moduleHost: host, shutdown });
  t.after(() => shutdown.dispose());
  t.after(() => moduleApp.close());
  return { h, host, probe, moduleApp };
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

test('shutdown joins wrapper persistence after send and allows unwrapped settlement reads', async t => {
  const { h, host, probe } = await setup(t, `
    export const accepted = Promise.withResolvers();
    export const persisted = Promise.withResolvers();
    export let stopped = false;
    export let disposed = false;
    export function activate(ctx) { return { routes: [], onStop() { stopped = true; },
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
  assert.equal(probe.stopped, true);
  let drained = false;
  const drain = host.stop().then(() => { drained = true; });
  await nextTurn();
  assert.equal(drained, false);
  assert.equal(probe.disposed, false);
  probe.persisted.resolve();
  assert.deepEqual((await sending).json(), receipt);
  await drain;
  assert.equal(s.sdk.send.mock.callCount(), 1);
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
