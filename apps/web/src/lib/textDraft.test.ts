import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createSessionDrafts, getSessionDraft } from './textDraft';
import { dismissUxError, getUxErrors } from './errorReporter';

const key = (id: string) => `cockpit:chat-draft:${id}`;
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  return { values, storage, drafts: createSessionDrafts(storage) };
}

beforeEach(() => {
  mock.method(console, 'error', () => {});
  for (const error of getUxErrors()) dismissUxError(error.id);
});
afterEach(() => {
  mock.restoreAll();
  for (const error of getUxErrors()) dismissUxError(error.id);
});

test('each session has one in-memory draft and one compact tab-storage record', () => {
  const { drafts, values, storage } = fixture();
  const a = drafts('A'), b = drafts('B');
  assert.equal(drafts('A'), a);
  assert.equal(values.size, 0, 'opening an empty draft must not write a record');
  a.edit('  Native text\n');
  b.edit('Separate text');
  assert.deepEqual(JSON.parse(values.get(key('A'))!), { text: '  Native text\n', unconfirmed: false });
  assert.deepEqual(createSessionDrafts(storage)('A').getSnapshot(), {
    text: '  Native text\n', attachments: [], blocks: [], revision: 0, pending: false, unconfirmed: false,
  });
  a.edit('');
  assert.equal(values.has(key('A')), false);
  assert.equal(b.getSnapshot().text, 'Separate text');
  assert.equal(values.size, 1);
});

test('subscribers receive stable snapshots until an edit and can unsubscribe', () => {
  const draft = createSessionDrafts()('A');
  const before = draft.getSnapshot();
  assert.equal(draft.getSnapshot(), before);
  let changes = 0;
  const unsubscribe = draft.subscribe(() => { changes++; });
  draft.edit('Edited');
  assert.notEqual(draft.getSnapshot(), before);
  assert.equal(before.text, '');
  assert.equal(changes, 1);
  unsubscribe();
  draft.edit('Later');
  assert.equal(changes, 1);
});

test('accepted sends clear only their original draft and remove its storage record', async () => {
  const { drafts, values } = fixture();
  const draft = drafts('A');
  draft.edit('  Send once  ');
  let finish!: (value: boolean) => void;
  const sending = draft.send(text => {
    assert.equal(text, 'Send once');
    return new Promise(resolve => { finish = resolve; });
  });
  assert.equal(draft.getSnapshot().text, '  Send once  ');
  assert.equal(draft.getSnapshot().pending, true);
  assert.deepEqual(JSON.parse(values.get(key('A'))!), { text: '  Send once  ', unconfirmed: true });
  assert.equal(await draft.send(async () => assert.fail('Concurrent send')), false);
  assert.equal(await draft.runAction(async () => assert.fail('Concurrent decision')), false);
  finish(true);
  assert.equal(await sending, true);
  assert.deepEqual(draft.getSnapshot(), { text: '', attachments: [], blocks: [], revision: 2, pending: false, unconfirmed: false });
  assert.equal(values.has(key('A')), false);
});

for (const edited of ['New text', 'Original']) {
  test(`late ACK cannot erase a newer revision even if the text is ${edited}`, async () => {
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
    assert.equal(b.getSnapshot().text, 'Other session');
    assert.equal(createSessionDrafts(storage)('A').getSnapshot().text, edited);
  });
}

for (const failure of ['false', 'throw', 'undefined'] as const) {
  test(`an unconfirmed ${failure} outcome keeps edits, survives reload and never resends`, async () => {
    const { drafts, storage } = fixture();
    const draft = drafts('A');
    draft.edit('Keep this');
    let calls = 0;
    const sent = await draft.runAction(() => {
      calls++;
      if (failure === 'throw') throw new Error('Unknown outcome');
      return failure === 'undefined' ? undefined : Promise.resolve(false);
    });
    assert.equal(sent, false);
    assert.equal(calls, 1);
    assert.equal(draft.getSnapshot().text, 'Keep this');
    assert.equal(draft.getSnapshot().pending, false);
    assert.equal(draft.getSnapshot().unconfirmed, true);
    for (let reload = 0; reload < 2; reload++) {
      assert.equal(createSessionDrafts(storage)('A').getSnapshot().unconfirmed, true);
    }
    draft.dismissNotice();
    assert.equal(createSessionDrafts(storage)('A').getSnapshot().unconfirmed, false);
    assert.equal(calls, 1);
  });
}

test('reload converts an outstanding request to unknown without locking or replaying input', async () => {
  const { drafts, storage } = fixture();
  const draft = drafts('A');
  draft.edit('Submitting');
  let finish!: (value: boolean) => void;
  const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
  draft.edit('New unsent text');
  const restored = createSessionDrafts(storage)('A');
  assert.deepEqual(restored.getSnapshot(), {
    text: 'New unsent text', attachments: [], blocks: [], revision: 0, pending: false, unconfirmed: true,
  });
  finish(false);
  await sending;
  assert.equal(draft.getSnapshot().text, 'New unsent text');
});

test('a rejected text send retains the draft and releases the pending lock without retrying', async () => {
  const { drafts, storage } = fixture();
  const draft = drafts('A');
  draft.edit('Uncertain text');
  let calls = 0;
  assert.equal(await draft.send(async () => { calls++; throw new Error('Connection lost'); }), false);
  assert.equal(calls, 1);
  assert.deepEqual(createSessionDrafts(storage)('A').getSnapshot(), {
    text: 'Uncertain text', attachments: [], blocks: [], revision: 0, pending: false, unconfirmed: true,
  });
  assert.equal(await draft.send(async () => true), true);
  assert.equal(draft.getSnapshot().text, '');
  assert.equal(draft.getSnapshot().unconfirmed, false);
});

for (const accepted of [true, false]) {
  test(`separate and duplicated tabs cannot overwrite each other after ACK=${accepted}`, async () => {
    const a = fixture(), b = fixture(), fresh = fixture();
    a.drafts('same').edit('Tab A');
    let finish!: (value: boolean) => void;
    const sending = a.drafts('same').send(() => new Promise(resolve => { finish = resolve; }));
    // Duplicate Tab copies sessionStorage once; subsequent writes are independent.
    for (const [name, value] of a.values) b.values.set(name, value);
    const copied = b.drafts('same');
    assert.equal(copied.getSnapshot().unconfirmed, true);
    assert.equal(copied.getSnapshot().pending, false);
    copied.edit('Tab B newer');
    const storedB = b.values.get(key('same'));
    finish(accepted);
    assert.equal(await sending, accepted);
    assert.equal(b.values.get(key('same')), storedB);
    assert.equal(createSessionDrafts(b.storage)('same').getSnapshot().text, 'Tab B newer');
    assert.equal(createSessionDrafts(a.storage)('same').getSnapshot().text, accepted ? '' : 'Tab A');
    assert.equal(fresh.drafts('same').getSnapshot().text, '');
  });
}

test('blank sends do nothing, and decision ACKs never clear unrelated typed text', async () => {
  const { drafts, values } = fixture();
  const draft = drafts('A');
  assert.equal(await draft.send(async () => assert.fail('Empty send')), false);
  assert.equal(values.size, 0);
  draft.edit(' \n ');
  assert.equal(await draft.send(async () => assert.fail('Whitespace send')), false);
  draft.edit('Keep for later');
  assert.equal(await draft.runAction(async () => true), true);
  assert.equal(draft.getSnapshot().text, 'Keep for later');
  draft.edit('');
  assert.equal(await draft.runAction(async () => false), false);
  assert.deepEqual(JSON.parse(values.get(key('A'))!), { text: '', unconfirmed: true });
  draft.dismissNotice();
  assert.equal(values.has(key('A')), false);
});

test('malformed tab records stay untouched and report read failures', () => {
  for (const stored of ['', 'null', '[]', '{}', '{"text":1,"unconfirmed":false}', '{"text":"a","unconfirmed":"yes"}']) {
    const { values, drafts } = fixture();
    values.set(key('A'), stored);
    assert.equal(drafts('A').getSnapshot().text, '');
    assert.equal(values.get(key('A')), stored);
    assert.ok(getUxErrors().some(error => error.message.includes('无法读取标签页草稿')));
  }
});

test('storage errors are visible without disabling in-memory editing or sending', async () => {
  const draft = createSessionDrafts({
    getItem() { throw new Error('Read blocked'); },
    setItem() { throw new Error('Write blocked'); },
    removeItem() { throw new Error('Remove blocked'); },
  })('blocked');
  assert.ok(getUxErrors().some(error => error.message.includes('Read blocked')));
  draft.edit('Still usable');
  assert.equal(draft.getSnapshot().text, 'Still usable');
  assert.ok(getUxErrors().some(error => error.message.includes('Write blocked')));
  assert.equal(await draft.send(async () => true), true);
  assert.equal(draft.getSnapshot().text, '');
  assert.ok(getUxErrors().some(error => error.message.includes('Remove blocked')));
});

test('browser drafts use only the current sessionStorage key, with no other storage or identity access', async t => {
  const { storage, values } = fixture();
  const reads: string[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: {
      ...storage,
      getItem(name: string) { reads.push(name); return storage.getItem(name); },
    },
    get localStorage() { return assert.fail('Drafts must not access persistent or historical storage'); },
    get crypto() { return assert.fail('Drafts need no generated owner identity'); },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const draft = getSessionDraft('browser');
  assert.deepEqual(reads, [key('browser')]);
  assert.equal(values.size, 0);
  draft.edit('Tab-only text');
  assert.deepEqual(JSON.parse(values.get(key('browser'))!), { text: 'Tab-only text', unconfirmed: false });
  assert.equal(await draft.send(async () => true), true);
  assert.equal(values.size, 0);
});

test('module draft scopes enforce fields and ownership, expose cached readonly snapshots and revoke writes', () => {
  const draft = createSessionDrafts()('scoped');
  const a = draft.bindModule('A', ['attachments']);
  const b = draft.bindModule('B', ['text', 'attachments']);
  assert.equal(a.draft.sessionId, 'scoped');
  assert.equal(a.draft.getSnapshot(), a.draft.getSnapshot());
  assert.deepEqual(Object.keys(a.draft.getSnapshot()).sort(), ['attachments', 'blocks', 'pending', 'revision', 'text', 'unconfirmed']);
  assert.equal(a.draft.id, draft.reference.id);
  assert.throws(() => a.draft.editText('Denied'), /cannot write text/);
  a.draft.appendAttachments([{ id: 'one', value: { type: 'file', path: '/fixture/one' } }]);
  const snapshot = a.draft.getSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.attachments[0].value));
  assert.throws(() => b.draft.removeAttachment('one'), /another module/);
  assert.throws(() => b.draft.appendAttachments([{ id: 'one', value: { type: 'file', path: '/fixture/two' } }]), /another module/);
  assert.throws(() => a.draft.appendAttachments([{ id: 'bad', value: new File(['x'], 'x') as never }]));
  assert.equal(a.draft.getSnapshot(), snapshot, 'failed writes are atomic');
  const release1 = a.draft.block('Uploading one');
  const release2 = a.draft.block('Uploading two');
  assert.equal(draft.getSnapshot().blocks.length, 2);
  release1(); release1();
  assert.equal(draft.getSnapshot().blocks.length, 1);
  a.dispose();
  release2();
  assert.throws(() => a.draft.removeAttachment('one'), /cannot write/);
  assert.equal(draft.getSnapshot().blocks[0].orphaned, true);
  draft.dismissOrphanedBlock(draft.getSnapshot().blocks[0].id);
  assert.equal(draft.getSnapshot().blocks.length, 0);
  draft.removeAttachment('one');
  b.draft.editText('Allowed');
  assert.equal(draft.getSnapshot().text, 'Allowed');
});

test('attachment-only ACK preserves text revisions while scoped attachments remain immutable during native submission', async () => {
  const { drafts, storage } = fixture();
  const draft = drafts('files');
  const scope = draft.bindModule('files', ['attachments']);
  const attachment = (id: string, path = id) => ({ id, value: { type: 'file' as const, path: `/fixture/${path}` } });
  scope.draft.appendAttachments([attachment('same'), attachment('unchanged')]);
  let finish!: (sent: boolean) => void;
  const sending = draft.send((text, attachments) => {
    assert.equal(text, '');
    assert.equal(attachments?.length, 2);
    return new Promise(resolve => { finish = resolve; });
  });
  assert.throws(() => scope.draft.appendAttachments([attachment('same', 'replacement'), attachment('new')]), /pending native submission/);
  assert.throws(() => scope.draft.removeAttachment('unchanged'), /pending native submission/);
  draft.edit('Typed during upload');
  const reloaded = createSessionDrafts(storage)('files');
  assert.equal(reloaded.getSnapshot().pending, false);
  assert.equal(reloaded.getSnapshot().unconfirmed, true);
  assert.equal(reloaded.getSnapshot().attachments.length, 2);
  finish(true);
  assert.equal(await sending, true);
  assert.deepEqual(draft.getSnapshot().attachments.map(item => item.id), []);
  assert.equal(draft.getSnapshot().text, 'Typed during upload');
  scope.draft.appendAttachments([attachment('same', 'replacement'), attachment('new')]);
  assert.equal(await draft.send(async () => false), false);
  assert.equal(draft.getSnapshot().attachments.length, 2);
  assert.equal(await draft.send(async () => true), true);
  assert.equal(draft.getSnapshot().attachments.length, 0);
});

test('multiple per-session blocks gate native send and never serialize pending file objects', async () => {
  const { drafts, storage, values } = fixture();
  const a = drafts('A'), b = drafts('B');
  a.edit('Waiting');
  b.edit('Independent');
  const scope = a.bindModule('file-module', ['attachments']);
  const first = scope.draft.block('First upload');
  const second = scope.draft.block('Second upload failed; remove it to proceed');
  assert.equal(await a.send(async () => assert.fail('blocked')), false);
  first();
  assert.equal(await a.send(async () => assert.fail('still blocked')), false);
  assert.equal(await b.send(async () => true), true);
  assert.doesNotMatch(values.get(key('A'))!, /upload|blocks|File/);
  assert.equal(createSessionDrafts(storage)('A').getSnapshot().pending, false);
  second(); second();
  assert.equal(await a.send(async () => true), true);
});
