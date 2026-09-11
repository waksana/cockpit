import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Attachment, ChatMessage } from '@cockpit/protocol';
import { ChatFileCard, FileCard } from './FileCard';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { Thread } from './Thread';
import { FileEntries, Files } from '../pages/Files';

const video: Attachment = { kind: 'file', name: '原始 视频.mp4', url: '/uploads/clip.mp4', mime: 'video/mp4', size: 123 };
const svg: Attachment = { kind: 'image', name: 'diagram.svg', url: '/uploads/diagram.svg', mime: 'image/svg+xml', size: 7 };

test('file cards use native seekable video, inert SVG images, original downloads, and no false document previews', () => {
  const clip = renderToStaticMarkup(createElement(FileCard, { file: video }));
  assert.match(clip, /<video controls="" preload="metadata" src="\/uploads\/clip.mp4"/);
  assert.match(clip, /href="\/uploads\/clip.mp4\?download=1" download="原始 视频.mp4"/);
  assert.match(clip, /video\/mp4 · 123 B/);
  const image = renderToStaticMarkup(createElement(FileCard, { file: svg }));
  assert.match(image, /<img src="\/uploads\/diagram.svg"/);
  assert.doesNotMatch(image, /<svg|<object|<iframe|<script|data:/);
  for (const mime of ['application/pdf', 'text/html', 'image/heic', 'image/tiff']) {
    const html = renderToStaticMarkup(createElement(FileCard, { file: { ...video, mime } }));
    assert.match(html, /下载原文件/);
    assert.doesNotMatch(html, /<img|<video|<iframe|<object/);
  }
});

test('extensionless source-stable uploads use authoritative MIME rather than name or URL suffixes', () => {
  const url = `/uploads/upload-v1-source-${'a'.repeat(64)}`;
  for (const [file, tag] of [[video, 'video'], [svg, 'img']] as const) {
    const html = renderToStaticMarkup(createElement(FileCard, { file: { ...file, url } }));
    assert.ok(html.includes(`src="${url}"`));
    assert.ok(html.includes(`<${tag}`));
    assert.ok(html.includes(`download="${file.name}"`));
  }
});

test('authoritative file cards expose provenance and integrity without leaking local paths', () => {
  const html = renderToStaticMarkup(createElement(FileCard, { file: {
    ...video, path: '/private/original-path.mp4', source: 'weixin', sessionId: 'A', sha256: 'a'.repeat(64),
  } }));
  assert.match(html, /来源与完整性/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /\/private\/original-path/);
});

test('unavailable file entries show explicit errors and URLs without download, preview, or draft actions', () => {
  const failedUrl = '/uploads/unpublished';
  const error = { url: failedUrl, error: 'Missing or corrupt metadata <sidecar>' };
  const render = (healthy: boolean) => renderToStaticMarkup(createElement(FileEntries, {
    page: { files: healthy ? [{ ...video, path: '/private/clip', size: 123, mime: 'video/mp4' }] : [], hasMore: true, nextOffset: 30, errors: [error] },
    sessionId: 'A', onSelect: () => assert.fail('render must not stage files'),
  }));
  const onlyErrors = render(false);
  assert.match(onlyErrors, /role="status" aria-label="文件不可用"/);
  assert.match(onlyErrors, /\/uploads\/unpublished/);
  assert.match(onlyErrors, /Missing or corrupt metadata &lt;sidecar&gt;/);
  assert.doesNotMatch(onlyErrors, /没有匹配文件|<a\b|<img\b|<video\b|<button\b|download=/);
  const mixed = render(true);
  assert.match(mixed, /\/uploads\/clip.mp4\?download=1/);
  assert.match(mixed, /加入草稿/);
  assert.match(mixed, /文件不可用/);
  assert.doesNotMatch(mixed, /href="\/uploads\/unpublished|\/private\/clip/);
});

test('managed markdown images/links offer one browse card per original URL without nested anchors or duplicate previews', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('render must not fetch'));
  for (const body of [
    '[clip](/uploads/clip.mp4) ![clip](/uploads/clip.mp4)',
    '[![clip](/uploads/clip.mp4)](/uploads/clip.mp4)',
    '![one](/uploads/clip.mp4) ![two](/uploads/clip.mp4)',
    '[![clip](/uploads/clip.mp4)](https://example.com)',
    '[download](/uploads/clip.mp4?download=1)',
  ]) {
    const html = renderToStaticMarkup(createElement(MessageBody, { body, sessionId: 'A' }));
    assert.equal((html.match(/class="chat-file-card"/g) ?? []).length, 1);
    assert.match(html, /\/files\?url=%2Fuploads%2Fclip.mp4&amp;sessionId=A/);
    assert.match(html, /\/uploads\/clip.mp4\?download=1/);
    let anchorDepth = 0;
    for (const tag of html.match(/<\/?a\b[^>]*>/g) ?? []) {
      anchorDepth += tag.startsWith('</') ? -1 : 1;
      assert.ok(anchorDepth >= 0 && anchorDepth <= 1, html);
    }
    assert.equal(anchorDepth, 0);
    assert.doesNotMatch(html, /<img|<video/); // MIME is unknown until the authoritative metadata read.
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('canonical message parts render in order instead of repeating flattened text and legacy attachments', () => {
  const message: ChatMessage = {
    id: 'm', role: 'user', timestamp: 1, content: 'do not repeat', attachment: video,
    parts: [{ type: 'text', text: 'first' }, { type: 'file', attachment: svg }, { type: 'text', text: 'last' }],
  };
  const html = renderToStaticMarkup(createElement(MessageContent, { message, sessionId: 'A' }));
  assert.doesNotMatch(html, /do not repeat|clip.mp4/);
  assert.ok(html.indexOf('first') < html.indexOf('diagram.svg'));
  assert.ok(html.lastIndexOf('diagram.svg') < html.indexOf('last'));
  const repeated = renderToStaticMarkup(createElement(MessageContent, { sessionId: 'A',
    message: { ...message, parts: [{ type: 'file', attachment: svg }, { type: 'text', text: '![again](/uploads/diagram.svg)' }] } }));
  assert.equal((repeated.match(/<img\b/g) ?? []).length, 1);
  assert.equal((repeated.match(/chat-file-card/g) ?? []).length, 1);
});

test('chat reserves media and unknown slots, compact known files, and never loads a video before viewing', () => {
  for (const file of [video, svg, { kind: 'file' as const, name: 'unknown', url: '/uploads/unknown' }]) {
    const html = renderToStaticMarkup(createElement(ChatFileCard, { file }));
    assert.match(html, /data-layout="media"/);
    assert.match(html, /class="chat-file-name"/);
    assert.match(html, /class="chat-file-description"/);
    assert.match(html, /class="chat-file-actions"/);
    assert.match(html, /\/files\?url=/);
    assert.doesNotMatch(html, /<video|autoplay|preload=|aria-expanded/);
    if (file.mime === 'video/mp4') assert.match(html, /<a[^>]+aria-label="查看视频[^"]*"><span class="chat-preview-state">/);
  }
  const document = renderToStaticMarkup(createElement(ChatFileCard, { file: { ...video, mime: 'application/pdf' } }));
  assert.match(document, /data-layout="file"/);
  assert.doesNotMatch(document, /class="chat-file-preview"/);
  const failed = renderToStaticMarkup(createElement(ChatFileCard, {
    file: { kind: 'file', name: 'unavailable', url: '/uploads/missing' }, error: 'Metadata unavailable', onRetry: () => {},
  }));
  assert.match(failed, /data-layout="media"/);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Metadata unavailable/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(failed, /download=|<img|<video/);
});

test('consecutive attachments form grids without moving interleaved text or duplicating Markdown cards', () => {
  const html = renderToStaticMarkup(createElement(MessageContent, { sessionId: 'A', message: {
    id: 'ordered', role: 'user', timestamp: 1, content: '', parts: [
      { type: 'file', attachment: svg }, { type: 'file', attachment: video },
      { type: 'text', text: 'between ![duplicate](/uploads/diagram.svg)' },
      { type: 'file', attachment: { ...svg, url: '/uploads/last.svg' } },
    ],
  } }));
  assert.equal((html.match(/class="chat-attachment-grid"/g) ?? []).length, 2);
  assert.equal((html.match(/class="chat-file-card"/g) ?? []).length, 3);
  assert.ok(html.indexOf('clip.mp4') < html.indexOf('between'));
  assert.ok(html.indexOf('between') < html.indexOf('last.svg'));
  const markdown = renderToStaticMarkup(createElement(MessageBody, { body: '[one](/uploads/one) ![two](/uploads/two)' }));
  assert.match(markdown, /<p class="chat-attachment-grid">/);
});

test('allowed non-managed images reserve their preview slot and linked images never nest anchors', () => {
  for (const image of ['/assets/local.png', 'https://example.com/external.png']) {
    for (const format of ['', '**', '*', '~~']) {
      const html = renderToStaticMarkup(createElement(MessageBody, { body: `[${format}![image](${image})${format}](https://example.com/destination)` }));
      let depth = 0;
      for (const tag of html.match(/<\/?a\b[^>]*>/g) ?? []) {
        depth += tag.startsWith('</') ? -1 : 1;
        assert.ok(depth >= 0 && depth <= 1, html);
      }
      assert.equal(depth, 0);
      assert.match(html, /href="https:\/\/example.com\/destination"/);
      if (image.startsWith('/')) assert.match(html, /class="chat-inline-image"/);
      else {
        assert.match(html, /data-img-blocked/);
        assert.doesNotMatch(html, /<img/);
      }
    }
  }
});

test('internal tool images are neither displayed nor collected before an agent publishes them', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('no automatic tool image collection'));
  const html = renderToStaticMarkup(createElement(Thread, { readOnly: true, onLoadMore: () => {}, session: {
    sessionId: 'A', title: 'Images', cwd: '/fixture', lastActivity: 1,
    status: 'idle', loaded: true, error: null, queue: [], ask: null,
    materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
    messages: [{ id: 'm', role: 'assistant', content: '', timestamp: 1,
      toolCalls: [{ toolCallId: 'tool', name: 'screenshot', title: 'Screenshot', status: 'completed',
        output: 'Internal original: /tmp/not-published.png' }] }],
  } }));
  assert.doesNotMatch(html, /查看图片|保留到文件|<img|blob:/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('global Files route exposes search, bounded browsing, upload and target-session selection without a chat owner', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('SSR must not load resources'));
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/files'] }, createElement(Files)));
  assert.match(html, /搜索文件/);
  assert.match(html, /选择到会话/);
  assert.match(html, /仅显示此会话关联文件/);
  assert.match(html, /type="file"/);
  assert.match(html, /不自动收集工具图片/);
  assert.match(html, /class="manage-header"/);
  assert.match(html, /aria-label="返回会话列表"/);
  assert.match(html, /aria-label="刷新"/);
  assert.match(html, /role="search"/);
  assert.match(html, /type="file" hidden=""/);
  assert.match(html, /class="files-upload rp"/);
  assert.doesNotMatch(html, /全局导航|sidebar-hamburger|type="checkbox"/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('file details have a deterministic parent rather than another global navigation menu', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter,
    { initialEntries: ['/files?url=%2Fuploads%2Fclip.mp4'] }, createElement(Files)));
  assert.match(html, /aria-label="返回文件列表"/);
  assert.match(html, /<h1 class="manage-title">文件详情<\/h1>/);
  assert.doesNotMatch(html, /全局导航|返回会话列表/);
});

test('library empty state and original-file tiles share the designed file surface', () => {
  const empty = renderToStaticMarkup(createElement(FileEntries, {
    page: { files: [], hasMore: false }, onSelect: () => {},
  }));
  assert.match(empty, /class="files-empty"/);
  assert.match(empty, /试试其他文件名或会话范围/);
  const html = renderToStaticMarkup(createElement(FileEntries, {
    page: { files: [{ ...video, path: '/private/clip', mime: 'video/mp4', size: 123 }], hasMore: false },
    onSelect: () => {},
  }));
  assert.match(html, /class="files-tile"/);
  assert.match(html, /class="files-tile-caption"/);
  assert.match(html, /<video controls/);
  assert.doesNotMatch(html, /\/private\/clip/);
});

test('Files search follows the active list URL and is omitted from focused file details', () => {
  for (const [url, value] of [['/files?query=original', 'original'], ['/files', '']] as const) {
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(Files)));
    assert.ok(html.includes(`placeholder="搜索文件名…" value="${value}"`));
  }
  const detail = renderToStaticMarkup(createElement(MemoryRouter,
    { initialEntries: ['/files?url=%2Fuploads%2Fclip.mp4'] }, createElement(Files)));
  assert.doesNotMatch(detail, /role="search"|class="files-intro"|class="files-grid"/);
});
