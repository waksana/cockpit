import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import { registerModuleProxy } from './module-proxy.ts';

test('single-port module gateway forwards only read UI/SSE routes with viewer identity, never internal writes', async t => {
  const observed: { url?: string; authorization?: string; host?: string; cookie?: string }[] = [];
  const upstream = createServer((req, res) => {
    observed.push({ url: req.url, authorization: req.headers.authorization, host: req.headers.host, cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': req.url === '/api/events' ? 'text/event-stream' : 'application/json',
      'content-security-policy': "default-src 'self'", 'referrer-policy': 'no-referrer', 'x-accel-buffering': 'no' });
    res.end(req.url === '/api/events' ? 'event: ready\ndata: {}\n\n' : JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const app = Fastify();
  t.after(() => app.close());
  registerModuleProxy(app, () => ({ origin: `http://127.0.0.1:${address.port}`,
    publicOrigin: 'https://cockpit.invalid', token: 'synthetic-viewer-token' }));
  for (const url of ['/modules/task/', '/modules/task/app.js?v=1', '/modules/task/style.css', '/modules/task/api/events']) {
    const response = await app.inject({ method: 'GET', url, headers: { cookie: 'must-not-forward', authorization: 'Bearer must-not-forward' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-security-policy'], "default-src 'self'");
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-accel-buffering'], 'no');
  }
  assert.equal((await app.inject({ method: 'POST', url: '/modules/task/api/read',
    headers: { origin: 'https://cockpit.invalid' }, payload: { view: 'summary' } })).statusCode, 200);
  const allowedCount = observed.length;
  for (const url of ['/modules/task/admin/restart', '/modules/task/admin/module/caller', '/modules/task/api/tools/work_dispatch',
    '/modules/task/health', '/modules/task/version', '/modules/task/%2e%2e/admin/restart']) {
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/modules/task/api/read',
    headers: { origin: 'https://attacker.invalid' }, payload: {} })).statusCode, 403);
  assert.equal(observed.length, allowedCount);
  assert.ok(observed.every(req => req.authorization === 'Bearer synthetic-viewer-token' && req.cookie === undefined && req.host === 'cockpit.invalid'));
  assert.equal((await app.inject({ method: 'GET', url: '/modules/task' })).headers.location, '/modules/task/');
});

test('module SSE forwards subsequent changes and upstream disconnect instead of leaving a stale connected stream', async t => {
  let stream: ServerResponse | undefined;
  const upstream = createServer((_req, res) => {
    stream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
    res.write('event: ready\ndata: {}\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const app = Fastify({ forceCloseConnections: true });
  t.after(() => app.close());
  registerModuleProxy(app, () => ({ origin: `http://127.0.0.1:${address.port}`,
    publicOrigin: 'https://cockpit.invalid', token: 'synthetic-viewer-token' }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${origin}/modules/task/api/events`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /event: ready/);
  stream!.write('event: changed\ndata: {}\n\n');
  assert.match(decoder.decode((await reader.read()).value), /event: changed/);
  stream!.destroy();
  assert.equal(await Promise.race([reader.read().then(value => value.done, () => true), sleep(1000).then(() => false)]), true);
});
