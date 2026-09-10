import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeHistoryPrefetch, withinHistoryPrefetch } from './historyPrefetch';

test('the preload threshold is one current viewport, not a fixed pixel count or the top edge', () => {
  assert.equal(withinHistoryPrefetch(301, 300), false);
  assert.equal(withinHistoryPrefetch(300, 300), true);
  assert.equal(withinHistoryPrefetch(250, 300), true);
  assert.equal(withinHistoryPrefetch(301, 600), true);
  assert.equal(withinHistoryPrefetch(0, 0), false);
});

test('prefetch coalesces scrolls, waits for anchoring, obeys visibility and disposal, and does not self-poll', t => {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  let top = 600;
  let height = 300;
  let allowed = true;
  let count = 0;
  let resize = () => {};
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const viewport = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ top: 0, bottom: height }),
  });
  Object.defineProperty(viewport, 'clientHeight', { get: () => height });
  const content = { getBoundingClientRect: () => ({ top: -top, bottom: height + 100 }) };
  const globals = {
    document,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  };
  const settle = () => { flush(); flush(); flush(); };
  const watch = () => observeHistoryPrefetch(
    viewport as unknown as HTMLElement, content as HTMLElement, () => allowed, () => { count++; }, () => top,
  );
  const first = watch();
  top = 250;
  for (let i = 0; i < 20; i++) viewport.dispatchEvent(new Event('scroll'));
  assert.equal(frames.size, 1);
  flush();
  assert.equal(count, 0);
  flush();
  assert.equal(count, 0);
  flush();
  assert.equal(count, 1, 'read before reaching scrollTop zero');
  resize(); settle();
  assert.equal(count, 1, 'same reader cannot issue another in-flight request');
  first();
  const next = watch();
  top = 700;
  settle();
  assert.equal(count, 1, 'prepend correction is measured before deciding to continue');
  height = 800;
  document.visibilityState = 'hidden';
  resize(); settle();
  assert.equal(count, 1);
  document.visibilityState = 'visible';
  allowed = false;
  document.dispatchEvent(new Event('visibilitychange')); settle();
  assert.equal(count, 1, 'error, unresolved boundary or exhaustion gates suppress reads');
  allowed = true;
  resize(); settle();
  assert.equal(count, 2, 'viewport resizing can require another screen of headroom');
  next();
  const stop = watch();
  const stale = [...frames.values()][0];
  stop();
  stale(0); flush();
  assert.equal(count, 2, 'a stale frame after unmount cannot fetch');
  assert.equal(frames.size, 0);
});
