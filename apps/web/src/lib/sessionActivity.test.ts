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

test('overall spinner leads concrete activities without hiding shell and agent counts', () => {
  const activity = activityFixture({
    processing: true, hasActiveWork: true, abortable: true,
    tasks: { activeAgents: 2, activeShells: 1, unknown: 0 },
  });
  const items = indicators(activity);
  assert.deepEqual(items.map(item => item.key), ['overall', 'agent', 'shell']);
  const html = renderToStaticMarkup(createElement(SessionActivity, { items }));
  for (const icon of ['shell', 'agent', 'loading']) assert.match(html, new RegExp(`data-icon="${icon}"`));
  assert.match(html, /aria-label="后台 shell 1"/);
  assert.match(html, /aria-label="活动 agent 2"/);
  assert.equal((html.match(/data-icon="loading"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /回复中|<button|<details|<summary/);
});

test('a pending decision replaces the overall spinner with one question icon', () => {
  const activity = activityFixture({
    processing: true, hasActiveWork: true, abortable: true,
    tasks: { activeAgents: 2, activeShells: 1, unknown: 0 },
  });
  const items = sessionActivityIndicators({ ...session, activity, needsDecision: true }, true);
  assert.deepEqual(items.map(item => [item.key, item.icon]), [['overall', 'decision'], ['agent', 'agent'], ['shell', 'shell']]);
  assert.equal(items[0].label, '总状态：等待你回答或确认');
  const html = renderToStaticMarkup(createElement(SessionActivity, { items }));
  assert.doesNotMatch(html, /data-icon="loading"|spinner/);
  assert.equal((html.match(/data-icon="decision"/g) ?? []).length, 1);
});

test('overall status rotates alone and waits on a question even before activity arrives', () => {
  const html = renderToStaticMarkup(createElement(SessionActivity, { items: indicators(activityFixture({ processing: true })) }));
  assert.match(html, /class="ck-icon spinner" data-icon="loading"/);
  assert.match(html, /不代表模型正在生成/);
  for (const activityRefreshing of [true, false]) {
    assert.deepEqual(sessionActivityIndicators({ ...session, activity: null, needsDecision: true, activityRefreshing }, true)
      .map(item => [item.key, item.icon]), [['overall', 'decision']]);
  }
});

test('remaining shell work keeps the overall spinner after the main turn ends', () => {
  assert.deepEqual(indicators(activityFixture({ hasActiveWork: true,
    tasks: { activeAgents: 0, activeShells: 1, unknown: 0 } })).map(item => item.key), ['overall', 'shell']);
  assert.deepEqual(sessionActivityIndicators({ ...session, status: 'idle', activity: activityFixture() }, true),
    [], 'terminal retained tasks are not active summary counts');
});

test('steering in-flight is a subset and MCP wait is an independent fact', () => {
  const items = indicators(activityFixture({
    queue: { pendingCount: 2, steeringCount: 3, inFlightSteeringCount: 2 },
    mcp: { pendingConnectionCount: 1 },
  }));
  assert.deepEqual(items.map(item => [item.key, item.count]), [['overall', undefined], ['queue', 3], ['mcp', 1]]);
  assert.match(items[1].label, /其中 2 已纳入回合/);
});

test('missing, unloaded, disconnected and unclassified activity never imply idle', () => {
  for (const activity of [undefined, null]) assert.equal(indicators(activity)[0].key, 'overall');
  const active = { ...session, activity: activityFixture({ processing: true }), needsDecision: true };
  assert.deepEqual(sessionActivityIndicators(active, false).map(item => item.icon), ['unknown']);
  for (const connected of [true, false]) {
    assert.deepEqual(sessionActivityIndicators({ ...active, loaded: false }, connected), []);
    assert.deepEqual(sessionActivityIndicators({ ...active, status: 'unloaded' }, connected), []);
  }
  assert.equal(indicators(activityFixture({ hasActiveWork: true }))[0].key, 'overall');
  assert.match(indicators(activityFixture({ tasks: { activeAgents: 0, activeShells: 0, unknown: 1 } }))[0].label, /状态未知/);
});

test('pending control reads show refreshing rather than unknown or stale native activity', () => {
  const items = sessionActivityIndicators({ ...session, activity: null, activityRefreshing: true }, true);
  assert.deepEqual(items.map(item => item.key), ['overall']);
  const html = renderToStaticMarkup(createElement(SessionActivity, { items }));
  assert.match(html, /正在刷新活动状态/);
  assert.match(html, /class="ck-icon spinner" data-icon="loading"/);
  assert.doesNotMatch(html, /未知|原生处理中/);
  assert.deepEqual(sessionActivityIndicators({ ...session, activityRefreshing: true }, false).map(item => item.icon), ['unknown']);
  assert.deepEqual(indicators(null).map(item => item.key), ['overall']);
});

test('refresh retains the previous visual facts, including empty idle, without replacing native activity', () => {
  const shell = activityFixture({ processing: true, tasks: { activeAgents: 0, activeShells: 2, unknown: 0 } });
  const value = { ...session, activity: null, activityRefreshing: true,
    activityDisplay: { previous: { status: 'running' as const, activity: shell } } };
  const items = sessionActivityIndicators(value, true);
  assert.deepEqual(items.map(item => [item.key, item.count]), [['overall', undefined], ['shell', 2]]);
  assert.match(items[0].label, /上次采样，等待更新/);
  assert.equal(value.activity, null);
  assert.deepEqual(sessionActivityIndicators({ ...value, needsDecision: true }, true).map(item => [item.key, item.icon]), [['overall', 'decision'], ['shell', 'shell']]);
  assert.deepEqual(sessionActivityIndicators({ ...value,
    activityDisplay: { previous: { status: 'idle', activity: activityFixture() } } }, true), []);
  assert.deepEqual(sessionActivityIndicators({ ...value, activity: activityFixture({ processing: true }) }, true)
    .map(item => item.key), ['overall'], 'fresh facts supersede retained presentation');
  assert.deepEqual(sessionActivityIndicators(value, false).map(item => item.icon), ['unknown']);
});

test('read errors replace overall spinning, while specific activities do not', () => {
  assert.deepEqual(sessionActivityIndicators({ ...session, activityDisplay: { error: 'Synthetic read failure' } }, true)
    .map(item => item.icon), ['error']);
  for (const activity of [
    activityFixture({ processing: true, tasks: { activeAgents: 1, activeShells: 0, unknown: 1 } }),
    activityFixture({ processing: true, queue: { pendingCount: 1, steeringCount: 0, inFlightSteeringCount: 0 } }),
    activityFixture({ processing: true, mcp: { pendingConnectionCount: 1 } }),
  ]) {
    assert.equal(indicators(activity)[0].icon, 'loading');
    assert.equal(indicators(activity).filter(item => item.icon === 'loading').length, 1);
  }
  assert.equal(indicators(activityFixture({ processing: true, tasks: { activeAgents: 0, activeShells: 0, unknown: 1 } })).length, 1);
});
