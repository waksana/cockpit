import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createSessionDrafts, getSessionDraft, resolveDraft } from './textDraft';
import { dismissUxError, getUxErrors } from './errorReporter';
import { memoryDraftStorage } from '../test/draftFixture';

const key = (id: string) => `cockpit:chat-draft:${id}`;
function fixture() {
  const memory = memoryDraftStorage();
  return { ...memory, drafts: createSessionDrafts(memory.storage) };
}
function saved(values: Map<string, string>, id: string) { return JSON.parse(values.get(key(id))!); }
beforeEach(() => {
  mock.method(console, 'error', () => {});
  for (const error of getUxErrors()) dismissUxError(error.id);
});
afterEach(() => {
  mock.restoreAll();
  for (const error of getUxErrors()) dismissUxError(error.id);
});

test('base drafts contain only text, generic content/leases and native submission state', () => {
  const { drafts, values, storage } = fixture();
  const a = drafts('A'), b = drafts('B');
  assert.equal(drafts('A'), a);
  assert.equal(values.size, 0);
  a.edit(' Native text\n');
  b.edit('Separate');
  assert.equal(saved(values, 'A').text, ' Native text\n');
  assert.equal(saved(values, 'A').unconfirmed, false);
  assert.deepEqual(saved(values, 'A').__cockpitDraft, { version: 1, purpose: { kind: 'prompt' } });
  assert.deepEqual(createSessionDrafts(storage)('A').getSnapshot(), {
    text: ' Native text\n', hasContent: true, blocks: [], revision: 0, pending: false, unconfirmed: false,
  });
  assert.equal('attachments' in a.getSnapshot(), false);
  assert.equal('appendAttachments' in a, false);
  assert.equal('removeAttachment' in a, false);
  a.edit('');
  assert.equal(values.has(key('A')), false);
  assert.equal(b.getSnapshot().text, 'Separate');
});

test('stable readonly references identify a draft lifetime and subscriptions release correctly', () => {
  const a = createSessionDrafts()('same'), b = createSessionDrafts()('same');
  assert.notEqual(a.reference.id, b.reference.id);
  assert.deepEqual(a.reference.purpose, { kind: 'prompt' });
  assert.equal(resolveDraft(a.reference), a);
  assert.throws(() => resolveDraft({ ...a.reference }), /reference/);
  const before = a.getSnapshot();
  assert.equal(a.getSnapshot(), before);
  assert.ok(Object.isFrozen(before));
  let changes = 0;
  const unsubscribe = a.subscribe(() => { changes++; });
  a.edit('Next');
  assert.equal(changes, 1);
  assert.equal(before.text, '');
  unsubscribe();
  a.edit('Later');
  assert.equal(changes, 1);
});

test('native ACK clears only the captured text revision and removes an otherwise empty record', async () => {
  const { drafts, values } = fixture();
  const draft = drafts('A');
  draft.edit('  Send once  ');
  let finish!: (value: boolean) => void;
  const sending = draft.send(request => {
    assert.deepEqual(request, { intent: 'prompt', body: { sessionId: 'A', text: 'Send once' } });
    assert.ok(Object.isFrozen(request.body));
    return new Promise(resolve => { finish = resolve; });
  });
  assert.equal(draft.getSnapshot().pending, true);
  assert.equal(saved(values, 'A').unconfirmed, true);
  assert.match(saved(values, 'A').__cockpitDraft.pendingToken, /^send-/);
  assert.equal(await draft.send(async () => assert.fail('Concurrent send')), false);
  assert.equal(await draft.runAction(async () => assert.fail('Concurrent action')), false);
  finish(true);
  assert.equal(await sending, true);
  assert.deepEqual(draft.getSnapshot(), { text: '', blocks: [], hasContent: false, revision: 2, pending: false, unconfirmed: false });
  assert.equal(values.has(key('A')), false);
});

for (const edited of ['New text', 'Original']) {
  test(`late ACK preserves a newer revision even if its text is ${edited}`, async () => {
    const { drafts, storage } = fixture();
    const a = drafts('A'), b = drafts('B');
    a.edit('Original');
    let finish!: (value: boolean) => void;
    const sending = a.send(() => new Promise(resolve => { finish = resolve; }));
    a.edit('Intermediate');
    a.edit(edited);
    b.edit('Other session');
    finish(true);
    assert.equal(await sending, true);
    assert.equal(a.getSnapshot().text, edited);
    assert.equal(createSessionDrafts(storage)('A').getSnapshot().text, edited);
    assert.equal(b.getSnapshot().text, 'Other session');
  });
}

for (const outcome of ['false', 'throw', 'undefined'] as const) {
  test(`unconfirmed ${outcome} retains text and never retries`, async () => {
    const { drafts, storage, values } = fixture();
    const draft = drafts('A');
    draft.edit('Keep');
    let calls = 0;
    assert.equal(await draft.runAction(() => {
      calls++;
      if (outcome === 'throw') throw new Error('Unknown native result');
      return outcome === 'undefined' ? undefined : Promise.resolve(false);
    }), false);
    assert.equal(calls, 1);
    assert.equal(draft.getSnapshot().text, 'Keep');
    assert.equal(draft.getSnapshot().pending, false);
    assert.equal(createSessionDrafts(storage)('A').getSnapshot().unconfirmed, true);
    assert.equal(saved(values, 'A').__cockpitDraft.pendingToken, undefined);
    draft.dismissNotice();
    assert.equal(createSessionDrafts(storage)('A').getSnapshot().unconfirmed, false);
    assert.equal(calls, 1);
  });
}

test('reload converts an outstanding checkpoint to unknown, never an in-flight request or automatic resend', async () => {
  const { drafts, storage } = fixture();
  const draft = drafts('A');
  draft.edit('Original');
  let finish!: (value: boolean) => void;
  const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
  draft.edit('Unsent revision');
  const restored = createSessionDrafts(storage)('A');
  assert.equal(restored.getSnapshot().text, 'Unsent revision');
  assert.equal(restored.getSnapshot().pending, false);
  assert.equal(restored.getSnapshot().unconfirmed, true);
  finish(false);
  assert.equal(await sending, false);
});

test('blank drafts do not send, while choice ACKs preserve unrelated typed text', async () => {
  const draft = createSessionDrafts()('A');
  assert.equal(await draft.send(async () => assert.fail('Empty')), false);
  draft.edit(' \n ');
  assert.equal(draft.getSnapshot().hasContent, false);
  assert.equal(await draft.send(async () => assert.fail('Blank')), false);
  draft.edit('Retained');
  assert.equal(await draft.runAction(async () => true), true);
  assert.equal(draft.getSnapshot().text, 'Retained');
});

test('unregistered legacy values and opaque schema namespaces survive text edits and sends but are never payloads', async () => {
  const { values, drafts } = fixture();
  const unknown = { attachments: Array.from({ length: 25 }, (_, index) => ({ opaque: index })),
    extra: { vendor: ['keep'] }, text: 'Old', unconfirmed: false,
    __cockpitDraft: { version: 1, purpose: { kind: 'prompt' }, schemas: { unknown: { future: true } } },
  };
  values.set(key('A'), JSON.stringify(unknown));
  const draft = drafts('A');
  draft.edit('New');
  assert.equal(await draft.send(async request => {
    assert.deepEqual(request.body, { sessionId: 'A', text: 'New' });
    return true;
  }), true);
  const record = saved(values, 'A');
  assert.deepEqual(record.attachments, unknown.attachments);
  assert.deepEqual(record.extra, unknown.extra);
  assert.deepEqual(record.__cockpitDraft.schemas, unknown.__cockpitDraft.schemas);
  assert.equal(draft.getSnapshot().hasContent, false);
  assert.equal(draft.getSnapshot().blocks.length, 0);
});

test('malformed base records/checkpoints stay untouched and fail explicitly rather than dispatching', async () => {
  for (const bytes of ['', 'null', '[]', '{}', '{"text":1,"unconfirmed":false}',
    '{"text":"a","unconfirmed":"yes"}', '{"text":"a","unconfirmed":false,"__cockpitDraft":{"version":99}}']) {
    const { values, drafts } = fixture();
    values.set(key('A'), bytes);
    const draft = drafts('A');
    draft.edit('Retained in memory');
    assert.equal(await draft.send(async () => assert.fail('Invalid checkpoint')), false);
    assert.equal(values.get(key('A')), bytes);
    assert.ok(getUxErrors().length > 0);
  }
});

test('persistence errors preserve memory edits and cannot claim a native send or ACK cleanup succeeded', async () => {
  const { storage, values } = memoryDraftStorage();
  let fail = true, calls = 0;
  const draft = createSessionDrafts({
    getItem: storage.getItem,
    setItem: (key, value) => { if (fail) throw new Error('Write blocked'); storage.setItem(key, value); },
    removeItem: key => { if (fail) throw new Error('Remove blocked'); storage.removeItem(key); },
  })('A');
  draft.edit('Usable memory');
  assert.equal(draft.getSnapshot().text, 'Usable memory');
  assert.equal(await draft.send(async () => { calls++; return true; }), false);
  assert.equal(calls, 0);
  fail = false;
  assert.equal(await draft.send(async () => { calls++; fail = true; return true; }), false);
  assert.equal(calls, 1);
  assert.equal(draft.getSnapshot().pending, false);
  assert.equal(draft.getSnapshot().unconfirmed, true);
  assert.equal(draft.getSnapshot().text, 'Usable memory');
  assert.ok(saved(values, 'A').__cockpitDraft.pendingToken);
});

test('module base bindings authorize only text/generic leases and dispose independently', () => {
  const draft = createSessionDrafts()('scoped');
  const a = draft.bindModule('A', []);
  const b = draft.bindModule('B', ['text']);
  assert.throws(() => a.draft.editText('Denied'), /cannot write/);
  assert.throws(() => a.draft.block('Denied'), /cannot block/);
  b.draft.editText('Allowed');
  const release = b.draft.block('Owned work');
  const other = draft.bindModule('C', ['text']);
  other.draft.block('Other work');
  b.dispose();
  release();
  assert.deepEqual(draft.getSnapshot().blocks.map(block => block.reason), ['Other work']);
  assert.throws(() => resolveDraft(b.draft), /revoked/);
  assert.throws(() => b.draft.editText('Late'), /cannot write/);
  other.dispose();
  assert.equal(draft.getSnapshot().blocks.length, 0);
});

test('generic leases gate only their captured draft and never serialize into native records', async () => {
  const { drafts, values } = fixture();
  const a = drafts('A'), b = drafts('B');
  a.edit('Waiting'); b.edit('Independent');
  const binding = a.bindModule('schema-module', [], undefined, () => true);
  const release = binding.draft.block('Module-owned work');
  assert.equal(await a.send(async () => assert.fail('Blocked')), false);
  assert.equal(await b.send(async () => true), true);
  assert.doesNotMatch(values.get(key('A'))!, /Module-owned|blocks/);
  binding.dispose();
  release();
  assert.equal(await a.send(async () => true), true);
});

test('browser draft creation has no persistent-storage or generated-device-identity dependency', async t => {
  const { storage } = fixture();
  const reads: string[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: { ...storage, getItem(name: string) { reads.push(name); return storage.getItem(name); } },
    get localStorage() { return assert.fail('No persistent device store'); },
    get crypto() { return assert.fail('No generated device identity'); },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const draft = getSessionDraft('browser');
  assert.deepEqual(reads, [key('browser'), 'cockpit:draft-requests:browser']);
  draft.edit('Tab text');
  assert.equal(await draft.send(async () => true), true);
});
