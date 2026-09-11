import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';

const requests: ReceivedRequest[] = [];
let reject = false;
mockHttp((response, request) => {
  requests.push(request);
  response.writeHead(reject ? 400 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reject ? { message: 'Unsupported native effort' } : { ok: true }));
});
const { registerSettingsTools } = await import('./settings.ts');
const mcp = new McpServer({ name: 'settings-test', version: '1' });
const client = new Client({ name: 'settings-client', version: '1' });
registerSettingsTools(mcp);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverTransport);
await client.connect(clientTransport);
after(async () => { await client.close(); await mcp.close(); });

test('model MCP preserves explicit invalid empty effort and never converts it into an omitted option', async () => {
  reject = true;
  const result = await client.callTool({ name: 'cockpit_set_model', arguments: {
    session_id: 'owned-fixture', model_id: 'native', reasoning_effort: '',
  } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(requests.at(-1)!.body.toString()).reasoningEffort, '');
});

test('model MCP sends exact options once and labels queued-compatible acknowledgement honestly', async () => {
  reject = false;
  const before = requests.length;
  const result = await client.callTool({ name: 'cockpit_set_model', arguments: {
    session_id: 'owned-fixture', model_id: 'native', reasoning_effort: 'high', context_tier: 'long_context',
  } });
  assert.equal(result.isError, undefined);
  assert.equal(requests.length - before, 1);
  assert.deepEqual(JSON.parse(requests.at(-1)!.body.toString()), {
    sessionId: 'owned-fixture', modelId: 'native', reasoningEffort: 'high', contextTier: 'long_context',
  });
  assert.match(JSON.stringify(result.content), /request accepted/);
  assert.match(JSON.stringify(result.content), /deferred change is not applied/);
});

test('compact describes model-context compaction without retiring its explicit confirmation', async () => {
  reject = false;
  const { tools } = await client.listTools();
  const compact = tools.find(tool => tool.name === 'cockpit_compact_session')!;
  assert.match(compact.description!, /model-facing context, not the retained chat event history/);
  assert.doesNotMatch(compact.description!, /rewrites history/);
  const before = requests.length;
  const refused = await client.callTool({ name: compact.name, arguments: { session_id: 'owned-fixture' } });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /confirm=true/);
  assert.equal(requests.length, before, 'missing confirmation never invokes compaction');
  const accepted = await client.callTool({ name: compact.name, arguments: {
    session_id: 'owned-fixture', confirm: true, custom_instructions: 'Preserve the constraints',
  } });
  assert.equal(accepted.isError, undefined);
  assert.equal(requests.length, before + 1);
  assert.deepEqual(JSON.parse(requests.at(-1)!.body.toString()), {
    sessionId: 'owned-fixture', customInstructions: 'Preserve the constraints',
  });
});
