import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
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
    fork: (...args) => calls.push(args),
    pin: (...args) => calls.push(args),
    trash: (...args) => calls.push(args),
  };
  const items = sessionActionItems(session('B'), true, handlers);
  assert.deepEqual(items.map((item) => item.label), [
    '会话设置', '本会话 MCP', '本会话 Skills', '计划与任务', '上下文资料', '定时任务', '运行维护',
    '分叉为独立会话', '置顶', '移入垃圾桶',
  ]);
  for (const item of items) item.onClick();
  assert.deepEqual(calls, [
    ['B', 'info'], ['B', 'mcp'], ['B', 'skills'], ['B', 'plan'], ['B', 'context'], ['B', 'schedules'], ['B', 'runtime'],
    ['B'], ['B', true], ['B'],
  ]);
  assert.deepEqual(items.flatMap((item, index) => item.separatorBefore ? [index] : []), [3, 7, 9]);
});

test('offline catalogs keep navigation available and disable all mutations', () => {
  const items = sessionActionItems(session('B', { pinned: true }), false, {
    openPanel() {}, fork() {}, pin() {}, trash() {},
  });
  assert.ok(items.slice(0, 7).every((item) => !item.disabled));
  assert.ok(items.slice(7).every((item) => item.disabled));
  assert.equal(items[8].label, '取消置顶');
  assert.equal(items[9].destructive, true);
});

test('every session action has a mapped glyph and keeps its identity across live labels and disabled states', () => {
  const handlers: SessionActionHandlers = {
    openPanel() {}, fork() {}, pin() {}, trash() {},
  };
  const initial = sessionActionItems(session('A'), true, handlers);
  const updated = sessionActionItems(session('A', { pinned: true, autoNaming: true }), false, handlers);
  assert.equal(new Set(initial.map(item => item.id)).size, 10);
  assert.ok(initial.every(item => item.id && item.icon));
  assert.deepEqual(initial.map(item => item.id), updated.map(item => item.id));
  const css = readFileSync(new URL('../styles/tgico.scss', import.meta.url), 'utf8');
  for (const item of [...initial, ...updated]) {
    assert.ok(css.includes(`[data-icon='${item.icon}']::before`), `${item.label} must use a mapped glyph`);
  }
  assert.notEqual(initial[8].label, updated[8].label);
});

test('fork action requires a loaded idle source without queued work or timers', () => {
  for (const patch of [{ loaded: false }, { status: 'running' as const }, { scheduleCount: 1 }, { activeSubagents: 1 },
    { queue: [{ id: 'q', text: 'old task' }] }, { autoNaming: true }, { nativeProcessing: true },
    { loading: true }, { closing: true }, { cancelling: true }, { compacting: true },
    { ask: { requestId: 'ask', question: 'Choose', choices: ['yes'], allowFreeform: true } },
    { planRequest: { requestId: 'plan', summary: 'Plan', actions: ['interactive'] } },
    { elicitation: { requestId: 'elicit', message: 'Choose' } },
  ] satisfies Partial<SessionMeta>[]) {
    const items = sessionActionItems(session('A', patch), true, {
      openPanel() {}, fork() {}, pin() {}, trash() {},
    });
    assert.equal(items.find(item => item.id === 'fork')!.disabled, true);
  }
});

test('naming actions are absent from every shared catalog, including while automatic naming runs', () => {
  const handlers: SessionActionHandlers = {
    openPanel() {}, fork() {}, pin() {}, trash() {},
  };
  for (const connected of [true, false]) {
    for (const autoNaming of [true, false]) {
      const items = sessionActionItems(session('A', { autoNaming }), connected, handlers);
      assert.ok(items.every(item => item.id !== 'rename' && item.id !== 'auto-name'));
      assert.ok(items.every(item => !/重命名|自动命名|生成名称/.test(item.label)));
    }
  }
  assert.equal(sessionActionItems(session('A'), true, handlers).find(item => item.id === 'fork')!.disabled, false);
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /getMenuItems=\{getSessionMenuItems\}/);
  assert.match(app, /items=\{getSessionMenuItems\(active\)\}/);
  assert.doesNotMatch(app, /AutoNameDialog|autoNameTarget|doRename|renameSession|autoNameSession/);
});
