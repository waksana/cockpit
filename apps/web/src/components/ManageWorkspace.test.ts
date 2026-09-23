import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SKILL_NOT_FOUND } from '@cockpit/protocol';
import { ManageWorkspace, SkillDetailContent } from './ManageWorkspace';
import { IntentHttpError } from '../net/client';
import { useCockpit } from '../net/store';
import App from '../App';

function renderWorkspace(t: TestContext, path: string, connected: boolean) {
  const state = useCockpit.getInitialState();
  const previous = { ...state };
  Object.assign(state, { connState: connected ? 'open' : 'connecting', sessions: [] });
  t.after(() => { Object.assign(state, previous); });
  return renderToStaticMarkup(createElement(MemoryRouter, {
    initialEntries: [path],
    children: createElement(Routes, {
      children: createElement(Route, { path: '/:section/:item?', element: createElement(ManageWorkspace) }),
    }),
  }));
}

for (const section of ['mcp', 'skills']) {
  for (const connected of [true, false]) {
    test(`global ${section} catalog is session-independent while ${connected ? 'connected' : 'offline'}`, (t) => {
      const html = renderWorkspace(t, `/${section}`, connected);
      assert.match(html, connected ? /加载中/ : /等待连接/);
      assert.doesNotMatch(html, /恢复会话|没有配置 MCP 服务器|没有可用的 skill/);
      if (section === 'mcp') {
        assert.match(html, /全局 MCP/);
        assert.doesNotMatch(html, /Copilot 全局配置|不改变已加载会话的连接/);
        assert.match(html, /aria-label="刷新 Copilot MCP 配置缓存"/);
      }
    });
  }
}

// The existing server renderer cannot run resource layout effects. Keep the
// loaded-detail control contract covered alongside transport and resource tests.
const source = readFileSync(new URL('./ManageWorkspace.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const shell = readFileSync(new URL('./ManagementShell.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');

for (const section of ['mcp', 'skills']) {
  test(`${section} list has one parent back control and no global hamburger`, (t) => {
    const html = renderWorkspace(t, `/${section}`, true);
    assert.equal(html.match(/aria-label="返回会话列表"/g)?.length, 1);
    assert.doesNotMatch(html, /aria-label="全局导航"|aria-haspopup="menu"/);
  });
}

for (const section of ['mcp', 'skills']) {
  test(`${section} lazy route fallback keeps separate exit and detail back controls`, () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, {
      initialEntries: [`/${section}/name%2Fpart`], children: createElement(App),
    }));
    assert.match(html, /加载页面/);
    assert.equal(html.match(/aria-label="返回会话列表"/g)?.length, 1);
    assert.equal(html.match(/aria-label="返回"/g)?.length, 1);
  });
}

test('narrow detail retains its separate hierarchical back control', () => {
  assert.match(shell, /className="chat-back ck-icon-button rp lg:hidden".*onClick=\{\(\) => up\(\)\}/);
  assert.doesNotMatch(shell, /\.focus\(|autoFocus|tabIndex/);
});

test('global skill toggles render only authoritative booleans and never assume unknown means enabled', () => {
  assert.match(source,
    /typeof enabled === 'boolean'/);
  assert.match(source, /Copilot 未提供全局启用状态/);
  assert.match(source,
    /<Toggle label=\{`全局默认启用 \$\{name\}`\} on=\{enabled\} busy=\{action.busy\} disabled=\{disabled \|\| !action.connected \|\| action.busy\}/);
  assert.doesNotMatch(source, /enabled\s*\?\?\s*true|localStorage|sessionStorage/);
});

test('both global toggles refresh authoritative detail and list after success or failure', () => {
  assert.match(source, /action.run\(\(\) => onChange\(name, next\)\)/);
  assert.match(source, /<McpList catalog=\{mcpCatalog\}/);
  assert.match(source, /<SkillsList catalog=\{skillCatalog\}/);
  assert.match(source, /<McpDetail catalog=\{mcpCatalog\} name=\{item\}/);
  assert.match(source, /<SkillDetail revision=\{refreshNonce\} name=\{item\}/);
  assert.match(source, /feedback=\{action.error && !action.busy && <ResourceError /);
});

test('MCP parent owns one route-independent catalog and disables it outside MCP', () => {
  const parent = source.slice(source.indexOf('function ManagementContent'));
  assert.equal(source.match(/useKeyedResource\('global:mcp'/g)?.length, 1);
  assert.match(parent, /useKeyedResource\('global:mcp', mcpGlobal, refreshNonce, section === 'mcp'\)/);
  assert.match(source, /<ManagementContent key=\{section\} section=\{section\} item=\{item\}/);
  for (const [start, end] of [['function McpList', 'function McpDetail'], ['function McpDetail', 'function SkillsList']]) {
    const consumer = source.slice(source.indexOf(start), source.indexOf(end));
    assert.doesNotMatch(consumer, /useKeyedResource|mcpGlobal|revision:|useState/);
    assert.match(consumer, /data: rows, status, failed.* = catalog/);
  }
});

test('MCP detail derives the route target from shared catalog and never owns a toggle', () => {
  const detail = source.slice(source.indexOf('function McpDetail'), source.indexOf('function SkillsList'));
  assert.match(detail, /data: rows, status, failed, pending \} = catalog/);
  assert.match(detail, /rows\?\.find\(server => server.name === name\)/);
  assert.match(detail, /if \(!row\) return status \? <ResourceStatus/);
  assert.match(detail, /未找到该 MCP 服务器/);
  assert.doesNotMatch(detail, /Toggle/);
  assert.match(detail, /<SectionHeading level=\{2\}>连接配置<\/SectionHeading>/);
  assert.match(source, /useKeyedAction\(`global:\$\{section\}:\$\{name\}`\)/);
});

test('global MCP refresh invalidates configuration cache without invoking session lifecycle', () => {
  assert.match(shell, /if \(section === 'mcp'\) await mcpRefresh\(\);/);
  assert.doesNotMatch(source + shell, /reloadSession|unloadSession|mcpToggleSession/);
  assert.match(source, /不改变已加载会话的连接/);
  assert.match(source, /用于新建或卸载后重新加载的会话，不改变当前已加载会话/);
  assert.doesNotMatch(source, /Cockpit 不保存偏好/);
});

test('management has no retired trash, restore or transcript consumers', () => {
  assert.doesNotMatch(source, /trash|restoreSession|SessionPreview|openPreview|refreshPreview/);
});

function renderSkill(t: TestContext, resource: Parameters<typeof SkillDetailContent>[0]['resource']) {
  const state = useCockpit.getInitialState();
  const previous = { ...state };
  Object.assign(state, { connState: 'open' });
  t.after(() => { Object.assign(state, previous); });
  return renderToStaticMarkup(createElement(SkillDetailContent, { resource }));
}

const skillFile = [
  '---', 'name: learn-by-doing', 'description: Learn a workflow once.', '---',
  '# Learn by Doing', '', 'Body.', '', '---', '', 'After rule.',
].join('\n');

test('skill detail shows the description once and never renders its frontmatter', t => {
  const html = renderSkill(t, { data: { name: 'learn-by-doing', description: 'Learn a workflow once.', source: 'personal',
    userInvocable: true, body: skillFile }, status: null, failed: false, pending: false, errorCause: undefined });
  assert.equal(html.match(/Learn a workflow once\./g)?.length, 1);
  assert.doesNotMatch(html, /name: learn-by-doing/);
  assert.match(html, /Learn by Doing/);
  assert.match(html, /After rule\./);
  assert.match(html, /<hr/);
  assert.ok(html.indexOf('manage-detail-line') < html.indexOf('manage-detail-body'));
  assert.match(html, /class="manage-detail-column"/);
});

test('skill detail with only frontmatter reports the missing body truthfully', t => {
  const html = renderSkill(t, { data: { name: 'x', description: 'd', body: '---\nname: x\n---\n' },
    status: null, failed: false, pending: false, errorCause: undefined });
  assert.match(html, /SKILL.md 没有正文/);
  assert.doesNotMatch(html, /name: x/);
});

test('structured not-found skill read is an in-place empty state, not a load failure', t => {
  const cause = new IntentHttpError('Unknown skill in this working directory', 404, SKILL_NOT_FOUND);
  const html = renderSkill(t, { data: undefined, status: `加载失败：${cause.message}`, failed: true, pending: false, errorCause: cause });
  assert.match(html, /未找到该 Skill。/);
  assert.doesNotMatch(html, /加载失败/);
});

for (const cause of [new IntentHttpError('native boom', 500), new IntentHttpError('gone', 404, 'OTHER'), new TypeError('Failed to fetch')]) {
  test(`genuine skill read failure stays visible (${cause.message})`, t => {
    const html = renderSkill(t, { data: undefined, status: `加载失败：${cause.message}`, failed: true, pending: false, errorCause: cause });
    assert.match(html, new RegExp(`加载失败：${cause.message}`));
    assert.doesNotMatch(html, /未找到该 Skill/);
  });
}

test('structured not-found after an earlier successful read replaces the retained detail', t => {
  const cause = new IntentHttpError('Unknown skill in this working directory', 404, SKILL_NOT_FOUND);
  const html = renderSkill(t, { data: { name: 'gone', description: 'old', body: '# Old body' },
    status: `加载失败：${cause.message}`, failed: true, pending: false, errorCause: cause });
  assert.match(html, /未找到该 Skill。/);
  assert.doesNotMatch(html, /Old body|加载失败/);
});
