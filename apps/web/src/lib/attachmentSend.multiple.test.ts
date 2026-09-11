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
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
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

test('batch validation rejects the entire selection before uploads or generation changes', async () => {
  const draft = new SessionDraft('A');
  draft.edit('keep caption');
  const valid = new File(['x'], 'valid.txt');
  const large = new File(['x'], 'large.mp4');
  Object.defineProperty(large, 'size', { value: 25 * 1024 * 1024 + 1 });
  for (const invalid of [large, new File([], 'empty.txt')]) {
    assert.equal(await draft.addAttachments([valid, invalid], async () => assert.fail('no uploads')), false);
    assert.equal(stagedAttachments(draft.getSnapshot()).length, 0);
    assert.match(draft.getSnapshot().error!, /本批未添加/);
  }
  for (let i = 0; i < 19; i++) draft.addManagedAttachment(file);
  const before = stagedAttachments(draft.getSnapshot());
  assert.equal(await draft.addAttachments([valid, valid], async () => assert.fail('no uploads')), false);
  assert.deepEqual(stagedAttachments(draft.getSnapshot()), before);
  assert.equal(draft.getSnapshot().text, 'keep caption');
});

test('one mixed batch reserves every slot and never sends in upload completion order', async () => {
  const draft = new SessionDraft('A');
  const pending = [deferred<UploadedFile>(), deferred<UploadedFile>(), deferred<UploadedFile>()];
  const files = ['a.png', 'b.mp4', 'c.txt'].map(name => new File(['data'], name));
  let index = 0;
  const adding = draft.addAttachments(files, async () => pending[index++].promise);
  assert.equal(stagedAttachments(draft.getSnapshot()).length, 3);
  assert.equal(await draft.send(async () => assert.fail('upload pending')), false);
  for (const i of [2, 1, 0]) {
    pending[i].resolve({ ...file, name: files[i].name });
    await Promise.resolve();
  }
  assert.equal(await adding, true);
  assert.equal(await draft.send(async (_text, _attachment, attachments) => {
    assert.deepEqual(attachments?.map(item => item.name), files.map(item => item.name));
    return true;
  }), true);
});

test('unnamed clipboard files get a display name without inferring a MIME from extensions', async () => {
  const draft = new SessionDraft('A');
  await draft.addAttachments([new File(['data'], '', { type: 'video/mp4' })], async selected => {
    assert.match(selected.name, /^attachment-/);
    assert.equal(selected.type, 'video/mp4');
    return { ...file, name: selected.name };
  });
  assert.equal(stagedAttachments(draft.getSnapshot())[0].status, 'ready');
});

test('upload retries keep source identity but intentional repeat selections get new identities', async t => {
  const requests: URL[] = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async input => {
    requests.push(new URL(String(input), 'http://fixture.test'));
    if (fail) { fail = false; throw new Error('lost upload response'); }
    return Response.json(file);
  });

  test('refresh retains incomplete slots as explicit failures instead of silently sending only ready files', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const draft = new SessionDraft('A', storage);
    const upload = deferred<UploadedFile>();
    const adding = draft.addAttachment(new File(['data'], 'still-uploading.txt'), () => upload.promise);
    draft.addManagedAttachment(file);
    const restored = new SessionDraft('A', storage);
    const slots = stagedAttachments(restored.getSnapshot());
    assert.deepEqual(slots.map(item => item.status), ['failed', 'ready']);
    assert.equal(slots[0].retryable, false);
    assert.match(slots[0].error!, /重新选择/);
    assert.equal(await restored.send(async () => assert.fail('must retain incomplete slot')), false);
    upload.resolve(file);
    await adding;
  });
  const draft = new SessionDraft('original-session');
  const selected = new File(['data'], file.name);
  assert.equal(await draft.addAttachment(selected), false);
  await draft.retryAttachment(stagedAttachments(draft.getSnapshot())[0].generation);
  await draft.addAttachment(selected);
  const sourceIds = requests.map(url => url.searchParams.get('sourceId'));
  assert.ok(sourceIds.every(Boolean));
  assert.equal(sourceIds[0], sourceIds[1]);
  assert.notEqual(sourceIds[1], sourceIds[2]);
  assert.ok(requests.every(url => url.searchParams.get('sessionId') === 'original-session'));
  assert.equal(stagedAttachments(draft.getSnapshot()).length, 2);
});
