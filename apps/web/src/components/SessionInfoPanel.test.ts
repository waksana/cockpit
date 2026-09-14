import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeModelSwitchResult } from '@cockpit/protocol';
import type { ChatSession } from '../net/types';
import { ModelControls, ModelOutcome } from './SessionInfoPanel';

const render = (result: NativeModelSwitchResult) => renderToStaticMarkup(createElement(ModelOutcome, { result }));

test('model outcomes distinguish actual application, pending, rejection and unknown status', () => {
  assert.match(render({ status: 'applied' }), /已应用/);
  for (const result of [
    { status: 'queued' }, { status: 'deferred' }, { status: 'applied', deferred: true },
    { status: 'rejected', deferred: true },
  ]) {
    const html = render(result);
    assert.match(html, /已接受，等待原生应用/);
    assert.doesNotMatch(html, /已应用/);
    assert.doesNotMatch(html, /原生报告失败/);
  }
  for (const status of ['rejected', 'failed', 'cancelled']) {
    assert.match(render({ status, message: 'Native refusal' }), /原生报告失败或拒绝.*Native refusal/);
    assert.match(render({ status }), /role="alert"/);
  }
  assert.match(render({ status: 'unchanged' }), /原生设置未变/);
  for (const result of [{}, { status: 'future-outcome' }]) {
    const html = render(result);
    assert.match(html, /应用结果未确认/);
    assert.doesNotMatch(html, /已应用|设置成功/);
  }
});

test('confirmation and persistence diagnostics preserve partial effects and native details', () => {
  const confirmation = render({
    status: 'confirmation_required',
    confirmation: { targetModelDisplayName: 'Small target', currentTokens: 120, targetLimit: 80 },
  });
  assert.match(confirmation, /原生要求确认或后续操作，尚未确认应用/);
  assert.match(confirmation, /Small target.*120.*80/);
  assert.match(confirmation, /不会自动确认或继续执行/);
  assert.doesNotMatch(confirmation, /<button/);
  const applied = render({
    status: 'applied', persistenceError: 'Read-only config',
    message: 'Runtime changed', warning: 'Native warning', deprecationWarnings: ['Retired model'],
    modelState: { modelId: 'target', reasoningEffort: 'high' }, extraNativeDetail: 'Preserved',
  });
  assert.match(applied, /已应用，但原生持久化失败.*Read-only config/);
  for (const detail of ['Runtime changed', 'Native warning', 'Retired model', 'extraNativeDetail', 'Preserved']) {
    assert.ok(applied.includes(detail), detail);
  }
  assert.doesNotMatch(render({ persistenceError: 'Unknown application' }), /已应用/);
  assert.match(render({ status: 'applied', persistenceError: '' }), /已应用，但原生持久化失败：原生未提供错误详情/);
});

test('one primary outcome leaves native diagnostics and the translated submitted combination in closed details', () => {
  const result = {
    status: 'applied', message: 'Runtime changed', warning: 'Native warning',
    deprecationWarnings: ['Retired model'], nativeExtension: { intact: true },
  };
  const html = renderToStaticMarkup(createElement(ModelOutcome, {
    result, selection: { modelId: 'native-model', reasoningEffort: 'xhigh', contextTier: 'long_context' },
  }));
  const [primary, details] = html.split('<details');
  assert.equal((primary.match(/role="status"/g) ?? []).length, 1);
  assert.match(primary, /已应用/);
  assert.match(primary, /Native warning/);
  assert.doesNotMatch(primary, /Runtime changed|上次提交|Retired model/);
  assert.match(details, /<summary>提交详情<\/summary>/);
  assert.doesNotMatch(details, /\bopen=/);
  assert.match(details, /思考力度：极高.*上下文：长上下文/);
  const raw = /<pre>(.*?)<\/pre>/s.exec(details)![1]
    .replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.deepEqual(JSON.parse(raw), result, 'all native fields survive unchanged');
});

test('refusal, persistence failure and required confirmation stay visible without opening diagnostics', () => {
  for (const result of [
    { status: 'rejected', message: 'Native refusal' },
    { status: 'applied', persistenceError: 'Native save failed' },
    { status: 'confirmation_required', message: 'Review target capacity',
      confirmation: { targetModelDisplayName: 'Small target', currentTokens: 120, targetLimit: 80 } },
  ]) {
    const primary = render(result).split('<details')[0];
    assert.match(primary, new RegExp(result.message ?? result.persistenceError!));
    if (result.confirmation) {
      assert.match(primary, /Small target.*120.*80/);
      assert.match(primary, /不会自动确认或继续执行/);
    } else assert.match(primary, /role="alert"/);
  }
});

test('model controls retain missing native choices and translate known current values', () => {
  const session: ChatSession = {
    sessionId: 'model-options', title: 'Options', cwd: '/fixture', loaded: true, status: 'idle',
    error: null, queue: [], ask: null, lastActivity: 0, messages: [], materialized: true,
    historyStale: false, hasMore: false, loadingHistory: false,
    currentModelId: 'unknown-native-model', currentReasoningEffort: 'high', currentContextTier: 'default',
    availableModels: [{ modelId: 'known', name: 'Known', supportedReasoningEfforts: ['high'], supportsLongContext: true }],
  };
  const editor = (value: ChatSession) => renderToStaticMarkup(createElement(ModelControls, {
    session: value, disabled: false, onSetModel: async () => assert.fail('Rendering must not submit'),
  }));
  const unknown = editor(session);
  assert.match(unknown, /unknown-native-model（当前值，列表未提供）/);
  assert.match(unknown, /思考力度：高.*上下文：标准上下文/);
  assert.match(unknown, /<button[^>]*disabled=""[^>]*>应用配置<\/button>/);
  assert.equal((unknown.match(/class="dialog-btn primary rp"/g) ?? []).length, 1, 'only one primary Apply action');
  assert.match(unknown, /aria-label="使用当前原生值" disabled="">重置/);
  assert.doesNotMatch(unknown, /正在提交|先选择完整组合/);
  const futureEffort = editor({ ...session, currentModelId: 'known', currentReasoningEffort: 'future-effort' });
  assert.match(futureEffort, /future-effort（当前值，列表未提供）/);
  assert.match(futureEffort, /class="info-model-name" title="known">Known/);
  assert.doesNotMatch(futureEffort, /原生未提供思考力度选项|原生未提供上下文档位能力/);
  for (const availableModels of [undefined, []]) {
    const missing = editor({ ...session, availableModels });
    assert.match(missing, /unknown-native-model.*思考力度：高.*上下文：标准上下文/);
    assert.match(missing, availableModels ? /原生可选模型列表为空/ : /原生可选模型列表不可用/);
    assert.doesNotMatch(missing, /<select|<button/);
  }
});
