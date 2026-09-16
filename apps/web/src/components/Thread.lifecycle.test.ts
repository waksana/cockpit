import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useLayoutEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { getSessionDraft } from '../lib/textDraft';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import type { IntentResult, SessionProjection } from '@cockpit/protocol';
import { MessageProcess, Thread } from './Thread';
import { ModelControls, SessionInfoPanel } from './SessionInfoPanel';
import { MessageBody } from './MessageBody';
import { DisclosureChoices } from './DisclosureChoices';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { groupTranscript } from '../lib/transcriptRows';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { ModuleRenderNode } from './ModuleContributions';
import { Composer, ComposerNotices } from './Composer';
import { useLongPress } from '../lib/longpress';
import { useMenuDismiss } from '../lib/useMenuDismiss';
import type { ComposerContext, ModuleFrontendContext } from '@cockpit/module-api';

// A deterministic DOM host for real React mounts/effects, not a replacement
// scroll owner. Each rendered message occupies 100px in a 300px viewport.
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
  // React's input-event fallback is selected before this fixture installs a DOM.
  attachEvent() {}
  detachEvent() {}
  scrollTop = 0;
  clientTop = 0;
  clientHeight = 300;
  clientWidth = 600;
  private text = '';
  selected = false;
  private controlValue = '';

  constructor(tag: string, document: HostDocument) {
    super();
    this.nodeName = this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get isConnected(): boolean { return this === this.ownerDocument.body || (this.parentNode?.isConnected ?? false); }
  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() {
    if (!this.isConnected || this.closest('[hidden]') || this.closest('[inert]')) return [];
    for (let parent = this.parentNode; parent; parent = parent.parentNode) {
      if (parent.tagName === 'DETAILS' && !parent.open
        && !parent.childNodes.find(node => node.tagName === 'SUMMARY')?.contains(this)) return [];
    }
    return [this.getBoundingClientRect()];
  }
  get textContent(): string { return this.text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text: string) {
    this.text = text;
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
  }
  get dataset() { return { messageId: this.getAttribute('data-message-id') }; }
  get options(): HostNode[] { return this.childNodes; }
  get open() { return this.attributes.has('open'); }
  set open(value: boolean) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get value(): string {
    if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent;
    if (this.tagName === 'SELECT') return this.options.find(option => option.selected)?.value ?? '';
    return this.controlValue;
  }
  set value(value: string) {
    this.controlValue = value;
    if (this.tagName === 'SELECT') for (const option of this.options) option.selected = option.value === value;
  }
  get scrollHeight() { return this.querySelectorAll('[data-message-frame]').length * 100; }
  appendChild(node: HostNode) { return this.insertBefore(node, null); }
  insertBefore(node: HostNode, before: HostNode | null) {
    node.parentNode?.removeChild(node);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: HostNode) {
    if (node.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === 'disabled' && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  matches(selector: string): boolean {
    if (selector === ':disabled') return this.attributes.has('disabled');
    if (selector.startsWith('.')) return (this.getAttribute('class') ?? '').split(' ').includes(selector.slice(1));
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    return !!match && this.attributes.has(match[1])
      && (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
  }
  closest(selector: string): HostNode | null {
    return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null;
  }
  querySelectorAll(selector: string): HostNode[] {
    return this.childNodes.flatMap(node => [
      ...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node: HostNode | null): boolean {
    return node === this || this.childNodes.some(child => child.contains(node));
  }
  getBoundingClientRect(): { top: number; bottom: number } {
    const viewport = this.closest('.chat-messages');
    if (!viewport || this === viewport) return { top: 0, bottom: 300 };
    const frame = this.closest('[data-message-frame]');
    const top = frame ? viewport.querySelectorAll('[data-message-frame]').indexOf(frame) * 100 - viewport.scrollTop
      : -viewport.scrollTop;
    return { top, bottom: top + (frame ? 100 : viewport.scrollHeight) };
  }
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
  getSelection() { return null; }
}

test('Thread lifecycle: re-entry follows latest while mounted updates preserve the reader and resources', async t => {
  const document = new HostDocument();
  const frames = new Map<number, FrameRequestCallback>();
  const resizes = new Set<() => void>();
  let frameId = 0;
  const globals: Record<string, unknown> = {
    document,
    window: Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }),
    Element: HostNode, HTMLElement: HostNode,
    CSS: { escape: (id: string) => id, supports: () => false },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    ResizeObserver: class {
      private callback: () => void;
      constructor(callback: () => void) { this.callback = callback; resizes.add(callback); }
      observe() {}
      disconnect() { resizes.delete(this.callback); }
    },
  };
  const restoreGlobals: (() => void)[] = [];
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    restoreGlobals.push(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Lifecycle fixture must not access a backend'); });
  const previousConnection = useCockpit.getState().connState;
  const previousSnapshotReady = useCockpit.getState().snapshotReady;
  useCockpit.setState({ connState: 'open', snapshotReady: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(() => root.unmount());
    useCockpit.setState({ connState: previousConnection, snapshotReady: previousSnapshotReady });
    for (const restore of restoreGlobals) restore();
  });
  await t.test('long-press timers belong to mounted primary gestures and native contextmenu cannot double-open', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    let opens = 0;
    function Gesture() {
      return createElement('button', { ...useLongPress(() => { opens++; }), className: 'gesture' });
    }
    const pointer = async (type: string, fields: Record<string, unknown> = {}) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({
        target: container.querySelector('.gesture'), pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 20, ...fields,
      })) Object.defineProperty(event, key, { value });
      await act(() => container.dispatchEvent(event));
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
  await t.test('outside pointer menu dismissal does not steal focus while Escape and Tab return it', async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    const requests: (boolean | undefined)[] = [];
    function Menu() {
      useMenuDismiss(restore => { requests.push(restore); });
      return null;
    }
    await act(() => root.render(createElement(Menu)));
    await act(() => subtest.mock.timers.tick(1));
    window.dispatchEvent(new Event('pointerdown'));
    const key = (value: string) => {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperty(event, 'key', { value });
      window.dispatchEvent(event);
      return event;
    };
    assert.equal(key('Escape').defaultPrevented, true);
    assert.equal(key('Tab').defaultPrevented, false, 'native Tab navigation remains in charge');
    assert.deepEqual(requests, [false, undefined, undefined]);
    await act(() => root.render(null));
    window.dispatchEvent(new Event('pointerdown'));
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
    const key = async (target: HostNode) => {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperties(event, { target: { value: target }, key: { value: 'ArrowRight' } });
      await act(() => container.dispatchEvent(event));
      return event;
    };
    assert.equal((await key(link)).defaultPrevented, false);
    assert.equal((await key(region)).defaultPrevented, true);
    assert.equal((table as HostNode & { scrollLeft: number }).scrollLeft, 80);
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
    return node;
  };
  const bottom = () => viewport().scrollHeight - viewport().clientHeight;
  const readAt = async (top: number) => {
    const node = viewport();
    await act(() => {
      const wheel = new Event('wheel');
      Object.defineProperties(wheel, { deltaY: { value: -20 }, ctrlKey: { value: false } });
      node.dispatchEvent(wheel);
      node.scrollTop = top;
      node.dispatchEvent(new Event('scroll'));
      node.dispatchEvent(new Event('scrollend'));
    });
    await flush();
  };
  const anchor = () => {
    const rows = viewport().querySelectorAll('[data-message-id]');
    const row = rows.find(node => node.getBoundingClientRect().bottom > 1);
    assert.ok(row);
    return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top };
  };

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
  await act(() => useCockpit.setState({ snapshotReady: true }));
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
    enlarged.clientHeight = 500;
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
      return element;
    };
    const click = async (target: HostNode) => {
      target.focus();
      const event = new Event('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      await act(() => container.dispatchEvent(event));
    };
    await act(show);
    const editor = node('.chat-input-message');
    await click(node('.chat-typing-stop'));
    assert.equal(document.activeElement, editor, 'stopping into idle focuses the surviving editor');
    assert.equal(node('.chat-input-card').open, true);

    value = { ...value, queue: [{ id: 'first', text: 'First queued' }, { id: 'second', text: 'Second queued' }] };
    await act(show);
    const second = node('[aria-label="移除排队消息：Second queued"]');
    await click(node('[aria-label="移除排队消息：First queued"]'));
    assert.equal(document.activeElement, second, 'queue deletion moves to the next surviving remove action');
    await click(second);
    assert.equal(document.activeElement, editor, 'removing the last item restores the editor');

    value = { ...value, status: 'running', compacting: false };
    await act(show);
    node('.chat-typing-stop').focus();
    node('.chat-input-card').open = false;
    value = { ...value, compacting: true };
    await act(show);
    assert.equal(document.activeElement, node('.chat-execution-head'), 'hidden or disabled editor falls back to the visible summary');

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
    const click = async (target: HostNode) => {
      const event = new Event('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      await act(() => container.dispatchEvent(event));
    };
    await act(show);
    const editor = container.querySelector('.chat-input-message')!;
    const stop = container.querySelector('.chat-typing-stop')!;
    stop.focus();
    await click(stop);
    assert.equal(stop.attributes.has('disabled'), false);
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
    const nextStop = container.querySelector('.chat-typing-stop')!;
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
    const retry = container.querySelector('.chat-typing-stop')!;
    retry.focus();
    await click(retry);
    value = { ...value, cancelling: false, activeOperations: 0 };
    await act(show);
    assert.equal(document.activeElement, retry, 'an unconfirmed cancellation that leaves the turn running retains the same control');
    assert.equal(retry.getAttribute('aria-disabled'), null);
    await act(() => root.render(null));
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
    const localDraft = getSessionDraft(value.sessionId);
    localDraft.edit('Keep typing');
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
    const click = async (target: HostNode) => {
      const event = new Event('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      await act(() => container.dispatchEvent(event));
    };
    await show();
    const input = container.querySelector('.chat-input-message')!;
    const execution = container.querySelector('.chat-execution-head')!;
    const queue = container.querySelector('.chat-queue-item')!;
    const queueCopy = queue.querySelector('[aria-label="复制排队消息"]')!;
    const queueEntry = queue.querySelector('.chat-queue-entry')!;
    await click(queueCopy);
    assert.deepEqual(copied, [value.queue![0].text]);
    assert.deepEqual(removed, []);
    assert.equal(stops, 0);
    assert.equal(queueEntry.attributes.has('open'), false, 'copying does not require or trigger expansion');
    assert.equal(queueCopy.querySelector('.chat-copy-label-text')?.textContent, '已复制');
    queueEntry.setAttribute('open', '');
    await click(queueCopy);
    assert.equal(queueEntry.attributes.has('open'), true, 'expanded copying does not collapse the entry');
    assert.deepEqual(copied, [value.queue![0].text, value.queue![0].text]);
    const decision = container.querySelector('.chat-input-card')!;
    assert.equal(decision.getAttribute('data-decision'), 'true');
    assert.equal(execution.parentNode, decision);
    assert.equal(queue.parentNode?.parentNode, container.querySelector('.chat-input-card-body'));
    assert.equal(container.querySelector('.chat-composer')?.parentNode, queue.parentNode?.parentNode);
    assert.equal(container.querySelector('.chat-typing-stop')?.textContent, '停止并清空队列');
    decision.open = false;
    await show({ title: 'Updated background metadata' });
    assert.equal(decision.open, false, 'ordinary updates preserve native question collapse');
    assert.equal(container.querySelector('.chat-input-message'), input);
    let finishReply!: (accepted: boolean) => void;
    let reply!: Promise<boolean>;
    await act(() => { reply = localDraft.runAction(() => new Promise(resolve => { finishReply = resolve; })); });
    assert.equal(decision.open, false, 'submission feedback does not reopen a manually folded card');
    assert.equal(container.querySelector('.chat-execution-label')?.textContent, '正在提交回答…');
    assert.equal(container.querySelector('.chat-pending-hint'), null, 'progress belongs to the header, not the answer body');
    assert.equal(container.querySelector('.chat-ask-choice')?.attributes.has('disabled'), true);
    assert.equal(container.querySelector('.send')?.getAttribute('aria-busy'), 'true');
    await act(async () => { finishReply(false); await reply; });
    assert.equal(decision.open, false);
    assert.equal(container.querySelector('.chat-execution-label')?.textContent, '等待你的回答');
    const error = container.querySelector('.chat-input-notice')!;
    assert.ok(container.querySelector('.chat-input-notices')?.contains(error));
    assert.equal(decision.contains(error), false, 'an unconfirmed result remains outside native disclosure');
    assert.equal(localDraft.getSnapshot().text, 'Keep typing');
    await act(() => localDraft.dismissNotice());
    await show({ ask: { ...value.ask!, requestId: 'next-question' } });
    assert.equal(decision.open, true, 'a different native question opens without replacing the editor');
    assert.equal(container.querySelector('.chat-input-message'), input);
    decision.open = false;
    await show({ ask: null });
    assert.equal(decision.open, true, 'ordinary input is restored after a collapsed question resolves');
    assert.equal(decision.getAttribute('data-decision'), null);
    assert.equal(container.querySelector('.chat-input-message'), input);
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
    assert.equal(container.querySelector('.chat-typing-stop')?.attributes.has('disabled'), false);
    assert.equal(container.querySelector('.chat-typing-stop')?.getAttribute('aria-disabled'), 'true');
    await click(container.querySelector('.chat-typing-stop')!);
    assert.equal(stops, 1);
    assert.equal(localDraft.getSnapshot().text, 'Keep typing');
    assert.equal(container.querySelector('.chat-composer-hint'), null);
    await click(container.querySelector('.chat-queue-remove')!);
    assert.deepEqual(removed, ['next']);
    assert.deepEqual(copied, [value.queue![0].text, value.queue![0].text]);
    decision.open = false;
    await show({ status: 'idle', ask: null, queue: [] });
    assert.equal(decision.open, true);
    assert.equal(execution.attributes.has('hidden'), true, 'idle input has no folding control or extra status row');
    assert.equal(container.querySelector('.chat-input-message'), input);
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
      return node;
    };
    const event = async (node: HostNode, type: string) => act(() => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'target', { value: node });
      container.dispatchEvent(event);
    });
    const change = async (label: string, value: string) => {
      const node = control(label);
      node.value = value;
      await event(node, 'change');
    };
    const apply = async () => {
      const button = container.querySelectorAll('.dialog-btn').find(node => node.textContent === '应用配置');
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
    assert.match(container.textContent, /已接受，等待原生应用/);
    assert.doesNotMatch(container.textContent, /上次原生返回：已应用/);
    assert.match(container.querySelector('.info-model-details')?.textContent ?? '', /Model changed/);
    assert.equal(container.querySelector('.info-model-name')?.textContent, 'Alpha');
    current = { ...current, currentModelId: 'b' };
    await editor();
    assert.equal(control('思考力度').value, 'high', 'native current updates are not desired editor state');
    await apply();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].opts, { reasoningEffort: 'high', contextTier: 'long_context' });
    await change('上下文长度', '');
    await act(() => calls[1].resolve({ ok: true, result: { status: 'applied', persistenceError: 'Fixture save failed' } }));
    assert.equal(control('上下文长度').value, '');
    assert.match(container.textContent, /已应用，但原生持久化失败：Fixture save failed/);
    await apply();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].opts, { reasoningEffort: 'high' }, 'unselected context is omitted for native handling');
    await act(() => calls[2].reject(new Error('Uncertain HTTP result')));
    assert.match(container.textContent, /应用结果未确认：Uncertain HTTP result/);
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
      return found;
    };
    const event = (target: HostNode, type: string) => act(() => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      container.dispatchEvent(event);
    });
    const change = async (label: string, value: string) => {
      const target = node(`[aria-label="${label}"]`);
      assert.equal(target.attributes.has('disabled'), false, `${label} remains editable`);
      target.value = value;
      await event(target, 'change');
    };
    const apply = () => node('.dialog-btn');
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
      assert.equal(apply().attributes.has('disabled'), true, 'summary metadata cannot authorize Apply');
      assert.equal(container.querySelectorAll('.spinner').length, 1, 'first read has only the body loader');
      assert.equal(refresh().getAttribute('aria-busy'), 'false');
      assert.equal(refresh().attributes.has('disabled'), true);
      assert.ok(node('[aria-label="复制 session ID"]'), 'ID copying is directly available');
      await act(() => reads[0].resolve(native));
      assert.match(node('.info-model-current').textContent, /高.*标准上下文/);
      await change('选择模型', 'b');
      await change('思考力度', 'max');
      await change('上下文长度', 'long_context');
      await invalidate(1);
      assert.equal(reads.length, 2);
      assert.equal(container.querySelectorAll('.spinner').length, 1, 'background refresh has only the icon spinner');
      assert.equal(refresh().getAttribute('aria-busy'), 'true');
      assert.doesNotMatch(container.textContent, /加载中/);
      assert.equal(apply().attributes.has('disabled'), false, 'accepted same-generation data still authorizes Apply');
      await event(apply(), 'click');
      assert.equal(mutations.length, 1);
      assert.deepEqual(mutations[0].opts, { reasoningEffort: 'max', contextTier: 'long_context' });
      assert.equal(apply().textContent, '正在提交…');
      assert.equal(apply().getAttribute('aria-busy'), 'true');
      assert.equal(container.querySelectorAll('.spinner').length, 0, 'submission owns the sole busy feedback');
      assert.doesNotMatch(container.textContent, /正在应用|正在提交配置/);
      assert.equal(apply().attributes.has('disabled'), true);
      await event(apply(), 'click');
      assert.equal(mutations.length, 1);
      await change('思考力度', 'high');
      await panel({ ...current, title: 'Background metadata', currentReasoningEffort: 'max' });
      await act(() => reads[1].resolve({ ...native, currentModelId: 'b', currentReasoningEffort: 'max' }));
      assert.equal(node('[aria-label="思考力度"]').value, 'high', 'metadata and accepted rereads never reset a local draft');
      assert.match(node('.info-model-details').textContent, /上次提交：b.*思考力度：最大.*上下文：长上下文/);
      await act(() => mutations[0].resolve({ ok: true, result: { status: 'applied', deferred: true } }));
      assert.match(node('.info-model-status').textContent, /已接受，等待原生应用/);
      assert.doesNotMatch(node('.info-model-status').textContent, /已应用/);
      assert.equal(apply().attributes.has('disabled'), false, 'the newer draft can be submitted explicitly');
      await event(apply(), 'click');
      assert.equal(mutations.length, 2);
      assert.deepEqual(mutations[1].opts, { reasoningEffort: 'high', contextTier: 'long_context' });
      await invalidate(2);
      await change('上下文长度', 'default');
      assert.equal(container.querySelectorAll('.spinner').length, 0);
      await act(() => mutations[1].resolve({ ok: true, result: { status: 'applied', persistenceError: 'Native save failed' } }));
      assert.match(node('.info-model-status').textContent, /已应用，但原生持久化失败：Native save failed/);
      assert.equal(node('.info-model-status').getAttribute('role'), 'alert');
      assert.equal(container.querySelectorAll('.spinner').length, 1, 'unfinished reread resumes its own indicator');
      await act(() => reads[2].reject(new Error('Native read unavailable')));
      assert.match(container.textContent, /加载失败：Native read unavailable/);
      assert.equal(container.querySelectorAll('.spinner').length, 0);
      assert.equal(node('[aria-label="上下文长度"]').value, 'default');
      assert.equal(node('[aria-label="上下文长度"]').attributes.has('disabled'), true);
      assert.equal(apply().attributes.has('disabled'), true);
      await event(apply(), 'click');
      assert.equal(mutations.length, 2, 'an unavailable read blocks further mutations');
      assert.equal(reads.length, 3, 'neither failure is automatically retried');
      await act(() => useCockpit.setState({ connState: 'connecting' }));
      assert.equal(refresh().attributes.has('disabled'), true);
      assert.equal(node('[aria-label="选择模型"]').attributes.has('disabled'), true);
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
  await act(() => toggleChoice());
  await renderProcess(false, [{ ...processMessage, thought: 'Updated after manual expansion' }]);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'true', 'manual open survives updates of an older overview');
  await renderProcess(true);
  await act(() => toggleChoice());
  await renderProcess(true, [{ ...processMessage, thought: 'Latest, but manually closed' }]);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false', 'manual close overrides latest default');
  await renderProcess(false);
  await renderProcess(true);
  assert.equal(container.querySelector('.process-summary')?.getAttribute('aria-expanded'), 'false', 'latest transitions do not erase a manual choice');
  await act(() => toggleChoice());
  const secondThought = { ...processMessage, id: 'second-thought', thought: 'Second thought' };
  const firstThoughtKey = JSON.stringify(['A', 'thought', processMessage.id]);
  await renderProcess(true, [processMessage, secondThought], firstThoughtKey);
  assert.deepEqual(container.querySelectorAll('.thought-toggle').map(node => node.getAttribute('aria-expanded')), ['false', 'true']);
  await act(() => toggleChoice());
  await renderProcess(true, [processMessage, secondThought, { ...secondThought, id: 'third-thought' }], firstThoughtKey);
  assert.deepEqual(container.querySelectorAll('.thought-toggle').map(node => node.getAttribute('aria-expanded')), ['true', 'false', 'true'],
    'only latest thought opens automatically; a manually opened old thought stays open');
  await renderProcess(true, [processMessage, secondThought], firstThoughtKey, 'newer-body');
  assert.deepEqual(container.querySelectorAll('.thought-toggle').map(node => node.getAttribute('aria-expanded')), ['true', 'false'],
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

  await t.test('module components retain type and scoped drafts; send keys, IME, paste and drop share host guards', async () => {
    let mounts = 0;
    let aboveMounts = 0;
    let received = 0;
    let scoped: ComposerContext | undefined;
    const reports: unknown[] = [];
    function Action(context: ComposerContext) {
      scoped = context;
      const state = useSyncExternalStore(context.draft.subscribe, context.draft.getSnapshot, context.draft.getSnapshot);
      useLayoutEffect(() => { mounts++; }, []);
      if (state.text === 'Crash module action') throw new Error('Fixture action failed');
      return createElement('button', { type: 'button', 'aria-label': 'Module action',
        onPaste: event => event.preventDefault(), onDrop: event => event.preventDefault(),
      }, state.text || 'Files');
    }
    function Above(context: ComposerContext) {
      const state = useSyncExternalStore(context.draft.subscribe, context.draft.getSnapshot, context.draft.getSnapshot);
      useLayoutEffect(() => { aboveMounts++; }, []);
      return state.attachments.length ? createElement('div', { className: 'fixture-attachment-panel' }, 'Selected file') : null;
    }
    const digest = 'a'.repeat(64);
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [{
        id: 'fixture', name: 'Fixture', version: '1.0.0', digest, apiBase: `/_modules/fixture/${digest}/api`,
        entry: `/_modules/assets/fixture/${digest}/entry.js`, styles: [], config: {},
      }], errors: [] }),
      load: async () => ({ activate: (_context: ModuleFrontendContext) => ({
        writes: ['attachments'], composerActions: [{ id: 'action', component: Action }],
        composerAbove: [{ id: 'above', component: Above }],
        fileInput: [{ id: 'files', accepts: () => true, receive: (_files: readonly File[], context: ComposerContext) => { received++; scoped = context; } }],
        chatRenderers: [{ id: 'broken', matches: () => true, component: () => { throw new Error('Fixture renderer failed'); } }],
      }) }),
      report: error => { reports.push(error); },
    });
    await runtime.start();
    const draft = getSessionDraft('module-lifecycle');
    let sends = 0;
    const onSend = () => draft.send(async () => { sends++; return true; });
    const renderComposer = async (operation: ComposerContext['operation'] = 'prompt', disabled = false) => {
      await act(() => root.render(createElement('details', { className: 'fixture-input-card', open: true },
        createElement(ComposerNotices, { draft, operation }),
        createElement(Composer, { draft, runtime, onSend, operation, disabled,
        ask: operation === 'ask' ? { request: { requestId: 'module-question', question: 'Choose', choices: ['A'] }, onChoice() {} } : undefined,
      }))));
    };
    const dispatch = async (selector: string, type: string, properties: Record<string, unknown> = {}) => {
      const target = container.querySelector(selector);
      assert.ok(target, selector);
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
      await act(async () => { container.dispatchEvent(event); });
      return event;
    };
    await renderComposer();
    await dispatch('.chat-input-message', 'focusin');
    const action = container.querySelector('[aria-label="Module action"]');
    const editor = container.querySelector('.chat-input-message');
    const context = container.querySelector('.chat-composer-context');
    assert.ok(context);
    assert.equal(context.querySelector('.module-composer-above')?.textContent, '');
    const scope = scoped!.draft;
    await act(() => draft.edit('Draft update'));
    assert.equal(container.querySelector('[aria-label="Module action"]'), action);
    assert.equal(mounts, 1, 'a draft update must not remount module components');
    assert.equal(scoped!.draft, scope);
    let release!: () => void;
    await act(() => { release = scope.block('Upload still pending'); });
    assert.equal(context.querySelector('.chat-input-notice'), null, 'active module upload feedback stays with its item');
    assert.equal(container.querySelector('.send')?.getAttribute('title'), 'Upload still pending');
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
    await act(() => scope.appendAttachments([{ id: 'native', value: { type: 'file', path: '/fixture/native' } }]));
    await renderComposer('ask');
    assert.match(container.textContent, /不接受附件/);
    assert.ok(context.querySelector('.module-draft-attachments'));
    assert.ok(context.querySelector('.fixture-attachment-panel'));
    assert.equal(aboveMounts, 1, 'empty/nonempty module content and notices must not remount contributions');
    assert.equal(container.querySelector('.chat-input-message'), editor);
    assert.equal(container.querySelector('[aria-label="Module action"]'), action);
    const answerCard = container.querySelector('.fixture-input-card')!;
    answerCard.open = false;
    await act(() => draft.edit('Draft updated while folded'));
    assert.equal(answerCard.open, false);
    assert.equal(aboveMounts, 1);
    assert.equal(container.querySelector('.chat-input-message'), editor);
    assert.equal(container.querySelector('[aria-label="Module action"]'), action);
    await dispatch('.chat-input-message', 'keydown', { key: 'Enter', ctrlKey: true });
    assert.equal(sends, 1);
    await renderComposer('prompt', true);
    await dispatch('.chat-input-message', 'keydown', { key: 'Enter', ctrlKey: true });
    assert.equal(sends, 1);
    await renderComposer();
    const clipboard = (text: string) => ({ files: [new File(['x'], 'paste.txt')], getData: () => text });
    const mixed = await dispatch('.chat-input-message', 'paste', { clipboardData: clipboard('plain text') });
    assert.equal(mixed.defaultPrevented, false, 'mixed clipboard text remains native textarea input');
    const filesOnly = await dispatch('.chat-input-message', 'paste', { clipboardData: clipboard('') });
    assert.equal(filesOnly.defaultPrevented, true);
    const textOnly = await dispatch('.chat-input-message', 'paste', { clipboardData: { files: [], getData: () => 'plain' } });
    assert.equal(textOnly.defaultPrevented, false);
    const dropped = await dispatch('.chat-input-message', 'drop', { dataTransfer: { files: [new File(['x'], 'drop.txt')] } });
    assert.equal(dropped.defaultPrevented, true);
    assert.equal(received, 3);
    await dispatch('[aria-label="Module action"]', 'paste', { clipboardData: clipboard('') });
    await dispatch('[aria-label="Module action"]', 'drop', { dataTransfer: { files: [new File(['x'], 'owned.txt')] } });
    assert.equal(received, 3, 'events handled by a module control do not start a second host receive');
    await act(() => root.render(null));
    await act(() => scope.appendAttachments([{ id: 'after-unmount', value: { type: 'file', path: '/fixture/later' } }]));
    await renderComposer();
    assert.equal(scoped!.draft, scope);
    assert.equal(draft.getSnapshot().attachments.length, 2);
    const restoreConsole = t.mock.method(console, 'error', () => {});
    try {
      await act(() => root.render(createElement(ModuleRenderNode, {
        runtime, node: { kind: 'link', target: '/fixture/file', label: 'Native fallback', origin: { sessionId: 'root', messageId: 'native' } },
        fallback: createElement('a', { href: '/fixture/file' }, 'Native fallback'),
      })));
      assert.match(container.textContent, /Native fallback/);
      assert.equal(reports.length, 1, 'a broken renderer reports locally instead of replacing core');
      await renderComposer();
      await act(() => { scope.block('Selected file not finished'); draft.edit('Crash module action'); });
      assert.equal(runtime.getSnapshot().length, 0, 'failed composer plugins are unregistered locally');
      assert.ok(container.querySelector('.chat-input-message'), 'native input survives the plugin render error');
      assert.equal(draft.getSnapshot().attachments.length, 2, 'ready native attachments remain usable');
      assert.equal(draft.getSnapshot().blocks[0].orphaned, true);
      assert.match(container.textContent, /移除未完成的选择/);
      assert.ok(container.querySelector('.chat-composer-context')?.querySelector('.module-draft-recovery'),
        'revoked module recovery remains in the composer context');
    } finally {
      restoreConsole.mock.restore();
      await act(() => root.render(null));
      runtime.stop();
    }
  });
});
