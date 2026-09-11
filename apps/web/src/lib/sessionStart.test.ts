import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { Attachment, IntentBody, ModuleSelection, SessionStartOperation } from '@cockpit/protocol';
import { NewSessionStart, type StartLock } from './sessionStart';
import { createKeyedAsync } from './keyedAsync';

const nativeId = '9682d20c-69c0-4dc9-9a51-a9c9e978c0f1';
const selected: ModuleSelection[] = [{ moduleId: 'task', roleId: 'commander', version: '1.2.0' }];
const file: Attachment = { kind: 'file', name: 'notes.txt', url: '/uploads/start-notes.txt', size: 4, mime: 'text/plain' };
const image: Attachment = { kind: 'image', name: 'image.png', url: '/uploads/start-image.png', size: 4, mime: 'image/png' };
const immediateLock: StartLock = async claim => claim();
function newStart(...args: ConstructorParameters<typeof NewSessionStart>) {
  return new NewSessionStart(args[0], args[1], args[2] ?? immediateLock);
}
function serialLock(): StartLock {
  let tail = Promise.resolve();
  return claim => {
    const next = tail.then(claim);
    tail = next.then(() => {}, () => {});
    return next;
  };
}
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const operation = (operationId: string, state: SessionStartOperation['state'] = 'accepted'): SessionStartOperation =>
  ({ operationId, sessionId: nativeId, state });

test('directory/role selection, empty send and cancel/reopen allocate no operation or native session', async () => {
  const storage = memoryStorage();
  let ids = 0, calls = 0;
  const start = newStart(storage, () => { ids++; return 'operation-0001'; });
  await start.configure('/workspace', selected);
  assert.equal(await start.send('/workspace', selected, async request => { calls++; return operation(request.operationId); }), false);
  const reopened = newStart(storage);
  assert.equal(reopened.getSnapshot().cwd, '/workspace');
  assert.deepEqual(reopened.getSnapshot().modules, selected);
  assert.equal(reopened.getSnapshot().attempt, undefined);
  assert.equal(ids, 0);
  assert.equal(calls, 0);
});

test('first real text and multiple retained files are sent once without any fake native session ID', async () => {
  const start = newStart(memoryStorage(), () => 'operation-0001');
  start.draft.edit('  first message \n');
  start.draft.addManagedAttachment(file);
  start.draft.addManagedAttachment(image);
  const bodies: IntentBody<'session/start'>[] = [];
  const sent = await start.send('/workspace', selected, async request => { bodies.push(request); return operation(request.operationId); });
  assert.equal(sent, true);
  assert.deepEqual(bodies, [{ operationId: 'operation-0001', cwd: '/workspace', modules: selected,
    text: 'first message', attachments: [file, image] }]);
  assert.equal('sessionId' in bodies[0], false);
  assert.equal(start.getSnapshot().attempt?.operation?.sessionId, nativeId);
  assert.equal(start.draft.getSnapshot().text, '');
  assert.equal(start.draft.getSnapshot().staged, undefined);
});

test('first file-only message works and a failed upload never starts native creation', async () => {
  const start = newStart(memoryStorage(), () => 'file-operation');
  start.draft.addManagedAttachment(file);
  const requests: IntentBody<'session/start'>[] = [];
  assert.equal(await start.send('/workspace', [], async request => { requests.push(request); return operation(request.operationId); }), true);
  assert.deepEqual(requests[0], { operationId: 'file-operation', cwd: '/workspace', text: '', attachment: file });
  const failed = newStart(memoryStorage());
  failed.draft.edit('keep caption');
  await failed.draft.addAttachment(new File(['test'], 'notes.txt'), async () => { throw new Error('upload failed'); });
  assert.equal(await failed.send('/workspace', [], async () => { assert.fail('failed upload must not create'); }), false);
  assert.equal(failed.getSnapshot().attempt, undefined);
  assert.equal(failed.draft.getSnapshot().text, 'keep caption');
});

test('uploads for the GUI first-message draft are explicitly unassociated', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ ...file, path: '/server/uploads/start-notes.txt' });
  });
  const start = newStart(memoryStorage());
  assert.equal(await start.draft.addAttachment(new File(['test'], 'notes.txt', { type: 'text/plain' })), true);
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0], 'https://cockpit.example').searchParams.has('sessionId'), false);
  assert.equal(urls[0].includes('gui-new-session'), false);
  assert.equal(start.getSnapshot().attempt, undefined);
});

test('double click and reopening a pending attempt never send again or allocate a new operation', async () => {
  const storage = memoryStorage();
  let ids = 0, calls = 0;
  const start = newStart(storage, () => { ids++; return 'pending-operation'; });
  start.draft.edit('real message');
  const response = deferred<SessionStartOperation>();
  const send = async () => { calls++; return response.promise; };
  const first = start.send('/workspace', selected, send);
  assert.equal(await start.send('/workspace', selected, send), false);
  const reopened = newStart(storage, () => { assert.fail('reopen cannot allocate an operation'); });
  assert.equal(reopened.getSnapshot().attempt?.request.operationId, 'pending-operation');
  assert.equal(await reopened.send('/workspace', selected, send), false);
  assert.equal(ids, 1); assert.equal(calls, 1);
  response.resolve(operation('pending-operation', 'unknown'));
  assert.equal(await first, false);
  assert.equal(start.draft.getSnapshot().text, 'real message');
});

test('competing tabs claim one operation and release the lock before the network response', { timeout: 5000 }, async () => {
  const storage = memoryStorage(), lock = serialLock();
  let ids = 0;
  const first = newStart(storage, () => { ids++; return 'first-tab-operation'; }, lock);
  const second = newStart(storage, () => { ids++; return 'second-tab-operation'; }, lock);
  first.draft.edit('first tab input');
  second.draft.edit('second tab input');
  const response = deferred<SessionStartOperation>();
  const calls: string[] = [];
  const send = async (request: IntentBody<'session/start'>) => {
    calls.push(request.operationId);
    return response.promise;
  };
  const sending = first.send('/first', selected, send);
  assert.equal(await second.send('/second', [], send), false);
  assert.deepEqual(calls, ['first-tab-operation']);
  assert.equal(ids, 1);
  assert.equal(second.getSnapshot().attempt?.request.operationId, 'first-tab-operation');
  assert.equal(second.draft.getSnapshot().text, 'second tab input');
  const reads: string[] = [];
  await second.read(async id => { reads.push(id); return operation(id, 'creating'); });
  assert.deepEqual(reads, ['first-tab-operation']);
  response.resolve(operation('first-tab-operation', 'unknown'));
  assert.equal(await sending, false);
});

test('stale configuration cannot overwrite another tab claim', async () => {
  const storage = memoryStorage(), lock = serialLock();
  const first = newStart(storage, () => 'claimed-operation', lock);
  const stale = newStart(storage, undefined, lock);
  first.draft.edit('real input');
  await first.send('/first', selected, async request => operation(request.operationId, 'unknown'));
  await stale.configure('/other', []);
  assert.equal(stale.getSnapshot().attempt?.request.operationId, 'claimed-operation');
  assert.equal(newStart(storage).getSnapshot().attempt?.request.operationId, 'claimed-operation');
});

test('browser Web Locks uses the shared exclusive claim name and fails closed if unavailable or rejected', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const lock = serialLock();
  const claims: { name: string; mode: string }[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    locks: { request: <T>(name: string, options: { mode: string }, claim: () => T) => {
      claims.push({ name, mode: options.mode });
      return lock(claim);
    } },
  } });
  const working = new NewSessionStart(memoryStorage(), () => 'browser-lock-operation');
  working.draft.edit('first input');
  assert.equal(await working.send('/workspace', [], async request => operation(request.operationId)), true);
  assert.deepEqual(claims, [
    { name: 'cockpit:new-session-start:v1', mode: 'exclusive' },
    { name: 'cockpit:new-session-start:v1', mode: 'exclusive' },
  ]);
  for (const navigator of [{}, { locks: { request() { throw new Error('lock denied'); } } }]) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
    let ids = 0;
    const start = new NewSessionStart(memoryStorage(), () => { ids++; return 'must-not-allocate'; });
    start.draft.edit('retain draft');
    assert.equal(await start.send('/workspace', [], async () => { assert.fail('unsafe ownership must not send'); }), false);
    assert.equal(ids, 0);
    assert.equal(start.getSnapshot().attempt, undefined);
    assert.match(start.getSnapshot().error ?? '', /Web Locks|lock denied/);
    assert.equal(start.draft.getSnapshot().text, 'retain draft');
  }
});

for (const result of ['unknown', 'creating', 'transport', 'mismatched'] as const) {
  test(`${result} response preserves exact draft/files and original operation without automatic retry`, async () => {
    const storage = memoryStorage();
    const start = newStart(storage, () => 'original-operation');
    start.draft.edit(' caption with whitespace \n');
    start.draft.addManagedAttachment(file);
    let calls = 0;
    const send = async (request: IntentBody<'session/start'>) => {
      calls++;
      if (result === 'transport') throw new TypeError('Failed to fetch');
      return result === 'mismatched' ? operation('other-operation')
        : { ...operation(request.operationId, result), error: 'module preparation or first message not confirmed' };
    };
    assert.equal(await start.send('/workspace', selected, send), false);
    await Promise.resolve();
    const restored = newStart(storage, () => { assert.fail('must retain original operation'); });
    assert.equal(restored.getSnapshot().attempt?.request.operationId, 'original-operation');
    assert.equal(restored.draft.getSnapshot().text, ' caption with whitespace \n');
    assert.equal(restored.draft.getSnapshot().staged?.attachment?.url, file.url);
    assert.equal(await restored.send('/workspace', selected, send), false);
    await assert.rejects(restored.newIndependent(), /不能/);
    assert.equal(calls, 1);
  });
}

test('passive readback can acknowledge the original operation after reload, never creating or prompting', async () => {
  const storage = memoryStorage(), start = newStart(storage, () => 'readback-operation');
  start.draft.edit('first text');
  start.draft.addManagedAttachment(file);
  await start.send('/workspace', selected, async () => { throw new Error('response lost'); });
  const restored = newStart(storage);
  const seen: string[] = [];
  await restored.read(async id => { seen.push(id); return null; });
  assert.equal(restored.draft.getSnapshot().text, 'first text');
  assert.equal(restored.getSnapshot().attempt?.request.operationId, 'readback-operation');
  await restored.read(async id => { seen.push(id); return operation(id); });
  assert.deepEqual(seen, ['readback-operation', 'readback-operation']);
  assert.equal(restored.draft.getSnapshot().text, '');
  assert.equal(restored.draft.getSnapshot().staged, undefined);
  assert.equal(restored.getSnapshot().attempt?.operation?.state, 'accepted');
});

test('passive acceptance cannot be downgraded by a late creating response or replaced with another session', async () => {
  const start = newStart(memoryStorage(), () => 'racing-operation');
  start.draft.edit('first input');
  const response = deferred<SessionStartOperation>();
  const sending = start.send('/workspace', [], async () => response.promise);
  await start.read(async id => operation(id));
  response.resolve(operation('racing-operation', 'creating'));
  assert.equal(await sending, true);
  assert.equal(start.getSnapshot().attempt?.operation?.state, 'accepted');
  await assert.rejects(start.read(async id => ({ ...operation(id), sessionId: '2d642111-c055-43d2-815b-5cae7525baba' })), /不同会话标识/);
  assert.equal(start.getSnapshot().attempt?.operation?.sessionId, nativeId);
});

test('cancelled passive read cannot acknowledge an unrelated or still-unconfirmed attempt', async () => {
  const start = newStart(memoryStorage(), () => 'cancelled-read-operation');
  start.draft.edit('retain original input');
  await start.send('/workspace', [], async request => operation(request.operationId, 'unknown'));
  const response = deferred<SessionStartOperation>();
  const abort = new AbortController();
  const reading = start.read(async () => response.promise, abort.signal);
  abort.abort();
  response.resolve(operation('cancelled-read-operation'));
  assert.equal(await reading, null);
  assert.equal(start.getSnapshot().attempt?.operation?.state, 'unknown');
  assert.equal(start.draft.getSnapshot().text, 'retain original input');
});

test('acknowledgement after reload preserves later same-text edits and re-added identical attachments', async () => {
  const storage = memoryStorage(), start = newStart(storage, () => 'revision-operation');
  start.draft.edit('submitted text');
  start.draft.addManagedAttachment(file);
  await start.send('/workspace', [], async () => { throw new Error('unknown'); });
  let restored = newStart(storage);
  restored.draft.edit('later text'); restored.draft.edit('submitted text');
  restored.draft.removeAttachment();
  restored.draft.addManagedAttachment(file);
  const latest = restored.draft.getSnapshot();
  restored = newStart(storage);
  await restored.read(async id => operation(id));
  assert.equal(restored.draft.getSnapshot().text, 'submitted text');
  assert.equal(restored.draft.getSnapshot().revision, latest.revision);
  assert.equal(restored.draft.getSnapshot().staged?.generation, latest.staged?.generation);
  assert.equal(restored.draft.getSnapshot().staged?.attachment?.url, file.url);
});

test('late success clears only the original unchanged draft and does not navigate from a cancelled route', async () => {
  const start = newStart(memoryStorage(), () => 'route-operation');
  start.draft.edit('first message'); start.draft.addManagedAttachment(file);
  const response = deferred<SessionStartOperation>();
  const connection = { connState: 'open', connectionGeneration: 1 };
  const view = createKeyedAsync<void>('first-message-creation', () => connection);
  let navigations = 0;
  view.activate();
  const sending = view.run(async () => { await start.send('/workspace', [], async () => response.promise); }, () => { navigations++; });
  view.deactivate();
  start.draft.edit('later user edit'); start.draft.addManagedAttachment(image);
  response.resolve(operation('route-operation'));
  await sending;
  assert.equal(navigations, 0);
  assert.equal(start.draft.getSnapshot().text, 'later user edit');
  assert.equal(start.draft.getSnapshot().staged?.attachment?.url, image.url);
  assert.equal(start.getSnapshot().attempt?.operation?.state, 'accepted');
});

test('new independent attempt is an explicit local transition only after acceptance, preserving later draft edits', async () => {
  const start = newStart(memoryStorage(), () => 'accepted-operation');
  start.draft.edit('first');
  await start.send('/workspace', [], async request => operation(request.operationId));
  start.draft.edit('next independent idea');
  await start.newIndependent();
  assert.equal(start.getSnapshot().attempt, undefined);
  assert.equal(start.draft.getSnapshot().text, 'next independent idea');
});

test('explicit archival releases an unknown planned ID into an empty independent draft without replay', async () => {
  const storage = memoryStorage();
  let ids = 0;
  const start = newStart(storage, () => `archival-operation-${++ids}`);
  start.draft.edit('original contents must not be replayed');
  start.draft.addManagedAttachment(file);
  const calls: IntentBody<'session/start'>[] = [];
  const submit = async (request: IntentBody<'session/start'>) => { calls.push(request); return operation(request.operationId, 'unknown'); };
  await start.send('/workspace', selected, submit);
  await start.read(async () => null);
  const oldDraft = start.draft;
  let confirmation = '';
  assert.equal(await start.archive('archival-operation-1', message => { confirmation = message; return true; }), true);
  assert.match(confirmation, /不取消后台请求、不删除服务器回执/);
  assert.match(confirmation, /不证明原生会话未创建或消息未提交/);
  assert.match(confirmation, /包括后来编辑的文字和暂存附件/);
  assert.equal(start.getSnapshot().attempt, undefined);
  assert.deepEqual(start.getSnapshot().modules, []);
  assert.notEqual(start.draft, oldDraft);
  assert.equal(start.draft.getSnapshot().text, '');
  assert.equal(start.draft.getSnapshot().staged, undefined);
  assert.equal(oldDraft.getSnapshot().text, '');
  assert.equal(oldDraft.getSnapshot().staged, undefined);
  assert.equal(start.getSnapshot().archives?.[0].operation?.sessionId, nativeId);
  assert.equal(ids, 1);
  assert.equal(calls.length, 1);
  const restored = newStart(storage, () => `archival-operation-${++ids}`);
  await restored.openNewForm();
  await restored.configure('/new-workspace', []);
  assert.equal(restored.draft.getSnapshot().text, '');
  assert.equal(await restored.send('/new-workspace', [], submit), false);
  restored.draft.edit('entirely new independent content');
  await restored.send('/new-workspace', [], submit);
  assert.deepEqual(calls[1], { operationId: 'archival-operation-2', cwd: '/new-workspace', text: 'entirely new independent content' });
  assert.equal(restored.getSnapshot().archives?.[0].operationId, 'archival-operation-1');
  assert.equal(restored.getSnapshot().archives?.[0].operation?.sessionId, nativeId);
});

test('archive cancellation, changed drafts and failed persistence do not discard the active attempt', async () => {
  const storage = memoryStorage();
  const start = newStart(storage, () => 'archive-cancel-operation');
  start.draft.edit('retain this');
  await start.send('/workspace', [], async request => operation(request.operationId, 'unknown'));
  const draft = start.draft;
  assert.equal(await start.archive('archive-cancel-operation', () => false), false);
  assert.equal(start.getSnapshot().archives, undefined);
  assert.equal(await start.archive('archive-cancel-operation', () => { draft.edit('later edit'); return true; }), false);
  assert.match(start.getSnapshot().error ?? '', /草稿已改变/);
  assert.equal(start.draft.getSnapshot().text, 'later edit');
  storage.setItem = () => { throw new Error('archive quota exhausted'); };
  assert.equal(await start.archive('archive-cancel-operation', () => true), false);
  assert.match(start.getSnapshot().error ?? '', /quota/);
  assert.equal(start.getSnapshot().attempt?.request.operationId, 'archive-cancel-operation');
  assert.equal(start.getSnapshot().archives, undefined);
  assert.equal(start.draft, draft);
  assert.equal(start.draft.getSnapshot().text, 'later edit');
});

test('late acceptance of an archived in-flight request updates only its history, never the new draft or navigation', async () => {
  const storage = memoryStorage(), lock = serialLock();
  const start = newStart(storage, () => 'archived-inflight-operation', lock);
  start.draft.edit('original');
  start.draft.addManagedAttachment(file);
  const response = deferred<SessionStartOperation>(), submitted = deferred<void>();
  const connection = { connState: 'open', connectionGeneration: 1 };
  const view = createKeyedAsync<void>('old-first-message-view', () => connection);
  view.activate();
  let navigations = 0;
  const sending = view.run(async () => {
    const accepted = await start.send('/workspace', [], async () => { submitted.resolve(); return response.promise; });
    if (!accepted) throw new Error('original attempt no longer owns the form');
  }, () => { navigations++; });
  await submitted.promise;
  const second = newStart(storage, () => 'independent-after-archive', lock);
  assert.equal(await second.archive('archived-inflight-operation', () => true), true);
  second.draft.edit('new message');
  second.draft.addManagedAttachment(image);
  await second.send('/different', [], async request => operation(request.operationId, 'unknown'));
  const independentDraft = second.draft.getSnapshot();
  response.resolve(operation('archived-inflight-operation'));
  await sending;
  assert.equal(navigations, 0);
  const restored = newStart(storage);
  assert.equal(restored.getSnapshot().attempt?.request.operationId, 'independent-after-archive');
  assert.equal(restored.getSnapshot().archives?.[0].operation?.state, 'accepted');
  assert.equal(restored.getSnapshot().archives?.[0].operation?.sessionId, nativeId);
  assert.equal(restored.draft.getSnapshot().text, independentDraft.text);
  assert.equal(restored.draft.getSnapshot().staged?.attachment?.url, image.url);
  assert.equal(restored.draft.getSnapshot().revision, independentDraft.revision);
});

test('archived readback is ID-bound and null, unknown, acceptance and mismatches never clear the independent draft', async () => {
  const storage = memoryStorage(), start = newStart(storage, () => 'archive-readback-operation');
  start.draft.edit('old');
  await start.send('/workspace', [], async request => operation(request.operationId, 'unknown'));
  await start.archive('archive-readback-operation', () => true);
  start.draft.edit('new unsent draft');
  start.draft.addManagedAttachment(image);
  const draft = start.draft.getSnapshot();
  const reads: string[] = [];
  await start.readArchived('archive-readback-operation', async id => { reads.push(id); return null; });
  assert.match(start.getSnapshot().archives?.[0].error ?? '', /不证明/);
  assert.equal(start.getSnapshot().archives?.[0].operation?.sessionId, nativeId);
  await assert.rejects(start.readArchived('archive-readback-operation', async () => operation('wrong-operation')), /标识不匹配/);
  await assert.rejects(start.readArchived('archive-readback-operation', async id => ({ ...operation(id),
    sessionId: '2d642111-c055-43d2-815b-5cae7525baba' })), /不同会话标识/);
  await start.readArchived('archive-readback-operation', async id => { reads.push(id); return operation(id); });
  await start.readArchived('archive-readback-operation', async id => operation(id, 'unknown'));
  assert.deepEqual(reads, ['archive-readback-operation', 'archive-readback-operation']);
  assert.equal(start.getSnapshot().archives?.[0].operation?.state, 'accepted');
  assert.equal(start.getSnapshot().attempt, undefined);
  assert.equal(start.draft.getSnapshot(), draft);
  assert.equal(newStart(storage).getSnapshot().archives?.[0].operation?.state, 'accepted');
});

test('readback started before archival can report the planned ID afterward without owning the blank form', async () => {
  const start = newStart(memoryStorage(), () => 'late-archive-read-operation');
  start.draft.edit('old contents');
  await start.send('/workspace', [], async () => { throw new Error('preflight response lost'); });
  const response = deferred<SessionStartOperation>();
  const reading = start.read(async () => response.promise);
  await start.archive('late-archive-read-operation', () => true);
  start.draft.edit('new contents');
  response.resolve(operation('late-archive-read-operation'));
  assert.equal(await reading, null);
  assert.equal(start.getSnapshot().attempt, undefined);
  assert.equal(start.getSnapshot().archives?.[0].operation?.sessionId, nativeId);
  assert.equal(start.getSnapshot().archives?.[0].operation?.state, 'accepted');
  assert.equal(start.draft.getSnapshot().text, 'new contents');
});

test('competing archive claims and stale old draft tabs cannot discard or resend the independent content', async () => {
  const storage = memoryStorage(), lock = serialLock();
  const first = newStart(storage, () => 'competing-archive-operation', lock);
  const stale = newStart(storage, () => { assert.fail('stale draft cannot allocate a new ID'); }, lock);
  first.draft.edit('original');
  await first.send('/workspace', [], async request => operation(request.operationId, 'unknown'));
  const second = newStart(storage, undefined, lock);
  const results = await Promise.all([
    first.archive('competing-archive-operation', () => true),
    second.archive('competing-archive-operation', () => true),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(newStart(storage).getSnapshot().archives?.length, 1);
  first.draft.edit('new independent message');
  stale.draft.edit('stale old message');
  assert.equal(await stale.send('/workspace', [], async () => { assert.fail('must not submit stale text'); }), false);
  assert.equal(stale.draft.getSnapshot().text, 'new independent message');
  assert.equal(newStart(storage).draft.getSnapshot().text, 'new independent message');
  assert.equal(await second.archive('competing-archive-operation', () => true), false);
  assert.equal(newStart(storage).draft.getSnapshot().text, 'new independent message');
});

test('archive cannot bypass missing Web Locks or recycle its old operation ID', async () => {
  const storage = memoryStorage(), start = newStart(storage, () => 'unchanged-archive-operation');
  start.draft.edit('old');
  await start.send('/workspace', [], async request => operation(request.operationId, 'unknown'));
  const unsafe = newStart(storage, undefined, async () => { throw new Error('archive lock denied'); });
  assert.equal(await unsafe.archive('unchanged-archive-operation', () => true), false);
  assert.match(unsafe.getSnapshot().error ?? '', /archive lock denied/);
  assert.equal(newStart(storage).getSnapshot().attempt?.request.operationId, 'unchanged-archive-operation');
  await start.archive('unchanged-archive-operation', () => true);
  start.draft.edit('new independent content');
  assert.equal(await start.send('/workspace', [], async () => { assert.fail('archived operation ID cannot be reused'); }), false);
  assert.match(start.getSnapshot().error ?? '', /复用归档 ID/);
  assert.equal(start.getSnapshot().attempt, undefined);
});

test('explicit global New opens an independent form after acceptance without clearing later edits/files', async () => {
  const start = newStart(memoryStorage(), () => 'accepted-new-operation');
  start.draft.edit('first input');
  await start.send('/workspace', selected, async request => operation(request.operationId));
  start.draft.edit('later input');
  start.draft.addManagedAttachment(image);
  const draft = start.draft.getSnapshot();
  await start.openNewForm();
  assert.equal(start.getSnapshot().attempt, undefined);
  assert.deepEqual(start.getSnapshot().modules, selected);
  assert.equal(start.draft.getSnapshot(), draft);
});

for (const state of ['creating', 'unknown', 'transport'] as const) {
  test(`explicit global New preserves the original ${state} attempt`, async () => {
    const start = newStart(memoryStorage(), () => 'unconfirmed-new-operation');
    start.draft.edit('first input');
    await start.send('/workspace', [], async request => {
      if (state === 'transport') throw new Error('response lost');
      return operation(request.operationId, state);
    });
    const draft = start.draft.getSnapshot();
    await start.openNewForm();
    assert.equal(start.getSnapshot().attempt?.request.operationId, 'unconfirmed-new-operation');
    assert.equal(start.draft.getSnapshot(), draft);
  });
}

test('a stale accepted tab cannot clear a newer unconfirmed attempt or resurrect its receipt', async () => {
  const storage = memoryStorage(), lock = serialLock();
  const first = newStart(storage, () => 'old-accepted-operation', lock);
  first.draft.edit('first input');
  await first.send('/workspace', [], async request => operation(request.operationId));
  const stale = newStart(storage, undefined, lock);
  const response = deferred<SessionStartOperation>();
  const reading = first.read(async () => response.promise);
  const second = newStart(storage, () => 'new-unknown-operation', lock);
  await second.openNewForm();
  second.draft.edit('second input');
  await second.send('/workspace', [], async request => operation(request.operationId, 'unknown'));
  await stale.openNewForm();
  assert.equal(stale.getSnapshot().attempt?.request.operationId, 'new-unknown-operation');
  assert.equal(first.getSnapshot().attempt?.request.operationId, 'old-accepted-operation');
  response.resolve(operation('old-accepted-operation'));
  assert.equal(await reading, null);
  assert.equal(newStart(storage).getSnapshot().attempt?.request.operationId, 'new-unknown-operation');
});

test('missing/unwritable or corrupt browser storage cannot trigger an untrackable native creation', async () => {
  const corrupt = memoryStorage();
  corrupt.setItem('cockpit:new-session-start:v1', '{not valid');
  for (const storage of [undefined, corrupt, { ...memoryStorage(), setItem() { throw new Error('quota'); } }]) {
    const start = newStart(storage);
    start.draft.edit('keep this');
    assert.equal(await start.send('/workspace', [], async () => { assert.fail('no durable record means no send'); }), false);
    assert.equal(start.draft.getSnapshot().text, 'keep this');
    assert.ok(start.getSnapshot().error || !storage);
  }
});

test('Web interactive creation uses first-message APIs and existing Composer, never directory-only creation or WeChat binding', () => {
  const picker = readFileSync(new URL('../components/DirPicker.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(picker, /<Composer draft=\{creation.draft\} onSend=\{send\} uploadFile=\{uploadFile\}/);
  assert.match(picker, /sendBlocked=\{!canStart\}/);
  assert.match(picker, /发送后创建；准备模块后处理这条消息/);
  assert.match(picker, /服务预留标识（可能尚未创建原生会话）/);
  assert.match(picker, /operation\?\.state === 'accepted'/);
  assert.match(picker, /放弃当前草稿并归档本地操作（不是重试）/);
  assert.match(picker, /creation\.archive\(attempt\.request\.operationId/);
  assert.match(picker, /creation\.readArchived\(operationId, onReadStart\)/);
  assert.match(picker, /first-message-creation:\$\{creation\.draft\.sessionId\}/);
  assert.match(app, /onStart=\{startSession\} onReadStart=\{getSessionStart\}/);
  assert.match(app, /const doNewSession = \(\) => \{\s*void getNewSessionStart\(\)\.openNewForm\(\);\s*setDirPicker\(true\);/);
  assert.doesNotMatch(picker, /onPick|session\/new|wechat\/bind|modules\/bind|在此创建/);
  assert.doesNotMatch(app, /onPick=\{newSession\}/);
});
