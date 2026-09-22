import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionMeta } from '@cockpit/protocol';
import { Sidebar } from '../components/Sidebar';
import { ModuleRuntimeProvider } from '../components/ModuleComponents';
import { createSidebarModuleFixture, sidebarSessions } from './sidebar-fixtures';

test('classic sidebar preserves full identity, independent roles, activity and module unread without avatars', async t => {
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
  assert.equal((html.match(/class="dialog-roles session-role-badges"/g) ?? []).length, 2);
  assert.equal((html.match(/class="role-badge"/g) ?? []).length, 3);
  assert.match(html, /active[^"]*"[^>]*aria-current="true"/);
  assert.match(html, /is-unloaded/);
  for (const session of sessions) {
    assert.ok(html.includes(`<span class="session-row-title">${session.title}</span>`));
    assert.ok(html.includes(`data-sidebar-unread="${session.sessionId}"`));
  }
  for (const state of ['decision', 'shell', 'agent']) assert.ok(html.includes(`data-activity="${state}"`));
  assert.match(html, /data-icon="error"/);
  assert.match(html, /已应用/);
  assert.match(html, /未应用/);
  assert.match(html, /不代表当前能力就绪/);
  assert.doesNotMatch(html, /\/workspace\//);
});
