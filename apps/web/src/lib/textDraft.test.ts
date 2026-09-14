import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocumentDrafts, createSessionDrafts, getSessionDraft } from './textDraft';

function fixture(legacy?: Parameters<typeof createSessionDrafts>[1]) {
  const values = new Map<string, string>();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  } satisfies Pick<Storage, 'getItem' | 'setItem'>;
  const drafts = createSessionDrafts(storage, legacy);
  return { values, drafts, storage };
}

test('text drafts preserve old rich data and never import or overwrite its state', async () => {
  const { values, drafts } = fixture();
  const old = '{"version":1,"text":"old","attachment":{"url":"/uploads/retained"}}';
  values.set('cockpit:composer:A', old);
  const draft = drafts('A');
  assert.equal(draft.getSnapshot().text, '');
  draft.edit('Native text');
  assert.equal(await draft.send(async text => { assert.equal(text, 'Native text'); return true; }), true);
  assert.equal(values.get('cockpit:composer:A'), old);
  assert.equal(draft.getSnapshot().text, '');
});

test('a late native acknowledgement preserves newer edits and a different session draft', async () => {
  const { drafts } = fixture();
  const a = drafts('A'), b = drafts('B');
  a.edit('First');
  let acknowledge!: (accepted: boolean) => void;
  const pending = a.send(() => new Promise(resolve => { acknowledge = resolve; }));
  assert.equal(a.getSnapshot().pending, true);
  assert.equal(await a.send(async () => assert.fail('Concurrent send')), false);
  a.edit('Later');
  b.edit('Other session');
  acknowledge(true);
  assert.equal(await pending, true);
  assert.equal(a.getSnapshot().text, 'Later');
  assert.equal(b.getSnapshot().text, 'Other session');
  assert.equal(a.getSnapshot().pending, false);
});

test('unknown native submission retains text and never retries', async () => {
  const { drafts } = fixture();
  const draft = drafts('A');
  draft.edit('Keep this');
  let calls = 0;
  assert.equal(await draft.send(async () => { calls++; throw new Error('Unknown outcome'); }), false);
  assert.equal(calls, 1);
  assert.equal(draft.getSnapshot().text, 'Keep this');
  assert.ok(draft.getSnapshot().error);
});

test('same SID in independent tabs has independent pending, late ACK and failure writes', async () => {
  for (const accepted of [true, false]) {
    const a = fixture(), b = fixture();
    a.drafts('same').edit('Tab A');
    let finish!: (accepted: boolean) => void;
    const pending = a.drafts('same').send(() => new Promise(resolve => { finish = resolve; }));
    b.drafts('same').edit('Tab B newer');
    const storedB = b.values.get('cockpit:native-composer:same');
    finish(accepted);
    assert.equal(await pending, accepted);
    assert.equal(b.values.get('cockpit:native-composer:same'), storedB);
    assert.equal(createSessionDrafts(b.storage)('same').getSnapshot().text, 'Tab B newer');
    assert.equal(createSessionDrafts(a.storage)('same').getSnapshot().text, accepted ? '' : 'Tab A');
  }
});

test('tab storage recovers on reload and imports legacy localStorage read-only once', async () => {
  const old = JSON.stringify({ version: 1, text: 'Legacy text', pending: true });
  let reads = 0;
  const legacy = { getItem: () => { reads++; return old; } };
  const tab = fixture(legacy);
  const draft = tab.drafts('reload');
  assert.equal(draft.getSnapshot().text, 'Legacy text');
  assert.ok(draft.getSnapshot().error);
  assert.equal(tab.drafts('reload'), draft, 'same-document remount retains ownership');
  const reloaded = createSessionDrafts(tab.storage, legacy)('reload');
  assert.equal(reads, 1);
  assert.ok(reloaded.getSnapshot().error, 'unknown send survives multiple reloads');
  reloaded.edit('New tab-owned text');
  let finish!: (accepted: boolean) => void;
  const pending = reloaded.send(() => new Promise(resolve => { finish = resolve; }));
  const interrupted = createSessionDrafts(tab.storage, legacy)('reload');
  assert.equal(interrupted.getSnapshot().pending, false);
  assert.ok(interrupted.getSnapshot().error);
  assert.equal(interrupted.getSnapshot().text, 'New tab-owned text');
  finish(true);
  await pending;
  assert.equal(createSessionDrafts(tab.storage, legacy)('reload').getSnapshot().text, '');
  assert.equal(reads, 1, 'cleared tab draft must not re-import shared legacy text');
});

test('storage failures keep the in-document draft and submission usable', async t => {
  t.mock.method(console, 'error', () => {});
  const draft = createSessionDrafts({
    getItem() { throw null; },
    setItem() { throw new Error('Quota exceeded'); },
  })('blocked');
  draft.edit('Still here');
  assert.equal(draft.getSnapshot().text, 'Still here');
  assert.equal(await draft.send(async () => false), false);
  assert.equal(draft.getSnapshot().text, 'Still here');
  assert.ok(draft.getSnapshot().error);
});

test('the browser persists only document-owned localStorage records and never rewrites legacy drafts', async t => {
  const tab = fixture();
  const persistent = fixture();
  const shared = JSON.stringify({ version: 1, text: 'Shared legacy draft' });
  persistent.values.set('cockpit:native-composer:browser-owned', shared);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: tab.storage,
    localStorage: persistent.storage,
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const draft = getSessionDraft('browser-owned');
  assert.equal(draft.getSnapshot().text, 'Shared legacy draft');
  draft.edit('Owned by this tab');
  assert.equal(await draft.send(async () => true), true);
  assert.equal(persistent.values.get('cockpit:native-composer:browser-owned'), shared);
  const records = [...persistent.values].filter(([key]) => key.startsWith('cockpit:native-composer-document:'));
  assert.equal(records.length, 1);
  assert.deepEqual(JSON.parse(records[0][1]), {
    version: 1, text: '', pending: false,
  });
  assert.equal(createDocumentDrafts('browser-reload', persistent.storage, tab.storage)('browser-owned').getSnapshot().text, '');
});

test('duplicated tabs fork persisted ownership before pending, failure and late ACK writes', async () => {
  for (const accepted of [true, false]) {
    const persistent = fixture(), tabA = fixture(), tabB = fixture();
    const a = createDocumentDrafts('A', persistent.storage, tabA.storage)('same');
    a.edit('Tab A submitting');
    let finish!: (accepted: boolean) => void;
    const pending = a.send(() => new Promise(resolve => { finish = resolve; }));
    for (const [key, value] of tabA.values) tabB.values.set(key, value); // Browser Duplicate Tab.
    const b = createDocumentDrafts('B', persistent.storage, tabB.storage)('same');
    assert.ok(b.getSnapshot().error, 'inherited pending text is unconfirmed, not resent');
    b.edit('Tab B newer');
    const bPointer = tabB.values.get('cockpit:native-composer:same');
    const ownedB = [...persistent.values].find(([key]) => key.includes('"B"'));
    assert.ok(ownedB);
    finish(accepted);
    assert.equal(await pending, accepted);
    assert.equal(tabB.values.get('cockpit:native-composer:same'), bPointer);
    assert.equal(persistent.values.get(ownedB[0]), ownedB[1]);
    const reload = createDocumentDrafts('B-reload', persistent.storage, tabB.storage)('same');
    assert.equal(reload.getSnapshot().text, 'Tab B newer');
    assert.ok(reload.getSnapshot().error);
    assert.equal(persistent.values.get(ownedB[0]), ownedB[1], 'reload keeps predecessor records intact');
    const retained = [...persistent.values];
    const fresh = createDocumentDrafts('fresh-tab', persistent.storage, fixture().storage)('same');
    assert.equal(fresh.getSnapshot().text, '', 'a fresh tab does not silently choose another tab’s draft');
    for (const [key, value] of retained) assert.equal(persistent.values.get(key), value, 'closing a tab does not erase its persistent records');
  }
});

test('owned draft storage errors fall back to reloadable tab snapshots without losing in-page edits', t => {
  t.mock.method(console, 'error', () => {});
  const tab = fixture();
  const persistent = { getItem: () => null, setItem() { throw new Error('Persistent storage blocked'); } };
  const draft = createDocumentDrafts('blocked-local', persistent, tab.storage)('same');
  draft.edit('Recoverable in this tab');
  assert.equal(createDocumentDrafts('reload', persistent, tab.storage)('same').getSnapshot().text, 'Recoverable in this tab');
  const local = fixture();
  const blockedTab = { getItem: () => null, setItem() { throw null; } };
  const memory = createDocumentDrafts('blocked-tab', local.storage, blockedTab)('same');
  memory.edit('Still persistent');
  assert.equal(memory.getSnapshot().text, 'Still persistent');
  assert.ok([...local.values.values()].some(value => JSON.parse(value).text === 'Still persistent'));
});
