import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionUsage as Usage } from '@cockpit/protocol';
import { SessionUsage, UsageValues } from './SessionUsage';
import { useCockpit } from '../net/store';

const data: Usage = {
  sessionId: 'a', sampledAt: 1,
  context: { totalTokens: 1000, promptTokenLimit: 10000, limit: 12000, modelId: 'model',
    modelSource: 'selected', compactionThreshold: 8000, compactions: { count: 1 },
    categories: { systemPrompt: 100, customInstructions: 100, systemTools: 100, mcpTools: 100, messages: 600, freeSpace: 8500, buffer: 2500 } },
  usage: { sessionStartTime: '2026-09-09T00:00:00Z', totalUserRequests: 2, lastCallInputTokens: 800, lastCallOutputTokens: 90,
    modelMetrics: { model: { usage: { inputTokens: 1800, outputTokens: 120, cacheReadTokens: 500, cacheWriteTokens: 0 } } } },
};
test('usage labels distinguish context snapshot, last main call and native aggregate without fabricated reasoning/cost', () => {
  const html = renderToStaticMarkup(createElement(UsageValues, { value: data }));
  for (const label of ['原生估算', '10.0%', '最近主代理调用', '原生按模型累计', '未提供', '不推算费用', 'LRU']) assert.ok(html.includes(label), label);
  assert.match(html, /1,000/);
  assert.match(html, /1,800/);
});
test('usage null context and unknown model limit do not display a ratio or substitute zero', () => {
  const html = renderToStaticMarkup(createElement(UsageValues, { value: { ...data, context: null } }));
  assert.match(html, /当前上下文暂不可用/);
  assert.doesNotMatch(html, /10.0%/);
  for (const context of [{ ...data.context!, promptTokenLimit: 0 }, { ...data.context!, modelSource: 'default' }]) {
    const rendered = renderToStaticMarkup(createElement(UsageValues, { value: { ...data, context } }));
    assert.doesNotMatch(rendered, /\d+\.\d+%/);
  }
});
test('unloaded usage panel never invokes the read or automatically resumes runtime', () => {
  const before = useCockpit.getState();
  let reads = 0;
  useCockpit.setState({ sessions: [], connState: 'open', getUsage: async () => { reads++; return data; } });
  try {
    const html = renderToStaticMarkup(createElement(SessionUsage, { sessionId: 'unloaded' }));
    assert.equal(reads, 0);
    assert.match(html, /会话未加载/);
    assert.match(html, /不会自动恢复/);
  } finally { useCockpit.setState(before); }
});
