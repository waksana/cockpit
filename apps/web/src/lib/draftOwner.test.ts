import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftOwnerFacts, DraftOwnerOptions, DraftTransportOutcome } from '@cockpit/module-api/frontend';
import { createDraftOwner, draftRecord, SessionDraft, type DraftStorage } from './textDraft';
import { RegisteredDraftSchema } from './draftSchemas';
import { appendFixture, fixtureItem, fixtureSchema, memoryDraftStorage } from '../test/draftFixture';

interface Request { requestId: string; text: string; actionRevision: number; attachments?: unknown }
interface Receipt { requestId: string }
const initial: DraftOwnerFacts = { editable: true, submittable: true, actionRevision: 0, capabilities: { attachments: true } };
function request(value: unknown): Request {
  if (!draftRecord(value) || typeof value.requestId !== 'string' || typeof value.text !== 'string'
    || !Number.isSafeInteger(value.actionRevision)
    || Object.keys(value).some(key => !['requestId', 'text', 'actionRevision', 'attachments'].includes(key))) throw new Error('Invalid saved request');
  return { requestId: value.requestId, text: value.text, actionRevision: Number(value.actionRevision),
    ...(Object.hasOwn(value, 'attachments') ? { attachments: value.attachments } : {}) };
}
function receipt(value: unknown): Receipt {
  if (!draftRecord(value) || typeof value.requestId !== 'string' || Object.keys(value).length !== 1) throw new Error('Invalid receipt');
  return { requestId: value.requestId };
}
function fixture(overrides: Partial<DraftOwnerOptions<Request, Receipt>> = {}, storage?: DraftStorage) {
  const memory = memoryDraftStorage(), sent: Request[] = [], inspected: Request[] = [], errors: unknown[] = [];
  const options: DraftOwnerOptions<Request, Receipt> = {
    key: 'inbox', purpose: { kind: 'prompt' }, facts: initial,
    prepare: snapshot => {
      if (Object.keys(snapshot.fields).some(key => key !== 'attachments')) throw new Error('Unsupported fields');
      return { requestId: snapshot.id, text: snapshot.text, actionRevision: snapshot.base.actionRevision, ...snapshot.fields };
    },
    validateRequest: request, validateReceipt: receipt,
    send: async value => { sent.push(value); return { status: 'accepted', receipt: { requestId: value.requestId } }; },
    inspect: async value => { inspected.push(value); return { status: 'accepted', receipt: { requestId: value.requestId } }; },
    ...overrides,
  };
  return { ...memory, ...createDraftOwner(options, storage ?? memory.storage, 'owner:inbox', error => errors.push(error)),
    options, sent, inspected, errors };
}
function schema(f: ReturnType<typeof fixture>, acknowledge = fixtureSchema().acknowledge) {
  const registration = new RegisteredDraftSchema('files-generation', 'files', fixtureSchema({ acknowledge }), error => f.errors.push(error));
  registration.prepare(f.core); registration.activate();
  return { registration, scope: registration.handle.forDraft(f.owner.reference)! };
}
const accepted = (value: Request): DraftTransportOutcome<Receipt> => ({ status: 'accepted', receipt: { requestId: value.requestId } });

test('generic owner uses one core and persists complete immutable transaction before send', async () => {
  const f = fixture({ send: async value => {
    assert.equal('sessionId' in f.owner.reference, false);
    assert.ok(Object.isFrozen(value));
    const saved = JSON.parse(f.values.get('owner:inbox')!).__cockpitDraft;
    assert.equal(saved.transaction.request.requestId, value.requestId);
    assert.equal(saved.transaction.base.text, ' hello ');
    assert.equal(saved.transaction.status, 'prepared');
    assert.equal(saved.pendingToken, value.requestId);
    assert.equal(saved.transaction.occurrence, saved.occurrence);
    assert.equal(saved.transaction.fields[0].namespace, '["files","fixture-data"]');
    return accepted(value);
  } });
  const s = schema(f);
  f.owner.editText(' hello ');
  appendFixture(s.scope, fixtureItem('A'));
  assert.deepEqual(await f.owner.submit(), { status: 'acknowledged' });
  assert.equal(f.owner.reference.getSnapshot().text, '');
  assert.equal(s.scope.getSnapshot().items.length, 0);
  const transaction = JSON.parse(f.values.get('owner:inbox')!).__cockpitDraft.transaction;
  assert.equal(transaction.status, 'settled');
  assert.equal(transaction.textSettled, true);
  assert.equal(transaction.ownerSettled, true);
  assert.deepEqual(transaction.acknowledged, ['["files","fixture-data"]']);
});

test('button and independently authorized captured module submission enter the same adapter', async () => {
  const f = fixture();
  const denied = f.core.bindModule('writer', ['text']);
  assert.throws(() => denied.draft.captureSend(), /cannot send/);
  const binding = f.core.bindModule('speech', ['text'], undefined, undefined, { check: () => undefined });
  binding.draft.editText('provisional');
  const intent = binding.draft.captureSend();
  binding.draft.editText('final');
  const sending = intent.send(binding.draft.getSnapshot().revision);
  assert.equal(intent.send(-1), sending);
  assert.deepEqual(await sending, { status: 'acknowledged' });
  f.owner.editText('button');
  assert.deepEqual(await f.owner.submit(), { status: 'acknowledged' });
  assert.deepEqual(f.sent.map(value => value.text), ['final', 'button']);
});

for (const kind of ['action', 'action-ABA', 'writer', 'field', 'retire', 'suspend'] as const) {
  test(`captured consent does not follow ${kind} changes`, async () => {
    const f = fixture(), s = schema(f);
    const binding = f.core.bindModule('speech', ['text'], undefined, undefined, { check: () => undefined });
    binding.draft.editText('capture');
    const intent = binding.draft.captureSend();
    if (kind === 'action' || kind === 'action-ABA') {
      f.owner.update({ ...initial, actionRevision: 1 });
      if (kind === 'action-ABA') {
        assert.throws(() => f.owner.update(initial), /backwards/);
        f.owner.update({ ...initial, actionRevision: 2 });
      }
    } else if (kind === 'writer') f.owner.editText('changed');
    else if (kind === 'field') appendFixture(s.scope, fixtureItem('late'));
    else if (kind === 'retire') f.owner.retire();
    else f.core.suspend();
    assert.equal((await intent.send(binding.draft.getSnapshot().revision)).status, 'blocked');
    assert.equal(f.sent.length, 0);
  });
}

for (const kind of ['readonly', 'unavailable', 'attachments', 'block', 'empty'] as const) {
  test(`owner facts enforce ${kind} without relying on presentation props`, async () => {
    const f = fixture(), s = schema(f);
    if (kind !== 'empty') f.owner.editText('text');
    if (kind === 'readonly') f.owner.update({ ...initial, editable: false });
    if (kind === 'unavailable') f.owner.update({ ...initial, submittable: false });
    if (kind === 'attachments') { appendFixture(s.scope, fixtureItem('A')); f.owner.update({ ...initial, capabilities: { attachments: false } }); }
    if (kind === 'block') f.core.bindModule('peer', ['text']).draft.block('uploading');
    assert.equal((await f.owner.submit()).status, 'blocked');
    assert.equal(f.sent.length, 0);
  });
}

test('owner facts expose bounded copied reference context and no target route', () => {
  const f = fixture();
  f.owner.update({ ...initial, referenceText: '😀'.repeat(1001) });
  assert.equal([...f.owner.reference.getSnapshot().referenceText!].length, 1000);
  assert.equal('topicId' in f.owner.reference, false);
  assert.equal('sessionId' in f.owner.reference, false);
});

for (const failure of ['request', 'validator-strips', 'receipt', 'storage'] as const) {
  test(`durable ${failure} failures never masquerade as success`, async () => {
    const memory = memoryDraftStorage();
    const f = fixture({
      ...(failure === 'request' ? { prepare: () => ({ requestId: 'id', text: 'x', actionRevision: NaN }) } : {}),
      ...(failure === 'validator-strips' ? { validateRequest: value => ({ ...request(value), text: 'stripped' }) } : {}),
      ...(failure === 'receipt' ? { validateReceipt: () => { throw new Error('Invalid receipt'); } } : {}),
    }, failure === 'storage' ? { ...memory.storage, setItem: () => { throw new Error('Quota exhausted'); } } : undefined);
    f.owner.editText('keep');
    assert.equal((await f.owner.submit()).status, failure === 'receipt' ? 'unconfirmed' : 'blocked');
    assert.equal(f.sent.length, failure === 'receipt' ? 1 : 0);
    assert.ok(f.errors.length);
    assert.equal(f.owner.reference.getSnapshot().text, 'keep');
  });
}

test('prepare and pending-publication reentrancy cannot change the captured action or text', async () => {
  for (const phase of ['prepare', 'pending']) {
    const f = fixture({ prepare: snapshot => {
      if (phase === 'prepare') f.owner.update({ ...initial, actionRevision: 1 });
      return { requestId: snapshot.id, text: snapshot.text, actionRevision: snapshot.base.actionRevision };
    } });
    f.owner.editText('text');
    const unsubscribe = f.core.subscribe(() => {
      if (phase === 'pending' && f.core.getSnapshot().pending) { unsubscribe(); f.owner.editText('new text'); }
    });
    assert.deepEqual(await f.owner.submit(), { status: 'blocked', reason: 'draft-changed' });
    assert.equal(f.sent.length, 0);
    assert.equal(f.owner.reference.getSnapshot().unconfirmed, false);
  }
});

test('explicit rejection is distinct from blocked and unknown; unknown never replays send', async () => {
  for (const status of ['rejected', 'unknown'] as const) {
    const f = fixture({ send: async () => ({ status, reason: 'business outcome' }) });
    f.owner.editText('keep');
    const result = await f.owner.submit();
    assert.equal(result.status, status === 'unknown' ? 'unconfirmed' : 'rejected');
    assert.equal(f.owner.reference.getSnapshot().text, 'keep');
    if (status === 'unknown') {
      assert.deepEqual(await f.owner.submit(), { status: 'blocked', reason: 'unconfirmed' });
      f.core.dismissNotice();
      assert.equal(f.owner.reference.getSnapshot().unconfirmed, true);
      const id = f.owner.reference.getSnapshot().submissionId!;
      assert.deepEqual(await f.owner.reconcile(id), { status: 'acknowledged' });
      assert.equal(f.inspected.length, 1);
    }
  }
});

test('reload restores the logical occurrence but issues new runtime/schema settlement authority', async () => {
  let finish!: (value: DraftTransportOutcome<Receipt>) => void;
  const f = fixture({ send: value => { f.sent.push(value); return new Promise(resolve => { finish = resolve; }); } });
  const s = schema(f, (current, captured) => ({ items: current.items.filter(item => !captured.items.some(old => old.id === item.id && JSON.stringify(old.value) === JSON.stringify(item.value))) }));
  f.owner.editText('original');
  appendFixture(s.scope, fixtureItem('A'));
  const sending = f.owner.submit();
  const id = f.owner.reference.getSnapshot().submissionId!;
  f.owner.editText('new revision');
  appendFixture(s.scope, fixtureItem('B'));
  f.owner.update({ ...initial, actionRevision: 2 });
  f.core.suspend(); s.registration.dispose();
  const restored = fixture({}, f.storage);
  const restoredSchema = schema(restored, (current, captured) => ({ items: current.items.filter(item => !captured.items.some(old => old.id === item.id && JSON.stringify(old.value) === JSON.stringify(item.value))) }));
  assert.notEqual(restored.owner.reference.id, f.owner.reference.id);
  assert.equal(restored.owner.reference.getSnapshot().pending, false);
  assert.equal(restored.owner.reference.getSnapshot().unconfirmed, true);
  assert.equal(restored.owner.reference.getSnapshot().actionRevision, 2);
  assert.equal(restored.sent.length + restored.inspected.length, 0, 'restoration does not dispatch or inspect');
  assert.deepEqual(await restored.owner.reconcile(id), { status: 'acknowledged' });
  assert.equal(restored.owner.reference.getSnapshot().text, 'new revision');
  assert.deepEqual(restoredSchema.scope.getSnapshot().items.map(item => item.id), ['B']);
  assert.equal(restored.sent.length, 0);
  finish(accepted(f.sent[0]));
  assert.equal((await sending).status, 'unconfirmed', 'old runtime closure has no recovered settlement authority');
  assert.equal(restored.owner.reference.getSnapshot().text, 'new revision');
});

test('retire preserves dispatched evidence and the next occurrence cannot reconcile the old request', async () => {
  const f = fixture({ send: async () => ({ status: 'unknown', reason: 'lost response' }) });
  f.owner.editText('original');
  await f.owner.submit();
  const id = f.owner.reference.getSnapshot().submissionId!;
  f.owner.retire();
  const fresh = fixture({}, f.storage);
  assert.equal(fresh.owner.reference.getSnapshot().text, '');
  assert.equal(fresh.owner.reference.getSnapshot().unconfirmed, false);
  assert.deepEqual(await fresh.owner.reconcile(id), { status: 'blocked', reason: 'draft-changed' });
  assert.ok([...f.values.keys()].some(key => key.startsWith('owner:inbox:retired:')));
});

test('accepted partial settlement recovers field checkpoints without resend or clearing new edits', async () => {
  let fail = true, settled = 0;
  const f = fixture({ settle: () => { settled++; } });
  const s = schema(f, (current, captured) => {
    if (fail) throw new Error('local ACK failed');
    return { items: current.items.filter(item => !captured.items.some(old => old.id === item.id)) };
  });
  f.owner.editText('original'); appendFixture(s.scope, fixtureItem('A'));
  assert.deepEqual(await f.owner.submit(), { status: 'unconfirmed', reason: 'settlement-failed' });
  f.owner.editText('new');
  appendFixture(s.scope, fixtureItem('B'));
  fail = false;
  assert.deepEqual(await f.owner.reconcile(f.owner.reference.getSnapshot().submissionId!), { status: 'acknowledged' });
  assert.equal(f.sent.length, 1);
  assert.equal(settled, 1);
  assert.equal(f.owner.reference.getSnapshot().text, 'new');
  assert.deepEqual(s.scope.getSnapshot().items.map(item => item.id), ['B']);
});

test('missing or incompatible captured schema cannot be silently omitted during recovery', async () => {
  const f = fixture({ send: async () => ({ status: 'unknown', reason: 'lost' }) }), s = schema(f);
  f.owner.editText('text'); appendFixture(s.scope, fixtureItem('A'));
  await f.owner.submit();
  s.registration.dispose(); f.core.suspend();
  const restored = fixture({}, f.storage);
  const id = restored.owner.reference.getSnapshot().submissionId!;
  assert.deepEqual(await restored.owner.reconcile(id), { status: 'unconfirmed', reason: 'settlement-failed' });
  assert.equal(restored.owner.reference.getSnapshot().text, 'text');
  assert.equal(restored.core.hasUnclaimedStoredData(), true);
  assert.equal(restored.sent.length, 0);
});

test('owner settlement clears only its captured business action revision', async () => {
  let action = 1, finish!: (value: DraftTransportOutcome<Receipt>) => void;
  const f = fixture({ facts: { ...initial, actionRevision: action },
    send: value => { f.sent.push(value); return new Promise(resolve => { finish = resolve; }); },
    settle: value => { if (action === value.actionRevision) action = 0; },
  });
  f.owner.editText('text');
  const pending = f.owner.submit();
  action = 2; f.owner.update({ ...initial, actionRevision: action });
  finish(accepted(f.sent[0]));
  assert.deepEqual(await pending, { status: 'acknowledged' });
  assert.equal(action, 2);
});

test('owner button checks pending-publication blocks and revoked attachment capability at dispatch', async () => {
  for (const change of ['block', 'attachments']) {
    const f = fixture(), s = schema(f);
    f.owner.editText('text'); appendFixture(s.scope, fixtureItem('A'));
    const unsubscribe = f.core.subscribe(() => {
      if (!f.core.getSnapshot().pending) return;
      unsubscribe();
      if (change === 'block') f.core.bindModule('upload', ['text']).draft.block('pending upload');
      else f.owner.update({ ...initial, capabilities: { attachments: false } });
    });
    assert.deepEqual(await f.owner.submit(), { status: 'blocked', reason: change === 'block' ? 'peer-blocked' : 'unsupported' });
    assert.equal(f.sent.length, 0);
  }
});

test('schema ACK notifications cannot confer further settlement authority on a suspended runtime', async () => {
  const f = fixture(), s = schema(f);
  f.owner.editText('original'); appendFixture(s.scope, fixtureItem('A'));
  let restored: ReturnType<typeof fixture> | undefined, bytes: string | undefined;
  const unsubscribe = s.scope.subscribe(() => {
    if (s.scope.getSnapshot().items.length) return;
    unsubscribe();
    f.core.suspend();
    restored = fixture({}, f.storage);
    bytes = f.values.get('owner:inbox');
  });
  assert.deepEqual(await f.owner.submit(), { status: 'unconfirmed', reason: 'settlement-failed' });
  assert.ok(restored);
  assert.equal(f.values.get('owner:inbox'), bytes, 'revoked runtime must not write text or owner checkpoints');
  assert.equal(restored.owner.reference.getSnapshot().text, 'original');
  restored.owner.editText('restored edit');
  assert.equal(restored.errors.length, 0);
});

test('business settlement revocation stops the subsequent owner checkpoint write', async () => {
  let restored: ReturnType<typeof fixture> | undefined, bytes: string | undefined;
  const f = fixture({ settle: () => {
    f.core.suspend();
    restored = fixture({}, f.storage);
    bytes = f.values.get('owner:inbox');
  } });
  f.owner.editText('original');
  assert.deepEqual(await f.owner.submit(), { status: 'unconfirmed', reason: 'settlement-failed' });
  assert.ok(restored);
  assert.equal(f.values.get('owner:inbox'), bytes);
  assert.equal(JSON.parse(bytes!).__cockpitDraft.transaction.ownerSettled, false);
  restored.owner.editText('new');
  assert.equal(restored.errors.length, 0);
});

test('restoration fences an old runtime even before any restored user edit or explicit reconciliation', async () => {
  let finish!: (value: DraftTransportOutcome<Receipt>) => void;
  const f = fixture({ send: value => { f.sent.push(value); return new Promise(resolve => { finish = resolve; }); } });
  f.owner.editText('original');
  const sending = f.owner.submit();
  const id = f.owner.reference.getSnapshot().submissionId!;
  const restored = fixture({}, f.storage);
  const claimed = f.values.get('owner:inbox');
  finish(accepted(f.sent[0]));
  assert.deepEqual(await sending, { status: 'unconfirmed', reason: 'settlement-failed' });
  assert.equal(f.values.get('owner:inbox'), claimed, 'old closure cannot write through a newly claimed generation');
  assert.equal(restored.owner.reference.getSnapshot().text, 'original');
  assert.deepEqual(await restored.owner.reconcile(id), { status: 'acknowledged' });
  assert.equal(restored.sent.length, 0);
});

test('schema restoration never exposes a generic owner request or receipt through legacyRecord', async () => {
  const f = fixture({ send: async () => ({ status: 'unknown', reason: 'lost' }) }), s = schema(f);
  f.owner.editText('public draft text'); appendFixture(s.scope, fixtureItem('A'));
  await f.owner.submit();
  f.core.suspend(); s.registration.dispose();
  const restored = fixture({}, f.storage);
  let legacy: unknown;
  const original = fixtureSchema();
  const registration = new RegisteredDraftSchema('new-files', 'files', fixtureSchema({
    persistence: {
      serialize: original.persistence!.serialize,
      restore: (input, reference) => { legacy = input.legacyRecord; return original.persistence!.restore(input, reference); },
    },
  }), error => restored.errors.push(error));
  registration.prepare(restored.core); registration.activate();
  assert.deepEqual(legacy, { text: 'public draft text', unconfirmed: true });
  assert.ok(JSON.parse(f.values.get('owner:inbox')!).__cockpitDraft.transaction.request, 'private request remains durable');
});

test('native reconciliation distinguishes durable acceptance from unprovable transport and legacy schema ACK', async () => {
  const memory = memoryDraftStorage(), errors: unknown[] = [];
  const source = new SessionDraft('native-recovery', memory.storage, undefined, undefined, error => errors.push(error));
  const initialSchema = new RegisteredDraftSchema('old', 'files', fixtureSchema({
    acknowledge: () => { throw new Error('Interrupted local field ACK'); },
  }), error => errors.push(error));
  initialSchema.prepare(source); initialSchema.activate();
  appendFixture(initialSchema.handle.forDraft(source.reference)!, fixtureItem('A'));
  source.edit('original');
  let sends = 0;
  assert.equal(await source.send(async () => { sends++; return true; }), false);
  assert.equal(source.hasAcceptedSubmission(), true);
  const id = source.getSnapshot().submissionId!;
  source.edit('new text');
  source.suspend(); initialSchema.dispose();
  const restored = new SessionDraft('native-recovery', memory.storage, undefined, undefined, error => errors.push(error));
  const currentSchema = new RegisteredDraftSchema('new', 'files', fixtureSchema({
    acknowledge: (current, captured) => ({ items: current.items.filter(item => !captured.items.some(old => old.id === item.id)) }),
  }), error => errors.push(error));
  currentSchema.setRecoveryAllowed(false);
  currentSchema.prepare(restored); currentSchema.activate();
  assert.deepEqual(await restored.reconcile(id), { status: 'unconfirmed', reason: 'settlement-failed' });
  assert.equal(currentSchema.handle.forDraft(restored.reference)!.getSnapshot().items.length, 1);
  currentSchema.setRecoveryAllowed(true);
  assert.deepEqual(await restored.reconcile(id), { status: 'acknowledged' });
  assert.equal(restored.getSnapshot().text, 'new text');
  assert.equal(currentSchema.handle.forDraft(restored.reference)!.getSnapshot().items.length, 0);
  assert.equal(sends, 1);

  const unknown = new SessionDraft('native-unknown', memory.storage, undefined, undefined, error => errors.push(error));
  unknown.edit('keep');
  await unknown.send(async () => { sends++; return false; });
  assert.deepEqual(await unknown.reconcile(unknown.getSnapshot().submissionId!), { status: 'unconfirmed', reason: 'native-unconfirmed' });
  assert.equal(unknown.getSnapshot().text, 'keep');
  assert.equal(sends, 2, 'inspection never calls native send');
});
