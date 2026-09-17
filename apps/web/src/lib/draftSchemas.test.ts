import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftSchemaRegistration } from '@cockpit/module-api';
import { RegisteredDraftSchema } from './draftSchemas';
import { SessionDraft } from './textDraft';
import { appendFixture, fixtureItem, fixtureSchema, memoryDraftStorage, type FixtureData } from '../test/draftFixture';

let generation = 0;
function install(draft: SessionDraft, definition = fixtureSchema(), moduleId = 'files', reports: unknown[] = []) {
  const schema = new RegisteredDraftSchema(`owner-${++generation}`, moduleId, definition, error => reports.push(error));
  schema.prepare(draft);
  schema.activate();
  return { schema, scope: schema.handle.forDraft(draft.reference)!, reports };
}
const namespace = (moduleId = 'files') => JSON.stringify([moduleId, 'fixture-data']);
const recordKey = 'cockpit:chat-draft:A';

test('typed schema scopes prepare once, expose immutable data, and are absent for nonapplicable purposes', () => {
  let created = 0;
  const draft = new SessionDraft('A');
  const schema = new RegisteredDraftSchema('owner', 'files', fixtureSchema({
    create: () => { created++; return { items: [] }; },
  }), assert.fail);
  assert.throws(() => schema.handle.forDraft(draft.reference), /not prepared/);
  assert.equal(created, 0, 'lookup does not initialize data during render');
  schema.prepare(draft); schema.prepare(draft); schema.activate();
  const scope = schema.handle.forDraft(draft.reference)!;
  assert.equal(schema.handle.forDraft(draft.reference), scope);
  assert.equal(created, 1);
  assert.equal(schema.handle.forDraft(new SessionDraft('A', undefined, { kind: 'ask', requestId: 'request' }).reference), undefined);
  appendFixture(scope, fixtureItem('one'));
  assert.ok(Object.isFrozen(scope.getSnapshot()));
  assert.ok(Object.isFrozen(scope.getSnapshot().items[0].value));
  assert.equal(draft.getSnapshot().hasContent, true);
  schema.dispose();
  assert.equal(draft.getSnapshot().hasContent, false);
  assert.throws(() => scope.update(value => value), /stopped/);
  assert.throws(() => schema.handle.forDraft(draft.reference), /stopped/);
});

test('field-only native sends use explicit projection and ACK only captured unchanged records', async () => {
  const { storage, values } = memoryDraftStorage();
  const draft = new SessionDraft('A', storage);
  const { schema, scope } = install(draft);
  appendFixture(scope, fixtureItem('same'), fixtureItem('unchanged'));
  let finish!: (ack: boolean) => void;
  const sending = draft.send(request => {
    assert.equal(request.intent, 'prompt');
    if (request.intent !== 'prompt') return assert.fail('Wrong route');
    assert.equal(request.body.text, '');
    assert.deepEqual(request.body.attachments?.map(value => value.type === 'file' ? value.path : ''), ['/fixture/same', '/fixture/unchanged']);
    assert.equal(draft.getSnapshot().pending, true);
    return new Promise(resolve => { finish = resolve; });
  });
  appendFixture(scope, fixtureItem('same', 'replacement'), fixtureItem('new'));
  draft.edit('New text revision');
  finish(true);
  assert.equal(await sending, true);
  assert.deepEqual(scope.getSnapshot().items.map(item => item.id), ['same', 'new']);
  assert.equal(draft.getSnapshot().text, 'New text revision');
  assert.equal(JSON.parse(values.get(recordKey)!).__cockpitDraft.pendingToken, undefined);
  schema.dispose();
});

for (const outcome of ['false', 'throw', 'undefined'] as const) {
  test(`native ${outcome} never ACKs schema data or automatically retries`, async () => {
    const draft = new SessionDraft('A', undefined, undefined, undefined, () => {});
    const { scope, schema } = install(draft);
    appendFixture(scope, fixtureItem('one'));
    const before = scope.getSnapshot();
    let calls = 0;
    assert.equal(await draft.send(async () => {
      calls++;
      if (outcome === 'throw') throw new Error('Unknown native result');
      return outcome === 'false' ? false : undefined as unknown as boolean;
    }), false);
    assert.equal(scope.getSnapshot(), before);
    assert.equal(draft.getSnapshot().unconfirmed, true);
    assert.equal(calls, 1);
    schema.dispose();
  });
}

test('module-owned legacy restore persists an empty tombstone and never reimports consumed legacy values', async () => {
  const { storage, values } = memoryDraftStorage();
  const legacy = [fixtureItem('legacy')];
  values.set(recordKey, JSON.stringify({ text: '', unconfirmed: false, attachments: legacy, vendor: { keep: 'opaque' } }));
  const first = new SessionDraft('A', storage);
  assert.equal(first.getSnapshot().hasContent, false, 'base never interprets legacy file data');
  const owner = install(first);
  assert.equal(owner.scope.getSnapshot().items.length, 1);
  assert.equal(await first.send(async () => true), true);
  owner.schema.dispose();
  const stored = JSON.parse(values.get(recordKey)!);
  assert.deepEqual(stored.attachments, legacy);
  assert.deepEqual(stored.vendor, { keep: 'opaque' });
  assert.equal(stored.__cockpitDraft.schemas[namespace()], '{"items":[]}');
  const restored = new SessionDraft('A', storage);
  assert.equal(restored.getSnapshot().hasContent, false);
  const next = install(restored);
  assert.deepEqual(next.scope.getSnapshot().items, []);
  next.schema.dispose();
});

test('inactive schema bytes and active peer data survive module loss and plain-text sends', async () => {
  const { storage, values } = memoryDraftStorage();
  const draft = new SessionDraft('A', storage);
  const files = install(draft);
  const peer = install(draft, fixtureSchema({ hasContent: () => false, project: () => undefined }), 'peer');
  appendFixture(files.scope, fixtureItem('file'));
  appendFixture(peer.scope, fixtureItem('peer-data'));
  const before = JSON.parse(values.get(recordKey)!).__cockpitDraft.schemas;
  files.schema.dispose();
  draft.edit('Plain text');
  assert.equal(await draft.send(async request => {
    assert.deepEqual(request.body, { sessionId: 'A', text: 'Plain text' });
    return true;
  }), true);
  assert.deepEqual(peer.scope.getSnapshot().items.map(item => item.id), ['peer-data']);
  assert.deepEqual(JSON.parse(values.get(recordKey)!).__cockpitDraft.schemas, before);
  assert.equal(draft.getSnapshot().blocks.length, 0);
  peer.schema.dispose();
});

test('validation, serialization and storage errors leave prior field data and bytes unchanged', () => {
  const memory = memoryDraftStorage();
  let writeFails = false, serializeFails = false, validateFails = false;
  const reports: unknown[] = [];
  const draft = new SessionDraft('A', {
    ...memory.storage, setItem(key, value) {
      if (writeFails) throw new Error('Storage failed');
      memory.storage.setItem(key, value);
    },
  });
  const { schema, scope } = install(draft, fixtureSchema({
    validate(value) {
      if (validateFails) throw new Error('Validation failed');
      return value as FixtureData;
    },
    persistence: {
      serialize(value) { if (serializeFails) return undefined as unknown as string; return JSON.stringify(value); },
      restore: () => ({ items: [] }),
    },
  }), 'files', reports);
  appendFixture(scope, fixtureItem('before'));
  const snapshot = scope.getSnapshot(), bytes = memory.values.get(recordKey);
  for (const failure of ['validate', 'serialize', 'storage']) {
    validateFails = failure === 'validate'; serializeFails = failure === 'serialize'; writeFails = failure === 'storage';
    assert.throws(() => appendFixture(scope, fixtureItem('after')));
    assert.equal(scope.getSnapshot(), snapshot, failure);
    assert.equal(memory.values.get(recordKey), bytes, failure);
  }
  assert.equal(reports.length, 3);
  schema.dispose();
});

test('invalid stored values and asynchronous factories fail explicitly without empty-state fallback', async () => {
  const { storage, values } = memoryDraftStorage();
  values.set(recordKey, JSON.stringify({ text: 'Keep', unconfirmed: false,
    __cockpitDraft: { version: 1, purpose: { kind: 'prompt' }, schemas: { [namespace()]: 'not JSON' } } }));
  const before = values.get(recordKey);
  const draft = new SessionDraft('A', storage);
  const invalid = new RegisteredDraftSchema('owner', 'files', fixtureSchema(), () => {});
  assert.throws(() => invalid.prepare(draft));
  assert.equal(draft.getSnapshot().text, 'Keep');
  assert.equal(values.get(recordKey), before);
  invalid.dispose();
  const asyncSchema = new RegisteredDraftSchema('async', 'async', fixtureSchema({
    create: (async () => ({ items: [] })) as never,
  }), () => {});
  assert.throws(() => asyncSchema.prepare(new SessionDraft('B')), /synchronous/);
  asyncSchema.dispose();
});

for (const projection of [{ text: 'overwrite' }, { sessionId: 'other' }, { mode: 'immediate' }, { unexpected: true }]) {
  test(`reserved/unsupported projection ${Object.keys(projection)[0]} fails before native dispatch`, async () => {
    const errors: unknown[] = [];
    const draft = new SessionDraft('A', undefined, undefined, undefined, error => errors.push(error));
    const owner = install(draft, fixtureSchema({ project: () => projection as never }));
    appendFixture(owner.scope, fixtureItem('one'));
    draft.edit('Core text');
    let native = 0;
    assert.equal(await draft.send(async () => { native++; return true; }), false);
    assert.equal(native, 0);
    assert.equal(draft.getSnapshot().pending, false);
    assert.equal(owner.scope.getSnapshot().items.length, 1);
    assert.ok(errors.length > 0);
    owner.schema.dispose();
  });
}

test('peer field collisions are errors, not last-writer precedence', async () => {
  const draft = new SessionDraft('A', undefined, undefined, undefined, () => {});
  const a = install(draft, fixtureSchema(), 'a'), b = install(draft, fixtureSchema(), 'b');
  appendFixture(a.scope, fixtureItem('a')); appendFixture(b.scope, fixtureItem('b'));
  assert.equal(await draft.send(async () => assert.fail('Conflicting fields must not dispatch')), false);
  assert.equal(a.scope.getSnapshot().items.length, 1);
  assert.equal(b.scope.getSnapshot().items.length, 1);
  a.schema.dispose(); b.schema.dispose();
});

test('schema generation replacement during a native send cannot receive an old ACK', async () => {
  const errors: unknown[] = [];
  const { storage } = memoryDraftStorage();
  const draft = new SessionDraft('A', storage, undefined, undefined, error => errors.push(error));
  const old = install(draft);
  appendFixture(old.scope, fixtureItem('old'));
  let finish!: (ack: boolean) => void;
  const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
  old.schema.dispose();
  const replacement = install(draft);
  replacement.scope.update(() => ({ items: [fixtureItem('replacement')] }));
  const before = replacement.scope.getSnapshot();
  finish(true);
  assert.equal(await sending, false, 'local stale ACK is not represented as successful cleanup');
  assert.equal(replacement.scope.getSnapshot(), before);
  assert.equal(draft.getSnapshot().unconfirmed, true);
  assert.ok(errors.some(error => String(error).includes('generation')));
  replacement.schema.dispose();
});

test('pure schema hooks cannot mutate base state, and content hints without projections cannot send blank native input', async () => {
  const draft = new SessionDraft('A', undefined, undefined, undefined, () => {});
  const owner = install(draft, fixtureSchema({ project: () => { draft.edit('Illegal hook edit'); return undefined; } }));
  appendFixture(owner.scope, fixtureItem('one'));
  assert.equal(await draft.send(async () => assert.fail('Impure projection')), false);
  assert.equal(draft.getSnapshot().text, '');
  owner.schema.dispose();
  const hint = install(draft, fixtureSchema({ project: () => undefined }));
  appendFixture(hint.scope, fixtureItem('hint'));
  assert.equal(draft.getSnapshot().hasContent, true);
  assert.equal(await draft.send(async () => assert.fail('No native content')), false);
  hint.schema.dispose();
});

test('native choice actions never project or ACK draft fields', async () => {
  const draft = new SessionDraft('A', undefined, { kind: 'ask', requestId: 'ask' });
  const hooks: string[] = [];
  const definition: DraftSchemaRegistration<FixtureData> = fixtureSchema({
    purposes: ['ask'], project: () => { hooks.push('project'); return undefined; },
    acknowledge: current => { hooks.push('ack'); return current; },
  });
  const owner = install(draft, definition);
  appendFixture(owner.scope, fixtureItem('not-choice-data'));
  draft.edit('Unsubmitted freeform answer');
  assert.equal(await draft.runAction(async () => true), true);
  assert.deepEqual(hooks, []);
  assert.equal(draft.getSnapshot().text, 'Unsubmitted freeform answer');
  assert.equal(owner.scope.getSnapshot().items.length, 1);
  owner.schema.dispose();
});
