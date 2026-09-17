import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import type { ChatSession } from '../net/types';
import { Sidebar } from '../components/Sidebar';
import { filterSessions } from './session-list';

function session(sessionId: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId, title: `Session ${sessionId}`, cwd: '/work/project', lastActivity: 100,
    status: 'idle', error: null, loaded: true, queue: [], ask: null,
    messages: [], materialized: false, historyStale: true, hasMore: false, loadingHistory: false,
    ...overrides,
  };
}
const ids = (sessions: readonly ChatSession[]) => sessions.map(value => value.sessionId);

test('all native sessions appear by activity regardless of old worker or pin metadata', () => {
  const sessions = [
    { ...session('older', { lastActivity: 100 }), pinned: true, spawnedBy: 'old-flow' },
    session('recent', { lastActivity: 900 }),
    { ...session('unloaded', { lastActivity: 200, loaded: false, status: 'unloaded' }), spawnedBy: 'old-flow' },
  ];
  assert.deepEqual(ids(filterSessions(sessions, '')), ['recent', 'unloaded', 'older']);
});

test('sorting retains input order for tied activity and never mutates native rows', () => {
  const sessions = Object.freeze([
    Object.freeze(session('old', { lastActivity: 0 })),
    Object.freeze(session('tie-first', { lastActivity: 500 })),
    Object.freeze(session('new', { lastActivity: 900 })),
    Object.freeze(session('tie-second', { lastActivity: 500 })),
  ]);
  const before = JSON.stringify(sessions);
  const result = filterSessions(sessions, '');
  assert.deepEqual(ids(result), ['new', 'tie-first', 'tie-second', 'old']);
  assert.equal(result[0], sessions[2]);
  result.reverse();
  assert.equal(JSON.stringify(sessions), before);
});

test('search matches native title, directory and ID case-insensitively', () => {
  const sessions = [
    session('title', { title: 'Deploy Production' }),
    session('path', { cwd: '/WORK/Production/service', loaded: false }),
    session('PRODUCTION-id', { title: 'Result' }),
    session('other'),
  ];
  assert.deepEqual(ids(filterSessions(sessions, ' pRoDuCtIoN ')), ['title', 'path', 'PRODUCTION-id']);
  assert.deepEqual(ids(filterSessions(sessions, '/work/production')), ['path']);
  assert.deepEqual(ids(filterSessions(sessions, 'duction-id')), ['PRODUCTION-id']);
  assert.deepEqual(filterSessions(sessions, 'missing'), []);
  assert.deepEqual(filterSessions([], ''), []);
});

test('search and rendering never read retired business fields', () => {
  const historical = {
    ...session('ordinary'),
    get spawnedBy(): never { throw new Error('Do not read retired worker metadata'); },
    get pinned(): never { throw new Error('Do not read retired pin metadata'); },
    get attention(): never { throw new Error('Do not read retired inbox metadata'); },
  };
  assert.equal(filterSessions([historical], 'ordinary')[0], historical);
  const html = render([historical]);
  assert.match(html, /Session ordinary/);
  assert.doesNotMatch(html, /dialog-pinned|dialog-unread|chatlist-group-title/);
});

const noAction = () => { throw new Error('Rendering must not dispatch native actions'); };
function render(sessions: ChatSession[], overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  return renderToStaticMarkup(createElement(Sidebar, {
    sessions, activeId: null, query: '', snapshotReady: true, connected: true, onSelect: noAction, getMenuItems: () => [], ...overrides,
  }));
}
const titles = (html: string) => [...html.matchAll(/<span class="dialog-title">([^<]*)<\/span>/g)].map(match => match[1]);

test('sidebar is a single list and keeps unloaded rows focusable and selectable', () => {
  const rows = [
    session('older', { lastActivity: 0 }),
    session('unloaded', { loaded: false, status: 'unloaded', lastActivity: 500 }),
  ];
  const html = render(rows, { activeId: 'unloaded' });
  assert.deepEqual(titles(html), ['Session unloaded', 'Session older']);
  assert.match(html, /<li><button type="button" class="chatlist-chat ck-button active is-unloaded" data-session-id="unloaded" tabindex="0" aria-current="true" aria-haspopup="menu"/);
  assert.doesNotMatch(html, /<li[^>]*role="button"/);
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /chatlist-group-title|dialog-pinned|dialog-unread/);
});

test('running state and pending decisions remain without schedule indicators or an inbox', () => {
  const html = render([
    session('scheduled', { scheduleCount: 2 }),
    session('running', { status: 'running' }),
    session('ask', { ask: { requestId: 'a', question: 'Choose' } }),
    session('plan', { planRequest: { requestId: 'p', summary: 'Plan' } }),
    session('elicit', { elicitation: { requestId: 'e', message: 'Confirm' } }),
  ]);
  assert.doesNotMatch(html, /dialog-schedule|定时任务/);
  assert.match(html, /data-tone="running">回复中/);
  assert.equal((html.match(/aria-label="需要选择"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /未读|已读|dialog-unread|dialog-pinned/);
});

test('sidebar preserves its basic grid, native cwd label and empty-state distinction', () => {
  const html = render([session('cwd', { cwd: '/work/项目/' })]);
  assert.match(html, /<span class="dialog-avatar" style="--chip-h:\d+" aria-hidden="true">项<\/span><span class="dialog-title">Session cwd<\/span>/);
  assert.match(html, /<span class="dialog-subtitle">项目<\/span><span class="dialog-meta"><\/span>/);
  assert.match(render([]), /服务器上没有 session/);
  assert.match(render([session('one')], { query: 'missing' }), /没有匹配的会话/);
});

test('session rows own their spacing rather than inheriting the shared button gap', () => {
  const css = compile(new URL('../styles/components/sidebar.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chatlist-chat \{[^}]*column-gap: 0\.6rem;/);
  assert.match(css, /\.chatlist-chat \{[^}]*row-gap: 0;/);
  assert.match(css, /\.chatlist-chat \{[^}]*min-height: 4\.25rem;/);
  assert.match(css, /\.chatlist-chat \.dialog-subtitle \{[^}]*margin-top: 0\.1rem;/);
});

test('an empty list is not authoritative before the first connection snapshot', () => {
  for (const connected of [true, false]) {
    const html = render([], { snapshotReady: false, connected });
    assert.match(html, /aria-busy="true"/);
    assert.match(html, connected ? /正在同步会话/ : /等待连接/);
    assert.doesNotMatch(html, /服务器上没有 session|没有匹配的会话/);
  }
  const reconnect = render([session('retained')], { snapshotReady: false, connected: false });
  assert.match(reconnect, /Session retained/);
  assert.doesNotMatch(reconnect, /服务器上没有 session/);
});
