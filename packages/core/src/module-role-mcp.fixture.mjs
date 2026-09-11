import { createInterface } from 'node:readline';

const version = process.argv[2];
if (!['v1', 'v2', 'global'].includes(version)) throw new Error('Synthetic MCP version required');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'module-fixture', version } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'module_version', description: 'Read the synthetic module version.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  } else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: `MCP_${version}` }] };
  } else if (request.method === 'ping') {
    result = {};
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'Unsupported synthetic method' } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
