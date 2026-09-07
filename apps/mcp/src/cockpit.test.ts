import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockpitError, intent } from './cockpit.ts';
import { requestTimeoutMs } from './config.ts';
import { McpToggleResult } from './shared.ts';

test('intent deadlines are operation-appropriate and bounded', () => {
  assert.equal(requestTimeoutMs('session/get'), 10_000);
  assert.equal(requestTimeoutMs('session/plan'), 45_000);
  assert.equal(requestTimeoutMs('session/panels'), 45_000);
  assert.equal(requestTimeoutMs('prompt'), 45_000);
  assert.equal(requestTimeoutMs('mcp/session'), 10_000);
  assert.equal(requestTimeoutMs('mcp/session-toggle'), 45_000);
  assert.equal(requestTimeoutMs('flow/run'), 90_000);
});

test('intent reports a precise timeout without retrying an uncertain request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => intent('session/plan', { sessionId: 'o43-test' }, { timeoutMs: 15 }),
      (error: unknown) => {
        assert.ok(error instanceof CockpitError);
        assert.equal(error.kind, 'timeout');
        assert.match(error.message, /session\/plan.*timed out after 15ms/);
        assert.match(error.message, /no retry was attempted/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('intent deadline covers a stalled response body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: () => new Promise<string>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  })) as typeof fetch;
  try {
    await assert.rejects(
      () => intent('session/plan', {}, { timeoutMs: 15 }),
      (error: unknown) => error instanceof CockpitError && error.kind === 'timeout',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('intent distinguishes connection and backend failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    }) as typeof fetch;
    await assert.rejects(
      () => intent('session/get', {}),
      (error: unknown) => error instanceof CockpitError
        && error.kind === 'connection'
        && /ECONNREFUSED/.test(error.message),
    );

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'unknown session' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    await assert.rejects(
      () => intent('session/get', {}),
      (error: unknown) => error instanceof CockpitError
        && error.kind === 'backend'
        && /unknown session/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mcp/session-toggle target failure is returned as a typed result, not a transport timeout', async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    ok: false,
    applied: false,
    sessionId: 's1',
    name: 'agency-icm',
    enabled: false,
    status: 'failed',
    error: 'protected resource metadata unavailable',
    operation: {
      id: 'mcp-toggle-test',
      desiredEnabled: true,
      state: 'failed',
      startedAt: 1,
      completedAt: 2,
      status: 'failed',
      error: 'protected resource metadata unavailable',
    },
  };
  globalThis.fetch = (async () => new Response(
    JSON.stringify(payload),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  try {
    const raw = await intent<unknown>('mcp/session-toggle', {}, { timeoutMs: 15 });
    const parsed = McpToggleResult.parse(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 'failed');
    assert.match(parsed.error ?? '', /protected resource metadata/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
