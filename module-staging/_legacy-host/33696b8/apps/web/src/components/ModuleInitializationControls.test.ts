import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleStatus } from '@cockpit/protocol';
import { ModuleInitializationControls, TaskInitializationReferences } from './ModuleInitializationControls';

const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.scss') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { ModuleManagementVersions } = await import('./Modules');
styles.deregister();

test('no initialization capability means no initialization UI or hook invocation', () => {
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', installed: [{ version: '1.2.2', digest: 'a'.repeat(64) }],
    selectedVersion: '1.2.2', roles: [], service: { ownership: 'external', status: 'running' } };
  for (const supportsInitialization of [undefined, false]) {
    assert.equal(renderToStaticMarkup(createElement(ModuleInitializationControls, {
      module: { ...module, supportsInitialization }, disabled: false, onRefresh: () => { assert.fail('render must not refresh'); },
    })), '');
  }
});

test('unread config fails closed and initialization defaults cannot enable an invalid gateway', () => {
  const module: ModuleStatus = { id: 'task', name: 'Task', description: 'Task', installed: [{ version: '1.2.3', digest: 'a'.repeat(64) }],
    selectedVersion: '1.2.3', supportsInitialization: true, roles: [], service: { ownership: 'external', status: 'unknown' } };
  const html = renderToStaticMarkup(createElement(ModuleInitializationControls,
    { module, disabled: false, onRefresh: () => { assert.fail('render cannot initialize or refresh'); } }));
  assert.match(html, /须先读取 Task 的权威配置/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>初始化全新 Task 配置/);
  assert.match(html, /不启动服务、不新建 caller\/session、不发消息/);
  assert.match(html, /1\.2\.3/);
  assert.match(html, new RegExp(`a{64}`));
});

test('configuration display exposes allowlisted file references, not credential contents', () => {
  const html = renderToStaticMarkup(createElement(TaskInitializationReferences, { config: {
    moduleId: 'task', revision: 1, configVersion: 1,
    values: { dataDirectory: '/fresh/data/task', managerCredentialFile: '/fresh/data/task/manager.json',
      viewerCredentialFile: '/fresh/data/task/viewer.json', token: 'must-not-render-token', otherSecret: 'must-not-render-secret' },
  } }));
  assert.match(html, /\/fresh\/data\/task\/manager\.json/);
  assert.match(html, /\/fresh\/data\/task\/viewer\.json/);
  assert.match(html, /不读取凭据正文/);
  assert.doesNotMatch(html, /must-not-render/);
});

test('one module management view reuses system authority and on-demand session module versions', () => {
  const html = renderToStaticMarkup(createElement(ModuleManagementVersions));
  assert.match(html, /主程序 \/ 系统版本/);
  assert.match(html, /会话应用版本/);
  assert.match(html, /已安装、selected 与服务实际运行版本/);
  assert.match(html, /请选择会话（不自动加载全部会话）/);
  const source = readFileSync(new URL('./Modules.tsx', import.meta.url), 'utf8');
  assert.match(source, /<ModuleManagementVersions \/>/);
  assert.match(source, /<VersionProjects status=\{versions.data\}/);
  assert.match(source, /'module-management-system-versions', loadDeliveryStatus/);
  assert.match(source, /sessionId && <SessionModuleVersions key=\{sessionId\} sessionId=\{sessionId\}/);
  assert.match(source, /<ModuleVersionDetails module=\{module\}/);
});

test('initialization UI uses one durable request, exact passive readback and independent start action', () => {
  const source = readFileSync(new URL('./ModuleInitializationControls.tsx', import.meta.url), 'utf8');
  assert.match(source, /getModuleInitialization/);
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /globalThis.location\?\.origin/);
  assert.match(source, /ModuleInitializationRequest.shape.gatewayUrl.safeParse/);
  assert.match(source, /window.confirm\(message\)/);
  assert.match(source, /intent\('modules\/config\/initialize', body\)/);
  assert.match(source, /intent\('modules\/config\/initialization', \{ operationId: request.operationId \}\)/);
  assert.match(source, /void config.refresh\(\); onRefresh\(\)/);
  assert.match(source, /再明确点击“启动所选已安装版本”/);
  assert.doesNotMatch(source, /newOperation|\.resume|randomUUID|setInterval|modules\/service'|session\/new|sendPrompt/);
});
