import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftAskContext } from '@cockpit/module-api/frontend';
import { DraftCache } from './draftSelection';
import { resolveDraft } from './textDraft';
import { memoryDraftStorage } from '../test/draftFixture';

test('ask context belongs only to its exact session, purpose and request occurrence', () => {
  const cache = new DraftCache(), session = cache.session('A');
  const purposes = [
    { kind: 'ask', requestId: 'same' }, { kind: 'plan', requestId: 'same' },
    { kind: 'elicitation', requestId: 'same' },
  ] as const;
  cache.session('B');
  cache.observe([
    { sessionId: 'A', ask: { requestId: 'same', question: 'Question A', choices: ['A'] },
      planRequest: { requestId: 'same' }, elicitation: { requestId: 'same' } },
    { sessionId: 'B', ask: { requestId: 'same', question: 'Question B' } },
  ], true);
  const answer = session.candidate(purposes[0]);
  const captured = answer.getSnapshot();
  assert.deepEqual(captured.askContext, { question: 'Question A', choices: ['A'] });
  assert.equal(session.prompt.getSnapshot().askContext, undefined);
  for (const purpose of purposes.slice(1)) assert.equal(session.candidate(purpose).getSnapshot().askContext, undefined);
  assert.deepEqual(cache.session('B').candidate(purposes[0]).getSnapshot().askContext, { question: 'Question B' });
  session.synchronize({ ask: { requestId: 'replacement', question: 'Replacement' } });
  assert.equal(answer.getSnapshot().askContext, undefined);
  assert.equal(answer.getSnapshot().retired, true);
  assert.deepEqual(captured.askContext, { question: 'Question A', choices: ['A'] });
  session.synchronize({});
  session.synchronize({ ask: { requestId: 'same', question: 'Reused' } });
  const reused = session.candidate(purposes[0]);
  assert.notEqual(reused.reference.id, answer.reference.id);
  assert.deepEqual(reused.getSnapshot().askContext, { question: 'Reused' });
  assert.equal(answer.getSnapshot().askContext, undefined);
  cache.retire('A');
  assert.equal(reused.getSnapshot().askContext, undefined);
  session.synchronize({ ask: { requestId: 'same', question: 'Cannot revive' } });
  assert.equal(reused.getSnapshot().askContext, undefined);
  assert.equal(cache.session('B').candidate(purposes[0]).getSnapshot().askContext?.question, 'Question B');
});

test('same live ID context updates are immutable copies, not text edits or a new occurrence', async () => {
  const { storage, values } = memoryDraftStorage();
  const session = new DraftCache(storage).session('A');
  const ask = { requestId: 'same', question: 'Original', choices: ['One', 'Two'] };
  session.synchronize({ ask });
  const answer = session.candidate({ kind: 'ask', requestId: 'same' });
  const binding = answer.bindModule('reader', []);
  const captured = binding.draft.getSnapshot();
  const context: DraftAskContext = captured.askContext!;
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.choices));
  assert.equal(Reflect.set(context, 'question', 'Attempt'), false);
  assert.throws(() => (context.choices as string[]).push('Attempt'), TypeError);
  assert.deepEqual(Object.keys(context).sort(), ['choices', 'question']);
  ask.question = 'Updated';
  ask.choices.push('Three');
  assert.deepEqual(context, { question: 'Original', choices: ['One', 'Two'] });
  answer.edit('Answer');
  const before = answer.getSnapshot(), saved = [...values];
  let notifications = 0;
  binding.draft.subscribe(() => { notifications++; });
  session.synchronize({ ask });
  assert.equal(session.candidate({ kind: 'ask', requestId: 'same' }), answer);
  assert.deepEqual(binding.draft.getSnapshot().askContext, { question: 'Updated', choices: ['One', 'Two', 'Three'] });
  assert.deepEqual({ ...answer.getSnapshot(), askContext: undefined }, { ...before, askContext: undefined });
  assert.deepEqual([...values], saved, 'context-only updates never persist question data');
  assert.equal(notifications, 1);
  session.synchronize({ ask: { ...ask, choices: [...ask.choices] } });
  assert.equal(notifications, 1, 'equal context keeps snapshot identity stable');
  let finish!: (ok: boolean) => void;
  const sending = answer.send(() => new Promise(resolve => { finish = resolve; }), () => session.isCurrent(answer));
  session.synchronize({ ask: { ...ask, question: 'Updated while sending' } });
  assert.equal(answer.getSnapshot().pending, true);
  assert.equal(answer.getSnapshot().revision, before.revision);
  finish(true);
  assert.equal(await sending, true);
  assert.equal(answer.getSnapshot().text, '', 'context updates cannot prevent captured text ACK');
  assert.equal(answer.getSnapshot().askContext?.question, 'Updated while sending');
  assert.deepEqual(context, { question: 'Original', choices: ['One', 'Two'] });
  assert.throws(() => binding.draft.editText('No write capability'), /cannot write/);
  binding.dispose();
  assert.throws(() => binding.draft.getSnapshot(), /revoked/);
  assert.throws(() => resolveDraft(binding.draft), /revoked/);
});

test('missing question, optional choices, context availability and text revision remain independent', () => {
  const session = new DraftCache().session('A');
  const purpose = { kind: 'ask', requestId: 'ask' } as const;
  const answer = session.candidate(purpose);
  assert.equal(answer.getSnapshot().askContext, undefined, 'candidate does not grant authority');
  session.synchronize({ ask: { requestId: 'ask', choices: ['No question'] } });
  assert.equal(answer.getSnapshot().askContext, undefined);
  session.synchronize({ ask: { requestId: 'ask', question: 'No choices' } });
  assert.deepEqual(answer.getSnapshot().askContext, { question: 'No choices' });
  assert.equal(answer.getSnapshot().hasContent, false);
  session.synchronize({ ask: { requestId: 'ask', question: '', choices: [] } });
  assert.deepEqual(answer.getSnapshot().askContext, { question: '', choices: [] });
  const writer = answer.bindModule('writer', ['text']).draft;
  const release = writer.block('Capturing');
  const revision = writer.getSnapshot().revision;
  session.synchronize({ ask: { requestId: 'ask' } });
  assert.equal(writer.getSnapshot().askContext, undefined);
  assert.equal(writer.getSnapshot().revision, revision);
  assert.equal(writer.getSnapshot().blocks.length, 1);
  release();
  assert.equal(writer.editTextIfRevision('Captured text', revision), true);
});

test('disconnect, unloaded and non-authoritative snapshots clear context without inventing retirement', () => {
  for (const loss of ['disconnect', 'unloaded', 'unconfirmed'] as const) {
    const cache = new DraftCache(), session = cache.session('background');
    const ask = { requestId: 'same', question: 'Confirmed' };
    cache.observe([{ sessionId: 'background', loaded: true, ask }], true);
    const answer = session.candidate({ kind: 'ask', requestId: 'same' });
    answer.edit('Retain answer');
    const captured = answer.getSnapshot();
    if (loss === 'disconnect') cache.observe([], false);
    else cache.observe([{ sessionId: 'background', loaded: loss !== 'unloaded',
      ask: { ...ask, question: 'Not authoritative' } }], loss === 'unloaded');
    assert.equal(answer.getSnapshot().askContext, undefined);
    assert.equal(answer.isRetired(), false);
    assert.equal(answer.getSnapshot().text, 'Retain answer');
    assert.equal(answer.getSnapshot().revision, captured.revision);
    assert.equal(captured.askContext?.question, 'Confirmed');
    assert.equal(session.current({ ask }, false), answer);
    assert.equal(answer.getSnapshot().askContext, undefined, 'reading stale metadata cannot restore authority');
    cache.observe([{ sessionId: 'background', loaded: true, ask: { ...ask, question: 'Reconfirmed' } }], true);
    assert.equal(answer.getSnapshot().askContext?.question, 'Reconfirmed');
    cache.observe([{ sessionId: 'unrelated', loaded: true, ask }], true);
    assert.equal(answer.getSnapshot().askContext, undefined);
    assert.equal(answer.isRetired(), true);
  }
});

test('restoration retains answer storage but never restores question context before native confirmation', () => {
  const { storage, values } = memoryDraftStorage();
  const session = new DraftCache(storage).session('A');
  const ask = { requestId: 'same', question: 'Ephemeral question', choices: ['Ephemeral choice'] };
  const purpose = { kind: 'ask', requestId: 'same' } as const;
  session.synchronize({ ask });
  session.candidate(purpose).edit('Saved answer');
  assert.ok([...values.values()].every(value => !value.includes('Ephemeral')));
  const restored = new DraftCache(storage).session('A');
  const answer = restored.current({ ask });
  assert.equal(answer.getSnapshot().text, 'Saved answer');
  assert.equal(answer.getSnapshot().askContext, undefined);
  restored.synchronize({ ask }, false);
  assert.equal(answer.getSnapshot().askContext, undefined);
  restored.synchronize({ loaded: false, ask });
  assert.equal(answer.getSnapshot().askContext, undefined);
  restored.synchronize({ ask: { requestId: 'same', question: 'Fresh question' } });
  assert.deepEqual(answer.getSnapshot().askContext, { question: 'Fresh question' });
});
