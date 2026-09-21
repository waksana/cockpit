import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeModelSwitchResult } from '@cockpit/protocol';
import type { ChatSession } from '../../net/types';
import { useCockpit } from '../../net/store';
import { ModelSettings, NativeModelOutcome } from './ModelSettings';
import { RoleSettings } from './RoleSettings';
import { SessionMcpSettings, SessionSkillSettings } from './SessionResources';
import { SettingSelect } from './SettingsControls';
import { readSelectValue, selectValue } from './selectValue';
import { sameModelSelection, selectionFrom } from '../../features/session-settings/useModelSettings';

const session: ChatSession = {
  sessionId: 'next-settings', title: 'Synthetic settings', cwd: '/fixture', loaded: true,
  status: 'idle', error: null, queue: [], ask: null, lastActivity: 0, messages: [],
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
  currentModelId: 'missing-native', currentReasoningEffort: 'future', currentContextTier: 'default',
};
const noMutation = async () => assert.fail('Rendering may not dispatch native mutations');
test('new production model controls retain unavailable native values and empty inventories', () => {
  for (const availableModels of [undefined, []]) {
    const html = renderToStaticMarkup(createElement(ModelSettings, {
      session: { ...session, availableModels }, disabled: true, onSetModel: noMutation,
    }));
    assert.match(html, /missing-native/);
    assert.match(html, /future/);
    assert.match(html, availableModels ? /原生可选模型列表为空/ : /原生可选模型列表不可用/);
    assert.doesNotMatch(html, /应用配置/);
  }
});
test('Radix unspecified encoding cannot alias a native ID and never sends an empty item', () => {
  assert.equal(selectValue(''), 'unspecified');
  assert.equal(readSelectValue('unspecified'), undefined);
  for (const value of ['unspecified', 'value:custom', 'native model', 'high']) {
    assert.equal(readSelectValue(selectValue(value)), value);
    assert.notEqual(selectValue(value), 'unspecified');
  }
  const html = renderToStaticMarkup(createElement(SettingSelect, {
    label: '思考力度', value: undefined, options: [{ value: 'high', label: '高' }], onChange: () => assert.fail(),
  }));
  assert.match(html, /role="combobox"/);
  assert.match(html, /思考力度/);
});
test('new outcome presentation delegates actual application classification to native protocol', () => {
  const render = (result: NativeModelSwitchResult) => renderToStaticMarkup(createElement(NativeModelOutcome, { result }));
  assert.match(render({ status: 'applied' }), /已应用/);
  for (const result of [{ status: 'queued' }, { status: 'applied', deferred: true }, { status: 'failed', deferred: true }]) {
    const html = render(result);
    assert.match(html, /已接受，等待原生应用/);
    assert.doesNotMatch(html.split('<details')[0], /已应用|原生报告失败/);
  }
  assert.match(render({ status: 'applied', persistenceError: 'read-only' }), /原生持久化失败：read-only/);
  assert.match(render({ status: 'future-status' }), /应用结果未确认/);
  assert.match(render({ status: 'rejected', message: 'native refusal' }), /native refusal/);
  const html = render({ status: 'confirmation_required', confirmation: { targetModelDisplayName: 'Small', currentTokens: 90, targetLimit: 80 } });
  assert.match(html, /Small.*90.*80/);
  assert.match(html, /不会自动确认或继续执行/);
  assert.doesNotMatch(html, /<button/);
});
test('draft dirtiness compares all optional native fields without manufacturing defaults', () => {
  assert.deepEqual(selectionFrom({ ...session, currentModelId: undefined, currentContextTier: undefined, currentReasoningEffort: undefined }), { modelId: '' });
  assert.ok(sameModelSelection({ modelId: 'x' }, { modelId: 'x', reasoningEffort: undefined }));
  assert.ok(!sameModelSelection({ modelId: 'x' }, { modelId: 'x', contextTier: 'default' }));
  assert.ok(!sameModelSelection({ modelId: 'x', reasoningEffort: 'high' }, { modelId: 'x', reasoningEffort: 'low' }));
});
test('role settings distinguish saved from applied without reading the catalog at render', () => {
  const html = renderToStaticMarkup(createElement(RoleSettings, { session: {
    ...session, roles: [{ moduleId: 'fixture', moduleName: 'Fixture', roleId: 'added', name: 'Added' }],
    appliedRoles: [], rolesNeedReload: true,
  } }));
  assert.match(html, /已保存.*fixture\/added/);
  assert.match(html, /已应用.*无/);
  assert.match(html, /不代表 MCP 连接或能力就绪/);
  assert.match(html, /追加模块角色/);
  assert.doesNotMatch(html, /role="checkbox"/);
});
for (const Component of [SessionMcpSettings, SessionSkillSettings]) {
  test(`${Component.name} reads authoritative load state instead of stale selected metadata`, t => {
    const initial = useCockpit.getInitialState();
    const previous = { ...initial };
    Object.assign(initial, { connState: 'open', sessions: [{ ...session, loaded: false }] });
    t.after(() => { Object.assign(initial, previous); });
    const html = renderToStaticMarkup(createElement(Component, { sessionId: session.sessionId }));
    assert.match(html, /恢复会话/);
    assert.doesNotMatch(html, /role="switch"/);
  });
}
