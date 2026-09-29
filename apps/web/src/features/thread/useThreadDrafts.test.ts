import { act, renderHook } from '../../test/dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSession } from '../../dev/chat-fixtures';
import { useThreadDrafts } from './useThreadDrafts';
import type { ChatSession } from '../../net/types';

test('native owner facts retain choice actions without granting free-text or attachment submission', async () => {
  const session: ChatSession = { ...fixtureSession('all'), sessionId: 'native-owner-choice',
    messages: [], ask: { requestId: 'choice-only', question: 'Choose', choices: ['Yes'], allowFreeform: false } };
  let choices = 0, textSends = 0;
  const { result, rerender } = renderHook(({ current }) => useThreadDrafts(current, {
    readOnly: false, authoritative: true,
    onSend: async () => { textSends++; return true; },
    onRespondAsk: async (_id, choice, freeform) => { assert.equal(choice, 'Yes'); assert.equal(freeform, false); choices++; return true; },
  }), { initialProps: { current: session } });
  const draft = result.current.draft;
  assert.equal(draft.getSnapshot().editable, false);
  assert.equal(draft.getSnapshot().submittable, false);
  assert.equal(draft.getSnapshot().capabilities.attachments, false);
  assert.throws(() => draft.bindModule('speech', ['text']).draft.editText('Unauthorized free text'), /read-only/);
  await act(async () => { assert.equal(await result.current.handleChoice('choice-only', 'Yes'), true); });
  assert.equal(choices, 1); assert.equal(textSends, 0);
  rerender({ current: { ...session, ask: { ...session.ask!, allowFreeform: true } } });
  assert.equal(result.current.draft, draft);
  assert.equal(draft.getSnapshot().editable, true);
  assert.equal(draft.getSnapshot().submittable, true);
});

test('native owner supplies only already-visible eligible completed source text and clears stale context', () => {
  const base = fixtureSession('all'), sessionId = 'native-owner-reference';
  const source = base.messages[0];
  const session: ChatSession = { ...base, sessionId, messages: [
    { ...source, id: 'eligible', role: 'assistant', subtype: undefined, content: '😀'.repeat(1001),
      origin: { sessionId, messageId: 'eligible' }, streaming: false, incomplete: undefined },
    { ...source, id: 'fragment', role: 'assistant', content: 'incomplete fragment',
      origin: { sessionId, messageId: 'fragment' }, incomplete: 'interrupted' },
    { ...source, id: 'foreign', role: 'assistant', content: 'other session',
      origin: { sessionId: 'other', messageId: 'foreign' } },
  ] };
  const { result, rerender } = renderHook(({ current, authoritative }) => useThreadDrafts(current, {
    readOnly: false, authoritative,
  }), { initialProps: { current: session, authoritative: true } });
  assert.equal([...result.current.draft.getSnapshot().referenceText!].length, 1000);
  const lifetime = result.current.draft;
  rerender({ current: session, authoritative: false });
  assert.equal(result.current.draft, lifetime);
  assert.equal(lifetime.getSnapshot().referenceText, undefined);
  assert.equal(lifetime.getSnapshot().editable, true, 'offline local text editing remains available');
  assert.equal(lifetime.getSnapshot().submittable, false);
});
