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

for (const status of ['saved', 'unchanged', 'uncertain']) {
  for (const loaded of [true, false]) {
    test(`semantic and generic role addition preserve ${status}, loaded:${loaded} with one request`, async () => {
      outcome = { sessionId: 'synthetic-id', status,
        roles: [{ ...roles[0], moduleName: 'Fixture', name: 'Owner' }],
        appliedRoles: [], loaded, rolesNeedReload: loaded,
        ...(status === 'uncertain' ? { error: 'synthetic persistence failure', recovery: 'Inspect saved roles before explicit recovery; do not retry automatically' } : {}) };
      for (const [name, args] of [
        ['cockpit_add_roles', { session_id: 'synthetic-id', roles }],
        ['cockpit_call_intent', { name: 'roles/add', body: { sessionId: 'synthetic-id', roles } }],
      ] as const) {
        requests.length = 0;
        const result = Reply.parse(await client.callTool({ name, arguments: args }));
        assert.deepEqual(JSON.parse(result.content[0].text), outcome);
        assert.equal(result.isError ?? false, status === 'uncertain');
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.url, '/intent/roles/add');
        assert.deepEqual(JSON.parse(requests[0]!.body.toString()), { sessionId: 'synthetic-id', roles });
      }
    });
  }
}

test('role MCP rejects invalid selections without sending', async () => {
  for (const selection of [[], Array.from({ length: 65 }, () => roles[0]), [{ moduleId: '', roleId: 'owner' }]]) {
    const result = Reply.parse(await client.callTool({ name: 'cockpit_add_roles', arguments: { session_id: 'synthetic-id', roles: selection } }));
    assert.equal(result.isError, true);
    assert.equal(requests.length, 0);
  }
});

test('role MCP describes metadata-only busy-safe addition and passive readiness', async () => {
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'cockpit_add_roles')!;
  assert.match(tool.description!, /including while main\/subagent\/shell work/);
  assert.match(tool.description!, /Never removes roles, stops, reloads, resumes, sends a prompt or retries/);
  assert.match(tool.description!, /unloaded sessions stay unloaded/);
  assert.match(tool.description!, /ordinary explicit reload or next cold load/);
  assert.match(tool.description!, /No phase\/readiness response/);
});

test('role readiness stays a separate passive request with saved/applied reload state', async () => {
  outcome = { sessionId: 'synthetic-id', loaded: true, ready: false, roles: [], appliedRoles: [],
    rolesNeedReload: true, reasons: ['Saved roles need reload'] };
  const result = Reply.parse(await client.callTool({ name: 'cockpit_role_readiness', arguments: { session_id: 'synthetic-id' } }));
  assert.deepEqual(JSON.parse(result.content[0].text), outcome);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, '/intent/roles/readiness');
});
