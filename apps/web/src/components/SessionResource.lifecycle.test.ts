import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { IntentResult, SessionProjection } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { IntentHttpError } from '../net/client';
import type { ChatSession } from '../net/types';
import { useSessionResource } from '../lib/useSessionResource';
import { useKeyedResource } from '../lib/useKeyedResource';
import { SessionInfoPanel } from './SessionInfoPanel';
import { SessionMcp, SessionSkills } from './Manage';
import { CopyButton } from './CopyButton';
import { ManageWorkspace } from './ManageWorkspace';
import { SessionDetails } from './SessionDetails';

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
  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() { return [1]; }
  closest(selector: string): HostNode | null {
    return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null;
  }
  matches(selector: string): boolean {
    if (selector.includes(', ')) return selector.split(', ').some(part => this.matches(part));
    if (selector.endsWith(':not(:disabled)')) return !this.attributes.has('disabled') && this.matches(selector.slice(0, -15));
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
  nativeModal: HostNode | null = null;
  querySelector(selector: string) { return selector === ':modal' ? this.nativeModal : this.body.querySelector(selector); }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
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
    document, window: Object.assign(new EventTarget(), {
      document, HTMLIFrameElement: class {}, history: { state: null },
      matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    }),
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
    container, document,
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
    session, open: true, onClose: noop, onSetModel: noMutation,
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

for (const section of ['mcp', 'skills'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`global ${section}: A → B → late ${outcome} → A reads catalog without leaking feedback`, async t => {
      const h = mount(t);
      const pending = deferred<void>();
      const values: Record<string, boolean> = { A: false, B: false };
      let reads = 0;
      useCockpit.setState({
        mcpGlobal: async () => { reads++; return Object.entries(values).map(([name, defaultOn]) => ({ name, defaultOn, detail: name })); },
        skillsGlobal: async () => { reads++; return Object.entries(values).map(([name, enabled]) => ({ name, enabled, description: name })); },
        skillsRead: async name => ({ name, enabled: values[name], body: '', description: name }),
        mcpSetDefault: () => pending.promise, skillsSetGlobal: () => pending.promise,
      });
      await h.render(createElement(MemoryRouter, { initialEntries: [`/${section}/A`] },
        createElement(Routes, null, createElement(Route, { path: '/:section/:item?', element: createElement(ManageWorkspace) }))));
      const toggle = () => {
        const control = h.container.querySelector('[role="switch"]');
        assert.ok(control);
        return control;
      };
      assert.equal(toggle().getAttribute('aria-checked'), 'false');
      await h.event(toggle(), 'click');
      await h.event(h.container.querySelectorAll('.manage-row').find(row => row.textContent === 'BB')!, 'click');
      const before = reads;
      await act(async () => {
        // A failed acknowledgement can still follow a committed native write.
        values.A = true;
        if (outcome === 'success') pending.resolve();
        else pending.reject(new Error('obsolete A failure'));
      });
      assert.ok(reads > before, 'the still-mounted catalog reads back either outcome');
      assert.equal(toggle().getAttribute('aria-checked'), 'false', 'B retains its own value');
      assert.doesNotMatch(h.container.textContent, /obsolete A failure|设置失败/);
      await h.event(h.container.querySelectorAll('.manage-row').find(row => row.textContent.startsWith('A'))!, 'click');
      assert.equal(toggle().getAttribute('aria-checked'), 'true', 'returning A sees authoritative readback');
      assert.doesNotMatch(h.container.textContent, /obsolete A failure|设置失败/);
    });
  }

  for (const leave of ['stay', 'unmount', 'reconnect', 'offline'] as const) {
    test(`global ${section}: multiple late results belong to catalog lifetime (${leave})`, async t => {
      const h = mount(t);
      const requests = [deferred<void>(), deferred<void>()];
      let writes = 0;
      let reads = 0;
      useCockpit.setState({
        mcpGlobal: async () => { reads++; return ['A', 'B'].map(name => ({ name, defaultOn: false, detail: name })); },
        skillsGlobal: async () => { reads++; return ['A', 'B'].map(name => ({ name, enabled: false, description: name })); },
        skillsRead: async name => ({ name, enabled: false, body: '', description: name }),
        mcpSetDefault: () => requests[writes++].promise, skillsSetGlobal: () => requests[writes++].promise,
      });
      const workspace = () => createElement(MemoryRouter, { initialEntries: [`/${section}/A`] },
        createElement(Routes, null, createElement(Route, { path: '/:section/:item?', element: createElement(ManageWorkspace) })));
      await h.render(workspace());
      await h.event(h.container.querySelector('[role="switch"]')!, 'click');
      await h.event(h.container.querySelectorAll('.manage-row').find(row => row.textContent === 'BB')!, 'click');
      await h.event(h.container.querySelector('[role="switch"]')!, 'click');
      assert.equal(writes, 2, 'different detail mutations may overlap');
      if (leave === 'unmount') {
        await h.render(null);
        await h.render(workspace());
      }
      if (leave === 'reconnect') await act(async () => useCockpit.setState({ connectionGeneration: 2 }));
      if (leave === 'offline') await act(async () => useCockpit.setState({ connState: 'connecting' }));
      const before = reads;
      await act(async () => { requests[0].resolve(); });
      const afterFirst = reads;
      await act(async () => { requests[1].reject(new Error('late B failure')); });
      if (leave === 'stay') {
        assert.ok(afterFirst > before);
        assert.ok(reads > afterFirst, 'each settlement invalidates, not only the latest request');
        assert.match(h.container.textContent, /late B failure/, 'current detail owns its failure');
      } else {
        assert.equal(reads, before, 'old requests cannot invalidate a remounted or reconnected owner');
        assert.doesNotMatch(h.container.textContent, /late B failure/);
      }
    });
  }
}

for (const desktop of [true, false]) {
  test(`session panel yields Escape and Tab to native modal (${desktop ? 'desktop' : 'narrow'})`, async t => {
    const h = mount(t);
    t.mock.method(window, 'matchMedia', () => Object.assign(new EventTarget(), { matches: desktop }) as MediaQueryList);
    useCockpit.setState({ mcpSession: async () => [] });
    let navigate!: ReturnType<typeof useNavigate>;
    function Panel() {
      navigate = useNavigate();
      return createElement(SessionDetails, { sessionId: session.sessionId, panel: 'mcp' });
    }
    await h.render(createElement(MemoryRouter, { initialEntries: [`/session/${session.sessionId}/mcp`] },
      createElement(Routes, null,
        createElement(Route, { path: '/session/:id/mcp', element: createElement(Panel) }),
        createElement(Route, { path: '/session/:id', element: createElement('div', null, 'closed panel') }))));
    const frame = h.container.querySelector('aside');
    assert.ok(frame);
    const modal = h.document.createElement('dialog');
    h.document.nativeModal = modal;
    modal.focus();
    const key = async (value: string, prevented = false) => {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperty(event, 'key', { value });
      if (prevented) event.preventDefault();
      await act(async () => { window.dispatchEvent(event); });
      return event;
    };
    assert.equal((await key('Tab')).defaultPrevented, false, 'native modal keeps browser Tab handling');
    assert.equal(h.document.activeElement, modal, 'background panel cannot steal modal focus');
    await key('Escape');
    assert.equal(h.container.querySelector('aside'), frame, 'modal Escape cannot navigate the background');
    h.document.nativeModal = null;
    await key('Escape', true);
    assert.equal(h.container.querySelector('aside'), frame, 'claimed Escape remains ignored');
    frame.focus();
    assert.equal((await key('Tab')).defaultPrevented, !desktop, 'original panel Tab behavior remains');
    await key('Escape');
    assert.equal(h.container.textContent, 'closed panel');
    await act(async () => { await navigate(`/session/${session.sessionId}/mcp`); });
    assert.ok(h.container.querySelector('aside'));
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`resource key changes isolate retained data and late ${outcome} without remounting`, async t => {
    const h = mount(t);
    const old = deferred<string>();
    const next = deferred<string>();
    const signals: AbortSignal[] = [];
    let reads = 0;
    let refresh!: () => Promise<boolean>;
    const loads = {
      a: (signal: AbortSignal) => {
        signals.push(signal);
        return ++reads === 1 ? Promise.resolve('accepted a') : old.promise;
      },
      b: () => next.promise,
    };
    function Probe({ owner }: { owner: keyof typeof loads }) {
      const resource = useKeyedResource(owner, loads[owner]);
      refresh = resource.refresh;
      return createElement('div', null, resource.error ?? resource.data ?? 'empty');
    }
    await h.render(createElement(Probe, { owner: 'a' }));
    assert.equal(h.container.textContent, 'accepted a');
    let pending!: Promise<boolean>;
    await act(async () => { pending = refresh(); });
    await h.render(createElement(Probe, { owner: 'a' }));
    assert.equal(reads, 2, 'the same key retains its existing task');
    assert.equal(signals[1].aborted, false);
    assert.equal(h.container.textContent, 'accepted a');

    await h.render(createElement(Probe, { owner: 'b' }));
    assert.equal(signals[1].aborted, true);
    assert.equal(h.container.textContent, 'empty');
    await act(async () => {
      if (outcome === 'success') old.resolve('obsolete a');
      else old.reject(new Error('obsolete a'));
      assert.equal(await pending, false);
    });
    assert.equal(h.container.textContent, 'empty');
    await act(async () => { next.resolve('accepted b'); });
    assert.equal(h.container.textContent, 'accepted b');
  });
}

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
    assert.match(h.container.textContent, /Native model|native-item/);
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
      assert.equal(h.container.querySelector('[data-kind="loading"]'), null, 'retained refresh belongs only to the header');
    }
    assert.ok(controls().every(node => !disabled(node)),
      'healthy same-generation refresh does not lock unrelated rows or interrupt draft editing');
    await act(async () => request.reject(new IntentHttpError('Native session is unloaded', 409, 'SESSION_UNLOADED')));
    assert.equal(useCockpit.getState().sessions[0].loaded, true, 'the fixture reproduces lagging metadata');
    assert.equal(controls().length, 0, 'unloaded resources cannot expose model or toggle values');
    assert.doesNotMatch(h.container.textContent, /Native model|native-item|metadata-model|Metadata model/);
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
    assert.match(h.container.textContent, /Native model|native-item/);
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
    const notice = h.container.querySelector('.manage-row-feedback');
    assert.ok(notice);
    assert.equal(h.container.querySelector(Component === SessionMcp ? '.mcp-operation-status' : '.manage-row-pending')?.textContent, '正在关闭…');
    if (Component === SessionMcp) {
      assert.equal(notice.querySelector('.manage-row-pending'), null);
      assert.equal(notice.querySelector('.manage-row-description')?.getAttribute('aria-hidden'), null);
    }
    assert.equal(h.container.querySelectorAll('.spinner').length, 1);
    const refresh = h.container.querySelector('[aria-label="刷新"]');
    assert.ok(refresh);
    assert.equal(disabled(refresh), true);
    assert.equal(refresh.getAttribute('aria-busy'), 'false', 'a mutation is not a resource read');
    assert.equal(refresh.querySelector('.spinner'), null);
    await h.event(control, 'click');
    assert.equal(calls, 1);
    await act(async () => mutation.reject(new Error('Native toggle rejected')));
    assert.equal(h.container.querySelector('.spinner'), null);
    assert.match(notice.textContent, /未确认：Native toggle rejected/);
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

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name}: overlapping invalidation stays local to the changed row through readback`, async t => {
    const h = mount(t);
    const mutation = deferred<void>();
    const reread = deferred<void>();
    const changed = new Set<string>();
    const calls: string[] = [];
    let hold = false;
    const read = async () => {
      if (hold) await reread.promise;
      return ['one', 'two'].map(name => ({ name, enabled: !changed.has(name), detail: 'native', status: 'connected' as const }));
    };
    useCockpit.setState({
      mcpSession: read, skillsSession: read,
      mcpToggleSession: async (_id, name) => { calls.push(name); await mutation.promise; changed.add(name); },
      skillsToggleSession: async (_id, name) => { calls.push(name); await mutation.promise; changed.add(name); },
    });
    await h.render(createElement(Component, { session, onClose: noop }));
    const [first, second] = h.container.querySelectorAll('[role="switch"]');
    const row = h.container.querySelector('[data-resource-name="one"]')!;
    const other = h.container.querySelector('[data-resource-name="two"]')!;
    const source = row.querySelector('.manage-row-description')!;
    await h.event(first, 'click');
    assert.equal(disabled(first), true);
    assert.equal(disabled(second), Component === SessionMcp, 'MCP is serial; Skills operations are per item');
    await act(async () => {
      hold = true;
      useCockpit.setState({ resourceRevisions: { [session.sessionId]: { mcp: 1, skills: 1 } } });
    });
    assert.equal(h.container.querySelectorAll('.spinner').length, 1, 'only the target row owns loading during a mutation');
    assert.equal(h.container.querySelector('.manage-scope'), null, 'no persistent scope explanation');
    assert.match(row.textContent, /正在关闭/);
    if (Component === SessionMcp) {
      assert.equal(source.textContent, 'native');
      assert.equal(source.getAttribute('aria-hidden'), null);
      assert.equal(row.querySelector('.mcp-operation-status')?.textContent, '正在关闭…');
      assert.doesNotMatch(row.querySelector('.manage-row-name')!.textContent, /已连接/);
    }
    assert.doesNotMatch(other.textContent, /正在关闭|未确认/);
    assert.equal(first.getAttribute('aria-checked'), 'true', 'never use optimistic native state');
    assert.equal(disabled(second), Component === SessionMcp);
    await act(async () => mutation.resolve());
    assert.equal(disabled(first), true, 'the target stays guarded until authoritative readback');
    await act(async () => { hold = false; reread.resolve(); });
    assert.equal(first.getAttribute('aria-checked'), 'false');
    assert.equal(second.getAttribute('aria-checked'), 'true');
    assert.ok(!disabled(first) && !disabled(second));
    assert.equal(h.container.querySelector('.spinner'), null);
    if (Component === SessionMcp) {
      assert.equal(source.textContent, 'native');
      assert.match(row.querySelector('.manage-row-status')!.textContent, /已连接/);
    }
    assert.deepEqual(calls, ['one']);
  });
}

test('Skills supports independent pending rows and keeps an error with its own row', async t => {
  const h = mount(t);
  const one = deferred<void>(), two = deferred<void>();
  const calls: string[] = [];
  const disabledNames = new Set<string>();
  useCockpit.setState({
    skillsSession: async () => ['one', 'two'].map(name => ({ name, enabled: !disabledNames.has(name) })),
    skillsToggleSession: async (_id, name) => {
      calls.push(name);
      await (name === 'one' ? one.promise : two.promise);
      disabledNames.add(name);
    },
  });
  await h.render(createElement(SessionSkills, { session, onClose: noop }));
  const [first, second] = h.container.querySelectorAll('[role="switch"]');
  await h.event(first, 'click');
  await h.event(second, 'click');
  await h.event(first, 'click');
  assert.deepEqual(calls, ['one', 'two']);
  await act(async () => two.reject(new Error('Second skill was rejected')));
  assert.match(h.container.querySelector('[data-resource-name="two"]')!.textContent, /未确认：Second skill was rejected/);
  assert.match(h.container.querySelector('[data-resource-name="one"]')!.textContent, /正在关闭/);
  assert.equal(disabled(first), true);
  assert.equal(disabled(second), false);
  await act(async () => one.resolve());
  assert.equal(first.getAttribute('aria-checked'), 'false');
  assert.equal(second.getAttribute('aria-checked'), 'true');
});

test('MCP honors native busy or settling states after remount, without a local action', async t => {
  const h = mount(t);
  let settling = false;
  useCockpit.setState({
    sessions: [{ ...session, activeMcpOperations: 1 }],
    mcpSession: async () => [{ name: 'one', enabled: true, detail: '', status: settling ? 'pending' : 'connected' }],
    mcpToggleSession: noMutation,
  });

  await h.render(createElement(SessionMcp, { session, onClose: noop }));
  assert.equal(disabled(h.container.querySelector('[role="switch"]')!), true);
  assert.match(h.container.querySelector('[data-resource-name="one"]')!.getAttribute('title')!, /等待完成后再修改/);
  await h.render(null);
  await h.render(createElement(SessionMcp, { session, onClose: noop }));
  assert.equal(disabled(h.container.querySelector('[role="switch"]')!), true);
  await act(async () => {
    settling = true;
    useCockpit.setState({ sessions: [session], resourceRevisions: { [session.sessionId]: { mcp: 1 } } });
  });
  assert.equal(disabled(h.container.querySelector('[role="switch"]')!), true);
  assert.equal(h.container.querySelector('.spinner'), null, 'native settling is not a local request');
});

for (const initiallyEnabled of [false, true]) {
  test(`MCP ${initiallyEnabled ? 'disable' : 'enable'} replaces connection status, never its source`, async t => {
    const h = mount(t);
    const mutation = deferred<void>();
    let enabled = initiallyEnabled;
    useCockpit.setState({
      mcpSession: async () => [{ name: 'native-server', enabled, detail: 'builtin',
        status: enabled ? 'connected' : 'disabled' }],
      mcpToggleSession: async (_id, _name, next) => { await mutation.promise; enabled = next; },
    });
    await h.render(createElement(SessionMcp, { session, onClose: noop }));
    const row = h.container.querySelector('[data-resource-name="native-server"]')!;
    const source = row.querySelector('.manage-row-description')!;
    await h.event(row.querySelector('[role="switch"]')!, 'click');
    assert.equal(source.textContent, 'builtin');
    assert.equal(source.getAttribute('aria-hidden'), null);
    assert.equal(row.querySelector('.mcp-operation-status')?.textContent, initiallyEnabled ? '正在关闭…' : '正在开启…');
    assert.equal(row.querySelector('.manage-row-pending'), null);
    assert.equal(h.container.querySelectorAll('.spinner').length, 1);
    await act(async () => mutation.resolve());
    assert.equal(row.querySelector('.manage-row-status')?.textContent, initiallyEnabled ? '已关闭' : '已连接');
    assert.equal(row.querySelector('.manage-row-description'), source);
    assert.equal(source.textContent, 'builtin');
  });
}

test('late toggles cannot trigger readback or feedback in a replaced page', async t => {
  const h = mount(t);
  const mutation = deferred<void>();
  let reads = 0;
  useCockpit.setState({
    skillsSession: async () => { reads++; return [{ name: 'one', enabled: true }]; },
    skillsToggleSession: async () => mutation.promise,
  });
  await h.render(createElement(SessionSkills, { session, onClose: noop }));
  await h.event(h.container.querySelector('[role="switch"]')!, 'click');
  await h.render(null);
  await h.render(createElement(SessionSkills, { session, onClose: noop }));
  assert.equal(reads, 2);
  await act(async () => mutation.resolve());
  assert.equal(reads, 2, 'old owner must not start a fresh read');
  assert.doesNotMatch(h.container.textContent, /正在关闭|未确认/);
});

test('unavailable and reconnecting resources cannot reuse accepted values as usable', async t => {
  const h = mount(t);
  const next = deferred<string[]>();
  let reads = 0;
  let resource!: ReturnType<typeof useSessionResource<string[]>>;
  const load = async () => ++reads === 1 ? ['initial'] : next.promise;
  function Probe() { resource = useSessionResource(session.sessionId, 'usable', load); return null; }
  await h.render(createElement(Probe));
  assert.equal(resource.usable, true);
  await act(async () => useCockpit.setState({ sessions: [{ ...session, closing: true }] }));
  assert.equal(resource.usable, false);
  await act(async () => useCockpit.setState({ sessions: [session] }));
  assert.equal(resource.pending, true);
  assert.equal(resource.usable, false, 'reenabling a resource requires a new read even in the same connection');
  await act(async () => next.resolve(['fresh']));
  assert.equal(resource.usable, true);
  await act(async () => useCockpit.setState({ connState: 'connecting', connectionGeneration: 2 }));
  assert.equal(resource.usable, false);
});

test('a successful write with failed readback stays unconfirmed and does not enable stale toggles', async t => {
  const h = mount(t);
  let reads = 0, writes = 0;
  useCockpit.setState({
    skillsSession: async () => {
      if (++reads > 1) throw new Error('Native read unavailable');
      return [{ name: 'one', enabled: true }];
    },
    skillsToggleSession: async () => { writes++; },
  });
  await h.render(createElement(SessionSkills, { session, onClose: noop }));
  await h.event(h.container.querySelector('[role="switch"]')!, 'click');
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  assert.match(h.container.textContent, /未能读取最新状态/);
  assert.match(h.container.textContent, /加载失败：Native read unavailable/);
  const toggle = h.container.querySelector('[role="switch"]')!;
  assert.equal(toggle.getAttribute('aria-checked'), 'true', 'a stale value is not an optimistic success');
  assert.equal(disabled(toggle), true);
  assert.equal(h.container.querySelector('.spinner'), null);
});

test('failed old-generation writes never refresh or overwrite a reconnected page', async t => {
  const h = mount(t);
  const mutation = deferred<void>();
  let reads = 0;
  useCockpit.setState({
    skillsSession: async () => { reads++; return [{ name: 'one', enabled: true }]; },
    skillsToggleSession: async () => mutation.promise,
  });
  await h.render(createElement(SessionSkills, { session, onClose: noop }));
  await h.event(h.container.querySelector('[role="switch"]')!, 'click');
  await act(async () => useCockpit.setState({ connState: 'connecting', connectionGeneration: 2 }));
  await act(async () => useCockpit.setState({ connState: 'open', connectionGeneration: 3 }));
  assert.equal(reads, 2);
  await act(async () => mutation.reject(new Error('Obsolete failure')));
  assert.equal(reads, 2);
  assert.doesNotMatch(h.container.textContent, /Obsolete failure|正在关闭/);
  assert.equal(disabled(h.container.querySelector('[role="switch"]')!), false);
});

test('model Apply has a pending label and busy state while preserving native result diagnostics', async t => {
  const h = mount(t);
  const read = deferred<SessionProjection>();
  const result = deferred<IntentResult<'setModel'>>();
  let mutations = 0;
  useCockpit.setState({ getResources: () => read.promise });
  await h.render(createElement(SessionInfoPanel, {
    session, open: true, onClose: noop,
    onSetModel: async () => { mutations++; return result.promise; },
  }));
  assert.equal(disabled(button(h.container, '应用配置')), true, 'metadata cannot enable Apply before the read');
  await h.event(button(h.container, '应用配置'), 'click');
  assert.equal(mutations, 0);
  await act(async () => read.resolve(modelData));
  const apply = button(h.container, '应用配置');
  assert.equal(disabled(apply), false);
  await h.event(apply, 'click');
  const pending = button(h.container, '正在提交…');
  assert.equal(disabled(pending), true);
  assert.equal(pending.getAttribute('aria-busy'), 'true');
  await h.event(pending, 'click');
  assert.equal(mutations, 1);
  await act(async () => result.resolve({ ok: true, result: { status: 'applied', persistenceError: 'Native save failed' } }));
  assert.equal(button(h.container, '应用配置').getAttribute('aria-busy'), 'false');
  assert.match(h.container.textContent, /已应用，但原生持久化失败：Native save failed/);
  assert.equal(disabled(button(h.container, '应用配置')), true, 'the same revision is not resubmitted');
});

test('session ID copies its exact value and retains confirmation without a restoration timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = mount(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async (text: string) => { copied.push(text); } },
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : Reflect.deleteProperty(globalThis, 'navigator'));
  useCockpit.setState({ getResources: async () => modelData });
  await h.render(createElement(SessionInfoPanel, {
    session, open: true, onClose: noop, onSetModel: noMutation,
  }));
  const copy = h.container.querySelector('[aria-label="复制 session ID"]');
  assert.ok(copy);
  assert.equal(copy.textContent, session.sessionId);
  assert.equal(copy.querySelector('.ck-icon'), null, 'the ID itself is the target, not an extra copy icon');
  await h.event(copy, 'click');
  assert.deepEqual(copied, [session.sessionId]);
  assert.match(copy.textContent, /已复制/);
  assert.equal(copy.querySelector('.copy-value-text')?.getAttribute('aria-hidden'), 'true');
  await act(async () => t.mock.timers.tick(10_000));
  assert.equal(copy.querySelector('.copy-value-feedback')?.textContent, '已复制');
  assert.equal(copy.querySelector('.copy-value-text')?.getAttribute('aria-hidden'), 'true');
  assert.equal(h.container.querySelector('.chat-sr-only')?.textContent, '已复制');
  await h.event(copy, 'click');
  assert.deepEqual(copied, [session.sessionId, session.sessionId], 'the confirmation still copies the original ID');
  assert.doesNotMatch(h.container.textContent, /工具权限|allow-all|交由原生处理/);
});

test('copy feedback is scoped to the value and fresh mounts start unconfirmed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = mount(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const request = deferred<void>();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async () => request.promise },
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : Reflect.deleteProperty(globalThis, 'navigator'));
  const render = (text: string, variant: 'value' | 'button' = 'value') =>
    h.render(createElement(CopyButton, { text, variant, label: 'Copy value' }));
  await render('first');
  await h.event(h.container.querySelector('button')!, 'click');
  assert.equal(h.container.querySelector('button')?.textContent, 'first', 'value copying does not flash an intermediate progress label');
  await render('second');
  await act(async () => request.resolve());
  assert.equal(h.container.querySelector('button')?.textContent, 'second', 'old content cannot show a new value as copied');
  await h.event(h.container.querySelector('button')!, 'click');
  assert.match(h.container.textContent, /已复制/);
  await render('replacement');
  assert.equal(h.container.querySelector('button')?.textContent, 'replacement');
  assert.equal(h.container.querySelector('.copy-value-feedback'), null);
  await h.render(null);
  await render('third');
  await act(async () => t.mock.timers.tick(2000));
  assert.equal(h.container.querySelector('button')?.textContent, 'third');
  await h.render(null);
  await render('code', 'button');
  await h.event(h.container.querySelector('button')!, 'click');
  await act(async () => t.mock.timers.tick(2000));
  assert.equal(h.container.querySelector('.chat-copy-label-text')?.textContent, '已复制', 'existing code/tool copy behavior stays unchanged');
});

test('copy retains its visible label while pending, prevents duplicate writes and reports failures explicitly', async t => {
  const h = mount(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const requests: ReturnType<typeof deferred<void>>[] = [];
  const texts: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: (text: string) => {
      const request = deferred<void>();
      requests.push(request); texts.push(text);
      return request.promise;
    } },
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : Reflect.deleteProperty(globalThis, 'navigator'));
  await h.render(createElement(CopyButton, { text: '  exact code\n', label: 'Copy code' }));
  const target = h.container.querySelector('button')!;
  const label = h.container.querySelector('.chat-copy-label-text')!;
  assert.equal(label.textContent, '复制');
  assert.equal(h.container.querySelector('.chat-copy-label-size')?.getAttribute('aria-hidden'), 'true');
  await h.event(target, 'click');
  await h.event(target, 'click');
  assert.equal(requests.length, 1);
  assert.equal(label.textContent, '复制', 'fast writes never flash an intermediate progress label');
  assert.equal(target.getAttribute('aria-busy'), 'true');
  assert.equal(target.getAttribute('aria-disabled'), 'true');
  await act(async () => requests[0].resolve());
  assert.equal(label.textContent, '已复制');
  assert.equal(target.getAttribute('aria-busy'), null);
  await h.event(target, 'click');
  assert.equal(label.textContent, '已复制', 'repeated copies retain the previous confirmation');
  await act(async () => requests[1].resolve());
  assert.equal(label.textContent, '已复制');
  await h.event(target, 'click');
  await act(async () => requests[2].reject(new Error('Clipboard denied')));
  assert.equal(label.textContent, '复制');
  assert.match(h.container.querySelector('.chat-copy-error')!.textContent, /复制失败/);
  await h.event(target, 'click');
  assert.equal(h.container.querySelector('.chat-copy-error'), null);
  await act(async () => requests[3].resolve());
  assert.equal(label.textContent, '已复制');
  assert.deepEqual(texts, Array(4).fill('  exact code\n'));
  assert.equal(h.container.querySelector('button'), target);
  assert.equal(h.container.querySelector('.chat-copy-label-text'), label);
});
