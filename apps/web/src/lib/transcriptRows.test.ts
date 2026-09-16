import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@cockpit/protocol';
import { groupTranscript, transcriptGap } from './transcriptRows';

const thought = (id: string): ChatMessage => ({ id, role: 'assistant', content: '', thought: id, timestamp: 0 });
const speech = (id: string): ChatMessage => ({ id, role: 'assistant', content: id, timestamp: 0 });
test('grouping is consecutive, derived and preserves item references and native ordering', () => {
  const messages = [thought('z'), thought('a'), speech('boundary'), thought('b')];
  const rows = groupTranscript(messages);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.flatMap(row => row.kind === 'process' ? row.items.map(item => item.message) : [row.message]), messages);
  assert.equal(rows[0].kind === 'process' && rows[0].items[0].message, messages[0]);
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
test('reasoning joins prior process before its own response body, tools after speech remain separate', () => {
  const first = thought('earlier'), response = { ...speech('response'), thought: 'Later thought' };
  const tool: ChatMessage = { id: 'execution', role: 'assistant', content: '', timestamp: 0,
    toolCalls: [{ toolCallId: 'call', title: 'Read', status: 'in_progress' }] };
  const rows = groupTranscript([first, response, tool]);
  assert.deepEqual(rows.map(row => row.kind), ['process', 'message', 'process']);
  assert.equal(rows[0].kind === 'process' && rows[0].items.length, 2);
  assert.equal(rows[1].kind === 'message' && rows[1].message, response);
  assert.equal(rows[2].kind === 'process' && rows[2].items[0].kind, 'tool');
});
test('body-first response keeps its body identity when thinking arrives and uses no empty placeholders', () => {
  const original = speech('response');
  const before = groupTranscript([original]);
  const after = groupTranscript([{ ...original, thought: 'Thinking arrived later' }], before);
  assert.deepEqual(after.map(row => row.kind), ['process', 'message']);
  assert.equal(after[1].key, before[0].key);
  const onlyThinking = groupTranscript([{ ...original, content: '', thought: 'Thinking only' }]);
  assert.equal(onlyThinking.length, 1);
  assert.equal(onlyThinking[0].kind, 'process');
});
test('skill activations stay in the continuous process without counting as an extra tool', () => {
  const rows = groupTranscript([thought('one'), { ...speech('skill'), role: 'system', subtype: 'skill' }, thought('two')]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].kind === 'process' && rows[0].items.map(item => item.kind), ['thought', 'skill', 'thought']);
});
test('thought-first response adoption preserves its overview and thought disclosure identity', () => {
  const temporary = { ...thought('reasoning-native-r'), thoughtKey: 'native-response-parent' };
  const first = groupTranscript([temporary]);
  const completed = groupTranscript([{ ...temporary, id: 'native-message', content: 'Final body' }], first);
  assert.equal(first[0].key, completed[0].key);
  assert.equal(first[0].kind === 'process' && first[0].items[0].key,
    completed[0].kind === 'process' && completed[0].items[0].key);
  assert.equal(completed[1].key, 'native-message');
});
test('spacing is derived once per visible boundary, not native message or event count', () => {
  const rows = groupTranscript([
    speech('answer'), { ...speech('user-1'), role: 'user' }, { ...speech('user-2'), role: 'user' },
    thought('thinking'), { ...speech('empty'), content: '' }, thought('more-thinking'),
    speech('reply'), speech('reply-continued'),
  ]);
  assert.deepEqual(rows.map((row, i) => transcriptGap(rows[i - 1], row)),
    ['none', 'speaker', 'related', 'speaker', 'section', 'related']);
  const snapshot = structuredClone(rows);
  const next = groupTranscript([
    speech('answer'), { ...speech('user-1'), role: 'user' }, { ...speech('user-2'), role: 'user' },
    thought('thinking'), thought('more-thinking'), speech('reply'), speech('reply-continued'),
  ], rows);
  assert.deepEqual(rows, snapshot, 'spacing never mutates a prior render projection');
  assert.deepEqual(next.map((row, i) => transcriptGap(next[i - 1], row)),
    rows.map((row, i) => transcriptGap(rows[i - 1], row)));
});
