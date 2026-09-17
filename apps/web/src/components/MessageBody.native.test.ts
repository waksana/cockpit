import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { hasMessageContent } from '../lib/messageContent';
import type { ChatMessage } from '@cockpit/protocol';
import type { ActivateFrontend, MarkdownNode } from '@cockpit/module-api';
import { ModuleRuntime, moduleRuntime } from '../lib/moduleRuntime';
import { ModuleRuntimeProvider } from './ModuleComponents';

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

test('a linked image keeps one link action instead of nesting an enhanced preview button inside it', t => {
  const observed: MarkdownNode[] = [];
  t.mock.method(moduleRuntime, 'renderer', (node: MarkdownNode) => {
    observed.push(node);
    return node.kind === 'image' ? {
      module: {
        asset: { id: 'fixture', name: 'Fixture', version: '1.0.0', digest: 'a'.repeat(64),
          apiBase: '/fixture/api', entry: '/fixture/entry.js', styles: [], config: {} },
        frontend: { apiVersion: 2 }, signal: new AbortController().signal, bindings: new Map(), stop() {},
      },
      renderer: { id: 'image', matches: () => true, component: () => createElement('button', { type: 'button' }, 'Preview') },
    } : undefined;
  });
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: '[![Picture](./image.png)](https://example.invalid/destination)\n\n![Standalone](./other.png)',
    origin: { sessionId: 'fixture', messageId: 'linked-image' },
  }));
  assert.deepEqual(observed.map(node => [node.kind, node.label]), [['link', 'Picture'], ['image', 'Standalone']]);
  assert.match(html, /<a[^>]*href="https:\/\/example.invalid\/destination"[^>]*><span>!\[Picture\]/);
  assert.doesNotMatch(html, /<a[^>]*><button/);
  assert.equal((html.match(/<button/g) ?? []).length, 1, 'standalone media remains module-enhanceable');
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

test('Markdown keeps semantic paragraphs for truly inline enhancements and safe native fallbacks', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: 'Inline [file](/fixture/file.txt) and ![image](/fixture/image.png).\n\n[file](/fixture/file.txt)',
    origin: { sessionId: 'root', messageId: 'native', agentId: 'child' },
  }));
  assert.match(html, /<p class="markdown-paragraph"/);
  assert.doesNotMatch(html, /<div class="markdown-paragraph"/);
  assert.match(html, /class="markdown-paragraph"/);
  assert.match(html, /href="\/fixture\/file.txt"/);
  assert.doesNotMatch(html, /<img/);
});

test('module renderer descriptors retain mdast spaces, Unicode and literal percent escapes before URI normalization', t => {
  const observed: MarkdownNode[] = [];
  t.mock.method(moduleRuntime, 'renderer', (node: MarkdownNode) => { observed.push(node); return undefined; });
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

test('the existing parser retains native block elements without extra prose wrappers or edge metadata', () => {
  for (const [body, expected] of [
    ['Before\n\nAfter', /<p class="markdown-paragraph">After<\/p>/],
    ['Before\n\n# Heading', /<h1>Heading<\/h1>/],
    ['Before\n\n```ts\ncode\n```', /<div class="chat-code-block">/],
    ['Before\n\n| A |\n| --- |\n| B |', /<div class="chat-table-scroll"/],
    ['Before\n\n- Item', /<ul>/],
    ['Before\n\n> Quote', /<blockquote>/],
    ['Before\n\n---', /<hr\/>/],
    ['Before\n\n[unused]: ./file.txt', /<p class="markdown-paragraph">Before<\/p>/],
    ['Before\n\n<div>escaped HTML</div>', /<p class="markdown-paragraph">Before<\/p>/],
  ] as const) {
    const html = renderToStaticMarkup(createElement(MessageBody, { body }));
    assert.match(html, expected, body);
    assert.doesNotMatch(html, /data-markdown-body-end|module-message-decorations/, body);
  }
});

test('real adornments share the existing presentation parent without changing native body markup', async t => {
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: ['first', 'second'].map(id => ({
      id, name: id, version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/${id}/${digest}/api`, entry: `/_modules/assets/${id}/${digest}/entry.js`,
    })), errors: [] }),
    load: async () => ({ activate: ((context => ({
      apiVersion: 2, components: [{ id: 'marker', boundary: 'message', wrap: Base => props => createElement(Base, {
        ...props, adornment: createElement(Fragment, null, props.adornment,
          createElement('span', { 'data-marker': context.moduleId, style: { position: 'absolute' } })),
      }) }],
    }))) satisfies ActivateFrontend }),
    report: assert.fail,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const body = createElement(MessageBody, {
    body: 'First paragraph\n\nFinal paragraph',
    identity: { kind: 'message', role: 'assistant', sessionId: 'session', id: 'native-message' }, complete: true,
  });
  const parent = createElement('div', { className: 'message-speech' }, body);
  const baseline = renderToStaticMarkup(parent);
  const html = renderToStaticMarkup(createElement(ModuleRuntimeProvider, { runtime, children: parent }));
  assert.match(html, /^<div class="message-speech"><div class="message-body">/);
  assert.match(html, /<p class="markdown-paragraph">Final paragraph<\/p><\/div><span data-marker="first"[^>]*><\/span><span data-marker="second"[^>]*><\/span><\/div>$/);
  assert.equal((html.match(/<div\b/g) ?? []).length, 2, 'only the existing parent and actual body');
  assert.equal(html.replace(/<span data-marker="(?:first|second)"[^>]*><\/span>/g, ''), baseline);
});
