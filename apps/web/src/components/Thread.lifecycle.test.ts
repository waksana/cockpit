import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useLayoutEffect } from 'react';
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
  get textContent(): string { return this.text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text: string) {
    this.text = text;
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
  }
  get dataset() { return { messageId: this.getAttribute('data-message-id') }; }
  get options(): HostNode[] { return this.childNodes; }
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
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(() => root.unmount());
    useCockpit.setState({ connState: previousConnection, snapshotReady: previousSnapshotReady });
    for (const restore of restoreGlobals) restore();
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
      assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), 'true');
    }
    await render({ ...sparse, loadingHistory: true });
    await render({ ...sparse, messages: session(sparse.sessionId).messages.slice(0, 6) });
    assert.equal(prefetches, before + 40);
    assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null);
  });

  for (const hasMore of [false, true]) {
    await t.test(`continuous streaming cannot starve readiness or pending viewport fill (hasMore=${hasMore})`, async () => {
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
        if (!hasMore) assert.equal(container.querySelector('.chat-message-rows')?.getAttribute('data-preparing'), null);
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
    assert.match(container.textContent, /当前：a/);
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
      session: value, models: [], open: true, onClose: () => {}, onSetModel,
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
      assert.equal(node('.info-meta-details').getAttribute('open'), null, 'ID starts collapsed');
      await act(() => reads[0].resolve(native));
      assert.match(node('.info-model-current').textContent, /思考力度：高.*上下文：标准上下文/);
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
});
