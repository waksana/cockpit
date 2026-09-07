// Unit tests for the global MCP config reader + server describer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGlobalMcpServers, describeMcpServer, normalizeMcpServersForSdk } from './mcp-config.ts';

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-'));
  const f = join(dir, 'mcp-config.json');
  writeFileSync(f, contents);
  return f;
}

test('reads the mcpServers record', () => {
  const f = tmpFile(JSON.stringify({ mcpServers: { chrome: { command: 'wrapper.sh' }, fs: { command: 'npx', args: ['srv'] } } }));
  const r = readGlobalMcpServers(f);
  assert.deepEqual(Object.keys(r).sort(), ['chrome', 'fs']);
  rmSync(f, { force: true });
});

test('missing file → {} (no throw)', () => {
  assert.deepEqual(readGlobalMcpServers('/nonexistent/does/not/exist.json'), {});
});

test('malformed JSON → {} (no throw)', () => {
  const f = tmpFile('{ this is not json ');
  assert.deepEqual(readGlobalMcpServers(f), {});
  rmSync(f, { force: true });
});

test('valid JSON without mcpServers key → {}', () => {
  const f = tmpFile(JSON.stringify({ somethingElse: 1 }));
  assert.deepEqual(readGlobalMcpServers(f), {});
  rmSync(f, { force: true });
});

test('describeMcpServer: url wins', () => {
  assert.equal(describeMcpServer({ url: 'https://x/mcp', command: 'ignored' }), 'https://x/mcp');
});

test('describeMcpServer: command + args joined', () => {
  assert.equal(describeMcpServer({ command: 'npx', args: ['@scope/srv', '/path'] }), 'npx @scope/srv /path');
});

test('describeMcpServer: command alone', () => {
  assert.equal(describeMcpServer({ command: 'wrapper.sh' }), 'wrapper.sh');
});

test('describeMcpServer: neither → "custom"', () => {
  assert.equal(describeMcpServer({}), 'custom');
});

test('describeMcpServer: non-string args ignored', () => {
  assert.equal(describeMcpServer({ command: 'x', args: ['a', 3, null, 'b'] as unknown[] }), 'x a b');
});

test('normalize: defaults tools to "*" and args to [] for command-only local server', () => {
  const r = normalizeMcpServersForSdk({ chrome: { command: 'wrapper.sh' } });
  assert.deepEqual(r.chrome, { command: 'wrapper.sh', tools: '*', args: [] });
});

test('normalize: keeps existing args and adds tools for local server', () => {
  const r = normalizeMcpServersForSdk({ fs: { command: 'node', args: ['srv.js'] } });
  assert.deepEqual(r.fs, { command: 'node', args: ['srv.js'], tools: '*' });
});

test('normalize: does not override an explicit tools list', () => {
  const r = normalizeMcpServersForSdk({ fs: { command: 'node', args: [], tools: ['a', 'b'] } });
  assert.deepEqual((r.fs as Record<string, unknown>).tools, ['a', 'b']);
});

test('normalize: remote (url) server gets tools but no args injected', () => {
  const r = normalizeMcpServersForSdk({ api: { type: 'http', url: 'https://x/mcp' } });
  assert.deepEqual(r.api, { type: 'http', url: 'https://x/mcp', tools: '*' });
});

test('normalize: does not mutate the input record', () => {
  const input = { chrome: { command: 'wrapper.sh' } };
  normalizeMcpServersForSdk(input);
  assert.deepEqual(input, { chrome: { command: 'wrapper.sh' } });
});
