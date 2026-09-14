import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';

const requests: ReceivedRequest[] = [];
let responseText = '';
mockHttp((response, request) => {
  requests.push(request);
  response.writeHead(503, { 'content-type': 'application/json' }).end(responseText);
});
const { registerFoundationTools } = await import('./foundation.ts');
const { CHARACTER_LIMIT } = await import('../config.ts');
const { MAX_ERROR_BYTES } = await import('../cockpit.ts');
const server = new McpServer({ name: 'foundation-errors-test', version: '1' });
const client = new Client({ name: 'foundation-errors-client', version: '1' });
registerFoundationTools(server);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
after(async () => { await client.close(); await server.close(); });
beforeEach(() => { requests.length = 0; });

const Reply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
  isError: z.boolean().optional(),
});
const tools = [
  { name: 'cockpit_service_status', arguments: { operation: 'status' }, method: 'GET', path: '/status' },
  { name: 'cockpit_call_intent', arguments: { name: 'system/status', body: {} }, method: 'POST', path: '/intent/system/status' },
] as const;
async function failedCall(tool: typeof tools[number]) {
  const reply = Reply.parse(await client.callTool(tool));
  assert.equal(reply.isError, true);
  const text = reply.content[0].text;
  assert.ok(text.length <= CHARACTER_LIMIT);
  assert.match(text, /HTTP 503: /);
  return JSON.parse(text.split('HTTP 503: ')[1]!);
}

for (const phase of ['closing', 'failed'] as const) {
  for (const tool of tools) {
    test(`${tool.name} retains complete ${phase} shutdown failure in one request`, async () => {
      const body = {
        error: 'Cockpit is closing', code: 'SERVICE_CLOSING',
        shutdown: { phase, requestedAt: 1770000000123, error: phase === 'failed' ? 'native close rejected' : null },
        cause: { code: 'NATIVE_CLOSE', message: 'Original native cause' },
      };
      responseText = JSON.stringify(body);
      assert.deepEqual(await failedCall(tool), body);
      assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [{ url: tool.path, method: tool.method }]);
      assert.equal(requests[0]!.body.toString(), tool.method === 'POST' ? '{}' : '');
    });
  }
}

for (const tool of tools) {
  test(`${tool.name} compacts oversized structured error text without hiding shutdown metadata`, async () => {
    const body = {
      diagnostics: 'line\n"quoted" '.repeat(2200),
      error: 'Cockpit is closing', code: 'SERVICE_CLOSING',
      shutdown: { phase: 'failed', requestedAt: 1770000000123, error: 'native close rejected' },
    };
    responseText = JSON.stringify(body);
    assert.ok(responseText.length > CHARACTER_LIMIT && Buffer.byteLength(responseText) < MAX_ERROR_BYTES);
    const compacted = await failedCall(tool);
    assert.equal(compacted._truncated, true);
    assert.equal(compacted._fullLength, responseText.length);
    assert.equal(compacted.body.code, body.code);
    assert.equal(compacted.body.error, body.error);
    assert.deepEqual(compacted.body.shutdown, body.shutdown);
    assert.match(compacted.body.diagnostics, /truncated \d+ chars/);
    assert.equal(requests.length, 1);
  });

  test(`${tool.name} keeps non-JSON errors safely visible and marks byte overflow`, async () => {
    responseText = '<html>failed\nwith "quotes" and \\backslashes</html>';
    assert.equal(await failedCall(tool), responseText);
    responseText = 'x'.repeat(MAX_ERROR_BYTES + 1);
    const overflow = await failedCall(tool);
    assert.equal(overflow._truncated, true);
    assert.match(overflow.error, /byte limit/);
    assert.equal(requests.length, 2);
  });

  test(`${tool.name} marks omitted array details without dropping shutdown failure fields`, async () => {
    const shutdown = { phase: 'failed', requestedAt: 1770000000123, error: 'Native close failed' };
    responseText = JSON.stringify({
      details: Array.from({ length: 900 }, (_, index) => ({ index, message: 'Original error detail' })),
      code: 'SERVICE_CLOSING', shutdown,
    });
    assert.ok(responseText.length > CHARACTER_LIMIT && Buffer.byteLength(responseText) < MAX_ERROR_BYTES);
    const compacted = await failedCall(tool);
    assert.equal(compacted._truncated, true);
    assert.equal(compacted.body.code, 'SERVICE_CLOSING');
    assert.deepEqual(compacted.body.shutdown, shutdown);
    assert.equal(compacted.body.details._truncated, true);
    assert.equal(compacted.body.details._total, 900);
    assert.equal(compacted.body.details._returned, compacted.body.details.items.length);
    assert.equal(requests.length, 1);
  });
}
