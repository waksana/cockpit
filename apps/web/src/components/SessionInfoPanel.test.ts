import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeModelSwitchResult } from '@cockpit/protocol';
import { ModelOutcome } from './SessionInfoPanel';

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
