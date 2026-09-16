import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { hasMessageContent } from '../lib/messageContent';
import type { ChatMessage } from '@cockpit/protocol';
import type { RenderNode } from '@cockpit/module-api';
import { moduleRuntime } from '../lib/moduleRuntime';

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

test('attachment-only messages remain visible without a module, network fetch or legacy marker conversion', () => {
  const message: ChatMessage = {
    id: 'user-native', role: 'user', content: ' \n ', timestamp: 1,
    origin: { sessionId: 'root-session', messageId: 'user-native' },
    attachments: [{ type: 'file', path: '/fixture/file.txt', displayName: 'Native file' },
      { type: 'blob', data: 'Zml4dHVyZQ==', mimeType: 'image/png', displayName: 'Native image' }],
  };
  assert.equal(hasMessageContent(message), true);
  const html = renderToStaticMarkup(createElement(MessageContent, { message }));
  assert.match(html, /Native file/);
  assert.match(html, /Native image/);
  assert.doesNotMatch(html, /<img|data:|Zml4dHVyZQ|<video|fetch|message-body/);
});

test('Markdown uses flow-content paragraphs for inline and block enhancement locations, with safe native fallbacks', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: 'Inline [file](/fixture/file.txt) and ![image](/fixture/image.png).\n\n[file](/fixture/file.txt)',
    origin: { sessionId: 'root', messageId: 'native', agentId: 'child' },
  }));
  assert.doesNotMatch(html, /<p(?:>| )/);
  assert.match(html, /class="markdown-paragraph"/);
  assert.match(html, /href="\/fixture\/file.txt"/);
  assert.doesNotMatch(html, /<img/);
});

test('module renderer descriptors retain mdast spaces, Unicode and literal percent escapes before URI normalization', t => {
  const observed: RenderNode[] = [];
  t.mock.method(moduleRuntime, 'renderer', (node: RenderNode) => { observed.push(node); return undefined; });
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: '[space](<./a b.png>) ![space](<./a b.png>)\n\n'
      + '[percent](./a%20b.png) ![percent](./a%20b.png)\n\n'
      + '[unicode](./图像.png) ![entity](./a&amp;b.png)\n\n'
      + '[reference][target] ![reference][target]\n\n[target]: <./reference space.png>\n\n'
      + '[unsafe](javascript:alert%281%29)',
    origin: { sessionId: 'root', messageId: 'native' },
  }));
  assert.deepEqual(observed.map(({ kind, target }) => [kind, target]), [
    ['link', './a b.png'], ['image', './a b.png'],
    ['link', './a%20b.png'], ['image', './a%20b.png'],
    ['link', './图像.png'], ['image', './a&b.png'],
    ['link', './reference space.png'], ['image', './reference space.png'],
    ['link', 'javascript:alert%281%29'],
  ]);
  assert.match(html, /href="\.\/a%20b.png"/);
  assert.match(html, /href="\.\/%E5%9B%BE%E5%83%8F.png"/);
  assert.doesNotMatch(html, /href="javascript:|data-module-markdown-target|<img/);
});
