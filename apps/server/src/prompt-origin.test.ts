import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserPromptOrigin, promptOrigin } from './prompt-origin.ts';

test('only admitted same-origin browser headers classify the native Chat ingress as user', () => {
  assert.equal(browserPromptOrigin({ origin: 'https://synthetic.test', 'sec-fetch-site': 'same-origin' }, true), 'user');
  assert.equal(browserPromptOrigin({ origin: 'https://synthetic.test', 'sec-fetch-site': 'same-origin' }, false), 'api');
  for (const headers of [{}, { origin: 'https://synthetic.test' }, { 'sec-fetch-site': 'same-origin' },
    { origin: 'https://synthetic.test', 'sec-fetch-site': 'cross-site' },
    { origin: 'https://synthetic.test', 'sec-fetch-site': 'same-site' }]) {
    assert.equal(browserPromptOrigin(headers, true), 'api');
  }
});
test('module ingress classification remains isolated from a concurrent browser request', async () => {
  const origins = await Promise.all(['user', 'module', 'api'].map(origin =>
    promptOrigin.run(origin as 'user' | 'module' | 'api', async () => {
      await Promise.resolve(); return promptOrigin.getStore();
    })));
  assert.deepEqual(origins, ['user', 'module', 'api']);
  assert.equal(promptOrigin.getStore(), undefined);
});
