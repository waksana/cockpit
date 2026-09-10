import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpServerStatus } from '@cockpit/protocol';
import { McpStatusPill } from './McpStatus';
import { mcpStatusOf } from '../net/mcp-status';

const expected = {
  connected: ['已连接', 'ok'],
  failed: ['失败', 'err'],
  'needs-auth': ['待授权', 'warn'],
  pending: ['连接中', 'pending'],
  disabled: ['已关闭', 'off'],
  stopped: ['已停止', 'off'],
  not_configured: ['未配置', 'warn'],
  unloaded: ['未加载', 'off'],
} satisfies Record<McpServerStatus, [string, string]>;

for (const status of McpServerStatus.options) {
  test(`MCP ${status} renders its own status label, tone and explanation`, () => {
    const [label, tone] = expected[status];
    const html = renderToStaticMarkup(createElement(McpStatusPill, { status }));
    assert.ok(html.includes(label));
    assert.ok(html.includes(`data-tone="${tone}"`));
    const hint = mcpStatusOf(status).hint;
    if (hint) assert.ok(html.includes(`title="${hint}"`));
  });
}

test('stopped explains policy restrictions and not_configured does not invent a broken config', () => {
  assert.match(mcpStatusOf('stopped').hint!, /策略允许.*受限策略隔离时不能重启/);
  assert.equal(mcpStatusOf('not_configured').hint, '本会话未配置此服务器');
  assert.equal(McpServerStatus.safeParse('needs_auth').success, false);
  assert.equal(McpServerStatus.safeParse('future-status').success, false);
});
