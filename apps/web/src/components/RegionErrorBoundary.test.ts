import assert from '../test/identityAssert';
import { beforeEach, test, type TestContext } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { useCockpit } from '../net/store';
import type { ChatMessage, ChatSession } from '../net/types';
import { fixtureSession } from '../dev/chat-fixtures';
import { RegionErrorBoundary } from './ErrorBoundary';
import { Sidebar } from './Sidebar';
import { Thread } from './Thread';
import { SessionDetails } from './SessionDetails';

// A small deterministic React DOM host: enough for real client renders, error
// boundaries, effects and clicks. It does not model layout or scrolling.
class HostNode extends EventTarget {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  ownerDocument: HostDocument;
  parentNode: HostNode | null = null;
  childNodes: HostNode[] = [];
  attributes = new Map<string, string>();
  style = { setProperty() {}, removeProperty() {} };
  attachEvent() {}
  detachEvent() {}
  scrollTop = 0;
  clientTop = 0;
  clientHeight = 300;
  clientWidth = 600;
  scrollHeight = 300;
  scrollWidth = 600;
  selectionStart = 0;
  selectionEnd = 0;
  value = '';
  private text = '';
  constructor(tag: string, document: HostDocument) {
    super();
    this.nodeName = this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get isConnected(): boolean { return this === this.ownerDocument.body || (this.parentNode?.isConnected ?? false); }
  get dataset() { return { messageId: this.getAttribute('data-message-id'), sessionId: this.getAttribute('data-session-id') }; }
  get open() { return this.attributes.has('open'); }
  set open(value: boolean) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get textContent(): string { return this.text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text: string) {
    this.text = text;
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
  }
  get nodeValue() { return this.text; }
  set nodeValue(text: string) { this.text = text; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  scrollTo() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  setSelectionRange() {}
  getClientRects() { return this.isConnected ? [this.getBoundingClientRect()] : []; }
  getBoundingClientRect() { return { top: 0, bottom: 100, left: 0, right: 600, width: 600, height: 100 }; }
  appendChild(node: HostNode) { return this.insertBefore(node, null); }
  insertBefore(node: HostNode, before: HostNode | null) {
    node.parentNode?.removeChild(node);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: HostNode) {
    if (node.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  contains(node: HostNode | null): boolean { return node === this || this.childNodes.some(child => child.contains(node)); }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  matches(selector: string): boolean {
    if (selector.includes(', ')) return selector.split(', ').some(part => this.matches(part));
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase();
    if (selector.startsWith('.')) return (this.getAttribute('class') ?? '').split(' ').includes(selector.slice(1));
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    return !!match && this.attributes.has(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
  }
  closest(selector: string): HostNode | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  querySelectorAll(selector: string): HostNode[] {
    return this.childNodes.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

class HostDocument extends EventTarget {
  nodeType = 9;
  visibilityState = 'visible';
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
  querySelector(selector: string) { return this.body.querySelector(selector); }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
  getSelection() { return null; }
}

class HostWindow extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}

let diagnostics: string[] = [];
beforeEach(context => {
  const t = context as TestContext;
  diagnostics = [];
  // React's own caught-error log and our local record both go to console.error.
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (args[0] === '[cockpit] local error (shown in place):') diagnostics.push(String(args[1]));
  });
  for (const error of getUxErrors()) dismissUxError(error.id);
});

function mount(t: TestContext) {
  const document = new HostDocument();
  const globals: Record<string, unknown> = {
    document,
    window: Object.assign(new HostWindow(), {
      document, HTMLIFrameElement: class {}, innerWidth: 1000, innerHeight: 800, history: { state: null },
      matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    }),
    Element: HostNode, HTMLElement: HostNode, HTMLButtonElement: HostNode,
    CSS: { escape: (id: string) => id, supports: () => false },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ lineHeight: '21px' }),
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  const restore: (() => void)[] = [];
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    restore.push(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Region boundary fixtures must not access a backend'));
  const state = useCockpit.getState();
  useCockpit.setState({ connState: 'open', snapshotReady: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    useCockpit.setState(state, true);
    for (const reset of restore) reset();
  });
  return {
    container,
    render: (children: ReactNode) => act(async () => root.render(children)),
    click: (node: HostNode) => act(async () => {
      const event = new Event('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: node });
      Object.defineProperty(event, 'button', { value: 0 });
      // React listens on its root container; this host has no event propagation.
      container.dispatchEvent(event);
    }),
  };
}

const fallbacks = (container: HostNode) => container.querySelectorAll('[data-region-error]');
function retry(fallback: HostNode) {
  const button = fallback.querySelectorAll('button').find(node => node.textContent === '重试');
  assert.ok(button, 'fallback offers a local retry');
  return button;
}

test('a crashing region shows its own failed result while siblings stay usable', async t => {
  const h = mount(t);
  let broken = true;
  let clicks = 0;
  function Fragile(): ReactNode {
    if (broken) throw new Error('Synthetic region failure');
    return createElement('p', { className: 'fragile' }, 'recovered');
  }
  await h.render(createElement('div', null,
    createElement(RegionErrorBoundary, { label: '这块内容', children: createElement(Fragile) }),
    createElement('button', { type: 'button', className: 'sibling', onClick: () => { clicks++; } }, 'sibling')));
  const [fallback] = fallbacks(h.container);
  assert.equal(fallback.getAttribute('data-region-error'), '这块内容');
  assert.match(fallback.textContent, /显示这块内容失败，其余界面不受影响。/);
  assert.equal(fallback.querySelector('[role="alert"]')?.textContent, '显示这块内容失败，其余界面不受影响。');
  assert.match(fallback.textContent, /详情/);
  await h.click(h.container.querySelector('.sibling')!);
  assert.equal(clicks, 1);
  // Owned in place: a local console record, no global notice.
  assert.equal(getUxErrors().length, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /^这块内容渲染失败：Synthetic region failure/);

  await h.click(retry(fallback));
  assert.equal(fallbacks(h.container).length, 1, 'a persisting cause stays local after retry');
  assert.equal(diagnostics.length, 1, 'an identical repeated failure is recorded once');
  broken = false;
  await h.click(retry(fallbacks(h.container)[0]));
  assert.equal(fallbacks(h.container).length, 0);
  assert.equal(h.container.querySelector('.fragile')?.textContent, 'recovered');
  assert.equal(getUxErrors().length, 0);
});

test('new region input retries automatically; an unchanged key keeps the fallback', async t => {
  const h = mount(t);
  const Value = ({ value }: { value: string }): ReactNode => {
    if (value === 'bad') throw new Error('Bad value');
    return createElement('span', { className: 'value' }, value);
  };
  const render = (value: string) => h.render(createElement(RegionErrorBoundary, {
    label: '值', resetKey: value, children: createElement(Value, { value }),
  }));
  await render('bad');
  assert.equal(fallbacks(h.container).length, 1);
  await render('bad');
  assert.equal(fallbacks(h.container).length, 1);
  await render('good');
  assert.equal(fallbacks(h.container).length, 0);
  assert.equal(h.container.querySelector('.value')?.textContent, 'good');
});

const brokenMessage = (id: string): ChatMessage => ({
  id, role: 'user', content: 'malformed attachment', timestamp: Date.now(),
  attachments: [null] as unknown as ChatMessage['attachments'],
});

test('one malformed message is isolated in the transcript; others and the composer keep working', async t => {
  const h = mount(t);
  const base = fixtureSession('reading');
  const session: ChatSession = { ...base, messages: [...base.messages.slice(0, 2), brokenMessage('broken'), ...base.messages.slice(2)] };
  useCockpit.setState({ sessions: [session] });
  await h.render(createElement(MemoryRouter, null, createElement(Thread, { session, onLoadMore: () => {} })));
  const failed = fallbacks(h.container);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute('data-region-error'), '这条消息');
  assert.ok(failed[0].closest('[data-message-frame="broken"]'), 'the fallback keeps the message frame for scroll anchoring');
  const others = h.container.querySelectorAll('[data-message-frame]').filter(frame => !frame.querySelector('[data-region-error]'));
  assert.ok(others.length >= 2 && others.every(frame => frame.textContent.trim()), 'other messages still render');
  assert.ok(h.container.querySelector('.chat-input-card'), 'the composer is still mounted');
  assert.equal(getUxErrors().length, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /^这条消息渲染失败：Cannot use 'in' operator/);

  // A repaired native message is new input for that row and recovers without a reload.
  const repaired = { ...session, messages: session.messages.map(m => m.id === 'broken' ? { ...m, attachments: [] } : m) };
  await h.render(createElement(MemoryRouter, null, createElement(Thread, { session: repaired, onLoadMore: () => {} })));
  assert.equal(fallbacks(h.container).length, 0);
  assert.match(h.container.querySelector('[data-message-frame="broken"]')?.textContent ?? '', /malformed attachment/);
});

test('one malformed session row is isolated; other rows remain selectable', async t => {
  const h = mount(t);
  const base = fixtureSession('reading');
  const good: ChatSession = { ...base, sessionId: 'good', title: 'Good session', messages: [] };
  const bad = { ...base, sessionId: 'bad', title: 'Bad session', messages: [], roles: [null] } as unknown as ChatSession;
  const selected: string[] = [];
  await h.render(createElement(MemoryRouter, null, createElement(Sidebar, {
    sessions: [bad, good], activeId: null, query: '', snapshotReady: true, connected: true,
    onSelect: id => { selected.push(id); }, getMenuItems: () => [],
  })));
  const failed = fallbacks(h.container);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute('data-region-error'), '这条会话');
  assert.equal(failed[0].parentNode?.tagName, 'LI');
  const row = h.container.querySelector('[data-session-id="good"]');
  assert.ok(row);
  await h.click(row);
  assert.deepEqual(selected, ['good']);
  assert.equal(getUxErrors().length, 0);
  assert.match(diagnostics[0], /^这条会话渲染失败：Cannot read properties of null/);
});

test('a crashing session panel keeps its header and close control inside the inspector', async t => {
  const h = mount(t);
  const base = fixtureSession('reading');
  const session = { ...base, sessionId: 'panel', loaded: true, roles: [null] } as unknown as ChatSession;
  useCockpit.setState({ sessions: [session], sessionReloadResults: {} });
  await h.render(createElement(MemoryRouter, { initialEntries: ['/session/panel/info'] },
    createElement(SessionDetails, { sessionId: 'panel', panel: 'info' })));
  // Let the lazy panel chunk resolve and render.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  const failed = fallbacks(h.container);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute('data-region-error'), '会话设置');
  const inspector = failed[0].closest('.inspector-surface');
  assert.ok(inspector, 'the fallback stays inside the inspector frame');
  assert.ok(inspector.querySelector('.pane-title')?.textContent === '会话设置');
  assert.ok(inspector.querySelectorAll('button').some(node => node.getAttribute('aria-label') === '关闭'), 'close stays available');
  assert.equal(getUxErrors().length, 0);
  assert.match(diagnostics.join('\n'), /会话设置渲染失败：Cannot read properties of null/);
});
