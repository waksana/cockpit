import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSession, ModelOption } from '../net/types';
import { SessionMcp, SessionSkills } from '../components/Manage';
import { PanelPageShell } from '../components/PanelPage';
import { SessionResume } from '../components/SessionResume';
import { ResourceStatus } from '../components/StateNotice';
import { useCockpit } from '../net/store';
import { useSessionResource } from './useSessionResource';

const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.scss') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { DirPicker } = await import('../components/DirPicker');
const { SessionInfoPanel } = await import('../components/SessionInfoPanel');
styles.deregister();

const noop = () => {};
const noModelMutation = async () => { assert.fail('Rendering must not change native model settings'); };
function composerWindow(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
}
const session = {
  sessionId: 'resource-test', title: 'Resource test', cwd: '/work/project', messages: [], queue: [],
  status: 'idle', error: null, loaded: true, ask: null, lastActivity: 0,
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
} as ChatSession;

test('closed info panel has no hidden focus targets or mounted navigation', () => {
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session, open: false, onClose: noop, onSetModel: noModelMutation,
  }));
  assert.equal(html, '');
});

test('open info panel identifies its session without cross-page navigation', () => {
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session, open: true, onClose: noop, onSetModel: noModelMutation,
  }));
  assert.match(html, /会话设置/);
  assert.match(html, /Resource test/);
  assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
  assert.doesNotMatch(html, /allow-all|工具权限/);
  assert.match(html, /aria-label="复制 session ID"/);
  assert.doesNotMatch(html, /交互模式/);
});

test('joined role badges show literal module and role names, not readiness', () => {
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session: { ...session, roles: [{ moduleId: 'fixture', roleId: 'owner', moduleName: 'Fixture', name: 'Owner' }] },
    open: true, onClose: noop, onSetModel: noModelMutation,
  }));
  assert.match(html, /class="module-label-name">Fixture</);
  assert.match(html, /class="role-badge-name">Owner</);
  assert.match(html, /不代表当前能力就绪/);
  assert.doesNotMatch(html, /读取时就绪|role-readiness|readiness-badge/);
});

const modelOptions: ModelOption[] = [
  { modelId: 'alpha', name: 'Alpha', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', supportsLongContext: true },
  { modelId: 'beta', name: 'Beta', supportedReasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'high', supportsLongContext: true },
  { modelId: 'basic', name: 'Basic' },
];
const renderModelSettings = (patch: Partial<ChatSession>, models = modelOptions) => {
  const state = useCockpit.getInitialState();
  const previous = state.sessions;
  const current = { ...session, availableModels: models, ...patch };
  state.sessions = [current];
  try {
    return renderToStaticMarkup(createElement(SessionInfoPanel, {
      session: current, open: true, onClose: noop,
      onSetModel: () => { assert.fail('Rendering confirmed values must never mutate them'); },
    }));
  } finally { state.sessions = previous; }
};
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
  assert.equal(fallback.text, '未指定');
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
  assert.match(html, /aria-label="思考力度：极高"/);
  assert.match(html, /aria-label="上下文：长上下文"/);
  assert.doesNotMatch(html, /原生未提供思考力度选项|原生未提供上下文档位能力/);
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
      assert.equal(selected.options.length, 3);
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
    assert.equal(selected.text, '未指定');
  }
  const withoutDefault = selectedOption(renderModelSettings({ currentModelId: 'beta' }, [{
    ...modelOptions[1], defaultReasoningEffort: undefined,
  }]), '思考力度');
  assert.equal(withoutDefault.text, '未指定');
  const html = renderModelSettings({ currentModelId: 'beta' });
  assert.match(html, /未指定/);
  assert.doesNotMatch(html, /原生默认 \/ 重置|不保留旧值/);
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
      : currentContextTier === 'default' ? '标准上下文' : '未指定');
  }
});

test('settings omit permission controls and rendering does not mutate the store', () => {
  const before = useCockpit.getState();
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session, open: true, onClose: noop, onSetModel: noModelMutation,
  }));
  assert.doesNotMatch(html, /工具权限|allow-all|自动批准|交互模式/);
  assert.equal(useCockpit.getState(), before);
});

test('directory picker without an initial path has no hardcoded home and cannot create before a listing', t => {
  composerWindow(t);
  const html = renderToStaticMarkup(createElement(DirPicker, {
    onCreate: async () => { throw new Error('render must not create a session'); }, onCreated: noop, onCancel: noop,
  }));
  assert.match(html, /<dialog[^>]*class="dialog-scrim directory-modal host-modal ck-modal"[^>]*aria-labelledby="[^"]+"/);
  assert.match(html, /<h3[^>]*tabindex="-1"[^>]*data-dialog-focus="true">新建会话<\/h3>/);
  assert.match(html, /选择工作目录，按需添加模块角色。/);
  assert.match(html, /aria-label="当前路径"/);
  assert.doesNotMatch(html, /dirpicker-help|创建说明|创建后暂不支持追加角色/);
  assert.doesNotMatch(html, /\/home\/honglai|没有子文件夹/);
  assert.match(html, /class="ck-button ck-primary" disabled=""[^>]*>创建会话/);
  assert.match(html, /等待连接/);
});

test('a supplied but unvalidated directory cannot enable session creation', t => {
  composerWindow(t);
  const html = renderToStaticMarkup(createElement(DirPicker, {
    initialPath: '/unvalidated', onCreate: async () => { throw new Error('render must not create a session'); },
    onCreated: noop, onCancel: noop,
  }));
  assert.match(html, /value="\/unvalidated"/);
  assert.match(html, /class="ck-button ck-primary" disabled=""[^>]*>创建会话/);
  assert.doesNotMatch(html, /没有子文件夹/);
});

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name} displays an offline state rather than an empty list`, () => {
    const html = renderToStaticMarkup(createElement(Component, {
      session, onClose: noop,
    }));
    assert.match(html, /等待连接/);
    assert.match(html, Component === SessionMcp ? /title="本会话 MCP"/ : /title="本会话 Skills"/);
    assert.doesNotMatch(html, /Resource test/, 'the standalone header does not append the session title');
    assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
    assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="刷新"/);
    assert.doesNotMatch(html, /没有配置 MCP|本会话没有可用的 MCP|未发现技能/);
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
  assert.match(html, /role="alert"><div class="state-notice-content">加载失败：not allowed/);
  assert.match(html, /previous valid data/);
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
  { name: 'skills', render: () => createElement(SessionSkills, { session, onClose: noop }) },
  { name: 'mcp', render: () => createElement(SessionMcp, { session, onClose: noop }) },
];

for (const page of nativePages) {
  test(`${page.name} uses authoritative unloaded state even with a stale loaded prop`, (t) => {
    withSession(t, false);
    const html = renderToStaticMarkup(page.render());
    assert.match(html, /会话未加载。恢复后可查看这些设置/);
    assert.match(html, /聊天历史仍可直接查看/);
    assert.match(html, /class="session-resume-action ck-button" aria-busy="false" aria-describedby="[^"]+">恢复会话<\/button>/);
    assert.match(html, /class="session-resume ck-surface" role="group" aria-label="会话未加载"/);
    assert.doesNotMatch(html, /没有可用的 skill|本会话没有可用的 MCP|没有配置 MCP/);
    assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="刷新"/);
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
    resource = useSessionResource<string[]>(session.sessionId, 'native:test', async () => assert.fail('must not read native runtime'));
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
  test(`${Component.name} omits persistent scope explanations without changing native calls`, (t) => {
    withSession(t, true);
    const html = renderToStaticMarkup(createElement(Component, { session, onClose: noop }));
    assert.doesNotMatch(html, /manage-scope|Cockpit 不保存或重放选择/);
  });
}

test('unloaded info settings expose explicit resume rather than stale model values', (t) => {
  withSession(t, false);
  const html = renderToStaticMarkup(createElement(SessionInfoPanel, {
    session: { ...session, availableModels: [{ modelId: 'model', name: 'Model' }] },
    open: true, onClose: noop, onSetModel: noModelMutation,
  }));
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /恢复会话|加载会话/);
  assert.doesNotMatch(html, /info-model-current|info-select/);
  assert.doesNotMatch(html, /任务清单|MCP 服务器|置顶会话/);
});

test('resume is disabled offline and after session removal without changing authoritative loaded state', (t) => {
  withSession(t, false, false);
  const render = (sessionId: string) => renderToStaticMarkup(createElement(SessionResume, { sessionId, required: true }));
  assert.match(render(session.sessionId), /disabled="" aria-busy="false" aria-describedby="[^"]+">恢复会话<\/button>/);
  assert.match(render('removed'), /disabled="" aria-busy="false" aria-describedby="[^"]+">恢复会话<\/button>/);
});
