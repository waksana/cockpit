import assert from 'node:assert/strict';
import { beforeEach, test, type Mock, type TestContext } from 'node:test';
import type { Attachment, NativeChatPage, IntentBody, IntentName, ServerEvent } from '@cockpit/protocol';
import { EVENTS_URL, intentUrl } from '../lib/config';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { IntentHttpError, isSessionUnloadedError, NetClient, SessionUnloadedError, type ConnState } from './client';
import { readDirectory } from '../lib/directoryResource';
import { createKeyedAsync } from '../lib/keyedAsync';

beforeEach((t: TestContext) => {
  t.mock.method(console, 'error', () => {});
  const clearDiagnostics = () => {
    for (const error of getUxErrors()) dismissUxError(error.id);
  };
  clearDiagnostics();
  t.after(clearDiagnostics);
});

function setup(t: TestContext, respond: typeof globalThis.fetch) {
  const fetch = t.mock.method(globalThis, 'fetch', respond);
  const events: ServerEvent[] = [];
  const states: ConnState[] = [];
  const client = new NetClient({
    onEvent: (event) => { events.push(event); },
    onStateChange: (state) => { states.push(state); },
  });
  t.after(() => client.disconnect());
  return { client, fetch, events, states };
}

function assertOnlyPost<K extends IntentName>(
  fetch: Mock<typeof globalThis.fetch>,
  name: K,
  body: IntentBody<K>,
) {
  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0].arguments;
  const { body: json, ...options } = init ?? {};
  assert.equal(url, intentUrl(name));
  assert.deepEqual(options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
  });
  assert.ok(typeof json === 'string');
  assert.deepEqual(JSON.parse(json), body);
}

const chatRead = {
  source: 'persisted', direction: 'backward', max: 64, waitMs: 0, bootstrap: false,
} as const;
const chatPage: NativeChatPage = {
  sessionId: 'session', source: 'persisted', direction: 'backward',
  events: [], cursor: 'native-cursor', cursorStatus: 'ok', hasMore: false,
  read: { rpc: 1, events: 0 },
};

test('fresh Task initialization sends the exact fixed identity and explicit confirmation once', async t => {
  const body = { moduleId: 'task' as const, operationId: 'fresh-task-initialization', version: '1.2.3',
    digest: 'a'.repeat(64), gatewayUrl: 'https://127.0.0.1:34907', confirm: true as const };
  const { confirm: _confirm, ...identity } = body;
  const operation = { ...identity, phase: 'preparing', updatedAt: 1 };
  const { client, fetch } = setup(t, async () => Response.json({ operation }));
  assert.deepEqual(await client.intent('modules/config/initialize', body), { operation });
  assertOnlyPost(fetch, 'modules/config/initialize', body);
});

test('trusted local installation sends only host-source identity and reads the same inventory receipt', async t => {
  const body = { moduleId: 'assistant' as const, operationId: 'local-assistant-install-operation',
    version: '1.0.0', digest: 'c'.repeat(64) };
  const operation = { moduleId: body.moduleId, operationId: body.operationId, version: body.version,
    sha256: body.digest, source: 'local', state: 'unknown', updatedAt: 1 };
  const { client, fetch } = setup(t, async () => Response.json(operation));
  assert.deepEqual(await client.intent('modules/install/local', body), operation);
  assertOnlyPost(fetch, 'modules/install/local', body);
  fetch.mock.mockImplementation(async () => Response.json({ operation }));
  assert.deepEqual(await client.intent('modules/updates/get', { operationId: body.operationId }), { operation });
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(fetch.mock.calls[1].arguments[0], intentUrl('modules/updates/get'));
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), { operationId: body.operationId });
});

test('WeChat unbind history uses the pure read endpoint with only the retained operation ID', async t => {
  const body = { operationId: 'original-wechat-unbind' };
  const operation = { ...body, sessionId: 'deleted-native-session', state: 'unknown', error: 'Original hook outcome unknown' };
  const { client, fetch } = setup(t, async () => Response.json({ operation }));
  assert.deepEqual(await client.intent('modules/wechat/unbind/get', body), { operation });
  assertOnlyPost(fetch, 'modules/wechat/unbind/get', body);
  for (const state of ['working', 'succeeded', 'failed'] as const) {
    const receipt = { ...operation, state };
    fetch.mock.mockImplementation(async () => Response.json({ operation: receipt }));
    assert.deepEqual(await client.intent('modules/wechat/unbind/get', body), { operation: receipt });
  }
  fetch.mock.mockImplementation(async () => Response.json({ operation: null }));
  assert.deepEqual(await client.intent('modules/wechat/unbind/get', body), { operation: null });
  assert.equal(fetch.mock.callCount(), 5);
  assert.ok(fetch.mock.calls.every(call => call.arguments[0] === intentUrl('modules/wechat/unbind/get')));
});

test('initialization history reads only the original operation ID and preserves unknown/null results', async t => {
  const body = { operationId: 'fresh-task-initialization' };
  const operation = { moduleId: 'task', ...body, version: '1.2.3', digest: 'a'.repeat(64),
    gatewayUrl: 'https://127.0.0.1:34907', phase: 'unknown', updatedAt: 1, reason: 'MODULE_INITIALIZATION_INTERRUPTED_NO_REPLAY' };
  const { client, fetch } = setup(t, async () => Response.json({ operation }));
  assert.deepEqual(await client.intent('modules/config/initialization', body), { operation });
  assertOnlyPost(fetch, 'modules/config/initialization', body);
  fetch.mock.mockImplementation(async () => Response.json({ operation: null }));
  assert.deepEqual(await client.intent('modules/config/initialization', body), { operation: null });
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(fetch.mock.calls.every(call => call.arguments[0] === intentUrl('modules/config/initialization')));
});

test('installation reconciliation sends the original ID with confirm and returns its authoritative outcome', async t => {
  const result = { moduleId: 'task', operationId: 'original-install-operation', version: '1.2.0',
    sha256: 'a'.repeat(64), state: 'failed', updatedAt: 1, error: 'package retained; selection unchanged' };
  const { client, fetch } = setup(t, async () => Response.json(result));
  const body = { moduleId: 'task' as const, operationId: result.operationId, confirm: true as const };
  assert.deepEqual(await client.intent('modules/updates/reconcile', body), result);
  assertOnlyPost(fetch, 'modules/updates/reconcile', body);
});

test('historical installation get is passive, nullable and preserves the exact original ID', async t => {
  const { client, fetch } = setup(t, async () => Response.json({ operation: null }));
  const body = { operationId: 'old-retained-install-operation' };
  assert.deepEqual(await client.intent('modules/updates/get', body), { operation: null });
  assertOnlyPost(fetch, 'modules/updates/get', body);
});

test('session module application and manual unbind forward caller-owned stable IDs exactly once', async t => {
  const selections = [{ moduleId: 'task' as const, roleId: 'commander', version: '1.2.1' }];
  const apply = { sessionId: 'session-a', operationId: 'retained-apply-operation', selections };
  let response = Response.json({ modules: { ...apply, phase: 'unknown', pendingSelections: selections } });
  const { client, fetch } = setup(t, async () => response);
  assert.equal((await client.intent('session/modules/apply', apply)).modules.phase, 'unknown');
  assertOnlyPost(fetch, 'session/modules/apply', apply);
  response = Response.json({ ok: true });
  const unbind = { sessionId: 'session-a', operationId: 'retained-unbind-operation', confirm: true as const };
  await client.intent('modules/wechat/unbind', unbind);
  assert.equal(fetch.mock.calls[1].arguments[0], intentUrl('modules/wechat/unbind'));
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), unbind);
  assert.equal(fetch.mock.callCount(), 2);
});

for (const action of ['start', 'stop', 'apply'] as const) {
  test(`module service ${action} uses the exact operation and release request without assuming readiness`, async t => {
    const body: IntentBody<'modules/service'> = { moduleId: 'task', operationId: 'service-wire-operation', action,
      ...(action === 'stop' ? {} : { version: '2.0.0', digest: 'a'.repeat(64) }) };
    const { moduleId, ...command } = body;
    const job = { schemaVersion: 1, command: { id: moduleId, ...command }, phase: 'accepted', step: 'queued',
      acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z' };
    const { client, fetch } = setup(t, async () => Response.json({ job }));
    assert.deepEqual(await client.intent('modules/service', body), { job });
    assertOnlyPost(fetch, 'modules/service', body);
  });
}

test('module service job/status reads stay passive and a lost submission never auto-retries', async t => {
  let response = Response.json({ job: null });
  const { client, fetch } = setup(t, async () => response);
  const abort = new AbortController();
  assert.deepEqual(await client.intent('modules/service/job', { operationId: 'original-service-operation' }, abort.signal), { job: null });
  assert.equal(fetch.mock.calls[0].arguments[0], intentUrl('modules/service/job'));
  assert.equal(fetch.mock.calls[0].arguments[1]?.signal, abort.signal);
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[0].arguments[1]?.body)), { operationId: 'original-service-operation' });
  const status = { id: 'task', status: 'stopped', owned: false, recoveryRequired: false };
  response = Response.json(status);
  assert.deepEqual(await client.intent('modules/service/status', { moduleId: 'task' }), status);
  assert.equal(fetch.mock.calls[1].arguments[0], intentUrl('modules/service/status'));
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), { moduleId: 'task' });
  response = Response.json({ error: 'runner response unknown' }, { status: 503 });
  await assert.rejects(client.intent('modules/service', { moduleId: 'task', action: 'stop', operationId: 'uncertain-service-operation' }), /unknown/);
  assert.equal(fetch.mock.callCount(), 3);
});

test('explicit module recovery forwards an independent stop ID linked to the original fault, without version or force', async t => {
  const body = { moduleId: 'task' as const, action: 'stop' as const, operationId: 'new-recovery-operation',
    recoveryOf: 'original-fault-operation', confirmRecovery: true as const };
  const { moduleId, ...command } = body;
  const job = { schemaVersion: 1, command: { id: moduleId, ...command }, phase: 'unknown', step: 'waiting-exit',
    acceptedAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:01.000Z', reason: 'drain not confirmed' };
  const { client, fetch } = setup(t, async () => Response.json({ job }));
  assert.deepEqual(await client.intent('modules/service', body), { job });
  assertOnlyPost(fetch, 'modules/service', body);
});

test('deletion preview forwards cancellation and returns only the matching validated plan', async t => {
  const plan = { sessionId: 'session', planId: 'a'.repeat(64), modules: [] };
  const { client, fetch } = setup(t, async () => Response.json({ plan }));
  const controller = new AbortController();
  assert.deepEqual(await client.previewDeleteSession('session', controller.signal), plan);
  assert.equal(fetch.mock.calls[0].arguments[0], intentUrl('session/delete/preview'));
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[0].arguments[1]?.body)), { sessionId: 'session' });
  assert.equal(fetch.mock.calls[0].arguments[1]?.signal, controller.signal);
  assert.equal(fetch.mock.callCount(), 1);
});

test('delete approval is forwarded exactly once and ordinary delete keeps its existing body', async t => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: true }));
  const unbind = { planId: 'b'.repeat(64), operationId: 'retained-operation' };
  await client.deleteSession('session', true, unbind);
  assertOnlyPost(fetch, 'session/purge', { sessionId: 'session', confirm: true, unbind });
  await client.deleteSession('ordinary', true);
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), { sessionId: 'ordinary', confirm: true });
});

test('failed or wrong-session delete preview never becomes an empty allowed plan', async t => {
  let response = Response.json({ error: 'Cannot read preview' }, { status: 503 });
  const { client, fetch } = setup(t, async () => response);
  await assert.rejects(client.previewDeleteSession('session'), /Cannot read preview/);
  response = Response.json({ plan: { sessionId: 'other', planId: 'c'.repeat(64), modules: [] } });
  await assert.rejects(client.previewDeleteSession('session'), /其他会话/);
  response = Response.json({});
  await assert.rejects(client.previewDeleteSession('session'));
  assert.equal(fetch.mock.callCount(), 3);
  assert.ok(fetch.mock.calls.every(call => call.arguments[0] === intentUrl('session/delete/preview')));
});

test('module-aware creation forwards exact choices and retains an incomplete native session without automatic retry', async t => {
  const { client, fetch } = setup(t, async () => Response.json({
    error: 'Task module preparation incomplete', code: 'MODULE_SESSION_INCOMPLETE', sessionId: 'retained-session',
  }, { status: 409 }));
  const modules = [{ moduleId: 'assistant' as const, roleId: 'assistant', version: '1.0.0' }];
  await assert.rejects(client.newSession('/workspace', modules), error => error instanceof IntentHttpError
    && error.sessionId === 'retained-session' && error.code === 'MODULE_SESSION_INCOMPLETE');
  assertOnlyPost(fetch, 'session/new', { cwd: '/workspace', modules });
});

test('interactive start sends actual first-message text and retained files with one operation identity', async t => {
  const operation = { operationId: 'start-operation', sessionId: 'b4d57799-2ccf-4a9e-9f04-0a9bc6aebdb0', state: 'accepted' as const };
  const { client, fetch } = setup(t, async () => Response.json({ operation }));
  const attachment = { kind: 'file' as const, name: 'notes.txt', url: '/uploads/notes.txt', size: 4, mime: 'text/plain' };
  const body = { operationId: operation.operationId, cwd: '/workspace', text: 'first message',
    modules: [{ moduleId: 'task' as const, roleId: 'commander', version: '1.2.0' }], attachment };
  assert.deepEqual(await client.startSession(body), operation);
  assertOnlyPost(fetch, 'session/start', body);
});

test('first-message ordered parts and multiple retained attachments preserve their wire shape', async t => {
  const operation = { operationId: 'parts-operation', sessionId: 'b4d57799-2ccf-4a9e-9f04-0a9bc6aebdb0', state: 'accepted' as const };
  const { client, fetch } = setup(t, async () => Response.json({ operation }));
  const attachment = { kind: 'image' as const, name: 'image.png', url: '/uploads/image.png' };
  const body = { operationId: operation.operationId, cwd: '/workspace', text: '',
    parts: [{ type: 'text' as const, text: 'read this' }, { type: 'file' as const, attachment }] };
  await client.startSession(body);
  assertOnlyPost(fetch, 'session/start', body);
  await client.startSession({ operationId: operation.operationId, cwd: '/workspace', text: '', attachments: [attachment, attachment] });
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), {
    operationId: operation.operationId, cwd: '/workspace', text: '', attachments: [attachment, attachment],
  });
});

test('start/get is passive and nullable, while unknown/missing/mismatched start results never auto-retry', async t => {
  const operationId = 'unknown-start-operation';
  const body = { operationId, cwd: '/workspace', text: 'first message' };
  let response = Response.json({ operation: { operationId, sessionId: 'b4d57799-2ccf-4a9e-9f04-0a9bc6aebdb0', state: 'unknown', error: 'preparation incomplete' } });
  const { client, fetch } = setup(t, async () => response);
  assert.equal((await client.startSession(body)).state, 'unknown');
  assert.equal(fetch.mock.callCount(), 1);
  response = Response.json({ operation: null });
  const controller = new AbortController();
  assert.equal(await client.getSessionStart(operationId, controller.signal), null);
  assert.equal(fetch.mock.calls[1].arguments[0], intentUrl('session/start/get'));
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), { operationId });
  assert.equal(fetch.mock.calls[1].arguments[1]?.signal, controller.signal);
  response = Response.json({});
  await assert.rejects(client.startSession(body));
  response = Response.json({ operation: { operationId: 'other-operation', sessionId: 'b4d57799-2ccf-4a9e-9f04-0a9bc6aebdb0', state: 'accepted' } });
  await assert.rejects(client.startSession(body), /标识不匹配/);
  assert.equal(fetch.mock.callCount(), 4);
});

test('native usage client validates the snapshot, forwards cancellation and never resumes on unloaded response', async t => {
  const usage = { sessionId: 'session', sampledAt: 1, context: null,
    usage: { sessionStartTime: '2026-09-09T00:00:00Z', totalUserRequests: 0,
      lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {} } };
  let cold = false;
  const { client, fetch } = setup(t, async () => cold
    ? Response.json({ error: 'Unloaded', code: 'SESSION_UNLOADED' }, { status: 409 })
    : Response.json(usage));
  const controller = new AbortController();
  assert.deepEqual(await client.getUsage('session', controller.signal), usage);
  assert.equal(fetch.mock.calls[0].arguments[1]?.signal, controller.signal);
  cold = true;
  await assert.rejects(client.getUsage('session'), isSessionUnloadedError);
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(fetch.mock.calls.every(call => String(call.arguments[0]).endsWith('/intent/session/usage')));
});

test('native usage client rejects another session or invalid counters without retry', async t => {
  let payload = { sessionId: 'other', sampledAt: 1, context: null,
    usage: { sessionStartTime: 'native-start', totalUserRequests: 0,
      lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {} } };
  const { client, fetch } = setup(t, async () => Response.json(payload));
  await assert.rejects(client.getUsage('requested'), /returned sessionId/);
  payload = { ...payload, sessionId: 'requested', usage: { ...payload.usage, lastCallInputTokens: -1 } };
  await assert.rejects(client.getUsage('requested'), /greater than or equal/);
  assert.equal(fetch.mock.callCount(), 2);
});

for (const path of [undefined, '/P', './P', '', '   ']) {
  test(`directory errors retain dispatch path ${path ?? '(default)'} and one original cause`, async t => {
    let reject!: (error: Error) => void;
    const original = new Error('directory denied');
    const { client, fetch } = setup(t, () => new Promise<Response>((_resolve, rejectRequest) => { reject = rejectRequest; }));
    const pending = client.listDir(path);
    reject(original);
    await assert.rejects(pending, error => error === original);
    assertOnlyPost(fetch, 'fs/listDir', path === undefined ? {} : { path });
    assert.equal(getUxErrors().length, 1);
    assert.equal(getUxErrors()[0].message, `目录 ${path ?? '服务器主目录（未指定路径）'}：接口 fs/listDir 调用失败：directory denied`);
  });
}

for (const [path, status, code] of [
  ['/missing', 404, 'ENOENT'], ['/file', 400, 'ENOTDIR'],
  ['/denied', 403, 'EACCES'], ['', 400, 'INVALID_DIRECTORY_PATH'],
] as const) {
  test(`directory picker resource exposes ${code} without accepting a fallback and can recover`, async t => {
    const message = `${code}: cannot list directory '${path}'`;
    let failed = true;
    const listing = { path: '/valid/project', parent: '/valid', entries: [] };
    const { client, fetch } = setup(t, async () => failed
      ? Response.json({ error: message, code }, { status })
      : Response.json(listing));
    const resource = createKeyedAsync(JSON.stringify(['directory', path]),
      () => ({ connState: 'open', connectionGeneration: 1 }));
    resource.activate();
    let accepted = 0;
    assert.equal(await resource.run(() => readDirectory(p => client.listDir(p), path), () => { accepted++; }), false);
    assertOnlyPost(fetch, 'fs/listDir', { path });
    assert.equal(accepted, 0);
    assert.equal(resource.getSnapshot().data, undefined);
    assert.equal(resource.getSnapshot().error, message);
    const cause = resource.getSnapshot().errorCause;
    assert.ok(cause instanceof IntentHttpError);
    assert.equal(cause.status, status);
    assert.equal(cause.code, code);
    assert.equal(getUxErrors().length, 1);
    assert.ok(getUxErrors()[0].message.includes(message));
    failed = false;
    resource.deactivate();
    const next = createKeyedAsync(JSON.stringify(['directory', listing.path]),
      () => ({ connState: 'open', connectionGeneration: 1 }));
    next.activate();
    assert.equal(await next.run(() => readDirectory(p => client.listDir(p), listing.path), () => { accepted++; }), true);
    assert.equal(accepted, 1);
    assert.equal(next.getSnapshot().error, null);
    assert.deepEqual(next.getSnapshot().data, listing);
    assert.equal(fetch.mock.callCount(), 2);
    assert.deepEqual(JSON.parse(String(fetch.mock.calls[1].arguments[1]?.body)), { path: listing.path });
  });
}

test('late directory HTTP failure keeps old P rather than the subsequently requested Q', async t => {
  let release!: (response: Response) => void;
  const { client } = setup(t, (_url, init) => JSON.parse(String(init?.body)).path === '/P'
    ? new Promise<Response>(resolve => { release = resolve; })
    : Promise.resolve(Response.json({ path: '/Q', parent: '/', entries: [] })));
  const old = client.listDir('/P');
  assert.equal((await client.listDir('/Q')).path, '/Q');
  release(Response.json({ error: 'no permission' }, { status: 500 }));
  await assert.rejects(old, /no permission/);
  assert.equal(getUxErrors().length, 1);
  assert.match(getUxErrors()[0].message, /^目录 \/P：.*no permission/);
  assert.doesNotMatch(getUxErrors()[0].message, /\/Q/);
});

for (const interrupted of [false, true]) {
  test(`interrupt transports ${interrupted} exactly once without changing cancel or sending a prompt`, async t => {
    const { client, fetch } = setup(t, async () => Response.json({ ok: true, interrupted }));
    assert.deepEqual(await client.interrupt('original'), { ok: true, interrupted });
    assertOnlyPost(fetch, 'session/interrupt', { sessionId: 'original' });
  });
}

test('interrupt transport uncertainty rejects and is never retried', async t => {
  const { client, fetch } = setup(t, async () => { throw new TypeError('network lost'); });
  await assert.rejects(client.interrupt('original'), /network lost/);
  assertOnlyPost(fetch, 'session/interrupt', { sessionId: 'original' });
});

test('child event page sends native agent identities and opaque cursor without a history scan', async (t) => {
  const page = { ...chatPage, source: 'live' };
  const { client, fetch } = setup(t, async () => Response.json(page));
  const opts = { ...chatRead, source: 'live' as const, agentIds: ['native-agent', 'native-spawn'], cursor: 'child-older' };
  assert.deepEqual(await client.chat({ sessionId: 'session', ...opts }), page);
  assertOnlyPost(fetch, 'session/chat', { sessionId: 'session', ...opts });
});

for (const invalid of [
  { ...chatPage, sessionId: 'wrong' },
  { ...chatPage, events: 'wrong' },
  { ...chatPage, cursorStatus: 'guessed' },
  { ...chatPage, read: undefined },
]) {
  test(`native page rejects wrong identity or shape without retries: ${JSON.stringify(invalid)}`, async (t) => {
    const { client, fetch } = setup(t, async () => Response.json(invalid));
    await assert.rejects(client.chat({ sessionId: 'session', ...chatRead }));
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('chat response validation uses serialized identity even when caller mutates the body', async (t) => {
  let resolve!: (value: Response) => void;
  const { client } = setup(t, () => new Promise<Response>((yes) => { resolve = yes; }));
  const body = { sessionId: 'session', ...chatRead };
  const pending = client.intent('session/chat', body);
  body.sessionId = 'wrong';
  resolve(Response.json({ ...chatPage, sessionId: 'wrong' }));
  await assert.rejects(pending, /returned sessionId/);
});

for (const source of ['persisted', 'live'] as const) {
  test(`${source} chat propagates the view abort signal and cancellation has no diagnostic or retry`, async (t) => {
    const controller = new AbortController();
    const { client, fetch } = setup(t, (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const pending = client.chat({ sessionId: 'session', ...chatRead, source }, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(getUxErrors(), []);
  });
}

function mockEventSource(t: TestContext) {
  const instances: FakeEventSource[] = [];
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = FakeEventSource.CONNECTING;
    readonly url: string;
    readonly withCredentials: boolean;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;

    constructor(url: string, options?: EventSourceInit) {
      this.url = url;
      this.withCredentials = options?.withCredentials ?? false;
      instances.push(this);
    }

    close() { this.readyState = FakeEventSource.CLOSED; }
    open() {
      this.readyState = FakeEventSource.OPEN;
      assert.ok(this.onopen);
      this.onopen();
    }
    emit(event: unknown) {
      assert.ok(this.onmessage);
      this.onmessage({ data: JSON.stringify(event) });
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true, writable: true, value: FakeEventSource,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'EventSource', original);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  });
  return { instances, FakeEventSource };
}

test('prompt stays pending until its POST resolves and returns the parsed acknowledgement', async (t) => {
  let resolve!: (response: Response) => void;
  const post = new Promise<Response>((yes) => { resolve = yes; });
  const { client, fetch, events } = setup(t, () => post);
  let settled = false;
  const pending = client.prompt('session', 'keep this draft', undefined, 'enqueue').then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assertOnlyPost(fetch, 'prompt', { sessionId: 'session', text: 'keep this draft', mode: 'enqueue' });
  assert.deepEqual(getUxErrors(), []);

  resolve(Response.json({ ok: true, queued: true }));
  assert.deepEqual(await pending, { ok: true, queued: true });
  assert.equal(settled, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(events, []);
  assert.deepEqual(getUxErrors(), []);
});

test('generic auto-name intent sends exactly the existing session identity with no prompt, model or resume request', async (t) => {
  const result = { ok: true, applied: true, title: 'Native name' };
  const { client, fetch, events } = setup(t, async () => Response.json(result));
  assert.equal('renameSession' in client, false);
  assert.equal('autoNameSession' in client, false);
  assert.deepEqual(await client.intent('session/auto-name', { sessionId: 'session' }), result);
  assertOnlyPost(fetch, 'session/auto-name', { sessionId: 'session' });
  assert.deepEqual(events, []);
  assert.deepEqual(getUxErrors(), []);
});

for (const invalid of [
  { ok: false, applied: false, title: null },
  { ok: true, title: 'missing applied' },
  { ok: true, applied: 'true', title: 'wrong boolean' },
  { ok: true, applied: true },
  { ok: true, applied: true, title: 123 },
  { ok: true, applied: false, title: null, reason: 'unknown' },
]) {
  test(`auto-name rejects malformed protocol result without retry: ${JSON.stringify(invalid)}`, async (t) => {
    const { client, fetch } = setup(t, async () => Response.json(invalid));
    await assert.rejects(client.intent('session/auto-name', { sessionId: 'session' }), { name: 'ZodError' });
    assertOnlyPost(fetch, 'session/auto-name', { sessionId: 'session' });
    assert.equal(getUxErrors().length, 1);
  });
}

test('auto-name preserves typed SESSION_BUSY instead of retrying, resuming or cancelling chat work', async (t) => {
  const { client, fetch } = setup(t, async () => Response.json({
    error: 'Wait until idle', code: 'SESSION_BUSY',
  }, { status: 409 }));
  await assert.rejects(client.intent('session/auto-name', { sessionId: 'session' }), (error) => {
    assert.ok(error instanceof IntentHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'SESSION_BUSY');
    return true;
  });
  assertOnlyPost(fetch, 'session/auto-name', { sessionId: 'session' });
});

const attachment: Attachment = {
  kind: 'image', name: 'screenshot.png', url: '/uploads/screenshot.png',
  size: 42, mime: 'image/png',
};

for (const mode of [undefined, 'enqueue', 'immediate'] as const) {
  test(`prompt sends only shared attachment metadata with mode ${mode ?? 'omitted'}`, async (t) => {
    const { client, fetch } = setup(t, async () => Response.json({ ok: true }));
    const uploaded = {
      ...attachment, path: '/server/private/screenshot.png',
      absolutePath: '/server/private/screenshot.png', serverOnly: true,
    };
    assert.deepEqual(await client.prompt('session', '', uploaded, mode), { ok: true });
    assertOnlyPost(fetch, 'prompt', {
      sessionId: 'session', text: '', attachment, ...(mode ? { mode } : {}),
    });
    assert.deepEqual(getUxErrors(), []);
  });
}

test('prompt without attachment or mode preserves the text-only contract', async (t) => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: true }));
  assert.deepEqual(await client.prompt('session', 'hello'), { ok: true });
  assertOnlyPost(fetch, 'prompt', { sessionId: 'session', text: 'hello' });
});

test('multi-file prompt preserves order while stripping server authority on each item', async t => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: true }));
  const second: Attachment = { kind: 'file', name: 'original clip.mp4', mime: 'video/mp4', size: 4, url: '/uploads/clip.mp4' };
  const files = [{ ...attachment, path: '/private/image' }, { ...second, path: '/private/video' }];
  assert.deepEqual(await client.prompt('session', 'caption', undefined, undefined, files), { ok: true });
  assertOnlyPost(fetch, 'prompt', { sessionId: 'session', text: 'caption', attachments: [attachment, second] });
});

test('legacy and multiple attachment forms cannot be combined or silently dropped', async t => {
  const { client, fetch } = setup(t, async () => assert.fail('invalid combination must not post'));
  await assert.rejects(client.prompt('session', 'caption', attachment, undefined, [attachment]));
  assert.equal(fetch.mock.callCount(), 0);
});

test('managed file reads and association use typed intents without hidden prompt dispatch', async t => {
  const uploaded = { ...attachment, path: '/uploads/image.png', storedName: 'image.png', size: 4, mime: 'image/png' };
  const errors = [{ url: '/uploads/unpublished', error: 'Missing metadata' }];
  const { client, fetch } = setup(t, async (url) => String(url).endsWith('/files/list')
    ? Response.json({ files: [uploaded], hasMore: true, nextOffset: 30, errors })
    : Response.json(uploaded));
  const controller = new AbortController();
  const page = await client.intent('files/list', { query: 'image', offset: 0, limit: 30 }, controller.signal);
  assert.equal(page.nextOffset, 30);
  assert.deepEqual(page.errors, errors);
  assert.equal(fetch.mock.calls[0].arguments[1]?.signal, controller.signal);
  await client.intent('files/get', { url: attachment.url });
  await client.intent('files/associate', { sessionId: 'session', url: attachment.url });
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[2].arguments[1]?.body)), { sessionId: 'session', url: attachment.url });
  assert.equal(fetch.mock.callCount(), 3);
  assert.ok(fetch.mock.calls.every(call => !String(call.arguments[0]).endsWith('/prompt')));
});

test('file attachments can omit optional metadata', async (t) => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: true, queued: false }));
  const file: Attachment = { kind: 'file', name: 'notes.txt', url: '/uploads/notes.txt' };
  assert.deepEqual(await client.prompt('session', 'read this', file, 'immediate'), { ok: true, queued: false });
  assertOnlyPost(fetch, 'prompt', {
    sessionId: 'session', text: 'read this', attachment: file, mode: 'immediate',
  });
});

test('direct prompt intents also strip non-protocol upload authority', async (t) => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: true }));
  const body = {
    sessionId: 'session', text: 'read this',
    attachment: { ...attachment, path: '/server/private/file', absolutePath: '/server/private/file' },
    path: '/server/private/file',
  };
  assert.deepEqual(await client.intent('prompt', body), { ok: true });
  assertOnlyPost(fetch, 'prompt', { sessionId: 'session', text: 'read this', attachment });
});

test('invalid attachment metadata rejects locally without posting or retrying', async (t) => {
  const { client, fetch, events } = setup(t, async () => {
    throw new Error('Invalid prompt must not POST');
  });
  await assert.rejects(client.prompt('session', 'draft', {
    ...attachment, kind: 'directory',
  } as unknown as Attachment), (error: unknown) => error instanceof Error && error.name === 'ZodError');
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(events, []);
  assert.equal(getUxErrors().length, 1);
  assert.match(getUxErrors()[0].message, /^会话 session \(session\)：接口 prompt 调用失败：/);
});

test('unloaded MCP remains a passive transport result, not configured toggle rows', async (t) => {
  const result = { loaded: false, servers: [] };
  const { client, fetch } = setup(t, async () => Response.json(result));
  assert.deepEqual(await client.mcpSession('session'), result);
  assertOnlyPost(fetch, 'mcp/session', { sessionId: 'session' });
});

for (const status of ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'stopped', 'not_configured']) {
  test(`Web MCP reads and settings preserve native ${status} and separate enablement`, async t => {
    const enabled = status !== 'disabled' && status !== 'not_configured';
    const inventory = { loaded: true, servers: [{ name: 'fixture', detail: 'native', status, enabled }] };
    const panels = { skills: [], mcpServers: [{ label: 'fixture', sublabel: status, enabled }],
      tasks: [], instructionSources: [], schedules: [] };
    const toggle = { ok: false, applied: false, sessionId: 'session', name: 'fixture', status, enabled,
      error: 'Native target did not confirm the requested change',
      operation: { id: 'operation', desiredEnabled: true, state: 'failed', startedAt: 1, status } };
    const { client, fetch } = setup(t, async url => Response.json(
      String(url).endsWith('/mcp/session') ? inventory : String(url).endsWith('/session/panels') ? panels : toggle,
    ));
    assert.deepEqual(await client.mcpSession('session'), inventory);
    assert.deepEqual(await client.getPanels('session'), panels);
    assert.deepEqual(await client.mcpToggleSession('session', 'fixture', true), toggle);
    assert.equal(fetch.mock.callCount(), 3);
  });
}

test('Web MCP unknown state is an explicit visible read/setting error, never an unconfigured fallback', async t => {
  const message = 'Native MCP state is unconfirmed for fixture: unknown status "future-status"';
  const { client, fetch } = setup(t, async () => Response.json({ error: message }, { status: 409 }));
  for (const read of [
    () => client.mcpSession('session'), () => client.getPanels('session'),
    () => client.mcpToggleSession('session', 'fixture', true),
  ]) await assert.rejects(read(), error => error instanceof Error && error.message === message);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(getUxErrors().length, 3);
  assert.ok(getUxErrors().every(error => error.message.includes(message)));
});

for (const status of ['needs_auth', 'future-status']) {
  test(`Web MCP rejects invalid successful-response status ${status}`, async t => {
    const { client, fetch } = setup(t, async () => Response.json({
      loaded: true, servers: [{ name: 'fixture', detail: 'native', enabled: true, status }],
    }));
    await assert.rejects(client.mcpSession('session'), /Invalid enum value/);
    assertOnlyPost(fetch, 'mcp/session', { sessionId: 'session' });
    assert.equal(getUxErrors().length, 1);
  });
}

for (const enabled of [true, false]) {
  test(`skillsSetGlobal sends only native name and enabled=${enabled} without session context`, async (t) => {
    const { client, fetch } = setup(t, async () => Response.json({ ok: true }));
    assert.deepEqual(await client.skillsSetGlobal('review', enabled), { ok: true });
    assertOnlyPost(fetch, 'skills/global-toggle', { name: 'review', enabled });
  });
}

for (const enabled of [true, false, undefined]) {
  test(`skillsRead preserves native optional enabled=${enabled} with its cwd`, async (t) => {
    const result = { name: 'review', body: '# Review', ...(enabled === undefined ? {} : { enabled }) };
    const { client, fetch } = setup(t, async () => Response.json(result));
    assert.deepEqual(await client.skillsRead('review', '/work/project'), result);
    assertOnlyPost(fetch, 'skills/read', { name: 'review', cwd: '/work/project' });
  });
}

for (const cwd of [undefined, '/work/project with spaces', '']) {
  test(`skillsGlobal sends optional cwd ${JSON.stringify(cwd)}`, async (t) => {
    const { client, fetch } = setup(t, async () => Response.json({ skills: [] }));
    assert.deepEqual(await client.skillsGlobal(cwd), { skills: [] });
    assertOnlyPost(fetch, 'skills/global', cwd === undefined ? {} : { cwd });
  });
}

test('ok:false is returned unchanged without retrying or sending a diagnostic prompt', async (t) => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: false }));
  assert.deepEqual(await client.respondAsk('session', 'ask', 'answer', true), { ok: false });
  assertOnlyPost(fetch, 'respondAsk', {
    sessionId: 'session', requestId: 'ask', answer: 'answer', wasFreeform: true,
  });
  assert.deepEqual(getUxErrors(), []);
});

test('prompt ok:false is not turned into a successful acknowledgement', async (t) => {
  const { client, fetch } = setup(t, async () => Response.json({ ok: false }));
  assert.deepEqual(await client.prompt('session', 'keep my draft', attachment), { ok: false });
  assertOnlyPost(fetch, 'prompt', { sessionId: 'session', text: 'keep my draft', attachment });
  assert.deepEqual(getUxErrors(), []);
});

const rejected = new Error('Answer submission rejected');
const offline = new TypeError('Connection lost while answering');
const unloadedMessage = 'Native session data is unavailable while unloaded; explicitly resume the session first.';

for (const name of ['session/plan', 'session/panels', 'skills/session', 'schedule/list'] as const) {
  for (const field of ['error', 'message'] as const) {
    test(`${name} preserves unloaded HTTP status/code and ${field} without global diagnostics or retries`, async (t) => {
      const { client, fetch, events } = setup(t, async () => Response.json({
        code: 'SESSION_UNLOADED', [field]: unloadedMessage,
      }, { status: 409 }));
      await assert.rejects(client.intent(name, { sessionId: 'session' }), (error: unknown) => {
        assert.ok(error instanceof IntentHttpError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'SESSION_UNLOADED');
        assert.equal(error.message, unloadedMessage);
        assert.equal(isSessionUnloadedError(error), true);
        return true;
      });
      assertOnlyPost(fetch, name, { sessionId: 'session' });
      assert.deepEqual(events, []);
      assert.deepEqual(getUxErrors(), []);
      assert.equal((console.error as Mock<typeof console.error>).mock.callCount(), 0);
    });
  }
}

for (const { status, code } of [
  { status: 409, code: 'OTHER_CONFLICT' },
  { status: 403, code: 'SESSION_UNLOADED' },
  { status: 409, code: undefined },
  { status: 409, code: 123 },
]) {
  test(`HTTP ${status}/${code} preserves valid error metadata without classifying by message`, async (t) => {
    const message = `${unloadedMessage} (${status}/${code})`;
    const { client, fetch } = setup(t, async () => Response.json({
      code, message,
    }, { status }));
    await assert.rejects(client.getPlan('session'), (error: unknown) => {
      assert.ok(error instanceof IntentHttpError);
      assert.equal(error.status, status);
      assert.equal(error.code, typeof code === 'string' ? code : undefined);
      assert.equal(error.message, message);
      assert.equal(isSessionUnloadedError(error), false);
      return true;
    });
    assertOnlyPost(fetch, 'session/plan', { sessionId: 'session' });
    assert.equal((console.error as Mock<typeof console.error>).mock.callCount(), 1);
  });
}

test('unloaded classification distinguishes local guards, actual HTTP conflicts and unrelated failures', () => {
  const local = new SessionUnloadedError();
  assert.match(local.message, /会话.*未加载.*请先.*恢复/);
  assert.equal(isSessionUnloadedError(local), true);
  assert.equal(isSessionUnloadedError(new IntentHttpError(unloadedMessage, 409, 'SESSION_UNLOADED')), true);
  for (const error of [null, undefined, unloadedMessage, new Error(unloadedMessage), new TypeError(unloadedMessage)]) {
    assert.equal(isSessionUnloadedError(error), false);
  }
});

const failures: {
  name: string;
  respond: typeof globalThis.fetch;
  matches: (error: unknown) => boolean;
  diagnostic: RegExp;
}[] = [
  {
    name: 'rejected POST',
    respond: async () => { throw rejected; },
    matches: (error) => error === rejected,
    diagnostic: /Answer submission rejected$/,
  },
  {
    name: 'offline POST',
    respond: async () => { throw offline; },
    matches: (error) => error === offline,
    diagnostic: /Connection lost while answering$/,
  },
  {
    name: 'HTTP failure with a server error',
    respond: async () => Response.json({ error: 'Answer forbidden' }, { status: 403 }),
    matches: (error) => error instanceof IntentHttpError && error.status === 403
      && error.code === undefined && error.message === 'Answer forbidden',
    diagnostic: /Answer forbidden$/,
  },
  {
    name: 'HTTP failure without JSON',
    respond: async () => new Response('upstream unavailable', { status: 503 }),
    matches: (error) => error instanceof IntentHttpError && error.status === 503
      && error.code === undefined && error.message === 'intent respondAsk failed (503)',
    diagnostic: /intent respondAsk failed \(503\)$/,
  },
  {
    name: 'invalid acknowledgement schema',
    respond: async () => Response.json({ ok: 'true' }),
    matches: (error) => error instanceof Error && error.name === 'ZodError',
    diagnostic: /Expected boolean, received string/,
  },
  {
    name: 'successful HTTP response with invalid JSON',
    respond: async () => new Response('not JSON'),
    matches: (error) => error instanceof Error && error.name === 'ZodError',
    diagnostic: /Required/,
  },
];

for (const failure of failures) {
  test(`${failure.name} rejects with one local diagnostic, no retry and no prompt`, async (t) => {
    const { client, fetch, events } = setup(t, failure.respond);
    await assert.rejects(client.respondAsk('session', 'ask', 'answer', false), failure.matches);
    assertOnlyPost(fetch, 'respondAsk', {
      sessionId: 'session', requestId: 'ask', answer: 'answer', wasFreeform: false,
    });
    const diagnostics = getUxErrors();
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /^会话 session \(session\)：接口 respondAsk 调用失败：/);
    assert.match(diagnostics[0].message, failure.diagnostic);
    assert.deepEqual(events, []);
  });

  test(`prompt ${failure.name} rejects without retrying or losing its failure`, async (t) => {
    const { client, fetch, events } = setup(t, failure.respond);
    await assert.rejects(client.prompt('session', 'unsent draft', attachment, 'immediate'), (error: unknown) => {
      if (failure.name === 'HTTP failure without JSON') {
        return error instanceof Error && error.message === 'intent prompt failed (503)';
      }
      return failure.matches(error);
    });
    assertOnlyPost(fetch, 'prompt', {
      sessionId: 'session', text: 'unsent draft', attachment, mode: 'immediate',
    });
    const diagnostics = getUxErrors();
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /^会话 session \(session\)：接口 prompt 调用失败：/);
    assert.deepEqual(events, []);
  });
}

test('unsupported file rollback rejects without falling back to a destructive rewind', async (t) => {
  const { client, fetch, events } = setup(t, async () => Response.json({
    error: 'File rollback is unsupported',
  }, { status: 501 }));
  await assert.rejects(client.rewindSession('session', 'turn', true), {
    message: 'File rollback is unsupported',
  });
  assertOnlyPost(fetch, 'session/rewind', {
    sessionId: 'session', toMsgId: 'turn', rollbackFiles: true,
  });
  assert.deepEqual(events, []);
  assert.equal(getUxErrors().length, 1);
  assert.match(getUxErrors()[0].message, /^会话 session \(session\)：接口 session\/rewind 调用失败：File rollback is unsupported$/);
});

for (const [index, response] of [null, { error: { detail: 'unavailable' } }, 'unavailable'].entries()) {
  test(`history HTTP failure with non-error JSON ${index} preserves status and diagnostics`, async (t) => {
    const status = 500 + index;
    const { client, fetch } = setup(t, async () => Response.json(response, { status }));
    await assert.rejects(client.chat({ sessionId: 'session', ...chatRead }), { message: `intent session/chat failed (${status})` });
    assertOnlyPost(fetch, 'session/chat', { sessionId: 'session', ...chatRead });
    assert.equal(getUxErrors().length, 1);
    assert.match(getUxErrors()[0].message, /^会话 session \(session\)：接口 session\/chat 调用失败：intent session\/chat failed/);
  });
}

test('history transport failures are rethrown without diagnostics, retries or prompts', async (t) => {
  const failure = new TypeError('History connection lost');
  const { client, fetch } = setup(t, async () => { throw failure; });
  await assert.rejects(
    client.chat({ sessionId: 'session', ...chatRead, direction: 'forward', cursor: 'native-forward', max: 80 }),
    (error: unknown) => error === failure,
  );
  assertOnlyPost(fetch, 'session/chat', {
    sessionId: 'session', ...chatRead, direction: 'forward', cursor: 'native-forward', max: 80,
  });
  assert.deepEqual(getUxErrors(), []);
});

for (const failure of [
  {
    name: 'HTTP',
    respond: async () => Response.json({ error: 'History access denied' }, { status: 403 }),
    diagnostic: /History access denied$/,
  },
  {
    name: 'schema',
    respond: async () => Response.json({ ...chatPage, events: 'invalid' }),
    diagnostic: /Expected array, received string/,
  },
  {
    name: 'obsolete acknowledgement',
    respond: async () => Response.json({ ok: true }),
    diagnostic: /Required/,
  },
]) {
  test(`history ${failure.name} failures remain local diagnostics, without retries or prompts`, async (t) => {
    const { client, fetch } = setup(t, failure.respond);
    await assert.rejects(client.chat({ sessionId: 'session', ...chatRead, cursor: 'older-native', max: 40 }));
    assertOnlyPost(fetch, 'session/chat', {
      sessionId: 'session', ...chatRead, cursor: 'older-native', max: 40,
    });
    const diagnostics = getUxErrors();
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /^会话 session \(session\)：接口 session\/chat 调用失败：/);
    assert.match(diagnostics[0].message, failure.diagnostic);
  });
}

test('EventSource opening and reopening only update connection state, never POST', (t) => {
  const { instances, FakeEventSource } = mockEventSource(t);
  const { client, fetch, states, events } = setup(t, async () => {
    throw new Error('Opening EventSource must not POST');
  });
  client.connect();
  const [source] = instances;
  assert.ok(source);
  assert.equal(source.url, EVENTS_URL);
  assert.equal(source.withCredentials, true);
  assert.equal(client.isOpen, false);
  source.open();
  assert.equal(client.isOpen, true);

  source.readyState = FakeEventSource.CONNECTING;
  assert.ok(source.onerror);
  source.onerror();
  assert.equal(client.isOpen, false);
  source.open();
  assert.deepEqual(states, ['connecting', 'open', 'connecting', 'open']);
  assert.equal(instances.length, 1);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(events, []);
  assert.deepEqual(getUxErrors(), []);
  client.disconnect();
  assert.equal(source.readyState, FakeEventSource.CLOSED);
  assert.equal(client.userClosed, true);
});

const invalidated: ServerEvent = {
  type: 'chat/invalidated', sessionId: 'session', reason: 'rewind',
};

test('chat returns one HTTP native page independently of control SSE', async (t) => {
  const { instances } = mockEventSource(t);
  let resolve!: (response: Response) => void;
  const post = new Promise<Response>((yes) => { resolve = yes; });
  const { client, fetch, events } = setup(t, () => post);
  client.connect();
  const [source] = instances;
  assert.ok(source);
  source.open();

  let settled = false;
  const opts = { ...chatRead, direction: 'forward' as const, cursor: 'native-forward', max: 80 };
  const pending = client.chat({ sessionId: 'session', ...opts }).then((page) => {
    settled = true;
    return page;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(events, []);
  source.emit(invalidated);
  assert.equal(settled, false);
  resolve(Response.json({ ...chatPage, serverOnly: true }));
  assert.deepEqual(await pending, chatPage);
  assert.deepEqual(events, [invalidated]);
  assertOnlyPost(fetch, 'session/chat', { sessionId: 'session', ...opts });
  assert.deepEqual(getUxErrors(), []);
});

for (const opts of [chatRead, { ...chatRead, cursor: 'older-native', max: 40 }]) {
  test(`chat accepts bounded native pages without SSE (${JSON.stringify(opts)})`, async (t) => {
    const { client, fetch, events } = setup(t, async () => Response.json(chatPage));
    assert.deepEqual(await client.chat({ sessionId: 'session', ...opts }), chatPage);
    assertOnlyPost(fetch, 'session/chat', { sessionId: 'session', ...opts });
    assert.deepEqual(events, []);
    assert.deepEqual(getUxErrors(), []);
  });
}

test('passive reads return only native page fields without SSE or duplicate session metadata', async (t) => {
  const page = { ...chatPage, hasMore: true };
  const { client, fetch, events } = setup(t, async () => Response.json({
    ...page, title: 'Separate metadata', cwd: '/work/project', serverOnly: true,
  }));
  const opts = { ...chatRead, cursor: 'older-native', max: 20 };
  assert.deepEqual(await client.chat({ sessionId: 'session', ...opts }), page);
  assertOnlyPost(fetch, 'session/chat', { sessionId: 'session', ...opts });
  assert.deepEqual(events, []);
  assert.deepEqual(getUxErrors(), []);
});

for (const source of ['persisted', 'live'] as const) {
  test(`${source} rejects a page for another session with a local diagnostic`, async (t) => {
    const { client, fetch, events } = setup(t, async () => Response.json({
      ...chatPage, sessionId: 'other-session', title: 'Other', cwd: '/work/other',
    }));
    await assert.rejects(client.chat({ sessionId: 'session', ...chatRead, source }), {
      message: 'intent session/chat returned sessionId "other-session" instead of "session"',
    });
    assertOnlyPost(fetch, 'session/chat', { sessionId: 'session', ...chatRead, source });
    assert.deepEqual(events, []);
    assert.equal(getUxErrors().length, 1);
    assert.match(getUxErrors()[0].message, /returned sessionId "other-session" instead of "session"$/);
  });
}

const snapshot: Extract<ServerEvent, { type: 'snapshot' }> = {
  type: 'snapshot', permissionPolicy: 'allow-all', agentStatus: 'up', models: [],
  sessions: [{
    sessionId: 'session', title: 'Session', cwd: '/work/project', lastActivity: 1,
    status: 'idle', error: null, loaded: true, queue: [], ask: null,
  }],
};

test('SSE snapshots require allow-all and preserve optional lifecycle metadata', (t) => {
  const { instances } = mockEventSource(t);
  const { client, fetch, events } = setup(t, async () => {
    throw new Error('Snapshot must not POST');
  });
  const warn = t.mock.method(console, 'warn', () => {});
  client.connect();
  const [source] = instances;
  const withLifecycle: ServerEvent = {
    ...snapshot, sessions: [{ ...snapshot.sessions[0], loading: true, closing: false, cancelling: true }],
  };
  source.emit(snapshot);
  source.emit(withLifecycle);
  const patch: ServerEvent = {
    type: 'session/patch', sessionId: 'session', loading: false, closing: true, cancelling: false,
  };
  source.emit(patch);
  source.emit({ ...snapshot, permissionPolicy: undefined });
  source.emit({ ...snapshot, permissionPolicy: 'ask' });
  source.emit({ type: 'session/history-page', page: chatPage });
  source.emit({ type: 'session/reset', page: chatPage });
  source.emit(invalidated);
  assert.deepEqual(events, [snapshot, withLifecycle, patch, invalidated]);
  assert.equal(warn.mock.callCount(), 4);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(getUxErrors(), []);
});

for (const action of ['replace', 'disconnect', 'disconnect-and-connect'] as const) {
  test(`obsolete EventSource callbacks cannot affect state or events after ${action}`, (t) => {
    const { instances, FakeEventSource } = mockEventSource(t);
    const { client, fetch, states, events } = setup(t, async () => {
      throw new Error('Obsolete EventSource must not POST');
    });
    const warn = t.mock.method(console, 'warn', () => {});
    client.connect();
    const [source] = instances;
    source.open();
    const { onopen, onerror, onmessage } = source;
    assert.ok(onopen && onerror && onmessage);
    const close = source.close.bind(source);
    t.mock.method(source, 'close', () => {
      onopen();
      onerror();
      onmessage({ data: JSON.stringify(invalidated) });
      close();
    });

    if (action === 'replace') client.connect();
    else {
      client.disconnect();
      if (action === 'disconnect-and-connect') client.connect();
    }
    assert.equal(source.readyState, FakeEventSource.CLOSED);
    const current = instances[1];
    current?.open();
    const expectedStates: ConnState[] = action === 'disconnect'
      ? ['connecting', 'open'] : ['connecting', 'open', 'connecting', 'open'];
    assert.deepEqual(states, expectedStates);
    onopen();
    onerror();
    source.readyState = FakeEventSource.CONNECTING;
    onerror();
    onmessage({ data: JSON.stringify(snapshot) });
    onmessage({ data: JSON.stringify(invalidated) });
    onmessage({ data: '{"type":"invalid"}' });
    onmessage({ data: 'not JSON' });
    assert.deepEqual(states, expectedStates);
    assert.deepEqual(events, []);
    assert.equal(client.isOpen, action !== 'disconnect');
    assert.equal(client.userClosed, action === 'disconnect');
    assert.equal(instances.length, action === 'disconnect' ? 1 : 2);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
    current?.emit(invalidated);
    assert.deepEqual(events, current ? [invalidated] : []);
  });
}

test('a closed source cannot publish or reset reconnect backoff while awaiting replacement', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { instances, FakeEventSource } = mockEventSource(t);
  const { client, fetch, states, events } = setup(t, async () => {
    throw new Error('Reconnecting must not POST');
  });
  client.connect();
  const [source] = instances;
  source.open();
  source.readyState = FakeEventSource.CLOSED;
  assert.ok(source.onerror && source.onopen);
  source.onerror();
  source.onopen();
  source.onerror();
  source.emit(invalidated);
  assert.deepEqual(states, ['connecting', 'open', 'connecting']);
  assert.deepEqual(events, []);
  assert.equal(client.isOpen, false);

  t.mock.timers.tick(999);
  assert.equal(instances.length, 1);
  t.mock.timers.tick(1);
  assert.equal(instances.length, 2);
  const second = instances[1];
  second.readyState = FakeEventSource.CLOSED;
  assert.ok(second.onerror);
  second.onerror();
  t.mock.timers.tick(1699);
  assert.equal(instances.length, 2);
  t.mock.timers.tick(1);
  assert.equal(instances.length, 3);
  instances[2].open();
  instances[2].emit(invalidated);
  assert.equal(client.isOpen, true);
  assert.deepEqual(events, [invalidated]);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(getUxErrors(), []);
});

test('disconnect cancels a scheduled reconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { instances, FakeEventSource } = mockEventSource(t);
  const { client, fetch, states } = setup(t, async () => {
    throw new Error('Disconnect must not POST');
  });
  client.connect();
  const [source] = instances;
  source.readyState = FakeEventSource.CLOSED;
  assert.ok(source.onerror);
  source.onerror();
  client.disconnect();
  t.mock.timers.tick(8000);
  assert.deepEqual(states, ['connecting', 'connecting']);
  assert.equal(instances.length, 1);
  assert.equal(client.userClosed, true);
  assert.equal(client.isOpen, false);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const source of ['persisted', 'live'] as const) {
  test(`${source} chat validates against the SID serialized at request time even if the caller mutates its body`, async (t) => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((yes) => { resolve = yes; });
    const { client, fetch } = setup(t, () => response);
    const body = { sessionId: 'original', ...chatRead, source };
    const pending = client.chat(body);
    assertOnlyPost(fetch, 'session/chat', { sessionId: 'original', ...chatRead, source });
    body.sessionId = 'other';
    resolve(Response.json({ ...chatPage, sessionId: 'other' }));
    await assert.rejects(pending, /instead of "original"/);
  });
}
