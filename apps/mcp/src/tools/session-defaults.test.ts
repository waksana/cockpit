import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';
import { harness } from '../../../../packages/core/test-support/engine-harness.ts';
import { memorySessionDefaults } from '../../../../packages/core/test-support/session-defaults.ts';

test('MCP default settings and session creation reach the host Engine without a client model override', async t => {
  process.env.COCKPIT_NO_BOOT = '1';
  process.env.COCKPIT_SERVE_WEB = '0';
  process.env.LOG_LEVEL = 'silent';
  const host = await import('../../../server/src/index.ts');
  const h = harness(t, { sessionDefaults: memorySessionDefaults() });
  h.runtime.models.mock.mockImplementation(async () => [
    { modelId: 'gpt-6-astra', name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' },
  ]);
  host.setTestDependencies({ engine: h.engine });
  const requests: ReceivedRequest[] = [];
  mockHttp((response, request) => {
    requests.push(request);
    void host.app.inject({ method: 'POST', url: request.url, payload: JSON.parse(request.body.toString()) })
      .then(result => { response.writeHead(result.statusCode, { 'content-type': 'application/json' }).end(result.body); },
        error => response.destroy(error));
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
  for (const modelId of ['gpt-6-astra', 'second']) {
    const saved = await client.callTool({ name: 'cockpit_call_intent', arguments: {
      name: 'settings/session-defaults-set', body: { modelId },
    } });
    assert.notEqual(saved.isError, true);
    const created = await client.callTool({ name: 'cockpit_new_session', arguments: { cwd: h.cwd } });
    assert.notEqual(created.isError, true);
    assert.equal(h.runtime.createSession.mock.calls.at(-1)!.arguments[0].model, modelId);
  }
  for (const request of requests.filter(request => request.url === '/intent/session/new')) {
    assert.deepEqual(JSON.parse(request.body.toString()), { cwd: h.cwd });
  }
  assert.equal(h.runtime.createSession.mock.callCount(), 2);
});
