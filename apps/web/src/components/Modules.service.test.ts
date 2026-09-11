import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleServiceJob, ModuleServiceStatus, ModuleStatus, ModuleUpdateOperation } from '@cockpit/protocol';
import type { ModuleServiceAttempt } from '../lib/moduleService';

const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.scss') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { ModuleVersionDetails, ServiceJobDetails, ModuleServiceControls, ModuleUpdateDetails, ServiceRecoveryControl } = await import('./Modules');
styles.deregister();

test('recovery control exists only for an explicitly permitted managed runner and preserves blocked state', () => {
  const job: ModuleServiceJob = { schemaVersion: 1, command: { id: 'task', action: 'stop', operationId: 'fault-operation' },
    phase: 'unknown', step: 'waiting-exit', acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:01.000Z' };
  const runner: ModuleServiceStatus = { id: 'task', status: 'unknown', owned: false, recoveryRequired: true, canRecoverStop: true, job };
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', roles: [], installed: [], selectedVersion: null,
    service: { ownership: 'managed', status: 'unknown', runner } };
  const render = (value: ModuleServiceStatus, blocked = false, target = module) =>
    renderToStaticMarkup(createElement(ServiceRecoveryControl, { module: target, runner: value, blocked,
      onRecover: () => { assert.fail('render must not recover'); } }));
  assert.match(render(runner), /确认后安全排空\/恢复停止/);
  assert.match(render(runner, true), /disabled=""/);
  assert.equal(render({ ...runner, canRecoverStop: false }), '');
  assert.equal(render({ ...runner, canRecoverStop: undefined }), '');
  assert.equal(render(runner, false, { ...module, service: { ...module.service, ownership: 'external' } }), '');
});

test('only unknown installations show an explicit reconciliation button, disabled while busy', () => {
  for (const state of ['downloading', 'extracting', 'installing', 'succeeded', 'failed', 'unknown'] as const) {
    const operation: ModuleUpdateOperation = { moduleId: 'task', operationId: 'original-install-operation',
      version: '1.2.0', sha256: 'a'.repeat(64), state, updatedAt: 1, error: 'retained result explanation' };
    const render = (busy: boolean) => renderToStaticMarkup(createElement(ModuleUpdateDetails, {
      operation, busy, onReconcile: () => { assert.fail('render must not reconcile'); },
    }));
    const html = render(false);
    assert.match(html, /original-install-operation/);
    assert.match(html, /retained result explanation/);
    if (state === 'unknown') {
      assert.match(html, /核对安装结果（不重试）/);
      assert.doesNotMatch(html, /disabled=""/);
      assert.match(render(true), /disabled=""/);
    } else assert.doesNotMatch(html, /<button/);
  }
});

test('installation receipts label local inventory separately from remote archive hashes', () => {
  for (const source of [undefined, 'local'] as const) {
    const operation: ModuleUpdateOperation = { moduleId: 'assistant', operationId: 'source-label-operation',
      version: '1.0.0', sha256: 'c'.repeat(64), source, state: 'unknown', updatedAt: 1 };
    const html = renderToStaticMarkup(createElement(ModuleUpdateDetails, {
      operation, busy: false, onReconcile: () => { assert.fail('render cannot reconcile'); },
    }));
    assert.match(html, source === 'local' ? /本机 inventory SHA256（不是归档哈希）/ : /远端归档 SHA256/);
    assert.match(html, /c{64}/);
  }
});

test('a completed start still offers authorized recovery when service health becomes unknown', () => {
  const job: ModuleServiceJob = { schemaVersion: 1, command: { id: 'task', action: 'start',
    operationId: 'completed-start-operation', version: '1.2.1', digest: 'a'.repeat(64) },
    phase: 'done', step: 'complete', acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:01.000Z' };
  const runner: ModuleServiceStatus = { id: 'task', status: 'unknown', owned: true,
    recoveryRequired: true, canRecoverStop: true, job };
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', roles: [], installed: [],
    selectedVersion: null, service: { ownership: 'managed', status: 'unknown', runner } };
  const render = (value: ModuleServiceStatus) => renderToStaticMarkup(createElement(ServiceRecoveryControl,
    { module, runner: value, blocked: false, onRecover: () => { assert.fail('render must not recover'); } }));
  const html = render(runner);
  assert.match(html, /确认后安全排空\/恢复停止/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.equal(render({ ...runner, canRecoverStop: false }), '');
  assert.equal(job.phase, 'done');
});

test('recovery chain control requires a read-confirmed failed link and matching latest runner authority', () => {
  const request = { moduleId: 'task' as const, action: 'stop' as const, operationId: 'failed-recovery-operation',
    recoveryOf: 'first-fault-operation', confirmRecovery: true as const };
  const job: ModuleServiceJob = { schemaVersion: 1, command: { id: request.moduleId, action: request.action,
    operationId: request.operationId, recoveryOf: request.recoveryOf, confirmRecovery: true },
    phase: 'failed', step: 'complete', acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:01.000Z' };
  const runner: ModuleServiceStatus = { id: 'task', status: 'failed', owned: true,
    recoveryRequired: true, canRecoverStop: true, job };
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', roles: [], installed: [],
    selectedVersion: null, service: { ownership: 'managed', status: 'failed', runner } };
  const attempt: ModuleServiceAttempt = { request: { moduleId: 'task', action: 'stop', operationId: request.recoveryOf },
    recovery: { request, terminal: 'failed' } };
  const render = (value = attempt, status = runner) => renderToStaticMarkup(createElement(ServiceRecoveryControl,
    { module, runner: status, attempt: value, blocked: false, onRecover: () => { assert.fail('render must not recover'); } }));
  assert.doesNotMatch(render(), /disabled=""/);
  assert.match(render({ ...attempt, recovery: { request } }), /disabled=""/);
  assert.match(render({ ...attempt, recovery: { request } }, { ...runner, job: { ...job, phase: 'unknown' } }),
    /unknown 的恢复链节，本界面只允许读回/);
  assert.match(render(attempt, { ...runner, job: { ...job, command: { ...job.command, operationId: 'different-recovery' } } }),
    /disabled=""/);
  assert.equal(render(attempt, { ...runner, canRecoverStop: false }), '');
});

test('installed, selected and actual running release identities are rendered separately', () => {
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', roles: [],
    installed: [{ version: '1.0.0', digest: 'a'.repeat(64) }, { version: '2.0.0', digest: 'b'.repeat(64) }],
    selectedVersion: '2.0.0', service: { ownership: 'managed', status: 'running', version: '1.0.0',
      digest: 'a'.repeat(64), instanceId: 'actual-instance' } };
  const html = renderToStaticMarkup(createElement(ModuleVersionDetails, { module }));
  assert.match(html, /已安装：/);
  assert.match(html, /新接入选择（selected）：2\.0\.0 · digest <code>b{64}/);
  assert.match(html, /实际服务报告：Cockpit 管理 · running · 1\.0\.0 · digest <code>a{64}/);
  assert.match(html, /安装或选择新版不切换运行版本/);
  assert.match(html, /actual-instance/);
});

for (const phase of ['accepted', 'running', 'waiting', 'unknown'] as const) {
  test(`${phase} job display never substitutes acceptance for actual service readiness`, () => {
    const job: ModuleServiceJob = { schemaVersion: 1, phase, step: phase === 'waiting' ? 'waiting-exit' : 'queued',
      command: { id: 'task', operationId: 'visible-job-identity', action: 'apply', version: '2.0.0', digest: 'b'.repeat(64) },
      acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:01.000Z',
      reason: 'waiting for active work' };
    const html = renderToStaticMarkup(createElement(ServiceJobDetails, { job }));
    assert.match(html, /visible-job-identity/);
    assert.match(html, /waiting for active work/);
    assert.match(html, /本次目标：2\.0\.0 · digest <code>b{64}/);
    assert.doesNotMatch(html, /实际服务.*running|服务已运行/);
    if (phase === 'accepted') assert.match(html, /不是服务就绪/);
    if (phase === 'running') assert.match(html, /不是服务运行确认/);
  });
}

test('external services expose no enabled mutation control or takeover', () => {
  const module: ModuleStatus = { id: 'wechat', name: 'WeChat', description: 'external', roles: [],
    installed: [], selectedVersion: null, service: { ownership: 'external', status: 'running' } };
  const html = renderToStaticMarkup(createElement(ModuleServiceControls, { module, moduleId: 'wechat' }));
  assert.match(html, /不接管外部进程/);
  for (const label of ['启动所选已安装版本', '安全停止', '安全应用所选已安装版本', '读取实际服务状态']) {
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  }
});

test('service UI uses durable operation ownership, explicit original-job readback and passive status APIs', () => {
  const source = readFileSync(new URL('./Modules.tsx', import.meta.url), 'utf8');
  const service = source.slice(source.indexOf('export function ModuleServiceControls'), source.indexOf('export function SessionModuleVersions'));
  assert.match(service, /useSyncExternalStore/);
  assert.match(service, /getModuleServiceOperation\(moduleId\)/);
  assert.match(service, /modules\/service\/status/);
  assert.match(service, /modules\/service\/job/);
  assert.match(service, /operation\.send\(module, runner, command/);
  assert.match(service, /serviceAttemptCanReset\(attempt\)/);
  assert.match(service, /operation\.newOperation\(\)/);
  assert.match(service, /历史\/预期身份（不是实际运行证明）/);
  assert.match(service, /const latest = await intent\('modules\/service\/status', \{ moduleId \}\)/);
  assert.match(service, /operation\.recover\(module, latest, message =>/);
  assert.match(service, /return window.confirm\(message\)/);
  assert.match(service, /recoveryView\.current !== view/);
  assert.match(service, /<ServiceRecoveryControl module=\{module\} runner=\{runner\} attempt=\{attempt\}/);
  assert.match(service, /operation\.readRecovery/);
  assert.doesNotMatch(service, /randomUUID|setInterval|force/);
});
