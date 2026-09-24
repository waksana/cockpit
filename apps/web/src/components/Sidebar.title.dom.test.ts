import { render, screen } from '../test/dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ChatSession } from '../net/types';
import { activityFixture } from '../dev/activity-fixtures';
import { Sidebar } from './Sidebar';

function session(sessionId: string, title: string, lastActivity: number): ChatSession {
  return {
    sessionId, title, cwd: '/work/project', lastActivity,
    status: 'idle', error: null, loaded: true, queue: [], ask: null, activity: activityFixture(),
    messages: [], materialized: false, historyStale: true, hasMore: false, loadingHistory: false,
  };
}

const sidebar = (sessions: ChatSession[]) => createElement(Sidebar, {
  sessions, activeId: null, query: '', snapshotReady: true, connected: true,
  onSelect() {}, getMenuItems: () => [],
});

test('short and long titles keep full text, hover and reading order', () => {
  const long = `前端改进 B：${'会话列表标题最多显示两行并保留完整名称 '.repeat(6)}`;
  const now = Date.now();
  const view = render(sidebar([session('short', 'Short', now), session('long', long, now - 3_600_000)]));
  for (const [id, title] of [['short', 'Short'], ['long', long]]) {
    const row = view.container.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
    const titleEl = row.querySelector<HTMLElement>('.session-row-title')!;
    const time = row.querySelector<HTMLElement>('.dialog-time')!;
    assert.equal(titleEl.textContent, title);
    assert.equal(titleEl.title, title);
    assert.ok(time.textContent);
    assert.deepEqual(Array.from(row.children, child => child.className),
      ['session-row-title', 'dialog-time', 'session-row-details']);
    assert.ok(screen.getByRole('button', { name: new RegExp(`^${title.trim().slice(0, 12)}`) }));
  }
});
