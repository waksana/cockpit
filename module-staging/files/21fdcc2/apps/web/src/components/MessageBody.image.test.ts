import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isMessageImageSrcAllowed } from '../lib/messageImage'
import { MessageBody } from './MessageBody'

test('allows existing root, current-directory and parent-directory image paths', () => {
  for (const src of [
    '/uploads/1720000000000-deadbeefcafe.png',
    './uploads/photo.png',
    '../uploads/photo.png',
    '../../uploads/photo.png',
    '/uploads/my%20photo.png?size=large#preview',
    '/uploads/%E5%9B%BE%E7%89%87.png',
    '/uploads/photo.png?original=https://external.example/photo.png',
  ]) {
    assert.equal(isMessageImageSrcAllowed(src), true, src)
  }
})

test('rejects network-path references and browser-normalized authority bypasses', () => {
  for (const src of [
    '//external.example/photo.png',
    '///external.example/photo.png',
    '////external.example/photo.png',
    '//user:password@external.example/photo.png',
    '//[::1]/photo.png',
    '/\\external.example/photo.png',
    '\\\\external.example/photo.png',
    '/\t/external.example/photo.png',
    '/\n/external.example/photo.png',
    '/\r/external.example/photo.png',
    '/\r\n\t/external.example/photo.png',
    ' //external.example/photo.png',
    '\t//external.example/photo.png',
    './\\photo.png',
    '../\\photo.png',
  ]) {
    assert.equal(isMessageImageSrcAllowed(src), false, JSON.stringify(src))
  }
})

test('continues rejecting missing sources, absolute URLs and non-allowlisted schemes', () => {
  for (const src of [
    undefined,
    '',
    'photo.png',
    'https://external.example/photo.png',
    'http://external.example/photo.png',
    'HTTPS://external.example/photo.png',
    'https://external.example@cockpit.example/photo.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///photo.png',
    'blob:https://cockpit.example/image-id',
    'mailto:user@example.com',
  ]) {
    assert.equal(isMessageImageSrcAllowed(src), false, JSON.stringify(src))
  }
})

function render(body: string): string {
  return renderToStaticMarkup(createElement(MessageBody, { body }))
}

test('renders relative markdown images with metadata intact', () => {
  for (const src of ['./photo.png', '../photo.png']) {
    const html = render(`![Uploaded photo](${src} "Photo title")`)
    assert.ok(html.includes(`<img src="${src}" alt="Uploaded photo" title="Photo title"`), html)
    assert.doesNotMatch(html, /data-img-blocked/)
  }
})

test('renders external and protocol-relative images only as safe click-through links', () => {
  for (const src of [
    '//external.example/photo.png',
    '///external.example/photo.png',
    'https://external.example/photo.png',
  ]) {
    const html = render(`![External photo](${src})`)
    assert.doesNotMatch(html, /<img\b|rel="preload"/)
    assert.ok(html.includes(`href="${src}"`), html)
    assert.match(html, /target="_blank"/)
    assert.match(html, /rel="noopener noreferrer"/)
    assert.match(html, /data-img-blocked/)
    assert.match(html, /\[image blocked: External photo\]/)
  }
})

test('keeps react-markdown sanitization for dangerous image URLs and links', () => {
  for (const src of ['javascript:alert%281%29', 'data:image/png;base64,AAAA', 'file:///photo.png']) {
    const html = render(`![Unsafe image](${src})`)
    assert.doesNotMatch(html, /<img\b|rel="preload"/)
    assert.ok(!html.includes(src), html)
    assert.match(html, /data-img-blocked/)
    assert.match(html, /\[image blocked: Unsafe image\]/)
  }
  assert.doesNotMatch(render('[Unsafe link](javascript:alert%281%29)'), /javascript:/)
})

test('preserves ordinary attachment and external markdown links', () => {
  for (const href of ['/uploads/report.pdf', 'https://external.example/report.pdf']) {
    const html = render(`[Download report](${href})`)
    assert.ok(html.includes(`href="${href}${href.startsWith('/uploads/') ? '?download=1' : ''}"`), html)
    if (!href.startsWith('/uploads/')) assert.match(html, /target="_blank" rel="noopener noreferrer"/)
    assert.match(html, />Download report<\/a>/)
    assert.doesNotMatch(html, /data-img-blocked/)
  }
})
