import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSession, ModelOption } from '../net/types';
import { DirPicker } from '../components/DirPicker';
import { SessionInfoPanel } from '../components/SessionInfoPanel';
import { SessionMcp, SessionSkills } from '../components/Manage';
import { SessionContext, SessionPlan } from '../components/SessionPages';
import { SessionSchedules } from '../pages/SessionSchedules';
import { PanelPageShell, PermissionPolicy, ResourceStatus, SessionResume } from '../components/SessionPanelKit';
import { SessionRuntime } from '../components/SessionRuntime';
import { useCockpit } from '../net/store';
import { useSessionResource } from './useSessionResource';

const noop = () => {};
const session = {
  sessionId: 'resource-test', title: 'Resource test', cwd: '/work/project', messages: [], queue: [],
  status: 'idle', error: null, loaded: true, ask: null, lastActivity: 0,
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
} as ChatSession;

test('closed info panel has no hidden focus targets or mounted navigation', () => {
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session, models: [], open: false, onClose: noop, onSetModel: noop,
  }));
  assert.equal(html, '');
});

test('open info panel identifies its session without cross-page navigation', () => {
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session, models: [], open: true, onClose: noop, onSetModel: noop,
  }));
  assert.match(html, /会话设置 · Resource test/);
  assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
  assert.match(html, /allow-all/);
  assert.match(html, /自动批准（所有交互模式）/);
});

const modelOptions: ModelOption[] = [
  { modelId: 'alpha', name: 'Alpha', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', supportsLongContext: true },
  { modelId: 'beta', name: 'Beta', supportedReasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'high', supportsLongContext: true },
  { modelId: 'basic', name: 'Basic' },
];
const renderModelSettings = (patch: Partial<ChatSession>, models = modelOptions) =>
  renderToStaticMarkup(createElement(SessionInfoPanel, {
    session: { ...session, availableModels: models, ...patch }, models, open: true, onClose: noop,
    onSetModel: () => { assert.fail('Rendering confirmed values must never mutate them'); },
  }));
function selectedOption(html: string, label: string) {
  const select = html.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`))?.[1];
  assert.ok(select, `Missing select: ${label}`);
  const options = [...select.matchAll(/<option([^>]*)>(.*?)<\/option>/g)];
  const selected = options.filter((option) => option[1].includes('selected=""'));
  assert.equal(selected.length, 1, `Exactly one explicit selection: ${label}`);
  return { attributes: selected[0][1], text: selected[0][2], options };
}

test('model inventory removal preserves the confirmed raw value and reintroduction restores its label', () => {
  for (const current of ['beta', 'unknown-model']) {
    const patch = { currentModelId: current, currentReasoningEffort: 'max' };
    const absent = renderModelSettings(patch, modelOptions.filter((model) => model.modelId !== current));
    const selected = selectedOption(absent, '选择模型');
    assert.match(selected.attributes, new RegExp(`value="${current}"`));
    assert.match(selected.attributes, /disabled=""/);
    assert.equal(selected.text, `${current}（当前值，列表未提供）`);
    assert.doesNotMatch(absent, /aria-label="思考力度"|aria-label="上下文长度"/);
    const present = selectedOption(renderModelSettings(patch, [...modelOptions.filter((model) => model.modelId !== current), {
      modelId: current, name: 'Returned model',
    }]), '选择模型');
    assert.equal(present.text, 'Returned model');
    assert.doesNotMatch(present.attributes, /disabled/);
    assert.equal(present.options.filter((option) => option[1].includes(`value="${current}"`)).length, 1);
  }
});

test('absent or empty session inventories never claim global models are available', () => {
  for (const availableModels of [undefined, []]) {
    const html = renderModelSettings({ currentModelId: 'beta', availableModels });
    assert.doesNotMatch(html, /<select/);
    assert.match(html, /beta/);
    assert.match(html, availableModels ? /列表为空/ : /列表不可用/);
  }
  assert.equal(selectedOption(renderModelSettings({ currentModelId: 'beta', availableModels: [modelOptions[0]] }),
    '选择模型').text, 'beta（当前值，列表未提供）');
  const local = [{ ...modelOptions[1], name: 'Session Beta' }];
  assert.equal(selectedOption(renderModelSettings({ currentModelId: 'beta', availableModels: local }, []), '选择模型').text, 'Session Beta');
  assert.doesNotMatch(renderModelSettings({ currentModelId: 'beta', availableModels: [] }, []), /<select/);
});

test('missing confirmed or default effort is explicit without adding a selectable unsupported command', () => {
  const narrow = [{ ...modelOptions[1], supportedReasoningEfforts: ['high'] }];
  for (const currentReasoningEffort of ['max', 'unknown-effort']) {
    const patch = { currentModelId: 'beta', currentReasoningEffort, currentContextTier: 'long_context' as const };
    const absent = selectedOption(renderModelSettings(patch, narrow), '思考力度');
    assert.match(absent.attributes, /disabled=""/);
    assert.equal(absent.text, `${currentReasoningEffort}（当前值，列表未提供）`);
    assert.ok(absent.options.some((option) => option[1].includes('value="high"') && !option[1].includes('disabled')));
    const restored = selectedOption(renderModelSettings(patch, [{
      ...modelOptions[1], supportedReasoningEfforts: ['high', currentReasoningEffort],
    }]), '思考力度');
    assert.equal(restored.text, currentReasoningEffort === 'max' ? '最大' : currentReasoningEffort);
    assert.doesNotMatch(restored.attributes, /disabled/);
    assert.equal(restored.options.filter((option) => option[1].includes(`value="${currentReasoningEffort}"`)).length, 1);
  }
  const fallback = selectedOption(renderModelSettings({ currentModelId: 'beta', currentReasoningEffort: null }, [{
    ...narrow[0], defaultReasoningEffort: 'max',
  }]), '思考力度');
  assert.equal(fallback.text, '力度…');
});

test('thin session catalog keeps native membership and never invents per-session capabilities from globals', () => {
  const rich: ModelOption[] = [{
    modelId: 'gpt-6-astra', name: 'Global Astra',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high', supportsLongContext: true,
  }, ...modelOptions];
  const thin = [{ modelId: 'gpt-6-astra', name: 'Session Astra' }];
  const patch = {
    currentModelId: 'gpt-6-astra', currentReasoningEffort: 'xhigh',
    currentContextTier: 'long_context' as const, availableModels: thin,
  };
  const html = renderModelSettings(patch, rich);
  const model = selectedOption(html, '选择模型');
  assert.equal(model.text, 'Session Astra');
  assert.equal(model.options.length, 1, 'global entries must not expand the session allow-list');
  assert.doesNotMatch(html, /aria-label="思考力度"|aria-label="上下文长度"/);
  for (const currentReasoningEffort of [undefined, null, '']) {
    assert.doesNotMatch(renderModelSettings({ ...patch, currentReasoningEffort }, rich), /aria-label="思考力度"/);
  }
  const unknown = renderModelSettings({ ...patch, availableModels: [modelOptions[2]] }, rich);
  assert.equal(selectedOption(unknown, '选择模型').text, 'gpt-6-astra（当前值，列表未提供）');
  assert.doesNotMatch(unknown, /aria-label="思考力度"|aria-label="上下文长度"/);
});

test('explicit session capabilities override richer globals per field, including empty arrays, empty default and false', () => {
  for (const supportedReasoningEfforts of [['high'], []]) {
    const html = renderModelSettings({
      currentModelId: 'beta', currentReasoningEffort: 'max', currentContextTier: 'long_context',
      availableModels: [{ modelId: 'beta', name: 'Local Beta', supportedReasoningEfforts, supportsLongContext: false }],
    });
    assert.doesNotMatch(html, /aria-label="上下文长度"/);
    if (!supportedReasoningEfforts.length) assert.doesNotMatch(html, /aria-label="思考力度"/);
    else {
      const selected = selectedOption(html, '思考力度');
      assert.equal(selected.text, 'max（当前值，列表未提供）');
      assert.match(selected.attributes, /disabled/);
      assert.equal(selected.options.length, 2);
    }
  }
  for (const defaultReasoningEffort of ['max', '']) {
    const html = renderModelSettings({
      currentModelId: 'beta', currentReasoningEffort: null,
      availableModels: [{ modelId: 'beta', name: 'Local Beta', defaultReasoningEffort }],
    });
    assert.doesNotMatch(html, /aria-label="思考力度"|aria-label="上下文长度"/);
  }
  const differentId = renderModelSettings({
    currentModelId: 'local-only', availableModels: [{ modelId: 'local-only', name: 'Local only' }],
  });
  assert.doesNotMatch(differentId, /aria-label="思考力度"|aria-label="上下文长度"/);
});

test('empty model and effort values remain unknown instead of selecting defaults', () => {
  for (const currentModelId of [undefined, '']) {
    const selected = selectedOption(renderModelSettings({ currentModelId }), '选择模型');
    assert.equal(selected.text, '选择模型…');
    assert.match(selected.attributes, /value=""|disabled=""/);
  }
  for (const currentReasoningEffort of [undefined, null, '']) {
    const selected = selectedOption(renderModelSettings({ currentModelId: 'beta', currentReasoningEffort }), '思考力度');
    assert.equal(selected.text, '力度…');
  }
  const withoutDefault = selectedOption(renderModelSettings({ currentModelId: 'beta' }, [{
    ...modelOptions[1], defaultReasoningEffort: undefined,
  }]), '思考力度');
  assert.equal(withoutDefault.text, '力度…');
});

test('capability-free models keep controls hidden and all legal context tiers have corresponding options', () => {
  for (const models of [modelOptions, [{ ...modelOptions[2], supportedReasoningEfforts: [] }]]) {
    const basic = renderModelSettings({ currentModelId: 'basic', currentReasoningEffort: 'max', currentContextTier: 'long_context' }, models);
    assert.equal(selectedOption(basic, '选择模型').text, 'Basic');
    assert.doesNotMatch(basic, /aria-label="思考力度"|aria-label="上下文长度"/);
  }
  for (const currentContextTier of [undefined, null, 'default', 'long_context'] as const) {
    const html = renderModelSettings({ currentModelId: 'beta', currentReasoningEffort: 'max', currentContextTier });
    assert.equal(selectedOption(html, '选择模型').text, 'Beta');
    assert.equal(selectedOption(html, '思考力度').text, '最大');
    assert.equal(selectedOption(html, '上下文长度').text, currentContextTier === 'long_context' ? '长上下文'
      : currentContextTier === 'default' ? '标准上下文' : '原生未提供当前值');
  }
});

test('permission policy is read-only and does not confuse interactive mode with permission prompts', () => {
  const html = renderToStaticMarkup(createElement(PermissionPolicy));
  assert.doesNotMatch(html, /高级设置/);
  assert.match(html, /只读/);
  assert.match(html, /allow-all/);
  assert.match(html, /自动批准（所有交互模式）/);
  assert.doesNotMatch(html, /<(select|input|button)\b/);
});

test('directory picker without an initial path has no hardcoded home and cannot create before a listing', () => {
  const html = renderToStaticMarkup(createElement(DirPicker, { onPick: async () => 'created', onCreated: noop, onCancel: noop }));
  assert.match(html, /aria-label="选择工作目录"/);
  assert.doesNotMatch(html, /\/home\/honglai|没有子文件夹/);
  assert.match(html, /class="dialog-btn primary rp" disabled=""/);
  assert.match(html, /等待连接/);
});

test('a supplied but unvalidated directory cannot enable session creation', () => {
  const html = renderToStaticMarkup(createElement(DirPicker, {
    initialPath: '/unvalidated', onPick: async () => 'created', onCreated: noop, onCancel: noop,
  }));
  assert.match(html, /value="\/unvalidated"/);
  assert.match(html, /class="dialog-btn primary rp" disabled=""/);
  assert.doesNotMatch(html, /没有子文件夹/);
});

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name} displays an offline state rather than an empty list`, () => {
    const html = renderToStaticMarkup(createElement(Component, {
      session, onClose: noop,
    }));
    assert.match(html, /等待连接/);
    assert.match(html, /Resource test/);
    assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
    assert.match(html, /aria-label="刷新" disabled=""/);
    assert.doesNotMatch(html, /没有配置 MCP|本会话没有可用的 MCP|没有可用的 skill/);
  });
}

test('refresh errors and retained data can render together in a detail shell', () => {
  const html = renderToStaticMarkup(createElement(PanelPageShell, {
    title: '资源', onClose: noop,
    children: [
      createElement(ResourceStatus, { key: 'error', status: '加载失败：not allowed', failed: true }),
      createElement('div', { key: 'data' }, 'previous valid data'),
    ],
  }));
  assert.match(html, /role="alert">加载失败：not allowed/);
  assert.match(html, /previous valid data/);
});

test('context shows independent resource status without a false empty result', () => {
  const html = renderToStaticMarkup(createElement(SessionContext, {
    session, onClose: noop,
  }));
  assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
  assert.doesNotMatch(html, /改动文件/);
  assert.match(html, /指令文件和子代理：等待连接/);
  assert.doesNotMatch(html, /本会话还没有上下文/);
});

test('schedules keep creation disabled until their authoritative list is available', () => {
  const html = renderToStaticMarkup(createElement(SessionSchedules, {
    session, onClose: noop,
    onAdd: async () => ({ ok: false }), onStop: async () => ({ ok: false }),
  }));
  assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
  assert.match(html, /等待连接/);
  assert.match(html, /type="submit" class="btn-primary" disabled=""/);
  assert.doesNotMatch(html, /本会话还没有定时任务/);
});

function withSession(t: TestContext, loaded: boolean, connected = true) {
  const state = useCockpit.getInitialState();
  const previous = { ...state };
  Object.assign(state, {
    connState: connected ? 'open' as const : 'connecting' as const,
    sessions: [{ ...session, loaded, status: loaded ? 'idle' as const : 'unloaded' as const }],
  });
  t.after(() => { Object.assign(state, previous); });
}

const nativePages = [
  { name: 'plan', render: () => createElement(SessionPlan, { session, onClose: noop }) },
  { name: 'context', render: () => createElement(SessionContext, { session, onClose: noop }) },
  { name: 'skills', render: () => createElement(SessionSkills, { session, onClose: noop }) },
  { name: 'schedules', render: () => createElement(SessionSchedules, {
    session, onClose: noop, onAdd: async () => ({ ok: false }), onStop: async () => ({ ok: false }),
  }) },
  { name: 'mcp', render: () => createElement(SessionMcp, { session, onClose: noop }) },
];

for (const page of nativePages) {
  test(`${page.name} uses authoritative unloaded state even with a stale loaded prop`, (t) => {
    withSession(t, false);
    const html = renderToStaticMarkup(page.render());
    assert.match(html, /会话未加载。恢复后可查看这些设置/);
    assert.match(html, /聊天历史仍可直接查看/);
    assert.match(html, /class="dialog-btn rp">恢复会话<\/button>/);
    assert.doesNotMatch(html, /本会话还没有任务|本会话还没有上下文|没有可用的 skill|本会话还没有定时任务|本会话没有可用的 MCP|没有配置 MCP/);
    if (page.name === 'context') assert.match(html, /aria-label="刷新" disabled=""/);
    if (page.name === 'skills' || page.name === 'mcp') assert.match(html, /aria-label="刷新" disabled=""/);
    if (page.name === 'schedules') {
      assert.match(html, /aria-label="刷新列表" disabled=""/);
      assert.match(html, /type="submit" class="btn-primary" disabled=""/);
    }
  });

  test(`${page.name} keeps loaded details available without an unnecessary resume prompt`, (t) => {
    withSession(t, true);
    const html = renderToStaticMarkup(page.render());
    assert.doesNotMatch(html, /恢复会话<\/button>|运行时未加载，原生详情暂不可用/);
  });
}

test('unloaded native resource hooks are invalid and explicit refresh cannot issue a detail read', async (t) => {
  withSession(t, false);
  let resource!: ReturnType<typeof useSessionResource<string[]>>;
  function Probe() {
    resource = useSessionResource(session.sessionId, 'native:test', async () => assert.fail('must not read native runtime'));
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(resource.requiresResume, true);
  assert.equal(resource.valid, false);
  assert.equal(resource.pending, false);
  assert.equal(resource.data, undefined);
  assert.equal(resource.status, null);
  assert.equal(await resource.refresh(), false);
});

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name} describes temporary native choices and restoration from Copilot global configuration`, (t) => {
    withSession(t, true);
    const html = renderToStaticMarkup(createElement(Component, { session, onClose: noop }));
    assert.doesNotMatch(html, /manage-scope|Cockpit 不保存或重放选择/);
    const manage = readFileSync(new URL('../components/Manage.tsx', import.meta.url), 'utf8');
    assert.match(manage, /resource.valid && !action.error && !!resource.data\?\.length/);
    assert.match(manage, /重载 MCP 或重新加载会话后采用全局默认/);
    assert.match(manage, /仅本会话临时有效；卸载后重新加载会话时采用全局配置/);
    assert.doesNotMatch(manage, /重载技能|刷新技能定义后/);
  });
}

test('unloaded info settings expose explicit resume rather than global model values', (t) => {
  withSession(t, false);
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session, models: [{ modelId: 'model', name: 'Model' }], open: true, onClose: noop, onSetModel: noop,
  }));
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /恢复会话|加载会话/);
  assert.match(html, /不显示上次读值或全局默认值/);
  assert.doesNotMatch(html, /任务清单|MCP 服务器|置顶会话/);
});

test('resume is disabled offline and after session removal without changing authoritative loaded state', (t) => {
  withSession(t, false, false);
  const render = (sessionId: string) => renderToStaticMarkup(createElement(SessionResume, { sessionId, required: true }));
  assert.match(render(session.sessionId), /disabled="">恢复会话<\/button>/);
  assert.match(render('removed'), /disabled="">恢复会话<\/button>/);
});

test('runtime and schedules explain SDK idle cleanup, paused persisted schedules and detached shells', (t) => {
  withSession(t, false);
  const runtime = renderToStaticMarkup(createElement(SessionRuntime, { session, onClose: noop }));
  assert.match(runtime, /原生运行时空闲 30 分钟后会卸载/);
  assert.match(runtime, /置顶或查看历史不会使运行时常驻/);
  assert.match(runtime, /后台 shell 可能继续运行/);
  assert.match(runtime, /卸载后可能无法再通过任务接口访问/);
  assert.ok(runtime.indexOf('>压缩</button>') < runtime.indexOf('原生运行时空闲'));
  assert.doesNotMatch(runtime, /高级设置|data-permission-policy/);
  assert.match(runtime, /class="dialog-btn rp">恢复会话<\/button>/);
  assert.doesNotMatch(runtime, />重载<\/button>/);
  const schedules = renderToStaticMarkup(nativePages.find((page) => page.name === 'schedules')!.render());
  assert.match(schedules, /任务会保留；卸载期间暂停/);
  assert.match(schedules, /恢复后重新计算执行时间/);
  assert.match(schedules, /定时任务不会让会话常驻/);
});
