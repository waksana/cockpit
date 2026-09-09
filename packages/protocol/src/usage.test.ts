import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Intents, SessionUsage } from './index.ts';

const usage = {
  sessionId: 'native', sampledAt: 1, context: null,
  usage: { sessionStartTime: 'native-start', totalUserRequests: 0,
    lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {} },
};
test('native usage contract keeps unavailable context and valid zero counts distinct', () => {
  assert.deepEqual(SessionUsage.parse(usage), usage);
  assert.equal(Intents['session/usage'].body.safeParse({ sessionId: '' }).success, false);
  assert.equal(Intents['session/usage'].body.parse({ sessionId: 'native' }).sessionId, 'native');
  assert.equal(SessionUsage.safeParse({}).success, false);
  assert.equal(SessionUsage.safeParse({ ...usage, usage: null }).success, false);
});
for (const count of [null, undefined, -1, NaN, Infinity, '123', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`native usage contract rejects invalid input token count: ${String(count)}`, () => {
    assert.equal(SessionUsage.safeParse({ ...usage, usage: { ...usage.usage, lastCallInputTokens: count } }).success, false);
  });
}
test('native usage contract preserves optional reasoning only when provided, never sums incomplete aggregates', () => {
  const model = { usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 } };
  const parsed = SessionUsage.parse({ ...usage, usage: { ...usage.usage, modelMetrics: { a: model, unknown: undefined } } });
  assert.equal(parsed.usage.modelMetrics.a?.usage.reasoningTokens, undefined);
  assert.equal(parsed.usage.modelMetrics.unknown, undefined);
  assert.equal(SessionUsage.parse({ ...usage, usage: { ...usage.usage, modelMetrics: {
    a: { usage: { ...model.usage, reasoningTokens: 5 } },
  } } }).usage.modelMetrics.a?.usage.reasoningTokens, 5);
});
