import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCall } from '@cockpit/protocol';
import { ToolCallRow } from './ToolCallRow';
import { DisclosureContext } from '../lib/disclosureChoice';
import { compile } from 'sass';

const tool: ToolCall = { toolCallId: 'tool', name: 'custom_tool', title: 'Native intent',
  args: '{"input":"exact"}', output: 'Exact output', status: 'completed' };
const render = (tc = tool, open = false) => renderToStaticMarkup(createElement(DisclosureContext.Provider, {
  value: { values: new Map([[JSON.stringify(['test', 'tool', tc.toolCallId]), open]]), set() {} },
  children: createElement(ToolCallRow, { tc, sessionId: 'test' }),
}));

test('tool identity and outcome have independent icons in one header without a collapsed detail preview', () => {
  const shapes = new Set<string>();
  for (const status of ['completed', 'failed', 'in_progress', 'pending', undefined] as const) {
    const html = render({ ...tool, status });
    assert.equal((html.match(/<button /g) ?? []).length, 1);
    assert.match(html, /custom_tool/);
    assert.match(html, /Native intent/);
    assert.doesNotMatch(html, /activity-status|activity-chevron|tool-detail|exact|Exact output/);
    assert.match(html, /data-icon="tool"/);
    assert.equal((html.match(/<svg /g) ?? []).length, 2);
    shapes.add(html.match(/class="ck-icon tool-state-icon"[^>]*>(<svg[\s\S]+?<\/svg>)/)![1]);
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

test('tool headers put semantic identity first, description and name next, and outcome last', () => {
  for (const open of [false, true]) {
    const header = render(tool, open).split('</button>')[0];
    assert.ok(header.indexOf('class="activity-icon"') < header.indexOf('class="tool-description"'));
    assert.ok(header.indexOf('class="tool-description"') < header.indexOf('class="tool-label"'));
    assert.ok(header.indexOf('class="tool-label"') < header.indexOf('class="ck-icon tool-state-icon"'));
    assert.doesNotMatch(header, /tool-heading-separator/);
  }
});

test('missing tool metadata remains explicit and a name-equivalent title is not repeated', () => {
  assert.match(render({ toolCallId: 'unknown', title: 'Missing start' }), /缺少工具名称/);
  assert.doesNotMatch(render({ ...tool, title: tool.name! }), /tool-description|tool-heading-separator/);
  assert.match(render({ toolCallId: 'empty', name: 'empty', title: 'empty' }, true), /暂无输入或输出记录/);
});

test('tool headers reserve separate grid cells for identity, content and outcome', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.tool-head \{[^}]*grid-template-columns: 1rem minmax\(0, 1fr\) 1rem;/);
  assert.match(css, /\.tool-state-icon > svg \{[^}]*display: block;/);
  for (const [selector, column] of [['activity-icon', 1], ['tool-heading-content', 2], ['tool-state-icon', 3]]) {
    assert.match(css, new RegExp(`\\.tool-head > \\.${selector} \\{[^}]*grid-area: 1\\s*/\\s*${column};`));
  }
});

test('builtins use action icons and keep the exact native name in expanded details', () => {
  const tc = { ...tool, name: 'functions.view', title: '读取组件源码' };
  const header = render(tc).split('</button>')[0];
  assert.match(header, /data-icon="read_file"/);
  assert.match(header, /读取组件源码/);
  assert.doesNotMatch(header, /class="tool-label"/);
  assert.match(render(tc, true), /class="tool-full-name">functions\.view/);
  const missingTitle = render({ ...tc, title: '' });
  assert.match(missingTitle, /读取文件/);
  const extension = render({ ...tc, name: 'third_party_view' });
  assert.match(extension, /data-icon="tool"/);
  assert.match(extension, /class="tool-label"/);
  assert.match(extension, /third_party_view/);
});

test('MCP rows tag the native server and move the complete tool identity into details', () => {
  const mcp: ToolCall = { toolCallId: 'mcp', name: 'cockpit-task-task_read', title: 'task_read',
    mcpServerName: 'cockpit-task', mcpToolName: 'task_read', status: 'completed' };
  const header = render(mcp).split('</button>')[0];
  assert.match(header, /class="tool-description"[^>]*>task_read</);
  assert.match(header, /class="tool-label" data-server=""[^>]*><bdi dir="ltr">cockpit-task<\/bdi>/);
  assert.doesNotMatch(header, />cockpit-task-task_read</);
  assert.match(header, /aria-label="展开细节：cockpit-task-task_read · task_read · 服务器 cockpit-task · 已完成"/);
  const detail = render(mcp, true).split('</button>')[1];
  assert.match(detail, /工具名<\/div><div class="tool-full-name">cockpit-task-task_read/);
  assert.match(detail, /MCP 工具名<\/div>\s*<div class="tool-full-name">task_read/);
  assert.match(detail, /MCP 服务器<\/div><div class="tool-full-name">cockpit-task</);

  // Human titles stay on the left; unprefixed github-mcp-server names are not repeated.
  const github: ToolCall = { toolCallId: 'gh', name: 'get_file_contents', title: 'Get file contents',
    mcpServerName: 'github-mcp-server', mcpToolName: 'get_file_contents', status: 'failed' };
  const ghHeader = render(github).split('</button>')[0];
  assert.match(ghHeader, /class="tool-description"[^>]*>Get file contents</);
  assert.match(ghHeader, /<bdi dir="ltr">github-mcp-server<\/bdi>/);
  assert.match(ghHeader, /aria-label="展开细节：get_file_contents · Get file contents · 服务器 github-mcp-server · 失败"/);
  const ghDetail = render(github, true).split('</button>')[1];
  assert.match(ghDetail, /class="tool-full-name">get_file_contents/);
  assert.doesNotMatch(ghDetail, /MCP 工具名/);
  assert.match(ghDetail, /MCP 服务器<\/div><div class="tool-full-name">github-mcp-server</);

  // A title equal to the full name still identifies the tool on the left once the server is the tag.
  const sameTitle = render({ ...github, title: 'get_file_contents', status: 'in_progress' }).split('</button>')[0];
  assert.match(sameTitle, /class="tool-description"[^>]*>get_file_contents</);
  assert.match(sameTitle, /<bdi dir="ltr">github-mcp-server<\/bdi>/);
});

test('tools without a native server name keep the truthful full-name tag', () => {
  for (const tc of [tool, { ...tool, mcpServerName: '' }]) {
    const header = render(tc).split('</button>')[0];
    assert.match(header, /class="tool-label"><bdi dir="ltr">custom_tool<\/bdi>/);
    assert.doesNotMatch(header, /data-server|服务器/);
  }
  const builtin = render({ ...tool, name: 'bash', title: 'list', mcpServerName: 'ignored' }).split('</button>')[0];
  assert.doesNotMatch(builtin, /tool-label|ignored/);
});

test('server tags read from their start instead of the full-name end truncation', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.tool-label \{[^}]*direction: rtl;/);
  assert.match(css, /\.tool-label\[data-server\] \{[^}]*direction: ltr;/);
});
