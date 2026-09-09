import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMcpServer, redactMcpConfig } from './mcp-config.ts';

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
