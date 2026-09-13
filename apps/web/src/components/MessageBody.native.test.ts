import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from './MessageBody';

test('native text rendering does not fetch or preview media without an enhancement', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: 'Before\n\n![reference](https://example.invalid/image.png)\n\n[ordinary link](https://example.invalid/page)\n\nAfter',
  }));
  assert.doesNotMatch(html, /<img|<video|data-file-url|download=/);
  assert.match(html, /!\[reference\]\(https:\/\/example.invalid\/image.png\)/);
  assert.match(html, /href="https:\/\/example.invalid\/page"/);
  assert.match(html, /Before/);
  assert.match(html, /After/);
});

test('native Markdown links retain the existing unsafe-URL protection', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: '[unsafe](javascript:alert%281%29)',
  }));
  assert.doesNotMatch(html, /href="javascript:/);
});
