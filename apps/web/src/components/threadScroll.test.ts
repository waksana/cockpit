import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { acknowledgeInView } from '../lib/draft';
import type { ChatSession } from '../net/types';
import type { NativeChatEvent, NativeChatRead } from '@cockpit/protocol';
import { NativeWindow } from '../net/nativeWindow';
import { Thread } from './Thread';
import { firstVisibleMessage, observeThreadScroll, ThreadScroll, type ThreadScrollView } from './threadScroll';

test('inline child history anchors the visible child message rather than its enclosing parent card', () => {
  const child = (id: string, top: number, bottom: number) => ({
    getBoundingClientRect: () => ({ top, bottom }),
    querySelector: (selector: string) => selector === '[data-message-id]' ? {
      getBoundingClientRect: () => ({ top, bottom }), getAttribute: () => id,
    } : null,
  });
  const children = [child('older-child', -400, -50), child('reading-child', -50, 300)];
  let nestedTop = -450;
  const root = {
    getBoundingClientRect: () => ({ top: -500, bottom: 800 }),
    querySelector: (selector: string) => selector === '[data-child-history]' ? {
      getBoundingClientRect: () => ({ top: nestedTop, bottom: 800 }),
      getAttribute: () => null,
      querySelectorAll: () => children,
    } : {
      getBoundingClientRect: () => ({ top: -500, bottom: 800 }), getAttribute: () => 'parent',
    },
  };
  assert.deepEqual(firstVisibleMessage([root], 0, 600), { id: 'reading-child', offset: -50 });
  nestedTop = 100;
  assert.deepEqual(firstVisibleMessage([root], 0, 600), { id: 'parent', offset: -500 });
});

class Frames {
  callbacks: (() => void)[] = [];
  pending = new Map<number, () => void>();
  cancelled: number[] = [];

  request(callback: () => void) {
    const id = this.callbacks.push(callback);
    this.pending.set(id, callback);
    return id;
  }

  cancel(id: number) {
    this.cancelled.push(id);
    this.pending.delete(id);
  }

  flush() {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
    assert.equal(this.pending.size, 0, 'corrections must not poll or self-schedule');
  }
}

class Transcript implements ThreadScrollView {
  top = 700;
  viewport = 300;
  width = 600;
  rows: { id: string; height: number; before?: number }[] =
    Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, height: 100 }));
  writes: number[] = [];

  measure() {
    return {
      top: this.top, viewport: this.viewport, width: this.width,
      height: this.rows.reduce((sum, row) => sum + row.height + (row.before ?? 0), 0),
    };
  }

  get bottom() { return Math.max(0, this.measure().height - this.viewport); }

  offset(id: string) {
    let offset = -this.top;
    for (const row of this.rows) {
      offset += row.before ?? 0;
      if (row.id === id) return offset;
      offset += row.height;
    }
    return null;
  }

  firstVisible() {
    for (const row of this.rows) {
      const offset = this.offset(row.id)!;
      if (offset + row.height > 1 && offset < this.viewport) return { id: row.id, offset };
    }
    return null;
  }

  write(top: number) {
    assert.ok(top >= 0 && top <= this.bottom, 'writes must fit the scroll range');
    this.writes.push(top);
    this.top = top;
  }
}

function fixture(top = 700) {
  const view = new Transcript();
  view.top = top;
  const frames = new Frames();
  const notices = { follows: 0 };
  const scroll = new ThreadScroll(view, frames, () => { notices.follows++; });
  return { view, frames, scroll, notices };
}

test('incremental backward owner repair and interleaved live rows retain the actual reading anchor', () => {
  const window = new NativeWindow(undefined, true);
  const message = (id: string): NativeChatEvent => ({
    id, type: 'assistant.message', timestamp: 1, data: { messageId: id, content: id },
  });
  const accept = (events: NativeChatEvent[], direction: 'backward' | 'forward' = 'backward') => {
    const request: NativeChatRead = {
      sessionId: 'anchor-fixture', source: 'live', direction, max: 32, waitMs: 0, bootstrap: false, agentScope: 'all',
    };
    window.accept({
      sessionId: request.sessionId, source: request.source, direction, events,
      cursor: 'fixture-cursor', hasMore: true, cursorStatus: 'ok', read: { rpc: 1, events: events.length },
    }, request);
  };
  accept([
    { id: 'answer', type: 'tool.execution_complete', timestamp: 1, data: {
      toolCallId: 'ask', result: { content: 'User responded: synthetic answer' },
    } },
    ...Array.from({ length: 10 }, (_, i) => message(`m${i}`)),
  ]);
  const { view, frames, scroll } = fixture(425);
  view.rows = window.snapshot().messages.map(message => ({ id: message.id, height: 100 }));
  scroll.interact();
  const anchor = scroll.position();
  const stable = window.snapshot().messages.find(message => message.id === 'm3');
  accept([message('live')], 'forward');
  accept([{ ...message('owner'), data: {
    messageId: 'owner', content: 'Question', toolRequests: [{ toolCallId: 'ask', name: 'ask_user' }],
  } }, { id: 'start', type: 'tool.execution_start', timestamp: 1, data: { toolCallId: 'ask', toolName: 'ask_user' } }]);
  view.rows = window.snapshot().messages.map(message => ({ id: message.id, height: 100 }));
  scroll.changed();
  frames.flush();
  assert.deepEqual(scroll.position(), anchor);
  assert.equal(window.snapshot().messages.find(message => message.id === 'm3'), stable);
  assert.equal(view.top, 625, 'owner body, tool row and ask reply precede the same reading anchor');
  accept([message('older')]);
  accept([message('more-live')], 'forward');
  view.rows = window.snapshot().messages.map(message => ({ id: message.id, height: 100 }));
  scroll.changed();
  frames.flush();
  assert.deepEqual(scroll.position(), anchor);
  assert.equal(view.top, 725);
  scroll.dispose();
});

test('each mounted scroll adapter starts at latest and real gestures cancel queued following', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = new Transcript();
  view.top = 0;
  const frames = new Frames();
  let owner: ReturnType<typeof observeThreadScroll> | undefined;
  t.after(() => owner?.dispose());
  const globals: Record<string, unknown> = {
    document: Object.assign(new EventTarget(), { activeElement: null, getSelection: () => null }),
    CSS: { escape: (id: string) => id },
    requestAnimationFrame: frames.request.bind(frames),
    cancelAnimationFrame: frames.cancel.bind(frames),
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const el = Object.assign(new EventTarget(), { clientTop: 0, getBoundingClientRect: () => ({ top: 0 }) });
  Object.defineProperties(el, {
    scrollTop: { get: () => view.top, set: value => view.write(value) },
    scrollHeight: { get: () => view.measure().height },
    clientHeight: { get: () => view.viewport }, clientWidth: { get: () => view.width },
  });
  const row = (id: string) => ({
    getBoundingClientRect: () => ({ top: view.offset(id)!, bottom: view.offset(id)! + 100 }),
    getAttribute: () => id,
    closest: () => null,
  });
  const content = Object.assign(new EventTarget(), {
    querySelectorAll: () => view.rows.map(value => ({ ...row(value.id), querySelector: () => row(value.id) })),
    querySelector: (selector: string) => {
      const id = selector.match(/data-message-id="([^"]+)"/)?.[1];
      return id ? row(id) : null;
    },
  });
  const distances: boolean[] = [];
  owner = observeThreadScroll(el as HTMLDivElement, content as unknown as HTMLDivElement, () => {}, undefined,
    away => distances.push(away));
  frames.flush();
  assert.equal(view.top, view.bottom);
  const wheel = new Event('wheel');
  Object.defineProperties(wheel, { deltaY: { value: -20 }, ctrlKey: { value: false } });
  el.dispatchEvent(wheel);
  view.top = 423;
  el.dispatchEvent(new Event('scroll'));
  t.mock.timers.tick(180);
  frames.flush();
  assert.equal(view.top, 423, 'current reading stays in place');
  assert.equal(owner.scroll.following, false, 'a small upward gesture still disables automatic following');
  assert.deepEqual(distances, [], 'less than one viewport does not expose a return action');
  view.top = view.bottom - view.viewport + 1;
  el.dispatchEvent(new Event('scroll'));
  assert.deepEqual(distances, [], 'one pixel short of a viewport remains quiet');
  view.top = view.bottom - view.viewport;
  el.dispatchEvent(new Event('scroll'));
  assert.deepEqual(distances, [true], 'a full viewport exposes the action without requiring new messages');
  view.top -= 1;
  el.dispatchEvent(new Event('scroll'));
  assert.deepEqual(distances, [true], 'remaining beyond the threshold does not repeat notifications');
  view.top = view.bottom - view.viewport + 1;
  el.dispatchEvent(new Event('scroll'));
  assert.deepEqual(distances, [true, false], 'returning within one viewport hides the action');
  view.top = view.bottom - view.viewport;
  el.dispatchEvent(new Event('scroll'));
  const end = new Event('keydown', { cancelable: true });
  Object.defineProperty(end, 'key', { value: 'End' });
  el.dispatchEvent(end);
  assert.equal(end.defaultPrevented, true);
  frames.flush();
  assert.equal(view.top, view.bottom);
  assert.deepEqual(distances, [true, false, true, false], 'following hides the return action again');
  assert.equal(owner.scroll.following, true);
  owner.scroll.follow();
  el.dispatchEvent(wheel);
  frames.flush();
  assert.equal(view.top, view.bottom, 'a real adapter gesture cancels the queued follow');
  t.mock.timers.tick(180);
  frames.flush();
  assert.equal(view.top, view.bottom, 'settling must not reinstate canceled following');
  owner.dispose();
  const writes = view.writes.length;
  el.dispatchEvent(new Event('scrollend'));
  frames.flush();
  assert.equal(view.writes.length, writes);
  view.top = 0;
  owner = observeThreadScroll(el as HTMLDivElement, content as unknown as HTMLDivElement, () => {});
  el.dispatchEvent(wheel);
  frames.flush();
  t.mock.timers.tick(180);
  frames.flush();
  assert.equal(view.top, 0, 'wheel overscroll at mount cancels following even without a scroll event');
  assert.equal(owner.scroll.following, false);
});

function readAt({ view, frames, scroll }: ReturnType<typeof fixture>, top: number) {
  const writes = view.writes.length;
  scroll.intent(top > view.top);
  view.top = top;
  scroll.scroll();
  assert.equal(view.writes.length, writes, 'scroll events must never write');
  scroll.settle();
  frames.flush();
  assert.equal(scroll.following, false);
  const anchor = view.firstVisible();
  assert.ok(anchor);
  return anchor;
}

function divContents(html: string, className: string) {
  const opening = new RegExp(`<div\\b[^>]*class="${className}"[^>]*>`).exec(html);
  assert.ok(opening, `missing ${className}`);
  const start = opening.index + opening[0].length;
  let depth = 1;
  for (const tag of html.slice(start).matchAll(/<\/?div\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (!depth) return html.slice(start, start + tag.index);
  }
  assert.fail(`unclosed ${className}`);
}

test('outer-frame lookup skips an offscreen semantic anchor even when its margin is visible', () => {
  const row = (id: string, top: number, bottom: number, margin: number) => ({
    getBoundingClientRect: () => ({ top, bottom: bottom + margin }),
    querySelector: () => ({
      getBoundingClientRect: () => ({ top, bottom }),
      getAttribute: () => id,
    }),
  });
  const rows = [row('offscreen', -100, 0, 5.6), row('visible', 5.6, 150, 5.6)];
  assert.deepEqual(firstVisibleMessage(rows, 0, 100), { id: 'visible', offset: 5.6 });
  assert.equal(firstVisibleMessage(rows, 200, 100), null);
  assert.equal(firstVisibleMessage(rows, -200, 50), null);
});

test('moving 20–49px off a completed transcript stays reading through content and resizes', () => {
  for (const distance of [20, 35, 49]) {
    const h = fixture();
    const anchor = readAt(h, h.view.bottom - distance);
    const top = h.view.top;
    for (const update of [
      () => { h.view.viewport = 260; },
      () => { h.view.rows.push({ id: 'new', height: 180 }); },
      () => { h.view.width = 480; h.view.viewport = 310; },
    ]) {
      update();
      h.scroll.changed();
      h.frames.flush();
      assert.equal(h.view.top, top);
      assert.deepEqual(h.view.firstVisible(), anchor);
      assert.equal(h.scroll.following, false);
    }
    assert.deepEqual(h.view.writes, []);
    assert.equal(h.notices.follows, 0);
  }
});

test('equivalent histories and metadata with unchanged geometry do not schedule or write', () => {
  for (const reading of [false, true]) {
    const h = fixture();
    if (reading) readAt(h, 275);
    for (let revision = 0; revision < 20; revision++) {
      h.view.rows = h.view.rows.map((row) => ({ ...row, revision }));
      h.scroll.changed();
      h.scroll.changed();
      assert.equal(h.frames.pending.size, 0);
    }
    assert.equal(h.frames.callbacks.length, 0);
    assert.deepEqual(h.view.writes, []);
    assert.equal(h.scroll.following, !reading);
  }
});

test('repeated fractional geometry, scroll, and visible-anchor jitter below 1px never oscillate', () => {
  for (const reading of [false, true]) {
    const h = fixture();
    if (reading) readAt(h, 275);
    const top = h.view.top;
    const revision = h.scroll.revision;
    for (let cycle = 0; cycle < 20; cycle++) {
      for (const jitter of [0.2, 0.6, 0.8, 0.4, 0.1, 0]) {
        h.view.rows[0].height = 100 + jitter;
        h.view.viewport = 300 + jitter / 2;
        h.view.width = 600 + jitter / 2;
        h.view.top = top + jitter / 4;
        h.scroll.scroll();
        h.scroll.changed();
        h.frames.flush();
      }
    }
    assert.equal(h.frames.callbacks.length, 0);
    assert.deepEqual(h.view.writes, []);
    assert.equal(h.view.top, top);
    assert.equal(h.scroll.revision, revision);
    assert.equal(h.scroll.following, !reading);

    // DOM scrollHeight rounds fractional content heights to whole CSS pixels.
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const jitter of [0.6, 0.2]) {
        h.view.rows[0].height = 100 + Math.round(jitter);
        h.scroll.changed();
        h.frames.flush();
      }
    }
    assert.deepEqual(h.view.writes, []);
    assert.equal(h.scroll.following, !reading);
  }
});

test('loading on/off reserves its leading flow slot without changing message rows', () => {
  const session: ChatSession = {
    sessionId: 'scroll-loading', title: 'History', cwd: '/project', lastActivity: 0,
    status: 'idle', loaded: true, error: null, queue: [], ask: null,
    materialized: true, historyStale: false, hasMore: true, loadingHistory: false,
    messages: [{ id: 'visible', role: 'user', content: 'Stable transcript', timestamp: 0 }],
  };
  const render = (loadingHistory: boolean) => renderToStaticMarkup(createElement(Thread, {
    session: { ...session, loadingHistory }, readOnly: true,
    onLoadMore() { assert.fail('render must not request history'); },
  }));
  const idle = render(false);
  const loading = render(true);
  const messages = divContents(loading, 'chat-message-rows');
  assert.equal(messages, divContents(idle, 'chat-message-rows'));
  assert.equal(messages, divContents(render(false), 'chat-message-rows'));
  assert.match(messages, /Stable transcript/);
  assert.match(messages, /class="message is-out" data-message-id="visible"/);
  assert.doesNotMatch(messages, /chat-loading-older|new-msg-badge/);
  assert.match(divContents(divContents(loading, 'chat-message-content'), 'chat-history-controls'), /chat-loading-older/);
  assert.doesNotMatch(idle, /chat-loading-older/);
  const css = readFileSync(new URL('../styles/components/chat.scss', import.meta.url), 'utf8');
  assert.match(css, /\.chat-transcript\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.chat-history-controls\s*\{[^}]*flex:\s*none[^}]*width:\s*100%/);
  assert.match(css, /\.chat-history-actions\s*\{[^}]*min-height:\s*2\.5rem/);
  assert.doesNotMatch(css, /\.chat-loading-older\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.new-msg-badge\s*\{[^}]*position:\s*absolute/);
  assert.match(divContents(loading, 'chat-history-controls'), /chat-loading-older/);
  assert.doesNotMatch(divContents(idle, 'chat-history-controls'), /button|加载更早/);

  const h = fixture();
  const anchor = readAt(h, 275);
  for (const loadingHistory of [true, false, true, false]) {
    assert.equal(divContents(render(loadingHistory), 'chat-message-rows'), messages);
    h.scroll.changed();
    assert.equal(h.frames.pending.size, 0);
    assert.deepEqual(h.view.firstVisible(), anchor);
  }
  assert.deepEqual(h.view.writes, []);

  const assistant = renderToStaticMarkup(createElement(Thread, {
    session: { ...session, messages: [{ ...session.messages[0], role: 'assistant' }] },
    readOnly: true, onLoadMore() {},
  }));
  assert.match(assistant, /class="doc-byline"[\s\S]*<\/header><div data-message-id="visible">/);
});

test('prepend preserves the latest visible message while a request waits and tail/media grow', () => {
  const h = fixture();
  assert.deepEqual(readAt(h, 75), { id: 'm0', offset: -75 });
  // The reader moves again before the older page arrives.
  const anchor = readAt(h, 275);
  assert.deepEqual(anchor, { id: 'm2', offset: -75 });
  h.view.rows.unshift({ id: 'older-a', height: 90 }, { id: 'older-b', height: 110 });
  h.view.rows.find((row) => row.id === 'm0')!.height += 45;
  h.view.rows.at(-1)!.height += 360;
  h.view.rows.push({ id: 'tail', height: 140 });
  h.scroll.changed();
  h.view.rows[0].height += 35;
  h.view.rows.at(-1)!.height += 80;
  h.scroll.changed();
  assert.equal(h.frames.pending.size, 1);
  assert.deepEqual(h.view.writes, []);
  h.frames.flush();
  assert.deepEqual(h.view.writes, [555]);
  assert.deepEqual(h.view.firstVisible(), anchor);
  assert.equal(h.scroll.following, false);

  // Same-day prepends can remove both a separator and an assistant byline.
  for (const before of [24, 57]) {
    const dated = fixture();
    dated.view.rows[0].before = before;
    dated.scroll.changed();
    dated.frames.flush();
    const first = readAt(dated, 75);
    dated.view.rows[0].before = 0;
    dated.view.rows.unshift({ id: 'older', height: 100 });
    dated.scroll.changed();
    dated.frames.flush();
    assert.equal(dated.view.top, 175 - before);
    assert.deepEqual(dated.view.firstVisible(), first);
  }
});

test('late media above a reading viewport and viewport reflow preserve message offsets', () => {
  const h = fixture();
  const anchor = readAt(h, 275);
  h.view.rows[0].height += 160;
  h.view.viewport = 240;
  h.view.width = 480;
  h.scroll.changed();
  assert.deepEqual(h.view.writes, []);
  h.frames.flush();
  assert.deepEqual(h.view.writes, [435]);
  assert.deepEqual(h.view.firstVisible(), anchor);
  h.view.width = 360;
  h.view.rows[1].height += 80;
  h.scroll.changed();
  h.view.viewport = 380;
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, [435, 515]);
  assert.deepEqual(h.view.firstVisible(), anchor);
  // A browser-applied geometry clamp/anchor adjustment needs no second correction.
  h.view.rows[0].height += 50;
  h.view.top += 50;
  h.scroll.scroll();
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, [435, 515]);
  assert.deepEqual(h.view.firstVisible(), anchor);
  assert.equal(h.scroll.following, false);
});

test('dispose cancels RAF and replayed stale callbacks cannot affect a replacement session', () => {
  const h = fixture();
  h.view.rows.at(-1)!.height += 100;
  h.scroll.changed();
  const stale = h.frames.callbacks.at(-1)!;
  h.scroll.dispose();
  assert.deepEqual(h.frames.cancelled, [1]);
  assert.equal(h.frames.pending.size, 0);
  h.view.top = 0;
  let follows = 0;
  const replacement = new ThreadScroll(h.view, h.frames, () => { follows++; });
  replacement.follow();
  stale();
  h.scroll.follow();
  h.scroll.changed();
  assert.deepEqual(h.view.writes, []);
  assert.equal(h.frames.pending.size, 1);
  h.frames.flush();
  assert.deepEqual(h.view.writes, [800]);
  stale();
  assert.deepEqual(h.view.writes, [800]);
  assert.equal(h.notices.follows, 0);
  assert.equal(follows, 1);
  replacement.dispose();
});

test('initial/open following coalesces streaming and viewport changes using latest geometry', () => {
  const h = fixture(0);
  h.scroll.follow();
  h.view.rows.at(-1)!.height += 80;
  h.view.viewport = 250;
  h.scroll.changed();
  assert.equal(h.frames.pending.size, 1);
  assert.deepEqual(h.view.writes, []);
  h.frames.flush();
  assert.deepEqual(h.view.writes, [830]);
  h.scroll.scroll();
  assert.equal(h.scroll.following, true);
  assert.equal(h.scroll.revision, 0);
  h.view.width = 360;
  h.view.rows[2].height += 60;
  h.scroll.changed();
  h.view.viewport = 350;
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, [830, 790]);
  assert.equal(h.view.top, h.view.bottom);
  assert.equal(h.scroll.following, true);
  h.scroll.changed();
  assert.equal(h.frames.pending.size, 0);
  assert.equal(h.notices.follows, 1);
});

test('geometry and programmatic bottom events cannot enable follow, but user return can', () => {
  const h = fixture();
  readAt(h, 275);
  h.view.viewport = 900;
  h.view.top = h.view.bottom;
  h.scroll.scroll();
  h.scroll.settle();
  h.frames.flush();
  assert.equal(h.scroll.following, false);
  h.view.viewport = 300;
  h.scroll.changed();
  h.frames.flush();
  h.view.top = h.view.bottom;
  h.scroll.scroll();
  h.scroll.settle();
  assert.equal(h.scroll.following, false);
  assert.equal(h.notices.follows, 0);
  readAt(h, h.view.bottom - 30);
  h.scroll.intent(true);
  h.view.top = h.view.bottom;
  h.scroll.scroll();
  assert.deepEqual(h.view.writes, []);
  h.scroll.settle();
  assert.equal(h.scroll.following, true);
  assert.equal(h.notices.follows, 1);
  h.view.rows.at(-1)!.height += 100;
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, [800]);
  h.scroll.scroll();
  assert.equal(h.scroll.following, true);

  const clamped = fixture();
  readAt(clamped, 275);
  clamped.scroll.intent(true);
  clamped.view.top = 300;
  clamped.scroll.scroll();
  clamped.view.viewport = 900;
  clamped.view.top = clamped.view.bottom;
  clamped.scroll.scroll();
  clamped.scroll.settle();
  clamped.frames.flush();
  assert.equal(clamped.scroll.following, false, 'resize during a gesture cannot rejoin follow');
  assert.equal(clamped.notices.follows, 0);
});

test('acknowledgeInView does not follow when a pending send resolves after the reader drags', async () => {
  const h = fixture();
  let resolve!: (sent: boolean) => void;
  const post = new Promise<boolean>((done) => { resolve = done; });
  let accepted = 0;
  const callbacks = {
    scrollRevision: () => h.scroll.revision,
    onAccepted: () => { accepted++; h.scroll.follow(); },
  };
  const result = acknowledgeInView({ active: true }, () => post, callbacks);
  h.scroll.hold(true);
  readAt(h, h.view.bottom - 30);
  h.scroll.hold(false);
  h.scroll.settle();
  resolve(true);
  assert.equal(await result, true);
  assert.equal(accepted, 0);
  assert.equal(h.notices.follows, 0);
  assert.equal(h.scroll.following, false);
  assert.equal(h.frames.pending.size, 0);
  assert.deepEqual(h.view.writes, []);
  assert.equal(await acknowledgeInView({ active: true }, async () => true, callbacks), true);
  h.frames.flush();
  assert.equal(accepted, 1, 'an unchanged view still follows its own accepted send');
  assert.equal(h.scroll.following, true);
  assert.deepEqual(h.view.writes, [700]);
});

test('touch and subsequent momentum suppress corrections, including an old queued frame', () => {
  const h = fixture();
  readAt(h, 375);
  h.view.rows[0].height += 80;
  h.scroll.changed();
  const stale = h.frames.callbacks.at(-1)!;
  h.scroll.hold(true);
  assert.equal(h.frames.pending.size, 0);
  stale();
  h.scroll.intent(false);
  h.view.top = 345;
  h.scroll.scroll();
  h.view.rows[0].height += 35;
  h.scroll.changed();
  h.view.top = 315;
  h.scroll.scroll();
  h.scroll.settle();
  h.scroll.hold(false);
  h.view.rows[0].height += 40;
  h.scroll.changed();
  stale();
  assert.equal(h.frames.pending.size, 0, 'touch release does not end momentum');
  assert.deepEqual(h.view.writes, []);
  h.view.top = 290;
  h.scroll.scroll();
  h.scroll.settle();
  h.frames.flush();
  assert.deepEqual(h.view.writes, []);
  const anchor = h.view.firstVisible();
  h.view.rows[0].height += 20;
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, [310]);
  assert.deepEqual(h.view.firstVisible(), anchor);
  assert.equal(h.scroll.following, false);
});

test('interact expands an in-view row in place rather than pinning its new bottom', () => {
  const h = fixture();
  const anchor = h.view.firstVisible();
  h.view.rows.at(-1)!.height += 50;
  h.scroll.changed();
  const stale = h.frames.callbacks.at(-1)!;
  h.scroll.interact();
  assert.equal(h.frames.pending.size, 0);
  h.view.rows[8].height += 300;
  h.scroll.changed();
  stale();
  assert.deepEqual(h.view.writes, []);
  h.frames.flush();
  h.view.rows[8].height -= 300;
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, []);
  assert.deepEqual(h.view.firstVisible(), anchor);
  assert.equal(h.scroll.following, false);
  assert.equal(h.notices.follows, 0);
});

test('find, focus or selection navigation owns its new position even during reflow', () => {
  const h = fixture();
  h.view.rows[0].height += 100;
  h.scroll.changed();
  const stale = h.frames.callbacks.at(-1)!;
  h.view.top = 275;
  h.scroll.navigate();
  const anchor = h.view.firstVisible();
  stale();
  h.scroll.settle();
  h.frames.flush();
  assert.deepEqual(h.view.writes, []);
  assert.equal(h.scroll.following, false);
  h.view.rows[0].height += 50;
  h.scroll.changed();
  h.frames.flush();
  assert.deepEqual(h.view.writes, [325]);
  assert.deepEqual(h.view.firstVisible(), anchor);
});

test('explicit End follow keeps a growing oversized reply at the bottom', () => {
  const h = fixture();
  h.view.rows.at(-1)!.height = 100_000;
  readAt(h, 900);
  h.scroll.follow();
  h.frames.flush();
  for (let i = 0; i < 8; i++) {
    h.view.rows.at(-1)!.height += 71;
    h.scroll.changed();
    h.frames.flush();
    h.scroll.scroll();
    assert.equal(h.view.top, h.view.bottom);
    assert.equal(h.scroll.following, true);
  }
});

test('activity spans finger hold and momentum so older rows can commit after settle', () => {
  for (const samples of [[], [-12, 0], [3, 0]]) {
    const view = new Transcript();
    view.top = 0;
    const frames = new Frames();
    const activity: boolean[] = [];
    let pendingOlder = false;
    const scroll = new ThreadScroll(view, frames, () => {}, (active) => {
      activity.push(active);
      if (!active && pendingOlder) view.rows.unshift({ id: 'older', height: 400 });
    });
    scroll.intent(false);
    scroll.settle();
    frames.flush();
    activity.length = 0;
    const anchor = view.firstVisible();
    scroll.hold(true);
    scroll.intent(false);
    pendingOlder = true;
    scroll.changed();
    for (const top of samples) {
      view.top = top;
      scroll.scroll();
    }
    scroll.settle();
    assert.deepEqual(activity, [true], 'scrollend cannot release a held finger');
    scroll.hold(false);
    assert.deepEqual(activity, [true], 'touchend does not end outstanding momentum');
    assert.deepEqual(view.writes, []);
    scroll.settle();
    frames.flush();
    assert.deepEqual(activity, [true, false]);
    assert.deepEqual(view.firstVisible(), anchor);
    assert.deepEqual(view.writes, [400]);
  }
});

test('stationary finger releases without waiting for a nonexistent movement; explicit End releases keyboard navigation', () => {
  const view = new Transcript();
  const frames = new Frames();
  const activity: boolean[] = [];
  const scroll = new ThreadScroll(view, frames, () => {}, active => activity.push(active));
  scroll.hold(true);
  scroll.hold(false);
  assert.deepEqual(activity, [true, false]);
  scroll.navigate();
  scroll.follow();
  frames.flush();
  assert.deepEqual(activity, [true, false, true, false]);
  assert.equal(scroll.following, true);
});
