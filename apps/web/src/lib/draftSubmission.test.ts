import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { DraftSchemaHandle, DraftSchemaRegistration, DraftSendBlockReason, ModuleFrontend, ModuleFrontendContext } from '@cockpit/module-api';
import { DraftCache } from './draftSelection';
import { ModuleRuntime } from './moduleRuntime';
import type { NativeDraftRequest } from './draft';
import { observeLocalSubmissions } from './localSubmission';
import { appendFixture, fixtureItem, fixtureSchema, memoryDraftStorage, type FixtureData } from '../test/draftFixture';

async function fixture(t: TestContext, options: {
  frontend?: ModuleFrontend;
  schema?: DraftSchemaRegistration<FixtureData>;
  send?: (request: NativeDraftRequest) => Promise<boolean>;
} = {}) {
  const memory = memoryDraftStorage(), cache = new DraftCache(memory.storage);
  const source = cache.prompt('A'), requests: NativeDraftRequest[] = [];
  let accepted = 0;
  t.after(observeLocalSubmissions(source.sessionId, () => { accepted++; }));
  const contexts: ModuleFrontendContext[] = [];
  let handle: DraftSchemaHandle<FixtureData> | undefined;
  let reason: DraftSendBlockReason | undefined;
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'speech', name: 'Speech', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/speech/${digest}/api`, entry: `/_modules/assets/speech/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (context: ModuleFrontendContext) => {
      contexts.push(context);
      if (options.schema) handle = context.state.registerDraft(options.schema);
      return options.frontend ?? { apiVersion: 2, writes: ['text'], sends: ['draft'] };
    } }),
    report: () => {},
    draftSubmission: { check: () => reason, send: async request => {
      requests.push(request);
      return options.send ? options.send(request) : true;
    } },
  });
  t.mock.method(console, 'error', () => {});
  await runtime.start();
  t.after(() => runtime.stop());
  runtime.prepareDraft(source, false);
  const context = contexts[0];
  const draft = context.state.bindDraft(source.reference);
  return { ...memory, cache, source, runtime, context, draft, requests, handle,
    accepted: () => accepted,
    gate: (next?: DraftSendBlockReason) => { reason = next; } };
}

test('captured send advertises separate permission, freezes the intent and dispatches once with full schema ACK', async t => {
  let finish!: (value: boolean) => void;
  const f = await fixture(t, { schema: fixtureSchema(), send: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(f.context.draftSubmissionVersion, 1);
  const field = f.handle!.forDraft(f.source.reference)!;
  appendFixture(field, fixtureItem('original'));
  f.draft.editText('Provisional');
  const release = f.draft.block('Recording');
  const intent = f.draft.captureSend();
  assert.ok(Object.isFrozen(intent));
  f.draft.editText('Streaming continuation');
  release(); release();
  assert.equal(f.draft.editTextIfRevision('Complete transcript', f.draft.getSnapshot().revision), true);
  const revision = f.draft.getSnapshot().revision;
  const first = intent.send(revision);
  assert.equal(intent.send(-1), first);
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  assert.equal(f.accepted(), 0, 'dispatch is not yet an acknowledged submission');
  assert.deepEqual(f.requests[0], { intent: 'prompt', body: {
    sessionId: 'A', text: 'Complete transcript', attachments: [fixtureItem('original').value],
  } });
  assert.equal(f.source.getSnapshot().pending, true);
  assert.equal(await f.source.send(async () => assert.fail('Pending captured submission excludes native button dispatch')), false);
  finish(true);
  assert.deepEqual(await first, { status: 'acknowledged' });
  assert.equal(f.source.getSnapshot().text, '');
  assert.equal(field.getSnapshot().items.length, 0);
  assert.equal(intent.send(revision), first);
  assert.equal(f.requests.length, 1);
  assert.equal(f.accepted(), 1, 'captured sends notify the same local view exactly once');
});

test('text write capability alone never authorizes send; send-only permission does not authorize text edits', async t => {
  const denied = await fixture(t, { frontend: { apiVersion: 2, writes: ['text'] } });
  assert.throws(() => denied.draft.captureSend(), /cannot send/);
  const allowed = await fixture(t, { frontend: { apiVersion: 2, sends: ['draft'] } });
  assert.throws(() => allowed.draft.editText('Unauthorized'), /cannot write/);
  allowed.source.edit('User text');
  assert.deepEqual(await allowed.draft.captureSend().send(1), { status: 'acknowledged' });
});

for (const change of ['manual', 'manual-ABA', 'other-module', 'revision-mismatch'] as const) {
  test(`external text checkpoint rejects ${change} without dispatch`, async t => {
    const f = await fixture(t);
    f.draft.editText('Original');
    const intent = f.draft.captureSend(), revision = f.draft.getSnapshot().revision;
    if (change === 'other-module') f.source.bindModule('other', ['text']).draft.editText('Changed');
    else f.source.edit('Changed');
    if (change === 'manual-ABA') f.source.edit('Original');
    // Even if this module has since published another provisional revision, external edits invalidate consent.
    if (change !== 'revision-mismatch') f.draft.editText('Module final text');
    const result = await intent.send(change === 'revision-mismatch' ? revision : f.draft.getSnapshot().revision);
    assert.deepEqual(result, { status: 'blocked', reason: change === 'revision-mismatch' ? 'revision-mismatch' : 'draft-changed' });
    assert.equal(f.requests.length, 0);
    assert.equal(f.accepted(), 0, 'blocked or cancelled captured sends never notify the view');
    assert.equal(f.source.getSnapshot().pending, false);
    assert.equal(f.source.getSnapshot().unconfirmed, false);
  });
}

for (const change of ['add', 'remove', 'modify', 'ABA', 'schema-loss', 'schema-generation'] as const) {
  test(`schema checkpoint rejects ${change} with unchanged text revision`, async t => {
    const f = await fixture(t, { schema: fixtureSchema() });
    const field = f.handle!.forDraft(f.source.reference)!;
    appendFixture(field, fixtureItem('original'));
    f.draft.editText('Transcript');
    const intent = f.draft.captureSend(), revision = f.draft.getSnapshot().revision;
    if (change === 'add') appendFixture(field, fixtureItem('added'));
    if (change === 'remove') field.update(() => ({ items: [] }));
    if (change === 'modify') appendFixture(field, fixtureItem('original', 'changed'));
    if (change === 'ABA') {
      const old = field.getSnapshot();
      field.update(() => ({ items: [] }));
      field.update(() => old);
    }
    if (change === 'schema-loss' || change === 'schema-generation') {
      // Exercise field generation boundaries without revoking the capturing module.
      const { RegisteredDraftSchema } = await import('./draftSchemas');
      const schema = new RegisteredDraftSchema('peer', 'peer', fixtureSchema(), assert.fail);
      schema.prepare(f.source); schema.activate();
      if (change === 'schema-loss') schema.dispose();
      else t.after(() => schema.dispose());
    }
    assert.equal(f.source.getSnapshot().revision, revision);
    assert.deepEqual(await intent.send(revision), { status: 'blocked', reason: 'draft-changed' });
    assert.equal(f.requests.length, 0);
  });
}

for (const gate of ['peer-blocked', 'pending', 'unconfirmed', 'read-only', 'unavailable', 'retired', 'cancelled', 'revoked'] as const) {
  test(`captured send consumes a ${gate} intent without dispatch or automatic retry`, async t => {
    const f = await fixture(t);
    f.draft.editText('Retain');
    let finish!: (value: boolean) => void;
    let pending: Promise<boolean> | undefined;
    if (gate === 'pending') pending = f.source.runAction(() => new Promise(resolve => { finish = resolve; }));
    if (gate === 'unconfirmed') await f.source.runAction(async () => false);
    const intent = f.draft.captureSend();
    const revision = f.draft.getSnapshot().revision;
    let release: (() => void) | undefined;
    if (gate === 'peer-blocked') release = f.source.bindModule('peer', ['text']).draft.block('Peer work');
    if (gate === 'read-only') f.runtime.prepareDraft(f.source, true);
    if (gate === 'unavailable') f.gate('unavailable');
    if (gate === 'retired') f.cache.retire('A');
    if (gate === 'cancelled') intent.cancel();
    if (gate === 'revoked') f.runtime.stop();
    const first = intent.send(revision);
    assert.deepEqual(await first, { status: 'blocked', reason: gate });
    release?.(); f.gate(); f.runtime.prepareDraft(f.source, false);
    assert.equal(intent.send(revision), first);
    assert.equal(f.requests.length, 0);
    if (pending) { finish(false); await pending; }
    assert.equal(f.accepted(), 0, 'blocked or cancelled captured sends never notify the view');
  });
}

test('an intervening ordinary native action invalidates captured consent even when text is unchanged', async t => {
  const f = await fixture(t);
  f.draft.editText('Retain');
  const intent = f.draft.captureSend(), revision = f.draft.getSnapshot().revision;
  assert.equal(await f.source.runAction(async () => true), true);
  assert.equal(f.source.getSnapshot().revision, revision);
  assert.deepEqual(await intent.send(revision), { status: 'blocked', reason: 'draft-changed' });
  assert.equal(f.requests.length, 0);
});

test('read-only session policy covers captured inactive decisions as well as the selected prompt', async t => {
  const f = await fixture(t);
  const session = f.cache.session('A');
  session.synchronize({ planRequest: { requestId: 'plan' } });
  const plan = session.candidate({ kind: 'plan', requestId: 'plan' });
  f.runtime.prepareDraft(plan, false);
  const draft = f.context.state.bindDraft(plan.reference);
  draft.editText('Feedback');
  const intent = draft.captureSend();
  f.runtime.prepareDraft(session.prompt, true);
  assert.deepEqual(await intent.send(1), { status: 'blocked', reason: 'read-only' });
  assert.throws(() => draft.captureSend(), /read-only/);
  assert.equal(f.requests.length, 0);
});

test('pending-publication reentrancy rechecks fields, text and host gates before dispatch', async t => {
  for (const change of ['field', 'text', 'disconnect', 'cancel', 'revocation']) {
    const f = await fixture(t, { schema: fixtureSchema() });
    f.draft.editText('Retain');
    const intent = f.draft.captureSend();
    const stop = f.source.subscribe(() => {
      if (!f.source.getSnapshot().pending) return;
      stop();
      if (change === 'field') appendFixture(f.handle!.forDraft(f.source.reference)!, fixtureItem('late'));
      if (change === 'text') f.source.edit('User edit');
      if (change === 'disconnect') f.gate('unavailable');
      if (change === 'cancel') intent.cancel();
      if (change === 'revocation') f.runtime.stop();
    });
    assert.equal((await intent.send(1)).status, 'blocked');
    assert.equal(f.requests.length, 0);
    assert.equal(f.source.getSnapshot().pending, false);
    assert.equal(f.source.getSnapshot().unconfirmed, false, 'definitely no dispatch is not an unknown native ACK');
  }
});

for (const outcome of ['false', 'throw', 'unknown', 'schema-ack', 'text-settlement', 'module-stop', 'schema-stop'] as const) {
  test(`in-flight ${outcome} settles conservatively and never retries the captured intent`, async t => {
    let finish!: (value: boolean) => void;
    const f = await fixture(t, {
      ...(outcome === 'schema-ack' || outcome === 'schema-stop' ? { schema: fixtureSchema({
        ...(outcome === 'schema-ack' ? { acknowledge: () => { throw new Error('Synthetic ACK failure'); } } : {}),
      }) } : {}),
      send: () => outcome === 'throw' ? Promise.reject(new Error('Unknown native outcome'))
        : outcome === 'unknown' ? Promise.resolve(undefined as unknown as boolean)
          : new Promise(resolve => { finish = resolve; }),
    });
    if (f.handle) appendFixture(f.handle.forDraft(f.source.reference)!, fixtureItem('original'));
    f.draft.editText('Retain');
    const intent = f.draft.captureSend(), first = intent.send(1);
    await Promise.resolve();
    assert.equal(f.requests.length, 1);
    intent.cancel();
    if (outcome === 'text-settlement') f.values.set('cockpit:chat-draft:A', '{"text":"Other instance","unconfirmed":false}');
    if (outcome === 'module-stop' || outcome === 'schema-stop') f.runtime.stop();
    if (outcome !== 'throw' && outcome !== 'unknown') finish(outcome !== 'false');
    const result = await first;
    assert.equal(f.accepted(), ['false', 'throw', 'unknown'].includes(outcome) ? 0 : 1);
    assert.deepEqual(result, outcome === 'module-stop' ? { status: 'acknowledged' } : {
      status: 'unconfirmed', reason: ['schema-ack', 'text-settlement', 'schema-stop'].includes(outcome) ? 'settlement-failed' : 'native-unconfirmed',
    });
    assert.equal(intent.send(1), first);
    assert.equal(f.requests.length, 1);
    if (result.status === 'unconfirmed') assert.equal(f.source.getSnapshot().unconfirmed, true);
  });
}

test('pre-dispatch projection and persistence errors never claim an uncertain dispatch', async t => {
  const projection = await fixture(t, { schema: fixtureSchema({ project: () => { throw new Error('Synthetic projection failure'); } }) });
  projection.draft.editText('Keep');
  assert.deepEqual(await projection.draft.captureSend().send(1), { status: 'blocked', reason: 'projection-failed' });
  const persistence = await fixture(t);
  persistence.draft.editText('Keep');
  const intent = persistence.draft.captureSend();
  persistence.values.set('cockpit:chat-draft:A', '{"text":"Other instance","unconfirmed":false}');
  assert.deepEqual(await intent.send(1), { status: 'blocked', reason: 'persistence-failed' });
  assert.equal(persistence.source.getSnapshot().pending, false);
  assert.equal(persistence.source.getSnapshot().text, 'Keep');
  assert.equal(projection.requests.length + persistence.requests.length, 0);
});
