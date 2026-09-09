import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CopilotClient, SessionEvent } from '@github/copilot-sdk';
import { MAX_TOOL_IMAGE_BYTES, ToolImageRead, ToolImageResult } from '@cockpit/protocol';
import { readToolImage, toolImagesOf } from './tool-image.ts';
import { normalizeEvent } from './sdk-types.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=';
const request = { sessionId: 'fixture', image: { eventId: 'image-event', toolCallId: 'tool', part: 0 } };
type Read = CopilotClient['rpc']['sessions']['readPersistedEvents'];
function imageEvent(part: Record<string, unknown> = { type: 'image', mimeType: 'image/png', data: png }): SessionEvent {
  return {
    type: 'tool.execution_complete', id: 'image-event', timestamp: '2026-09-09T00:00:00Z', parentId: null,
    data: { toolCallId: 'tool', success: true, result: { binaryResultsForLlm: [part] } },
  } as SessionEvent;
}
function fixture(event = imageEvent()) {
  const calls: Parameters<Read>[0][] = [];
  const read: Read = async params => {
    calls.push(params);
    assert.equal(params.max, 1);
    if (params.sessionId !== 'fixture') throw new Error('Unknown native session');
    return { events: [event], hasMore: false, cursor: 'end', cursorStatus: 'ok' };
  };
  return { read, calls };
}

test('native image descriptors contain no bytes, paths or inferred resource URLs', () => {
  const descriptor = toolImagesOf(normalizeEvent(imageEvent({
    type: 'image', mimeType: 'image/png', data: png, description: 'file:///private/image.png',
  })));
  assert.deepEqual(descriptor, [{ ...request.image, mime: 'image/png', byteLength: 77, unavailable: undefined }]);
  assert.doesNotMatch(JSON.stringify(descriptor), /private|file:|iVBOR/);
  assert.deepEqual(toolImagesOf(normalizeEvent(imageEvent({
    type: 'resource', mimeType: 'application/pdf', data: 'AA==',
  }))), []);
});

test('read recovers exact bytes through only passive native RPC and validates identity', async () => {
  const { read, calls } = fixture();
  const image = await readToolImage(read, request);
  assert.equal(ToolImageResult.safeParse(image).success, true);
  assert.equal(image.data, png);
  assert.equal(image.byteLength, 77);
  assert.equal(calls.length, 1);
  await assert.rejects(readToolImage(read, { ...request, sessionId: 'elsewhere' }), /Unknown native session/);
  await assert.rejects(readToolImage(read, { ...request, image: { ...request.image, toolCallId: 'other' } }), /不匹配/);
  await assert.rejects(readToolImage(read, { ...request, image: { ...request.image, part: 1 } }), /没有该图片/);
  await assert.rejects(readToolImage(read, { ...request, image: { ...request.image, eventId: 'other' } }), /已删除/);
});

test('omitted, oversize, missing, corrupt, active and MIME-mismatched images fail explicitly', async () => {
  const invalid = [
    { type: 'image', mimeType: 'image/png', byteLength: 77, omittedReason: 'too_large' },
    { type: 'image', mimeType: 'image/png', byteLength: MAX_TOOL_IMAGE_BYTES + 1, data: png },
    { type: 'image', mimeType: 'image/png' },
    { type: 'image', mimeType: 'image/png', data: '!!!!' },
    { type: 'image', mimeType: 'image/png', data: png.slice(0, -1) },
    { type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"/>').toString('base64') },
    { type: 'image', mimeType: 'image/jpeg', data: png },
    { type: 'image', mimeType: 'image/png', data: Buffer.from('<html>not an image</html>').toString('base64') },
  ];
  for (const part of invalid) await assert.rejects(readToolImage(fixture(imageEvent(part)).read, request));
});

test('embedded image resources reuse native bytes; descriptions are never dereferenced', async () => {
  const event = imageEvent({ type: 'resource', mimeType: 'image/png', data: png, description: 'https://third-party.invalid/private' });
  assert.equal((await readToolImage(fixture(event).read, request)).data, png);
});

test('opaque hints stay within the selected session and bounded page, and expired hints never return a different image', async () => {
  const calls: Parameters<Read>[0][] = [];
  const read: Read = async params => {
    calls.push(params);
    assert.equal(params.sessionId, 'fixture');
    assert.equal(params.max, 1);
    if (params.cursor === 'expired') return { events: [imageEvent()], hasMore: false, cursor: 'end', cursorStatus: 'expired' };
    return params.cursor === 'second'
      ? { events: [imageEvent()], hasMore: false, cursor: 'end', cursorStatus: 'ok' }
      : { events: [], hasMore: true, cursor: 'second', cursorStatus: 'ok' };
  };
  const image = { ...request.image, cursor: 'first', count: 2 };
  assert.equal((await readToolImage(read, { ...request, image })).data, png);
  assert.equal(calls.length, 2);
  await assert.rejects(readToolImage(read, { ...request, image: { ...image, count: 1 } }), /已删除/);
  await assert.rejects(readToolImage(read, { ...request, image: { ...image, cursor: 'expired' } }), /定位已失效/);
});

test('cancellation prevents both further scans and delivery of an obsolete native result', async () => {
  const controller = new AbortController();
  let calls = 0;
  const read: Read = async () => {
    calls++;
    controller.abort();
    return { events: [imageEvent()], hasMore: false, cursor: 'end', cursorStatus: 'ok' };
  };
  await assert.rejects(readToolImage(read, request, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(readToolImage(read, request, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('API rejects paths, URLs, extra selectors, negative parts and unbounded native counts', () => {
  for (const sessionId of ['../other', '/tmp/events', 'https://example.org', 'a/b']) {
    assert.equal(ToolImageRead.safeParse({ ...request, sessionId }).success, false);
  }
  for (const image of [
    { ...request.image, path: '/private/a.png' }, { ...request.image, url: 'https://example.org' },
    { ...request.image, part: -1 }, { ...request.image, count: 1001 },
  ]) assert.equal(ToolImageRead.safeParse({ ...request, image }).success, false);
});
