import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { GlobalMcpDetail, ResourceList, SkillContent } from './ResourceContent';

const noMutation = async () => assert.fail('Static resource rendering may not mutate defaults');
test('global skill controls only render an authoritative boolean', () => {
  for (const enabled of [undefined, true, false]) {
    const html = renderToStaticMarkup(createElement(SkillContent, {
      data: { name: 'synthetic', description: 'Native skill', body: '', enabled }, valid: true, onChange: noMutation,
    }));
    if (enabled === undefined) {
      assert.match(html, /Copilot 未提供全局启用状态/);
      assert.doesNotMatch(html, /role="switch"/);
    } else {
      assert.match(html, /role="switch"/);
      assert.match(html, new RegExp(`aria-checked="${enabled}"`));
    }
    assert.match(html, /不改变当前已加载会话/);
  }
});
test('skill body uses safe production markdown rather than raw HTML', () => {
  const html = renderToStaticMarkup(createElement(SkillContent, {
    data: { name: 'safe', body: '**Native skill**\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))' },
    valid: false, onChange: noMutation,
  }));
  assert.match(html, /<strong>Native skill<\/strong>/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
});
test('resource links encode native identities and respect the next basename', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, {
    basename: '/next', initialEntries: ['/next/mcp'],
    children: createElement(ResourceList, { section: 'mcp', selected: null,
      rows: [{ name: 'native/name #1', detail: 'Native configuration', defaultOn: false }], status: null, failed: false }),
  }));
  assert.match(html, /href="\/next\/mcp\/native%2Fname%20%231"/);
  assert.doesNotMatch(html, /<button/);
});
test('MCP detail uses the accepted shared catalog and blocks stale defaults after failure', () => {
  const html = renderToStaticMarkup(createElement(GlobalMcpDetail, {
    name: 'native', onChange: noMutation, catalog: {
      data: [{ name: 'native', detail: 'Configuration', defaultOn: true, config: { command: 'native-command' } }],
      error: 'read failed', errorCause: undefined, status: '加载失败：read failed', failed: true, pending: false,
      connected: true, usable: false, valid: false, refresh: async () => false,
    },
  }));
  assert.match(html, /read failed/);
  assert.match(html, /当前状态未确认/);
  assert.match(html, /role="switch"[^>]*disabled=""/);
  assert.match(html, /native-command/);
  assert.match(html, /不改变已加载会话的连接/);
});
