import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGINAL_MARKDOWN_TARGET, originalMarkdownTarget, remarkOriginalMarkdownTargets } from './messageContent';

test('original Markdown targets override normalized hrefs, including an explicitly empty target', () => {
  assert.equal(originalMarkdownTarget({ properties: { [ORIGINAL_MARKDOWN_TARGET]: './a b.png' } }, './a%20b.png'), './a b.png');
  assert.equal(originalMarkdownTarget({ properties: { [ORIGINAL_MARKDOWN_TARGET]: './a%20b.png' } }, './a%20b.png'), './a%20b.png');
  assert.equal(originalMarkdownTarget({ properties: { [ORIGINAL_MARKDOWN_TARGET]: '' } }, 'fallback'), '');
  assert.equal(originalMarkdownTarget(undefined, './fallback'), './fallback');
  assert.equal(originalMarkdownTarget({ properties: {} }, './fallback'), './fallback');
});

test('remark annotation preserves unrelated data/properties and leaves non-target nodes alone', () => {
  const link = { type: 'link', url: './a b.png', data: { retained: true, hProperties: { title: 'Existing title' } } };
  const text = { type: 'text', url: './not-a-link' };
  remarkOriginalMarkdownTargets()({ type: 'root', children: [link, text] });
  assert.deepEqual(link.data, { retained: true, hProperties: {
    title: 'Existing title', [ORIGINAL_MARKDOWN_TARGET]: './a b.png',
  } });
  assert.equal(Object.hasOwn(text, 'data'), false);
});

test('reference targets use the first definition in document order, including nested definitions', () => {
  const reference = { type: 'linkReference', identifier: 'FILE', data: { hProperties: {} } };
  remarkOriginalMarkdownTargets()({ type: 'root', children: [
    { type: 'blockquote', children: [{ type: 'definition', identifier: 'file', url: './first space.png' }] },
    { type: 'definition', identifier: 'file', url: './later%20literal.png' },
    reference,
  ] });
  assert.deepEqual(reference.data.hProperties, { [ORIGINAL_MARKDOWN_TARGET]: './first space.png' });
});
