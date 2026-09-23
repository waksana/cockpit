import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { ServerEvent } from '@cockpit/protocol';
import { installLocalModule, selectModule } from './module-install.ts';
import { ModuleHost } from './module-host.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

test('onReady waits for listening, not activation, injection or agent up; invokes once with usable HTTP and host bridge', {
  timeout: 5000,
}, async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('ready', `
    export const state = { calls: 0, up: 0 };
    export const finished = Promise.withResolvers();
    let origin;
    export function setOrigin(value) { origin = value; }
    export function activate(ctx) {
      if (ctx.serviceReadyVersion !== 1) {
        throw Object.assign(new Error('Host service-ready callback is unsupported'), { code: 'MODULE_SERVICE_READY_UNSUPPORTED' });
      }
      state.serviceReadyVersion = ctx.serviceReadyVersion;
      state.frozen = Object.isFrozen(ctx);
      return {
        routes: [
          { method: 'GET', path: '/probe', handler: () => ({ body: { ready: true } }) },
          { method: 'POST', path: '/mcp', handler: req => ({ body: { jsonrpc: '2.0', id: req.body.id, result: {} } }) },
        ],
        controlEvents: { types: ['agent/status'], handle() { state.up++; } },
        async onReady() {
          state.calls++;
          try {
            const response = await fetch(origin + ctx.apiBase + '/probe', { signal: ctx.signal });
            state.http = await response.json();
            state.result = await ctx.host.call('session/new', { cwd: ctx.dataRoot });
            finished.resolve();
          } catch (error) { finished.reject(error); throw error; }
        },
      };
    }
  `)), { trustLocalCode: true, enable: true });
  const backend = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  assert.throws(() => backend.activate({ apiVersion: 1 }), { code: 'MODULE_SERVICE_READY_UNSUPPORTED' },
    'a consumer can explicitly reject older API v1 hosts before starting any work');
  assert.equal(backend.state.calls, 0);
  assert.equal(backend.state.serviceReadyVersion, undefined, 'capability rejection precedes activation side effects');
  const app = Fastify();
  t.after(() => app.close());
  const listeners = new Set<(event: ServerEvent) => void>();
  let runtimeStarted = false;
  const host = new ModuleHost({
    observer: { ...f.observer, onEvent(handler) {
      listeners.add(handler); return () => { listeners.delete(handler); };
    } },
    host: { call: async (name, body) => {
      assert.ok(runtimeStarted && app.server.listening);
      assert.equal(name, 'session/new');
      assert.deepEqual(body, { cwd: join(f.hostRoot, 'modules/data/ready') });
      const response = await fetch(`${origin}/_modules/ready/${installed.digest}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cockpit-Module-Digest': installed.digest },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(response.status, 200, 'a host-call adapter can connect the same module HTTP MCP during onReady');
      assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: {} });
      return { sessionId: 'synthetic' } as never;
    } },
  });
  await host.register(app);
  assert.equal(backend.state.serviceReadyVersion, 1);
  assert.equal(backend.state.frozen, true);
  assert.equal(backend.state.calls, 0);
  await app.ready();
  await app.inject('/_modules');
  assert.throws(() => host.ready(), /requires a listening HTTP server/);
  runtimeStarted = true;
  for (const listener of listeners) listener({ type: 'agent/status', status: 'up' });
  assert.equal(backend.state.up, 1);
  assert.equal(backend.state.calls, 0, 'agent up is not service readiness');
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  backend.setOrigin(origin);
  host.ready();
  host.ready();
  await backend.finished.promise;
  assert.equal(backend.state.calls, 1);
  assert.deepEqual(backend.state.http, { ready: true });
  assert.deepEqual(backend.state.result, { sessionId: 'synthetic' });
  assert.deepEqual(host.bootstrap().errors, []);
});

test('ready throws and rejections are reported locally, without retries or unloading healthy routes', async t => {
  const f = await moduleFixture(t);
  const installed = [];
  for (const [id, hook] of [
    ['a-sync', 'onReady() { calls++; throw new Error("sync ready failed"); }'],
    ['b-async', 'async onReady() { calls++; throw new Error("async ready failed"); }'],
    ['c-good', 'onReady() { calls++; }'],
    ['d-invalid', 'onReady: true'],
    ['e-legacy', ''],
  ]) installed.push(await installLocalModule(await f.package(moduleEntries(id, `
    export let calls = 0;
    export function activate() { return {
      routes: [{ method: 'GET', path: '/probe', handler: () => ({ body: 'healthy' }) }],
      ${hook}
    }; }
  `)), { trustLocalCode: true, enable: true }));
  const app = Fastify();
  t.after(() => app.close());
  const reports: string[] = [];
  const host = new ModuleHost({ observer: f.observer, report: id => { reports.push(id); } });
  await host.register(app);
  assert.deepEqual(reports, ['d-invalid']);
  await app.listen({ host: '127.0.0.1', port: 0 });
  host.ready();
  await nextTurn();
  host.ready();
  assert.deepEqual(reports, ['d-invalid', 'a-sync', 'b-async']);
  assert.deepEqual(host.bootstrap().active.map(module => module.id), ['a-sync', 'b-async', 'c-good', 'e-legacy']);
  for (const module of installed) {
    const backend = await import(pathToFileURL(join(module.root, 'backend.mjs')).href);
    assert.equal(backend.calls, ['d-invalid', 'e-legacy'].includes(module.manifest.id) ? 0 : 1);
  }
  const bootstrap = (await app.inject('/_modules')).json();
  assert.deepEqual(bootstrap.errors.map((error: { id: string; stage: string; error: string }) => [error.id, error.stage]),
    [['d-invalid', 'activation'], ['a-sync', 'runtime'], ['b-async', 'runtime']]);
  assert.deepEqual(bootstrap.errors.slice(1).map((error: { error: string }) => error.error), ['sync ready failed', 'async ready failed']);
  assert.equal((await app.inject(`/_modules/a-sync/${installed[0]!.digest}/api/probe`)).body, 'healthy');
});

test('close before or during readiness skips callbacks and cancels pending work without waiting', {
  timeout: 5000,
}, async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('ready', `
    export let context;
    export let calls = 0;
    export const gate = Promise.withResolvers();
    export let stopped = false;
    export function activate(ctx) {
      context = ctx;
      return { routes: [], async onReady() {
        calls++;
        await gate.promise;
        if (ctx.signal.aborted) {
          try { await ctx.host.call('session/get', { sessionId: 'synthetic' }); }
          catch (error) { stopped = error.message === 'Module is stopped'; }
        }
        throw new Error('late ready rejection');
      } };
    }
  `)), { trustLocalCode: true, enable: true });
  const backend = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const closedApp = Fastify();
  const closedHost = new ModuleHost({ observer: f.observer });
  await closedHost.register(closedApp);
  await closedApp.close();
  closedHost.ready();
  assert.equal(backend.calls, 0);
  assert.ok(backend.context.signal.aborted);

  const app = Fastify();
  t.after(() => app.close());
  const reported = Promise.withResolvers<unknown>();
  const host = new ModuleHost({ observer: f.observer, report: (_id, error) => { reported.resolve(error); } });
  await host.register(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(host.ready(), undefined, 'callback promises do not block startup');
  assert.equal(backend.calls, 1);
  await app.close();
  assert.ok(backend.context.signal.aborted, 'close completes while onReady is still pending');
  host.ready();
  backend.gate.resolve();
  assert.match(String(await reported.promise), /late ready rejection/);
  assert.ok(backend.stopped, 'retained callback context cannot dispatch after close');
  assert.equal(backend.calls, 1);
});

test('a callback that closes the host cannot start later modules', async t => {
  const f = await moduleFixture(t);
  const modules = [];
  for (const id of ['a-first', 'b-later']) {
    modules.push(await installLocalModule(await f.package(moduleEntries(id, `
      export let calls = 0;
      export let close;
      export function setClose(value) { close = value; }
      export function activate() { return { routes: [], onReady() { calls++; close?.(); } }; }
    `)), { trustLocalCode: true, enable: true }));
  }
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const first = await import(pathToFileURL(join(modules[0]!.root, 'backend.mjs')).href);
  const later = await import(pathToFileURL(join(modules[1]!.root, 'backend.mjs')).href);
  first.setClose(() => host.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  host.ready();
  assert.equal(first.calls, 1);
  assert.equal(later.calls, 0);
});

test('install and selection do not replay readiness; the next cold activation gets its own callback', async t => {
  const f = await moduleFixture(t);
  const events: string[] = [];
  const options = { observer: f.observer, onInvalidate: (id: string) => { events.push(id); } };
  const source = `export function activate(ctx) { return { routes: [], onReady() { ctx.invalidate(); } }; }`;
  await installLocalModule(await f.package(moduleEntries('initial', source)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost(options);
  await host.register(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  host.ready();
  await installLocalModule(await f.package(moduleEntries('next', source)), { trustLocalCode: true, enable: true });
  await selectModule('initial', { enabled: false });
  await selectModule('initial', { enabled: true });
  host.ready();
  assert.deepEqual(events, ['initial']);
  assert.deepEqual(host.bootstrap().active.map(module => module.id), ['initial']);
  await app.close();

  const nextApp = Fastify();
  t.after(() => nextApp.close());
  const nextHost = new ModuleHost(options);
  await nextHost.register(nextApp);
  await nextApp.listen({ host: '127.0.0.1', port: 0 });
  nextHost.ready();
  assert.deepEqual(events, ['initial', 'initial', 'next']);
});
