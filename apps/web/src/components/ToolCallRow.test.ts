import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCall } from '@cockpit/protocol';
import { ToolCallRow } from './ToolCallRow';
import { DisclosureContext } from '../lib/disclosureChoice';

const tool: ToolCall = { toolCallId: 'tool', name: 'custom_tool', title: 'Native intent',
  args: '{"input":"exact"}', output: 'Exact output', status: 'completed' };
const render = (tc = tool, open = false) => renderToStaticMarkup(createElement(DisclosureContext.Provider, {
  value: { values: new Map([[JSON.stringify(['test', 'tool', tc.toolCallId]), open]]), set() {} },
  children: createElement(ToolCallRow, { tc, sessionId: 'test' }),
}));

test('all tool states use only a status icon and one header with no collapsed detail preview', () => {
  const shapes = new Set<string>();
  for (const status of ['completed', 'failed', 'in_progress', 'pending', undefined] as const) {
    const html = render({ ...tool, status });
    assert.equal((html.match(/<button /g) ?? []).length, 1);
    assert.match(html, /custom_tool/);
    assert.match(html, /Native intent/);
    assert.doesNotMatch(html, /activity-status|activity-chevron|tool-detail|exact|Exact output/);
    shapes.add(html.match(/<svg[\s\S]+?<\/svg>/)![0].replace(/data-status="[^"]+"/, ''));
  }
  assert.equal(shapes.size, 5, 'unknown, pending and running must not share the same shape');
});

test('expanded tool details retain copyable inputs and outputs without repeating complete metadata', () => {
  const html = render(tool, true);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="复制工具输入"/);
  assert.match(html, /aria-label="复制工具输出"/);
  assert.match(html, /\{&quot;input&quot;:&quot;exact&quot;\}/);
  assert.match(html, /Exact output/);
  const detail = html.slice(html.indexOf('class="activity-detail tool-detail"'));
  assert.doesNotMatch(detail, /custom_tool|Native intent|已完成|工具名|说明/);
});

test('tool headers put status first, native description next and the name tag last', () => {
  for (const open of [false, true]) {
    const header = render(tool, open).split('</button>')[0];
    assert.ok(header.indexOf('class="activity-icon"') < header.indexOf('class="tool-description"'));
    assert.ok(header.indexOf('class="tool-description"') < header.indexOf('class="tool-label"'));
    assert.doesNotMatch(header, /tool-heading-separator/);
  }
});

test('missing tool metadata remains explicit and a name-equivalent title is not repeated', () => {
  assert.match(render({ toolCallId: 'unknown', title: 'Missing start' }), /缺少工具名称/);
  assert.doesNotMatch(render({ ...tool, title: tool.name! }), /tool-description|tool-heading-separator/);
  assert.match(render({ toolCallId: 'empty', name: 'empty', title: 'empty' }, true), /暂无输入或输出记录/);
});
