import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeAttachment, NativeAttachmentDescriptor } from './index.ts';
import { ChatMessage, projectNativeAttachments } from './validation.ts';

test('history preserves omitted blobs without relaxing native send input', () => {
  for (const omittedReason of ['too_large', 'asset_unavailable', 'future_reason', undefined]) {
    const input = { type: 'blob', mimeType: 'image/png', displayName: 'Native image', omittedReason };
    const [attachment] = projectNativeAttachments([{ ...input, assetId: 'private', byteLength: 100 }]);
    assert.equal(attachment?.type, 'blob');
    assert.equal(attachment?.displayName, 'Native image');
    assert.ok(attachment?.type === 'blob');
    assert.equal(attachment.data, undefined);
    assert.equal(attachment.omittedReason, omittedReason);
    assert.equal('assetId' in attachment, false);
    assert.equal('byteLength' in attachment, false);
    assert.equal(NativeAttachment.safeParse(attachment).success, false);
    assert.equal(NativeAttachmentDescriptor.safeParse(attachment).success, true);
    assert.equal(ChatMessage.safeParse({
      id: 'event', role: 'user', content: '', timestamp: 1, attachments: [attachment],
    }).success, true);
  }
});

test('complete native attachments remain sendable while invalid descriptors are rejected', () => {
  const input = [
    { type: 'file', path: '/fixture/file', displayName: 'File' },
    { type: 'directory', path: '/fixture', displayName: undefined },
    { type: 'selection', filePath: '/fixture/code', displayName: 'Code', text: 'line', selection: undefined },
    { type: 'blob', data: 'eA==', mimeType: 'text/plain', displayName: 'Inline' },
  ];
  assert.deepEqual(projectNativeAttachments(input), input);
  for (const attachment of input) assert.equal(NativeAttachment.safeParse(attachment).success, true);
  assert.equal(NativeAttachment.safeParse({ ...input[3], omittedReason: 'too_large' }).success, false);
  assert.deepEqual(projectNativeAttachments([
    { type: 'file', path: 12 },
    { type: 'blob', data: 42, mimeType: 'image/png' },
    { type: 'blob', omittedReason: 'too_large' },
  ]), []);
});
