import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionMeta } from '@cockpit/protocol';
import { Sidebar } from '../components/Sidebar';
import { ModuleRuntimeProvider } from '../components/ModuleComponents';
import { createSidebarModuleFixture, sidebarSessions } from './sidebar-fixtures';
import { sessionRowOutline } from '../test/sessionRowOutline';

test('sidebar preserves full identity, independent roles, activity and module unread without avatars', async t => {
  const sessions = sidebarSessions(1_789_441_200_000);
  sessions.forEach(session => SessionMeta.parse(session));
  const runtime = createSidebarModuleFixture();
  await runtime.start();
  t.after(() => runtime.stop());
  const html = renderToStaticMarkup(createElement(ModuleRuntimeProvider, {
    runtime, children: createElement(Sidebar, {
      sessions, activeId: sessions[1].sessionId, query: '', snapshotReady: true, connected: true,
      onSelect() {}, getMenuItems: () => [],
    }),
  }));
  assert.doesNotMatch(html, /dialog-avatar|--chip-h/);
  assert.equal((html.match(/<button\b/g) ?? []).length, sessions.length);
  const rows = sessionRowOutline(html);
  assert.equal(rows.filter(row => row.roles.length).length, 4);
  assert.equal(rows.reduce((count, row) => count + row.roles.length, 0), 3 + 3 + 5);
  assert.match(html, /active[^"]*"[^>]*aria-current="true"/);
  assert.match(html, /is-unloaded/);
  for (const session of sessions) {
    const row = rows.find(value => value.id === session.sessionId)!;
    assert.deepEqual(row.lines, ['session-row-title', 'dialog-time', 'session-row-details']);
    assert.deepEqual(row.title, { text: session.title, hover: session.title });
    assert.deepEqual(row.directory, { text: session.cwd.split('/').filter(Boolean).at(-1), hover: session.cwd });
    assert.equal(row.unread, 1);
  }
  assert.deepEqual(rows.find(row => row.id === 'demo-extreme')!.status,
    ['overall', 'compaction', 'agent', 'shell', 'queue', 'mcp']);
  assert.deepEqual(rows.find(row => row.id === 'demo-plain')!.details, ['dialog-subtitle', 'dialog-meta']);
  for (const state of ['shell', 'agent']) assert.ok(html.includes(`data-activity="${state}"`));
  assert.ok(html.includes('data-icon="decision"'));
  assert.match(html, /data-icon="error"/);
  assert.match(html, /已应用/);
  assert.match(html, /未应用/);
  assert.match(html, /不代表当前能力就绪/);
});
