import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSession } from '../net/types';
import { Sidebar } from '../components/Sidebar';
import { groupSessions } from './session-list';

function session(sessionId: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    cwd: '/work/project',
    lastActivity: 100,
    status: 'idle',
    error: null,
    loaded: true,
    queue: [],
    ask: null,
    messages: [],
    materialized: false,
    historyStale: true,
    hasMore: false,
    loadingHistory: false,
    ...overrides,
  };
}

function ids(sessions: readonly ChatSession[]) {
  return sessions.map((s) => s.sessionId);
}

test('historical worker metadata never excludes loaded or unloaded sessions', () => {
  const sessions = [
    { ...session('worker', { lastActivity: 300 }), spawnedBy: 'historical-flow' },
    { ...session('unloaded-worker', { loaded: false, status: 'unloaded', lastActivity: 200 }), spawnedBy: 'deleted-flow' },
    session('ordinary', { lastActivity: 100 }),
    session('unloaded', { loaded: false, status: 'unloaded', lastActivity: 0 }),
  ];
  const { pinnedList, restList } = groupSessions(sessions, '');
  assert.deepEqual(pinnedList, []);
  assert.deepEqual(ids(restList), ['worker', 'unloaded-worker', 'ordinary', 'unloaded']);
});

test('pinned workers appear once alongside ordinary pins, regardless of loaded state', () => {
  const sessions = [
    session('recent', { lastActivity: 900 }),
    { ...session('pinned-worker', { pinned: true, lastActivity: 300 }), spawnedBy: 'old-flow' },
    session('pin', { pinned: true, lastActivity: 500 }),
    { ...session('unloaded-pin', { pinned: true, loaded: false, status: 'unloaded', lastActivity: 100 }), spawnedBy: 'old-flow' },
    session('old', { pinned: false, lastActivity: 0 }),
  ];
  const { pinnedList, restList } = groupSessions(sessions, '');
  assert.deepEqual(ids(pinnedList), ['pin', 'pinned-worker', 'unloaded-pin']);
  assert.deepEqual(ids(restList), ['recent', 'old']);
  assert.equal(new Set([...pinnedList, ...restList]).size, sessions.length);
});

test('both groups sort by descending activity and retain input order on ties', () => {
  const sessions = [
    session('old', { lastActivity: 0 }),
    session('pin-old', { pinned: true, lastActivity: 0 }),
    session('tie-first', { lastActivity: 500 }),
    session('pin-tie-first', { pinned: true, lastActivity: 300 }),
    session('new', { lastActivity: 900 }),
    session('tie-second', { lastActivity: 500 }),
    session('pin-tie-second', { pinned: true, lastActivity: 300 }),
  ];
  const { pinnedList, restList } = groupSessions(sessions, '');
  assert.deepEqual(ids(pinnedList), ['pin-tie-first', 'pin-tie-second', 'pin-old']);
  assert.deepEqual(ids(restList), ['new', 'tie-first', 'tie-second', 'old']);
});

test('search trims whitespace and matches title, full cwd and session ID case-insensitively', () => {
  const sessions = [
    session('title', { title: 'Deploy Production', pinned: true }),
    session('path', { cwd: '/WORK/Production/service', loaded: false }),
    { ...session('PRODUCTION-worker', { title: 'Historical result' }), spawnedBy: 'old-flow' },
    session('other'),
  ];
  const { pinnedList, restList } = groupSessions(sessions, '  pRoDuCtIoN  ');
  assert.deepEqual(ids(pinnedList), ['title']);
  assert.deepEqual(ids(restList), ['path', 'PRODUCTION-worker']);
  assert.deepEqual(ids(groupSessions(sessions, '/work/production').restList), ['path']);
  assert.deepEqual(ids(groupSessions(sessions, 'DUCTION-WOR').restList), ['PRODUCTION-worker']);
});

test('extra historical metadata is not searchable or consulted for grouping', () => {
  const historical = {
    ...session('worker'),
    get spawnedBy(): string { throw new Error('Historical metadata must not be read'); },
  };
  assert.equal(groupSessions([historical], '').restList[0], historical);
  assert.equal(groupSessions([historical], 'WORKER').restList[0], historical);
  assert.deepEqual(groupSessions([historical], 'historical-flow'), { pinnedList: [], restList: [] });
});

test('empty and whitespace queries keep every session; unmatched queries return empty groups', () => {
  const sessions = [session('one', { pinned: true }), session('two')];
  assert.deepEqual(groupSessions(sessions, ' \n\t '), groupSessions(sessions, ''));
  assert.deepEqual(groupSessions(sessions, 'missing'), { pinnedList: [], restList: [] });
  assert.deepEqual(groupSessions([], ''), { pinnedList: [], restList: [] });
  assert.deepEqual(groupSessions([], 'missing'), { pinnedList: [], restList: [] });
});

test('filtering and sorting never mutate the input array or session objects', () => {
  const sessions = Object.freeze([
    Object.freeze({ ...session('old', { lastActivity: 0 }), spawnedBy: 'old-flow' }),
    Object.freeze(session('pin', { pinned: true, lastActivity: 100 })),
    Object.freeze(session('new', { lastActivity: 200 })),
  ]);
  const before = JSON.stringify(sessions);
  const { pinnedList, restList } = groupSessions(sessions, '');
  assert.equal(JSON.stringify(sessions), before);
  assert.equal(pinnedList[0], sessions[1]);
  assert.equal(restList[0], sessions[2]);
  assert.equal(restList[1], sessions[0]);
  assert.notEqual(restList, sessions);
  pinnedList.pop();
  restList.reverse();
  groupSessions(sessions, 'old');
  assert.equal(JSON.stringify(sessions), before);
});

const noAction = () => { throw new Error('Rendering must not invoke session actions'); };

function render(sessions: ChatSession[], overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  return renderToStaticMarkup(createElement(Sidebar, {
    sessions,
    activeId: null,
    query: '',
    onSelect: noAction,
    getMenuItems: () => [],
    ...overrides,
  }));
}

function titles(html: string) {
  return [...html.matchAll(/<span class="dialog-title">([^<]*)<\/span>/g)].map((match) => match[1]);
}

test('sidebar does not read historical metadata when rendering or searching', () => {
  const historical = {
    ...session('worker'),
    get spawnedBy(): string { throw new Error('Historical metadata must not be read'); },
  };
  assert.deepEqual(titles(render([historical])), ['Session worker']);
  assert.deepEqual(titles(render([historical], { query: 'WORKER' })), ['Session worker']);
  assert.deepEqual(titles(render([historical], { query: 'historical-flow' })), []);
  historical.pinned = true;
  assert.deepEqual(titles(render([historical])), ['Session worker']);
});

test('sidebar renders every historical worker in its normal pinned or recent group', () => {
  const sessions = [
    { ...session('worker', { lastActivity: 500 }), spawnedBy: 'old-flow' },
    { ...session('unloaded-worker', { loaded: false, status: 'unloaded', lastActivity: 400 }), spawnedBy: 'old-flow' },
    { ...session('pinned-worker', { pinned: true, loaded: false, status: 'unloaded' }), spawnedBy: 'old-flow' },
    session('ordinary', { lastActivity: 0 }),
  ];
  const html = render(sessions, { activeId: 'unloaded-worker' });
  assert.deepEqual(titles(html), [
    'Session pinned-worker', 'Session worker', 'Session unloaded-worker', 'Session ordinary',
  ]);
  assert.match(html, /^<ul class="chatlist">/);
  assert.equal((html.match(/class="chatlist-group-title"/g) ?? []).length, 2);
  assert.match(html, /class="chatlist-chat active is-unloaded" role="button" data-session-id="unloaded-worker" tabindex="0" aria-current="true" aria-haspopup="menu"/);
  assert.equal((html.match(/role="button" data-session-id="[^"]+" tabindex="0"/g) ?? []).length, 4);
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /chatlist-empty/);
});

test('a worker-only sidebar is not blank and supports ID search', () => {
  const worker = { ...session('ABC-123', { title: 'Historical result', loaded: false, status: 'unloaded' }), spawnedBy: 'old-flow' };
  assert.deepEqual(titles(render([worker])), ['Historical result']);
  assert.deepEqual(titles(render([worker], { query: ' abc-123 ' })), ['Historical result']);
  assert.doesNotMatch(render([worker]), /chatlist-empty|chatlist-group-title/);
});

test('sidebar searches historical workers by title and full cwd as ordinary sessions', () => {
  const sessions = [
    { ...session('pin', { title: 'Production deploy', pinned: true }), spawnedBy: 'old-flow' },
    { ...session('worker', { cwd: '/WORK/Production/service', loaded: false, status: 'unloaded' }), spawnedBy: 'old-flow' },
    session('other'),
  ];
  assert.deepEqual(titles(render(sessions, { query: '  PRODUCTION ' })), ['Production deploy', 'Session worker']);
  const html = render(sessions, { query: ' /work/production/ ' });
  assert.deepEqual(titles(html), ['Session worker']);
  assert.doesNotMatch(html, /chatlist-group-title|chatlist-empty/);
});

test('sidebar keeps schedule, pin, status and attention badges on unloaded rows', () => {
  const html = render([
    session('seen', { loaded: false, pinned: true, scheduleCount: 2, attention: 'choice', attnId: 5, seenId: 5 }),
    session('unseen', { status: 'running', attention: 'choice', attnId: 6, seenId: 5 }),
    session('ready', { status: 'error', attention: 'ready', attnId: 2, seenId: 1 }),
  ]);
  assert.match(html, /class="dialog-schedule" title="2 个定时任务"/);
  assert.match(html, /class="dialog-pinned" title="已置顶"/);
  assert.match(html, /class="dialog-choice is-seen" title="已读 · 仍需选择"/);
  assert.match(html, /class="dialog-choice" title="未读 · 需要选择"/);
  assert.match(html, /class="dialog-unread" title="有新结果"/);
  assert.match(html, /data-tone="running">回复中/);
  assert.match(html, /data-tone="error">出错/);
  assert.equal((html.match(/class="dialog-schedule"/g) ?? []).length, 1);
});

test('unloaded historical workers retain every attention state without a resident status badge', () => {
  for (const [attention, seenId, badge] of [
    ['choice', 4, 'dialog-choice'],
    ['choice', 5, 'dialog-choice is-seen'],
    ['ready', 4, 'dialog-unread'],
  ] as const) {
    const worker = {
      ...session('worker', { loaded: false, status: 'unloaded', pinned: true, scheduleCount: 1, attention, attnId: 5, seenId }),
      spawnedBy: 'old-flow',
    };
    const html = render([worker]);
    assert.match(html, /class="chatlist-chat is-unloaded"/);
    assert.ok(html.includes(`class="${badge}"`));
    assert.match(html, /class="dialog-schedule" title="1 个定时任务"/);
    assert.match(html, /class="dialog-pinned" title="已置顶"/);
    assert.doesNotMatch(html, /class="dialog-status"/);
  }
});

test('sidebar keeps the five grid children, cwd chip and basename', () => {
  const html = render([session('cwd', { cwd: '/work/项目/', scheduleCount: 0 })]);
  assert.match(html, /<span class="dialog-avatar" style="--chip-h:\d+" aria-hidden="true">项<\/span><span class="dialog-title">Session cwd<\/span><span class="dialog-time">[^<]*<\/span><span class="dialog-subtitle">项目<\/span><span class="dialog-meta"><\/span>/);
  assert.doesNotMatch(html, /dialog-schedule|dialog-status|dialog-pinned|dialog-choice|dialog-unread/);
});

test('sidebar distinguishes empty server from empty search and hides unused group headings', () => {
  assert.match(render([]), /class="chatlist-empty">服务器上没有 session/);
  assert.match(render([], { query: ' \t ' }), /class="chatlist-empty">服务器上没有 session/);
  assert.match(render([session('one')], { query: 'missing' }), /class="chatlist-empty">没有匹配的会话/);
  const pinnedOnly = render([session('pin', { pinned: true }), session('other')], { query: 'pin' });
  assert.equal((pinnedOnly.match(/class="chatlist-group-title"/g) ?? []).length, 1);
  assert.match(pinnedOnly, /role="heading" aria-level="2">置顶/);
  assert.doesNotMatch(pinnedOnly, />全部</);
});

test('different directories and worktrees share one activity-sorted list below global pins', () => {
  const sessions = [
    session('main', { lastActivity: 300 }),
    session('another', { cwd: '/other/project', lastActivity: 400 }),
    session('worktree', { cwd: '/tasks/feature', lastActivity: 200 }),
    session('pin', { pinned: true, cwd: '/elsewhere', lastActivity: 100 }),
    session('unknown', { cwd: '', lastActivity: 50 }),
    session('root', { cwd: '/', lastActivity: 40 }),
  ];
  const { pinnedList, restList } = groupSessions(sessions, '');
  assert.deepEqual(ids(pinnedList), ['pin']);
  assert.deepEqual(ids(restList), ['another', 'main', 'worktree', 'unknown', 'root']);
  const html = render(sessions);
  assert.deepEqual(titles(html), ['Session pin', 'Session another', 'Session main', 'Session worktree', 'Session unknown', 'Session root']);
  assert.deepEqual([...html.matchAll(/role="heading" aria-level="2">([^<]+)/g)].map(match => match[1]), ['置顶', '全部']);
  assert.match(html, />feature<\/span>/);
  assert.equal((html.match(/data-session-id=/g) ?? []).length, sessions.length);
  assert.doesNotMatch(html, /chatlist-group-path|主工作区|归属未确认|<select|aria-expanded/);
});

test('legacy project metadata is ignored for grouping, avatars, labels and search', () => {
  const sessions = [
    { ...session('first', { cwd: '/tasks/feature', lastActivity: 200 }),
      get project(): never { throw new Error('Retired project metadata must not be read'); } },
    session('fork', { cwd: '/tasks/feature', lastActivity: 400 }),
    session('main', { lastActivity: 300 }),
    session('unrelated', { cwd: '/not-this-one' }),
  ];
  assert.deepEqual(ids(groupSessions(sessions, '/work/project').restList), ['main']);
  assert.deepEqual(ids(groupSessions(sessions, '/tasks/feature').restList), ['fork', 'first']);
  assert.deepEqual(titles(render(sessions, { query: 'fork' })), ['Session fork']);
  assert.deepEqual(titles(render(sessions)), ['Session fork', 'Session main', 'Session first', 'Session unrelated']);
  assert.doesNotMatch(render(sessions), /chatlist-group-title|主工作区|Worktree/);
});
