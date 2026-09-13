import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { requestGracefulRestart } from './graceful-restart.mjs';

test('CLI rejects wait options before any restart request instead of silently ignoring them', async () => {
  const exec = promisify(execFile);
  for (const option of ['--wait', '--poll', '--timeout=30m']) {
    await assert.rejects(exec(process.execPath, [
      new URL('./graceful-restart.mjs', import.meta.url).pathname, option,
    ], {
      env: { ...process.env, COCKPIT_URL: 'http://127.0.0.1:1' },
      timeout: 5000,
    }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /accepts no command-line options.*--wait/);
      assert.doesNotMatch(error.stderr, /fetch failed|ECONNREFUSED/);
      return true;
    });
  }
});

test('restart helper delegates one decision to the backend even while busy', async () => {
  const calls = [];
  const result = await requestGracefulRestart({
    baseUrl: 'http://fixture.invalid/',
    token: 'fixture-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ restartPending: true, busy: 2, willRestartWhenIdle: true });
    },
  });
  assert.deepEqual(result, { restartPending: true, busy: 2, dryRun: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://fixture.invalid/admin/restart');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { pending: true });
});

test('dry run reads aggregate status without scheduling a restart', async () => {
  const result = await requestGracefulRestart({
    baseUrl: 'https://fixture.invalid/cockpit',
    dryRun: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://fixture.invalid/cockpit/status');
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      return Response.json({ restartPending: false, busy: 0, sessions: [{ title: 'not printed' }] });
    },
  });
  assert.deepEqual(result, { restartPending: false, busy: 0, dryRun: true });
});

test('an unreachable backend fails without retries or a direct service restart', async () => {
  let calls = 0;
  await assert.rejects(requestGracefulRestart({
    baseUrl: 'http://fixture.invalid',
    fetchImpl: async () => { calls++; throw new Error('connection refused'); },
  }), /connection refused/);
  assert.equal(calls, 1);
});

test('HTTP errors and invalid status cannot become successful restart reports', async () => {
  for (const response of [
    new Response('unavailable', { status: 503 }),
    Response.json({ restartPending: false, busy: 0 }),
    Response.json({ restartPending: true, busy: -1 }),
    Response.json({ restartPending: true }),
    Response.json(null),
  ]) {
    await assert.rejects(requestGracefulRestart({
      baseUrl: 'http://fixture.invalid',
      fetchImpl: async () => response,
    }));
  }
});

test('invalid URLs are rejected before contacting anything', async () => {
  for (const baseUrl of ['file:///tmp/status', 'http://name:secret@fixture.invalid', 'http://fixture.invalid?q=x', 'http://fixture.invalid/#x']) {
    await assert.rejects(requestGracefulRestart({
      baseUrl,
      fetchImpl: async () => assert.fail('invalid URL must not be requested'),
    }), /HTTP\(S\) backend URL/);
  }
});
