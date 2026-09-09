import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadToolImage } from './toolImage';

const request = { sessionId: 'fixture', image: { eventId: 'event', toolCallId: 'tool', part: 0 } };
const image = { sessionId: 'fixture', eventId: 'event', toolCallId: 'tool', part: 0,
  mime: 'image/png', byteLength: 1, data: 'AA==' };

test('private image transport binds full source identity and disables redirects and caching', async t => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.match(url, /\/intent\/session\/tool-image$/);
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(options.body)), request);
    return Response.json(image);
  });
  const blob = await loadToolImage(request, signal);
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, 1);
});

test('mismatched source, byte counts, login HTML, and deleted images cannot become preview blobs', async t => {
  for (const response of [
    Response.json({ ...image, sessionId: 'other' }),
    Response.json({ ...image, eventId: 'other' }),
    Response.json({ ...image, toolCallId: 'other' }),
    Response.json({ ...image, part: 1 }),
    Response.json({ ...image, byteLength: 2 }),
    new Response('<html>Login</html>'),
    Response.json({ error: 'Native image deleted' }, { status: 410 }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(loadToolImage(request, new AbortController().signal));
  }
});

test('aborted image requests never return bytes', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    return Response.json(image);
  });
  await assert.rejects(loadToolImage(request, controller.signal), { name: 'AbortError' });
});
