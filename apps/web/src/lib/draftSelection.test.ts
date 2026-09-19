import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftCache } from './draftSelection';
import { RegisteredDraftSchema } from './draftSchemas';
import { appendFixture, fixtureItem, fixtureSchema, memoryDraftStorage } from '../test/draftFixture';

test('ask interrupts with an independent draft while cached prompt uploads remain writable', async () => {
  const { storage } = memoryDraftStorage();
  const cache = new DraftCache(storage), session = cache.session('A');
  const prompt = session.prompt;
  prompt.edit('Cached prompt');
  const schema = new RegisteredDraftSchema('files', 'files', fixtureSchema(), assert.fail);
  schema.prepare(prompt); schema.activate();
  const field = schema.handle.forDraft(prompt.reference)!;
  appendFixture(field, fixtureItem('ready'));
  session.synchronize({ ask: { requestId: 'ask-1' } });
  const answer = session.current({ ask: { requestId: 'ask-1' } });
  assert.notEqual(answer.reference.id, prompt.reference.id);
  assert.deepEqual(answer.reference.purpose, { kind: 'ask', requestId: 'ask-1' });
  assert.equal(answer.getSnapshot().text, '');
  assert.equal(schema.handle.forDraft(answer.reference), undefined);
  answer.edit('Uncertain answer');
  assert.equal(await answer.send(async request => {
    assert.deepEqual(request, { intent: 'respondAsk', body: { sessionId: 'A', requestId: 'ask-1', answer: 'Uncertain answer', wasFreeform: true } });
    return false;
  }, () => session.isCurrent(answer)), false);
  appendFixture(field, fixtureItem('finished-in-background'));
  assert.equal(prompt.getSnapshot().text, 'Cached prompt');
  assert.equal(field.getSnapshot().items.length, 2);
  assert.equal(answer.getSnapshot().text, 'Uncertain answer');
  assert.equal(session.current({ ask: { requestId: 'ask-1' } }), answer);
  session.synchronize({});
  assert.equal(session.current({}), prompt);
  assert.equal(answer.getSnapshot().unconfirmed, true);
  assert.throws(() => answer.edit('Late answer'), /retired/);
  schema.dispose();
});

test('plan and elicitation use their own request scopes; unsupported text never falls through to prompt', async () => {
  const cache = new DraftCache();
  const session = cache.session('A');
  session.prompt.edit('Keep normal prompt');
  session.synchronize({ planRequest: { requestId: 'plan' } });
  const plan = session.current({ planRequest: { requestId: 'plan' } });
  plan.edit('Plan feedback');
  assert.equal(await plan.send(async request => {
    assert.deepEqual(request, { intent: 'planSupersede', body: { sessionId: 'A', requestId: 'plan', message: 'Plan feedback' } });
    return true;
  }, () => session.isCurrent(plan)), true);
  session.synchronize({ elicitation: { requestId: 'tool' } });
  const elicitation = session.current({ elicitation: { requestId: 'tool' } });
  elicitation.edit('Not a supported native answer');
  assert.equal(await elicitation.send(async () => assert.fail('No text route')), false);
  assert.equal(await elicitation.runAction(async () => true, () => session.isLive(elicitation)), true);
  assert.equal(elicitation.getSnapshot().text, 'Not a supported native answer');
  assert.equal(session.prompt.getSnapshot().text, 'Keep normal prompt');
  session.synchronize({});
  assert.equal(session.current({}), session.prompt);
});

test('request replacement and reuse after retirement cannot expose old answer data or settle a new scope', async () => {
  const { storage } = memoryDraftStorage();
  const session = new DraftCache(storage).session('A');
  session.prompt.edit('Prompt');
  session.synchronize({ ask: { requestId: 'same' } });
  const old = session.current({ ask: { requestId: 'same' } });
  old.edit('Old answer');
  let finish!: (value: boolean) => void;
  const sending = old.send(() => new Promise(resolve => { finish = resolve; }), () => session.isCurrent(old));
  session.synchronize({});
  session.synchronize({ ask: { requestId: 'same' } });
  const next = session.current({ ask: { requestId: 'same' } });
  assert.notEqual(next, old);
  assert.notEqual(next.reference.id, old.reference.id);
  assert.equal(next.getSnapshot().text, '');
  next.edit('New answer');
  finish(true);
  assert.equal(await sending, true, 'the original in-flight action may settle its retired draft only');
  assert.equal(next.getSnapshot().text, 'New answer');
  assert.equal(session.prompt.getSnapshot().text, 'Prompt');
  assert.equal(session.isCurrent(next), true);
  assert.equal(session.isLive(old), false);
  session.synchronize({ ask: { requestId: 'other' } });
  assert.equal(session.current({ ask: { requestId: 'other' } }).getSnapshot().text, '');
});

test('live request storage restores only its own occurrence and keeps prompt/session namespaces separate', () => {
  const { storage } = memoryDraftStorage();
  const first = new DraftCache(storage);
  first.prompt('A').edit('Prompt A');
  first.prompt('B').edit('Prompt B');
  first.session('A').synchronize({ ask: { requestId: 'shared' } });
  first.session('A').current({ ask: { requestId: 'shared' } }).edit('Answer A');
  first.session('B').synchronize({ ask: { requestId: 'shared' } });
  assert.equal(first.session('B').current({ ask: { requestId: 'shared' } }).getSnapshot().text, '');
  const reload = new DraftCache(storage);
  assert.equal(reload.session('A').current({ ask: { requestId: 'shared' } }).getSnapshot().text, 'Answer A');
  assert.equal(reload.prompt('A').getSnapshot().text, 'Prompt A');
  assert.equal(reload.prompt('B').getSnapshot().text, 'Prompt B');
  reload.session('A').synchronize({});
  const reused = new DraftCache(storage).session('A');
  assert.equal(reused.current({ ask: { requestId: 'shared' } }).getSnapshot().text, '');
});

test('authoritative retirement is observed for inactive sessions, not inferred from connection loss', () => {
  const cache = new DraftCache();
  const session = cache.session('A');
  cache.observe([{ sessionId: 'A', ask: { requestId: 'ask' } }], true);
  const answer = session.current({ ask: { requestId: 'ask' } });
  answer.edit('Keep');
  cache.observe([], false);
  assert.equal(session.current({}, false), answer);
  assert.equal(answer.isRetired(), false);
  cache.observe([{ sessionId: 'A', ask: null }], true);
  assert.equal(answer.isRetired(), true);
  cache.observe([{ sessionId: 'A', ask: { requestId: 'ask' } }], true);
  assert.equal(session.current({ ask: { requestId: 'ask' } }).getSnapshot().text, '');
});

test('session absence retires every captured lifetime even before native observation, and reuse creates new references', () => {
  for (const observed of [false, true]) {
    const cache = new DraftCache();
    const session = cache.session('deleted');
    if (observed) cache.observe([{ sessionId: 'deleted', loaded: true }], true);
    session.synchronize({ ask: { requestId: 'same' }, planRequest: { requestId: 'plan' }, elicitation: { requestId: 'tool' } });
    const drafts = [session.prompt,
      session.candidate({ kind: 'ask', requestId: 'same' }),
      session.candidate({ kind: 'plan', requestId: 'plan' }),
      session.candidate({ kind: 'elicitation', requestId: 'tool' })];
    const notifications = drafts.map(() => 0);
    drafts.forEach((draft, index) => draft.subscribe(() => {
      notifications[index]++;
      assert.ok(drafts.every(value => value.getSnapshot().retired), 'all lifetime flags precede notifications');
    }));
    cache.observe([], false);
    cache.observe([{ sessionId: 'deleted', loaded: false, ask: null }], true);
    assert.ok(drafts.every(draft => !draft.getSnapshot().retired), 'disconnect/unload is not retirement');
    assert.equal(session.current({ loaded: false }), drafts[1]);
    cache.observe([], true);
    assert.deepEqual(notifications, [1, 1, 1, 1]);
    assert.equal(session.candidate({ kind: 'ask', requestId: 'same' }), drafts[1]);
    assert.throws(() => session.candidate({ kind: 'ask', requestId: 'new' }), /retired/);
    const fresh = cache.session('deleted');
    cache.observe([{ sessionId: 'deleted', loaded: true, ask: { requestId: 'same' } }], true);
    assert.notEqual(fresh.prompt.reference.id, session.prompt.reference.id);
    assert.notEqual(fresh.candidate({ kind: 'ask', requestId: 'same' }).reference.id, drafts[1].reference.id);
    assert.equal(fresh.prompt.getSnapshot().retired, false);
    assert.ok(drafts.every(draft => draft.getSnapshot().retired));
  }
});

test('decision replacement publishes retirement without retiring the inactive writable prompt', () => {
  const cache = new DraftCache(), session = cache.session('A');
  const prompt = session.prompt.bindModule('speech', ['text']).draft;
  prompt.editText('Captured');
  const revision = prompt.getSnapshot().revision;
  cache.observe([{ sessionId: 'A', ask: { requestId: 'same' } }], true);
  const old = session.candidate({ kind: 'ask', requestId: 'same' }).bindModule('speech', ['text']).draft;
  let retired = 0;
  old.subscribe(() => { if (old.getSnapshot().retired) retired++; });
  cache.observe([{ sessionId: 'A', ask: { requestId: 'replacement' } }], true);
  assert.equal(retired, 1);
  assert.equal(prompt.editTextIfRevision('Background result', revision), true);
  assert.equal(prompt.getSnapshot().retired, false);
  cache.observe([{ sessionId: 'A', ask: { requestId: 'same' } }], true);
  assert.throws(() => old.editTextIfRevision('Late result', 0), /retired/);
  assert.equal(session.candidate({ kind: 'ask', requestId: 'same' }).getSnapshot().text, '');
  assert.equal(prompt.getSnapshot().text, 'Background result');
});

test('all ended decisions and selection are revoked before any retirement callback can run', async () => {
  const session = new DraftCache().session('atomic-retirement');
  session.synchronize({ ask: { requestId: 'ask' }, planRequest: { requestId: 'plan' } });
  const ask = session.candidate({ kind: 'ask', requestId: 'ask' });
  const plan = session.candidate({ kind: 'plan', requestId: 'plan' });
  const binding = plan.bindModule('speech', ['text']).draft;
  let observed: { retired: boolean; live: boolean; selected: boolean } | undefined;
  let action: Promise<boolean> | undefined, dispatched = false;
  ask.subscribe(() => {
    if (!ask.getSnapshot().retired) return;
    observed = { retired: plan.getSnapshot().retired, live: session.isLive(plan), selected: session.isCurrent(session.prompt) };
    action = plan.runAction(async () => { dispatched = true; return true; }, () => session.isLive(plan));
  });
  session.synchronize({});
  assert.deepEqual(observed, { retired: true, live: false, selected: true });
  assert.equal(await action, false);
  assert.equal(dispatched, false);
  assert.throws(() => binding.editTextIfRevision('Late', 0), /retired/);
});

test('a retired prompt ACK cannot mutate storage or block completion in a reused session lifetime', async () => {
  const { storage } = memoryDraftStorage();
  const cache = new DraftCache(storage), old = cache.prompt('reused');
  old.edit('Deleted prompt');
  let finish!: (value: boolean) => void;
  const sending = old.send(() => new Promise(resolve => { finish = resolve; }));
  cache.observe([], true);
  const fresh = cache.prompt('reused');
  assert.equal(fresh.getSnapshot().text, '');
  assert.equal(fresh.getSnapshot().unconfirmed, false);
  const before = fresh.getSnapshot();
  finish(true);
  assert.equal(await sending, false);
  assert.equal(fresh.getSnapshot(), before);
  assert.equal(fresh.bindModule('speech', ['text']).draft.editTextIfRevision('New lifetime', 0), true);
  assert.equal(new DraftCache(storage).prompt('reused').getSnapshot().text, 'New lifetime');
  assert.equal(old.getSnapshot().retired, true);
});

test('choice responses preserve the cached prompt and never project its schema', async () => {
  const session = new DraftCache().session('A');
  let projects = 0;
  const schema = new RegisteredDraftSchema('files', 'files', fixtureSchema({
    project: () => { projects++; return { attachments: [] }; },
  }), assert.fail);
  schema.prepare(session.prompt); schema.activate();
  const field = schema.handle.forDraft(session.prompt.reference)!;
  appendFixture(field, fixtureItem('prompt-only'));
  session.prompt.edit('Ordinary');
  const before = session.prompt.getSnapshot();
  session.synchronize({ ask: { requestId: 'ask' } });
  const answer = session.current({ ask: { requestId: 'ask' } });
  assert.equal(await answer.runAction(async () => true, () => session.isLive(answer)), true);
  assert.equal(projects, 0);
  assert.equal(session.prompt.getSnapshot(), before);
  assert.equal(field.getSnapshot().items.length, 1);
  schema.dispose();
});

test('stale stored pending tokens cannot overwrite a newer draft instance', async () => {
  const { storage } = memoryDraftStorage();
  const first = new DraftCache(storage).prompt('A');
  first.edit('First');
  let finish!: (value: boolean) => void;
  const sending = first.send(() => new Promise(resolve => { finish = resolve; }));
  const replacement = new DraftCache(storage).prompt('A');
  replacement.edit('Newer independent instance');
  finish(true);
  assert.equal(await sending, false);
  assert.equal(first.getSnapshot().pending, false);
  assert.equal(replacement.getSnapshot().text, 'Newer independent instance');
  assert.equal(new DraftCache(storage).prompt('A').getSnapshot().text, 'Newer independent instance');
});

test('decision-index storage failures do not veto authoritative current input or restore unknown occurrences', async () => {
  for (const failure of ['corrupt', 'read', 'write']) {
    const { storage, values } = memoryDraftStorage();
    const index = 'cockpit:draft-requests:A';
    if (failure === 'corrupt') values.set(index, 'not-json');
    const backing = {
      ...storage,
      getItem(key: string) {
        if (failure === 'read' && key === index) throw new Error('Synthetic index read failure');
        return storage.getItem(key);
      },
      setItem(key: string, value: string) {
        if (failure === 'write' && key === index) throw new Error('Synthetic index write failure');
        storage.setItem(key, value);
      },
    };
    const session = new DraftCache(backing).session('A');
    session.prompt.edit('Still usable');
    session.synchronize({});
    let calls = 0;
    assert.equal(await session.prompt.send(async () => { calls++; return true; }, () => session.isCurrent(session.prompt)), true);
    session.synchronize({ ask: { requestId: 'current' } });
    const answer = session.current({ ask: { requestId: 'current' } });
    assert.equal(answer.getSnapshot().text, '');
    answer.edit('Current answer');
    assert.equal(await answer.send(async request => {
      assert.equal(request.intent, 'respondAsk');
      calls++;
      return true;
    }, () => session.isCurrent(answer)), true);
    session.synchronize({ ask: { requestId: 'replacement' } });
    assert.equal(session.isLive(answer), false);
    assert.equal(session.current({ ask: { requestId: 'replacement' } }).getSnapshot().text, '');
    assert.equal(calls, 2);
  }
});
