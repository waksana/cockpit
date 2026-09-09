import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ChatMessage } from '../net/types';
import { canSkipMessageLayout, createMessageLayout } from './messageLayout';

const message: ChatMessage = {
  id: 'message', role: 'assistant', content: 'A completed reply', timestamp: 1,
};

test('only settled messages can skip layout', () => {
  assert.equal(canSkipMessageLayout(message, false), true);
  assert.equal(canSkipMessageLayout(message, true), false);
  for (const status of ['pending', 'in_progress', undefined] as const) {
    assert.equal(canSkipMessageLayout({
      ...message, toolCalls: [{ toolCallId: 'tool', title: 'Tool', status }],
    }, false), false);
  }
  assert.equal(canSkipMessageLayout({
    ...message, toolCalls: [
      { toolCallId: 'done', title: 'Done', status: 'completed' },
      { toolCallId: 'failed', title: 'Failed', status: 'failed' },
    ],
  }, false), true);
});

test('child cards keep normal layout without changing their open resource lifetime', () => {
  assert.equal(canSkipMessageLayout({
    ...message, subtype: 'subagent',
    subagent: { name: 'task', displayName: 'Task', status: 'completed' },
  }, false), false);
});

function measuredLayout(t: TestContext) {
  let deliver: ResizeObserverCallback | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let disconnects = 0;
  class Observer {
    constructor(callback: ResizeObserverCallback) { deliver = callback; }
    observe() {}
    unobserve() {}
    disconnect() { disconnects++; }
  }
  const globals = {
    CSS: { supports: () => true }, ResizeObserver: Observer,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (key: number) => { frames.delete(key); },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const node = () => {
    const attrs = new Map<string, string>();
    const styles = new Map<string, string>();
    const style = {
      setProperty: (key: string, value: string) => { styles.set(key, value); },
      removeProperty: (key: string) => { const value = styles.get(key) ?? ''; styles.delete(key); return value; },
    } as CSSStyleDeclaration;
    const element = {
      style,
      setAttribute: (key: string, value: string) => { attrs.set(key, value); },
      removeAttribute: (key: string) => { attrs.delete(key); },
    } as HTMLElement;
    return { element, attrs, styles };
  };
  const layout = createMessageLayout();
  t.after(() => layout.dispose());
  return {
    layout, node, frames, disconnects: () => disconnects,
    resize(element: HTMLElement, width: number, height: number) {
      const size = [{ inlineSize: width, blockSize: height }];
      deliver!([{
        target: element, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
        contentRect: { x: 0, y: 0, top: 0, left: 0, bottom: height, right: width, width, height, toJSON: () => ({ width, height }) },
      }], { observe() {}, unobserve() {}, disconnect() {} });
    },
    frame() {
      const next = [...frames.values()];
      frames.clear();
      next.forEach(callback => callback(0));
    },
  };
}

test('message layout batches containment writes outside ResizeObserver delivery with latest sizes', t => {
  const h = measuredLayout(t);
  const a = h.node(), b = h.node();
  h.layout.observe(a.element);
  h.layout.observe(b.element);
  h.resize(a.element, 390, 100);
  h.resize(a.element, 390, 120);
  h.resize(b.element, 390, 200);
  assert.equal(h.frames.size, 1);
  assert.equal(a.attrs.size, 0);
  assert.equal(a.styles.size, 0);
  h.frame();
  assert.equal(a.styles.get('--message-height'), '120px');
  assert.equal(b.styles.get('--message-height'), '200px');
  assert.equal(a.attrs.has('data-measured-layout'), true);
  assert.equal(h.frames.size, 0);
});

test('message layout invalidates old width and hidden measurements before accepting a new size', t => {
  const h = measuredLayout(t), a = h.node();
  h.layout.observe(a.element);
  h.resize(a.element, 390, 100); h.frame();
  h.resize(a.element, 872, 50); h.frame();
  assert.equal(a.attrs.size, 0);
  assert.equal(a.styles.size, 0);
  h.resize(a.element, 872, 55); h.frame();
  assert.equal(a.styles.get('--message-height'), '55px');
  h.resize(a.element, 0, 0); h.frame();
  assert.equal(a.attrs.size, 0);
  h.resize(a.element, 390, 105); h.frame();
  assert.equal(a.styles.get('--message-height'), '105px');
});

test('message layout unobserve and disposal cancel queued writes without restoring old row state', t => {
  const h = measuredLayout(t), a = h.node(), b = h.node();
  const remove = h.layout.observe(a.element);
  h.layout.observe(b.element);
  h.resize(a.element, 390, 100);
  h.resize(b.element, 390, 200);
  remove(); h.frame();
  assert.equal(a.attrs.size, 0);
  assert.equal(b.styles.get('--message-height'), '200px');
  const removeAgain = h.layout.observe(a.element);
  h.resize(a.element, 390, 120);
  removeAgain();
  assert.equal(h.frames.size, 0);
  h.layout.observe(a.element);
  h.frame();
  assert.equal(a.styles.size, 0);
  h.resize(a.element, 390, 130);
  h.layout.dispose();
  assert.equal(h.frames.size, 0);
  assert.equal(a.attrs.size, 0);
  assert.equal(b.attrs.size, 0);
  assert.equal(h.disconnects(), 1);
});
