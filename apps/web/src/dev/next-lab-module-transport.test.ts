import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleLabFetch } from './next-lab-module-transport';

test('combined lab forwards only loopback fixture endpoints and synthesizes speech credentials locally', async () => {
  const calls: { url: string; redirect?: RequestRedirect }[] = [];
  let sessions = 0;
  const nativeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), redirect: init?.redirect });
    return Response.json({ synthetic: true });
  };
  const request = moduleLabFetch(nativeFetch, 'http://127.0.0.1:1234/chat-lab.html', () => {
    sessions++;
    return Response.json({ fixtureSession: true });
  });
  const digest = 'a'.repeat(64);
  await request('/_modules');
  await request(`/_modules/cockpit-file/${digest}/api/upload?name=test.txt&operationId=fixture`, { method: 'POST' });
  await request('/__next_lab__/files', { method: 'POST', body: '{"hold":true}' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:1234/') && call.redirect === 'error'));
  const credential = await request(`/_modules/cockpit-speech/${digest}/api/session`, { method: 'POST' });
  assert.equal((await credential.json()).fixtureSession, true);
  assert.equal(sessions, 1);
  assert.equal(calls.length, 3, 'speech never reaches any real credential endpoint');
  for (const path of [
    '/intent/prompt', '/events', '/chat/stream', '/status',
    'https://external.invalid/_modules', 'http://localhost:1234/_modules',
    'http://user:password@127.0.0.1:1234/_modules',
    `/_modules/other/${digest}/api/upload`, `/_modules/cockpit-speech/${digest}/api/unknown`,
  ]) await assert.rejects(request(path), /blocked/);
  assert.equal(calls.length, 3);
  const abort = new AbortController();
  abort.abort(new Error('Synthetic aborted'));
  await assert.rejects(request(`/_modules/cockpit-speech/${digest}/api/session`, { method: 'POST', signal: abort.signal }), /aborted/);
  assert.equal(sessions, 1);
  assert.throws(() => moduleLabFetch(nativeFetch, 'https://production.invalid/chat-lab.html', () => Response.json({})), /loopback/);
});
