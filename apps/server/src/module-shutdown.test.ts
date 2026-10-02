import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { installLocalModule } from './module-install.ts';
import { ModuleHost } from './module-host.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

test('close stops ingress then joins started sends and persistence with host resources still usable', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('drain', `
    import { writeFile } from 'node:fs/promises';
    export const entered = Promise.withResolvers();
    export const sent = Promise.withResolvers();
    export const persisted = Promise.withResolvers();
    export const state = { steps: [] };
    export let context;
    export function activate(ctx) {
      if (ctx.shutdownVersion !== 1) throw new Error('Missing safe shutdown');
      context = ctx;
      ctx.stopping.addEventListener('abort', () => state.steps.push('stop-intake'));
      return {
        routes: [{ method: 'POST', path: '/send', async handler(req) {
          state.steps.push('send-start');
          entered.resolve();
          await sent.promise;
          if (ctx.signal.aborted || req.signal.aborted) throw new Error('Premature revocation');
          await ctx.host.call('session/get', { sessionId: 'synthetic' });
          state.steps.push('send-settled');
          await persisted.promise;
          await writeFile(ctx.dataRoot + '/receipt', 'durable');
          state.steps.push('persisted');
          return { body: 'accepted' };
        } }],
        onStop() { state.steps.push('drain'); },
        dispose() { state.steps.push('dispose'); },
      };
    }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  const hostCalls: string[] = [];
  const host = new ModuleHost({ observer: f.observer, host: { call: async name => {
    hostCalls.push(name); return { meta: null } as never;
  } } });
  t.after(() => app.close());
  await host.register(app);
  const base = host.bootstrap().modules[0]!.apiBase;
  const sending = app.inject({ method: 'POST', url: `${base}/send`, headers: { 'x-cockpit-module-digest': installed.digest } });
  void sending.then(() => {});
  await probe.entered.promise;
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  assert.strictEqual(host.close(), host.close(), 'close has one shared completion');
  assert.ok(probe.context.stopping.aborted);
  await nextTurn();
  assert.deepEqual(probe.state.steps, ['send-start', 'stop-intake', 'drain']);
  assert.equal(closed, false);
  assert.equal(probe.context.signal.aborted, false);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/send` })).statusCode, 503);
  await assert.rejects(async () => probe.context.host.call('prompt', { sessionId: 'synthetic', text: 'new work' }), /stopping/);
  probe.sent.resolve();
  await nextTurn();
  assert.equal(closed, false, 'a settled network send is not yet a durable receipt');
  probe.persisted.resolve();
  await closing;
  await sending;
  assert.deepEqual(hostCalls, ['session/get']);
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/drain/receipt'), 'utf8'), 'durable');
  assert.deepEqual(probe.state.steps, ['send-start', 'stop-intake', 'drain', 'send-settled', 'persisted', 'dispose']);
  assert.ok(probe.context.signal.aborted);
  await assert.rejects(async () => probe.context.host.call('session/get', { sessionId: 'synthetic' }), /stopped/);
});

test('opt-in readiness and event callbacks are joined while legacy readiness stays best-effort', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('ready-drain', `
    export const ready = Promise.withResolvers();
    export const event = Promise.withResolvers();
    export const state = { ready: 0, events: 0, stops: 0, disposed: 0 };
    export function activate() { return {
      routes: [],
      async onReady() { state.ready++; await ready.promise; },
      events: { types: ['assistant.message_delta'], async handle() { state.events++; await event.promise; } },
      onStop() { state.stops++; },
      dispose() { state.disposed++; },
    }; }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  host.ready();
  f.emit();
  const closing = host.close();
  await nextTurn();
  f.emit();
  host.ready();
  assert.deepEqual(probe.state, { ready: 1, events: 1, stops: 1, disposed: 0 });
  probe.ready.resolve();
  await nextTurn();
  assert.equal(probe.state.disposed, 0);
  probe.event.resolve();
  await closing;
  assert.equal(probe.state.disposed, 1);
  assert.equal(f.listeners.size, 0);
});

test('shutdown waits for in-progress activation and drains its late result without starting readiness', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('starting', `
    export const entered = Promise.withResolvers();
    export const activation = Promise.withResolvers();
    export const drain = Promise.withResolvers();
    export const state = { ready: 0, stops: 0, disposed: 0 };
    export let context;
    export async function activate(ctx) {
      context = ctx;
      entered.resolve();
      await activation.promise;
      return { routes: [], onReady() { state.ready++; },
        async onStop() { state.stops++; await drain.promise; }, dispose() { state.disposed++; } };
    }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  const registering = host.register(app);
  await probe.entered.promise;
  const closing = host.close();
  assert.ok(probe.context.stopping.aborted);
  probe.activation.resolve();
  await registering;
  await nextTurn();
  assert.deepEqual(probe.state, { ready: 0, stops: 1, disposed: 0 });
  probe.drain.resolve();
  await closing;
  assert.equal(probe.state.disposed, 1);
  assert.deepEqual(host.bootstrap().active, []);
});

test('aborted role preflight does not hide its still-running opted-in callback from drain', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('role-drain', `
    export const entered = Promise.withResolvers();
    export const gate = Promise.withResolvers();
    export let disposed = false;
    export function activate() { return { routes: [], onStop() {},
      roleAssignments: { async availability() {
        entered.resolve(); await gate.promise; return { reasons: [] };
      } }, dispose() { disposed = true; },
    }; }
  `, { roles: [{ id: 'neutral', name: 'Neutral' }] })), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const checking = host.roles.availability({ operation: 'create', previousRoles: [],
    roles: [{ moduleId: 'role-drain', roleId: 'neutral' }] });
  await probe.entered.promise;
  const closing = host.close();
  assert.equal((await checking).status, 'unknown');
  await nextTurn();
  assert.equal(probe.disposed, false);
  probe.gate.resolve();
  await closing;
  assert.equal(probe.disposed, true);
});

test('all modules receive stop even when one rejects; no opted-in resource is disposed', async t => {
  const f = await moduleFixture(t);
  const installed = [];
  for (const id of ['a-failed', 'b-good']) {
    installed.push(await installLocalModule(await f.package(moduleEntries(id, `
      export const state = { stops: 0, disposed: 0 };
      export let context;
      export function activate(ctx) { context = ctx; return {
        routes: [], onStop() { state.stops++; ${id === 'a-failed' ? 'throw new Error("unknown send outcome");' : ''} },
        dispose() { state.disposed++; },
      }; }
    `)), { trustLocalCode: true, enable: true }));
  }
  const app = Fastify();
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  await assert.rejects(host.close(), { code: 'MODULE_SHUTDOWN_FAILED' });
  await assert.rejects(app.close(), { code: 'MODULE_SHUTDOWN_FAILED' });
  for (const installation of installed) {
    const probe = await import(pathToFileURL(join(installation.root, 'backend.mjs')).href);
    assert.deepEqual(probe.state, { stops: 1, disposed: 0 });
    assert.equal(probe.context.signal.aborted, false);
  }
  assert.ok(host.bootstrap().errors.some(error => error.id === 'a-failed'));
});

test('a timed-out drain remains failed with resources retained even after late completion', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('timeout', `
    export const gate = Promise.withResolvers();
    export const state = { stopped: 0, disposed: 0 };
    export let context;
    export function activate(ctx) { context = ctx; return { routes: [],
      async onStop() { state.stopped++; await gate.promise; },
      dispose() { state.disposed++; },
    }; }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  const host = new ModuleHost({ observer: f.observer, shutdownTimeoutMs: 20 });
  await host.register(app);
  const stopping = host.stop();
  await assert.rejects(stopping, { code: 'MODULE_SHUTDOWN_TIMEOUT' });
  assert.equal(probe.context.signal.aborted, false);
  probe.gate.resolve();
  await nextTurn();
  assert.strictEqual(host.stop(), stopping);
  await assert.rejects(host.close(), { code: 'MODULE_SHUTDOWN_TIMEOUT' });
  await assert.rejects(app.close(), { code: 'MODULE_SHUTDOWN_TIMEOUT' });
  assert.deepEqual(probe.state, { stopped: 1, disposed: 0 });
  assert.equal(probe.context.signal.aborted, false);
});

test('an unresolved activation blocks shutdown and its late result cannot trigger cleanup after timeout', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('late-start', `
    export const entered = Promise.withResolvers();
    export const gate = Promise.withResolvers();
    export const state = { stops: 0, disposed: 0 };
    export async function activate() {
      entered.resolve();
      await gate.promise;
      return { routes: [], onStop() { state.stops++; }, dispose() { state.disposed++; } };
    }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  const host = new ModuleHost({ observer: f.observer, shutdownTimeoutMs: 20 });
  const registering = host.register(app);
  await probe.entered.promise;
  const closing = host.close();
  await assert.rejects(closing, { code: 'MODULE_SHUTDOWN_TIMEOUT' });
  probe.gate.resolve();
  await registering;
  await nextTurn();
  await assert.rejects(host.close(), { code: 'MODULE_SHUTDOWN_TIMEOUT' });
  await assert.rejects(app.close(), { code: 'MODULE_SHUTDOWN_TIMEOUT' });
  assert.equal(probe.state.disposed, 0);
  assert.deepEqual(host.bootstrap().active, []);
});

for (const duringStop of [false, true]) {
  test(`activation timeout preserves unknown cleanup resources (shutdown already requested: ${duringStop})`, async t => {
    const f = await moduleFixture(t);
    const installed = await installLocalModule(await f.package(moduleEntries('late-opt-in', `
      export const entered = Promise.withResolvers();
      export const activation = Promise.withResolvers();
      export const stopped = Promise.withResolvers();
      export const drain = Promise.withResolvers();
      export const state = { steps: [] };
      export let context;
      export async function activate(ctx) {
        context = ctx;
        ctx.signal.addEventListener('abort', () => state.steps.push('revoked'));
        entered.resolve();
        await activation.promise;
        return { routes: [], async onStop() {
          state.steps.push('drain');
          if (ctx.signal.aborted) throw new Error('Cleanup resource already revoked');
          stopped.resolve();
          await drain.promise;
        }, dispose() { state.steps.push('dispose'); } };
      }
    `)), { trustLocalCode: true, enable: true });
    const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
    const app = Fastify();
    t.after(() => app.close());
    const host = new ModuleHost({ observer: f.observer, activationTimeoutMs: 20 });
    const registering = host.register(app);
    await probe.entered.promise;
    const closing = duringStop ? host.close() : undefined;
    await registering;
    assert.ok(probe.context.stopping.aborted);
    assert.equal(probe.context.signal.aborted, false, 'an unknown late result might opt into resource-preserving drain');
    probe.activation.resolve();
    await probe.stopped.promise;
    assert.deepEqual(probe.state.steps, ['drain']);
    probe.drain.resolve();
    await (closing ?? host.close());
    assert.deepEqual(probe.state.steps, ['drain', 'revoked', 'dispose']);
  });
}

test('opt-in final disposal is awaited and an invalid stop hook is rejected at activation', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('dispose', `
    export const gate = Promise.withResolvers();
    export let disposals = 0;
    export function activate() { return { routes: [], onStop() {},
      async dispose() { disposals++; await gate.promise; },
    }; }
  `)), { trustLocalCode: true, enable: true });
  await installLocalModule(await f.package(moduleEntries('invalid', `
    export function activate() { return { routes: [], onStop: true }; }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  assert.deepEqual(host.bootstrap().errors.map(error => error.id), ['invalid']);
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(probe.disposals, 1);
  assert.equal(closed, false);
  probe.gate.resolve();
  await closing;
  await host.close();
  assert.equal(probe.disposals, 1);
});

test('legacy routes and native observations survive drain until the native shutdown phase has finished', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('legacy', `
    export const state = { events: 0 };
    export let context;
    export function activate(ctx) { context = ctx; return {
      routes: [{ method: 'GET', path: '/mcp-read', handler: () => ({ body: 'existing native work' }) }],
      events: { types: ['assistant.message_delta'], handle() { state.events++; } },
    }; }
  `)), { trustLocalCode: true, enable: true });
  const probe = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  await host.stop();
  assert.equal(probe.context.signal.aborted, false);
  f.emit();
  assert.equal(probe.state.events, 1);
  assert.equal((await app.inject(`${host.bootstrap().modules[0]!.apiBase}/mcp-read`)).statusCode, 200);
  await host.close();
  assert.equal(probe.context.signal.aborted, true);
  assert.equal(f.listeners.size, 0);
});
