import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';
import { harness } from '../../../../packages/core/test-support/engine-harness.ts';
import { HostSessionDefaults } from '../../../server/src/session-defaults.ts';

test('MCP default settings and session creation reach the host Engine without a client model override', async t => {
  process.env.COCKPIT_NO_BOOT = '1';
  process.env.COCKPIT_SERVE_WEB = '0';
  process.env.LOG_LEVEL = 'silent';
  const host = await import('../../../server/src/index.ts');
  const root = await mkdtemp(join(tmpdir(), 'cockpit-mcp-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, revision: 1, values: { unrelated: 'preserved' } }));
  const h = harness(t, { sessionDefaults: new HostSessionDefaults(root) });
  h.runtime.models.mock.mockImplementation(async () => [
    { modelId: 'gpt-6-astra', name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' },
  ]);
  host.setTestDependencies({ engine: h.engine });
  const requests: ReceivedRequest[] = [];
  const listen = Server.prototype.listen;
  mockHttp((response, request) => {
    requests.push(request);
    void host.app.inject({ method: 'POST', url: request.url, payload: JSON.parse(request.body.toString()) })
      .then(result => { response.writeHead(result.statusCode, { 'content-type': 'application/json' }).end(result.body); },
        error => response.destroy(error));
  });
  // Only the kernel lease for this temporary storage root may listen, never a transport server.
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: Parameters<typeof listen>) {
    assert.equal(args[0], `\0cockpit-module-writer-${createHash('sha256').update(root).digest('hex')}`);
    return listen.apply(this, args);
  });
  const { registerLifecycleTools } = await import('./lifecycle.ts');
  const { registerFoundationTools } = await import('./foundation.ts');
  const server = new McpServer({ name: 'defaults-fixture', version: '1' });
  const client = new Client({ name: 'defaults-fixture-client', version: '1' });
  registerLifecycleTools(server);
  registerFoundationTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await host.app.close(); });
  const initial = await client.callTool({ name: 'cockpit_call_intent', arguments: {
    name: 'settings/session-defaults', body: {},
  } });
  assert.notEqual(initial.isError, true);
  assert.match(JSON.stringify(initial.content), /gpt-6-astra/);
  for (const modelId of ['gpt-6-astra', 'second']) {
    const saved = await client.callTool({ name: 'cockpit_call_intent', arguments: {
      name: 'settings/session-defaults-set', body: { modelId },
    } });
    assert.notEqual(saved.isError, true, JSON.stringify(saved));
    const created = await client.callTool({ name: 'cockpit_new_session', arguments: { cwd: h.cwd } });
    assert.notEqual(created.isError, true);
    assert.equal(h.runtime.createSession.mock.calls.at(-1)!.arguments[0].model, modelId);
  }
  for (const request of requests.filter(request => request.url === '/intent/session/new')) {
    assert.deepEqual(JSON.parse(request.body.toString()), { cwd: h.cwd });
  }
  assert.equal(h.runtime.createSession.mock.callCount(), 2);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    schemaVersion: 1, revision: 3, values: { unrelated: 'preserved', sessionDefaults: { modelId: 'second' } },
  });
});
