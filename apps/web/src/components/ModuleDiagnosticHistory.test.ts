import { act, render, screen, userEvent, within } from '../test/dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { ModuleDiagnosticHistory } from './ModuleDiagnosticHistory';
import { UxErrorNotifications } from './UxErrorNotifications';
import { moduleRuntime } from '../lib/moduleRuntime';
import { dismissUxError, getUxErrors, reportUxError } from '../lib/errorReporter';

const history = {
  errors: Array.from({ length: 5 }, (_, index) => ({
    id: `module-${index}`, stage: 'runtime' as const, code: `CODE_${index}`, error: `Historical cause ${index}`,
    firstObservedAt: '2026-11-11T00:00:00.000Z', lastObservedAt: '2026-11-11T01:00:00.000Z', count: index + 1,
  })),
  errorHistory: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', semantics: 'historical' as const,
    currentHealth: 'unknown' as const, limit: 100, evicted: 7,
  },
};

test('all five diagnostics are accessible without current-failure alerts or the three-notice cap', async t => {
  const store = moduleRuntime.diagnostics;
  store.replace(history);
  t.after(() => store.replace({ errors: [] }));
  const view = render(createElement(UxErrorNotifications));
  assert.ok(screen.getByText('模块诊断历史（5 条）'));
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(screen.queryByRole('listitem'), null, 'the complete list starts collapsed');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '展开模块诊断历史' }));
  assert.equal(screen.getAllByRole('listitem').length, 5);
  assert.ok(screen.getByText(/已淘汰 7 条/));
  assert.ok(screen.getByText(/当前健康未知/));
  const last = screen.getAllByRole('listitem')[4];
  assert.ok(within(last).getByText('CODE_4'));
  assert.match(last.textContent!, /观测次数：5/);
  assert.equal(last.querySelectorAll('time').length, 2);
  await user.click(screen.getByRole('button', { name: '关闭模块诊断提示' }));
  assert.equal(screen.queryByRole('complementary'), null);
  act(() => store.replace(history));
  assert.equal(screen.queryByRole('complementary'), null, 'unchanged reconnect stays dismissed');
  view.unmount();
  render(createElement(ModuleDiagnosticHistory, { history: store.getSnapshot() }));
  await user.click(screen.getByRole('button', { name: '展开模块诊断历史' }));
  assert.equal(screen.getAllByRole('listitem').length, 5, 'settings can still display locally dismissed history');
});

test('history dismissal moves focus outside the removed card and does not dismiss ordinary errors', async t => {
  t.mock.method(console, 'error', () => {});
  const store = moduleRuntime.diagnostics;
  store.replace({ ...history, errors: history.errors.slice(0, 4) });
  reportUxError('Ordinary operation failure');
  t.after(() => {
    store.replace({ errors: [] });
    for (const error of getUxErrors()) dismissUxError(error.id);
  });
  render(createElement(UxErrorNotifications));
  const user = userEvent.setup();
  const close = screen.getByRole('button', { name: '关闭模块诊断提示' });
  close.focus();
  await user.keyboard('{Escape}');
  assert.equal(document.activeElement, screen.getByRole('button', { name: '关闭错误通知' }));
  assert.ok(screen.getByRole('alert'));
  assert.equal(store.getSnapshot().errors.length, 4);
});

test('legacy empty history stays neutral and reports unknown evidence', async () => {
  render(createElement(ModuleDiagnosticHistory, { history: { errors: [] } }));
  await userEvent.setup().click(screen.getByRole('button', { name: '展开模块诊断历史' }));
  assert.ok(screen.getByText(/不能推断历史总数/));
  assert.ok(screen.getByText(/这不是健康检查结果/));
  assert.equal(screen.queryByRole('alert'), null);
});
