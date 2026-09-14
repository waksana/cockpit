import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';

const requests: ReceivedRequest[] = [];
let listing: { path: string; parent: string | null; entries: { name: string; isDir: boolean }[] };
mockHttp((response, request) => {
  requests.push(request);
  assert.equal(request.url, '/intent/fs/listDir');
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listing));
});
const { registerDirectoryTools } = await import('./directory.ts');
const { CHARACTER_LIMIT } = await import('../config.ts');
const server = new McpServer({ name: 'directory-test', version: '1' });
const client = new Client({ name: 'directory-client', version: '1' });
registerDirectoryTools(server);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
after(async () => { await client.close(); await server.close(); });
beforeEach(() => { requests.length = 0; });

const Reply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
  isError: z.boolean().optional(),
});

for (const input of [undefined, 'relative/project'] as const) {
  test(`large directory JSON preserves backend location for ${input ?? 'default home'}`, async () => {
    listing = {
      path: input ? '/backend/root/relative/project' : '/backend/default-home',
      parent: input ? '/backend/root/relative' : '/backend',
      entries: Array.from({ length: 1200 }, (_, index) => ({ name: `entry-${index}`, isDir: index % 2 === 0 })),
    };
    assert.ok(JSON.stringify(listing, null, 2).length > CHARACTER_LIMIT);
    const reply = Reply.parse(await client.callTool({
      name: 'cockpit_list_dir', arguments: { response_format: 'json', ...(input === undefined ? {} : { path: input }) },
    }));
    assert.equal(reply.isError, undefined);
    assert.ok(reply.content[0].text.length <= CHARACTER_LIMIT);
    const compacted = JSON.parse(reply.content[0].text);
    assert.equal(compacted.path, listing.path);
    assert.equal(compacted.parent, listing.parent);
    assert.equal(compacted.count, listing.entries.length);
    assert.equal(compacted._returned, compacted.entries.length);
    assert.ok(compacted._returned > 0 && compacted._returned < listing.entries.length);
    assert.equal(compacted._compacted, 'identifiers-only');
    assert.deepEqual(compacted.entries, listing.entries.slice(0, compacted._returned));
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0]!.body.toString()), input === undefined ? {} : { path: input });
  });
}

test('even a single oversized directory entry retains location and a truthful zero-entry count', async () => {
  listing = { path: '/', parent: null, entries: [{ name: 'x'.repeat(CHARACTER_LIMIT), isDir: true }] };
  const reply = Reply.parse(await client.callTool({
    name: 'cockpit_list_dir', arguments: { path: '/', response_format: 'json' },
  }));
  assert.equal(reply.isError, undefined);
  assert.deepEqual(JSON.parse(reply.content[0].text), {
    path: '/', parent: null, entries: [], count: 1, _returned: 0, _compacted: 'identifiers-only',
  });
  assert.equal(requests.length, 1);
});
