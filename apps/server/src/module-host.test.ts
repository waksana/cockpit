import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { chmod, readFile, unlink, symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MAX_MODULE_EVENT_BYTES, type ModuleEventPayload } from '@cockpit/module-api';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { installLocalModule, selectModule } from './module-install.ts';
import { ModuleHost } from './module-host.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

const workingBackend = `
import { Readable } from 'node:stream';
export function activate(ctx) {
  return {
    publicConfig: { moduleId: ctx.moduleId, configured: ctx.config.configured === true },
    routes: [
      { method: 'GET', path: '/hello/:who', handler: req => ({ body: { who: req.params.who, q: req.query.q, apiBase: ctx.apiBase, dataRoot: ctx.dataRoot, aborted: req.signal.aborted } }) },
      { method: 'GET', path: '/download', handler: () => ({ headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.txt"' }, body: Readable.from(['fixture bytes']) }) },
      { method: 'HEAD', path: '/download', handler: () => ({ headers: { 'content-type': 'application/octet-stream', 'content-length': '13' }, body: Readable.from(['fixture bytes']) }) },
      { method: 'POST', path: '/json', bodyLimit: 32, handler: req => ({ body: req.body }) },
      { method: 'POST', path: '/upload', body: 'stream', bodyLimit: 8, handler: async req => { let bytes = 0; for await (const chunk of req.body) bytes += chunk.length; return { status: 201, body: { bytes } }; } },
      { method: 'GET', path: '/known-error', handler: () => { throw Object.assign(new Error('synthetic missing file'), { code: 'FILE_MISSING', statusCode: 404 }); } },
      { method: 'GET', path: '/unknown-error', handler: () => { throw new Error('internal stack or private state'); } },
    ],
  };
}`;

async function waitUntil(predicate: () => boolean, message: string | (() => string)): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

const publishingBackend = `
let context;
export function activate(ctx) {
  context = ctx;
  ctx.publish({ during: 'activation' });
  return { routes: [] };
}
export function publish(value) { context.publish(value); }
`;

test('module publish captures immutable data with host-owned routing and stops with its activation', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('publisher', publishingBackend)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const events: { id: string; payload: ModuleEventPayload }[] = [];
  const host = new ModuleHost({ observer: f.observer, onEvent: (id, payload) => { events.push({ id, payload }); } });
  await host.register(app);
  assert.deepEqual(events, [], 'publishing during activation is inactive, like invalidate');
  const { publish } = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const payload = { moduleId: 'another-module', type: 'session/removed', nested: [{ value: 1 }] };
  publish(payload);
  payload.nested[0]!.value = 2;
  payload.nested.push({ value: 3 });
  assert.deepEqual(events, [{ id: 'publisher', payload: {
    moduleId: 'another-module', type: 'session/removed', nested: [{ value: 1 }],
  } }]);
  const event = firstEvent(events);
  assert.ok(event);
  assert.ok(Object.isFrozen(event.payload));
  const snapshot = event.payload as typeof payload;
  assert.ok(snapshot.nested[0]);
  assert.ok(Object.isFrozen(snapshot.nested[0]));
  assert.throws(() => { snapshot.nested[0]!.value = 3; }, TypeError);
  assert.equal(f.listeners.size, 0, 'publication never subscribes to native history');
  host.close();
  publish({ after: 'stop' });
  publish(undefined);
  assert.equal(events.length, 1);
});

function firstEvent(events: readonly { id: string; payload: ModuleEventPayload }[]) {
  const event = events[0];
  assert.ok(event);
  return event;
}

test('module publish rejects malformed, nonfinite, resource and oversized payloads and reports errors', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('publisher', publishingBackend)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const reports: unknown[] = [];
  const events: ModuleEventPayload[] = [];
  const host = new ModuleHost({ observer: f.observer,
    onEvent: (_id, payload) => { events.push(payload); }, report: (_id, error) => { reports.push(error); },
  });
  await host.register(app);
  const { publish } = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = { next: deep };
  let touched = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { touched++; return 'unsafe'; } });
  const proxy = new Proxy({}, { ownKeys() { touched++; return []; } });
  const resource = Readable.from(['data']);
  t.after(() => resource.destroy());
  const invalid = [
    undefined, { value: undefined }, () => {}, Symbol(), 1n, NaN, Infinity, -Infinity,
    cycle, deep, accessor, proxy, new Date(), new Map(), Buffer.from('data'), resource,
    { toJSON() { touched++; return null; } }, new Array(4), { [Symbol()]: 1 },
  ];
  for (const payload of invalid) assert.throws(() => publish(payload), { code: 'MODULE_EVENT_INVALID' });
  assert.equal(touched, 0);
  assert.deepEqual(events, []);
  assert.equal(reports.length, invalid.length);
  assert.throws(() => publish('界'.repeat(MAX_MODULE_EVENT_BYTES / 2)), { code: 'MODULE_EVENT_TOO_LARGE' });
  assert.equal(host.bootstrap().errors[0]!.code, 'MODULE_EVENT_TOO_LARGE');
  const maximum = 'x'.repeat(MAX_MODULE_EVENT_BYTES - 2);
  publish(maximum);
  publish({ kind: 'sync-hint' });
  assert.deepEqual(events, [maximum, { kind: 'sync-hint' }], 'rejection does not stop the module or invent a fallback');
});

test('module publish honestly reports and throws unavailable or failing transports', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('publisher', publishingBackend)), { trustLocalCode: true, enable: true });
  const { publish } = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href);
  for (const onEvent of [undefined, () => { throw new Error('transport failed'); }]) {
    const app = Fastify();
    t.after(() => app.close());
    const reports: unknown[] = [];
    const host = new ModuleHost({ observer: f.observer, onEvent, report: (_id, error) => { reports.push(error); } });
    await host.register(app);
    assert.throws(() => publish(null), onEvent ? /transport failed/ : { code: 'MODULE_EVENT_UNAVAILABLE' });
    assert.equal(reports.length, 1);
    host.close();
    publish(null);
    assert.equal(reports.length, 1);
  }
});

test('failed and timed-out backend activations cannot publish using retained contexts', async t => {
  const f = await moduleFixture(t);
  const events: ModuleEventPayload[] = [];
  const installed = [];
  for (const [id, result] of [
    ['failed-publisher', 'throw new Error("activation failed")'],
    ['timed-publisher', 'return new Promise(() => {})'],
  ]) installed.push(await installLocalModule(await f.package(moduleEntries(id, `
    let context;
    export function activate(ctx) { context=ctx; ctx.publish(null); ${result}; }
    export function publish() { context.publish({ late: true }); }
  `)), { trustLocalCode: true, enable: true }));
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer, activationTimeoutMs: 30, onEvent: (_id, payload) => { events.push(payload); } });
  await host.register(app);
  assert.equal(host.bootstrap().errors.length, 2);
  for (const module of installed) (await import(pathToFileURL(join(module.root, 'backend.mjs')).href)).publish();
  assert.deepEqual(events, []);
});

test('cold-loaded modules expose only successful bootstrap assets and scoped digest-bound APIs', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', workingBackend)), { trustLocalCode: true, enable: true });
  const apiBase = `/_modules/fixture/${installed.digest}/api`;
  await selectModule('fixture', { enabled: true, config: { configured: true } });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  app.get('/native-sentinel', async () => ({ untouched: true }));
  const bootstrap = await app.inject('/_modules');
  assert.equal(bootstrap.headers['cache-control'], 'private, no-store');
  const value = bootstrap.json();
  assert.equal(value.errors.length, 0);
  assert.deepEqual(value.active, [{ id: 'fixture', version: '1.0.0', digest: installed.digest }]);
  assert.equal(value.modules[0].apiBase, apiBase);
  assert.deepEqual(value.modules[0].config, { moduleId: 'fixture', configured: true });
  const headers = { 'x-cockpit-module-digest': installed.digest };
  const response = await app.inject({ url: `${apiBase}/hello/friend?q=yes`, headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { who: 'friend', q: 'yes', apiBase, dataRoot: join(f.hostRoot, 'modules/data/fixture'), aborted: false });
  assert.equal((await app.inject(`${apiBase}/hello/friend`)).statusCode, 200, 'Version-bound native media reads may omit custom headers');
  assert.equal((await app.inject('/_modules/fixture/api/hello/friend')).statusCode, 404, 'No unversioned fallback is registered');
  assert.equal((await app.inject(`${apiBase.replace(installed.digest, '0'.repeat(64))}/hello/friend`)).statusCode, 404, 'Old version URLs cannot dispatch the new backend');
  for (const digest of ['', 'b'.repeat(64)]) {
    const mismatched = await app.inject({ url: `${apiBase}/hello/friend`, headers: { 'x-cockpit-module-digest': digest } });
    assert.equal(mismatched.statusCode, 409);
    assert.equal(mismatched.json().code, 'MODULE_VERSION_MISMATCH');
  }
  const missingMutationDigest = await app.inject({ method: 'POST', url: `${apiBase}/json`, payload: { hello: true } });
  assert.equal(missingMutationDigest.statusCode, 409);
  assert.equal(missingMutationDigest.json().code, 'MODULE_VERSION_MISMATCH');
  assert.equal((await app.inject({ url: `${apiBase}/unknown-error`, headers })).statusCode, 500);
  assert.equal((await app.inject({ url: `${apiBase}/known-error`, headers })).statusCode, 404);
  assert.deepEqual((await app.inject('/_modules')).json().errors, [], 'request failures are not activation or runtime failures');
  const asset = await app.inject(value.modules[0].entry);
  assert.match(asset.headers['content-type'] ?? '', /^text\/javascript/);
  assert.match(asset.headers['cache-control'] ?? '', /immutable/);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  assert.equal((await app.inject({ method: 'HEAD', url: value.modules[0].entry })).body, '');
  assert.match((await app.inject(value.modules[0].styles[0])).headers['content-type'] ?? '', /^text\/css/);
  for (const path of ['backend.mjs', 'web/missing.js', 'web/%252e%252e/backend.mjs']) {
    assert.equal((await app.inject(`/_modules/assets/fixture/${installed.digest}/${path}`)).statusCode, 404);
  }
  assert.equal((await app.inject(value.modules[0].entry.replace(installed.digest, '0'.repeat(64)))).statusCode, 404);
  await selectModule('fixture', { enabled: false });
  assert.equal((await app.inject('/_modules')).json().active.length, 1, 'selection changes must not hot-unload a running module');
  assert.deepEqual((await app.inject('/native-sentinel')).json(), { untouched: true });
});

test('activation and route compilation failures stay local and activation is not repeated', async t => {
  const f = await moduleFixture(t);
  const duplicate = `
    import { writeFileSync } from 'node:fs';
    export function activate(ctx) {
      writeFileSync(ctx.dataRoot + '/activated', 'once', { flag: 'wx' });
      return { routes: [
        { method: 'GET', path: '/:first', handler: () => ({ body: 'a' }) },
        { method: 'GET', path: '/:second', handler: () => ({ body: 'b' }) },
      ], dispose() { writeFileSync(ctx.dataRoot + '/disposed', 'yes'); } };
    }`;
  for (const [id, backend] of [
    ['a-throws', 'export function activate() { throw new Error("synthetic activation failure"); }'],
    ['b-invalid', 'import { writeFileSync } from "node:fs"; export function activate(ctx) { return { routes: [], onClose() {}, dispose() { writeFileSync(ctx.dataRoot + "/disposed", "once", { flag: "wx" }); } }; }'],
    ['c-duplicate', duplicate],
    ['d-good', workingBackend],
  ]) await installLocalModule(await f.package(moduleEntries(id, backend)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  app.get('/native', async () => ({ native: 'healthy' }));
  const bootstrap = (await app.inject('/_modules')).json();
  assert.deepEqual(bootstrap.modules.map((value: { id: string }) => value.id), ['d-good']);
  assert.deepEqual(bootstrap.errors.map((value: { id: string }) => value.id), ['a-throws', 'b-invalid', 'c-duplicate']);
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/c-duplicate/activated'), 'utf8'), 'once');
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/c-duplicate/disposed'), 'utf8'), 'yes');
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/b-invalid/disposed'), 'utf8'), 'once');
  assert.equal((await app.inject('/native')).statusCode, 200);
  assert.equal((await app.inject(`/_modules/c-duplicate/${'0'.repeat(64)}/api/anything`)).statusCode, 404);
});

test('module routes support streaming GET/HEAD, isolated JSON/octet parsers, errors and per-route upload limits', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', workingBackend)), { trustLocalCode: true, enable: true });
  const apiBase = `/_modules/fixture/${installed.digest}/api`;
  const app = Fastify();
  t.after(() => app.close());
  await new ModuleHost({ observer: f.observer }).register(app);
  app.post('/root-json', async request => request.body);
  const headers = { 'x-cockpit-module-digest': installed.digest };
  const download = await app.inject({ url: `${apiBase}/download`, headers });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, 'fixture bytes');
  assert.equal(download.headers['content-disposition'], 'attachment; filename="fixture.txt"');
  assert.equal((await app.inject({ method: 'HEAD', url: `${apiBase}/download`, headers })).body, '');
  const nativeMedia = await app.inject(`${apiBase}/download`);
  assert.equal(nativeMedia.statusCode, 200);
  assert.equal(nativeMedia.body, 'fixture bytes');
  const nativeHead = await app.inject({ method: 'HEAD', url: `${apiBase}/download` });
  assert.equal(nativeHead.statusCode, 200);
  assert.equal(nativeHead.headers['content-length'], '13');
  const oldHead = await app.inject({ method: 'HEAD', url: `${apiBase}/download`, headers: { 'x-cockpit-module-digest': '0'.repeat(64) } });
  assert.equal(oldHead.statusCode, 409);
  assert.equal((await app.inject({ method: 'HEAD', url: `${apiBase}/hello/friend`, headers })).statusCode, 404, 'GET declarations do not create implicit HEAD handlers');
  const json = await app.inject({ method: 'POST', url: `${apiBase}/json`, headers, payload: { hello: true } });
  assert.equal(json.statusCode, 200);
  assert.deepEqual(json.json(), { hello: true });
  const oversized = await app.inject({ method: 'POST', url: `${apiBase}/json`, headers, payload: { text: 'x'.repeat(40) } });
  assert.equal(oversized.statusCode, 413);
  const uploadHeaders = { ...headers, 'content-type': 'application/octet-stream' };
  const upload = await app.inject({ method: 'POST', url: `${apiBase}/upload`, headers: uploadHeaders, payload: Buffer.from('1234') });
  assert.equal(upload.statusCode, 201);
  assert.deepEqual(upload.json(), { bytes: 4 });
  const emptyUpload = await app.inject({ method: 'POST', url: `${apiBase}/upload`, headers: uploadHeaders, payload: Buffer.alloc(0) });
  assert.equal(emptyUpload.statusCode, 201);
  assert.deepEqual(emptyUpload.json(), { bytes: 0 });
  const tooLarge = await app.inject({ method: 'POST', url: `${apiBase}/upload`, headers: uploadHeaders, payload: Buffer.from('123456789') });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal((await app.inject({ method: 'POST', url: '/root-json', headers: uploadHeaders, payload: Buffer.from('1234') })).statusCode, 415);
  assert.equal((await app.inject({ method: 'POST', url: `${apiBase}/json`, headers: uploadHeaders, payload: Buffer.from('1234') })).statusCode, 415);
  const known = await app.inject({ url: `${apiBase}/known-error`, headers });
  assert.equal(known.statusCode, 404);
  assert.deepEqual(known.json(), { code: 'FILE_MISSING', error: 'synthetic missing file' });
  const unknown = await app.inject({ url: `${apiBase}/unknown-error`, headers });
  assert.equal(unknown.statusCode, 500);
  assert.deepEqual(unknown.json(), { code: 'MODULE_ERROR', error: 'Module request failed' });
});

test('stream routes reject unsupported types before parsing and close incomplete uploads', { timeout: 5000 }, async t => {
  const f = await moduleFixture(t);
  const backend = `export function activate() { return { routes: [{
    method: 'POST', path: '/upload', body: 'stream', bodyLimit: 1073741824,
    handler: async request => {
      let bytes = 0;
      for await (const chunk of request.body) bytes += chunk.length;
      return { status: 201, body: { bytes } };
    }
  }] }; }`;
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', backend)), { trustLocalCode: true, enable: true });
  const app = Fastify({ forceCloseConnections: true });
  t.after(() => app.close());
  let parsing = 0;
  const sources: Readable[] = [];
  app.addHook('onRequest', async request => { sources.push(request.raw); });
  app.addHook('preParsing', async (_request, _reply, payload) => { parsing++; return payload; });
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const url = `${host.bootstrap().modules[0]!.apiBase}/upload`;
  const headers = { 'x-cockpit-module-digest': installed.digest };
  const payload = Buffer.from('{"unterminated":"' + 'x'.repeat(1024 * 1024 + 1));
  for (const contentType of ['application/json', 'text/plain', 'application/octet-stream+json', 'application/octet-stream/invalid', undefined]) {
    const response = await app.inject({
      method: 'POST', url, payload,
      headers: { ...headers, ...(contentType ? { 'content-type': contentType } : {}) },
    });
    assert.equal(response.statusCode, 415, contentType);
    assert.equal(response.json().code, 'MODULE_CONTENT_TYPE');
    assert.equal(parsing, 0, 'Unsupported uploads must not reach preParsing or buffered JSON/text parsers');
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  for (const contentType of ['application/json', 'text/plain']) {
    const response = await new Promise<{ status?: number; body: string; connection?: string }>((resolve, reject) => {
      const request = httpRequest(`${address}${url}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': contentType, 'content-length': String(128 * 1024 * 1024), connection: 'keep-alive' },
      }, result => {
        let body = '';
        result.on('error', reject);
        result.on('data', chunk => { body += chunk; });
        result.on('end', () => resolve({ status: result.statusCode, body, connection: result.headers.connection }));
      });
      request.on('error', reject);
      t.after(() => request.destroy());
      request.write('{"incomplete":');
    });
    assert.equal(response.status, 415, 'Reject without waiting for the declared upload body');
    assert.equal(JSON.parse(response.body).code, 'MODULE_CONTENT_TYPE');
    assert.equal(response.connection, 'close');
    assert.equal(parsing, 0);
  }
  await waitUntil(() => sources.every(source => source.destroyed), 'Rejected upload sources were not closed');
  for (const contentType of ['application/octet-stream', 'Application/Octet-Stream', 'application/octet-stream; charset=binary', 'APPLICATION/OCTET-STREAM ; filename="fixture;bytes.bin"']) {
    const response = await app.inject({
      method: 'POST', url, payload: Buffer.from('1234'), headers: { ...headers, 'content-type': contentType },
    });
    assert.equal(response.statusCode, 201, contentType);
    assert.deepEqual(response.json(), { bytes: 4 });
  }
  assert.equal(parsing, 4);
  await waitUntil(() => (Reflect.get(host, 'loaded') as Array<{ streams: Set<Readable>; replies: Set<unknown> }>)
    .every(module => module.streams.size === 0 && module.replies.size === 0), 'Upload request resources were retained');
});

test('activation timeouts abort and dispose late results once while other modules still load', async t => {
  const f = await moduleFixture(t);
  const slow = `
    import { writeFileSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    export async function activate(ctx) {
      await setTimeout(250);
      return { routes: [], dispose() { writeFileSync(ctx.dataRoot + '/disposed', 'once', { flag: 'wx' }); } };
    }`;
  await installLocalModule(await f.package(moduleEntries('a-slow', slow)), { trustLocalCode: true, enable: true });
  await installLocalModule(await f.package(moduleEntries('b-good')), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer, activationTimeoutMs: 100 });
  await host.register(app);
  assert.deepEqual((await app.inject('/_modules')).json().active.map((module: { id: string }) => module.id), ['b-good']);
  await delay(300);
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/a-slow/disposed'), 'utf8'), 'once');
  assert.equal(host.bootstrap().errors.find(error => error.id === 'a-slow')?.error, 'Module activation timed out');
});

test('asset serving rejects replaced symlinks even after successful activation', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const asset = host.bootstrap().modules[0]!.entry;
  await chmod(join(installed.root, 'web'), 0o700);
  await unlink(join(installed.root, 'web/index.js'));
  await symlink(join(installed.root, 'backend.mjs'), join(installed.root, 'web/index.js'));
  assert.equal((await app.inject(asset)).statusCode, 404);
});

test('native notifications filter types and isolate failures without retaining work; close never joins dispose', async t => {
  const f = await moduleFixture(t);
  const subscription = t.mock.method(f.observer, 'onNativeEvent');
  const backend = `
    import { appendFileSync, writeFileSync } from 'node:fs';
    export function activate(ctx) {
      ctx.signal.addEventListener('abort', () => writeFileSync(ctx.dataRoot + '/aborted', 'yes'));
      return { routes: [], events: { types: ['assistant.message_delta'], handle(value) {
        appendFileSync(ctx.dataRoot + '/events', value.sessionId + ':' + value.cwd + '\\n');
        throw new Error('synthetic observer failure');
      } }, dispose() { writeFileSync(ctx.dataRoot + '/disposed', 'yes'); return new Promise(() => {}); } };
    }`;
  await installLocalModule(await f.package(moduleEntries('fixture', backend)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  await app.ready();
  assert.equal(f.listeners.size, 1);
  assert.deepEqual(subscription.mock.calls[0]?.arguments.at(1), { types: ['assistant.message_delta'] });
  f.emit('session.idle');
  f.emit();
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/fixture/events'), 'utf8'), `synthetic-session:${f.root}\n`);
  assert.equal(host.bootstrap().errors[0]?.error, 'synthetic observer failure');
  await Promise.race([app.close(), delay(1000).then(() => { throw new Error('Module dispose blocked app.close'); })]);
  assert.equal(f.listeners.size, 0);
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/fixture/aborted'), 'utf8'), 'yes');
  assert.equal(await readFile(join(f.hostRoot, 'modules/data/fixture/disposed'), 'utf8'), 'yes');
});

test('chunked uploads enforce byte limits and stalled module HTTP work cannot block server close', async t => {
  const f = await moduleFixture(t);
  const backend = `
    import { writeFileSync } from 'node:fs';
    export function activate(ctx) { return { routes: [{ method: 'POST', path: '/upload', body: 'stream', bodyLimit: 8, handler: async req => {
      writeFileSync(ctx.dataRoot + '/started', 'yes');
      for await (const chunk of req.body) {}
      return { body: 'done' };
    } }], dispose() { return new Promise(() => {}); } }; }`;
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', backend)), { trustLocalCode: true, enable: true });
  const apiBase = `/_modules/fixture/${installed.digest}/api`;
  const app = Fastify({ forceCloseConnections: true });
  t.after(() => app.close());
  await new ModuleHost({ observer: f.observer }).register(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { 'x-cockpit-module-digest': installed.digest, 'content-type': 'application/octet-stream' };
  const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest(`${address}${apiBase}/upload`, { method: 'POST', headers }, result => {
      let body = '';
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    request.on('error', reject);
    request.write('12345');
    request.end('67890');
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).code, 'MODULE_BODY_TOO_LARGE');
  await unlink(join(f.hostRoot, 'modules/data/fixture/started'));
  const request = httpRequest(`${address}${apiBase}/upload`, { method: 'POST', headers });
  request.on('error', () => {});
  t.after(() => request.destroy());
  request.write('123');
  for (let attempts = 0; ; attempts++) {
    try { await readFile(join(f.hostRoot, 'modules/data/fixture/started')); break; }
    catch { if (attempts >= 50) throw new Error('Synthetic upload did not start'); await delay(10); }
  }
  await Promise.race([app.close(), delay(1000).then(() => { throw new Error('Module upload blocked app.close'); })]);
});

test('response streams are owned before abort and response validation, including returns after host close', async t => {
  const f = await moduleFixture(t);
  const backend = `
    import { createReadStream, writeFileSync } from 'node:fs';
    export const probes = new Map();
    export function activate(ctx) {
      const file = ctx.dataRoot + '/synthetic-response.txt';
      writeFileSync(file, 'synthetic response bytes');
      return { routes: [{ method: 'GET', path: '/response/:kind', handler: async request => {
        const kind = request.params.kind;
        const probe = { signal: request.signal, release: undefined, stream: undefined };
        probes.set(kind, probe);
        if (kind === 'abort' || kind === 'shutdown') await new Promise(resolve => { probe.release = resolve; });
        probe.stream = createReadStream(file);
        return { body: probe.stream, status: kind === 'status' ? 0 : 200,
          headers: kind === 'headers' ? { 'invalid header name': 'bad' } : undefined };
      } }] };
    }`;
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', backend)), { trustLocalCode: true, enable: true });
  const app = Fastify({ forceCloseConnections: true });
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const { probes } = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href) as {
    probes: Map<string, { signal: AbortSignal; release?: () => void; stream?: Readable }>;
  };
  const apiBase = host.bootstrap().modules[0]!.apiBase;
  for (const kind of ['status', 'headers']) {
    assert.equal((await app.inject(`${apiBase}/response/${kind}`)).statusCode, 500);
    await waitUntil(() => probes.get(kind)?.stream?.closed === true, `Invalid ${kind} response leaked its file stream`);
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  for (const kind of ['abort', 'shutdown']) {
    const request = httpRequest(`${address}${apiBase}/response/${kind}`);
    request.on('error', () => {});
    t.after(() => request.destroy());
    request.end();
    await waitUntil(() => !!probes.get(kind)?.release, 'Synthetic module handler did not start');
    if (kind === 'abort') request.destroy();
    else await Promise.race([app.close(), delay(1000).then(() => { throw new Error('Late handler blocked close'); })]);
    await waitUntil(() => probes.get(kind)!.signal.aborted, 'Request signal did not abort');
    probes.get(kind)!.release!();
    await waitUntil(() => probes.get(kind)?.stream?.closed === true, 'Late handler leaked its file stream');
  }
  assert.equal((Reflect.get(host, 'scopes') as Set<AbortController>).size, 0);
  const loaded = Reflect.get(host, 'loaded') as Array<{ streams: Set<Readable> }>;
  assert.ok(loaded.every(module => module.streams.size === 0), 'Late streams must not repopulate a closed host registry');
});

test('early upload responses release upstream backpressure and their source listeners', async t => {
  const f = await moduleFixture(t);
  const backend = `
    export function activate() { return { routes: [{
      method: 'POST', path: '/early/:kind', body: 'stream', bodyLimit: 1048576,
      handler: request => {
        if (request.params.kind === 'throw') throw Object.assign(new Error('synthetic rejection'), { statusCode: 400, code: 'SYNTHETIC_REJECTION' });
        return { status: 400, body: { error: 'synthetic early rejection' } };
      }
    }] }; }`;
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', backend)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  let upstream: Readable | undefined;
  app.addHook('preParsing', async (_request, _reply, payload) => { upstream = payload; return payload; });
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  const apiBase = host.bootstrap().modules[0]!.apiBase;
  for (const kind of ['return', 'throw']) {
    let produced = 0;
    const payload = Readable.from((async function* () {
      for (let index = 0; index < 64; index++) {
        produced += 8192;
        yield Buffer.alloc(8192);
      }
    })());
    t.after(() => payload.destroy());
    const response = await app.inject({
      method: 'POST', url: `${apiBase}/early/${kind}`, payload,
      headers: { 'content-type': 'application/octet-stream', 'x-cockpit-module-digest': installed.digest },
    });
    assert.equal(response.statusCode, 400);
    await waitUntil(() => payload.readableEnded && !!upstream?.readableEnded,
      () => `Early ${kind} stalled: ${JSON.stringify({ produced, ended: payload.readableEnded, sourceEnded: upstream?.readableEnded, sourceDestroyed: upstream?.destroyed })}`);
    assert.equal(produced, 512 * 1024);
    assert.equal(upstream!.listeners('error').some(listener => listener.name === 'sourceError'), false);
    assert.equal(upstream!.listeners('data').length, 0);
    await waitUntil(() => (Reflect.get(host, 'loaded') as Array<{ streams: Set<Readable> }>).every(module => module.streams.size === 0),
      'Completed upload sources remained in the module stream registry');
  }
});

test('discarding an early upload is byte-bounded rather than consuming an unbounded source', async t => {
  const f = await moduleFixture(t);
  const backend = `export function activate() { return { routes: [{
    method: 'POST', path: '/early', body: 'stream', bodyLimit: 4194304, handler: () => ({ status: 400, body: 'rejected' })
  }] }; }`;
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', backend)), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  let upstream: Readable | undefined;
  app.addHook('preParsing', async (_request, _reply, payload) => { upstream = payload; return payload; });
  const host = new ModuleHost({ observer: f.observer });
  await host.register(app);
  let produced = 0;
  const payload = Readable.from((async function* () {
    for (let index = 0; index < 512; index++) { produced += 8192; yield Buffer.alloc(8192); }
  })());
  t.after(() => payload.destroy());
  const response = await app.inject({
    method: 'POST', url: `${host.bootstrap().modules[0]!.apiBase}/early`, payload,
    headers: { 'content-type': 'application/octet-stream', 'x-cockpit-module-digest': installed.digest },
  });
  assert.equal(response.statusCode, 400);
  await waitUntil(() => upstream?.destroyed === true, 'Oversized discarded source was not closed');
  assert.ok(produced < 2 * 1024 * 1024, `Discarded too much upload data: ${produced}`);
  assert.equal(upstream!.listeners('error').some(listener => listener.name === 'sourceError'), false);
});

test('module API routes inherit the real server origin guard without native construction', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('fixture', workingBackend)), { trustLocalCode: true, enable: true });
  process.env.LOG_LEVEL = 'silent';
  const { app } = await import('./index.ts');
  t.after(() => app.close());
  await new ModuleHost({ observer: f.observer }).register(app);
  const response = await app.inject({
    method: 'POST', url: `/_modules/fixture/${installed.digest}/api/json`,
    headers: { origin: 'https://synthetic-attacker.invalid', host: 'fixture.example', 'x-cockpit-module-digest': installed.digest },
    payload: { hello: true },
  });
  assert.equal(response.statusCode, 403);
  assert.equal((await app.inject('/_modules')).statusCode, 200);
});
