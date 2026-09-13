import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { readDeliveryStatus, registerDeliveryStatus } from './delivery-status.ts';

test('version view is demand-driven read-only proxy with no admin credentials in output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'status-view-'));
  const path = join(directory, 'viewer.json');
  let reads = 0, fail = false;
  const server = createServer((req, res) => {
    reads++;
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/status');
    assert.equal(req.headers.authorization, 'Bearer fixture-viewer');
    res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ projects: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: 'fixture-viewer' }), { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true }); });
  assert.equal(reads, 0);
  assert.deepEqual(await readDeliveryStatus(path), { projects: [] });
  assert.equal(reads, 1);
  fail = true;
  await assert.rejects(readDeliveryStatus(path), /HTTP 503/);
  assert.equal(reads, 2);
});
test('unconfigured version view is explicitly unavailable, never repo HEAD or last success', async t => {
  const previous = process.env.COCKPIT_DELIVERY_VIEWER_CREDENTIAL;
  delete process.env.COCKPIT_DELIVERY_VIEWER_CREDENTIAL;
  t.after(() => { if (previous !== undefined) process.env.COCKPIT_DELIVERY_VIEWER_CREDENTIAL = previous; });
  const app = Fastify(); registerDeliveryStatus(app); t.after(() => app.close());
  const response = await app.inject('/system/versions');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.body.includes('sha'));
});
