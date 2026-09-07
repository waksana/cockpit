// Unit tests for memory.ts — the heap-bounding helpers that keep image-heavy
// sessions from OOM-ing the in-process SDK. Pure functions only (no Engine/SDK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageBytesOf, pickEvictionVictims } from './memory.ts';

test('imageBytesOf sums a base64 image payload nested in a tool result', () => {
  // Mirrors the real shape: data.input.toolResult.binaryResultsForLlm[].data
  const ev = {
    type: 'hook.start',
    data: {
      input: {
        toolResult: {
          binaryResultsForLlm: [
            { type: 'image', mimeType: 'image/jpeg', data: 'A'.repeat(1000) },
          ],
        },
      },
    },
  };
  assert.equal(imageBytesOf(ev), 1000);
});

test('imageBytesOf sums multiple images across arrays', () => {
  const ev = {
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'x'.repeat(50) },
      { type: 'image', data: 'y'.repeat(70) },
    ],
  };
  assert.equal(imageBytesOf(ev), 120);
});

test('imageBytesOf ignores non-image objects and non-string data', () => {
  assert.equal(imageBytesOf({ type: 'image' }), 0); // no data
  assert.equal(imageBytesOf({ type: 'image', data: 123 }), 0); // non-string
  assert.equal(imageBytesOf({ type: 'text', data: 'long string here' }), 0); // not an image
  assert.equal(imageBytesOf(null), 0);
  assert.equal(imageBytesOf('a string'), 0);
  assert.equal(imageBytesOf(undefined), 0);
});

test('imageBytesOf does not descend into an image block past its data', () => {
  // A nested image inside an image block must not be double-counted.
  const ev = { type: 'image', data: 'a'.repeat(10), extra: { type: 'image', data: 'b'.repeat(999) } };
  assert.equal(imageBytesOf(ev), 10);
});

test('imageBytesOf is depth-bounded (no runaway on deep nesting)', () => {
  let deep: Record<string, unknown> = { type: 'image', data: 'z'.repeat(100) };
  for (let i = 0; i < 100; i++) deep = { nest: deep };
  // Beyond MAX_WALK_DEPTH the buried image is not counted — must not throw.
  assert.equal(imageBytesOf(deep), 0);
});

test('pickEvictionVictims evicts heaviest first, enough to meet the target', () => {
  const cands = [
    { sessionId: 'light', lastActivity: 1, imageBytes: 10 },
    { sessionId: 'heavy', lastActivity: 2, imageBytes: 1000 },
    { sessionId: 'mid', lastActivity: 3, imageBytes: 100 },
  ];
  // Need 900 freed → just 'heavy' (1000) suffices.
  assert.deepEqual(pickEvictionVictims(cands, 900, 3), ['heavy']);
  // Need 1050 → 'heavy' then 'mid' (1100 total).
  assert.deepEqual(pickEvictionVictims(cands, 1050, 3), ['heavy', 'mid']);
});

test('pickEvictionVictims breaks ties by least-recently-active', () => {
  const cands = [
    { sessionId: 'newer', lastActivity: 200, imageBytes: 500 },
    { sessionId: 'older', lastActivity: 100, imageBytes: 500 },
  ];
  assert.deepEqual(pickEvictionVictims(cands, 400, 1), ['older']);
});

test('pickEvictionVictims honors maxCount even if target unmet', () => {
  const cands = [
    { sessionId: 'a', lastActivity: 1, imageBytes: 5 },
    { sessionId: 'b', lastActivity: 2, imageBytes: 5 },
    { sessionId: 'c', lastActivity: 3, imageBytes: 5 },
  ];
  // Target unreachable (15 < 1000) but maxCount caps the pass at 2.
  assert.equal(pickEvictionVictims(cands, 1000, 2).length, 2);
});

test('pickEvictionVictims returns empty for no candidates or zero cap', () => {
  assert.deepEqual(pickEvictionVictims([], 100, 3), []);
  assert.deepEqual(pickEvictionVictims([{ sessionId: 'a', lastActivity: 1, imageBytes: 9 }], 100, 0), []);
});
