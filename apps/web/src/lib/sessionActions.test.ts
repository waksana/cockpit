import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../components/Icon';
import type { SessionMeta } from '../net/types';
import { sessionActionItems, type SessionActionHandlers } from './sessionActions';

function session(sessionId: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId, title: sessionId, cwd: '/work', lastActivity: 1,
    status: 'idle', loaded: true, error: null, queue: [], ask: null, ...patch,
  };
}

test('sidebar and chat catalogs have one stable order and bind every action to the supplied session', () => {
  const calls: unknown[][] = [];
  const handlers: SessionActionHandlers = {
    openPanel: (...args) => calls.push(args),
    reload: (...args) => calls.push(['reload', ...args]),
    delete: (...args) => calls.push(args),
  };
  const items = sessionActionItems(session('B'), true, handlers);
  assert.deepEqual(items.map((item) => item.label), [
    '会话设置', '本会话 MCP', '本会话 Skills', '重新加载会话', '永久删除会话',
  ]);
  for (const item of items) item.onClick();
  assert.deepEqual(calls, [
    ['B', 'info'], ['B', 'mcp'], ['B', 'skills'], ['reload', 'B'], ['B'],
  ]);
  assert.deepEqual(items.flatMap((item, index) => item.separatorBefore ? [index] : []), [4]);
  assert.equal(items[3].icon, 'reload');
});

test('offline catalogs keep navigation available and disable all mutations', () => {
  const items = sessionActionItems(session('B'), false, {
    openPanel() {}, reload() {}, delete() {},
  });
  assert.ok(items.slice(0, 3).every((item) => !item.disabled));
  assert.equal(items[3].disabled, true);
  assert.equal(items[4].disabled, true);
  assert.equal(items[4].label, '永久删除会话');
  assert.equal(items[4].destructive, true);
});

test('every session action has a mapped glyph and keeps its identity across live labels and disabled states', () => {
  const handlers: SessionActionHandlers = {
    openPanel() {}, reload() {}, delete() {},
  };
  const initial = sessionActionItems(session('A'), true, handlers);
  const updated = sessionActionItems(session('A', { status: 'running' }), false, handlers);
  assert.equal(new Set(initial.map(item => item.id)).size, 5);
  assert.ok(initial.every(item => item.id && item.icon));
  assert.deepEqual(initial.map(item => item.id), updated.map(item => item.id));
  for (const item of [...initial, ...updated]) {
    const html = renderToStaticMarkup(createElement(Icon, { name: item.icon! }));
    assert.ok(html.includes(`data-icon="${item.icon}"`), `${item.label} must use a mapped icon`);
    assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/);
  }
  assert.notEqual(initial[3].disabled, updated[3].disabled);
});

test('native activity cannot bring removed session actions back into the menu', () => {
  for (const patch of [{ loaded: false }, { status: 'running' as const }, { scheduleCount: 1 }, { activeSubagents: 1 },
    { queue: [{ id: 'q', text: 'old task' }] }, { nativeProcessing: true },
    { loading: true }, { closing: true }, { cancelling: true }, { compacting: true },
    { ask: { requestId: 'ask', question: 'Choose', choices: ['yes'], allowFreeform: true } },
    { planRequest: { requestId: 'plan', summary: 'Plan', actions: ['interactive'] } },
    { elicitation: { requestId: 'elicit', message: 'Choose' } },
  ] satisfies Partial<SessionMeta>[]) {
    const items = sessionActionItems(session('A', patch), true, {
      openPanel() {}, reload() {}, delete() {},
    });
    assert.deepEqual(items.map(item => item.id), ['info', 'mcp', 'skills', 'reload', 'delete']);
    assert.equal(items[3].disabled, !('loaded' in patch || 'scheduleCount' in patch));
  }
});

test('naming and pin actions are absent from every shared catalog', () => {
  const handlers: SessionActionHandlers = {
    openPanel() {}, reload() {}, delete() {},
  };
  for (const connected of [true, false]) {
    const items = sessionActionItems(session('A'), connected, handlers);
    assert.ok(items.every(item => item.id !== 'rename' && item.id !== 'auto-name' && item.id !== 'pin'));
    assert.ok(items.every(item => !/重命名|自动命名|生成名称|置顶/.test(item.label)));
  }
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /getMenuItems=\{getSessionMenuItems\}/);
  assert.match(app, /items=\{getSessionMenuItems\(active\)\}/);
  assert.doesNotMatch(app, /AutoNameDialog|autoNameTarget|doRename|renameSession|autoNameSession|forkSession/);
});

test('pending reload keeps its identity and native disabled semantics', () => {
  const items = sessionActionItems(session('A'), true, {
    openPanel() {}, reload() {}, delete() {},
  }, true);
  assert.equal(items[3].id, 'reload');
  assert.equal(items[3].icon, 'reload');
  assert.equal(items[3].disabled, true);
  assert.equal(items[3].label, '正在重新加载会话…');
});
