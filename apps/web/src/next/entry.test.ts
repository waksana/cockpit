import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextUiDocument } from '../../parallel-ui-plugin';

test('new UI development deep links use their own document and preserve queries', () => {
  for (const path of ['/next', '/next/', '/next/session/fixture', '/next/session/fixture/info',
    '/next/mcp', '/next/skills/project']) {
    assert.equal(nextUiDocument(path), '/next/index.html', path);
  }
  assert.equal(nextUiDocument('/next/session/fixture?mode=synthetic'), '/next/index.html?mode=synthetic');
  for (const path of ['/', '/session/fixture', '/next/intent/prompt', '/next/_modules',
    '/next/index.html', '/next/assets/missing.js', '/next/unknown', '/nextish']) {
    assert.equal(nextUiDocument(path), undefined, path);
  }
});
