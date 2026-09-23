import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeAttachmentDescriptor } from '@cockpit/protocol';
import { MessageContent } from './MessageContent';

test('native blob attachments have a safe basic fallback without a file renderer', () => {
  const render = (attachment: NativeAttachmentDescriptor) => renderToStaticMarkup(createElement(MessageContent, {
    message: {
      id: 'event', role: 'user', content: '', timestamp: 1, attachments: [attachment],
      origin: { sessionId: 'fixture', messageId: 'event' },
    },
  }));
  const omitted = render({ type: 'blob', mimeType: 'image/png', displayName: '<image>', omittedReason: 'too_large' });
  assert.match(omitted, /&lt;image&gt;/);
  assert.match(omitted, /附件不可用.*超出大小限制/);
  assert.match(render({ type: 'blob', mimeType: 'image/png', omittedReason: 'asset_unavailable' }), /资源不可用/);
  assert.match(render({ type: 'blob', mimeType: 'image/png' }), /附件不可用/);
  const complete = render({ type: 'blob', data: 'eA==', mimeType: 'text/plain', displayName: 'Inline' });
  assert.match(complete, /Inline/);
  assert.doesNotMatch(complete, /不可用|eA==/);
});
