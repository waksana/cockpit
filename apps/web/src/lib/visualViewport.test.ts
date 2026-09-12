import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserViewportSource, observeVisualViewport, visibleViewport, type ViewportGeometry } from './visualViewport';

test('uses the reported visible bottom, not an assumed keyboard or system toolbar height', () => {
  assert.deepEqual(visibleViewport({ layoutHeight: 844, height: 844, offsetTop: 0, scale: 1 }),
    { top: 0, height: 844, occludedBottom: 0 });
  assert.deepEqual(visibleViewport({ layoutHeight: 844, height: 420, offsetTop: 24, scale: 1 }),
    { top: 24, height: 420, occludedBottom: 400 });
  assert.deepEqual(visibleViewport({ layoutHeight: 420, height: 420, offsetTop: 0, scale: 1 }),
    { top: 0, height: 420, occludedBottom: 0 }, 'layout-resizing browsers do not get another keyboard subtraction');
  assert.deepEqual(visibleViewport({ layoutHeight: 844, height: 820, offsetTop: 12, scale: 1 }),
    { top: 12, height: 820, occludedBottom: 12 }, 'partial bottom occlusion only consumes that much safe area');
});

test('clamps overscroll, ignores pinch zoom and rejects transient invalid geometry', () => {
  assert.deepEqual(visibleViewport({ layoutHeight: 844, height: 860, offsetTop: -12, scale: 1 }),
    { top: 0, height: 844, occludedBottom: 0 });
  assert.deepEqual(visibleViewport({ layoutHeight: 844, height: 420, offsetTop: 500, scale: 1 }),
    { top: 500, height: 344, occludedBottom: 0 });
  for (const change of [{ scale: 2 }, { height: 0 }, { offsetTop: NaN }, { layoutHeight: 0 }]) {
    assert.equal(visibleViewport({ layoutHeight: 844, height: 420, offsetTop: 0, scale: 1, ...change }), null);
  }
});

test('viewport changes are event-driven, frame-coalesced and released with the mounted shell', () => {
  let geometry: ViewportGeometry = { layoutHeight: 844, height: 844, offsetTop: 0, scale: 1 };
  let listener: (() => void) | undefined;
  const values = new Map<string, string>([['--chat-viewport-top', '3px']]);
  const frames = new Map<number, () => void>();
  let id = 0, writes = 0, unsubscribed = false;
  const cleanup = observeVisualViewport({
    read: () => geometry,
    subscribe: update => { listener = update; return () => { listener = undefined; unsubscribed = true; }; },
  }, {
    getPropertyValue: name => values.get(name) ?? '', getPropertyPriority: () => '',
    setProperty: (name, value) => { writes++; values.set(name, value ?? ''); },
    removeProperty: name => { const value = values.get(name) ?? ''; values.delete(name); return value; },
  }, {
    request: callback => { frames.set(++id, callback); return id; },
    cancel: id => { frames.delete(id); },
  });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  assert.equal(values.get('--chat-viewport-height'), '844px');
  const originalWrites = writes;
  listener!(); listener!(); listener!();
  assert.equal(frames.size, 1);
  flush();
  assert.equal(writes, originalWrites, 'unchanged geometry causes no DOM writes');
  geometry = { layoutHeight: 844, height: 420, offsetTop: 24, scale: 1 };
  listener!(); flush();
  assert.equal(values.get('--chat-viewport-height'), '420px');
  assert.equal(values.get('--chat-viewport-top'), '24px');
  assert.equal(values.get('--chat-viewport-occluded-bottom'), '400px');
  geometry = { ...geometry, scale: 2, height: 210 };
  listener!(); flush();
  assert.equal(values.get('--chat-viewport-height'), '420px', 'pinch does not reflow the shell');
  geometry = { layoutHeight: 390, height: 230, offsetTop: 0, scale: 1 };
  listener!(); flush();
  assert.equal(values.get('--chat-viewport-height'), '230px', 'rotation uses current geometry, not an old baseline');
  geometry = { layoutHeight: 390, height: 390, offsetTop: 0, scale: 1 };
  listener!(); flush();
  assert.equal(values.get('--chat-viewport-occluded-bottom'), '0px', 'closing the keyboard restores the device safe area');
  const stale = listener!;
  listener!();
  cleanup();
  assert.equal(unsubscribed, true);
  assert.equal(frames.size, 0);
  assert.deepEqual([...values], [['--chat-viewport-top', '3px']]);
  stale();
  assert.equal(frames.size, 0, 'late events cannot resurrect a disposed viewport owner');
});

test('the browser adapter subscribes only to viewport and window geometry, not focus or transcript events', () => {
  const viewport = Object.assign(new EventTarget(), { height: 420, offsetTop: 20, scale: 1 });
  const host = Object.assign(new EventTarget(), {
    visualViewport: viewport, document: { documentElement: { clientHeight: 844 } },
  });
  const source = browserViewportSource(host as unknown as Window)!;
  assert.deepEqual(source.read(), { layoutHeight: 844, height: 420, offsetTop: 20, scale: 1 });
  let updates = 0;
  const unsubscribe = source.subscribe(() => updates++);
  viewport.dispatchEvent(new Event('resize'));
  viewport.dispatchEvent(new Event('scroll'));
  host.dispatchEvent(new Event('resize'));
  host.dispatchEvent(new Event('focusin'));
  assert.equal(updates, 3);
  unsubscribe();
  viewport.dispatchEvent(new Event('resize'));
  host.dispatchEvent(new Event('resize'));
  assert.equal(updates, 3);
  assert.equal(browserViewportSource({ visualViewport: null } as Window), undefined);
});
