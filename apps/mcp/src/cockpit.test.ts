import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_ORIGIN, mockHttp, type MockResponse, type ReceivedRequest } from '../test-support/mock-http.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

const requests: ReceivedRequest[] = [];
let respond: (response: MockResponse, request: ReceivedRequest) => void;
const originalEnv = {
  COCKPIT_URL: process.env.COCKPIT_URL,
  COCKPIT_API_TOKEN: process.env.COCKPIT_API_TOKEN,
  COCKPIT_TIMEOUT_MS: process.env.COCKPIT_TIMEOUT_MS,
};
mockHttp((response, request) => {
  requests.push(request);
  respond(response, request);
});
process.env.COCKPIT_API_TOKEN = 'transport-test-token';
delete process.env.COCKPIT_TIMEOUT_MS;
after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// Config is initialized once at import time; never point these tests at a live backend.
const { COCKPIT_URL, requestTimeoutMs } = await import('./config.ts');
assert.equal(COCKPIT_URL, MOCK_ORIGIN);
const { CockpitError, MAX_TRANSFER_BYTES, MAX_ERROR_BYTES, backendJson, backendRequest, intent, readBoundedBody, assertIntentSuccess } =
  await import('./cockpit.ts');
const { McpToggleResult } = await import('./shared.ts');
const runNode = promisify(execFile);

beforeEach(() => {
  requests.length = 0;
  respond = (response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  };
});

function isCockpitError(kind: 'timeout' | 'connection' | 'backend' | 'protocol', pattern?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CockpitError);
    assert.equal(error.kind, kind);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

test('bounded native pages use the short deadline while real load operations keep theirs', () => {
  for (const name of ['session/chat', 'session/get', 'mcp/session', 'session/history', 'session/peek', 'session/subagent-history', 'flow/run', 'governance', 'governance/run', '/health']) {
    assert.equal(requestTimeoutMs(name), 10_000, name);
  }
  for (const name of ['session/plan', 'session/panels', 'session/load', 'prompt', 'mcp/session-toggle']) {
    assert.equal(requestTimeoutMs(name), 45_000, name);
  }
});

test('configured timeout overrides both generic and load-aware deadlines', async () => {
  respond = () => {};
  await runNode(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mockHttp } from './test-support/mock-http.ts';
    let calls = 0;
    mockHttp(() => { calls++; });
    process.env.COCKPIT_TIMEOUT_MS = '123';
    const { requestTimeoutMs } = await import('./src/config.ts');
    const { backendJson, intent, CockpitError } = await import('./src/cockpit.ts');
    const { invokePublishedIntent } = await import('./src/tools/foundation.ts');
    for (const path of ['/health', 'session/history', 'session/subagent-history', 'session/peek', 'flow/run']) {
      assert.equal(requestTimeoutMs(path), 123);
    }
    for (const request of [
      () => backendJson('/health'),
      () => intent('session/peek'),
      () => invokePublishedIntent('session/delete', { sessionId: 's1' }),
    ]) {
      await assert.rejects(request, (error) =>
        error instanceof CockpitError && error.kind === 'timeout'
          && /after 123ms/.test(error.message) && /no retry was attempted/.test(error.message));
    }
    assert.equal(calls, 3, 'one request per call, without capability preflight or retry');
  `], { env: { ...process.env, COCKPIT_TIMEOUT_MS: '123' } });
  assert.equal(requests.length, 0);
});

test('every generic JSON route and semantic intent authenticates with the configured token', async () => {
  assert.deepEqual(await backendJson('/capabilities?version=1'), { ok: true });
  await backendJson('/health');
  await backendJson('/status', { method: 'GET' });
  await backendJson('/admin/restart', { method: 'POST', body: { reason: 'test' } });
  const result = await intent<{ ok: boolean }>('session/peek', { sessionId: 's1' });
  assert.equal(result.ok, true);
  await intent('Mcp_1/session-toggle_2');
  assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
    ['GET', '/capabilities?version=1'],
    ['GET', '/health'],
    ['GET', '/status'],
    ['POST', '/admin/restart'],
    ['POST', '/intent/session/peek'],
    ['POST', '/intent/Mcp_1/session-toggle_2'],
  ]);
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Bearer transport-test-token');
    assert.equal(request.headers['accept-encoding'], 'identity');
  }
  assert.equal(requests[0]?.body.byteLength, 0);
  assert.deepEqual(JSON.parse(requests[3]?.body.toString() ?? ''), { reason: 'test' });
  assert.deepEqual(JSON.parse(requests[4]?.body.toString() ?? ''), { sessionId: 's1' });
  assert.deepEqual(JSON.parse(requests[5]?.body.toString() ?? ''), {});
});

test('an unset API token omits Authorization', async () => {
  const env = { ...process.env };
  delete env.COCKPIT_API_TOKEN;
  await runNode(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mockHttp } from './test-support/mock-http.ts';
    let calls = 0;
    mockHttp((response, request) => {
      assert.equal(request.headers.authorization, undefined);
      calls++;
      response.end('{"ok":true}');
    });
    const { backendJson, intent } = await import('./src/cockpit.ts');
    await backendJson('/health');
    await intent('session/peek');
    assert.equal(calls, 2);
  `], { env });
  assert.equal(requests.length, 0);
});

test('binary transport overrides caller auth and encoding headers and consumes bounded bytes', async () => {
  const upload = new Uint8Array([0, 1, 127, 255]);
  respond = (response, request) => response.end(request.body);
  const result = await backendRequest('/upload?name=a%20b.bin&mime=application%2Foctet-stream', {
    method: 'POST',
    body: upload,
    headers: {
      Authorization: 'Bearer wrong',
      authorization: 'Bearer also-wrong',
      'Accept-Encoding': 'gzip',
      'content-type': 'application/octet-stream',
      'x-test': 'preserved',
    },
  }, (response) => readBoundedBody(response));
  assert.deepEqual(result, upload);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.authorization, 'Bearer transport-test-token');
  assert.equal(requests[0]?.headers['accept-encoding'], 'identity');
  assert.equal(requests[0]?.headers['x-test'], 'preserved');
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(requests[0]?.body, Buffer.from(upload));
});

test('intent names reject traversal, URLs and escaping before any network request', async () => {
  for (const name of [
    '', '/', '/session/get', 'session/', 'session//get', '.', '..', 'session/../get', 'session/./get',
    'https://example.invalid/x', '//example.invalid/x', 'session\\get', 'session?get', 'session#get',
    'session/%2fget', 'session/%2E%2e/get', 'session/%252e%252e/get', 'session%5cget',
    'session get', 'session\nget', 'session\u0000get', 'séssion/get',
  ]) {
    await assert.rejects(() => intent(name), isCockpitError('protocol', /Invalid cockpit intent name/));
  }
  assert.equal(requests.length, 0);
});

test('all backend entry points reject unsafe paths before networking', async () => {
  const invalidPaths = [
    '', 'health', 'http://example.invalid/', '//example.invalid/x', '///health',
    '/a//b', '/a/../b', '/a/./b', '/..', '/.', '/a\\b', '/a#fragment', '/a?x=1#fragment',
    '/%2e%2e/b', '/.%2e/b', '/%2E/b', '/a%2fb', '/a%5Cb', '/a%3fb', '/a%23b',
    '/%252e%252e/b', '/%252fb', '/%', '/%0', '/%gg', '/%FF', '/a%00b', '/a%0ab',
    '/a b', '/a\nb', '/a\u007fb', '/a?value=%', '/a?value=%ff', '/a?value=%0D%0A',
    '/a?value=%5c', '/http://example.invalid/',
  ];
  for (const path of invalidPaths) {
    await assert.rejects(() => backendJson(path), isCockpitError('protocol', /Invalid cockpit backend path/));
    await assert.rejects(
      () => backendRequest(path, { method: 'POST', body: new Uint8Array([1]) }, readBoundedBody),
      isCockpitError('protocol', /Invalid cockpit backend path/),
    );
  }
  assert.equal(requests.length, 0);
});

test('safe backend filename escapes and query data remain intact', async () => {
  await backendJson('/uploads/report%20%E4%B8%AD.txt?name=a%23b&mime=text%2Fplain');
  assert.equal(requests[0]?.url, '/uploads/report%20%E4%B8%AD.txt?name=a%23b&mime=text%2Fplain');
});

test('redirects are errors for reads, mutations and binary requests without following or retrying', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    respond = (response) => {
      response.writeHead(status, { location: '/redirect-target' });
      response.end('redirect');
    };
    await assert.rejects(() => backendJson('/health'), isCockpitError('connection', /redirect/));
    await assert.rejects(() => intent('session/peek'), isCockpitError('connection', /redirect/));
    await assert.rejects(
      () => backendRequest('/upload', { method: 'POST', body: new Uint8Array([1]) }, readBoundedBody),
      isCockpitError('connection', /redirect/),
    );
  }
  assert.equal(requests.length, 15);
  assert.ok(requests.every((request) => request.url !== '/redirect-target'));
});

test('HTTP 421 never replays generic, intent or binary requests', async () => {
  respond = (response) => {
    response.writeHead(421);
    response.end('misdirected request');
  };
  await assert.rejects(() => backendJson('/health'), isCockpitError('backend', /HTTP 421/));
  await assert.rejects(
    () => backendJson('/admin/restart', { method: 'POST' }),
    isCockpitError('backend', /HTTP 421/),
  );
  await assert.rejects(() => intent('session/peek'), isCockpitError('backend', /HTTP 421/));
  await assert.rejects(
    () => backendRequest('/upload', { method: 'POST', body: new Uint8Array([1]) }, readBoundedBody),
    isCockpitError('backend', /HTTP 421/),
  );
  assert.equal(requests.length, 4);
});

test('header timeout reports an uncertain intent once, with no retry', async () => {
  respond = () => {};
  await assert.rejects(
    () => intent('session/plan', { sessionId: 's1' }, { timeoutMs: 100 }),
    (error: unknown) => {
      assert.ok(isCockpitError('timeout', /session\/plan.*timed out after 100ms/)(error));
      assert.ok(error instanceof CockpitError);
      assert.equal(error.intentName, 'session/plan');
      assert.match(error.message, /backend may still be processing it and no retry was attempted/);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test('generic JSON and binary deadlines cover stalled response bodies', async () => {
  respond = (response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"unfinished":');
  };
  await assert.rejects(
    () => backendJson('/status', { timeoutMs: 100 }),
    isCockpitError('timeout', /timed out after 100ms/),
  );
  await assert.rejects(
    () => backendRequest('/uploads/a.bin', { timeoutMs: 100 }, readBoundedBody),
    isCockpitError('timeout'),
  );
  assert.equal(requests.length, 2);
});

test('one deadline spans time spent on both headers and body, rather than restarting at headers', async () => {
  respond = (response) => {
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const headersTimer = setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":');
      bodyTimer = setTimeout(() => response.end('true}'), 100);
    }, 100);
    response.once('close', () => {
      clearTimeout(headersTimer);
      clearTimeout(bodyTimer);
    });
  };
  await assert.rejects(
    () => intent('session/peek', {}, { timeoutMs: 160 }),
    isCockpitError('timeout'),
  );
  assert.equal(requests.length, 1);
});

test('deadline also stays active throughout an asynchronous consumer', async () => {
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await assert.rejects(
      () => backendRequest('/health', { timeoutMs: 100 }, async (response) => {
        await readBoundedBody(response);
        await pending;
      }),
      isCockpitError('timeout'),
    );
  } finally {
    finish();
  }
  assert.equal(requests.length, 1);
});

test('consumer filesystem and programming errors are not relabeled as backend connection failures', async () => {
  for (const failure of [
    Object.assign(new Error('cannot write destination'), { code: 'EACCES' }),
    new TypeError('consumer bug'),
  ]) {
    await assert.rejects(
      () => backendRequest('/health', {}, async (response) => {
        await readBoundedBody(response);
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
  }
});

test('connection reset is actionable and is not retried', async () => {
  respond = (response) => response.destroy();
  await assert.rejects(
    () => intent('session/get'),
    (error: unknown) => {
      assert.ok(isCockpitError('connection', /Cannot connect.*socket hang up/)(error));
      assert.ok(error instanceof CockpitError);
      assert.match(error.message, /COCKPIT_URL \/ COCKPIT_PORT/);
      assert.equal(error.intentName, 'session/get');
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test('body connection failure stays distinct from a deadline', async () => {
  respond = (response) => {
    response.writeHead(200, { 'content-length': '100' });
    response.write('{"ok":true}');
    const timer = setTimeout(() => response.destroy(), 20);
    response.once('close', () => clearTimeout(timer));
  };
  await assert.rejects(() => backendJson('/health'), isCockpitError('connection', /response body/));
  assert.equal(requests.length, 1);
});

test('JSON, text, empty and oversized HTTP errors remain bounded backend errors', async () => {
  for (const [status, body, detail] of [
    [400, '{"error":"unknown session"}', /unknown session/],
    [401, 'unauthorized', /unauthorized/],
    [403, '{"error":123}', /HTTP 403/],
    [500, '<html>backend failed</html>', /backend failed/],
    [503, '', /HTTP 503/],
    [502, 'x'.repeat(70 * 1024), /byte limit/],
  ] as const) {
    respond = (response) => {
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(body);
    };
    await assert.rejects(
      () => intent('session/get'),
      (error: unknown) => {
        assert.ok(isCockpitError('backend', detail)(error));
        assert.ok(error instanceof CockpitError);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(error.message.length < 1500);
        assert.equal(error.intentName, 'session/get');
        return true;
      },
    );
  }
  assert.equal(requests.length, 6);
});

test('HTTP failures retain structured backend body, status and native cause without another request', async () => {
  const body = {
    error: 'Cockpit is closing', code: 'SERVICE_CLOSING',
    shutdown: { phase: 'failed', requestedAt: 1770000000123, error: 'native close rejected' },
    cause: { code: 'NATIVE_CLOSE', message: 'Original native cause' },
  };
  respond = response => response.writeHead(503).end(JSON.stringify(body));
  await assert.rejects(() => intent('system/status'), error => {
    assert.ok(error instanceof CockpitError);
    assert.equal(error.httpStatus, 503);
    assert.equal(error.intentName, 'system/status');
    assert.deepEqual(error.responseBody, body);
    assert.deepEqual(JSON.parse(error.message.split('HTTP 503: ')[1]!), body);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('HTTP error byte cap uses UTF-8 bytes and explicitly reports body omission', async () => {
  const body = JSON.stringify({ error: '界'.repeat(MAX_ERROR_BYTES / 2) });
  assert.ok(body.length < MAX_ERROR_BYTES);
  assert.ok(Buffer.byteLength(body) > MAX_ERROR_BYTES);
  respond = response => response.writeHead(503).end(body);
  await assert.rejects(() => intent('system/status'), error => {
    assert.ok(error instanceof CockpitError);
    assert.match(error.message, /byte limit/);
    assert.equal((error.responseBody as { _truncated: boolean })._truncated, true);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('HTTP error body consumption obeys the same deadline', async () => {
  respond = (response) => {
    response.writeHead(500);
    response.write('still producing error');
  };
  await assert.rejects(
    () => backendJson('/admin/restart', { method: 'POST', timeoutMs: 100 }),
    isCockpitError('timeout'),
  );
  assert.equal(requests.length, 1);
});

test('invalid or empty successful JSON is a protocol error, never a fabricated result', async () => {
  respond = (response) => response.end('not JSON');
  await assert.rejects(() => intent('session/get'), isCockpitError('protocol', /invalid JSON.*HTTP 200/));
  respond = (response) => {
    response.writeHead(204);
    response.end();
  };
  await assert.rejects(
    () => backendJson('/admin/restart', { method: 'POST' }),
    isCockpitError('protocol', /invalid JSON.*HTTP 204/),
  );
  respond = (response) => response.end('null');
  assert.equal(await backendJson('/health'), null);
});

test('oversized declared JSON and download responses are rejected before buffering', async () => {
  assert.equal(MAX_TRANSFER_BYTES, 25 * 1024 * 1024);
  respond = (response) => {
    response.writeHead(200, { 'content-length': String(MAX_TRANSFER_BYTES + 1) });
    response.flushHeaders();
  };
  await assert.rejects(() => backendJson('/status'), isCockpitError('protocol', /byte limit/));
  await assert.rejects(
    () => backendRequest('/uploads/a.bin', {}, readBoundedBody),
    isCockpitError('protocol', /byte limit/),
  );
  assert.equal(requests.length, 2);
});

test('JSON responses without Content-Length are capped by measured streaming bytes', async () => {
  respond = (response) => {
    response.writeHead(200, { 'transfer-encoding': 'chunked' });
    response.end(Buffer.alloc(MAX_TRANSFER_BYTES + 1, 32));
  };
  await assert.rejects(() => backendJson('/status'), isCockpitError('protocol', /byte limit/));
  assert.equal(requests.length, 1);
});

test('bounded binary streaming accepts the exact limit and rejects a byte beyond it', async () => {
  respond = (response) => {
    response.writeHead(200, { 'transfer-encoding': 'chunked' });
    response.write(new Uint8Array([1, 2]));
    response.end(new Uint8Array([3, 4]));
  };
  assert.deepEqual(
    await backendRequest('/uploads/a.bin', {}, (response) => readBoundedBody(response, 4)),
    new Uint8Array([1, 2, 3, 4]),
  );
  await assert.rejects(
    () => backendRequest('/uploads/a.bin', {}, (response) => readBoundedBody(response, 3)),
    isCockpitError('protocol', /3 byte limit/),
  );
});

test('compressed responses are refused even when a backend ignores identity negotiation', async () => {
  respond = (response) => {
    response.writeHead(200, { 'content-encoding': 'gzip' });
    response.end('not even consumed');
  };
  await assert.rejects(() => backendJson('/status'), isCockpitError('protocol', /Content-Encoding/));
  assert.equal(requests[0]?.headers['accept-encoding'], 'identity');
});

test('outgoing binary bounds and invalid deadlines are rejected before networking', async () => {
  await assert.rejects(
    () => backendRequest('/upload', { method: 'POST', body: new Uint8Array(MAX_TRANSFER_BYTES + 1) }, readBoundedBody),
    isCockpitError('protocol', /byte limit/),
  );
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(() => backendJson('/health', { timeoutMs }), isCockpitError('protocol', /timeout/));
  }
  assert.equal(requests.length, 0);
});

// Malformed or dishonest lengths cannot all be represented by node:http/fetch,
// which reject some at the HTTP parser. Exercise the body reader directly too.
test('body reader validates declared lengths, encoding and exact byte consistency', async () => {
  for (const length of ['-1', 'NaN', 'Infinity', '1.2', '1e2', '1, 1', '9007199254740992', '']) {
    await assert.rejects(
      () => readBoundedBody(new Response('x', { headers: { 'content-length': length } })),
      isCockpitError('protocol', /Content-Length/),
    );
  }
  for (const length of ['0', '2']) {
    await assert.rejects(
      () => readBoundedBody(new Response('x', { headers: { 'content-length': length } })),
      isCockpitError('protocol', /match Content-Length/),
    );
  }
  for (const encoding of ['gzip', 'br', 'identity, gzip', '']) {
    await assert.rejects(
      () => readBoundedBody(new Response('x', { headers: { 'content-encoding': encoding } })),
      isCockpitError('protocol', /Content-Encoding/),
    );
  }
  assert.deepEqual(await readBoundedBody(new Response(null, { headers: { 'content-length': '0' } }), 0), new Uint8Array());
  assert.deepEqual(
    await readBoundedBody(new Response('é', { headers: { 'content-length': '2', 'content-encoding': 'identity' } }), 2),
    new TextEncoder().encode('é'),
  );
});

test('body reader cancels the source on overflow and invalid declarations', async () => {
  for (const length of [undefined, '1000', '-1']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, {
      headers: length === undefined ? {} : { 'content-length': length },
    });
    await assert.rejects(() => readBoundedBody(response, 3), isCockpitError('protocol'));
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  }
});

test('fragmented response bodies are coalesced into one bounded backing buffer', async () => {
  let remaining = 8192;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(new Uint8Array([7]));
      else controller.close();
    },
  }));
  const result = await readBoundedBody(response, 8192);
  assert.equal(result.length, 8192);
  assert.equal(result.buffer.byteLength, 8192);
  assert.ok(result.every((byte) => byte === 7));
});

test('mcp/session-toggle target failure is returned as a typed result, not a transport timeout', async () => {
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
  respond = (response) => response.end(JSON.stringify(payload));
  const raw = await intent<unknown>('mcp/session-toggle', {}, { timeoutMs: 1000 });
  const parsed = McpToggleResult.parse(raw);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.error ?? '', /protected resource metadata/);
  assert.equal(requests[0]?.headers.authorization, 'Bearer transport-test-token');
});
