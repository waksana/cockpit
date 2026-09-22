import assert from '../test/identityAssert';
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
import { ModelControls, SessionInfoPanel } from './SessionInfoPanel';
import { SessionRoles } from './SessionRoles';
import { Sidebar } from './Sidebar';
import { SessionMcp, SessionSkills } from './Manage';
import { CopyButton } from './CopyButton';
import { ManageWorkspace } from './ManageWorkspace';
import { SessionDetails } from './SessionDetails';
import { ExpandableText } from './SessionPanelKit';
import { GlobalNavigation } from './GlobalNavigation';

// The same deterministic React DOM host as Thread.lifecycle, limited to the
// controls these panels use. Reads and mutations stay in fixture-owned stores.
class HostNode extends EventTarget {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  ownerDocument: HostDocument;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  type = '';
  checked = false;
  parentNode: HostNode | null = null;
  childNodes: HostNode[] = [];
  attributes = new Map<string, string>();
  style = { setProperty() {}, removeProperty() {} };
  private selectedValue = false;
  get selected() { return this.selectedValue; }
  set selected(value: boolean) {
    if (value && this.tagName === 'OPTION') {
      for (const sibling of this.parentNode?.childNodes ?? []) sibling.selectedValue = false;
    }
    this.selectedValue = value;
  }
  private measuredHeight = 21;
  get scrollHeight() { return this.ownerDocument.textHeights.get(this.textContent) ?? this.measuredHeight; }
  set scrollHeight(value: number) { this.measuredHeight = value; }
  scrollWidth = 100;
  clientWidth = 100;
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
  open = false;
  showModal() { this.open = true; this.ownerDocument.nativeModal = this; }
  close() { this.open = false; if (this.ownerDocument.nativeModal === this) this.ownerDocument.nativeModal = null; }
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
  textHeights = new Map<string, number>();
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
  const observers = new Set<() => void>();
  const globals = {
    document, window: Object.assign(new EventTarget(), {
      document, HTMLIFrameElement: class {}, history: { state: null },
      matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    }),
    Element: HostNode, HTMLElement: HostNode, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ lineHeight: '21px' }),
    ResizeObserver: class {
      private callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
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
    resize: () => act(async () => { observers.forEach(callback => callback()); }),
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

const roleCatalog = [
  { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'existing', name: 'Existing role' },
  { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'added', name: 'Additional role' },
];

function roleFixture(t: TestContext, overrides: Partial<ChatSession> = {}) {
  const h = mount(t);
  const target = { ...session, roles: [roleCatalog[0]], appliedRoles: [roleCatalog[0]], rolesNeedReload: false, ...overrides };
  let catalogs = 0;
  let inspections = 0;
  let refreshes = 0;
  const calls: Array<{ id: string; roles: unknown }> = [];
  useCockpit.setState({
    sessions: [target],
    snapshotReady: true,
    listRoles: async () => { catalogs++; return roleCatalog; },
    addRoles: async (id, roles) => {
      calls.push({ id, roles });
      useCockpit.setState(state => ({ sessions: state.sessions.map(row => row.sessionId === id
        ? { ...row, roles: roleCatalog, rolesNeedReload: row.loaded } : row) }));
      return { sessionId: id, status: 'saved', roles: roleCatalog,
        appliedRoles: target.appliedRoles, loaded: target.loaded, rolesNeedReload: target.loaded };
    },
    roleReadiness: async id => {
      inspections++;
      return { sessionId: id, roles: target.roles ?? [], appliedRoles: target.roles ?? [],
        loaded: target.loaded, ready: target.loaded, reasons: [] };
    },
    refreshRoles: async id => {
      refreshes++;
      const current = useCockpit.getState().sessions.find(row => row.sessionId === id)!;
      return { sessionId: id, roles: current.roles, appliedRoles: current.appliedRoles,
        loaded: current.loaded, rolesNeedReload: current.rolesNeedReload };
    },
    loadSession: noMutation,
  });
  function CurrentRoles({ value }: { value: ChatSession }) {
    const current = useCockpit(state => state.sessions.find(row => row.sessionId === value.sessionId));
    return createElement(SessionRoles, { session: current ?? value });
  }
  const render = (value = target) => h.render(createElement(CurrentRoles, { value }));
  const open = async () => {
    await render();
    await h.event(button(h.container, '追加模块角色…'), 'click');
  };
  const choose = async () => {
    const checkbox = h.container.querySelector('input');
    assert.ok(checkbox);
    assert.equal(checkbox.type, 'checkbox');
    checkbox.checked = true;
    await h.event(checkbox, 'click');
  };
  const submit = () => h.event(button(h.container, '保存追加角色'), 'click');
  return { ...h, target, render, open, choose, submit, calls,
    unmount: () => h.render(null),
    refresh: () => h.event(h.container.querySelector('[aria-label="刷新模块角色"]')!, 'click'),
    catalogs: () => catalogs, inspections: () => inspections, refreshes: () => refreshes };
}

test('roles remain passive until addition opens; native checkbox selection never submits or reloads', async t => {
  const h = roleFixture(t);
  await h.render();
  assert.equal(h.catalogs(), 0);
  assert.equal(h.inspections(), 0);
  assert.ok(h.container.querySelector('[aria-label="已保存的模块角色"]'));
  assert.equal(h.refreshes(), 0);
  await h.open();
  assert.equal(h.catalogs(), 1);
  assert.equal(h.container.querySelectorAll('input').length, 1, 'already selected role is not removable');
  const input = h.container.querySelector('input')!;
  assert.ok(input.getAttribute('aria-labelledby'));
  assert.equal(h.container.querySelector('fieldset')?.querySelector('legend')?.textContent, '模块角色');
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
  await h.choose();
  assert.equal(h.calls.length, 0);
  assert.equal(disabled(button(h.container, '保存追加角色')), false);
  assert.doesNotMatch(h.container.textContent, /检查当前角色状态|可选，可多选|执行中、有待决问题/);
  await h.submit();
  assert.deepEqual(h.calls, [{ id: h.target.sessionId, roles: [{ moduleId: 'fixture', roleId: 'added' }] }]);
  assert.match(h.container.textContent, /角色选择已保存/);
  assert.match(h.container.textContent, /需要另行显式重新加载会话/);
  assert.doesNotMatch(h.container.textContent, /本次返回的已保存选择|本次返回的已应用角色|完整结果/);
  assert.equal(h.container.querySelector('pre'), null);
  assert.match(h.container.textContent, /目录中的角色均已选择/);
  assert.equal(h.inspections(), 0, 'no automatic readiness polling');
});

for (const state of [
  { loaded: true, appliedRoles: [roleCatalog[0]], muted: [false, true] },
  { loaded: true, appliedRoles: undefined, muted: [true, true] },
  { loaded: false, appliedRoles: roleCatalog, muted: [true, true] },
  { loaded: true, appliedRoles: roleCatalog.map(role => ({ ...role, moduleId: 'different' })), muted: [true, true] },
]) {
  test(`settings and sidebar show one identical saved set: ${JSON.stringify(state)}`, async t => {
    const h = mount(t);
    const target = { ...session, ...state, roles: roleCatalog };
    useCockpit.setState({ sessions: [target], snapshotReady: true });
    await h.render(createElement('div', null, createElement(SessionRoles, { session: target }),
      createElement(Sidebar, { sessions: [target], activeId: null, query: '', connected: true, snapshotReady: true,
        onSelect: () => {}, getMenuItems: () => [] })));
    const lists = h.container.querySelectorAll('.session-role-badges');
    assert.equal(lists.length, 2, 'one saved list on each surface');
    for (const list of lists) assert.deepEqual(list.querySelectorAll('.role-badge')
      .map(badge => badge.getAttribute('data-unapplied') === 'true'), state.muted);
  });
}

test('unloaded role addition uses one same-ID add request, without a preliminary load', async t => {
  const h = roleFixture(t, { loaded: false });
  await h.open();
  await h.choose();
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].id, h.target.sessionId);
  assert.equal(useCockpit.getState().sessions[0].loaded, false);
  assert.equal(useCockpit.getState().sessions[0].rolesNeedReload, false);
  assert.match(h.container.textContent, /下次加载时应用/);
});

test('saved roles never imply application or capability readiness', async t => {
  const h = roleFixture(t);
  useCockpit.setState({ addRoles: async id => ({
    sessionId: id, status: 'saved', roles: roleCatalog, appliedRoles: [roleCatalog[0]],
    loaded: true, rolesNeedReload: true,
  }) });
  await h.open();
  await h.choose();
  await h.submit();
  assert.match(h.container.textContent, /角色选择已保存，需要另行显式重新加载会话/);
  assert.equal((h.container.textContent.match(/角色选择已保存/g) ?? []).length, 1);
  assert.match(h.container.textContent, /不代表能力就绪/);
  assert.equal(h.inspections(), 0);
});

for (const mode of ['unavailable', 'empty', 'all-selected'] as const) {
  test(`role catalog ${mode} cannot enable mutation or imply success`, async t => {
    const h = roleFixture(t);
    useCockpit.setState({ listRoles: async () => {
      if (mode === 'unavailable') throw new Error('Catalog unavailable');
      return mode === 'empty' ? [] : [roleCatalog[0]];
    } });
    await h.open();
    assert.equal(h.container.querySelectorAll('input').length, 0);
    assert.equal(disabled(button(h.container, '保存追加角色')), true);
    assert.match(h.container.textContent, mode === 'unavailable' ? /Catalog unavailable/
      : mode === 'empty' ? /没有可用的模块角色/ : /目录中的角色均已选择/);
    assert.equal(h.calls.length, 0);
  });
}

for (const busy of [
  { status: 'running' as const }, { nativeProcessing: true },
  { cancelling: true }, { compacting: true }, { activeOperations: 1 }, { activeMcpOperations: 1 },
  { scheduleCount: 1 },
  { activeSubagents: 1 }, { queue: [{ id: 'queued', text: 'fixture' }] },
  { ask: { requestId: 'ask', question: 'Fixture?' } },
  { planRequest: { requestId: 'plan', summary: 'Fixture plan' } },
  { elicitation: { requestId: 'elicitation', message: 'Fixture request' } },
] satisfies Partial<ChatSession>[]) {
  test(`busy session still allows saving roles: ${JSON.stringify(busy)}`, async t => {
    const h = roleFixture(t, busy);
    await h.open();
    await h.choose();
    assert.equal(disabled(button(h.container, '保存追加角色')), false);
    assert.equal(disabled(h.container.querySelector('fieldset')!), false);
    await h.submit();
    assert.equal(h.calls.length, 1);
  });
}

for (const status of ['uncertain'] as const) {
  test(`role ${status} preserves concise errors and requires a fresh saved selection before retry`, async t => {
    const h = roleFixture(t);
    let calls = 0;
    let inspections = 0;
    const result: IntentResult<'roles/add'> = {
      sessionId: h.target.sessionId, status, roles: roleCatalog,
      appliedRoles: [roleCatalog[0]], loaded: true, rolesNeedReload: true,
      error: 'Synthetic persistence uncertainty', recovery: 'Inspect before retry',
    };
    useCockpit.setState({
      addRoles: async (id, roles) => {
        calls++;
        assert.equal(id, h.target.sessionId);
        assert.deepEqual(roles, [{ moduleId: 'fixture', roleId: 'added' }]);
        return result;
      },
      refreshRoles: async () => {
        inspections++;
        return { sessionId: result.sessionId, loaded: result.loaded, rolesNeedReload: result.rolesNeedReload,
          appliedRoles: result.appliedRoles, roles: [roleCatalog[0]] };
      },
    });
    await h.open();
    await h.choose();
    await h.submit();
    assert.equal(calls, 1);
    assert.equal(inspections, 0);
    assert.match(h.container.textContent, /请先刷新模块角色，再显式重试/);
    assert.match(h.container.textContent, /Synthetic persistence uncertainty.*Inspect before retry/);
    assert.equal(h.container.querySelector('pre'), null);
    assert.equal(disabled(button(h.container, '保存追加角色')), true);
    await h.event(button(h.container, '收起角色追加'), 'click');
    await h.event(button(h.container, '追加模块角色…'), 'click');
    assert.match(h.container.textContent, /Synthetic persistence uncertainty/, 'collapsing retains diagnostics');
    assert.equal(disabled(button(h.container, '保存追加角色')), true);
    await h.refresh();
    assert.equal(inspections, 1);
    assert.equal(calls, 1, 'inspection never retries addition');
    assert.match(h.container.textContent, /角色状态已刷新；应用不代表能力就绪/);
    assert.equal(disabled(button(h.container, '保存追加角色')), false);
    await h.submit();
    assert.equal(calls, 2, 'only this explicit action retries the original additions');
  });
}

for (const transition of [{ loading: true }, { closing: true }]) {
  test(`lifecycle transition blocks role persistence: ${JSON.stringify(transition)}`, async t => {
    const h = roleFixture(t, transition);
    await h.open();
    assert.equal(disabled(button(h.container, '保存追加角色')), true);
    assert.equal(disabled(h.container.querySelector('fieldset')!), true);
    assert.equal(h.calls.length, 0);
  });
}

test('authoritative identity replaces saved and applied badges after another client or explicit reload', async t => {
  const h = roleFixture(t);
  await h.open();
  await h.choose();
  await h.submit();
  const saved = () => h.container.querySelector('[aria-label="已保存的模块角色"]')!;
  const muted = () => saved().querySelectorAll('[data-unapplied="true"]').map(node => node.textContent);
  assert.match(saved().textContent, /Additional role/);
  assert.equal(muted().length, 1);
  assert.match(muted()[0], /Additional role/);
  await act(async () => useCockpit.setState({ sessions: [{
    ...h.target, roles: roleCatalog, appliedRoles: roleCatalog, rolesNeedReload: false,
  }] }));
  assert.equal(muted().length, 0);
  assert.doesNotMatch(h.container.textContent, /角色选择已保存，需要另行显式重新加载会话/);
  const remoteRole = { ...roleCatalog[1], roleId: 'remote', name: 'Other client role' };
  await act(async () => useCockpit.setState({ sessions: [{
    ...h.target, roles: [...roleCatalog, remoteRole], appliedRoles: roleCatalog, rolesNeedReload: true,
  }] }));
  assert.match(saved().textContent, /Other client role/);
  assert.equal(muted().length, 1);
  assert.match(muted()[0], /Other client role/);
  assert.match(h.container.textContent, /角色选择已保存，需要另行显式重新加载会话/);
  await act(async () => useCockpit.setState({ sessions: [{
    ...h.target, roles: [...roleCatalog, remoteRole], loaded: false, appliedRoles: [], rolesNeedReload: false,
  }] }));
  assert.match(saved().textContent, /Other client role/);
  assert.equal(muted().length, 3);
  assert.match(h.container.textContent, /会话未加载；已保存的角色将在下次加载时应用/);
  assert.equal(h.inspections(), 0);
});

for (const leave of ['target', 'unmount', 'reconnect', 'offline'] as const) {
  test(`late role addition result loses ownership after ${leave}`, async t => {
    const h = roleFixture(t);
    const pending = deferred<IntentResult<'roles/add'>>();
    let calls = 0;
    useCockpit.setState({ addRoles: async id => {
      calls++;
      assert.equal(id, h.target.sessionId);
      return pending.promise;
    } });
    await h.open();
    await h.choose();
    await h.submit();
    assert.equal(calls, 1);
    if (leave === 'target') {
      const next = { ...h.target, sessionId: 'another-target', roles: [] };
      useCockpit.setState({ sessions: [h.target, next], activeId: next.sessionId });
      await h.render(next);
    } else if (leave === 'unmount') await h.unmount();
    else await act(async () => useCockpit.setState(leave === 'reconnect'
      ? { connectionGeneration: 2 } : { connState: 'connecting' }));
    await act(async () => pending.resolve({
      sessionId: h.target.sessionId, status: 'saved', roles: roleCatalog,
      appliedRoles: [roleCatalog[0]], loaded: true, rolesNeedReload: true,
    }));
    assert.doesNotMatch(h.container.textContent, /角色选择已保存，未重新加载会话/);
    assert.equal(calls, 1);
    assert.equal(h.inspections(), 0);
  });
}

test('role addition rejects mismatched response IDs instead of displaying wrong-target success', async t => {
  const h = roleFixture(t);
  useCockpit.setState({ addRoles: async () => ({
    sessionId: 'wrong-target', status: 'saved', roles: roleCatalog, appliedRoles: [], loaded: true, rolesNeedReload: true,
  }) });
  await h.open();
  await h.choose();
  await h.submit();
  assert.match(h.container.textContent, /会话 ID 不匹配/);
  assert.doesNotMatch(h.container.textContent, /角色选择已保存，未重新加载会话/);
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
});

test('transport uncertainty keeps the draft and requires a matching explicit inspection before retry', async t => {
  const h = roleFixture(t);
  let calls = 0;
  useCockpit.setState({
    addRoles: async () => { calls++; throw new Error('Synthetic lost acknowledgement'); },
    refreshRoles: async () => ({
      sessionId: 'wrong-target', roles: [], loaded: false, appliedRoles: [], rolesNeedReload: false,
    }),
  });
  await h.open();
  await h.choose();
  await h.submit();
  assert.match(h.container.textContent, /Synthetic lost acknowledgement/);
  assert.equal(h.container.querySelector('input')!.checked, true);
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
  await h.refresh();
  assert.match(h.container.textContent, /会话 ID 不匹配/);
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
  assert.equal(calls, 1);
});

for (const loaded of [true, false]) {
  test(`role header refresh is passive, including unloaded sessions: ${loaded}`, async t => {
    const h = roleFixture(t, { loaded });
    await h.render();
    await h.refresh();
    assert.equal(h.refreshes(), 1);
    assert.equal(h.catalogs(), 0);
    assert.equal(h.inspections(), 0);
    assert.equal(h.calls.length, 0);
    assert.match(h.container.textContent, /角色状态已刷新/);
  });
}

test('double save is exclusive; disconnect preserves the uncertain-save lock until explicit fresh identity', async t => {
  const h = roleFixture(t);
  const pending = deferred<IntentResult<'roles/add'>>();
  let calls = 0;
  useCockpit.setState({ addRoles: async () => { calls++; return pending.promise; } });
  await h.open();
  await h.choose();
  await h.submit();
  await h.submit();
  assert.equal(calls, 1);
  assert.equal(disabled(h.container.querySelector('[aria-label="刷新模块角色"]')!), true);
  await act(async () => useCockpit.setState({ connState: 'connecting' }));
  await act(async () => useCockpit.setState({ connState: 'open', connectionGeneration: 2 }));
  assert.equal(h.container.querySelector('input')!.checked, true);
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
  await act(async () => pending.resolve({
    sessionId: h.target.sessionId, status: 'saved', roles: roleCatalog, appliedRoles: [],
    loaded: true, rolesNeedReload: true,
  }));
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
  assert.doesNotMatch(h.container.textContent, /角色选择已保存，未重新加载会话/);
  await h.refresh();
  assert.equal(disabled(button(h.container, '保存追加角色')), false);
  assert.equal(calls, 1);
});

for (const failure of ['missing roles', 'read failure'] as const) {
  test(`refresh ${failure} never unlocks an uncertain save`, async t => {
    const h = roleFixture(t);
    useCockpit.setState({
      addRoles: async () => { throw new Error('Unconfirmed save'); },
      refreshRoles: async () => {
        if (failure === 'read failure') throw new Error('Cannot read persisted selection');
        return { sessionId: h.target.sessionId, loaded: true, appliedRoles: [], rolesNeedReload: false };
      },
    });
    await h.open();
    await h.choose();
    await h.submit();
    await h.refresh();
    assert.match(h.container.textContent, /刷新失败/);
    assert.equal(disabled(button(h.container, '保存追加角色')), true);
    assert.equal(h.container.querySelector('input')!.checked, true);
  });
}

test('refresh reconciles a saved-but-unacknowledged role without resubmitting it', async t => {
  const h = roleFixture(t);
  useCockpit.setState({
    addRoles: async () => { throw new Error('Lost acknowledgement'); },
    refreshRoles: async id => {
      const next = { ...h.target, roles: roleCatalog, rolesNeedReload: true };
      useCockpit.setState({ sessions: [next] });
      return { ...next, sessionId: id };
    },
  });
  await h.open();
  await h.choose();
  await h.submit();
  await h.refresh();
  assert.equal(h.container.querySelectorAll('input').length, 0);
  assert.match(h.container.textContent, /目录中的角色均已选择/);
  assert.equal(disabled(button(h.container, '保存追加角色')), true);
  assert.equal(h.inspections(), 0);
});

for (const leave of ['target', 'unmount', 'reconnect', 'offline'] as const) {
  test(`late role refresh does not publish feedback after ${leave}`, async t => {
    const h = roleFixture(t);
    const pending = deferred<SessionProjection>();
    useCockpit.setState({ refreshRoles: async () => pending.promise });
    await h.render();
    await h.refresh();
    await h.refresh();
    if (leave === 'target') {
      const next = { ...h.target, sessionId: 'another-target', roles: [] };
      useCockpit.setState({ sessions: [h.target, next] });
      await h.render(next);
    } else if (leave === 'unmount') await h.unmount();
    else await act(async () => useCockpit.setState(leave === 'reconnect'
      ? { connectionGeneration: 2 } : { connState: 'connecting' }));
    await act(async () => pending.resolve(h.target));
    assert.doesNotMatch(h.container.textContent, /角色状态已刷新/);
  });
}

test('role submit rechecks the original target, not the active session or stale rendered idle state', async t => {
  const h = roleFixture(t);
  await h.open();
  await h.choose();
  await act(async () => useCockpit.setState({
    activeId: 'other',
    sessions: [{ ...h.target, closing: true }, { ...session, sessionId: 'other' }],
  }));
  await h.submit();
  assert.equal(h.calls.length, 0, 'late close is authoritative at click time');
  await act(async () => useCockpit.setState({ sessions: [h.target, { ...session, sessionId: 'other' }] }));
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].id, h.target.sessionId, 'active-session change never redirects the captured request');
});

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name}: metadata labels never alias names, infer provenance, or change mutation keys`, async t => {
    const h = mount(t);
    const name = Component === SessionMcp ? 'cockpit-task' : 'cockpit-task-owner';
    const unrelated = 'module_cockpit-task__unrelated';
    const module = { id: 'cockpit-task', name: 'Task',
      roles: [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Owner' }] };
    let enabled = true;
    const calls: Array<[string, string, boolean]> = [];
    const mutate = async (id: string, key: string, value: boolean) => { calls.push([id, key, value]); enabled = value; };
    useCockpit.setState({
      mcpSession: async () => [
        { name, module, detail: 'native', enabled, status: enabled ? 'connected' : 'disabled' },
        { name: unrelated, detail: 'native', enabled: false, status: 'disabled' },
      ],
      skillsSession: async () => [
        { name, module, description: '', source: 'custom', enabled },
        { name: unrelated, description: '', source: 'custom', enabled: false },
      ],
      mcpToggleSession: mutate, skillsToggleSession: mutate,
    });
    await h.render(createElement(Component, { session, onClose: noop }));
    const rows = h.container.querySelectorAll('.manage-row');
    assert.equal(rows[0].querySelector('.manage-row-name')?.textContent, name);
    assert.equal(rows[0].querySelector('.module-label-name')?.textContent, 'Task');
    assert.equal(rows.length, 2, 'shared resources still have one row');
    assert.equal(rows[0].querySelector('.role-badge-name')?.textContent, 'Executor、Owner');
    assert.equal(h.container.querySelector('.module-mark'), null);
    if (Component === SessionMcp) assert.match(rows[0].querySelector('.module-label')!.getAttribute('title')!, /角色配置来源，不代表当前连接身份/);
    assert.match(rows[0].querySelector('.manage-row-source')!.textContent, /native|custom/);
    assert.equal(rows[1].querySelector('.manage-row-name')?.textContent, unrelated);
    assert.equal(rows[1].querySelector('.module-label'), null);
    await h.event(rows[0].querySelector('[role="switch"]')!, 'click');
    assert.deepEqual(calls, [[session.sessionId, name, false]]);
    assert.equal(rows[0].querySelector('.module-label-name')?.textContent, 'Task');
    assert.equal(rows[0].querySelector('.role-badge-name')?.textContent, 'Executor、Owner');
  });
}

test('two-line disclosure measures overflow, keeps collapse while expanded, and remeasures resize and late text', async t => {
  const h = mount(t);
  const render = (text: string) => h.render(createElement(ExpandableText, { text, label: '说明' }));
  await render('short');
  const text = h.container.querySelector('.panel-expandable-text')!;
  assert.equal(h.container.querySelector('button'), null);
  text.scrollHeight = 63;
  await render('late content with three lines');
  const expand = button(h.container, '展开全文');
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
  assert.equal(expand.getAttribute('aria-controls'), text.getAttribute('id'));
  await h.event(expand, 'click');
  assert.equal(text.getAttribute('data-expanded'), 'true');
  await h.resize();
  assert.equal(button(h.container, '收起').getAttribute('aria-expanded'), 'true');
  await h.event(button(h.container, '收起'), 'click');
  assert.equal(text.getAttribute('data-expanded'), null);
  text.scrollHeight = 42;
  await h.resize();
  assert.equal(h.container.querySelector('button'), null, 'exactly two lines has no unnecessary disclosure');
  text.scrollHeight = 84;
  await h.resize();
  await h.event(button(h.container, '展开全文'), 'click');
  await render('replacement content starts collapsed');
  assert.equal(text.getAttribute('data-expanded'), null);
  text.scrollHeight = 21;
  await render('short again');
  assert.equal(h.container.querySelector('button'), null);
  await h.render(null);
  await h.resize();
});

test('model drafts survive queued results and newer native values; reset and apply stay manual', async t => {
  const h = mount(t);
  const response = deferred<IntentResult<'setModel'>>();
  const calls: string[] = [];
  const onSetModel = async (id: string) => { calls.push(id); return response.promise; };
  const value = { ...session, availableModels: [
    { modelId: 'metadata-model', name: 'Metadata model' }, { modelId: 'draft', name: 'Draft model' },
  ] };
  const render = (currentModelId: string) => h.render(createElement(ModelControls, {
    session: { ...value, currentModelId }, disabled: false, onSetModel,
  }));
  await render('metadata-model');
  const select = h.container.querySelector('select')!;
  select.value = 'draft';
  await h.event(select, 'change');
  assert.deepEqual(calls, []);
  assert.equal(select.value, 'draft');
  assert.equal(h.container.querySelector('.info-model-hint'), null);
  await h.event(button(h.container, '应用配置'), 'click');
  select.value = 'metadata-model';
  await h.event(select, 'change');
  await render('draft');
  await act(async () => response.resolve({ ok: true, result: { status: 'queued' } }));
  assert.equal(select.value, 'metadata-model', 'late native results do not overwrite the draft');
  assert.match(h.container.textContent, /等待原生应用/);
  assert.deepEqual(calls, ['draft']);
  await h.event(button(h.container, '重置'), 'click');
  assert.equal(select.value, 'draft', 'reset uses the latest authoritative value');
  assert.deepEqual(calls, ['draft'], 'reset is never a write');
});

test('global navigation does not take focus on entry or route remount', async t => {
  const h = mount(t);
  const initialFocus = h.document.activeElement;
  await h.render(createElement(MemoryRouter, { initialEntries: ['/'] },
    createElement(GlobalNavigation, { key: 'entry' })));
  assert.equal(h.document.activeElement, initialFocus);
  const trigger = h.container.querySelector('button');
  assert.ok(trigger);
  assert.equal(trigger.getAttribute('aria-label'), '全局导航');
  assert.equal(trigger.getAttribute('tabindex'), null);
  assert.equal(disabled(trigger), false);

  const input = h.document.createElement('input');
  h.document.body.appendChild(input);
  input.focus();
  await h.render(createElement(MemoryRouter, { initialEntries: ['/'] },
    createElement(GlobalNavigation, { key: 'return' })));
  assert.equal(h.document.activeElement, input);
});

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
    const frame = h.container.querySelector('dialog');
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
    assert.equal(h.container.querySelector('dialog'), frame, 'modal Escape cannot navigate the background');
    h.document.nativeModal = null;
    await key('Escape', true);
    assert.equal(h.container.querySelector('dialog'), frame, 'claimed Escape remains ignored');
    frame.focus();
    assert.equal((await key('Tab')).defaultPrevented, false, 'Tab belongs to the browser at both widths');
    if (desktop) await key('Escape');
    else await act(async () => { frame.dispatchEvent(new Event('cancel', { cancelable: true })); });
    assert.equal(h.container.textContent, 'closed panel');
    await act(async () => { await navigate(`/session/${session.sessionId}/mcp`); });
    assert.ok(h.container.querySelector('dialog'));
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
      if (node.getAttribute('aria-expanded') !== null) continue; // Passive role-entry disclosure, not a model action.
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
    await h.render(createElement(MemoryRouter, null, createElement(Component, { session, onClose: noop })));
    const notice = h.container.querySelector('[data-kind="loading"]');
    assert.ok(notice);
    assert.equal(notice.getAttribute('data-placement'), 'pane');
    assert.match(notice.textContent, /加载中/);
    assert.doesNotMatch(h.container.textContent, /本会话没有可用的 MCP|未发现技能/);
    await act(async () => request.resolve());
    assert.equal(h.container.querySelector('[data-kind="loading"]'), null);
    assert.match(h.container.textContent, /本会话没有可用的 MCP|未发现技能/);
    if (Component === SessionSkills) {
      assert.equal(h.container.querySelector('[data-kind="empty"]')?.textContent, '未发现技能');
      assert.equal(h.container.querySelector('a'), null);
    }
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
    const notice = h.container.querySelector('.resource-row');
    assert.ok(notice);
    assert.equal(h.container.querySelector('.mcp-operation-status')?.textContent, Component === SessionMcp ? '断开中' : '停用中');
    if (Component === SessionMcp) {
      assert.equal(notice.querySelector('.manage-row-pending'), null);
      assert.equal(h.container.querySelector('.manage-row-status')?.getAttribute('aria-hidden'), null);
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
    const error = h.container.querySelector('.manage-row-error')!;
    assert.match(error.textContent, /未确认：Native toggle rejected/);
    assert.equal(error.getAttribute('hidden'), '');
    const disclosure = button(h.container, '失败');
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(disclosure.parentNode?.getAttribute('class'), 'manage-row-status');
    await h.event(disclosure, 'click');
    assert.equal(error.getAttribute('hidden'), null);
    await h.event(button(h.container, '收起'), 'click');
    assert.equal(error.getAttribute('hidden'), '');
    assert.equal(h.container.querySelector('[role="alert"]'), null, 'no duplicate automatic error box');
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
    const source = row.querySelector('.manage-row-source');
    await h.event(first, 'click');
    assert.equal(disabled(first), true);
    assert.equal(disabled(second), Component === SessionMcp, 'MCP is serial; Skills operations are per item');
    await act(async () => {
      hold = true;
      useCockpit.setState({ resourceRevisions: { [session.sessionId]: { mcp: 1, skills: 1 } } });
    });
    assert.equal(h.container.querySelectorAll('.spinner').length, 1, 'only the target row owns loading during a mutation');
    assert.equal(h.container.querySelector('.manage-note'), null);
    assert.match(row.textContent, /断开中|停用中/);
    if (Component === SessionMcp) {
      assert.equal(source!.textContent, 'native');
      assert.equal(source!.getAttribute('aria-hidden'), null);
      assert.equal(row.querySelector('.mcp-operation-status')?.textContent, '断开中');
      assert.doesNotMatch(row.querySelector('.manage-row-name')!.textContent, /已连接/);
    }
    assert.doesNotMatch(other.textContent, /断开中|停用中|未确认|请等待|正在切换/);
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
      assert.equal(source!.textContent, 'native');
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
  assert.match(h.container.querySelector('[data-resource-name="one"]')!.textContent, /停用中/);
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

for (const Component of [SessionMcp, SessionSkills]) {
  test(`${Component.name}: disclosures stay manual through late text, failed writes and repeated errors`, async t => {
    const h = mount(t);
    const name = 'a-long-native-resource-name';
    const long = 'Late native content that exceeds the collapsed line budget. '.repeat(8);
    h.document.textHeights.set(name, 63);
    h.document.textHeights.set(long, 210);
    let source = '', description = '', revision = 0;
    let mutation = deferred<void>();
    const read = async () => [
      { name, source, detail: source, description, enabled: true, status: 'connected' as const },
      { name: 'other', enabled: true, status: 'connected' as const, detail: 'builtin' },
    ];
    useCockpit.setState({
      mcpSession: read, skillsSession: read,
      mcpToggleSession: async () => mutation.promise, skillsToggleSession: async () => mutation.promise,
    });
    await h.render(createElement(Component, { session, onClose: noop }));
    const row = h.container.querySelector(`[data-resource-name="${name}"]`)!;
    const other = h.container.querySelector('[data-resource-name="other"]')!;
    const otherText = other.textContent;
    const sourceSlot = row.querySelector('.manage-row-source')!;
    const descriptionSlot = row.querySelector('.manage-row-description');
    assert.equal(sourceSlot.querySelector('.manage-row-text')!.getAttribute('data-lines'), '1');
    if (Component === SessionSkills) {
      assert.equal(descriptionSlot?.querySelector('.manage-row-text')?.getAttribute('data-lines'), '2');
      assert.equal(row.querySelector('.manage-row-status')?.textContent, '已启用');
    }
    const revise = () => act(async () => {
      useCockpit.setState({ resourceRevisions: { [session.sessionId]: { mcp: ++revision, skills: revision } } });
    });
    const disclosure = (label: string) => row.querySelector(`[aria-label="${label}"]`)!;
    const open = async (field: string) => {
      const control = disclosure(`展开${name}${field}`);
      assert.ok(control);
      assert.equal(control.getAttribute('aria-expanded'), 'false');
      await h.event(control, 'click');
      assert.equal(disclosure(`收起${name}${field}`).getAttribute('aria-expanded'), 'true');
    };
    source = description = long;
    await revise();
    assert.equal(row.querySelector('.manage-row-source'), sourceSlot);
    assert.equal(row.querySelector('.manage-row-description'), descriptionSlot);
    assert.equal(row.querySelector('[data-expanded]'), null, 'late text never opens itself');
    for (const field of ['名称', '来源', ...(Component === SessionSkills ? ['说明'] : [])]) {
      await open(field);
      await h.resize();
      await h.event(disclosure(`收起${name}${field}`), 'click');
      assert.equal(disclosure(`展开${name}${field}`).getAttribute('aria-expanded'), 'false');
    }
    await open('来源');
    source = 'replacement source';
    await revise();
    source = long;
    await revise();
    assert.equal(disclosure(`展开${name}来源`).getAttribute('aria-expanded'), 'false',
      'an earlier expanded value cannot reopen when it returns');
    if (Component === SessionSkills) await open('说明');
    for (let attempt = 0; attempt < 2; attempt++) {
      await h.event(row.querySelector('[role="switch"]')!, 'click');
      assert.equal(row.querySelector('.manage-row-error'), null);
      assert.equal(row.querySelector('.manage-row-pending'), null);
      assert.equal(row.querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'true');
      await act(async () => mutation.reject(new Error(long)));
      const error = row.querySelector('.manage-row-error')!;
      assert.equal(error.getAttribute('hidden'), '', 'even the same subsequent error starts collapsed');
      assert.equal(disclosure(`展开${name}错误详情`).getAttribute('aria-controls'), error.getAttribute('id'));
      await open('错误详情');
      assert.equal(error.getAttribute('hidden'), null);
      assert.equal(error.textContent, `未确认：${long}`);
      if (Component === SessionSkills) {
        assert.equal(disclosure(`收起${name}说明`).getAttribute('aria-expanded'), 'true',
          'pending and errors must not discard an explicitly expanded description');
      }
      assert.equal(other.textContent, otherText);
      mutation = deferred<void>();
    }
  });
}

test('native MCP error revisions are discoverable but never inherit another error disclosure', async t => {
  const h = mount(t);
  let error: string | undefined = 'Native failure A';
  let revision = 0;
  useCockpit.setState({
    mcpSession: async () => [{ name: 'one', enabled: true, status: 'failed', detail: 'native', error }],
  });
  await h.render(createElement(SessionMcp, { session, onClose: noop }));
  for (const replacement of ['Native failure B', 'Native failure A', undefined, 'Native failure A']) {
    if (error) {
      assert.equal(button(h.container, '失败').getAttribute('aria-expanded'), 'false');
      assert.equal(h.container.querySelector('.manage-row-error')?.getAttribute('hidden'), '');
      await h.event(button(h.container, '失败'), 'click');
      assert.equal(h.container.querySelector('.manage-row-error')?.getAttribute('hidden'), null);
    }
    error = replacement;
    await act(async () => useCockpit.setState({ resourceRevisions: { [session.sessionId]: { mcp: ++revision } } }));
  }
  assert.equal(button(h.container, '失败').getAttribute('aria-expanded'), 'false');
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
    const source = row.querySelector('.manage-row-source')!;
    assert.equal(source.parentNode, row.querySelector('.manage-mcp-identity'), 'MCP name and source form an independent compact left column');
    assert.equal(row.querySelector('.manage-row-name')!.parentNode, source.parentNode);
    assert.equal(row.querySelector('.manage-row-status')!.parentNode, row, 'MCP connection status shares the switch column');
    await h.event(row.querySelector('[role="switch"]')!, 'click');
    assert.equal(source.textContent, 'builtin');
    assert.equal(source.getAttribute('aria-hidden'), null);
    assert.equal(row.querySelector('.mcp-operation-status')?.textContent, initiallyEnabled ? '断开中' : '连接中');
    assert.equal(row.querySelector('.manage-row-pending'), null);
    assert.equal(h.container.querySelectorAll('.spinner').length, 1);
    await act(async () => mutation.resolve());
    assert.equal(row.querySelector('.manage-row-status')?.textContent, initiallyEnabled ? '已关闭' : '已连接');
    assert.equal(row.querySelector('.manage-row-source'), source);
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
  assert.doesNotMatch(h.container.textContent, /停用中|未确认/);
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
  assert.doesNotMatch(h.container.textContent, /Obsolete failure|停用中/);
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
  const value = h.container.querySelector('.info-session-id-value')!;
  assert.equal(value.textContent, session.sessionId);
  assert.equal(value.getAttribute('aria-hidden'), null);
  assert.equal(copy.querySelector('.ck-icon')?.getAttribute('data-icon'), 'copy', 'copy has its own obvious action');
  assert.equal(copy.querySelector('.chat-copy-label-text')?.textContent, '复制');
  await h.event(copy, 'click');
  assert.deepEqual(copied, [session.sessionId]);
  assert.match(copy.textContent, /已复制/);
  assert.equal(h.container.querySelector('.info-session-id-value'), value);
  assert.equal(value.textContent, session.sessionId);
  assert.equal(value.getAttribute('aria-hidden'), null);
  await act(async () => t.mock.timers.tick(10_000));
  assert.equal(copy.querySelector('.chat-copy-label-text')?.textContent, '已复制');
  assert.equal(value.textContent, session.sessionId);
  assert.equal(value.getAttribute('aria-hidden'), null);
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
