import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Attachment, UploadedFile } from '@cockpit/protocol';
import { SessionDraft, stagedAttachments } from './attachmentSend';
import { sendThreadDraft } from './draft';

const file: UploadedFile = {
  kind: 'file', name: '原始 视频.mp4', mime: 'video/mp4', size: 4,
  path: '/server/private/clip.mp4', url: '/uploads/clip.mp4',
};
const second = { ...file, name: '图.svg', url: '/uploads/image.svg', kind: 'image' as const, mime: 'image/svg+xml' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}

test('concurrent uploads keep selection order; removing one never invalidates another', async () => {
  const draft = new SessionDraft('A');
  const firstUpload = deferred<UploadedFile>();
  const first = draft.addAttachment(new File(['data'], file.name), () => firstUpload.promise);
  await draft.addAttachment(new File(['data'], second.name), async () => second);
  assert.deepEqual(stagedAttachments(draft.getSnapshot()).map(item => item.status), ['uploading', 'ready']);
  assert.equal(await draft.send(async () => true), false);
  draft.removeAttachment(stagedAttachments(draft.getSnapshot())[1].generation);
  firstUpload.resolve(file);
  assert.equal(await first, true);
  assert.deepEqual(stagedAttachments(draft.getSnapshot()).map(item => item.name), [file.name]);
});

test('a failed upload can be retried in place without resending or replacing other attachments', async () => {
  const draft = new SessionDraft('A');
  draft.edit('caption');
  const selected = new File(['data'], file.name);
  assert.equal(await draft.addAttachment(selected, async () => { throw new Error('offline'); }), false);
  draft.addManagedAttachment(second);
  const generation = stagedAttachments(draft.getSnapshot())[0].generation;
  const uploaded = deferred<UploadedFile>();
  const retry = draft.retryAttachment(generation, async actual => {
    assert.equal(actual, selected);
    return uploaded.promise;
  });
  assert.equal(stagedAttachments(draft.getSnapshot())[0].status, 'uploading');
  assert.equal(await draft.send(async () => assert.fail('upload is not ready')), false);
  assert.equal(await draft.retryAttachment(generation), false);
  uploaded.resolve(file);
  assert.equal(await retry, true);
  assert.equal(draft.getSnapshot().text, 'caption');
  assert.deepEqual(stagedAttachments(draft.getSnapshot()).map(item => item.name), [file.name, second.name]);
});

test('multi-send emits ordered safe metadata and clears only acknowledged generations', async () => {
  const draft = new SessionDraft('A');
  draft.edit('caption');
  draft.addManagedAttachment(file);
  draft.addManagedAttachment(second);
  const ack = deferred<boolean>();
  let posted: Attachment[] | undefined;
  const sending = draft.send(async (text, attachment, attachments) => {
    assert.equal(text, 'caption');
    assert.equal(attachment, undefined);
    posted = attachments;
    return ack.promise;
  });
  assert.deepEqual(posted?.map(item => item.name), [file.name, second.name]);
  assert.ok(posted?.every(item => !('path' in item)));
  const firstGeneration = stagedAttachments(draft.getSnapshot())[0].generation;
  draft.removeAttachment(firstGeneration);
  draft.addManagedAttachment(file);
  draft.edit('new caption');
  assert.equal(await draft.send(async () => true), false);
  ack.resolve(true);
  assert.equal(await sending, true);
  assert.equal(draft.getSnapshot().text, 'new caption');
  assert.deepEqual(stagedAttachments(draft.getSnapshot()).map(item => item.name), [file.name]);
});

test('failed multi-send preserves the entire draft across storage restore', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const draft = new SessionDraft('A', storage);
  draft.edit('caption');
  draft.addManagedAttachment(file);
  draft.addManagedAttachment(second);
  assert.equal(await draft.send(async () => false), false);
  const restored = new SessionDraft('A', storage);
  assert.equal(restored.getSnapshot().text, 'caption');
  assert.deepEqual(stagedAttachments(restored.getSnapshot()).map(item => item.name), [file.name, second.name]);
  assert.equal(stagedAttachments(new SessionDraft('B', storage).getSnapshot()).length, 0);
});

test('twenty-file limit includes uploading entries and explicit ask/plan responses never drop arrays', async () => {
  const draft = new SessionDraft('A');
  for (let i = 0; i < 20; i++) assert.equal(draft.addManagedAttachment(file), true);
  assert.equal(draft.addManagedAttachment(second), false);
  let uploads = 0;
  assert.equal(await draft.addAttachment(new File(['x'], 'x'), async () => { uploads++; return file; }), false);
  assert.equal(uploads, 0);
  for (const handlers of [{ askRequestId: 'ask' }, { planRequestId: 'plan' }]) {
    assert.equal(await sendThreadDraft('caption', { ...handlers, onSend: async () => assert.fail('must not dispatch') }, undefined, [file, second]), false);
  }
});
