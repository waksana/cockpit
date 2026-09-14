import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@cockpit/protocol';
import { groupTranscript } from './transcriptRows';

const thought = (id: string): ChatMessage => ({ id, role: 'assistant', content: '', thought: id, timestamp: 0 });
const speech = (id: string): ChatMessage => ({ id, role: 'assistant', content: id, timestamp: 0 });
test('grouping is consecutive, derived and preserves item references and native ordering', () => {
  const messages = [thought('z'), thought('a'), speech('boundary'), thought('b')];
  const rows = groupTranscript(messages);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.flatMap(row => row.kind === 'process' ? row.items : [row.message]), messages);
  assert.equal(rows[0].kind === 'process' && rows[0].items[0], messages[0]);
});
test('prepending and appending process items preserve the mounted group identity', () => {
  const known = [thought('known'), thought('second')];
  const before = groupTranscript(known);
  const after = groupTranscript([thought('older'), ...known, thought('newer')], before);
  assert.equal(after[0].key, before[0].key);
  assert.equal(before[0].kind === 'process' && before[0].items.length, 2);
});
test('new speech can split a group without duplicate React keys', () => {
  const a = thought('a'), b = thought('b');
  const before = groupTranscript([a, b]);
  const after = groupTranscript([a, speech('answer'), b], before);
  assert.equal(new Set(after.map(row => row.key)).size, 3);
  assert.equal(after[0].key, before[0].key);
});
test('splitting a group after prefix extension still yields unique overview identities', () => {
  const a = thought('a'), b = thought('b');
  const initial = groupTranscript([b]);
  const extended = groupTranscript([a, b], initial);
  const split = groupTranscript([a, speech('answer'), b], extended);
  assert.equal(new Set(split.map(row => row.key)).size, split.length);
  assert.equal(split[2].key, initial[0].key, 'the original group containing b keeps its manual choice and anchor');
  assert.notEqual(split[0].key, initial[0].key, 'prepended items must not steal the old group identity');
});
test('invisible starts do not break process; user answers and errors do', () => {
  const empty = { ...speech('empty'), content: ' \n ' };
  const rows = groupTranscript([thought('a'), empty, thought('b'),
    { ...speech('user'), role: 'user', subtype: 'ask-reply' },
    thought('c'), { ...speech('error'), role: 'system', level: 'error' }, thought('d')]);
  assert.deepEqual(rows.map(row => row.kind), ['process', 'message', 'process', 'message', 'process']);
});
test('provisional reasoning stays outside the confirmed overview and has no effect on its count', () => {
  const first = thought('confirmed'), preview = { ...thought('preview'), provisional: true };
  const previous = groupTranscript([first]);
  const next = groupTranscript([first, preview], previous);
  assert.equal(next.length, 2);
  assert.equal(next[0].key, previous[0].key);
  assert.deepEqual(next[0].kind === 'process' && next[0].items, [first]);
  assert.deepEqual(next[1].kind === 'process' && next[1].items, [preview]);
});
