import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../net/types';
import { elicitationRecords, recordElicitation, withElicitationRecords } from './decisionRecords';
import { pendingDecisions, findPendingDecision } from './pendingDecisions';

function withStorage(t: { after(fn: () => void): void }) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : Reflect.deleteProperty(globalThis, 'window'));
  return values;
}

test('elicitation records keep the chosen action for this page only and cap their count', t => {
  const values = withStorage(t);
  recordElicitation('records', { requestId: 'r1', message: 'Allow?', source: 'mcp', anchor: 'm1', timestamp: 1, action: 'accept' });
  assert.equal(elicitationRecords('records')[0].action, 'accept');
  const stored = JSON.parse(values.get('cockpit:elicitation-records:records')!);
  assert.deepEqual(stored, [{ requestId: 'r1', message: 'Allow?', source: 'mcp', anchor: 'm1', timestamp: 1 }], 'the action is not persisted');
  for (let i = 2; i <= 25; i++) recordElicitation('records', { requestId: `r${i}`, message: 'M', anchor: null, timestamp: i });
  assert.equal(elicitationRecords('records').length, 20);
  assert.equal(elicitationRecords('records')[0].requestId, 'r6');
});

test('restored records only mark a request as handled', t => {
  const values = withStorage(t);
  values.set('cockpit:elicitation-records:restored', JSON.stringify([
    { requestId: 'r1', message: 'Allow?', anchor: 'm1', timestamp: 1, action: 'decline' }, { bogus: true },
  ]));
  assert.deepEqual(elicitationRecords('restored'), [{ requestId: 'r1', message: 'Allow?', anchor: 'm1', timestamp: 1 }]);
});

test('records are placed after their anchor message', () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: 'a', timestamp: 1 }, { id: 'm2', role: 'assistant', content: 'b', timestamp: 2 },
  ];
  const merged = withElicitationRecords(messages, [
    { requestId: 'x', message: 'Allow?', anchor: 'm1', timestamp: 3 },
    { requestId: 'y', message: 'Start?', anchor: null, timestamp: 0 },
  ]);
  assert.deepEqual(merged.map(message => message.id), ['elicitation-y', 'm1', 'elicitation-x', 'm2']);
  assert.equal(merged[2].subtype, 'elicitation-reply');
  assert.equal(withElicitationRecords(messages, []), messages);
});

test('pending decisions prefer the ordered list and fall back to singular fields', () => {
  const ask = { requestId: 'a', question: 'Q' };
  const plan = { requestId: 'p', summary: 'S' };
  assert.deepEqual(pendingDecisions({ ask, planRequest: plan }).map(d => d.kind), ['ask', 'plan']);
  const decisions = [{ kind: 'plan' as const, request: plan }, { kind: 'ask' as const, request: ask },
    { kind: 'ask' as const, request: { requestId: 'b', question: 'Q2' } }];
  assert.equal(pendingDecisions({ decisions, ask, planRequest: plan }), decisions);
  assert.equal(findPendingDecision({ decisions }, 'ask', 'b')?.request.question, 'Q2');
  assert.equal(findPendingDecision({ decisions }, 'plan', 'b'), undefined);
});
