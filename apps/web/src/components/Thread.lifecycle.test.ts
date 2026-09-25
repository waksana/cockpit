import { act, fireEvent } from '../test/dom';
import assert, { assertIdentityList } from '../test/identityAssert';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createElement, Fragment, useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getSessionDraft } from '../lib/textDraft';
import { getDraftSession } from '../lib/draftSelection';
import type { NativeDraftRequest } from '../lib/draft';
import { appendFixture, fixtureItem, fixtureSchema, type FixtureData } from '../test/draftFixture';
import { createCockpitStore, useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import type { IntentResult, SessionProjection } from '@cockpit/protocol';
import { Thread } from './Thread';
import { MessageProcess } from './Transcript';
import { ModelControls, SessionInfoPanel } from './SessionInfoPanel';
import { MessageBody } from './MessageBody';
import { DisclosureChoices } from './DisclosureChoices';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { groupTranscript } from '../lib/transcriptRows';
import { ModuleRuntime, moduleRuntime } from '../lib/moduleRuntime';
import { MarkdownReplacement, ModuleRuntimeProvider } from './ModuleComponents';
import { Composer, ComposerNotices } from './Composer';
import { GlobalNavigation } from './GlobalNavigation';
import { ManagementShell } from './ManagementShell';
import { useLongPress } from '../lib/longpress';
import { useMenuDismiss } from '../lib/useMenuDismiss';
import type { ActivateFrontend, ComposerContext, ComposerInputProps, ComposerProps, ComponentMiddleware, DraftSchemaHandle, DraftSchemaScope, MessageIdentity, MessageProps, ModuleFrontendContext } from '@cockpit/module-api/frontend';
import { fixtureSession } from '../dev/chat-fixtures';
import { activityFixture } from '../dev/activity-fixtures';
import { installFullWebFixture } from '../dev/full-web-fixtures';
import { ConnectedThread } from './ConnectedThread';
import { SessionControlBar } from './SessionControlBar';
import { workspaceSessionId } from '../dev/workspace-fixtures';
import App from '../App';
import { failOnReport } from '../test/failOnReport';

type TestElement = HTMLElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  open: boolean;
  scrollLeft: number;
};

test('Thread lifecycle: re-entry follows latest while mounted updates preserve the reader and resources', async t => {
  const frames = new Map<number, FrameRequestCallback>();
  const resizes = new Set<() => void>();
  let frameId = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id: number) => { frames.delete(id); });
  t.mock.method(globalThis, 'getComputedStyle', () => ({ lineHeight: '21px' }) as CSSStyleDeclaration);
  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    private observed = new Set<Element>();
    private callback: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.callback = () => callback(Array.from(this.observed).map(target => ({
        target, contentRect: target.getBoundingClientRect(),
      }) as ResizeObserverEntry), this as unknown as ResizeObserver);
      resizes.add(this.callback);
    }
    observe(target: Element) { this.observed.add(target); }
    unobserve(target: Element) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); resizes.delete(this.callback); }
  } });
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const heights = new WeakMap<Element, number>();
  const widths = new WeakMap<Element, number>();
  const scrollWidths = new WeakMap<Element, number>();
  // happy-dom has no layout; these metrics preserve the old 300px viewport
  // and 100px-per-message model used by the scroll lifecycle assertions.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return heights.get(this) ?? 300; }, set(value) { heights.set(this, value); },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true, get() { return widths.get(this) ?? 600; }, set(value) { widths.set(this, value); },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return this.querySelectorAll('[data-message-frame]').length * 100; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() { return scrollWidths.get(this) ?? this.clientWidth; },
    set(value) { scrollWidths.set(this, value); },
  });
  const originalQuerySelector = Element.prototype.querySelector;
  const originalQuerySelectorAll = Element.prototype.querySelectorAll;
  t.mock.method(Element.prototype, 'querySelector', function (this: Element, selector: string) {
    try {
      return originalQuerySelector.call(this, selector);
    } catch (error) {
      if (selector.startsWith('[data-message-id="') && selector.endsWith('"]')) {
        return Array.from(originalQuerySelectorAll.call(this, '[data-message-id]'))
          .find(node => `[data-message-id="${CSS.escape(node.getAttribute('data-message-id') ?? '')}"]` === selector) ?? null;
      }
      throw error;
    }
  });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>('.chat-messages');
    const width = this.clientWidth;
    if (!viewport || this === viewport) return { top: 0, bottom: 300, left: 0, right: width, width, height: 300, x: 0, y: 0, toJSON() { return this; } } as DOMRect;
    const frame = this.closest<HTMLElement>('[data-message-frame]');
    const top = frame ? Array.from(viewport.querySelectorAll('[data-message-frame]')).indexOf(frame) * 100 - viewport.scrollTop
      : -viewport.scrollTop;
    const height = frame ? 100 : viewport.scrollHeight;
    return { top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() { return this; } } as DOMRect;
  });
  t.mock.method(HTMLElement.prototype, 'getClientRects', function (this: HTMLElement) {
    if (!this.isConnected || this.closest('[hidden]') || this.closest('[inert]')) return [] as unknown as DOMRectList;
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open
        && !parent.querySelector('summary')?.contains(this)) return [] as unknown as DOMRectList;
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  t.mock.method(Element.prototype, 'scrollIntoView', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Lifecycle fixture must not access a backend'); });
  const previousConnection = useCockpit.getState().connState;
  const previousSnapshotReady = useCockpit.getState().snapshotReady;
  const previousSessions = useCockpit.getState().sessions;
  useCockpit.setState({ connState: 'open', snapshotReady: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    useCockpit.setState({ connState: previousConnection, snapshotReady: previousSnapshotReady, sessions: previousSessions });
    if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  });
  await t.test('module decorations receive exact speech and host ask identities, and failed modules release their resources', async subtest => {
    type Observation = MessageIdentity & { complete: boolean; element: HTMLDivElement };
    const contexts = new Map<string, Observation>();
    const key = (context: MessageIdentity) => JSON.stringify([context.kind, context.id, context.agentId]);
    let crash = false, disposed = 0, stylesRemoved = 0, notified = 0;
    let activation!: ModuleFrontendContext;
    const decorate: ComponentMiddleware<MessageProps> = Base => function Decorated(props) {
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const bodyRef = useCallback((node: HTMLDivElement | null) => { setElement(node); }, []);
      useLayoutEffect(() => {
        if (!element) return;
        const context = { ...props.identity, complete: props.complete, element };
        contexts.set(key(context), context);
        return () => { contexts.delete(key(context)); };
      }, [props.identity, props.complete, element]);
      if (crash) throw new Error('Fixture decoration failed');
      return createElement(Base, { ...props, bodyRef,
        adornment: createElement(Fragment, null, props.adornment, createElement('span', { className: 'fixture-decoration', 'aria-label': 'Marker' }, 'line')),
      });
    };
    const digest = 'a'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'fixture', name: 'Fixture', version: '1.0.0', digest, config: {},
        styles: [`/_modules/assets/fixture/${digest}/style.css`],
        apiBase: `/_modules/fixture/${digest}/api`, entry: `/_modules/assets/fixture/${digest}/entry.js`,
      }], errors: [] }),
      load: async () => ({ activate: (context: ModuleFrontendContext) => {
        activation = context;
        context.state.host.subscribe(() => { notified++; });
        context.onInvalidate!(() => { notified++; });
        return { apiVersion: 2, components: [{ id: 'line', boundary: 'message', wrap: decorate }], dispose: () => { disposed++; } };
      } }),
      style: () => () => { stylesRemoved++; }, report: () => {},
    });
    await runtime.start();
    subtest.after(() => runtime.stop());
    subtest.mock.method(moduleRuntime, 'compose', runtime.compose.bind(runtime));
    subtest.mock.method(moduleRuntime, 'getSnapshot', runtime.getSnapshot);
    subtest.mock.method(moduleRuntime, 'subscribe', runtime.subscribe);
    subtest.mock.method(moduleRuntime, 'unregister', runtime.unregister.bind(runtime));
    subtest.mock.method(moduleRuntime, 'report', runtime.report);
    subtest.mock.method(console, 'error', () => {});
    const timestamp = 1;
    let value: ChatSession = { ...fixtureSession('ask'), sessionId: 'host-route',
      ask: { requestId: 'host-request', question: 'Exact pending question', choices: ['Answer'] },
      messages: [
        { id: 'projected-root', role: 'assistant', content: 'Exact root speech', timestamp, streaming: true,
          origin: { sessionId: 'native-session', messageId: 'native-shared' } },
        { id: 'card', role: 'assistant', content: '', timestamp, subtype: 'subagent',
          subagent: { toolCallId: 'host-tool', name: 'child', displayName: 'Child', status: 'completed', agentId: 'native-child' },
          subMessages: [{ id: 'projected-child', role: 'assistant', content: 'Exact child speech', timestamp,
            origin: { sessionId: 'native-session', messageId: 'native-shared', agentId: 'native-child' } }] },
        { id: 'thought', role: 'assistant', content: '', thought: 'Not speech', timestamp,
          origin: { sessionId: 'native-session', messageId: 'thought' } },
        { id: 'fragment-row', role: 'assistant', content: 'Partial history fragment', timestamp, streaming: true,
          origin: { sessionId: 'native-session', messageId: 'fragment-native' } },
        { id: 'user', role: 'user', content: 'User text', timestamp,
          origin: { sessionId: 'native-session', messageId: 'user' } },
        { id: 'system', role: 'system', content: 'System text', timestamp },
      ], hasMore: false };
    const show = () => root.render(createElement(Thread, {
      session: value, onLoadMore() {}, onSend: async () => true, onRespondAsk: async () => true,
    }));
    await act(show);
    const speech = contexts.get(JSON.stringify(['message', 'native-shared', undefined]))!;
    assert.ok(speech);
    assert.equal(speech.sessionId, 'native-session');
    assert.equal(Object.hasOwn(speech, 'agentId'), false, 'root does not invent an agent identifier');
    assert.equal(speech.complete, false);
    assert.equal(speech.element?.textContent, 'Exact root speech');
    assert.equal(speech.element.parentElement?.querySelector('.fixture-decoration')?.parentElement,
      speech.element.parentElement, 'the real marker is a sibling in the existing presentation parent');
    assert.equal(container.querySelector('.module-message-decorations'), null, 'the marker has no framework placeholder');
    const ask = contexts.get(JSON.stringify(['ask', 'host-request', undefined]))!;
    assert.equal(ask.sessionId, 'host-route');
    assert.equal(ask.complete, true);
    assert.equal(ask.element?.textContent, 'Exact pending question');
    assert.equal(ask.element.getAttribute('class'), 'chat-ask-q');
    assert.equal(contexts.size, 4, 'closed children, thoughts and unattributed system text have no message boundary');
    const user = contexts.get(JSON.stringify(['message', 'user', undefined]))!;
    assert.equal(user.kind, 'message');
    assert.equal(user.kind === 'message' && user.role, 'user');
    assert.equal(user.element.textContent, 'User text', 'the generic message boundary preserves attributed native roles');
    assert.equal(contexts.get(JSON.stringify(['message', 'fragment-native', undefined]))?.complete, false,
      'a loaded history fragment is not treated as a completed assistant reply');
    const clickChild = async () => {
      const target = container.querySelector<HTMLElement>('.subagent-head');
      assert.ok(target);
      await act(async () => { fireEvent.click(target); });
    };
    await clickChild();
    const child = contexts.get(JSON.stringify(['message', 'native-shared', 'native-child']))!;
    assert.equal(child.sessionId, 'native-session', 'child uses native provenance, not the serialized host nesting key');
    assert.equal(child.complete, true);
    assert.equal(child.element?.textContent, 'Exact child speech');
    assert.equal(container.querySelectorAll('.chat-messages').length, 1);
    value = { ...value, ask: { ...value.ask!, requestId: 'next-host-request', question: 'Replacement question' },
      messages: value.messages.map(message => message.id === 'projected-root' ? { ...message, streaming: false, content: 'Final root speech' } : message) };
    await act(show);
    assert.equal(contexts.has(JSON.stringify(['ask', 'host-request', undefined])), false);
    assert.notEqual(contexts.get(JSON.stringify(['ask', 'next-host-request', undefined]))?.element, ask.element,
      'a new request owns a fresh answer composer');
    assert.equal(contexts.get(JSON.stringify(['message', 'native-shared', undefined]))?.element, speech.element);
    assert.equal(contexts.get(JSON.stringify(['message', 'native-shared', undefined]))?.complete, true);
    await clickChild();
    assert.equal(contexts.has(JSON.stringify(['message', 'native-shared', 'native-child'])), false);
    await act(() => root.render(null));
    assert.equal(contexts.size, 0);
    crash = true;
    await act(show);
    assert.equal(activation.signal.aborted, true);
    assert.equal(runtime.getSnapshot().length, 0);
    assert.equal(disposed, 1);
    assert.equal(stylesRemoved, 1);
    assert.match(container.textContent, /Final root speech/);
    assert.equal(container.querySelector('.fixture-decoration'), null);
    runtime.updateView({ sessionId: 'other', visible: true, connected: true });
    runtime.invalidate('fixture');
    assert.equal(notified, 0);
    await act(() => root.render(null));
  });
  await t.test('real navigation and management boundaries retain menu, routing and focus behavior with or without middleware', async subtest => {
    const digest = 'c'.repeat(64);
    let moduleActions = 0, refreshes = 0;
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'navigation', name: 'Navigation', version: '1.0.0', digest, config: {}, styles: [],
        apiBase: `/_modules/navigation/${digest}/api`, entry: `/_modules/assets/navigation/${digest}/entry.js`,
      }], errors: [] }),
      load: async () => ({ activate: (() => ({
        apiVersion: 2,
        menus: [{ id: 'navigation', menu: 'global', getState: () => ({ label: 'Module navigation' }),
          onSelect: () => { moduleActions++; } }],
        components: [
          { id: 'management', boundary: 'managementHeader', wrap: Base => props => createElement(Base, {
            ...props, actions: createElement(Fragment, null, props.actions,
              createElement('button', { type: 'button', 'aria-label': 'Module list action', onClick: () => { moduleActions++; } }, props.section)),
          }) },
          { id: 'detail', boundary: 'managementDetailHeader', wrap: Base => props => createElement(Base, {
            ...props, actions: createElement(Fragment, null, props.actions,
              createElement('button', { type: 'button', 'aria-label': 'Module detail action', onClick: () => { moduleActions++; } }, props.item)),
          }) },
        ],
      })) satisfies ActivateFrontend }),
      report: failOnReport,
    });
    subtest.after(async () => {
      await act(() => root.render(null));
      runtime.stop();
    });
    const node = (selector: string) => {
      const result = container.querySelector(selector);
      assert.ok(result, selector);
      return result as HTMLElement;
    };
    const click = async (target: HTMLElement) => {
      target.focus();
      await act(async () => { fireEvent.click(target); });
    };
    function Location() { return createElement('output', { className: 'fixture-route' }, useLocation().pathname); }
    function Management() {
      const location = useLocation();
      return createElement(ManagementShell, {
        section: 'skills', item: location.pathname === '/skills/resource' ? 'resource' : null,
        master: null, detail: null, onRefresh: () => { refreshes++; },
      });
    }
    const mount = async (management: boolean, pathname: string) => {
      await act(() => root.render(null));
      await act(() => root.render(createElement(ModuleRuntimeProvider, { runtime,
        children: createElement(MemoryRouter, { initialEntries: [pathname] },
          createElement(management ? Management : GlobalNavigation), createElement(Location)),
      })));
    };
    const noNestedButtons = () => {
      for (const button of Array.from(container.querySelectorAll('button'))) assert.equal(button.querySelector('button'), null);
    };
    for (const enhanced of [false, true]) {
      if (enhanced) await act(async () => { await runtime.start(); });
      await mount(false, '/');
      const trigger = node('[aria-label="全局导航"]');
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(container.querySelector('[role="menu"]'), null);
      assert.equal(container.querySelectorAll('button').length, 1, 'menu extensions do not add a main-view button');
      await click(trigger);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      const items = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      assert.deepEqual(items.map(item => item.textContent), enhanced
        ? ['默认新会话模型', '全局 MCP', '全局 Skills', 'Module navigation']
        : ['默认新会话模型', '全局 MCP', '全局 Skills']);
      assert.equal(document.activeElement, items[0], 'opening focuses the first native menu command');
      await act(() => { fireEvent.keyDown(items[0], { key: 'End' }); });
      assert.equal(document.activeElement, items[items.length - 1]);
      noNestedButtons();
      await act(() => new Promise(resolve => setTimeout(resolve, 1)));
      const escape = new Event('keydown', { cancelable: true });
      Object.defineProperty(escape, 'key', { value: 'Escape' });
      await act(() => window.dispatchEvent(escape));
      assert.equal(escape.defaultPrevented, true);
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(container.querySelector('[role="menu"]'), null);
      assert.equal(document.activeElement, trigger);
      if (enhanced) {
        await click(trigger);
        await click(Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === 'Module navigation')!);
        assert.equal(container.querySelector('[role="menu"]'), null);
        assert.equal(document.activeElement, trigger, 'module actions share native menu close/focus behavior');
      }
      await click(trigger);
      await click(Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === '全局 Skills')!);
      assert.equal(node('.fixture-route').textContent, '/skills');
      assert.equal(container.querySelector('[role="menu"]'), null);
      assert.equal(document.activeElement, trigger);
      assert.equal(node('[aria-label="全局导航"]'), trigger, 'menu changes keep the actual native trigger mounted');

      await mount(true, '/skills');
      assert.equal(document.activeElement, document.body, 'entering management does not move focus to Back');
      assert.equal(node('.pane-title').textContent, '全局 Skills');
      const refresh = node('[aria-label="刷新"]');
      assert.equal(refresh.hasAttribute('disabled'), false);
      await click(refresh);
      assert.equal(refreshes, enhanced ? 2 : 1);
      if (enhanced) await click(node('[aria-label="Module list action"]'));
      noNestedButtons();
      await click(node('[aria-label="返回会话列表"]'));
      assert.equal(node('.fixture-route').textContent, '/');

      await mount(true, '/skills/resource');
      assert.equal(node('.manage-detail-header').querySelector('.pane-title')?.textContent, 'resource');
      assert.equal(document.activeElement, document.body, 'entering a detail does not focus its title');
      if (enhanced) await click(node('[aria-label="Module detail action"]'));
      noNestedButtons();
      await click(node('[aria-label="返回"]'));
      assert.equal(node('.fixture-route').textContent, '/skills');
      assert.equal(container.querySelector('.manage-detail-header'), null);
      assert.equal(document.activeElement, document.body, 'removing detail Back does not focus another control');
      await act(() => root.render(null));
    }
    assert.equal(moduleActions, 3);
  });
  await t.test('App session menus share registrations, dynamic focus, exact targets and revoked action lifetimes', async subtest => {
    const previous = useCockpit.getState();
    const sessions = ['A', 'B'].map(sessionId => ({ ...fixtureSession('user-time'), sessionId, title: `Session ${sessionId}` }));
    useCockpit.setState({
      sessions, activeId: 'A', connState: 'open', snapshotReady: true,
      init: () => () => {},
      setActiveId: activeId => { useCockpit.setState({ activeId }); },
    });
    const listeners = new Set<() => void>();
    const reports: unknown[] = [];
    const calls: { sessionId: string; signal: AbortSignal }[] = [];
    const completions: (() => void)[] = [];
    let disabled = false, visible = true;
    const digest = 'd'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: ['z', 'a'].map(id => ({
        id, name: id, version: '1.0.0', digest, config: {}, styles: [],
        apiBase: `/_modules/${id}/${digest}/api`, entry: `/_modules/assets/${id}/${digest}/entry.js`,
      })), errors: [] }),
      load: async () => ({ activate: ((context) => ({
        apiVersion: 2,
        menus: [{ id: 'info', menu: 'session', getState: target => ({
          label: `${context.moduleId}:${target.menu === 'session' ? target.sessionId : 'global'}${disabled ? ':busy' : ''}`,
          visible, disabled,
        }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        onSelect: (target, { signal }) => {
          assert.equal(target.menu, 'session');
          if (target.menu !== 'session') assert.fail();
          calls.push({ sessionId: target.sessionId, signal });
          return new Promise<void>(resolve => { completions.push(resolve); });
        } }],
      })) satisfies ActivateFrontend }),
      report: error => { reports.push(error); },
    });
    subtest.after(async () => {
      await act(() => root.render(null));
      runtime.stop();
      useCockpit.setState(previous, true);
    });
    const event = async (target: Element, type: string, fields: Record<string, unknown> = {}) => {
      const input = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(input, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])));
      await act(() => { fireEvent(target, input); });
    };
    const click = (target: Element) => event(target, 'click', { detail: 0 });
    const node = (selector: string) => {
      const value = container.querySelector(selector);
      assert.ok(value, selector);
      return value as HTMLElement;
    };
    const items = () => Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const labels = () => items().map(item => item.textContent);
    const refresh = () => act(() => { for (const listener of listeners) listener(); });
    await act(() => root.render(createElement(ModuleRuntimeProvider, { runtime,
      children: createElement(MemoryRouter, { initialEntries: ['/session/A'] }, createElement(App)),
    })));
    const trigger = node('[aria-label="更多操作"]');
    await click(trigger);
    assert.deepEqual(labels(), ['会话设置', '本会话 MCP', '本会话 Skills', '永久删除会话']);
    await event(items()[0], 'keydown', { key: 'End' });
    assert.equal(document.activeElement, items()[3]);
    await event(items()[3], 'keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, items()[2]);
    await act(async () => { await runtime.start(); });
    assert.deepEqual(labels(), ['会话设置', '本会话 MCP', '本会话 Skills', '永久删除会话', 'a:A', 'z:A']);
    assert.equal(container.querySelectorAll('[role="separator"]').length, 2);
    await event(items()[0], 'keydown', { key: 'End' });
    assert.equal(document.activeElement, items()[5]);
    await event(items()[5], 'focusin');
    disabled = true;
    await refresh();
    assert.equal(document.activeElement, items()[0], 'a disabled focused module command returns to a valid native command');
    assert.equal(items()[4].hasAttribute('disabled'), true);
    await event(items()[0], 'keydown', { key: 'End' });
    assert.equal(document.activeElement, items()[3], 'keyboard skips disabled module commands');
    visible = false;
    await refresh();
    assert.equal(items().length, 4);
    assert.equal(container.querySelectorAll('[role="separator"]').length, 1);
    visible = true;
    disabled = false;
    await refresh();
    await click(items()[4]);
    assert.equal(calls[0].sessionId, 'A');
    assert.equal(calls[0].signal.aborted, false, 'normal menu close does not cancel accepted work');
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    const b = node('[data-session-id="B"]');
    await event(b, 'contextmenu', { clientX: 40, clientY: 70 });
    assert.deepEqual(labels(), ['会话设置', '本会话 MCP', '本会话 Skills', '永久删除会话', 'a:B', 'z:B']);
    assert.equal(useCockpit.getState().activeId, 'A', 'a row context menu does not select its session');
    await event(b, 'pointerdown', { pointerType: 'mouse', button: 2, isPrimary: true });
    await event(b, 'contextmenu', { clientX: 40, clientY: 70 });
    await click(items()[5]);
    assert.deepEqual(calls.map(call => call.sessionId), ['A', 'B']);
    assert.equal(document.activeElement, b);
    await event(b, 'pointerdown', { pointerType: 'touch', button: 0, isPrimary: true, clientX: 40, clientY: 70 });
    await act(() => new Promise(resolve => setTimeout(resolve, 470)));
    await event(b, 'pointerup', { pointerType: 'touch' });
    assert.deepEqual(labels().slice(-2), ['a:B', 'z:B'], 'long press consumes the same session registry');
    await event(b, 'click', { detail: 1 });
    assert.equal(useCockpit.getState().activeId, 'A', 'the trailing touch click does not select B');
    await event(b, 'keydown', { key: 'F10', shiftKey: true });
    assert.equal(items().length, 6);
    await click(node('[data-session-id="A"]'));
    await click(b);
    assert.equal(useCockpit.getState().activeId, 'B');
    assert.equal(container.querySelector('[role="menu"]'), null, 'routing closes the old row menu');
    assert.equal(calls[0].sessionId, 'A');
    await act(() => useCockpit.setState({ sessions: [sessions[1]] }));
    assert.equal(calls[0].signal.aborted, true, 'deleting A invalidates only the A action');
    assert.equal(calls[1].signal.aborted, false);
    await click(node('[aria-label="更多操作"]'));
    await act(() => runtime.unregister(runtime.getSnapshot().find(module => module.asset.id === 'z')!));
    assert.equal(calls[1].signal.aborted, true);
    assert.deepEqual(labels().slice(-1), ['a:B']);
    await act(() => { for (const complete of completions) complete(); });
    assert.deepEqual(labels().slice(-1), ['a:B'], 'late completion cannot reinstall a removed contribution');
    await act(() => runtime.stop());
    assert.equal(listeners.size, 0);
    assert.deepEqual(labels(), ['会话设置', '本会话 MCP', '本会话 Skills', '永久删除会话']);
    assert.deepEqual(reports, []);
  });

  await t.test('long-press timers belong to mounted primary gestures and native contextmenu cannot double-open', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    let opens = 0;
    function Gesture() {
      return createElement('button', { ...useLongPress(() => { opens++; }), className: 'gesture' });
    }
    const pointer = async (type: string, fields: Record<string, unknown> = {}) => {
      const target = container.querySelector('.gesture');
      assert.ok(target);
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({
        pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 20, ...fields,
      })) Object.defineProperty(event, key, { value });
      await act(() => { fireEvent(target, event); });
    };
    const tick = () => act(() => subtest.mock.timers.tick(500));
    await act(() => root.render(createElement(Gesture)));
    await pointer('pointerdown', { isPrimary: false });
    await tick();
    assert.equal(opens, 0);
    await pointer('pointerdown');
    await pointer('pointermove', { clientY: 40 });
    await tick();
    assert.equal(opens, 0, 'scroll cancels the pending gesture');
    await pointer('pointerdown');
    await pointer('contextmenu');
    await tick();
    assert.equal(opens, 1, 'native long-press contextmenu cancels the timer');
    await pointer('pointerdown');
    await tick();
    await pointer('contextmenu');
    assert.equal(opens, 2, 'timer-first long press ignores the duplicate native menu');
    await pointer('pointerdown', { pointerType: 'mouse', button: 2 });
    await pointer('contextmenu');
    assert.equal(opens, 3, 'a new right-click remains available');
    await pointer('pointerdown');
    await act(() => root.render(null));
    await tick();
    assert.equal(opens, 3, 'removed rows cannot open a late menu');
  });
  await t.test('native decisions select fresh drafts without moving cached prompt fields or invoking stale choice callbacks', async subtest => {
    let handle!: DraftSchemaHandle<FixtureData>;
    function Rows({ field }: { field: DraftSchemaScope<FixtureData> }) {
      const data = useSyncExternalStore(field.subscribe, field.getSnapshot, field.getSnapshot);
      return data.items.length ? createElement('section', { className: 'fixture-prompt-files' }, data.items.map(item =>
        createElement('span', { key: item.id }, item.id))) : null;
    }
    const digest = 'b'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'attachment', name: 'Attachment', version: '1.0.0', digest, config: {}, styles: [],
        apiBase: `/_modules/attachment/${digest}/api`, entry: `/_modules/assets/attachment/${digest}/entry.js`,
      }], errors: [] }),
      load: async () => ({ activate: ((context => {
        handle = context.state.registerDraft(fixtureSchema());
        return { apiVersion: 2, components: [{
          id: 'files', boundary: 'composer', wrap: Base => props => {
            const field = handle.forDraft(props.draft);
            return createElement(Base, { ...props,
              children: createElement(Fragment, null, props.children, field && createElement(Rows, { field })),
            });
          },
        }] };
      })) satisfies ActivateFrontend }),
      report: failOnReport,
    });
    subtest.mock.method(console, 'error', () => {});
    await runtime.start();
    let value = { ...fixtureSession('reading'), sessionId: 'decision-fields' };
    const group = getDraftSession(value.sessionId), prompt = group.prompt;
    prompt.edit('Cached ordinary prompt');
    runtime.prepareDraft(prompt);
    const field = handle.forDraft(prompt.reference)!;
    appendFixture(field, fixtureItem('Prompt file'));
    let finish!: (value: boolean) => void;
    let choices = 0;
    const sent: NativeDraftRequest[] = [];
    const show = () => root.render(createElement(ModuleRuntimeProvider, { runtime, children: createElement(Thread, {
      session: value, onLoadMore() {}, onSend: request => { sent.push(request); return new Promise(resolve => { finish = resolve; }); },
      onRespondAsk: async () => { choices++; return true; },
    }) }));
    await act(show);
    assert.ok(container.querySelector('.fixture-prompt-files'));
    container.querySelector<HTMLElement>('.chat-input-message')!.focus();
    value = { ...value, ask: { requestId: 'first', question: 'Question one', choices: ['Choice'] } };
    await act(show);
    assert.equal(document.activeElement, container.querySelector('.chat-input-message'), 'a focused editor follows the isolated answer draft');
    const answer = group.current(value);
    assert.notEqual(answer.reference.id, prompt.reference.id);
    assert.equal(answer.getSnapshot().text, '');
    const capturedAsk = answer.getSnapshot();
    assert.deepEqual(capturedAsk.askContext, { question: 'Question one', choices: ['Choice'] });
    value = { ...value, ask: { ...value.ask!, question: 'Updated same question', choices: ['Updated choice'] } };
    await act(show);
    assert.equal(group.current(value), answer);
    assert.deepEqual(answer.getSnapshot().askContext, { question: 'Updated same question', choices: ['Updated choice'] });
    assert.equal(answer.getSnapshot().revision, capturedAsk.revision);
    assert.deepEqual(capturedAsk.askContext, { question: 'Question one', choices: ['Choice'] });
    assert.equal(container.querySelector('.fixture-prompt-files'), null);
    assert.doesNotMatch(container.textContent, /Cached ordinary prompt|Prompt file|不接受附件/);
    const choice = container.querySelector('.chat-ask-choice')!;
    const key = Object.keys(choice).find(name => name.startsWith('__reactProps$'))!;
    const staleChoice = (choice as unknown as Record<string, { onClick(): void }>)[key].onClick;
    await act(() => answer.edit('Retained answer'));
    const enter = new Event('click', { bubbles: true, cancelable: true });
    await act(() => { fireEvent(container.querySelector('.send')!, enter); });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { intent: 'respondAsk', body: { sessionId: value.sessionId, requestId: 'first', answer: 'Retained answer', wasFreeform: true } });
    assert.equal(prompt.getSnapshot().pending, false);
    await act(() => appendFixture(field, fixtureItem('Background upload')));
    await act(() => finish(false));
    assert.equal(group.current(value), answer, 'failure does not restore the prompt before native retirement');
    assert.equal(answer.getSnapshot().text, 'Retained answer');
    assert.equal(prompt.getSnapshot().text, 'Cached ordinary prompt');
    assert.equal(field.getSnapshot().items.length, 2);
    value = { ...value, ask: { requestId: 'second', question: 'Replacement question', choices: ['Choice'] } };
    await act(show);
    assert.equal(answer.getSnapshot().askContext, undefined);
    assert.equal(group.current(value).getSnapshot().text, '');
    value = { ...value, ask: { requestId: 'first', question: 'Reused request ID', choices: ['Choice'] } };
    await act(show);
    assert.notEqual(group.current(value), answer);
    assert.deepEqual(group.current(value).getSnapshot().askContext, { question: 'Reused request ID', choices: ['Choice'] });
    await act(() => staleChoice());
    assert.equal(choices, 0, 'a saved callback cannot answer a reused request occurrence');
    value = { ...value, ask: null };
    await act(show);
    assert.equal(document.activeElement, container.querySelector('.chat-input-message'), 'a focused answer editor follows the restored prompt draft');
    assert.equal(group.current(value), prompt);
    assert.match(container.textContent, /Prompt fileBackground upload/);
    assert.equal(prompt.getSnapshot().text, 'Cached ordinary prompt');
    await act(() => root.render(null));
    runtime.stop();
  });
  await t.test('outside pointer menu dismissal does not steal focus while Escape and Tab return it', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    const requests: (boolean | undefined)[] = [];
    function Menu() {
      useMenuDismiss(restore => { requests.push(restore); });
      return null;
    }
    await act(() => root.render(createElement(Menu)));
    await act(() => subtest.mock.timers.tick(1));
    fireEvent.pointerDown(window);
    const key = (value: string) => {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperty(event, 'key', { value });
      fireEvent(window, event);
      return event;
    };
    assert.equal(key('Escape').defaultPrevented, true);
    assert.equal(key('Tab').defaultPrevented, false, 'native Tab navigation remains in charge');
    assert.deepEqual(requests, [false, undefined, undefined]);
    await act(() => root.render(null));
    fireEvent.pointerDown(window);
    assert.equal(requests.length, 3, 'dismiss listeners are removed with the menu');
  });
  await t.test('Markdown table arrow keys belong to the focused scroll region, not its child links', async () => {
    await act(() => root.render(createElement(MessageBody, {
      body: '| Link | Value |\n| --- | --- |\n| [Child](https://example.invalid) | Wide |',
    })));
    const region = container.querySelector('.chat-table-scroll')!;
    const table = container.querySelector('[data-chat-table]')!;
    const link = table.querySelector('[href="https://example.invalid"]')!;
    Object.assign(table, { scrollWidth: 1000, scrollLeft: 0 });
    const key = async (target: Element) => {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: 'ArrowRight' });
      await act(() => { fireEvent(target, event); });
      return event;
    };
    assert.equal((await key(link)).defaultPrevented, false);
    assert.equal((await key(region)).defaultPrevented, true);
    assert.equal((table as HTMLElement & { scrollLeft: number }).scrollLeft, 80);
    await act(() => root.render(null));
  });
  let prefetches = 0;
  const onLoadMore = () => { prefetches++; };
  const session = (id: string): ChatSession => ({
    sessionId: id, title: id, cwd: '/fixture', lastActivity: 0,
    status: 'idle', loaded: true, error: null, queue: [], ask: null,
    materialized: true, historyStale: false, hasMore: true, loadingHistory: false,
    messages: Array.from({ length: 12 }, (_, i) => ({
      id: `${id}-${i}`, role: 'system', content: `Message ${i}`, timestamp: i,
    })),
  });
  let a = session('lifecycle-a');
  const b = session('lifecycle-b');
  const draft = getSessionDraft(a.sessionId);
  draft.edit('Retained unsent draft');
  const draftSnapshot = draft.getSnapshot();
  const flush = async () => {
    for (let count = 0; frames.size; count++) {
      assert.ok(count < 10, 'RAF work must settle without polling');
      await act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
    }
  };
  const render = async (value: ChatSession | null) => {
    await act(() => root.render(value ? createElement(Thread, {
      key: value.sessionId, session: value, readOnly: true, onLoadMore,
    }) : null));
    await flush();
  };
  const viewport = () => {
    const node = container.querySelector('.chat-messages');
    assert.ok(node);
    return node as HTMLElement;
  };
  const bottom = () => viewport().scrollHeight - viewport().clientHeight;
  const readAt = async (top: number) => {
    const node = viewport();
    await act(() => {
      const wheel = new Event('wheel');
      Object.defineProperties(wheel, { deltaY: { value: -20 }, ctrlKey: { value: false } });
      fireEvent(node, wheel);
      node.scrollTop = top;
      fireEvent.scroll(node);
      fireEvent(node, new Event('scrollend'));
    });
    await flush();
  };
  const anchor = () => {
    const rows = Array.from(viewport().querySelectorAll<HTMLElement>('[data-message-id]'));
    const row = rows.find(node => node.getBoundingClientRect().bottom > 1);
    assert.ok(row);
    return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top };
  };

  const checkCompleteControls = async () => {
    const previous = useCockpit.getState();
    const fixture = createCockpitStore();
    installFullWebFixture(fixture);
    const mirror = () => useCockpit.setState({ ...fixture.getState(), sessions: [...previous.sessions, ...fixture.getState().sessions] });
    const unsubscribe = fixture.subscribe(mirror);
    try {
      mirror();
      await act(() => root.render(createElement(ConnectedThread, { sessionId: workspaceSessionId })));
      await flush();
      const click = async (selector: string, scope: Element = container) => {
        const target = scope.querySelector(selector);
        assert.ok(target, selector);
        await act(() => { fireEvent.click(target); });
        await flush();
      };
      const indicators = Array.from(container.querySelector('.chat-controls-header')!.querySelectorAll('.session-activity-item'));
      assert.equal(indicators[0].getAttribute('data-activity'), 'overall');
      assert.equal(indicators.length, 1, 'task and queue summaries live in headings while expanded');
      assert.ok(indicators[0].querySelector('.spinner'));
      assert.ok(container.querySelector('[aria-label="Agent 列表"]'));
      assert.ok(container.querySelector('[aria-label="Terminal 列表"]'));
      const editor = container.querySelector<TestElement>('.chat-input-message')!;
      await act(() => getSessionDraft(workspaceSessionId).edit('普通消息草稿'));
      editor.focus();
      await click('.chat-controls-toggle');
      assert.equal(container.querySelector('.chat-controls-header')!.querySelectorAll('.session-activity-item').length, 4);
      assert.equal(container.querySelector('.chat-controls-list')?.getAttribute('hidden'), '');
      assert.equal(container.querySelector('.chat-input-message'), editor, 'normal input never folds with activities');
      await act(() => fixture.setState(state => ({ sessions: state.sessions.map(session => session.sessionId === workspaceSessionId
        ? { ...session, ask: { requestId: 'fresh-question', question: '继续吗？', choices: ['继续'], allowFreeform: true } } : session) })));
      await flush();
      assert.equal(container.querySelector('.chat-controls-toggle')?.getAttribute('aria-expanded'), 'true');
      assert.equal(container.querySelector('.chat-input-message'), editor);
      assert.equal(editor.value, '');
      assert.equal(document.activeElement, editor);
      const overall = container.querySelector('.chat-controls-header [data-activity="overall"]');
      assert.ok(overall?.querySelector('.spinner') || overall?.querySelector('[data-icon="decision"]'));
      assert.equal(container.querySelector('[data-activity="decision"]'), null, 'the overall item owns the decision state');
      assert.equal(container.querySelector('.chat-controls-decisions, .chat-question-row'), null);
      const card = container.querySelector('.chat-messages .chat-decision-card[data-state="pending"]');
      assert.ok(card, 'the question is a transcript card');
      assert.ok(card.querySelector('[aria-label="取消问题并中断当前回合"]'), 'cancel lives on the card head');
      await click('.chat-ask-choice');
      assert.equal(container.querySelector('.chat-input-message'), editor);
      assert.equal(editor.value, '普通消息草稿');
      if (container.querySelector('.chat-controls-toggle')?.getAttribute('aria-expanded') !== 'true') await click('.chat-controls-toggle');
      assert.equal(container.querySelector('[aria-label="查看 Agent 详情：独立代码审查"]'), null);
      await click('[aria-label="取消任务：构建项目"]', container.querySelector('[data-task-id="preview-build"]')!);
      assert.equal(container.querySelectorAll('.chat-controls-task').length, 2);
      assert.equal(container.querySelector('[data-task-id="preview-build"]'), null);
      await click('[aria-label="清空 Agent（取消该组任务）"]');
      assert.equal(container.querySelector('[aria-label="Agent 列表"]'), null);
      await click('[aria-label="清空 Terminal（取消该组任务）"]');
      assert.equal(container.querySelector('[aria-label="Terminal 列表"]'), null);
      await click('[aria-label="清空队列"]');
      await act(() => fixture.setState(state => ({ sessions: state.sessions.map(session => session.sessionId === workspaceSessionId
        ? { ...session, ask: { requestId: 'cancel-question', question: '取消这个问题？', allowFreeform: true } } : session) })));
      await click('[aria-label="取消问题并中断当前回合"]');
      assert.equal(container.querySelector('.chat-controls-header'), null, 'confirmed idle has no status bar');
      assert.equal(container.querySelector('.chat-input-message'), editor);
      assert.equal(editor.value, '普通消息草稿');
      let rejectOld!: (error: Error) => void;
      const controls = { token: 'old-handle', sampledAt: 1, main: false, compaction: null,
        tasks: [{ id: 'same-task-id', kind: 'shell' as const, title: 'Native task', status: 'running' as const }], steering: [] };
      const renderHandle = (token: string) => root.render(createElement(SessionControlBar, {
        session: { ...session('handle-owned-actions'), status: 'running', controls: { ...controls, token } },
        controls, connected: true, expanded: true, disabled: false, onToggle() {}, controlRef() {},
        onAction: async () => new Promise<void>((_resolve, reject) => { rejectOld = reject; }),
      }));
      await act(() => renderHandle('old-handle'));
      await click('[aria-label="取消任务：Native task"]');
      await act(() => renderHandle('replacement-handle'));
      assert.ok(container.querySelector('[aria-label="取消任务：Native task"]'));
      await act(() => rejectOld(new Error('Old handle operation failure')));
      assert.doesNotMatch(container.textContent, /Old handle operation failure/);
    } finally {
      await act(() => root.render(null));
      unsubscribe();
      useCockpit.setState(previous, true);
    }
  };

  await t.test('first message commit reaches latest without a RAF, including empty async mounts and cached switches', async () => {
    const commit = async (value: ChatSession | null) => {
      await act(() => root.render(value ? createElement(Thread, {
        session: value, readOnly: true, onLoadMore,
      }) : null));
    };
    for (const initial of ['cached', 'loading', 'empty', 'filtered']) {
      await commit(null);
      const value = { ...session(`initial-${initial}`), hasMore: false };
      if (initial !== 'cached') {
        await commit({ ...value, messages: initial === 'filtered'
          ? [{ id: 'whitespace', role: 'assistant', content: ' \n ', timestamp: 0 }] : [],
        materialized: initial === 'empty', loadingHistory: initial === 'loading' });
        await flush();
        assert.equal(viewport().scrollTop, 0);
        assert.equal(viewport().querySelector('[data-message-frame]'), null,
          'empty and filtered native pages have no rendered content to position');
      }
      await commit(value);
      assert.equal(viewport().scrollTop, bottom(), `${initial}: layout effect must position before queued frames`);
      await flush();
      await act(() => {
        (viewport() as HTMLElement & { clientHeight: number }).clientHeight -= 40;
        for (const resize of resizes) resize();
      });
      assert.equal(viewport().scrollTop, bottom(), 'input/viewport resize must settle before RO returns, not next RAF');
      await flush();
      await readAt(225);
      const reader = anchor();
      await commit({ ...value, messages: [...value.messages, {
        id: 'remote-tail', role: 'system', content: 'Remote tail', timestamp: 20,
      }] });
      await flush();
      assert.deepEqual(anchor(), reader);

      await commit({ ...value, sessionId: `${value.sessionId}-switch` });
      assert.equal(viewport().scrollTop, bottom(), 'same message array in a new session still gets its own initial commit');
      await flush();
    }
    await commit(null);
    const cold = { ...session('initial-user-intent'), messages: [] };
    await commit(cold);
    await flush();
    await readAt(0);
    await commit({ ...cold, messages: session(cold.sessionId).messages });
    assert.equal(viewport().scrollTop, 0, 'a gesture before the first page cancels initial following');
    await flush();
    assert.equal(viewport().scrollTop, 0);
    await commit(null);
  });

  await t.test('all local submission surfaces follow once on ACK, including captured module sends', async subtest => {
    let activation!: ModuleFrontendContext;
    let finish!: (ok: boolean) => void;
    let requests = 0;
    const send = async () => {
      requests++;
      return new Promise<boolean>(resolve => { finish = resolve; });
    };
    const digest = 'd'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'capture-fixture', name: 'Capture fixture', version: '1.0.0', digest, config: {}, styles: [],
        apiBase: `/_modules/capture-fixture/${digest}/api`, entry: `/_modules/assets/capture-fixture/${digest}/entry.js`,
      }], errors: [] }),
      load: async () => ({ activate: (context: ModuleFrontendContext) => {
        activation = context;
        return { apiVersion: 2, writes: ['text'], sends: ['draft'] };
      } }),
      draftSubmission: { check: () => undefined, send },
      report: failOnReport,
    });
    await runtime.start();
    subtest.after(async () => { await act(() => root.render(null)); runtime.stop(); });
    const show = async (value: ChatSession | null, readOnly = false) => {
      await act(() => root.render(value ? createElement(ModuleRuntimeProvider, { runtime,
        children: createElement(Thread, { session: value, onSend: send, onLoadMore: () => {},
          onRespondAsk: send, onRespondPlan: send, onRespondElicitation: send, readOnly }),
      }) : null));
      await flush();
    };
    const dispatch = async (selector: string, type: string, properties: Record<string, unknown> = {}) => {
      const target = container.querySelector(selector);
      assert.ok(target, selector);
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
      await act(() => { fireEvent(target, event); });
    };
    for (const surface of ['button', 'queued-button', 'enter', 'ctrl-enter', 'meta-enter', 'module',
      'ask-choice', 'ask-enter', 'ask-module', 'plan-choice', 'plan-enter', 'plan-module', 'elicitation'] as const) {
      let value: ChatSession = { ...session(`local-${surface}`), hasMore: false,
        ...(surface === 'queued-button' ? { status: 'running' as const, queue: [{ id: 'existing', text: 'Already queued' }] } : {}),
        ...(surface.startsWith('ask') ? { ask: { requestId: 'ask', question: 'Question', choices: ['Choice'], allowFreeform: true } } : {}),
        ...(surface.startsWith('plan') ? { planRequest: { requestId: 'plan', summary: 'Plan', actions: ['interactive'] } } : {}),
        ...(surface === 'elicitation' ? { elicitation: { requestId: 'tool', message: 'Tool confirmation' } } : {}),
      };
      await show(value);
      const source = getDraftSession(value.sessionId).current(value);
      await act(() => source.edit('Synthetic local submission'));
      await readAt(325);
      let captured: Promise<unknown> | undefined;
      const before = requests;
      if (surface.includes('module')) {
        const bound = activation.state.bindDraft(source.reference);
        const intent = bound.captureSend();
        await act(() => { captured = intent.send(bound.getSnapshot().revision); });
      } else if (surface.endsWith('choice') || surface === 'elicitation') {
        await dispatch('.chat-ask-choice', 'click');
      } else if (surface.endsWith('button')) await dispatch('.send', 'click');
      else {
        await dispatch('.chat-input-message', 'focusin');
        await dispatch('.chat-input-message', 'keydown', {
          key: 'Enter', ctrlKey: surface === 'ctrl-enter', metaKey: surface === 'meta-enter',
        });
      }
      assert.equal(requests, before + 1, surface);
      await readAt(125);
      assert.equal(viewport().scrollTop, 125, 'a pending request does not force follow');
      // Native decision removal can precede the HTTP acknowledgement.
      if (surface.startsWith('ask') || surface.startsWith('plan') || surface === 'elicitation') {
        value = { ...value, ask: null, planRequest: null, elicitation: null };
        await show(value);
      }
      await act(async () => { finish(true); await captured; });
      await flush();
      assert.equal(viewport().scrollTop, bottom(), `${surface}: ACK overrides pre-ACK reading`);
      assert.equal(value.messages.length, 12, 'ACK creates no optimistic chat message');
      value = { ...value, messages: [...value.messages, {
        id: 'delayed-local', role: 'user', content: 'Delayed native append', timestamp: 30,
      }] };
      await show(value);
      assert.equal(viewport().scrollTop, bottom(), 'the native DOM append may follow the ACK frame');
      (viewport() as HTMLElement & { clientHeight: number }).clientHeight = 250;
      await act(() => { for (const resize of resizes) resize(); });
      await flush();
      assert.equal(viewport().scrollTop, bottom(), 'later input-card layout changes keep following');
      await readAt(225);
      value = { ...value, status: 'running', queue: [], messages: [...value.messages, {
        id: 'remote-user', role: 'user', content: 'Remote user or queued execution', timestamp: 40,
      }, { id: 'remote-agent', role: 'assistant', content: 'Agent streaming', timestamp: 41, streaming: true }] };
      await show(value);
      assert.equal(viewport().scrollTop, 225, 'post-ACK gestures win over remote messages and queue execution');
      await show(null);
    }
    for (const change of ['switch', 'return', 'unmount', 'read-only', 'failed', 'unknown'] as const) {
      const value = { ...session(`late-module-${change}`), hasMore: false };
      await show(value);
      const source = getSessionDraft(value.sessionId);
      await act(() => source.edit('Original target'));
      const bound = activation.state.bindDraft(source.reference);
      const intent = bound.captureSend();
      let pending!: Promise<unknown>;
      await act(() => { pending = intent.send(bound.getSnapshot().revision); });
      await readAt(125);
      if (change === 'unmount') await show(null);
      if (change === 'read-only') await show(value, true);
      if (change === 'switch' || change === 'return') {
        await show({ ...session('unrelated-local-view'), hasMore: false });
        if (change === 'return') await show(value);
        await readAt(225);
      }
      await act(async () => { finish(change === 'unknown' ? undefined as unknown as boolean : change !== 'failed'); await pending; });
      await flush();
      if (change !== 'unmount') {
        assert.equal(viewport().scrollTop, change === 'switch' || change === 'return' ? 225 : 125, change);
      }
      await show(null);
    }
    const value = { ...session('cancelled-module'), hasMore: false };
    await show(value);
    const source = getSessionDraft(value.sessionId);
    const bound = activation.state.bindDraft(source.reference);
    await readAt(225);
    await act(() => bound.editText('Dictation only'));
    await flush();
    assert.equal(viewport().scrollTop, 225);
    const intent = bound.captureSend();
    intent.cancel();
    const before = requests;
    await act(async () => {
      assert.deepEqual(await intent.send(bound.getSnapshot().revision), { status: 'blocked', reason: 'cancelled' });
    });
    await flush();
    assert.equal(requests, before);
    assert.equal(viewport().scrollTop, 225);
    const blocked = bound.captureSend();
    let release!: () => void;
    await act(() => { release = bound.block('Synthetic recording'); });
    await act(async () => {
      assert.deepEqual(await blocked.send(bound.getSnapshot().revision), { status: 'blocked', reason: 'peer-blocked' });
      release();
    });
    await flush();
    assert.equal(requests, before);
    assert.equal(viewport().scrollTop, 225);

    const background = bound.captureSend();
    const other = { ...session('background-visible'), hasMore: false };
    await show(other);
    await readAt(225);
    let pending!: Promise<unknown>;
    await act(() => { pending = background.send(bound.getSnapshot().revision); });
    assert.equal(viewport().scrollTop, 225, 'background dispatch neither navigates nor scrolls the current thread');
    await show(value);
    await readAt(125);
    await act(async () => { finish(true); await pending; });
    await flush();
    assert.equal(viewport().scrollTop, 125, 'a view opened after dispatch does not inherit its late ACK');
  });

  await render(a);
  assert.equal(viewport().scrollTop, bottom());
  const mounted = viewport();
  await readAt(225);
  const reading = anchor();
  assert.ok(prefetches > 0, 'a mounted reader near the top prefetches older history');
  const measuredContent = container.querySelector('.chat-message-content')!;
  const historyHint = measuredContent.querySelector('.chat-history-loading')!;
  assert.ok(historyHint);
  for (const loadingHistory of [true, false, true, false]) {
    await render({ ...a, loadingHistory });
    assert.equal(container.querySelector('.chat-message-content'), measuredContent);
    const indicator = container.querySelector('.chat-history-loading');
    assert.equal(indicator, historyHint);
    assert.equal(indicator.parentNode, measuredContent.querySelector('.chat-history-controls'));
    assert.equal(viewport().getAttribute('aria-busy'), String(loadingHistory));
    assert.deepEqual(anchor(), reading);
    assert.equal(viewport().scrollTop, 225);
  }
  for (const change of [
    { title: 'Metadata update' },
    { loadingHistory: true },
    { status: 'running' as const, messages: [...a.messages, { id: 'stream', role: 'system' as const, content: 'New', timestamp: 20 }] },
  ]) {
    a = { ...a, ...change };
    await render(a);
    assert.equal(viewport(), mounted, 'ordinary updates must retain the mounted scroll owner');
    assert.deepEqual(anchor(), reading);
    assert.equal(viewport().scrollTop, 225);
  }
  await act(() => {
    const touch = new Event('touchstart');
    Object.defineProperty(touch, 'touches', { value: [{ clientY: 200 }] });
    viewport().dispatchEvent(touch);
  });
  a = { ...a, loadingHistory: false, messages: [
    { id: 'older', role: 'system', content: 'Older page', timestamp: 0 }, ...a.messages,
  ] };
  await render(a);
  assert.equal(viewport().querySelector('[data-message-id="older"]'), null, 'an active gesture holds newly prefetched rows');
  assert.deepEqual(anchor(), reading);
  assert.equal(viewport().scrollTop, 225);
  await act(() => {
    viewport().dispatchEvent(new Event('touchend'));
    viewport().dispatchEvent(new Event('scrollend'));
  });
  await flush();
  assert.deepEqual(anchor(), reading, 'older-page commit preserves the visible message and offset');
  assert.equal(viewport().scrollTop, 325);
  const retainedMessages = a.messages;

  await render(b);
  assert.equal(viewport().scrollTop, bottom());
  await readAt(125);
  await render(a);
  assert.notEqual(viewport(), mounted);
  assert.equal(viewport().scrollTop, bottom(), 'A → B → A must not restore A’s old following:false position');
  assert.equal(a.messages, retainedMessages);
  assert.equal(getSessionDraft(a.sessionId).getSnapshot(), draftSnapshot);

  await readAt(225);
  await render(null); // The phone detail route removes the chat view.
  assert.equal(container.querySelector('.chat-messages'), null);
  await render(a);
  assert.equal(viewport().scrollTop, bottom(), 'phone detail → chat remount must enter at latest');
  assert.equal(a.messages, retainedMessages, 're-entry must retain the existing loaded window');
  assert.equal(getSessionDraft(a.sessionId).getSnapshot(), draftSnapshot);

  let short = { ...session('interrupted-fill'), messages: session('interrupted-fill').messages.slice(0, 2) };
  await render(null);
  await act(() => useCockpit.setState({ snapshotReady: false }));
  const beforeFill = prefetches;
  await render(short);
  assert.equal(prefetches, beforeFill, 'an open transport cannot consume a fill before its snapshot');
  await act(() => useCockpit.setState({ snapshotReady: true, sessions: [short] }));
  await flush();
  assert.equal(prefetches, beforeFill + 1, 'a retained short page is not a completed initial viewport');
  assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null,
    'retained content remains visible while filling');
  await render({ ...short, loadingHistory: true });
  await render(null); // Leave while its older-page request is interrupted.
  await render(short);
  assert.equal(prefetches, beforeFill + 2, 're-entry resumes an interrupted short fill');
  await render({ ...short, loadingHistory: true });
  short = { ...short, messages: session(short.sessionId).messages.slice(0, 5) };
  await render(short);
  assert.equal(prefetches, beforeFill + 3);
  await render({ ...short, loadingHistory: true });
  short = { ...short, messages: session(short.sessionId).messages.slice(0, 6) };
  await render(short);
  assert.equal(prefetches, beforeFill + 3, 'two measured screens complete the fill');
  const enlarged = viewport();
  await act(() => {
    (enlarged as HTMLElement & { clientHeight: number }).clientHeight = 500;
    for (const resize of resizes) resize();
  });
  await flush();
  assert.equal(prefetches, beforeFill + 4, 'a larger mounted viewport requires renewed initial headroom');
  await render({ ...short, historyError: 'Fixture interruption' });
  await act(() => { for (const resize of resizes) resize(); });
  await flush();
  assert.equal(prefetches, beforeFill + 4, 'an error stops automatic filling without hiding retained rows');
  await render({ ...short, hasMore: false });
  assert.equal(prefetches, beforeFill + 4, 'native exhaustion completes a short viewport');

  await t.test('initial fill follows arbitrarily sparse pages until geometry is sufficient', async () => {
    let sparse = { ...session('sparse-fill'), messages: [] as ChatSession['messages'], materialized: false };
    await render(sparse);
    const before = prefetches;
    sparse = { ...sparse, materialized: true };
    for (let page = 0; page < 40; page++) {
      await render({ ...sparse, loadingHistory: true });
      await render(sparse);
      assert.equal(prefetches, before + page + 1, 'no fixed low-density page budget');
      assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null,
        'even sparse initial history has no hidden measurement stage');
    }
    await render({ ...sparse, loadingHistory: true });
    await render({ ...sparse, messages: session(sparse.sessionId).messages.slice(0, 6) });
    assert.equal(prefetches, before + 40);
    assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null);
  });

  await t.test('cold entry displays each received page while further viewport filling continues', async () => {
    const cold = { ...session('progressive-fill'), materialized: false, loadingHistory: true, messages: [] as ChatSession['messages'] };
    await render(cold);
    const before = prefetches;
    const first = session(cold.sessionId).messages.slice(0, 1);
    await render({ ...cold, messages: first });
    const rows = container.querySelector('.chat-message-rows')!;
    const received = rows.querySelector(`[data-message-id="${first[0].id}"]`);
    assert.ok(received);
    for (const name of ['data-preparing', 'aria-hidden', 'inert']) assert.equal(rows.getAttribute(name), null);
    assert.equal(prefetches, before, 'an in-flight page is not duplicated');
    await render({ ...cold, messages: first, materialized: true, loadingHistory: false });
    assert.equal(prefetches, before + 1, 'displaying a short page does not stop two-screen fill');
    await render({ ...cold, messages: first, materialized: true });
    assert.equal(rows.querySelector(`[data-message-id="${first[0].id}"]`), received);
    const second = [{ id: 'progressive-older', role: 'assistant' as const, content: 'Older page', timestamp: 0 }, ...first];
    await render({ ...cold, messages: second, materialized: true, loadingHistory: false });
    assert.equal(prefetches, before + 2);
    assert.ok(rows.querySelector('[data-message-id="progressive-older"]'));
    assert.equal(rows.querySelector(`[data-message-id="${first[0].id}"]`), received);
    await readAt(25);
    const reader = anchor();
    await render({ ...cold, messages: second, materialized: true, loadingHistory: false, historyError: 'Read interrupted' });
    assert.deepEqual(anchor(), reader);
    assert.equal(prefetches, before + 2, 'failed fill retains partial content without retrying');
    assert.equal(rows.getAttribute('inert'), null);
  });

  await t.test('removed execution and queue controls restore focus locally without stealing it across views', async () => {
    let value: ChatSession = { ...session('removed-control'), hasMore: false, status: 'running',
      queue: [{ id: 'first', text: 'First queued' }, { id: 'second', text: 'Second queued' }],
      planRequest: { requestId: 'plan', summary: 'Plan', actions: ['exit_only'] } };
    const show = () => root.render(createElement(Thread, {
      session: value, onLoadMore, onSend: async () => true,
      onCancel: () => {
        value = { ...value, status: 'idle', queue: [], planRequest: null };
        show();
      },
      onRemoveQueued: id => {
        value = { ...value, queue: value.queue?.filter(item => item.id !== id) };
        show();
      },
    }));
    const node = (selector: string) => {
      const element = container.querySelector(selector);
      assert.ok(element, selector);
      return element as TestElement;
    };
    const click = async (target: Element) => {
      if (target instanceof HTMLElement) target.focus();
      await act(() => { fireEvent.click(target); });
    };
    await act(show);
    let editor = node('.chat-input-message');
    await click(node('.chat-typing-stop'));
    assert.notEqual(node('.chat-input-message'), editor, 'ending the plan restores a distinct prompt composer');
    editor = node('.chat-input-message');
    assert.equal(document.activeElement, editor, 'stopping into idle focuses the current prompt editor');
    assert.equal(node('.chat-input-card').getAttribute('data-open'), 'true');

    value = { ...value, queue: [{ id: 'first', text: 'First queued' }, { id: 'second', text: 'Second queued' }] };
    await act(show);
    const second = node('[aria-label="移除排队消息：Second queued"]');
    await click(node('[aria-label="移除排队消息：First queued"]'));
    assert.equal(document.activeElement, second, 'queue deletion moves to the next surviving remove action');
    await click(second);
    assert.equal(document.activeElement, editor, 'removing the last item restores the editor');

    value = { ...value, status: 'running', compacting: false };
    await act(show);
    await click(node('.chat-execution-toggle'));
    assert.equal(node('.chat-input-card-body').getAttribute('hidden'), '');
    node('.chat-typing-stop').focus();
    value = { ...value, compacting: true };
    await act(show);
    assert.equal(document.activeElement, node('.chat-execution-toggle'), 'hidden or disabled editor falls back to the visible fold toggle');

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    value = { ...value, compacting: false };
    await act(show);
    node('.chat-typing-stop').focus();
    outside.focus();
    value = { ...value, status: 'idle' };
    await act(show);
    assert.equal(document.activeElement, outside, 'a late result cannot override a focus move outside the controls');

    value = { ...value, status: 'running' };
    await act(show);
    node('.chat-typing-stop').focus();
    value = { ...value, sessionId: 'different-focus-owner', status: 'idle' };
    await act(show);
    assert.equal(document.activeElement, document.body, 'a changed session does not focus its editor from an old control');
    value = { ...value, status: 'running' };
    await act(show);
    node('.chat-typing-stop').focus();
    await act(() => root.render(null));
    assert.equal(document.activeElement, document.body, 'unmounting does not schedule focus into a different view');
    document.body.removeChild(outside);
  });

  await t.test('Stop retains focus across native pending cancellation before removal without stealing a later focus move', async () => {
    let value: ChatSession = { ...session('pending-stop-focus'), hasMore: false, status: 'running',
      queue: [{ id: 'queued', text: 'Queued request' }] };
    let requests = 0;
    const show = () => root.render(createElement(Thread, {
      session: value, onLoadMore, onSend: async () => true,
      onCancel: () => {
        requests++;
        value = { ...value, cancelling: true, activeOperations: 1 };
        show();
      },
    }));
    const click = async (target: Element) => {
      await act(() => { fireEvent.click(target); });
    };
    await act(show);
    const editor = container.querySelector<TestElement>('.chat-input-message')!;
    const stop = container.querySelector<TestElement>('.chat-typing-stop')!;
    stop.focus();
    await click(stop);
    assert.equal(stop.hasAttribute('disabled'), false);
    assert.equal(stop.getAttribute('aria-disabled'), 'true');
    assert.equal(stop.getAttribute('aria-busy'), 'true');
    assert.equal(document.activeElement, stop, 'pending native cancellation must not force focus to BODY');
    await click(stop);
    assert.equal(requests, 1, 'focusable pending Stop still blocks duplicate activation');
    value = { ...value, cancelling: false, activeOperations: 0, status: 'idle', queue: [] };
    await act(show);
    assert.equal(document.activeElement, editor, 'pending → removed restores the surviving editor');

    value = { ...value, status: 'running' };
    await act(show);
    const nextStop = container.querySelector<TestElement>('.chat-typing-stop')!;
    nextStop.focus();
    await click(nextStop);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    value = { ...value, cancelling: false, activeOperations: 0, status: 'idle' };
    await act(show);
    assert.equal(document.activeElement, outside, 'finishing an async Stop must respect focus moved outside');
    document.body.removeChild(outside);

    value = { ...value, status: 'running' };
    await act(show);
    const retry = container.querySelector<TestElement>('.chat-typing-stop')!;
    retry.focus();
    await click(retry);
    value = { ...value, cancelling: false, activeOperations: 0 };
    await act(show);
    assert.equal(document.activeElement, retry, 'an unconfirmed cancellation that leaves the turn running retains the same control');
    assert.equal(retry.getAttribute('aria-disabled'), null);
    await act(() => root.render(null));
  });

  await t.test('accepted stop keeps remaining native activity and rejects late feedback for a different target', async () => {
    for (const switchTarget of [false, true]) {
      let value = fixtureSession('activity-mixed');
      value = { ...value, sessionId: `activity-stop-${switchTarget}` };
      let accept!: () => void;
      let calls = 0;
      const show = async () => {
        await act(() => root.render(createElement(Thread, {
          session: value, onLoadMore,
          onCancel: async () => { calls++; await new Promise<void>(resolve => { accept = resolve; }); },
        })));
        await flush();
      };
      await show();
      const stop = container.querySelector('.chat-typing-stop')!;
      await act(() => { fireEvent.click(stop); });
      assert.equal(calls, 1);
      assert.equal(stop.getAttribute('aria-busy'), 'true');
      if (switchTarget) value = { ...fixtureSession('reading'), sessionId: 'different-stop-target' };
      else value = { ...value, ask: null, activity: activityFixture({
        hasActiveWork: true, tasks: { activeAgents: 1, activeShells: 1, unknown: 0 },
      }) };
      await show();
      await act(async () => { accept(); });
      await flush();
      if (switchTarget) {
        assert.doesNotMatch(container.textContent, /停止请求已受理/);
      } else {
        assert.doesNotMatch(container.textContent, /停止请求已受理|已请求打断/);
        assert.ok(container.querySelector('[data-activity="shell"]'));
        assert.ok(container.querySelector('[data-activity="agent"]'));
        assert.equal(container.querySelector('[data-activity="processing"]'), null);
        assert.equal(container.querySelector('.chat-typing-stop')?.hasAttribute('disabled'), true);
      }
    }
  });

  await t.test('pending decisions retain the same input and independent queue controls across updates', async subtest => {
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const copied: string[] = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      clipboard: { writeText: async (text: string) => { copied.push(text); } },
    } });
    subtest.after(() => previousNavigator
      ? Object.defineProperty(globalThis, 'navigator', previousNavigator) : Reflect.deleteProperty(globalThis, 'navigator'));
    const value: ChatSession = { ...session('dock-transition'), hasMore: false, status: 'running',
      queue: [{ id: 'next', text: '  Keep this queue\nwith original whitespace  ' }], ask: { requestId: 'ask', question: 'Choose', choices: ['A', 'B'] } };
    const promptDraft = getSessionDraft(value.sessionId);
    promptDraft.edit('Cached ordinary prompt');
    let stops = 0;
    const removed: string[] = [];
    const show = async (patch: Partial<ChatSession> = {}) => {
      await act(() => root.render(createElement(Thread, {
        key: value.sessionId, session: { ...value, ...patch }, onLoadMore,
        onCancel: () => { stops++; },
        onRemoveQueued: id => { removed.push(id); },
      })));
      await flush();
    };
    const click = async (target: Element) => {
      await act(() => { fireEvent.click(target); });
    };
    await show();
    const localDraft = getDraftSession(value.sessionId).current(value);
    await act(() => localDraft.edit('Keep typing'));
    const input = container.querySelector('.chat-input-message')!;
    const execution = container.querySelector('.chat-execution-head')!;
    const queue = container.querySelector('.chat-queue-item')!;
    const queueCopy = queue.querySelector('[aria-label="复制排队消息"]')!;
    const queueEntry = queue.querySelector('.chat-queue-entry')!;
    await click(queueCopy);
    assert.deepEqual(copied, [value.queue![0].text]);
    assert.deepEqual(removed, []);
    assert.equal(stops, 0);
    assert.equal(queueEntry.hasAttribute('data-expanded'), false, 'copying does not require or trigger expansion');
    assert.equal(queueCopy.querySelector('.chat-copy-label-text')?.textContent, '已复制');
    queueEntry.setAttribute('data-expanded', '');
    await click(queueCopy);
    assert.equal(queueEntry.hasAttribute('data-expanded'), true, 'expanded copying does not collapse the entry');
    assert.deepEqual(copied, [value.queue![0].text, value.queue![0].text]);
    const decision = container.querySelector('.chat-input-card')!;
    assert.equal(decision.getAttribute('data-decision'), 'true');
    assert.equal(decision.hasAttribute('data-question'), false);
    assert.equal(decision.querySelector('.chat-decision-card'), null, 'the question is in the transcript');
    assert.equal(execution.parentNode, decision);
    const inputContext = container.querySelector('.chat-input-context')!;
    const cardBody = container.querySelector('.chat-input-card-body')!;
    assert.equal(queue.parentNode?.parentNode, inputContext);
    assert.equal(inputContext.parentNode, cardBody);
    assert.equal(container.querySelector('.chat-composer')?.parentNode, cardBody);
    assert.equal(container.querySelector('.chat-typing-stop')?.textContent, '停止并清空队列');
    const folded = () => decision.getAttribute('data-open') === 'false';
    await click(container.querySelector('.chat-execution-toggle')!);
    await show({ title: 'Updated background metadata' });
    assert.equal(folded(), true, 'ordinary updates preserve question collapse');
    assert.equal(container.querySelector('.chat-input-message'), input);
    let finishReply!: (accepted: boolean) => void;
    let reply!: Promise<boolean>;
    await act(() => { reply = localDraft.runAction(() => new Promise(resolve => { finishReply = resolve; })); });
    assert.equal(folded(), true, 'submission feedback does not reopen a manually folded card');
    assert.equal(container.querySelector('.chat-execution-progress')?.textContent, '正在提交回答…');
    assert.equal(container.querySelector('.chat-pending-hint'), null, 'progress belongs to the header, not the answer body');
    assert.equal(container.querySelector('.chat-ask-choice')?.hasAttribute('disabled'), true);
    assert.equal(container.querySelector('.send')?.getAttribute('aria-busy'), 'true');
    await act(async () => { finishReply(false); await reply; });
    assert.equal(folded(), true);
    assert.equal(container.querySelector('[data-activity="overall"]')?.getAttribute('aria-label'), '总状态：等待你回答或确认');
    const error = container.querySelector('.chat-input-notice')!;
    assert.ok(container.querySelector('.chat-input-notices')?.contains(error));
    assert.equal(decision.contains(error), false, 'an unconfirmed result remains outside the card disclosure');
    assert.equal(localDraft.getSnapshot().text, 'Keep typing');
    await act(() => localDraft.dismissNotice());
    await show({ ask: { ...value.ask!, requestId: 'next-question' } });
    assert.equal(folded(), false, 'a different native question opens its own answer composer');
    const nextInput = container.querySelector('.chat-input-message');
    assert.notEqual(nextInput, input);
    assert.equal(getDraftSession(value.sessionId).current({ ask: { requestId: 'next-question' } }).getSnapshot().text, '');
    await click(container.querySelector('.chat-execution-toggle')!);
    assert.equal(folded(), true);
    await show({ ask: null });
    assert.equal(folded(), false, 'ordinary input is restored after a collapsed question resolves');
    assert.equal(decision.getAttribute('data-decision'), null);
    assert.equal(decision.getAttribute('data-question'), null);
    assert.equal(container.querySelector('.chat-input-context'), inputContext);
    assert.equal(container.querySelector('.chat-composer')?.parentNode, cardBody);
    assert.equal(inputContext.contains(container.querySelector('.chat-input-message')!), false);
    assert.notEqual(container.querySelector('.chat-input-message'), nextInput);
    assert.equal(getDraftSession(value.sessionId).current({}), promptDraft);
    assert.equal(promptDraft.getSnapshot().text, 'Cached ordinary prompt');
    assert.equal(container.querySelector('.chat-execution-head'), execution);
    assert.equal(container.querySelector('.chat-queue-item'), queue);
    assert.equal(container.querySelector('[aria-label="复制排队消息"]'), queueCopy);
    assert.equal(queueCopy.querySelector('.chat-copy-label-text')?.textContent, '已复制');
    assert.equal(localDraft.getSnapshot().text, 'Keep typing');
    await show();
    assert.equal(container.querySelector('.chat-execution-head'), execution);
    await click(container.querySelector('.chat-typing-stop')!);
    assert.equal(stops, 1);
    await show({ cancelling: true });
    assert.equal(container.querySelector('.chat-typing-stop')?.hasAttribute('disabled'), false);
    assert.equal(container.querySelector('.chat-typing-stop')?.getAttribute('aria-disabled'), 'true');
    await click(container.querySelector('.chat-typing-stop')!);
    assert.equal(stops, 1);
    assert.equal(localDraft.getSnapshot().text, 'Keep typing');
    assert.equal(container.querySelector('.chat-composer-hint'), null);
    await click(container.querySelector('.chat-queue-remove')!);
    assert.deepEqual(removed, ['next']);
    assert.deepEqual(copied, [value.queue![0].text, value.queue![0].text]);
    await click(container.querySelector('.chat-execution-toggle')!);
    assert.equal(folded(), true);
    await show({ status: 'idle', ask: null, queue: [], activity: activityFixture() });
    assert.equal(folded(), false);
    assert.equal(execution.hasAttribute('hidden'), true, 'idle input has no folding control or extra status row');
    assert.equal(getDraftSession(value.sessionId).current({}), promptDraft);
    assert.equal(container.querySelector<TestElement>('.chat-input-message')?.value, 'Cached ordinary prompt');
    await show({ ask: null });
    assert.equal(folded(), false, 'the next run opens afresh even though its fold key recurs');
  });

  for (const hasMore of [false, true]) {
    await t.test(`continuous streaming remains visible without starving pending viewport fill (hasMore=${hasMore})`, async () => {
      const live = { ...session(`continuous-${hasMore}`), hasMore, materialized: false,
        messages: [] as ChatSession['messages'] };
      await render(live);
      const before = prefetches;
      for (let frame = 0; frame < 120; frame++) {
        await act(() => root.render(createElement(Thread, {
          key: live.sessionId, session: { ...live, materialized: true, messages: [
            { id: 'live-message', role: 'assistant', content: `Stream ${frame}`, timestamp: 1 },
          ] }, readOnly: true, onLoadMore,
        })));
        await act(() => {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(frame);
        });
        assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null);
        assert.match(container.querySelector('.chat-message-rows')!.textContent, new RegExp(`Stream ${frame}`));
      }
      assert.equal(prefetches, before + (hasMore ? 1 : 0), 'stream frames cannot postpone or duplicate the bounded older read');
      await render(null);
    });
  }

  await t.test('model editor stages a full command and late outcomes never rewrite newer local edits', async () => {
    let current = { ...session('model-editor'), currentModelId: 'a',
      availableModels: [
        { modelId: 'a', name: 'Alpha', supportedReasoningEfforts: ['high', 'max'], supportsLongContext: true },
        { modelId: 'b', name: 'Beta', supportedReasoningEfforts: ['high', 'max'], supportsLongContext: true },
      ],
    };
    const calls: { modelId: string; opts: unknown; resolve: (value: IntentResult<'setModel'>) => void; reject: (error: Error) => void }[] = [];
    const onSetModel = (modelId: string, opts: unknown) => new Promise<IntentResult<'setModel'>>((resolve, reject) => {
      calls.push({ modelId, opts, resolve, reject });
    });
    const editor = () => act(() => root.render(createElement(ModelControls, {
      key: current.sessionId, session: current, disabled: false, onSetModel,
    })));
    const control = (label: string) => {
      const node = container.querySelector(`[aria-label="${label}"]`);
      assert.ok(node, label);
      return node as TestElement;
    };
    const event = async (node: Element, type: string) => act(() => {
      fireEvent(node, new Event(type, { bubbles: true }));
    });
    const change = async (label: string, value: string) => {
      const node = control(label);
      node.value = value;
      await event(node, 'change');
    };
    const apply = async () => {
      const button = Array.from(container.querySelector('.ui-pending-bar')?.querySelectorAll<HTMLElement>('.ck-button') ?? [])
        .find(node => node.textContent === '应用');
      assert.ok(button);
      await event(button, 'click');
    };
    await editor();
    await change('选择模型', 'b');
    await change('思考力度', 'max');
    await change('上下文长度', 'long_context');
    assert.equal(calls.length, 0, 'changes only stage the component-owned draft');
    await apply();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].modelId, 'b');
    assert.deepEqual(calls[0].opts, { reasoningEffort: 'max', contextTier: 'long_context' });
    await change('思考力度', 'high');
    await act(() => calls[0].resolve({ ok: true, result: {
      deferred: true, status: 'applied', message: 'Model changed...',
      modelState: { modelId: 'a', reasoningEffort: 'low', contextTier: 'default' },
    } }));
    assert.equal(control('思考力度').value, 'high', 'queued ACK preserves the newer unsent edit');
    assert.match(container.textContent, /已接受，等待生效/);
    assert.doesNotMatch(container.textContent, /上次原生返回：已应用/);
    assert.doesNotMatch(container.textContent, /Model changed/, 'raw native result fields are not rendered');
    assert.equal(container.querySelector('.info-model-current'), null, 'selects present the known native value');
    assert.match(container.querySelector('.ui-pending-bar')?.textContent ?? '', /有未应用的修改/);
    current = { ...current, currentModelId: 'b' };
    await editor();
    assert.equal(control('思考力度').value, 'high', 'native current updates are not desired editor state');
    await apply();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].opts, { reasoningEffort: 'high', contextTier: 'long_context' });
    await change('上下文长度', '');
    await act(() => calls[1].resolve({ ok: true, result: { status: 'applied', persistenceError: 'Fixture save failed' } }));
    assert.equal(control('上下文长度').value, '');
    assert.match(container.textContent, /已应用模型设置.*保存模型设置失败：Fixture save failed/);
    await apply();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].opts, { reasoningEffort: 'high' }, 'unselected context is omitted for native handling');
    await act(() => calls[2].reject(new Error('Uncertain HTTP result')));
    assert.match(container.textContent, /结果未知：Uncertain HTTP result/);
    await apply();
    assert.equal(calls.length, 3, 'the same uncertain submission is not silently retried');
    await change('思考力度', 'max');
    await apply();
    assert.equal(calls.length, 4);
    current = { ...current, sessionId: 'another-model-editor', currentModelId: 'a' };
    await editor();
    await act(() => calls[3].resolve({ ok: true, result: { status: 'rejected', message: 'Late old-session failure' } }));
    assert.equal(control('选择模型').value, 'a');
    assert.doesNotMatch(container.textContent, /Late old-session failure|Uncertain HTTP result/);
    assert.equal(calls.length, 4, 'no queued or rejected result generates a follow-up');
  });

  await t.test('model panel keeps its latest draft editable through refresh and submission with one busy indicator', async () => {
    const previous = useCockpit.getState();
    const current: ChatSession = {
      ...session('model-panel'), currentModelId: 'a', currentReasoningEffort: 'high', currentContextTier: 'default',
      availableModels: ['a', 'b'].map(modelId => ({
        modelId, name: modelId, supportedReasoningEfforts: ['high', 'max'], supportsLongContext: true,
      })),
    };
    const native: SessionProjection = {
      sessionId: current.sessionId, loaded: true, currentModelId: 'a',
      currentReasoningEffort: 'high', currentContextTier: 'default', availableModels: current.availableModels,
    };
    const reads: { resolve: (value: SessionProjection) => void; reject: (error: Error) => void }[] = [];
    const mutations: { resolve: (value: IntentResult<'setModel'>) => void; opts: unknown }[] = [];
    const onSetModel = (_modelId: string, opts: unknown) => new Promise<IntentResult<'setModel'>>(resolve => {
      mutations.push({ resolve, opts });
    });
    const panel = (value = current) => act(async () => root.render(createElement(SessionInfoPanel, {
      session: value, open: true, onClose: () => {}, onSetModel,
    })));
    const node = (selector: string) => {
      const found = container.querySelector(selector);
      assert.ok(found, selector);
      return found as TestElement;
    };
    const event = (target: Element, type: string) => act(() => {
      fireEvent(target, new Event(type, { bubbles: true }));
    });
    const change = async (label: string, value: string) => {
      const target = node(`[aria-label="${label}"]`);
      assert.equal(target.hasAttribute('disabled'), false, `${label} remains editable`);
      target.value = value;
      await event(target, 'change');
    };
    const apply = () => {
      const button = node('.ui-pending-bar').querySelector('.ck-primary');
      assert.ok(button, 'model section has its own Apply action');
      assert.match(button.textContent, /^(应用|正在提交…)$/);
      return button;
    };
    const refresh = () => node('[aria-label="刷新"]');
    const invalidate = (revision: number) => act(async () => {
      useCockpit.setState({ resourceRevisions: { [current.sessionId]: { model: revision } } });
    });
    try {
      await act(() => useCockpit.setState({
        sessions: [current], resourceRevisions: {},
        getResources: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
      }));
      await panel();
      assert.equal(reads.length, 1);
      const roleEntry = container.querySelector('.ui-section-actions')?.querySelector('[aria-label="追加模块角色"]');
      assert.ok(roleEntry);
      assert.equal(roleEntry.hasAttribute('disabled'), false, 'passive role disclosure is independent of model availability');
      assert.equal(container.querySelector('.ui-pending-bar'), null, 'summary metadata cannot authorize Apply');
      assert.equal(node('[aria-label="选择模型"]').hasAttribute('disabled'), true);
      assert.equal(container.querySelectorAll('.spinner').length, 1, 'first read has only the body loader');
      assert.equal(refresh().getAttribute('aria-busy'), 'false');
      assert.equal(refresh().hasAttribute('disabled'), true);
      assert.ok(node('[aria-label="复制 session ID"]'), 'ID copying is directly available');
      await act(() => reads[0].resolve(native));
      assert.equal(node('[aria-label="思考力度"]').value, 'high', 'selects show the native current value');
      assert.equal(node('[aria-label="上下文长度"]').value, 'default');
      assert.equal(container.querySelector('.info-model-current'), null);
      assert.equal(container.querySelector('.ui-pending-bar'), null, 'no bar until the draft differs');
      await change('选择模型', 'b');
      await change('思考力度', 'max');
      await change('上下文长度', 'long_context');
      await invalidate(1);
      assert.equal(reads.length, 2);
      assert.equal(container.querySelectorAll('.spinner').length, 1, 'background refresh has only the icon spinner');
      assert.equal(refresh().getAttribute('aria-busy'), 'true');
      assert.doesNotMatch(container.textContent, /加载中/);
      assert.equal(apply().hasAttribute('disabled'), false, 'accepted same-generation data still authorizes Apply');
      await event(apply(), 'click');
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0].opts, { reasoningEffort: 'max', contextTier: 'long_context' });
      assert.equal(apply().textContent, '正在提交…');
      assert.equal(apply().getAttribute('aria-busy'), 'true');
      assert.equal(container.querySelectorAll('.spinner').length, 0, 'submission owns the sole busy feedback');
      assert.doesNotMatch(container.textContent, /正在应用|正在提交配置/);
      assert.equal(apply().hasAttribute('disabled'), true);
      await event(apply(), 'click');
      assert.equal(mutations.length, 1);
      await change('思考力度', 'high');
      await panel({ ...current, title: 'Background metadata', currentReasoningEffort: 'max' });
      await act(() => reads[1].resolve({ ...native, currentModelId: 'b', currentReasoningEffort: 'max' }));
      assert.equal(node('[aria-label="思考力度"]').value, 'high', 'metadata and accepted rereads never reset a local draft');
      assert.match(node('.info-model-status').textContent, /上次提交：b.*思考力度：最大.*上下文：长上下文/);
      await act(() => mutations[0].resolve({ ok: true, result: { status: 'applied', deferred: true } }));
      assert.match(node('.info-model-status').textContent, /已接受，等待生效/);
      assert.doesNotMatch(node('.info-model-status').textContent, /已应用/);
      assert.equal(apply().hasAttribute('disabled'), false, 'the newer draft can be submitted explicitly');
      await event(apply(), 'click');
      assert.equal(mutations.length, 2);
      assert.deepEqual(mutations[1].opts, { reasoningEffort: 'high', contextTier: 'long_context' });
      await invalidate(2);
      await change('上下文长度', 'default');
      assert.equal(container.querySelectorAll('.spinner').length, 0);
      await act(() => mutations[1].resolve({ ok: true, result: { status: 'applied', persistenceError: 'Native save failed' } }));
      assert.match(node('.info-model-result').textContent, /已应用模型设置.*保存模型设置失败：Native save failed/);
      assert.match(node('.info-model-result').querySelector('[role="alert"]')!.textContent, /保存模型设置失败/,
        'the partial failure is announced, the applied part is not');
      assert.equal(container.querySelectorAll('.spinner').length, 1, 'unfinished reread resumes its own indicator');
      await act(() => reads[2].reject(new Error('Native read unavailable')));
      assert.match(container.textContent, /加载失败：Native read unavailable/);
      assert.equal(container.querySelectorAll('.spinner').length, 0);
      assert.equal(node('[aria-label="上下文长度"]').value, 'default');
      assert.equal(node('[aria-label="上下文长度"]').hasAttribute('disabled'), true);
      assert.equal(apply().hasAttribute('disabled'), true);
      await event(apply(), 'click');
      assert.equal(mutations.length, 2, 'an unavailable read blocks further mutations');
      assert.equal(reads.length, 3, 'neither failure is automatically retried');
      await act(() => useCockpit.setState({ connState: 'connecting' }));
      assert.equal(refresh().hasAttribute('disabled'), true);
      assert.equal(node('[aria-label="选择模型"]').hasAttribute('disabled'), true);
      assert.match(container.textContent, /等待连接/);
    } finally {
      await act(() => root.render(null));
      await act(() => useCockpit.setState(previous, true));
    }
  });

  const processMessage = { id: 'process', role: 'assistant' as const, content: '', timestamp: 1, thought: 'Actual reasoning' };
  const processItems = (messages: typeof processMessage[]) => groupTranscript(messages).flatMap(row => row.kind === 'process' ? row.items : []);
  await act(() => root.render(createElement(MessageProcess, { items: processItems([processMessage]), sessionId: 'A', latest: true })));
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'true');
  await act(() => root.render(createElement(MessageProcess, { items: processItems([{ ...processMessage, thought: 'Updated reasoning' }]), sessionId: 'A', latest: false })));
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false', 'an automatically open overview closes when it is no longer latest');
  await act(() => root.render(null));
  await act(() => root.render(createElement(MessageProcess, { items: processItems([processMessage]), sessionId: 'A', latest: false })));
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false', 'history re-entry starts compact');
  assert.equal(container.querySelector('.msg-thought'), null);

  let toggleChoice: () => void = () => { throw new Error('Choice probe not mounted'); };
  function ChoiceProbe({ choice }: { choice: string }) {
    const { toggle } = useDisclosureChoice(choice, false);
    useLayoutEffect(() => { toggleChoice = toggle; }, [toggle]);
    return null;
  }
  const choiceKey = JSON.stringify(['A', 'overview', 'stable-overview']);
  const renderProcess = async (latest: boolean, items = [processMessage], choice = choiceKey, latestItemId = processItems(items).at(-1)?.key) => {
    await act(() => root.render(createElement(DisclosureChoices, {
      children: [
        createElement(MessageProcess, { key: 'process', identity: 'stable-overview', items: processItems(items), sessionId: 'A', latest, latestItemId }),
        createElement(ChoiceProbe, { key: 'probe', choice }),
      ],
    })));
  };
  await renderProcess(false);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('.process-summary-counts')?.textContent, '1');
  await act(() => toggleChoice());
  await renderProcess(false, [{ ...processMessage, thought: 'Updated after manual expansion' }]);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'true', 'manual open survives updates of an older overview');
  const thoughtNode = container.querySelector('.thought-toggle');
  assert.ok(thoughtNode);
  const childAnchor = thoughtNode.parentNode?.parentNode;
  await renderProcess(true);
  await act(() => toggleChoice());
  await renderProcess(true, [{ ...processMessage, thought: 'Latest, but manually closed' }]);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false', 'manual close overrides latest default');
  await renderProcess(false);
  await renderProcess(true);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false', 'latest transitions do not erase a manual choice');
  assert.equal(container.querySelector('.process-summary-counts')?.textContent, '1');
  assert.equal(container.querySelector('.thought-toggle'), thoughtNode, 'closing the overview retains mounted children');
  await act(() => toggleChoice());
  assert.equal(container.querySelector('.thought-toggle'), thoughtNode, 'reopening retains child identity');
  assert.equal(thoughtNode.parentNode?.parentNode, childAnchor, 'the transcript anchor remains mounted');
  const secondThought = { ...processMessage, id: 'second-thought', thought: 'Second thought' };
  const firstThoughtKey = JSON.stringify(['A', 'thought', processMessage.id]);
  await renderProcess(true, [processMessage, secondThought], firstThoughtKey);
  assert.equal(container.querySelector('.process-summary-count')?.getAttribute('title'), '2 次思考');
  assert.deepEqual(Array.from(container.querySelectorAll('.thought-toggle')).map(node => node.getAttribute('aria-expanded')), ['false', 'true']);
  await act(() => toggleChoice());
  await renderProcess(true, [processMessage, secondThought, { ...secondThought, id: 'third-thought' }], firstThoughtKey);
  assert.deepEqual(Array.from(container.querySelectorAll('.thought-toggle')).map(node => node.getAttribute('aria-expanded')), ['true', 'false', 'true'],
    'only latest thought opens automatically; a manually opened old thought stays open');
  await renderProcess(true, [processMessage, secondThought], firstThoughtKey, 'newer-body');
  assert.deepEqual(Array.from(container.querySelectorAll('.thought-toggle')).map(node => node.getAttribute('aria-expanded')), ['true', 'false'],
    'newer speech closes automatic thought selection but retains the manually opened thought');

  const response = { ...processMessage, id: 'response-body-first', content: 'Body first', thought: undefined };
  await render({ ...a, messages: [response] });
  const responseBody = container.querySelector('.message-body');
  assert.ok(responseBody);
  await render({ ...a, messages: [{ ...response, thought: 'Thinking arrived afterwards' }] });
  assert.equal(container.querySelector('.message-body'), responseBody, 'inserting response thinking must not remount its body');
  assert.equal(container.querySelector('.thought-toggle')?.getAttribute('aria-expanded'), 'false', 'the body is still the latest visible content');
  await render({ ...a, messages: [{ ...response, content: 'Body first, completed', thought: 'Thinking arrived afterwards' }] });
  assert.equal(container.querySelector('.message-body'), responseBody, 'the complete response uses the same renderer and layout');
  assert.equal(container.querySelectorAll('.thought-toggle').length, 1);

  const body = '| A | B |\n|---|---|\n| one | two |\n\nStable native text.';
  const renderBody = (content = body) => act(async () => root.render(createElement(MessageBody, {
    body: content,
  })));
  await renderBody();
  const table = container.querySelector('[data-chat-table]');
  assert.ok(table);
  for (const content of [body, `${body}\n\nNext streamed paragraph.`, `${body}\n\nAnother streamed paragraph.`]) {
    await renderBody(content);
    assert.equal(container.querySelector('[data-chat-table]'), table, 'body updates retain the table renderer');
  }
  await act(async () => root.render(null));
  await renderBody();
  assert.notEqual(container.querySelector('[data-chat-table]'), table, 'a real unmount releases native render nodes');

  await t.test('streamed thinking keeps the same Markdown nodes through updates and completion', async () => {
    const thought = { id: 'thinking-markdown', role: 'assistant' as const, content: '', timestamp: 1,
      thought: '## Thinking\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```ts\nconst exact = 1;\n```\n\nWorking' };
    const current = { ...session('thinking-renderer'), hasMore: false, status: 'running' as const, messages: [thought] };
    await render(current);
    const detail = container.querySelector('.msg-thought')!;
    const markdown = detail.querySelector('.message-body');
    const table = detail.querySelector('[data-chat-table]');
    const code = detail.querySelector('.chat-code-block');
    assert.ok(markdown && table && code);
    await render({ ...current, messages: [{ ...thought, thought: `${thought.thought} **incrementally**.` }] });
    assert.equal(container.querySelector('.msg-thought'), detail);
    assert.equal(detail.querySelector('.message-body'), markdown);
    assert.equal(detail.querySelector('[data-chat-table]'), table);
    assert.equal(detail.querySelector('.chat-code-block'), code);
    await render({ ...current, status: 'idle' });
    assert.equal(detail.querySelector('.message-body'), markdown);
    assert.equal(detail.querySelector('[data-chat-table]'), table);
    assert.equal(detail.querySelector('.chat-code-block'), code);
  });

  await t.test('attachment-only native rows contribute to measured initial history fill', async () => {
    const current = session('attachment-fill');
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      id: `attachment-${i}`, role: 'user' as const, content: '', timestamp: i,
      attachments: [{ type: 'file' as const, path: `/fixture/${i}`, displayName: `Native attachment ${i}` }],
      origin: { sessionId: current.sessionId, messageId: `attachment-${i}` },
    }));
    const before = prefetches;
    await render({ ...current, messages: attachments });
    assert.equal(container.querySelectorAll('[data-message-frame]').length, 6);
    assert.match(container.textContent, /Native attachment 5/);
    assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null);
    assert.equal(prefetches, before, 'six attachment-only rows satisfy two screens');
  });

  await t.test('the native editor leaves ordinary paste and drop events untouched without module middleware', async subtest => {
    const runtime = new ModuleRuntime();
    const draft = getSessionDraft('native-dom-events');
    draft.edit('Native text');
    subtest.after(async () => {
      await act(() => root.render(null));
      runtime.stop();
    });
    await act(() => root.render(createElement(Composer, {
      runtime, draft, onSend: async () => assert.fail('DOM passthrough does not submit'),
    })));
    const editor = container.querySelector<TestElement>('.chat-input-message')!;
    const row = container.querySelector('.chat-input')!;
    assert.equal(editor.parentNode, row);
    assert.equal(container.querySelector('.send')?.parentNode, row);
    assert.deepEqual(Array.from(row.childNodes).map(node => (node as Element).tagName), ['TEXTAREA', 'BUTTON']);
    const snapshot = draft.getSnapshot();
    for (const type of ['paste', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      await act(() => { fireEvent(editor, event); });
      assert.equal(event.defaultPrevented, false);
    }
    assert.equal(draft.getSnapshot(), snapshot);
    assert.equal(container.querySelector('.chat-input-message'), editor);
  });

  await t.test('real input middleware preserves controlled events, refs, IME and captured submit gates', async subtest => {
    let input!: ComposerInputProps;
    let preventKey = false;
    const events: string[] = [];
    const digest = 'b'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'input-fixture', name: 'Input fixture', version: '1.0.0', digest, config: {}, styles: [],
        apiBase: `/_modules/input-fixture/${digest}/api`, entry: `/_modules/assets/input-fixture/${digest}/entry.js`,
      }], errors: [] }),
      load: async () => ({ activate: (() => ({ apiVersion: 2, components: [{
        id: 'input', boundary: 'composerInput', wrap: Base => props => {
          input = props;
          return createElement(Fragment, null, createElement(Base, { ...props,
            onChange: event => { events.push('change'); props.onChange(event); },
            onPaste: event => { events.push(event.currentTarget.tagName); props.onPaste?.(event); },
            onKeyDown: event => { if (preventKey) event.preventDefault(); props.onKeyDown?.(event); },
          }), createElement('button', { type: 'button', 'aria-label': 'Microphone', disabled: props.disabled || props.sendBlocked }, 'Microphone'));
        },
      }] })) satisfies ActivateFrontend }),
      report: failOnReport,
    });
    subtest.after(async () => { await act(() => root.render(null)); runtime.stop(); });
    await runtime.start();
    let draft = getSessionDraft('input-contract');
    let sends = 0;
    let finish!: (value: boolean) => void;
    let sending: Promise<boolean> | undefined;
    const objectRef = { current: null as HTMLTextAreaElement | null };
    const renderInput = (options: Partial<Pick<ComposerProps, 'disabled' | 'sendBlocked' | 'editorRef'>> = {}) => act(() => root.render(createElement(Composer, {
      runtime, draft, onSend: () => { sends++; sending = draft.send(() => new Promise(resolve => { finish = resolve; })); return sending; },
      editorRef: objectRef, ...options,
    })));
    const dispatch = async (type: string, properties: Record<string, unknown> = {}) => {
      const target = container.querySelector('.chat-input-message');
      assert.ok(target);
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
      await act(() => { fireEvent(target, event); });
      return event;
    };
    await renderInput();
    const editor = container.querySelector<TestElement>('.chat-input-message')!;
    assert.equal(objectRef.current, editor);
    assert.equal(input.draft, draft.reference);
    await dispatch('focusin');
    await act(() => { fireEvent.input(editor, { target: { value: 'Native edit' } }); });
    assert.equal(draft.getSnapshot().text, 'Native edit');
    assert.deepEqual(events, ['change']);
    await dispatch('paste');
    assert.deepEqual(events, ['change', 'TEXTAREA']);
    for (const keys of [
      { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', shiftKey: true },
    ]) assert.equal((await dispatch('keydown', keys)).defaultPrevented, false);
    preventKey = true;
    await dispatch('keydown', { key: 'Enter', ctrlKey: true });
    preventKey = false;
    assert.equal(sends, 0);
    await renderInput({ sendBlocked: true });
    assert.equal(editor.hasAttribute('disabled'), false);
    await dispatch('keydown', { key: 'Enter', metaKey: true });
    input.onSubmit();
    assert.equal(sends, 0);
    await renderInput();
    await dispatch('keydown', { key: 'Enter', ctrlKey: true });
    assert.equal(sends, 1);
    assert.equal(editor.hasAttribute('disabled'), false, 'pending submit must not disable native editing');
    await act(() => draft.edit('Newer edit'));
    await dispatch('keydown', { key: 'Enter' });
    assert.equal(sends, 1);
    await act(async () => { finish(true); await sending; });
    assert.equal(editor.value, 'Newer edit', 'ACK retains a newer controlled revision');
    assert.equal(container.querySelector('.chat-input-message'), editor);

    const legacyCalls: (HTMLTextAreaElement | null)[] = [];
    const legacyRef = (node: HTMLTextAreaElement | null) => { legacyCalls.push(node); };
    await renderInput({ editorRef: legacyRef });
    assert.equal(objectRef.current, null);
    assertIdentityList(legacyCalls, [editor]);
    let cleaned = 0;
    const modernCalls: (HTMLTextAreaElement | null)[] = [];
    const modernRef = (node: HTMLTextAreaElement | null) => { modernCalls.push(node); return () => { cleaned++; }; };
    await renderInput({ editorRef: modernRef });
    assertIdentityList(legacyCalls, [editor, null]);
    assertIdentityList(modernCalls, [editor]);
    const oldSubmit = input.onSubmit;
    await act(() => { draft = getSessionDraft('replacement-input'); });
    await renderInput({ editorRef: modernRef, disabled: true });
    await act(() => oldSubmit());
    assert.equal(sends, 1, 'a captured action never submits a replacement draft');
    await act(() => root.render(null));
    assert.equal(cleaned, 1);
    assertIdentityList(modernCalls, [editor], 'React 19 invokes cleanup instead of callback(null)');
  });

  await t.test('paired speech consumer mounts the real input and keeps feedback, leases, refs and focus scoped', {
    skip: !process.env.COCKPIT_TEST_SPEECH_ENTRY,
  }, async subtest => {
    const { activate } = await import(pathToFileURL(process.env.COCKPIT_TEST_SPEECH_ENTRY!).href);
    assert.equal(typeof activate, 'function');
    const fileActivate: ActivateFrontend = context => ({
      apiVersion: 2, components: [{
        id: 'file-fixture', boundary: 'composerEditor',
        wrap: Base => props => createElement(Base, props,
          props.operation === 'prompt' ? context.react.createElement('button', { type: 'button', 'aria-label': 'File fixture' }, 'File') : null,
          props.children),
      }],
    });
    let finish!: (text: string) => void;
    let requests = 0;
    let captures = 0;
    let failNext = false;
    let capturePort: { onmessage: ((event: { data: unknown }) => void) | null } | undefined;
    const audioGlobals = {
      isSecureContext: true,
      navigator: { mediaDevices: { getUserMedia: async () => {
        captures++;
        const track = { kind: 'audio', readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; }, onended: null };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      } } },
      AudioContext: class {
        currentTime = 0;
        state = 'running';
        resume = async () => {};
        close = async () => {};
        destination = {};
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource = () => ({
          connect() { capturePort?.onmessage?.({ data: { type: 'pcm', buffer: new ArrayBuffer(4800) } }); },
          disconnect() {},
        });
      },
      AudioWorkletNode: class {
        port = {
          onmessage: null as ((event: { data: unknown }) => void) | null,
          postMessage: () => {
            queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ended', limited: false } }));
          },
          close() {},
        };
        constructor() { capturePort = this.port; }
        connect() {}
        disconnect() {}
      },
      WebSocket: class {
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        bufferedAmount = 0;
        constructor(url: string) {
          assert.equal(new URL(url).origin, 'wss://synthetic.openai.azure.com');
          queueMicrotask(() => this.onopen?.());
        }
        send(message: string) {
          const { type, session } = JSON.parse(message);
          if (type === 'session.update') {
            this.onmessage?.({ data: JSON.stringify({ type: 'session.updated', session }) });
          } else if (type === 'input_audio_buffer.commit') {
            if (failNext) {
              failNext = false;
              this.onmessage?.({ data: JSON.stringify({ type: 'error', error: { code: 'RateLimitReached' } }) });
              return;
            }
            this.onmessage?.({ data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'fixture-item' }) });
            finish = text => this.onmessage?.({ data: JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed', item_id: 'fixture-item', content_index: 0, transcript: text,
            }) });
          } else if (type === 'input_audio_buffer.clear') {
            this.onmessage?.({ data: JSON.stringify({ type: 'input_audio_buffer.cleared' }) });
          } else assert.equal(type, 'input_audio_buffer.append');
        }
        close() {}
      },
    };
    for (const [key, value] of Object.entries(audioGlobals)) {
      const original = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { configurable: true, value });
      subtest.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
    }
    const digest = 'c'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/_modules') return Response.json({ modules: [{
          id: 'cockpit-speech', name: 'Speech fixture', version: '0.2.0', digest, styles: [], config: {},
          apiBase: `/_modules/cockpit-speech/${digest}/api`, entry: `/_modules/assets/cockpit-speech/${digest}/entry.js`,
        }, {
          id: 'file-fixture', name: 'File fixture', version: '1.0.0', digest, styles: [], config: {},
          apiBase: `/_modules/file-fixture/${digest}/api`, entry: `/_modules/assets/file-fixture/${digest}/entry.js`,
        }], errors: [] });
        assert.ok(path.endsWith('/session'), 'module backend only mints a credential');
        requests++;
        return Response.json({
          clientSecret: 'synthetic-ephemeral', expiresAt: Math.floor(Date.now() / 1000) + 600, deployment: 'dictation',
          socketUrl: 'wss://synthetic.openai.azure.com/openai/v1/realtime?intent=transcription',
        });
      },
      load: async url => ({ activate: url.includes('/file-fixture/') ? fileActivate : activate }), report: failOnReport,
    });
    subtest.after(async () => { await act(() => root.render(null)); runtime.stop(); });
    await runtime.start();
    runtime.updateView({ sessionId: 'paired-speech', connected: true, visible: true });
    const draft = getSessionDraft('paired-speech');
    draft.edit('hello world');
    let cleaned = 0;
    const refCalls: (HTMLTextAreaElement | null)[] = [];
    const editorRef = (node: HTMLTextAreaElement | null) => { refCalls.push(node); return () => { cleaned++; }; };
    await act(() => root.render(createElement(Composer, { runtime, draft, editorRef, onSend: async () => assert.fail('speech never sends') })));
    const editor = container.querySelector<TestElement>('.chat-input-message')!;
    assertIdentityList(refCalls, [editor]);
    const row = container.querySelector('.chat-input')!;
    const inputControls = (node: Element): HTMLElement[] => Array.from(node.childNodes).flatMap(child => [
      ...(child instanceof HTMLElement && ['BUTTON', 'TEXTAREA'].includes(child.tagName) ? [child] : []),
      ...(child instanceof Element ? inputControls(child) : []),
    ]);
    const file = row.querySelector('[aria-label="File fixture"]')!;
    const microphone = row.querySelector<HTMLElement>('.cockpit-speech-mic')!;
    const send = row.querySelector('.send')!;
    assertIdentityList(inputControls(row), [file, editor, microphone, send],
      'input middleware may wrap the editor without changing control order or duplicating controls');
    assert.equal(file.parentNode, row);
    assert.equal(microphone.parentNode, row);
    assert.equal(send.parentNode, row);
    assert.match(row.getAttribute('class') ?? '', /ck-input-row/, 'native row owns the shared public layout');
    const click = async (selector: string) => {
      const target = container.querySelector(selector);
      assert.ok(target, selector);
      await act(async () => { fireEvent.click(target); });
    };
    editor.setSelectionRange(6, 11);
    microphone.focus();
    await click('.cockpit-speech-mic');
    assert.equal(draft.getSnapshot().blocks.length, 1);
    assert.equal(container.querySelector('.send')!.hasAttribute('disabled'), true);
    assert.equal(container.querySelector('.cockpit-speech-panel'), null, 'recording is expressed by the button, not a phase panel');
    assert.equal(container.querySelector('.cockpit-speech-mic')!.getAttribute('aria-label'), '停止录音并收取剩余文字');
    const status = container.querySelector('.cockpit-speech-status')!;
    assert.ok(status);
    assert.equal(row.contains(status), false, 'status wraps the full input row instead of living inside it');
    assert.equal(status.parentNode, row.parentNode);
    assert.match(status.textContent, /正在录音/);
    await click('.cockpit-speech-mic');
    assert.equal(container.querySelector('.cockpit-speech-mic')!.hasAttribute('disabled'), true);
    assert.equal(container.querySelector('.cockpit-speech-mic')!.getAttribute('aria-busy'), 'true');
    assert.match(container.querySelector('.cockpit-speech-status')!.textContent, /正在处理录音/);
    assert.equal(requests, 1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); finish('speech'); });
    assert.equal(editor.value, 'hello speech');
    assert.notEqual(document.activeElement, editor, 'asynchronous transcription does not take editor focus');
    assert.equal(editor.selectionStart, 12);
    assert.equal(editor.selectionEnd, 12);
    assert.equal(draft.getSnapshot().blocks.length, 0);
    assert.equal(container.querySelector('.cockpit-speech-mic')!.hasAttribute('disabled'), false);
    assert.equal(container.querySelector('.cockpit-speech-panel'), null, 'successful insertion does not lift the editor with a notice');
    assert.equal(container.querySelector('.chat-input-message'), editor);
    assert.equal(container.querySelector('.cockpit-speech-status'), null);

    await click('.cockpit-speech-mic');
    await act(() => draft.edit('manual text'));
    await click('.cockpit-speech-mic');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); finish('recovery'); });
    assert.equal(editor.value, 'manual text');
    assert.equal(container.querySelectorAll('textarea').length, 2, 'one editor and one read-only recovery field');
    assert.match(container.querySelector('.cockpit-speech-panel')!.textContent, /识别结果/);
    const panel = container.querySelector('.cockpit-speech-panel')!;
    assert.equal(row.contains(panel), false);
    assert.equal(panel.parentNode, container.querySelector('.chat-composer')!.parentNode);
    assert.equal(container.querySelector('.cockpit-speech-panel')!.contains(editor), false);
    const recoveryButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent === '插入原输入框光标处')!;
    assert.equal(recoveryButton.hasAttribute('disabled'), false);
    editor.setSelectionRange(3, 7);
    await act(() => { fireEvent.click(recoveryButton); });
    assert.equal(editor.value, 'manrecoveryual text');
    assert.equal(editor.selectionStart, 11);
    assert.equal(document.activeElement, editor);
    assert.equal(requests, 1, 'successive recordings reuse an in-memory credential');
    await click('.cockpit-speech-mic');
    failNext = true;
    await click('.cockpit-speech-mic');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    assert.equal(draft.getSnapshot().blocks.length, 0);
    assert.equal(container.querySelector('.cockpit-speech-panel'), null, 'failure stays on the retry button');
    assert.match(container.querySelector('.cockpit-speech-mic')!.getAttribute('class')!, /\bck-danger\b/);
    const capturesBeforeRetry = captures;
    await click('.cockpit-speech-mic');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); finish('replayed'); });
    assert.equal(captures, capturesBeforeRetry, 'retry does not reopen the microphone');
    assert.match(editor.value, /replayed/);
    assert.equal(draft.getSnapshot().blocks.length, 0);
    await act(() => root.render(null));
    assert.equal(cleaned, 1);
    assertIdentityList(refCalls, [editor], 'composed React 19 ref cleans up without a synthetic null call');
  });

  await t.test('module components retain scoped drafts and native send guards while DOM handlers compose on the real editor', async subtest => {
    let mounts = 0;
    let aboveMounts = 0;
    let disposed = 0;
    const events: { type: string; target: EventTarget; currentTarget: EventTarget; prevented: boolean }[] = [];
    let scoped: ComposerContext | undefined;
    let handle!: DraftSchemaHandle<FixtureData>;
    const reports: unknown[] = [];
    function Action(context: ComposerContext) {
      scoped = context;
      const state = useSyncExternalStore(context.draft.subscribe, context.draft.getSnapshot, context.draft.getSnapshot);
      useLayoutEffect(() => { mounts++; }, []);
      if (state.text === 'Crash module action') throw new Error('Fixture action failed');
      return createElement('button', { type: 'button', 'aria-label': 'Module action',
        onPaste: event => event.preventDefault(), onDrop: event => event.preventDefault(),
      }, state.text || 'Module action');
    }
    function Above({ field }: { field: DraftSchemaScope<FixtureData> }) {
      const state = useSyncExternalStore(field.subscribe, field.getSnapshot, field.getSnapshot);
      useLayoutEffect(() => { aboveMounts++; }, []);
      return state.items.length ? createElement('div', { className: 'fixture-state-panel' }, 'Registered item') : null;
    }
    const digest = 'a'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'fixture', name: 'Fixture', version: '1.0.0', digest, apiBase: `/_modules/fixture/${digest}/api`,
        entry: `/_modules/assets/fixture/${digest}/entry.js`, styles: [], config: {},
      }], errors: [] }),
      load: async () => ({ activate: ((context => {
        handle = context.state.registerDraft(fixtureSchema());
        const observations = context.state.register({
          id: 'observations', create: () => ({ events }),
          dispose: () => { disposed++; },
        });
        return { apiVersion: 2,
        components: [{ id: 'composer', boundary: 'composer', wrap: Base => props => {
          const field = handle.forDraft(props.draft);
          if (!field) return createElement(Base, props);
          return createElement(Base, { ...props,
            children: createElement(Fragment, null, props.children, createElement(Above, { field })),
          });
        } }, { id: 'editor', boundary: 'composerEditor', wrap: Base => props => {
          const bound = { ...props, draft: context.state.bindDraft(props.draft) };
          return createElement(Base, { ...props,
            className: 'fixture-editor',
            children: createElement(Fragment, null, props.children, createElement(Action, bound)),
            onPaste: event => {
              observations.get().events.push({
                type: event.type, target: event.target, currentTarget: event.currentTarget, prevented: event.defaultPrevented,
              });
              props.onPaste?.(event);
            },
            onDrop: event => {
              observations.get().events.push({
                type: event.type, target: event.target, currentTarget: event.currentTarget, prevented: event.defaultPrevented,
              });
              props.onDrop?.(event);
            },
          });
        } }],
        markdown: [{ id: 'broken', matches: () => true, component: () => { throw new Error('Fixture renderer failed'); } }],
      }; })) satisfies ActivateFrontend }),
      report: error => { reports.push(error); },
    });
    subtest.after(async () => {
      await act(() => root.render(null));
      runtime.stop();
    });
    await runtime.start();
    const draft = getSessionDraft('module-lifecycle');
    let sends = 0;
    const requests: NativeDraftRequest[] = [];
    const onSend = () => draft.send(async request => { sends++; requests.push(request); return true; });
    const renderComposer = async (disabled = false) => {
      await act(() => root.render(createElement('details', { className: 'fixture-input-card', open: true },
        createElement(ComposerNotices, { draft }),
        createElement(Composer, { draft, runtime, onSend, disabled }))));
    };
    const dispatch = async (selector: string, type: string, properties: Record<string, unknown> = {}) => {
      const target = container.querySelector(selector);
      assert.ok(target, selector);
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
      await act(async () => { fireEvent(target, event); });
      return event;
    };
    await renderComposer();
    let field = handle.forDraft(draft.reference)!;
    await dispatch('.chat-input-message', 'focusin');
    const action = container.querySelector('[aria-label="Module action"]');
    const editor = container.querySelector<TestElement>('.chat-input-message');
    const context = container.querySelector('.chat-composer-context');
    assert.ok(context);
    assert.equal(context.querySelector('.fixture-state-panel'), null);
    assert.equal(container.querySelector('.module-composer-above'), null);
    assert.equal(container.querySelector('.module-composer-actions'), null);
    const row = container.querySelector('.fixture-editor')!;
    assert.equal(row, container.querySelector('.chat-input'), 'middleware extends the existing input DIV');
    assert.equal(action?.parentNode, row);
    assert.equal(editor?.parentNode, row);
    assert.equal(container.querySelector('.send')?.parentNode, row);
    const scope = scoped!.draft;
    await act(() => draft.edit('Draft update'));
    assert.equal(container.querySelector('[aria-label="Module action"]'), action);
    assert.equal(mounts, 1, 'a draft update must not remount module components');
    assert.equal(scoped!.draft, scope);
    let release!: () => void;
    await act(() => { release = scope.block('Module work pending'); });
    assert.equal(context.querySelector('.chat-input-notice'), null, 'module feedback stays with its own content');
    assert.equal(container.querySelector('.send')?.getAttribute('title'), 'Module work pending');
    assert.equal(container.querySelector('.chat-input-message'), editor);
    for (const keys of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true }]) {
      await dispatch('.chat-input-message', 'keydown', keys);
    }
    await dispatch('.send', 'click');
    assert.equal(sends, 0);
    await act(() => release());
    await dispatch('.chat-input-message', 'keydown', { key: 'Enter', isComposing: true });
    assert.equal(sends, 0, 'IME composition never submits');
    await dispatch('.chat-input-message', 'keydown', { key: 'Enter', ctrlKey: true });
    assert.equal(sends, 1);
    await act(() => appendFixture(field, fixtureItem('native')));
    assert.equal(context.querySelector('.draft-attachments'), null);
    assert.ok(context.querySelector('.fixture-state-panel'));
    assert.equal(aboveMounts, 1, 'empty/nonempty module content and notices must not remount contributions');
    assert.equal(container.querySelector('.chat-input-message'), editor);
    assert.equal(container.querySelector('[aria-label="Module action"]'), action);
    const answerCard = container.querySelector<HTMLDetailsElement>('.fixture-input-card')!;
    answerCard.open = false;
    let releaseFold!: () => void;
    await act(() => { releaseFold = scope.block('Folded module work'); draft.edit('Draft updated while folded'); });
    assert.equal(answerCard.open, false);
    assert.equal(aboveMounts, 1);
    assert.equal(container.querySelector('.chat-input-message'), editor);
    assert.equal(container.querySelector('[aria-label="Module action"]'), action);
    await dispatch('.chat-input-message', 'keydown', { key: 'Enter', ctrlKey: true });
    assert.equal(sends, 1);
    await renderComposer(true);
    await dispatch('.chat-input-message', 'keydown', { key: 'Enter', ctrlKey: true });
    assert.equal(sends, 1);
    await act(() => releaseFold());
    await renderComposer();
    const beforeEvents = draft.getSnapshot();
    const beforeField = field.getSnapshot();
    for (const type of ['paste', 'drop']) {
      const event = await dispatch('.chat-input-message', type);
      assert.equal(event.defaultPrevented, false, 'the host leaves ordinary DOM events untouched');
      const handled = await dispatch('[aria-label="Module action"]', type);
      assert.equal(handled.defaultPrevented, true, 'module children may handle their own DOM events');
    }
    assert.deepEqual(events, [
      { type: 'paste', target: editor, currentTarget: row, prevented: false },
      { type: 'paste', target: action, currentTarget: row, prevented: true },
      { type: 'drop', target: editor, currentTarget: row, prevented: false },
      { type: 'drop', target: action, currentTarget: row, prevented: true },
    ], 'ordinary React bubbling reaches the actual enhanced row once per event');
    assert.equal(draft.getSnapshot(), beforeEvents, 'DOM passthrough does not mutate draft state');
    assert.equal(field.getSnapshot(), beforeField);
    assert.equal(sends, 1);
    await act(() => root.render(null));
    await act(() => appendFixture(field, fixtureItem('after-unmount', 'later')));
    await renderComposer();
    assert.equal(scoped!.draft, scope);
    assert.equal(field.getSnapshot().items.length, 2);
    const restoreConsole = t.mock.method(console, 'error', () => {});
    try {
      await act(() => root.render(createElement(ModuleRuntimeProvider, { runtime, children: createElement(MarkdownReplacement, {
        node: { kind: 'link', target: '/fixture/file', label: 'Native fallback', origin: { sessionId: 'root', messageId: 'native' } },
        fallback: createElement('a', { href: '/fixture/file' }, 'Native fallback'),
      }) })));
      assert.match(container.textContent, /Native fallback/);
      assert.equal(reports.length, 1, 'a broken renderer reports locally instead of replacing core');
      assert.equal(runtime.getSnapshot().length, 0, 'a broken renderer also releases its module');
      assert.equal(disposed, 1);
      assert.throws(() => scope.block('stale'), /Module cannot block/);
      await act(() => root.render(null));
      await act(async () => { runtime.stop(); await runtime.start(); });
      await renderComposer();
      field = handle.forDraft(draft.reference)!;
      await act(() => { scoped!.draft.block('Unfinished module work'); draft.edit('Crash module action'); });
      assert.equal(runtime.getSnapshot().length, 0, 'failed composer plugins are unregistered locally');
      assert.ok(container.querySelector('.chat-input-message'), 'native input survives the plugin render error');
      assert.equal(field.getSnapshot().items.length, 2, 'the last immutable schema snapshot is retained, not submitted');
      assert.equal(draft.getSnapshot().blocks.length, 0);
      assert.equal(disposed, 2);
      assert.doesNotMatch(container.textContent, /移除未完成的选择|Registered item/);
      assert.equal(container.querySelector('.module-draft-recovery'), null);
      await dispatch('.chat-input-message', 'keydown', { key: 'Enter', ctrlKey: true });
      await dispatch('.send', 'click');
      assert.equal(sends, 1, 'module loss must not dispatch text while silently omitting persisted module data');
      assert.equal(draft.getSnapshot().text, 'Crash module action', 'host text stays editable and retained');
      assert.equal(draft.hasUnclaimedStoredData(), true);
      assert.equal(field.getSnapshot().items.length, 2, 'unrestored module values remain recoverable');
    } finally {
      restoreConsole.mock.restore();
      await act(() => root.render(null));
      runtime.stop();
    }
  });
  await t.test('complete App thread applies grouped controls, retains the leading spinner and reuses the answer editor', checkCompleteControls);
});
