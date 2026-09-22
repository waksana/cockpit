import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sessionActivityIndicators } from './sessionActivity';
import { SessionActivity } from '../components/SessionActivity';
import { activityFixture } from '../dev/activity-fixtures';
import type { SessionMeta } from '@cockpit/protocol';

const session = { status: 'running' as const, loaded: true, needsDecision: false };
const indicators = (activity: SessionMeta['activity']) => sessionActivityIndicators({ ...session, activity }, true);

test('concrete activities suppress the fallback spinner without hiding shell and agent counts', () => {
  const activity = activityFixture({
    processing: true, hasActiveWork: true, abortable: true,
    tasks: { activeAgents: 2, activeShells: 1, unknown: 0 },
  });
  const items = sessionActivityIndicators({ ...session, activity, needsDecision: true }, true);
  assert.deepEqual(items.map(item => item.key), ['decision', 'shell', 'agent']);
  const html = renderToStaticMarkup(createElement(SessionActivity, { items }));
  for (const icon of ['shell', 'agent', 'decision']) assert.match(html, new RegExp(`data-icon="${icon}"`));
  assert.match(html, /aria-label="后台 shell 1"/);
  assert.match(html, /aria-label="活动 agent 2"/);
  assert.doesNotMatch(html, /data-icon="loading"/);
  assert.doesNotMatch(html, /回复中|<button|<details|<summary/);
});

test('a lone processing indicator rotates, while a pending question suppresses missing-state spinners', () => {
  const html = renderToStaticMarkup(createElement(SessionActivity, { items: indicators(activityFixture({ processing: true })) }));
  assert.match(html, /class="ck-icon spinner" data-icon="loading"/);
  assert.match(html, /不代表模型正在生成/);
  for (const activityRefreshing of [true, false]) {
    assert.deepEqual(sessionActivityIndicators({ ...session, activity: null, needsDecision: true, activityRefreshing }, true)
      .map(item => item.key), ['decision']);
  }
});

test('turn ended with shell work is shell-only, including after accepted stop', () => {
  assert.deepEqual(indicators(activityFixture({ hasActiveWork: true,
    tasks: { activeAgents: 0, activeShells: 1, unknown: 0 } })).map(item => item.key), ['shell']);
  assert.deepEqual(sessionActivityIndicators({ ...session, status: 'idle', activity: activityFixture() }, true),
    [], 'terminal retained tasks are not active summary counts');
});

test('steering in-flight is a subset and MCP wait is an independent fact', () => {
  const items = indicators(activityFixture({
    queue: { pendingCount: 2, steeringCount: 3, inFlightSteeringCount: 2 },
    mcp: { pendingConnectionCount: 1 },
  }));
  assert.deepEqual(items.map(item => [item.key, item.count]), [['queue', 5], ['mcp', 1]]);
  assert.match(items[0].label, /其中 2 已纳入回合/);
});

test('missing, unloaded, disconnected and unclassified activity never imply idle', () => {
  for (const activity of [undefined, null]) assert.equal(indicators(activity)[0].key, 'unknown');
  const active = { ...session, activity: activityFixture({ processing: true }), needsDecision: true };
  assert.deepEqual(sessionActivityIndicators(active, false).map(item => item.key), ['offline']);
  for (const connected of [true, false]) {
    assert.deepEqual(sessionActivityIndicators({ ...active, loaded: false }, connected), []);
    assert.deepEqual(sessionActivityIndicators({ ...active, status: 'unloaded' }, connected), []);
  }
  assert.equal(indicators(activityFixture({ hasActiveWork: true }))[0].key, 'other');
  assert.equal(indicators(activityFixture({ tasks: { activeAgents: 0, activeShells: 0, unknown: 1 } }))[0].key, 'unknown-tasks');
});

test('pending control reads show refreshing rather than unknown or stale native activity', () => {
  const items = sessionActivityIndicators({ ...session, activity: null, activityRefreshing: true }, true);
  assert.deepEqual(items.map(item => item.key), ['refreshing']);
  const html = renderToStaticMarkup(createElement(SessionActivity, { items }));
  assert.match(html, /正在刷新活动状态/);
  assert.match(html, /class="ck-icon spinner" data-icon="loading"/);
  assert.doesNotMatch(html, /未知|原生处理中/);
  assert.deepEqual(sessionActivityIndicators({ ...session, activityRefreshing: true }, false).map(item => item.key), ['offline']);
  assert.deepEqual(indicators(null).map(item => item.key), ['unknown']);
});

test('refresh retains the previous visual facts, including empty idle, without replacing native activity', () => {
  const shell = activityFixture({ processing: true, tasks: { activeAgents: 0, activeShells: 2, unknown: 0 } });
  const value = { ...session, activity: null, activityRefreshing: true,
    activityDisplay: { previous: { status: 'running' as const, activity: shell } } };
  const items = sessionActivityIndicators(value, true);
  assert.deepEqual(items.map(item => [item.key, item.count]), [['shell', 2]]);
  assert.match(items[0].label, /上次采样，等待更新/);
  assert.equal(value.activity, null);
  assert.deepEqual(sessionActivityIndicators({ ...value, needsDecision: true }, true).map(item => item.key), ['decision', 'shell']);
  assert.deepEqual(sessionActivityIndicators({ ...value,
    activityDisplay: { previous: { status: 'idle', activity: activityFixture() } } }, true), []);
  assert.deepEqual(sessionActivityIndicators({ ...value, activity: activityFixture({ processing: true }) }, true)
    .map(item => item.key), ['processing'], 'fresh facts supersede retained presentation');
  assert.deepEqual(sessionActivityIndicators(value, false).map(item => item.key), ['offline']);
});

test('read failures and all specific activities suppress fallback spinning', () => {
  assert.deepEqual(sessionActivityIndicators({ ...session, activityDisplay: { error: 'Synthetic read failure' } }, true)
    .map(item => item.key), ['read-error']);
  for (const activity of [
    activityFixture({ processing: true, tasks: { activeAgents: 1, activeShells: 0, unknown: 1 } }),
    activityFixture({ processing: true, queue: { pendingCount: 1, steeringCount: 0, inFlightSteeringCount: 0 } }),
    activityFixture({ processing: true, mcp: { pendingConnectionCount: 1 } }),
  ]) assert.ok(indicators(activity).every(item => item.icon !== 'loading'));
  assert.equal(indicators(activityFixture({ processing: true, tasks: { activeAgents: 0, activeShells: 0, unknown: 1 } })).length, 1);
});
