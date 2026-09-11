import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionDeletionPlan, SessionUnbindApproval } from '@cockpit/protocol';
import { createDeletionAttempt, SessionDeleteDialogView } from './SessionDeleteDialog';
import { createKeyedAsync } from '../lib/keyedAsync';

const plan = (extra: Partial<SessionDeletionPlan> = {}): SessionDeletionPlan => ({
  sessionId: 'target-a', planId: 'a'.repeat(64),
  modules: [{ moduleId: 'wechat', name: '微信', version: '1.0.0' }], ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function markup(value?: SessionDeletionPlan, status: string | null = null, canConfirm = true) {
  return renderToStaticMarkup(createElement(SessionDeleteDialogView, {
    sessionId: 'target-a', name: '会话 A', plan: value, busy: false, status, canConfirm,
    onCancel() { assert.fail('render cannot cancel'); },
    onConfirm() { assert.fail('render cannot delete'); },
    onRefresh() { assert.fail('render cannot read'); },
  }));
}

test('deletion confirmation names only declared hooks and preserves retained files/workdir notice', () => {
  const html = markup(plan());
  assert.match(html, /解除关联并删除会话/);
  assert.match(html, /微信.*1\.0\.0/);
  assert.match(html, /托管文件和工作目录不会被删除/);
  assert.doesNotMatch(html, /Assistant|Task|通知/);
  const ordinary = markup(plan({ modules: [] }));
  assert.match(ordinary, /没有需要解除关联的模块/);
  assert.match(ordinary, />永久删除<\/button>/);
  assert.doesNotMatch(ordinary, /解除关联并删除会话/);
});

test('loading/failed preview cannot grant deletion and partial progress remains honest', () => {
  for (const status of ['加载中…', '加载失败：预览不可用']) {
    const html = markup(undefined, status, false);
    assert.match(html, /disabled=""[^>]*>永久删除<\/button>/);
    assert.ok(html.includes(status));
    assert.doesNotMatch(html, /没有需要解除关联的模块/);
  }
  const html = markup(plan({ state: 'failed', operationId: 'retained-operation',
    completedModules: ['wechat'], error: '原生删除未完成' }));
  assert.match(html, /已完成解除关联：微信/);
  assert.match(html, /原生删除未完成/);
  assert.match(html, /retained-operation/);
  assert.doesNotMatch(html, /会话已删除/);
});

test('module and nonmodule confirmation each issue exactly one native deletion, never separate hook calls', async () => {
  const received: { sessionId: string; confirm: true; unbind?: SessionUnbindApproval }[] = [];
  const send = async (sessionId: string, confirm: true, unbind?: SessionUnbindApproval) => {
    received.push({ sessionId, confirm, ...(unbind ? { unbind } : {}) });
  };
  await createDeletionAttempt('target-a', 'modal-operation').run(plan(), send);
  await createDeletionAttempt('target-a', 'unused-operation').run(plan({ modules: [] }), send);
  assert.deepEqual(received, [
    { sessionId: 'target-a', confirm: true, unbind: { planId: 'a'.repeat(64), operationId: 'modal-operation' } },
    { sessionId: 'target-a', confirm: true },
  ]);
});

test('partial failure refresh preserves the original operation ID and only explicit continuation sends again', async () => {
  const attempt = createDeletionAttempt('target-a', 'modal-operation');
  const calls: (SessionUnbindApproval | undefined)[] = [];
  const first = plan({ operationId: 'retained-operation', state: 'failed' });
  const send = async (_id: string, _confirm: true, approval?: SessionUnbindApproval) => {
    calls.push(approval);
    if (calls.length === 1) throw new Error('partial failure');
  };
  await assert.rejects(attempt.run(first, send), /partial failure/);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.ok(attempt.blockedReason(first));
  assert.ok(attempt.blockedReason(plan({ state: 'unknown', operationId: 'retained-operation' })));
  assert.ok(attempt.blockedReason(plan({ state: 'failed', operationId: 'different-operation' })));
  const refreshed = plan({ state: 'unbound', operationId: 'retained-operation', completedModules: ['wechat'] });
  assert.equal(attempt.blockedReason(refreshed), null);
  await attempt.run(refreshed, send);
  assert.deepEqual(calls, Array(2).fill({ planId: first.planId, operationId: 'retained-operation' }));
});

test('modal-generated operation ID remains fixed after a partial failure and an authoritative new preview', async () => {
  const attempt = createDeletionAttempt('target-a', 'fixed-modal-id');
  const approvals: (SessionUnbindApproval | undefined)[] = [];
  const send = async (_id: string, _confirm: true, approval?: SessionUnbindApproval) => {
    approvals.push(approval);
    if (approvals.length === 1) throw new Error('response lost');
  };
  await assert.rejects(attempt.run(plan(), send), /response lost/);
  const refreshed = plan({ state: 'failed', operationId: 'fixed-modal-id', planId: 'b'.repeat(64) });
  await attempt.run(refreshed, send);
  assert.deepEqual(approvals, [
    { planId: 'a'.repeat(64), operationId: 'fixed-modal-id' },
    { planId: 'b'.repeat(64), operationId: 'fixed-modal-id' },
  ]);
});

test('unconfirmed ordinary deletion, working/unknown progress, foreign sessions and concurrent clicks are blocked', async () => {
  const attempt = createDeletionAttempt('target-a', 'modal-operation');
  let calls = 0;
  const pending = deferred<void>();
  const send = async () => { calls++; await pending.promise; };
  for (const value of [plan({ sessionId: 'target-b' }), plan({ state: 'working' }), plan({ state: 'unknown' }), plan({ state: 'deleted' })]) {
    await assert.rejects(attempt.run(value, send));
  }
  assert.equal(calls, 0);
  const first = attempt.run(plan({ modules: [] }), send);
  await assert.rejects(attempt.run(plan(), send));
  assert.equal(calls, 1);
  pending.reject(new Error('native result unknown'));
  await assert.rejects(first, /native result unknown/);
  await assert.rejects(attempt.run(plan({ modules: [] }), send));
  assert.equal(calls, 1);
});

test('cancel/navigation aborts preview ownership and stale reads cannot authorize the replacement dialog', async () => {
  const connection = { connState: 'open', connectionGeneration: 1 };
  const old = createKeyedAsync<SessionDeletionPlan>('delete-preview:old:target-a', () => connection);
  const latest = createKeyedAsync<SessionDeletionPlan>('delete-preview:new:target-b', () => connection);
  const response = deferred<SessionDeletionPlan>();
  let signal: AbortSignal | undefined;
  old.activate();
  const request = old.refresh(value => { signal = value; return response.promise; });
  await Promise.resolve();
  old.deactivate();
  latest.activate();
  await latest.refresh(async () => plan({ sessionId: 'target-b', modules: [] }));
  response.resolve(plan());
  await request;
  assert.equal(signal?.aborted, true);
  assert.equal(old.getSnapshot().data, undefined);
  assert.equal(latest.getSnapshot().data?.sessionId, 'target-b');
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(source, /setDeleteTarget\(null\)/);
  assert.match(source, /<SessionDeleteDialog key=\{`\$\{location.key\}:\$\{deleteTarget.sessionId\}`\}/);
  const dialog = readFileSync(new URL('./SessionDeleteDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /useKeyedResource\(`delete-preview:\$\{identity\}:\$\{sessionId\}`/);
  assert.match(dialog, /preview.valid && !busy && !blockedReason/);
  assert.match(dialog, /useModalFocus\(ref\)/);
  assert.doesNotMatch(dialog, /session\/unbind|modules\/unbind|setInterval|setTimeout/);
});
