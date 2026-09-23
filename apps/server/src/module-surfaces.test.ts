import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { ServerEvent } from '@cockpit/protocol';
import { ModuleHost } from './module-host.ts';
import { installLocalModule } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

test('bootstrap exposes the frontend entry and styles under the immutable identity', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('surface-assets', undefined, {
    frontend: { entry: 'web/index.js', styles: ['web/style.css'], assets: ['web'] },
  });
  const installed = await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const bootstrap = (await app.inject('/_modules')).json();
  const root = `/_modules/assets/surface-assets/${installed.digest}/web`;
  assert.deepEqual(bootstrap.errors, []);
  assert.deepEqual(bootstrap.active, [{ id: 'surface-assets', version: installed.manifest.version, digest: installed.digest }]);
  assert.equal(bootstrap.modules[0].entry, `${root}/index.js`);
  assert.deepEqual(bootstrap.modules[0].styles, [`${root}/style.css`]);
  assert.equal((await app.inject(bootstrap.modules[0].entry)).statusCode, 200);
  assert.equal((await app.inject(bootstrap.modules[0].styles[0])).statusCode, 200);
});

test('control observation and invalidation stay scoped and cannot outlive module shutdown', async t => {
  const f = await moduleFixture(t);
  const listeners = new Set<(event: ServerEvent) => void>();
  const changes: string[] = [];
  const entries = moduleEntries('surface-fixture', `
    let saved;
    export function activate(ctx) {
      saved=ctx;
      ctx.invalidate();
      let calls=0;
      return {
        routes:[{method:'GET',path:'/calls',handler:()=>({body:{calls}})}],
        controlEvents:{types:['session/patch'],handle(event){calls++;event.sessionId='modified';ctx.invalidate();}}
      };
    }
    export function afterStop(){saved.invalidate();}
  `);
  const installed = await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: { ...f.observer,
    onEvent(handler) { listeners.add(handler); return () => { listeners.delete(handler); }; },
  }, onInvalidate: id => changes.push(id) });
  await host.register(app);
  assert.deepEqual(changes, [], 'activation before publication has no invalidation side effect');
  const event: ServerEvent = { type: 'session/patch', sessionId: 'synthetic', ask: null };
  for (const handler of listeners) handler(event);
  assert.equal(event.sessionId, 'synthetic', 'modules never mutate the native control projection');
  assert.deepEqual(changes, ['surface-fixture']);
  for (const handler of listeners) handler({ type: 'session/removed', sessionId: 'synthetic' });
  const response = await app.inject(`/_modules/surface-fixture/${installed.digest}/api/calls`);
  assert.deepEqual(response.json(), { calls: 1 });
  host.close();
  assert.equal(listeners.size, 0);
  const { afterStop } = await import(join(installed.root, 'backend.mjs'));
  afterStop();
  assert.equal(changes.length, 1);
});

test('a module worker has a stable narrow scope and is verified against the active archive', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('worker-fixture', undefined, {
    frontend: { entry: 'web/index.js', assets: ['web'], worker: 'web/worker.js' },
  });
  entries.push({ path: 'web/worker.js', content: 'self.addEventListener("message", () => {});' });
  const installed = await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const bootstrap = (await app.inject('/_modules')).json();
  assert.deepEqual(bootstrap.modules[0].worker, {
    entry: '/_modules/workers/worker-fixture/worker.js', scope: '/_modules/workers/worker-fixture/',
  });
  const response = await app.inject(bootstrap.modules[0].worker.entry);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['service-worker-allowed'], './');
  assert.match(response.body, /self\.__cockpitModuleWorker=/);
  assert.ok(response.body.includes(installed.digest));
  assert.ok(response.body.includes(`../../worker-fixture/${installed.digest}/api`));
  assert.equal((await app.inject('/_modules/workers/unknown/worker.js')).statusCode, 404);
  await chmod(join(installed.root, 'web/worker.js'), 0o600);
  await writeFile(join(installed.root, 'web/worker.js'), response.body.slice(-46).padEnd(46));
  assert.equal((await app.inject(bootstrap.modules[0].worker.entry)).statusCode, 500);
  host.close();
  assert.equal((await app.inject(bootstrap.modules[0].worker.entry)).statusCode, 404);
});

test('a module requiring unavailable control events is disabled locally', async t => {
  const f = await moduleFixture(t);
  await installLocalModule(await f.package(moduleEntries('needs-control',
    'export function activate(){return {routes:[],controlEvents:{types:["session/patch"],handle(){}}};}')),
  { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  await new ModuleHost({ observer: f.observer }).register(app);
  const bootstrap = (await app.inject('/_modules')).json();
  assert.equal(bootstrap.modules.length, 0);
  assert.equal(bootstrap.errors[0].id, 'needs-control');
});
