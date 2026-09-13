import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleInstallControls, WechatUnbindControls } from './ModuleMutationControls';
import { getModuleInstall, getWechatUnbind } from '../lib/moduleMutation';

test('uncertain manual WeChat unbind remains visible even when no current binding is listed', async t => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    locks: { request: <T>(_name: string, _options: unknown, claim: () => T) => Promise.resolve(claim()) },
  } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const operation = getWechatUnbind();
  await assert.rejects(operation.start(operationId => ({ operationId, sessionId: 'deleted-native-session', confirm: true }),
    async () => { throw new Error('transport unknown'); }));
  const id = operation.getSnapshot().attempt?.request.operationId;
  assert.ok(id);
  const html = renderToStaticMarkup(createElement(WechatUnbindControls, {
    bindings: [], disabled: false, onRefresh: () => { assert.fail('render must not refresh or unbind'); },
  }));
  assert.ok(html.includes(id));
  assert.match(html, /deleted-native-session/);
  assert.match(html, /绑定消失不是原操作成功证明/);
  assert.match(html, /不会再次 POST 解绑来查询/);
  assert.match(html, /只读核对原解绑操作（不再次解绑）/);
  assert.doesNotMatch(html, /当前缺少.*只读接口/);
  assert.doesNotMatch(html, /允许新的显式解绑/);
});

test('application, installation and manual unbind wiring never allocates ad hoc IDs or queries with mutation POSTs', () => {
  const modules = readFileSync(new URL('./Modules.tsx', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('./ModuleMutationControls.tsx', import.meta.url), 'utf8');
  const apply = modules.slice(modules.indexOf('export function SessionModuleVersions'));
  assert.doesNotMatch(modules + controls, /crypto\.randomUUID/);
  assert.doesNotMatch(modules + controls, /intent\('modules\/install'/);
  assert.match(controls, /modules\/updates\/get', \{ operationId: request.operationId \}/);
  assert.match(controls, /operation\.start\(operationId/);
  assert.match(controls, /intent\('modules\/install\/local'/);
  assert.match(controls, /digest: request.sha256/);
  assert.match(controls, /sha256: localRelease.digest, source: 'local'/);
  assert.match(modules, /localRelease=\{module.localRelease\} localSourceError=\{module.localSourceError\}/);
  assert.match(apply, /useMemo\(\(\) => getModuleApply\(sessionId\), \[sessionId\]\)/);
  assert.match(apply, /operation\.read/);
  assert.match(apply, /await readOriginal\(\);\s*await operation\.resume/);
  assert.match(apply, /operationId: binding.operationId/);
  assert.match(apply, /outgoing.sending \|\| !!attempt/);
  const unbind = controls.slice(controls.indexOf('export function WechatUnbindControls'));
  assert.match(unbind, /window.confirm/);
  assert.match(unbind, /operation\.read/);
  assert.match(unbind, /intent\('modules\/wechat\/unbind\/get', \{ operationId: request.operationId \}\)/);
  assert.doesNotMatch(unbind, /setInterval|modules\/list/);
  assert.match(unbind, /snapshot.sending \|\| !!attempt/);
});

test('fresh Assistant exposes its trusted local install without a remote catalog and retains unknown ownership', async t => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    locks: { request: <T>(_name: string, _options: unknown, claim: () => T) => Promise.resolve(claim()) },
  } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const localRelease = { version: '1.0.0', digest: 'c'.repeat(64) };
  const render = (localSourceError?: string) => renderToStaticMarkup(createElement(ModuleInstallControls,
    { moduleId: 'assistant', targets: [], localRelease, localSourceError, disabled: false,
      onRefresh: () => { assert.fail('render cannot install or refresh'); } }));
  const fresh = render();
  assert.match(fresh, /安装随附\/本机可信版本/);
  assert.match(fresh, /本机 inventory SHA256（不是归档哈希）/);
  assert.doesNotMatch(fresh, /下载并安装此归档/);
  assert.match(fresh, /<button[^>]*disabled=""[^>]*>安装随附\/本机可信版本/, 'SSR remains disabled until the live connection is established');
  assert.match(render('allowlisted source digest mismatch'), /disabled=""/);
  const operation = getModuleInstall('assistant');
  await operation.start(operationId => ({ moduleId: 'assistant', operationId, version: localRelease.version,
    sha256: localRelease.digest, source: 'local' }), async request => ({ ...request, state: 'unknown', updatedAt: 1 }));
  const pending = render();
  assert.match(pending, /<button[^>]*disabled=""[^>]*>安装随附\/本机可信版本/);
  assert.match(pending, /读取原安装 ID（不重新安装）/);
  assert.ok(pending.includes(operation.getSnapshot().attempt!.request.operationId));
  assert.doesNotMatch(pending, /终态已核对，明确另起安装操作/);
});
