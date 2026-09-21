import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';

const requests: ReceivedRequest[] = [];
const roles = [{ moduleId: 'fixture', roleId: 'owner' }];
let outcome: unknown;
mockHttp((response, request) => {
  requests.push(request);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(outcome));
});
const { registerRoleTools } = await import('./roles.ts');
const { registerFoundationTools } = await import('./foundation.ts');
const server = new McpServer({ name: 'synthetic-roles', version: '1' });
const client = new Client({ name: 'synthetic-client', version: '1' });
registerRoleTools(server);
registerFoundationTools(server);
const [left, right] = InMemoryTransport.createLinkedPair();
await server.connect(right);
await client.connect(left);
after(async () => { await client.close(); await server.close(); });
beforeEach(() => { requests.length = 0; });
const Reply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
  isError: z.boolean().optional(),
});

for (const status of ['applied', 'unchanged', 'incomplete', 'uncertain']) {
  test(`semantic and generic role addition preserve ${status} with one request`, async () => {
    outcome = { sessionId: 'synthetic-id', status, phase: 'verify', roles: [], appliedRoles: [], loaded: true,
      ...(status === 'incomplete' || status === 'uncertain' ? { error: 'synthetic failure', recovery: 'Inspect before retry' } : {}) };
    for (const [name, args] of [
      ['cockpit_add_roles', { session_id: 'synthetic-id', roles }],
      ['cockpit_call_intent', { name: 'roles/add', body: { sessionId: 'synthetic-id', roles } }],
    ] as const) {
      requests.length = 0;
      const result = Reply.parse(await client.callTool({ name, arguments: args }));
      assert.deepEqual(JSON.parse(result.content[0].text), outcome);
      assert.equal(result.isError ?? false, status === 'incomplete' || status === 'uncertain');
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.url, '/intent/roles/add');
      assert.deepEqual(JSON.parse(requests[0]!.body.toString()), { sessionId: 'synthetic-id', roles });
    }
  });
}

test('role MCP rejects empty selection without sending and describes self-call safety', async () => {
  const result = Reply.parse(await client.callTool({ name: 'cockpit_add_roles', arguments: { session_id: 'synthetic-id', roles: [] } }));
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'cockpit_add_roles')!;
  assert.match(tool.description!, /self-call is busy/);
  assert.match(tool.description!, /never removes roles/);
});
