import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoNameQuestion, generatedTitle } from './auto-name.ts';

test('generated titles are plain, bounded Unicode without truncation or surrogate corruption', () => {
  for (const title of ['对话自动命名实现验证', 'Native conversation naming', '🧪'.repeat(32)]) {
    assert.equal(generatedTitle(` ${title} `), title);
  }
  for (const invalid of ['', ' \n ', 'a'.repeat(33), '🧪'.repeat(33), 'two\nlines', 'two\r lines',
    'null\0byte', '\ud800', '\udc00', 'title\u2028next', '```title```', '"quoted title"', '标题：自动命名']) {
    assert.throws(() => generatedTitle(invalid), { code: 'AUTO_NAME_INVALID_TITLE', statusCode: 502 });
  }
  assert.match(autoNameQuestion, /language of the conversation/);
  assert.match(autoNameQuestion, /ONLY the title/);
});
