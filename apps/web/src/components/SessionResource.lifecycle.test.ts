import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { IntentResult, SessionProjection } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { IntentHttpError } from '../net/client';
import type { ChatSession } from '../net/types';
import { useSessionResource } from '../lib/useSessionResource';
import { SessionInfoPanel } from './SessionInfoPanel';
import { SessionMcp, SessionSkills } from './Manage';

// The same deterministic React DOM host as Thread.lifecycle, limited to the
// controls these panels use. Reads and mutations stay in fixture-owned stores.
class HostNode extends EventTarget {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  ownerDocument: HostDocument;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  parentNode: HostNode | null = null;
  childNodes: HostNode[] = [];
  attributes = new Map<string, string>();
  style = { setProperty() {}, removeProperty() {} };
  selected = false;
  private text = '';
  constructor(tag: string, ownerDocument: HostDocument) {
    super();
    this.nodeName = this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nodeValue() { return this.text; }
  set nodeValue(text: string) { this.text = text; }
  get textContent(): string { return this.text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text: string) {
    this.text = text;
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
  }
  get options() { return this.childNodes; }
  get value(): string {
    return this.tagName === 'SELECT' ? this.options.find(option => option.selected)?.value ?? ''
      : this.getAttribute('value') ?? this.textContent;
  }
  set value(value: string) {
    for (const option of this.options) option.selected = option.value === value;
  }
  appendChild(node: HostNode) { return this.insertBefore(node, null); }
  insertBefore(node: HostNode, before: HostNode | null) {
    node.parentNode?.removeChild(node);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: HostNode) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return (this.getAttribute('class') ?? '').split(' ').includes(selector.slice(1));
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    return match ? this.attributes.has(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2])
      : this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector: string): HostNode[] {
    return this.childNodes.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

class HostDocument extends EventTarget {
  nodeType = 9;
  documentElement = new HostNode('html', this);
  body = new HostNode('body', this);
  activeElement = this.body;
  createElement(tag: string) { return new HostNode(tag, this); }
  createElementNS(_namespace: string, tag: string) { return this.createElement(tag); }
  createTextNode(text: string) {
    const node = new HostNode('#text', this);
    node.nodeType = 3;
    node.textContent = text;
    return node;
  }
}

function mount(t: TestContext) {
  const document = new HostDocument();
  const globals = {
    document, window: Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }),
    Element: HostNode, HTMLElement: HostNode, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const restore: (() => void)[] = [];
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    restore.push(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Resource fixtures must not access a backend'));
  const state = useCockpit.getState();
  useCockpit.setState({ connState: 'open', connectionGeneration: 1, sessions: [session], resourceRevisions: {} });
  const container = document.createElement('div');
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    useCockpit.setState(state, true);
    for (const reset of restore) reset();
  });
  return {
    container,
    render: (children: ReactNode) => act(async () => root.render(children)),
    event: (node: HostNode, type: string) => act(async () => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'target', { value: node });
      container.dispatchEvent(event);
    }),
  };
}

const session: ChatSession = {
  sessionId: 'resource-lifecycle', title: 'Fixture session', cwd: '/fixture', loaded: true,
  status: 'idle', error: null, queue: [], ask: null, lastActivity: 0, messages: [],
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
  currentModelId: 'metadata-model', availableModels: [{ modelId: 'metadata-model', name: 'Metadata model' }],
};
const modelData: SessionProjection = {
  sessionId: session.sessionId, loaded: true, currentModelId: 'native-model',
  availableModels: [{ modelId: 'native-model', name: 'Native model', supportedReasoningEfforts: ['high'], supportsLongContext: true }],
};
const noop = () => {};
const noMutation = async () => assert.fail('No native mutation expected');
const pages = [
  { name: 'info', render: () => createElement(SessionInfoPanel, {
    session, models: [], open: true, onClose: noop, onSetModel: noMutation,
  }) },
  { name: 'mcp', render: () => createElement(SessionMcp, { session, onClose: noop }) },
  { name: 'skills', render: () => createElement(SessionSkills, { session, onClose: noop }) },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function button(container: HostNode, text: string) {
  const result = container.querySelectorAll('button').find(node => node.textContent === text);
  assert.ok(result, `Missing button: ${text}`);
  return result;
}
function disabled(node: HostNode) { return node.attributes.has('disabled'); }

for (const page of pages) {
  test(`${page.name}: closing is explicit, with reads, refresh and model actions disabled`, async t => {
    const h = mount(t);
    useCockpit.setState({
      sessions: [{ ...session, closing: true }],
      getResources: noMutation, mcpSession: noMutation, skillsSession: noMutation, loadSession: noMutation,
    });
    await h.render(page.render());
    assert.match(h.container.textContent, /会话正在关闭，等待关闭完成/);
    assert.equal(h.container.querySelector('.spinner'), null, 'closing is not a resource read');
    assert.doesNotMatch(h.container.textContent, /没有可用的|本会话没有|加载失败/);
    for (const node of h.container.querySelectorAll('select')) assert.equal(disabled(node), true);
    for (const node of h.container.querySelectorAll('.dialog-btn')) {
      assert.equal(disabled(node), true);
      await h.event(node, 'click');
    }
    const refresh = h.container.querySelector('[aria-label="刷新"]');
    if (page.name !== 'info') {
      assert.ok(refresh);
      assert.equal(disabled(refresh), true);
      assert.equal(refresh.getAttribute('aria-busy'), 'false');
      assert.equal(h.container.querySelector('[data-kind="info"]')?.getAttribute('data-placement'), 'pane');
      await h.event(refresh, 'click');
    }
    await act(async () => useCockpit.setState({ sessions: [{ ...session, loaded: false, closing: true }] }));
    const resume = button(h.container, '恢复会话');
    assert.equal(disabled(resume), true);
    await h.event(resume, 'click');
  });

  test(`${page.name}: native unload hides accepted values and explicit resume rereads despite loaded metadata`, async t => {
    const h = mount(t);
    const request = deferred<void>();
    let reads = 0;
    let resumes = 0;
    const read = async () => { if (++reads === 2) await request.promise; };
    useCockpit.setState({
      getResources: async () => { await read(); return modelData; },
      mcpSession: async () => { await read(); return [{ name: 'native-item', detail: '', status: 'connected', enabled: true }]; },
      skillsSession: async () => { await read(); return [{ name: 'native-item', enabled: true }]; },
      loadSession: async () => { resumes++; },
    });
    await h.render(page.render());
    assert.equal(reads, 1);
    assert.match(h.container.textContent, /native-model|native-item/);
    const controls = () => [...h.container.querySelectorAll('select'), ...h.container.querySelectorAll('[role="switch"]')];
    assert.ok(controls().length > 0);
    assert.ok(controls().every(node => !disabled(node)));
    await act(async () => useCockpit.setState({
      resourceRevisions: { [session.sessionId]: { model: 1, models: 1, mcp: 1, skills: 1 } },
    }));
    assert.equal(reads, 2);
    assert.ok(h.container.querySelector('.spinner'), 'pending uses the real resource pending flag');
    const pendingRefresh = h.container.querySelector('[aria-label="刷新"]');
    if (pendingRefresh) {
      assert.equal(pendingRefresh.getAttribute('aria-busy'), 'true');
      assert.ok(pendingRefresh.querySelector('.spinner'));
      assert.equal(h.container.querySelector('[data-kind="loading"]')?.getAttribute('data-placement'), 'inline');
    }
    assert.ok(controls().every(disabled));
    await act(async () => request.reject(new IntentHttpError('Native session is unloaded', 409, 'SESSION_UNLOADED')));
    assert.equal(useCockpit.getState().sessions[0].loaded, true, 'the fixture reproduces lagging metadata');
    assert.equal(controls().length, 0, 'unloaded resources cannot expose model or toggle values');
    assert.doesNotMatch(h.container.textContent, /native-model|native-item|metadata-model|Metadata model/);
    assert.match(h.container.textContent, /会话未加载/);
    assert.equal(h.container.querySelector('.spinner'), null);
    const refresh = h.container.querySelector('[aria-label="刷新"]');
    if (refresh) {
      assert.equal(disabled(refresh), true);
      assert.equal(refresh.getAttribute('aria-busy'), 'false');
      assert.equal(refresh.querySelector('.spinner'), null);
    }
    await act(async () => useCockpit.setState({
      resourceRevisions: { [session.sessionId]: { model: 2, models: 2, mcp: 2, skills: 2 } },
    }));
    assert.equal(reads, 2, 'resource invalidation must not retry an unloaded read');
    const resume = button(h.container, '恢复会话');
    assert.equal(disabled(resume), false);
    await h.event(resume, 'click');
    assert.equal(resumes, 1);
    assert.equal(reads, 3, 'successful explicit resume refreshes the existing owner');
    assert.ok(controls().length > 0);
    assert.ok(controls().every(node => !disabled(node)));
    assert.match(h.container.textContent, /native-model|native-item/);
    assert.doesNotMatch(h.container.textContent, /会话未加载/);
  });
}

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name}: an initial resource read uses pane placement without claiming an empty list`, async t => {
    const h = mount(t);
    const request = deferred<void>();
    useCockpit.setState({
      mcpSession: async () => { await request.promise; return []; },
      skillsSession: async () => { await request.promise; return []; },
    });
    await h.render(createElement(Component, { session, onClose: noop }));
    const notice = h.container.querySelector('[data-kind="loading"]');
    assert.ok(notice);
    assert.equal(notice.getAttribute('data-placement'), 'pane');
    assert.match(notice.textContent, /加载中/);
    assert.doesNotMatch(h.container.textContent, /本会话没有可用的 MCP|没有可用的 skill/);
    await act(async () => request.resolve());
    assert.equal(h.container.querySelector('[data-kind="loading"]'), null);
    assert.match(h.container.textContent, /本会话没有可用的 MCP|没有可用的 skill/);
  });

  test(`${Component.name}: toggles show pending without optimistic values or a false refresh spinner`, async t => {
    const h = mount(t);
    const mutation = deferred<never>();
    let calls = 0;
    const toggle = async () => { calls++; return mutation.promise; };
    useCockpit.setState({
      mcpSession: async () => [{ name: 'native-item', detail: '', status: 'connected', enabled: true }],
      skillsSession: async () => [{ name: 'native-item', enabled: true }],
      mcpToggleSession: toggle, skillsToggleSession: toggle,
    });
    await h.render(createElement(Component, { session, onClose: noop }));
    const control = h.container.querySelector('[role="switch"]');
    assert.ok(control);
    await h.event(control, 'click');
    assert.equal(calls, 1);
    assert.equal(disabled(control), true);
    assert.equal(control.getAttribute('aria-checked'), 'true', 'no optimistic native value');
    const notice = h.container.querySelector('[data-kind="loading"]');
    assert.ok(notice);
    assert.equal(notice.textContent, '正在提交…');
    const refresh = h.container.querySelector('[aria-label="刷新"]');
    assert.ok(refresh);
    assert.equal(disabled(refresh), true);
    assert.equal(refresh.getAttribute('aria-busy'), 'false', 'a mutation is not a resource read');
    assert.equal(refresh.querySelector('.spinner'), null);
    await h.event(control, 'click');
    assert.equal(calls, 1);
    await act(async () => mutation.reject(new Error('Native toggle rejected')));
    assert.equal(h.container.querySelector('[data-kind="loading"]'), null);
    assert.match(h.container.textContent, /操作失败：Native toggle rejected/);
    assert.equal(control.getAttribute('aria-checked'), 'true');
    assert.equal(disabled(control), false);
    assert.equal(calls, 1, 'native rejection does not trigger an automatic retry');
  });
}

test('resource owner aborts closing reads and rejects their late values without changing ordinary stale retention', async t => {
  const h = mount(t);
  const held = deferred<string[]>();
  let signal!: AbortSignal;
  let reads = 0;
  const load = async (nextSignal: AbortSignal) => {
    signal = nextSignal;
    reads++;
    return reads === 1 ? ['accepted'] : reads === 2 ? held.promise : ['fresh'];
  };
  let resource!: ReturnType<typeof useSessionResource<string[]>>;
  function Probe() {
    resource = useSessionResource(session.sessionId, 'resource-owner', load);
    return null;
  }
  await h.render(createElement(Probe));
  assert.equal(resource.valid, true);
  let refresh!: Promise<boolean>;
  await act(async () => { refresh = resource.refresh(); });
  assert.equal(resource.pending, true);
  assert.deepEqual(resource.data, ['accepted']);
  await act(async () => held.reject(new Error('Ordinary failure')));
  assert.equal(await refresh, false);
  assert.deepEqual(resource.data, ['accepted']);
  assert.equal(resource.failed, true);
  const closingRead = deferred<string[]>();
  await act(async () => { refresh = resource.refresh(async nextSignal => { signal = nextSignal; return closingRead.promise; }); });
  await act(async () => useCockpit.setState({ sessions: [{ ...session, closing: true }] }));
  assert.equal(signal.aborted, true);
  assert.equal(resource.closing, true);
  assert.equal(resource.valid, false);
  assert.equal(resource.pending, false);
  assert.equal(resource.data, undefined);
  assert.match(resource.status ?? '', /会话正在关闭/);
  assert.equal(await resource.refresh(), false);
  await act(async () => closingRead.resolve(['obsolete']));
  assert.equal(await refresh, false);
  assert.equal(resource.data, undefined);
  await act(async () => useCockpit.setState({ sessions: [session] }));
  assert.equal(resource.valid, true);
  assert.deepEqual(resource.data, ['fresh']);
});

test('model Apply has a pending label and busy state while preserving native result diagnostics', async t => {
  const h = mount(t);
  const read = deferred<SessionProjection>();
  const result = deferred<IntentResult<'setModel'>>();
  let mutations = 0;
  useCockpit.setState({ getResources: () => read.promise });
  await h.render(createElement(SessionInfoPanel, {
    session, models: [], open: true, onClose: noop,
    onSetModel: async () => { mutations++; return result.promise; },
  }));
  assert.equal(disabled(button(h.container, '应用配置')), true, 'metadata cannot enable Apply before the read');
  await h.event(button(h.container, '应用配置'), 'click');
  assert.equal(mutations, 0);
  await act(async () => read.resolve(modelData));
  const apply = button(h.container, '应用配置');
  assert.equal(disabled(apply), false);
  await h.event(apply, 'click');
  const pending = button(h.container, '正在应用…');
  assert.equal(disabled(pending), true);
  assert.equal(pending.getAttribute('aria-busy'), 'true');
  await h.event(pending, 'click');
  assert.equal(mutations, 1);
  await act(async () => result.resolve({ ok: true, result: { status: 'applied', persistenceError: 'Native save failed' } }));
  assert.equal(button(h.container, '应用配置').getAttribute('aria-busy'), 'false');
  assert.match(h.container.textContent, /已应用，但原生持久化失败：Native save failed/);
  assert.equal(disabled(button(h.container, '应用配置')), true, 'the same revision is not resubmitted');
});
