import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import type { ChatSession } from '../net/types';
import { Sidebar } from '../components/Sidebar';
import { filterSessions } from './session-list';
import { activityFixture } from '../dev/activity-fixtures';
import { sessionRowOutline } from '../test/sessionRowOutline';

function session(sessionId: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId, title: `Session ${sessionId}`, cwd: '/work/project', lastActivity: 100,
    status: 'idle', error: null, loaded: true, queue: [], ask: null, activity: activityFixture(),
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
const titles = (html: string) => sessionRowOutline(html).map(row => row.title.text);

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
  assert.doesNotMatch(html, /data-activity="unloaded"|未加载/);
});

test('running state and pending decisions remain without schedule indicators or an inbox', () => {
  const html = render([
    session('scheduled', { scheduleCount: 2 }),
    session('running', { status: 'running', activity: activityFixture({ processing: true }) }),
    session('ask', { ask: { requestId: 'a', question: 'Choose' } }),
    session('plan', { planRequest: { requestId: 'p', summary: 'Plan' } }),
    session('elicit', { elicitation: { requestId: 'e', message: 'Confirm' } }),
  ]);
  assert.doesNotMatch(html, /dialog-schedule|定时任务/);
  assert.match(html, /data-activity="overall"/);
  assert.equal((html.match(/data-activity="decision"/g) ?? []).length, 3);
  assert.doesNotMatch(html, />选</);
  assert.doesNotMatch(html, /未读|已读|dialog-unread|dialog-pinned/);
});

test('each row renders a title of up to two lines with its time, then roles, directory and status', () => {
  const [row] = sessionRowOutline(render([session('cwd', { cwd: '/work/项目/', title: 'A very long title '.repeat(8) })]));
  assert.deepEqual(row.lines, ['session-row-title', 'dialog-time', 'session-row-details']);
  assert.deepEqual(row.details, ['dialog-subtitle', 'dialog-meta']);
  assert.deepEqual(row.title, { text: 'A very long title '.repeat(8), hover: 'A very long title '.repeat(8) });
  assert.deepEqual(row.directory, { text: '项目', hover: '/work/项目/' });
  assert.deepEqual(row.status, []);
  assert.match(render([]), /服务器上没有 session/);
  assert.match(render([session('one')], { query: 'missing' }), /没有匹配的会话/);
});

test('roles, a long directory and every status indicator share the second line in reading order', () => {
  const roles = [
    { moduleId: 'cockpit-task', moduleName: 'Task', roleId: 'executor', name: 'Executor' },
    { moduleId: 'review', moduleName: 'SyntheticReviewModuleWithLongName', roleId: 'reviewer', name: 'IndependentReviewer' },
  ];
  const cwd = `/work/${'long-directory-'.repeat(10)}`;
  const [row] = sessionRowOutline(render([session('extreme', {
    status: 'running', compacting: true, roles, appliedRoles: [roles[0]], cwd,
    planRequest: { requestId: 'p', summary: 'Plan' },
    activity: activityFixture({ processing: true, hasActiveWork: true,
      tasks: { activeAgents: 12, activeShells: 9, unknown: 1 },
      queue: { pendingCount: 23, steeringCount: 0, inFlightSteeringCount: 0 },
      mcp: { pendingConnectionCount: 4 } }),
  })]));
  assert.deepEqual(row.lines, ['session-row-title', 'dialog-time', 'session-row-details']);
  assert.deepEqual(row.details, ['dialog-roles session-role-badges', 'dialog-subtitle', 'dialog-meta']);
  assert.equal(row.directory.hover, cwd);
  assert.equal(row.roles.length, 2);
  assert.ok(row.roles.every(title => title?.includes('不代表当前能力就绪')));
  assert.deepEqual(row.status, ['overall', 'decision', 'compaction', 'agent', 'shell', 'queue', 'mcp']);
  assert.ok(row.text.indexOf('Session extreme') < row.text.indexOf('Task') && row.text.indexOf('Task') < row.text.indexOf('long-directory'));
});

test('busy session rows retain the leading overall spinner alongside specific activities', () => {
  for (const tasks of [
    { activeAgents: 1, activeShells: 0, unknown: 0 }, { activeAgents: 0, activeShells: 1, unknown: 0 },
  ]) {
    const html = render([session('background', { status: 'running',
      activity: activityFixture({ processing: false, hasActiveWork: true, tasks,
        queue: { pendingCount: 2, steeringCount: 0, inFlightSteeringCount: 0 } }),
    })]);
    assert.ok(html.indexOf('data-activity="overall"') < html.indexOf('data-activity="queue"'));
    assert.match(html, /class="ck-icon spinner" data-icon="loading"/);
    assert.match(html, new RegExp(`data-activity="${tasks.activeAgents ? 'agent' : 'shell'}"`));
  }
});

test('title clamps at two lines beside the time; details yield directory first, then roles, never status', () => {
  const css = compile(new URL('../styles/components/sidebar.scss', import.meta.url).pathname).css;
  const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  assert.match(rule('.chatlist-chat'), /grid-template-areas: "title time" "details details";/);
  assert.doesNotMatch(rule('.chatlist-chat'), /[^-]height: /);
  const title = rule('.chatlist-chat .session-row-title');
  assert.match(title, /-webkit-line-clamp: 2;[^]*line-clamp: 2;[^]*overflow: hidden;/);
  assert.doesNotMatch(title, /white-space: nowrap|[^-]height:/);
  assert.doesNotMatch(css, /session-row-title::before|float:/);
  assert.match(rule('.chatlist-chat .dialog-time'), /grid-area: time;[^]*align-self: start;[^]*white-space: nowrap;/);
  assert.match(rule('.chatlist-chat .dialog-subtitle'), /flex: 1 1 0;/);
  assert.match(rule('.chatlist-chat .dialog-roles'), /flex: 0 1 auto;/);
  assert.match(rule('.chatlist-chat .dialog-meta'), /flex: none;/);
  assert.match(rule('.chatlist-chat .dialog-roles'), /flex-wrap: nowrap;/);
  assert.doesNotMatch(css, /dialog-avatar|--chip-h/);
});

test('session role badges are separate from cwd and preserve all literal names', () => {
  const html = render([session('roles', { roles: [
    { moduleId: 'cockpit-task', moduleName: 'Task', roleId: 'owner', name: 'Owner' },
    { moduleId: 'other', moduleName: 'module_Original__Name', roleId: 'owner', name: 'cockpit-Exact-role' },
  ] })]);
  const [row] = sessionRowOutline(html);
  assert.deepEqual(row.details, ['dialog-roles session-role-badges', 'dialog-subtitle', 'dialog-meta']);
  assert.equal(row.directory.text, 'project');
  assert.equal((html.match(/class="role-badge"/g) ?? []).length, 2);
  assert.match(html, /class="module-label-name">Task</);
  assert.match(html, /class="module-label-name">module_Original__Name</);
  assert.match(html, /class="role-badge-name">cockpit-Exact-role</);
  assert.doesNotMatch(html, /readiness-badge|role-readiness/);
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
