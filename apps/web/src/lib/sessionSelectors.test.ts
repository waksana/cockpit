import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCockpitStore } from '../net/store';
import type { ChatSession } from '../net/types';
import { Sidebar } from '../components/Sidebar';
import { createSessionMetadataSelector } from './sessionSelectors';

function session(sessionId: string): ChatSession {
  return {
    sessionId, title: sessionId, cwd: '/project', lastActivity: 1,
    status: 'idle', loaded: true, error: null, queue: [], ask: null,
    messages: [], materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
  };
}

test('metadata projection retains sidebar array and row identities across window updates', () => {
  const select = createSessionMetadataSelector();
  const a = session('a');
  const b = session('b');
  const rows = select({ sessions: [a, b] });
  const updated = {
    ...a,
    messages: [{ id: 'm', role: 'assistant' as const, content: 'stream', timestamp: 2 }],
    loadingHistory: true, historyStale: true, hasMore: true, partialHistory: true, incompleteBoundary: true,
  };
  assert.equal(select({ sessions: [updated, b] }), rows);
  assert.equal(select({ sessions: [{ ...updated, materialized: false }, b] }), rows);
  assert.ok(!('messages' in rows[0]));
  assert.ok(!('loadingHistory' in rows[0]));

  const changed = select({ sessions: [{ ...updated, title: 'renamed' }, b] });
  assert.notEqual(changed, rows);
  assert.notEqual(changed[0], rows[0]);
  assert.equal(changed[1], rows[1]);
  assert.equal(changed[0].title, 'renamed');
  assert.equal(select({ sessions: [b] })[0], rows[1]);
});

test('streaming store updates do not notify the metadata/sidebar render boundary', () => {
  const store = createCockpitStore();
  const select = createSessionMetadataSelector();
  store.setState({ sessions: [session('active'), session('other')] });
  let metadata = select(store.getState());
  let renderCount = 0;
  const render = () => {
    renderCount++;
    return renderToStaticMarkup(createElement(Sidebar, {
      sessions: metadata, activeId: 'active', query: '',
      onSelect() {}, getMenuItems: () => [],
    }));
  };
  const before = render();
  const unsubscribe = store.subscribe((state) => {
    const next = select(state);
    if (!Object.is(metadata, next)) { metadata = next; render(); }
  });
  try {
    for (let i = 1; i <= 50; i++) {
      store.setState((state) => ({
        sessions: state.sessions.map((s) => s.sessionId === 'active' ? {
          ...s, messages: [{ id: 'reply', role: 'assistant', content: `delta ${i}`, timestamp: 2 }],
        } : s),
      }));
    }
    assert.equal(renderCount, 1);
    assert.equal(store.getState().sessions[0].messages[0].content, 'delta 50');
    assert.equal(render(), before);
    store.setState((state) => ({
      sessions: state.sessions.map((s) => s.sessionId === 'active' ? { ...s, scheduleCount: 1 } : s),
    }));
    assert.equal(renderCount, 3);
    assert.match(render(), /dialog-schedule/);
  } finally { unsubscribe(); }
});
