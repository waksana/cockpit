import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMcpServer, mcpConnection, redactMcpConfig } from './mcp-config.ts';

test('native MCP connection summaries use config transport and only short safe targets', () => {
  for (const [config, connection] of [
    [{ type: 'http', url: 'https://example.invalid:8443/long/path' }, { method: 'http', target: 'example.invalid' }],
    [{ url: 'http://localhost:9999/mcp' }, { method: 'http', target: 'localhost' }],
    [{ type: 'sse', url: 'https://events.invalid/sse' }, { method: 'sse', target: 'events.invalid' }],
    [{ type: 'stdio', command: '/opt/tools/bin/native-server' }, { method: 'stdio', target: 'native-server' }],
    [{ type: 'local', command: 'C:\\tools\\native.exe' }, { method: 'stdio', target: 'native.exe' }],
    [{ command: 'npx', args: ['--yes', '@scope/server'] }, { method: 'stdio', target: 'npx' }],
    [{ type: 'custom', url: 'https://example.invalid' }, { method: 'unknown' }],
    [{ type: 'future', command: 'node' }, { method: 'unknown' }],
    [{ type: 'builtin', command: 'node' }, { method: 'unknown' }],
    [{ type: null, url: 'https://example.invalid' }, { method: 'unknown' }],
    [{}, { method: 'unknown' }],
    [{ command: 'node', url: 'https://ambiguous.invalid' }, { method: 'unknown' }],
    [{ type: 'http', url: 'not a url' }, { method: 'http' }],
    [{ type: 'sse', url: 'file:///private/token' }, { method: 'sse' }],
    [{ type: 'stdio', command: 'node --token=private-token' }, { method: 'stdio' }],
    [{ command: 'node --token=/private/fixture-secret' }, { method: 'stdio' }],
    [{ command: 'node /private/server.js' }, { method: 'stdio' }],
    [{ command: 'node;/private/server.js' }, { method: 'stdio' }],
    [{ command: '/directory with spaces/server' }, { method: 'stdio' }],
  ] as const) {
    assert.deepEqual(mcpConnection(config), connection);
  }
});

test('connection summaries exclude credentials, URL tails and arbitrarily long command arguments', () => {
  const configs = [
    { url: 'https://fixture-user:fixture-password@example.invalid/mcp?token=fixture-token#fixture-fragment' },
    { type: 'sse', url: 'http://fixture-user:fixture-password@events.invalid:8443/private/path?key=fixture-key' },
    { command: '/private/tools/node', args: ['--token', 'fixture-secret', 'x'.repeat(20_000)] },
  ];
  const before = structuredClone(configs);
  assert.deepEqual(configs.map(mcpConnection), [
    { method: 'http', target: 'example.invalid' },
    { method: 'sse', target: 'events.invalid' },
    { method: 'stdio', target: 'node' },
  ]);
  assert.deepEqual(configs, before);
});

test('native MCP display describes transports without parsing or normalizing config', () => {
  assert.equal(describeMcpServer({ url: 'https://x/mcp', command: 'ignored' }), 'https://x/mcp');
  assert.equal(describeMcpServer({ command: 'npx', args: ['@scope/srv', '/path'] }), 'npx @scope/srv /path');
  assert.equal(describeMcpServer({ command: 'wrapper.sh' }), 'wrapper.sh');
  assert.equal(describeMcpServer({}), 'custom');
});

test('native MCP display consistently redacts credentials without changing definitions', () => {
  const config = {
    url: 'https://fixture-user:fixture-password@example.invalid/mcp?token=fixture-token&custom=fixture-query#fixture-fragment',
    env: { TOKEN: 'fixture-env' }, headers: { Authorization: 'fixture-header' },
    oauth: { clientSecret: 'fixture-secret', token: 'fixture-oauth-token' },
    args: ['--api-key', 'fixture-key', '--token=fixture-arg-token', '--url=https://other:credential@example.invalid/x'],
  };
  const original = structuredClone(config);
  const redacted = redactMcpConfig(config);
  const result = JSON.stringify(redacted) + describeMcpServer(config);
  for (const value of [
    'fixture-user', 'fixture-password', 'fixture-token', 'fixture-query', 'fixture-fragment',
    'fixture-env', 'fixture-header', 'fixture-secret', 'fixture-oauth-token', 'fixture-key',
    'fixture-arg-token', 'other', 'credential@',
  ]) assert.ok(!result.includes(value), value);
  assert.deepEqual(redacted.env, { TOKEN: '••••••' });
  assert.deepEqual(redacted.headers, { Authorization: '••••••' });
  assert.ok(result.includes('example.invalid/mcp'));
  assert.deepEqual(config, original);
  assert.ok(!describeMcpServer({ command: 'node', args: config.args }).includes('fixture-key'));
});
