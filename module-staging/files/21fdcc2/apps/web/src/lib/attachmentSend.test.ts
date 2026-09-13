import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Attachment, UploadedFile } from '@cockpit/protocol';
import { createSessionDrafts, SessionDraft, type SendPrompt } from './attachmentSend';
import { dismissUxError, getUxErrors } from './errorReporter';

const uploaded: UploadedFile = {
  kind: 'file',
  name: 'review & notes.txt',
  url: '/uploads/review.txt',
  path: '/server/private/uploads/review.txt',
  size: 4,
  mime: 'text/plain',
};
const image: UploadedFile = {
  kind: 'image',
  name: 'preview.png',
  url: '/uploads/preview.png',
  path: '/server/private/uploads/preview.png',
  size: 4,
  mime: 'image/png',
};
const attachment: Attachment = {
  kind: 'file',
  name: 'review & notes.txt',
  url: '/uploads/review.txt',
  size: 4,
  mime: 'text/plain',
};
const imageAttachment: Attachment = {
  kind: 'image',
  name: 'preview.png',
  url: '/uploads/preview.png',
  size: 4,
  mime: 'image/png',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function persisted(storage: ReturnType<typeof memoryStorage>, sessionId: string) {
  const value = storage.getItem(`cockpit:composer:${sessionId}`);
  assert.notEqual(value, null);
  return JSON.parse(value!);
}

function file(metadata: UploadedFile = uploaded) {
  return new File(['data'], metadata.name, { type: metadata.mime });
}

async function stage(draft: SessionDraft, metadata: UploadedFile = uploaded) {
  assert.equal(await draft.selectAttachment(file(metadata), async () => metadata), true);
  const staged = draft.getSnapshot().staged;
  assert.equal(staged?.status, 'ready');
  assert.ok(staged?.attachment);
  return staged.attachment;
}

type Outcome = 'success' | 'false' | 'rejection';

function settle(post: ReturnType<typeof deferred<boolean>>, outcome: Outcome) {
  if (outcome === 'rejection') post.reject(new Error('Acknowledgement connection lost'));
  else post.resolve(outcome === 'success');
}

test('first-message acknowledgement survives refresh while a later attachment batch is incomplete', async () => {
  const storage = memoryStorage();
  const options = { persistRevisions: true, associateUploads: false };
  const draft = new SessionDraft('first-message-draft', storage, options);
  draft.edit('first message');
  await stage(draft);
  const submitted = draft.captureSubmission();
  draft.edit('later edit');
  const upload = deferred<UploadedFile>();
  const adding = draft.addAttachments([file(image)], () => upload.promise);
  const laterGeneration = draft.getSnapshot().stagedAttachments![1].generation;

  const restored = new SessionDraft('first-message-draft', storage, options);
  assert.equal(restored.getSnapshot().staged?.generation, submitted.attachments[0].generation);
  restored.acknowledgeSubmission(submitted);
  assert.equal(restored.getSnapshot().text, 'later edit');
  assert.equal(restored.getSnapshot().staged?.generation, laterGeneration);
  assert.equal(restored.getSnapshot().staged?.status, 'failed');
  assert.equal(restored.getSnapshot().staged?.retryable, false);
  assert.equal(restored.getSnapshot().stagedAttachments, undefined);

  upload.resolve(image);
  await adding;
});

test('the registry owns one stable draft per session, independently of subscriptions', () => {
  const getSessionDraft = createSessionDrafts(memoryStorage());
  const original = getSessionDraft('original');
  const other = getSessionDraft('other');
  assert.equal(getSessionDraft('original'), original);
  assert.notEqual(other, original);
  const initial = original.getSnapshot();
  assert.deepEqual(initial, { text: '', revision: 0, pending: false });
  assert.equal(original.getSnapshot(), initial);

  let firstNotifications = 0;
  let secondNotifications = 0;
  const unsubscribeFirst = original.subscribe(() => { firstNotifications++; });
  const unsubscribeSecond = original.subscribe(() => { secondNotifications++; });
  assert.equal(original.getSnapshot(), initial);
  original.edit('first edit');
  assert.deepEqual(original.getSnapshot(), { text: 'first edit', revision: 1, pending: false });
  assert.notEqual(original.getSnapshot(), initial);
  assert.deepEqual(initial, { text: '', revision: 0, pending: false });
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 1);

  unsubscribeFirst();
  original.edit('second edit');
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 2);
  unsubscribeSecond();
  const beforeUnmount = original.getSnapshot();
  assert.equal(getSessionDraft('original').getSnapshot(), beforeUnmount);
  original.edit('unmounted edit');
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 2);

  const remounted = getSessionDraft('original');
  const latest = remounted.getSnapshot();
  const unsubscribeRemount = remounted.subscribe(() => { firstNotifications++; });
  assert.equal(remounted, original);
  assert.equal(remounted.getSnapshot(), latest);
  assert.equal(latest.text, 'unmounted edit');
  assert.equal(latest.revision, 3);
  assert.deepEqual(other.getSnapshot(), { text: '', revision: 0, pending: false });
  remounted.edit('remounted edit');
  assert.equal(firstNotifications, 2);
  unsubscribeRemount();
});

test('same-text input advances the active draft revision without mutating its previous snapshot', () => {
  const draft = new SessionDraft('revision');
  draft.edit('same');
  const previous = draft.getSnapshot();
  draft.edit('same');
  assert.equal(draft.getSnapshot().revision, previous.revision + 1);
  assert.equal(draft.getSnapshot().text, previous.text);
  assert.notEqual(draft.getSnapshot(), previous);
  assert.equal(previous.revision, 1);
});

test('late acknowledgement preserves identical text in another session and newer input after remount', async () => {
  const storage = memoryStorage();
  const drafts = createSessionDrafts(storage);
  const original = drafts('original');
  original.edit('  identical text \n');
  const post = deferred<boolean>();
  const sent: string[] = [];
  const sending = original.send((text) => { sent.push(text); return post.promise; });
  assert.deepEqual(sent, ['identical text']);
  assert.equal(persisted(storage, 'original').text, '  identical text \n');
  const other = drafts('other');
  other.edit('  identical text \n');
  const remounted = drafts('original');
  remounted.edit('typed after remount');
  post.resolve(true);
  assert.equal(await sending, true);
  assert.equal(remounted.getSnapshot().text, 'typed after remount');
  assert.equal(persisted(storage, 'original').text, 'typed after remount');
  assert.equal(other.getSnapshot().text, '  identical text \n');
  assert.equal(persisted(storage, 'other').text, '  identical text \n');
  assert.equal(sent.length, 1);
});

test('invalid cached attachment metadata cannot crash the composer or discard its caption', () => {
  for (const invalid of [
    { ...attachment, name: { bad: 'React child' } },
    { ...attachment, kind: 'unknown' },
    { ...attachment, size: -1 },
    { ...attachment, mime: 'text/plain\nunsafe' },
    { ...attachment, url: '//foreign.example/file.txt' },
    { ...attachment, url: '/uploads/%2e%2e%2fprivate.txt' },
    'not metadata',
  ]) {
    const storage = memoryStorage({
      'cockpit:composer:invalid': JSON.stringify({ version: 1, text: 'preserved caption', attachment: invalid }),
    });
    const draft = new SessionDraft('invalid', storage);
    assert.equal(draft.getSnapshot().text, 'preserved caption');
    assert.equal(draft.getSnapshot().staged, undefined);
  }
});

test('malformed injected upload metadata fails staging without dispatch or losing caption', async () => {
  const draft = new SessionDraft('invalid-upload');
  draft.edit('caption');
  const invalid = { ...uploaded, url: 'https://foreign.example/uploads/file.txt' };
  assert.equal(await draft.selectAttachment(file(), async () => invalid), false);
  assert.equal(draft.getSnapshot().staged?.status, 'failed');
  assert.equal(draft.getSnapshot().staged?.attachment, undefined);
  assert.equal(draft.getSnapshot().text, 'caption');
  assert.equal(await draft.send(async () => { assert.fail('must not send'); }), false);
});

for (const [metadata, expected] of [
  [uploaded, attachment],
  [image, imageAttachment],
] as const) {
  test(`selecting ${metadata.kind} content only uploads and stages safe metadata without a blob preview`, async (t) => {
    const createObjectURL = t.mock.method(URL, 'createObjectURL', () => {
      throw new Error('Local blob previews must not be created');
    });
    const storage = memoryStorage();
    const draft = new SessionDraft('select', storage);
    draft.edit('original caption');
    const upload = deferred<UploadedFile>();
    const selected = file(metadata);
    const events: string[] = [];
    const uploadFile = t.mock.fn((value: File) => {
      assert.equal(value, selected);
      events.push('upload');
      return upload.promise;
    });
    const send = t.mock.fn(async () => {
      events.push('send');
      return true;
    });
    const result = draft.selectAttachment(selected, uploadFile);
    const uploading = draft.getSnapshot();
    assert.deepEqual(uploading.staged, {
      generation: 1,
      kind: metadata.kind,
      name: selected.name,
      size: selected.size,
      status: 'uploading',
    });
    assert.equal(uploading.text, 'original caption');
    assert.equal(uploading.pending, false);
    assert.equal(await draft.send(send), false);
    assert.equal(draft.getSnapshot(), uploading);
    assert.equal(send.mock.callCount(), 0);

    draft.edit('  caption typed during upload \n');
    const revision = draft.getSnapshot().revision;
    upload.resolve({ ...metadata, serverPath: '/not/shared', previewUrl: 'blob:not-shared' } as UploadedFile);
    assert.equal(await result, true);
    const ready = draft.getSnapshot();
    assert.equal(ready.text, '  caption typed during upload \n');
    assert.equal(ready.revision, revision);
    assert.equal(ready.pending, false);
    assert.equal(ready.staged?.status, 'ready');
    assert.equal(ready.staged.generation, uploading.staged.generation);
    assert.deepEqual(ready.staged.attachment, expected);
    assert.equal(Object.hasOwn(ready.staged, 'path'), false);
    assert.deepEqual(persisted(storage, 'select'), {
      version: 1, text: ready.text, attachment: expected, pending: false,
    });
    assert.deepEqual(events, ['upload']);
    assert.equal(uploadFile.mock.callCount(), 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(createObjectURL.mock.callCount(), 0);
    assert.equal(JSON.stringify(ready).includes('blob:'), false);
    assert.equal(JSON.stringify(ready).includes('/server/private'), false);
    assert.equal(JSON.stringify(ready).includes('/not/shared'), false);
  });
}

test('send dispatches the trimmed caption and one attachment reference exactly once', async (t) => {
  const storage = memoryStorage();
  const draft = new SessionDraft('send', storage);
  const caption = ' \n review this file \t ';
  draft.edit(caption);
  const upload = t.mock.fn(async () => uploaded);
  assert.equal(await draft.selectAttachment(file(), upload), true);
  const reference = draft.getSnapshot().staged?.attachment;
  assert.ok(reference);
  const before = draft.getSnapshot();
  const post = deferred<boolean>();
  const dispatch = t.mock.fn<SendPrompt>(() => post.promise);
  const result = draft.send(dispatch);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.deepEqual(dispatch.mock.calls[0].arguments, ['review this file', attachment]);
  assert.equal(dispatch.mock.calls[0].arguments[1], reference);
  assert.equal(Object.hasOwn(reference, 'path'), false);
  assert.equal(draft.getSnapshot().pending, true);
  assert.equal(draft.getSnapshot().text, caption);
  assert.equal(draft.getSnapshot().staged, before.staged);
  assert.equal(persisted(storage, 'send').pending, true);

  post.resolve(true);
  assert.equal(await result, true);
  assert.equal(draft.getSnapshot().text, '');
  assert.equal(draft.getSnapshot().revision, before.revision + 1);
  assert.equal(draft.getSnapshot().staged, undefined);
  assert.equal(draft.getSnapshot().pending, false);
  assert.equal(draft.getSnapshot().error, undefined);
  assert.deepEqual(persisted(storage, 'send'), { version: 1, text: '', pending: false });
  assert.equal(await draft.send(dispatch), false);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.equal(upload.mock.callCount(), 1);
});

test('an attachment-only draft dispatches an empty caption and clears on acknowledgement', async (t) => {
  const draft = new SessionDraft('attachment-only');
  draft.edit(' \n\t ');
  const reference = await stage(draft);
  const post = deferred<boolean>();
  const dispatch = t.mock.fn<SendPrompt>(() => post.promise);
  const result = draft.send(dispatch);
  assert.deepEqual(dispatch.mock.calls[0].arguments, ['', attachment]);
  assert.equal(dispatch.mock.calls[0].arguments[1], reference);
  assert.equal(draft.getSnapshot().staged?.attachment, reference);
  post.resolve(true);
  assert.equal(await result, true);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.equal(draft.getSnapshot().text, '');
  assert.equal(draft.getSnapshot().staged, undefined);
});

test('empty drafts are blocked but text-only drafts send without an attachment', async (t) => {
  const draft = new SessionDraft('text-only');
  const dispatch = t.mock.fn(async () => true);
  assert.equal(await draft.send(dispatch), false);
  draft.edit(' \n ');
  assert.equal(await draft.send(dispatch), false);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.equal(draft.getSnapshot().pending, false);
  draft.edit('  text only \n');
  assert.equal(await draft.send(dispatch), true);
  assert.deepEqual(dispatch.mock.calls[0].arguments, ['text only', undefined]);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.equal(draft.getSnapshot().text, '');
});

for (const outcome of ['false', 'rejection'] as const) {
  test(`send ${outcome} retains the exact caption/reference and only explicit retry reuses the upload`, async (t) => {
    const storage = memoryStorage();
    const draft = new SessionDraft('retry', storage);
    const caption = ' \n exact unsent caption \t ';
    draft.edit(caption);
    const upload = t.mock.fn(async () => uploaded);
    await draft.selectAttachment(file(), upload);
    const before = draft.getSnapshot();
    const post = deferred<boolean>();
    const dispatch = t.mock.fn<SendPrompt>(() => post.promise);
    const result = draft.send(dispatch);
    assert.deepEqual(dispatch.mock.calls[0].arguments, [caption.trim(), attachment]);
    assert.equal(dispatch.mock.calls[0].arguments[1], before.staged?.attachment);
    settle(post, outcome);
    assert.equal(await result, false);
    assert.equal(draft.getSnapshot().text, caption);
    assert.equal(draft.getSnapshot().revision, before.revision);
    assert.equal(draft.getSnapshot().staged, before.staged);
    assert.equal(draft.getSnapshot().pending, false);
    assert.ok(draft.getSnapshot().error);
    assert.equal(dispatch.mock.callCount(), 1);
    assert.equal(upload.mock.callCount(), 1);
    assert.deepEqual(persisted(storage, 'retry'), {
      version: 1, text: caption, attachment, pending: false,
    });

    const retryPost = deferred<boolean>();
    dispatch.mock.mockImplementation(() => retryPost.promise);
    const retry = draft.send(dispatch);
    assert.deepEqual(dispatch.mock.calls[1].arguments, [caption.trim(), attachment]);
    assert.equal(dispatch.mock.calls[1].arguments[1], before.staged?.attachment);
    assert.equal(draft.getSnapshot().pending, true);
    assert.equal(draft.getSnapshot().error, undefined);
    assert.equal(dispatch.mock.callCount(), 2);
    assert.equal(upload.mock.callCount(), 1);
    retryPost.resolve(true);
    assert.equal(await retry, true);
    assert.equal(draft.getSnapshot().text, '');
    assert.equal(draft.getSnapshot().staged, undefined);
    assert.equal(dispatch.mock.callCount(), 2);
    assert.equal(upload.mock.callCount(), 1);
  });
}

for (const outcome of ['success', 'false', 'rejection'] as const) {
  for (const awayAndBack of [false, true]) {
    test(`typing ${awayAndBack ? 'away and back to the submitted value' : 'new text'} survives send ${outcome}`, async () => {
      const draft = new SessionDraft('typing');
      const original = '  original caption \n';
      draft.edit(original);
      const reference = await stage(draft);
      const submittedRevision = draft.getSnapshot().revision;
      const post = deferred<boolean>();
      const result = draft.send(() => post.promise);
      draft.edit('  next caption \n');
      if (awayAndBack) draft.edit(original);
      const latest = draft.getSnapshot();
      assert.ok(latest.revision > submittedRevision);
      settle(post, outcome);

      assert.equal(await result, outcome === 'success');
      assert.equal(draft.getSnapshot().text, awayAndBack ? original : '  next caption \n');
      assert.equal(draft.getSnapshot().revision, latest.revision);
      assert.equal(draft.getSnapshot().staged?.attachment, outcome === 'success' ? undefined : reference);
      assert.equal(draft.getSnapshot().pending, false);
    });
  }

  for (const change of ['remove', 'replace-uploading', 'replace-ready'] as const) {
    test(`${change} during send ${outcome} never restores the old attachment or clears a replacement`, async (t) => {
      const storage = memoryStorage();
      const draft = new SessionDraft('replacement', storage);
      const caption = '  unchanged caption \n';
      draft.edit(caption);
      const reference = await stage(draft);
      const submitted = draft.getSnapshot();
      const post = deferred<boolean>();
      const dispatch = t.mock.fn<SendPrompt>(() => post.promise);
      const result = draft.send(dispatch);
      assert.deepEqual(dispatch.mock.calls[0].arguments, [caption.trim(), attachment]);
      assert.equal(dispatch.mock.calls[0].arguments[1], reference);
      const replacementUpload = deferred<UploadedFile>();
      let replacement: Promise<boolean> | undefined;
      if (change === 'remove') draft.removeAttachment();
      else {
        replacement = draft.selectAttachment(file(image), () => replacementUpload.promise);
        assert.ok(draft.getSnapshot().staged!.generation > submitted.staged!.generation);
        if (change === 'replace-ready') {
          replacementUpload.resolve(image);
          assert.equal(await replacement, true);
        }
      }
      const latest = draft.getSnapshot();
      assert.equal(latest.revision, submitted.revision);
      settle(post, outcome);
      assert.equal(await result, outcome === 'success');
      assert.equal(draft.getSnapshot().text, outcome === 'success' ? '' : caption);
      assert.equal(draft.getSnapshot().staged, latest.staged);
      assert.notEqual(draft.getSnapshot().staged?.attachment, reference);
      assert.equal(draft.getSnapshot().pending, false);

      if (change === 'replace-uploading') {
        replacementUpload.resolve(image);
        assert.equal(await replacement, true);
      }
      assert.deepEqual(draft.getSnapshot().staged?.attachment, change === 'remove' ? undefined : imageAttachment);
      assert.deepEqual(persisted(storage, 'replacement'), {
        version: 1,
        text: outcome === 'success' ? '' : caption,
        ...(change === 'remove' ? {} : { attachment: imageAttachment }),
        pending: false,
      });
    });
  }
}

test('reselecting identical metadata during send is a new generation that acknowledgement cannot clear', async () => {
  const draft = new SessionDraft('identical-replacement');
  const original = await stage(draft);
  const generation = draft.getSnapshot().staged!.generation;
  const post = deferred<boolean>();
  const result = draft.send(() => post.promise);
  const replacement = await stage(draft);
  assert.deepEqual(replacement, original);
  assert.notEqual(replacement, original);
  assert.ok(draft.getSnapshot().staged!.generation > generation);
  post.resolve(true);
  assert.equal(await result, true);
  assert.equal(draft.getSnapshot().staged?.attachment, replacement);
});

test('a text-only acknowledgement cannot clear an attachment selected while pending', async () => {
  const draft = new SessionDraft('new-attachment');
  draft.edit('submitted text');
  const post = deferred<boolean>();
  const result = draft.send(() => post.promise);
  const replacement = await stage(draft);
  post.resolve(true);
  assert.equal(await result, true);
  assert.equal(draft.getSnapshot().text, '');
  assert.equal(draft.getSnapshot().staged?.attachment, replacement);
});

for (const staleOutcome of ['success', 'rejection'] as const) {
  for (const newestFirst of [false, true]) {
    test(`a superseded upload ${staleOutcome} ${newestFirst ? 'after' : 'before'} its replacement is ignored`, async (t) => {
      const draft = new SessionDraft('upload-generation');
      draft.edit('  keep this caption \n');
      const oldUpload = deferred<UploadedFile>();
      const newUpload = deferred<UploadedFile>();
      const oldUploadFile = t.mock.fn(() => oldUpload.promise);
      const newUploadFile = t.mock.fn(() => newUpload.promise);
      const oldResult = draft.selectAttachment(file(), oldUploadFile);
      const oldGeneration = draft.getSnapshot().staged!.generation;
      const newResult = draft.selectAttachment(file(image), newUploadFile);
      assert.ok(draft.getSnapshot().staged!.generation > oldGeneration);
      if (newestFirst) {
        newUpload.resolve(image);
        assert.equal(await newResult, true);
      }
      const latest = draft.getSnapshot();
      const listener = t.mock.fn();
      const unsubscribe = draft.subscribe(listener);
      if (staleOutcome === 'success') oldUpload.resolve(uploaded);
      else oldUpload.reject(new Error('Obsolete upload failed'));
      assert.equal(await oldResult, false);
      assert.equal(draft.getSnapshot(), latest);
      assert.equal(listener.mock.callCount(), 0);
      if (!newestFirst) {
        newUpload.resolve(image);
        assert.equal(await newResult, true);
      }
      assert.equal(draft.getSnapshot().text, '  keep this caption \n');
      assert.equal(draft.getSnapshot().staged?.status, 'ready');
      assert.deepEqual(draft.getSnapshot().staged?.attachment, imageAttachment);
      assert.equal(draft.getSnapshot().error, undefined);
      assert.equal(oldUploadFile.mock.callCount(), 1);
      assert.equal(newUploadFile.mock.callCount(), 1);
      unsubscribe();
    });
  }

  test(`removing a staged upload drops its late ${staleOutcome} without resurrecting metadata`, async (t) => {
    const storage = memoryStorage();
    const draft = new SessionDraft('removed-upload', storage);
    draft.edit('  retained caption \n');
    const upload = deferred<UploadedFile>();
    const result = draft.selectAttachment(file(), () => upload.promise);
    draft.removeAttachment();
    const removed = draft.getSnapshot();
    const listener = t.mock.fn();
    const unsubscribe = draft.subscribe(listener);
    if (staleOutcome === 'success') upload.resolve(uploaded);
    else upload.reject(new Error('Removed upload failed'));
    assert.equal(await result, false);
    assert.equal(draft.getSnapshot(), removed);
    assert.equal(removed.staged, undefined);
    assert.equal(removed.text, '  retained caption \n');
    assert.equal(removed.error, undefined);
    assert.equal(listener.mock.callCount(), 0);
    assert.deepEqual(persisted(storage, 'removed-upload'), {
      version: 1, text: '  retained caption \n', pending: false,
    });
    unsubscribe();
  });
}

test('upload rejection leaves a failed stage and caption, blocks send, and requires explicit reselection', async (t) => {
  const draft = new SessionDraft('failed-upload');
  draft.edit('  caption survives \n');
  const upload = deferred<UploadedFile>();
  const uploadFile = t.mock.fn(() => upload.promise);
  const result = draft.selectAttachment(file(), uploadFile);
  const uploading = draft.getSnapshot();
  upload.reject(new Error('Upload unavailable'));
  assert.equal(await result, false);
  assert.deepEqual(draft.getSnapshot().staged, {
    ...uploading.staged, status: 'failed', error: 'Upload unavailable',
  });
  assert.equal(draft.getSnapshot().text, '  caption survives \n');
  assert.equal(draft.getSnapshot().revision, uploading.revision);
  assert.equal(draft.getSnapshot().pending, false);
  const dispatch = t.mock.fn(async () => true);
  assert.equal(await draft.send(dispatch), false);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.equal(uploadFile.mock.callCount(), 1);
  const replacement = await stage(draft, image);
  assert.deepEqual(replacement, imageAttachment);
  assert.equal(draft.getSnapshot().staged?.error, undefined);
  assert.equal(draft.getSnapshot().text, '  caption survives \n');
});

for (const firstOperation of ['send', 'decision'] as const) {
  test(`pending ${firstOperation} blocks duplicate sends and decisions across remount, but not another session`, async (t) => {
    const getSessionDraft = createSessionDrafts(memoryStorage());
    const original = getSessionDraft('original');
    const other = getSessionDraft('other');
    original.edit('original caption');
    other.edit('other caption');
    const reference = await stage(original);
    const listener = t.mock.fn();
    const unsubscribe = original.subscribe(listener);
    const post = deferred<boolean>();
    const operation = t.mock.fn(() => post.promise);
    const result = firstOperation === 'send' ? original.send(operation) : original.runAction(operation);
    const blocked = t.mock.fn(async () => true);
    assert.equal(original.getSnapshot().pending, true);
    assert.equal(await original.send(blocked), false);
    assert.equal(await original.runAction(blocked), false);
    unsubscribe();
    const notifications = listener.mock.callCount();
    const remounted = getSessionDraft('original');
    assert.equal(remounted, original);
    assert.equal(remounted.getSnapshot().pending, true);
    const remountListener = t.mock.fn();
    const unsubscribeRemount = remounted.subscribe(remountListener);
    assert.equal(await remounted.send(blocked), false);
    assert.equal(await remounted.runAction(blocked), false);
    assert.equal(blocked.mock.callCount(), 0);

    const otherDispatch = t.mock.fn<SendPrompt>(async () => true);
    assert.equal(await other.send(otherDispatch), true);
    assert.deepEqual(otherDispatch.mock.calls[0].arguments, ['other caption', undefined]);
    assert.equal(otherDispatch.mock.callCount(), 1);
    assert.equal(other.getSnapshot().text, '');
    assert.equal(remounted.getSnapshot().pending, true);
    post.resolve(true);
    assert.equal(await result, true);
    assert.equal(operation.mock.callCount(), 1);
    assert.equal(listener.mock.callCount(), notifications);
    assert.ok(remountListener.mock.callCount() > 0);
    assert.equal(remounted.getSnapshot().pending, false);
    assert.equal(remounted.getSnapshot().text, firstOperation === 'send' ? '' : 'original caption');
    assert.equal(remounted.getSnapshot().staged?.attachment, firstOperation === 'send' ? undefined : reference);
    assert.equal(await remounted.runAction(blocked), true);
    assert.equal(blocked.mock.callCount(), 1);
    unsubscribeRemount();
  });
}

for (const outcome of ['false', 'rejection', 'unavailable'] as const) {
  test(`a native decision ${outcome} releases the shared lock and retains the draft`, async (t) => {
    const draft = new SessionDraft('decision-failure');
    draft.edit('decision caption');
    const reference = await stage(draft);
    const post = deferred<boolean>();
    const decision = t.mock.fn(() => outcome === 'unavailable' ? undefined : post.promise);
    const result = draft.runAction(decision);
    assert.equal(draft.getSnapshot().pending, true);
    draft.edit('  newer caption \n');
    if (outcome !== 'unavailable') settle(post, outcome);
    assert.equal(await result, false);
    assert.equal(decision.mock.callCount(), 1);
    assert.equal(draft.getSnapshot().pending, false);
    assert.equal(draft.getSnapshot().text, '  newer caption \n');
    assert.equal(draft.getSnapshot().staged?.attachment, reference);
    assert.ok(draft.getSnapshot().error);
    assert.equal(await draft.send(async () => true), true);
    assert.equal(draft.getSnapshot().error, undefined);
  });
}

for (const operation of ['send', 'decision'] as const) {
  test(`a synchronous ${operation} throw preserves the caption/reference and releases the lock`, async (t) => {
    const draft = new SessionDraft('synchronous-failure');
    const caption = '  exact caption after a throw \n';
    draft.edit(caption);
    const upload = t.mock.fn(async () => uploaded);
    assert.equal(await draft.selectAttachment(file(), upload), true);
    const before = draft.getSnapshot();
    const callback = t.mock.fn(() => { throw new Error('Synchronous dispatch failure'); });
    const result = operation === 'send' ? draft.send(callback) : draft.runAction(callback);
    assert.equal(await result, false);
    assert.equal(draft.getSnapshot().text, caption);
    assert.equal(draft.getSnapshot().revision, before.revision);
    assert.equal(draft.getSnapshot().staged, before.staged);
    assert.equal(draft.getSnapshot().pending, false);
    assert.ok(draft.getSnapshot().error);
    assert.equal(callback.mock.callCount(), 1);
    assert.equal(upload.mock.callCount(), 1);

    const retry = t.mock.fn<SendPrompt>(async () => true);
    assert.equal(await draft.send(retry), true);
    assert.deepEqual(retry.mock.calls[0].arguments, [caption.trim(), attachment]);
    assert.equal(retry.mock.calls[0].arguments[1], before.staged?.attachment);
    assert.equal(retry.mock.callCount(), 1);
    assert.equal(upload.mock.callCount(), 1);
    assert.equal(draft.getSnapshot().text, '');
    assert.equal(draft.getSnapshot().staged, undefined);
    assert.equal(draft.getSnapshot().error, undefined);
  });
}

for (const outcome of ['success', 'false', 'rejection'] as const) {
  test(`route away/back typing before ${outcome} acknowledgement reconciles only the original session`, async (t) => {
    const storage = memoryStorage();
    const getSessionDraft = createSessionDrafts(storage);
    const original = getSessionDraft('original');
    original.edit('submitted caption');
    const reference = await stage(original);
    const post = deferred<boolean>();
    const dispatch = t.mock.fn<SendPrompt>(() => post.promise);
    let active = original;
    const oldListener = t.mock.fn();
    let unsubscribe = active.subscribe(oldListener);
    const result = active.send(dispatch);
    assert.deepEqual(dispatch.mock.calls[0].arguments, ['submitted caption', attachment]);
    assert.equal(dispatch.mock.calls[0].arguments[1], reference);
    unsubscribe();
    const oldNotifications = oldListener.mock.callCount();
    active = getSessionDraft('other');
    active.edit('typing on the other route');
    active = getSessionDraft('original');
    assert.equal(active, original);
    assert.equal(active.getSnapshot().pending, true);
    const remountedListener = t.mock.fn();
    unsubscribe = active.subscribe(remountedListener);
    active.edit('  typed after returning \n');
    const revision = active.getSnapshot().revision;
    unsubscribe();
    const remountedNotifications = remountedListener.mock.callCount();
    active = getSessionDraft('other');
    active.edit('  latest other-session draft \n');
    const otherSnapshot = active.getSnapshot();
    settle(post, outcome);
    assert.equal(await result, outcome === 'success');
    assert.equal(original.getSnapshot().text, '  typed after returning \n');
    assert.equal(original.getSnapshot().revision, revision);
    assert.equal(original.getSnapshot().staged?.attachment, outcome === 'success' ? undefined : reference);
    assert.equal(original.getSnapshot().pending, false);
    assert.equal(active.getSnapshot(), otherSnapshot);
    assert.equal(oldListener.mock.callCount(), oldNotifications);
    assert.equal(remountedListener.mock.callCount(), remountedNotifications);
    assert.equal(dispatch.mock.callCount(), 1);
    assert.equal(persisted(storage, 'original').text, '  typed after returning \n');
    assert.equal(persisted(storage, 'other').text, '  latest other-session draft \n');
  });
}

test('success while unmounted clears unchanged revisions and durably reconciles before remount', async (t) => {
  const storage = memoryStorage();
  const getSessionDraft = createSessionDrafts(storage);
  const draft = getSessionDraft('unmounted-send');
  draft.edit('unchanged caption');
  await stage(draft);
  const revision = draft.getSnapshot().revision;
  const listener = t.mock.fn();
  const unsubscribe = draft.subscribe(listener);
  const post = deferred<boolean>();
  const result = draft.send(() => post.promise);
  assert.equal(persisted(storage, 'unmounted-send').pending, true);
  unsubscribe();
  const notifications = listener.mock.callCount();
  post.resolve(true);
  assert.equal(await result, true);
  assert.equal(listener.mock.callCount(), notifications);
  assert.deepEqual(persisted(storage, 'unmounted-send'), { version: 1, text: '', pending: false });

  const remounted = getSessionDraft('unmounted-send');
  assert.equal(remounted, draft);
  const reconciled = remounted.getSnapshot();
  assert.equal(reconciled.text, '');
  assert.equal(reconciled.revision, revision + 1);
  assert.equal(reconciled.staged, undefined);
  assert.equal(reconciled.pending, false);
  const unsubscribeRemount = remounted.subscribe(() => {});
  assert.equal(remounted.getSnapshot(), reconciled);
  unsubscribeRemount();
  assert.deepEqual(new SessionDraft('unmounted-send', storage).getSnapshot(), {
    text: '', revision: 0, pending: false,
  });
});

for (const remountBeforeCompletion of [false, true]) {
  test(`an upload survives unsubscribe and finishes ${remountBeforeCompletion ? 'after' : 'before'} remount`, async (t) => {
    const storage = memoryStorage();
    const getSessionDraft = createSessionDrafts(storage);
    const draft = getSessionDraft('unmounted-upload');
    draft.edit('caption before upload');
    const listener = t.mock.fn();
    const unsubscribe = draft.subscribe(listener);
    const upload = deferred<UploadedFile>();
    const uploadFile = t.mock.fn(() => upload.promise);
    const result = draft.selectAttachment(file(image), uploadFile);
    const uploading = draft.getSnapshot();
    unsubscribe();
    const notifications = listener.mock.callCount();
    const remountedListener = t.mock.fn();
    let unsubscribeRemount: (() => void) | undefined;
    if (remountBeforeCompletion) {
      const remounted = getSessionDraft('unmounted-upload');
      assert.equal(remounted, draft);
      assert.equal(remounted.getSnapshot(), uploading);
      unsubscribeRemount = remounted.subscribe(remountedListener);
      remounted.edit('  caption after returning \n');
    }
    upload.resolve(image);
    assert.equal(await result, true);
    assert.equal(listener.mock.callCount(), notifications);
    assert.equal(uploadFile.mock.callCount(), 1);
    const ready = draft.getSnapshot();
    const remounted = getSessionDraft('unmounted-upload');
    assert.equal(remounted, draft);
    assert.equal(remounted.getSnapshot(), ready);
    if (!remountBeforeCompletion) unsubscribeRemount = remounted.subscribe(remountedListener);
    assert.equal(ready.staged?.status, 'ready');
    assert.deepEqual(ready.staged.attachment, imageAttachment);
    assert.equal(ready.text, remountBeforeCompletion ? '  caption after returning \n' : 'caption before upload');
    assert.equal(ready.pending, false);
    assert.equal(remountedListener.mock.callCount(), remountBeforeCompletion ? 2 : 0);
    assert.deepEqual(persisted(storage, 'unmounted-upload'), {
      version: 1, text: ready.text, attachment: imageAttachment, pending: false,
    });
    assert.deepEqual(new SessionDraft('unmounted-upload', storage).getSnapshot().staged?.attachment, imageAttachment);
    unsubscribeRemount?.();
  });
}

for (const pending of [false, true]) {
  test(`version 1 storage hydrates caption and path-free metadata with persisted pending=${pending}`, async (t) => {
    const caption = ' \n stored caption is exact \t ';
    const storage = memoryStorage({
      'cockpit:composer:hydrate': JSON.stringify({
        version: 1, text: caption, attachment: { ...uploaded, serverPath: '/not/shared' }, pending,
      }),
      'cockpit:draft:hydrate': 'obsolete legacy caption',
    });
    const draft = new SessionDraft('hydrate', storage);
    assert.equal(storage.getItem('cockpit:draft:hydrate'), null);
    const hydrated = draft.getSnapshot();
    assert.equal(hydrated.text, caption);
    assert.equal(hydrated.revision, 0);
    assert.equal(hydrated.pending, false);
    assert.equal(Boolean(hydrated.error), pending);
    assert.equal(hydrated.staged?.status, 'ready');
    assert.deepEqual(hydrated.staged.attachment, attachment);
    assert.equal(Object.hasOwn(hydrated.staged, 'path'), false);
    assert.equal(JSON.stringify(hydrated).includes('/server/private'), false);
    assert.equal(JSON.stringify(hydrated).includes('/not/shared'), false);
    const post = deferred<boolean>();
    const dispatch = t.mock.fn<SendPrompt>(() => post.promise);
    const result = draft.send(dispatch);
    assert.deepEqual(dispatch.mock.calls[0].arguments, [caption.trim(), attachment]);
    assert.equal(dispatch.mock.calls[0].arguments[1], hydrated.staged.attachment);
    assert.deepEqual(persisted(storage, 'hydrate'), {
      version: 1, text: caption, attachment, pending: true,
    });
    post.resolve(false);
    assert.equal(await result, false);
    assert.equal(dispatch.mock.callCount(), 1);
    assert.equal(draft.getSnapshot().text, caption);
    assert.equal(draft.getSnapshot().staged?.attachment, hydrated.staged.attachment);
    assert.deepEqual(persisted(storage, 'hydrate'), {
      version: 1, text: caption, attachment, pending: false,
    });
  });
}

test('legacy text is removed without reading or migrating it, leaving other storage untouched', (t) => {
  const storage = memoryStorage({
    'cockpit:draft:legacy': 'obsolete caption',
    'cockpit:draft:empty': 'must not revive this',
    'cockpit:draft:other': 'another session',
    'unrelated': 'unrelated value',
    'cockpit:composer:other': 'untouched modern draft',
    'cockpit:composer:empty': JSON.stringify({ version: 1, text: '', pending: false }),
  });
  const read = t.mock.method(storage, 'getItem');
  const write = t.mock.method(storage, 'setItem');
  const remove = t.mock.method(storage, 'removeItem');
  const draft = new SessionDraft('legacy', storage);
  assert.deepEqual(draft.getSnapshot(), { text: '', revision: 0, pending: false });
  assert.deepEqual(read.mock.calls.map(call => call.arguments), [['cockpit:composer:legacy']]);
  assert.equal(write.mock.callCount(), 0, 'discarding old text must not write a modern draft');
  assert.deepEqual(remove.mock.calls.map(call => call.arguments), [['cockpit:draft:legacy']]);
  assert.equal(storage.getItem('cockpit:draft:legacy'), null);
  assert.equal(storage.getItem('cockpit:composer:legacy'), null);
  draft.edit('  new caption \n');
  assert.deepEqual(persisted(storage, 'legacy'), {
    version: 1, text: '  new caption \n', pending: false,
  });
  assert.equal(new SessionDraft('empty', storage).getSnapshot().text, '');
  assert.equal(storage.getItem('cockpit:draft:empty'), null);
  assert.equal(storage.getItem('cockpit:composer:empty'), JSON.stringify({ version: 1, text: '', pending: false }));
  assert.equal(storage.getItem('cockpit:draft:other'), 'another session');
  assert.equal(storage.getItem('cockpit:composer:other'), 'untouched modern draft');
  assert.equal(storage.getItem('unrelated'), 'unrelated value');
});

test('failed legacy removal is redacted and does not prevent restoring the modern caption and attachment', (t) => {
  for (const error of getUxErrors()) dismissUxError(error.id);
  t.after(() => { for (const error of getUxErrors()) dismissUxError(error.id); });
  const logged = t.mock.method(console, 'error', () => {});
  const storage = memoryStorage({
    'cockpit:composer:cleanup-denied': JSON.stringify({ version: 1, text: 'modern caption', attachment, pending: true }),
  });
  const read = t.mock.method(storage, 'getItem');
  t.mock.method(storage, 'removeItem', () => { throw new Error('private storage details'); });
  const draft = new SessionDraft('cleanup-denied', storage);
  assert.equal(draft.getSnapshot().text, 'modern caption');
  assert.deepEqual(draft.getSnapshot().staged?.attachment, attachment);
  assert.equal(draft.getSnapshot().pending, false);
  assert.ok(draft.getSnapshot().error);
  assert.deepEqual(read.mock.calls.map(call => call.arguments), [['cockpit:composer:cleanup-denied']]);
  assert.equal(getUxErrors().length, 1);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(JSON.stringify(logged.mock.calls[0].arguments).includes('private storage details'), false);
  draft.edit('new caption');
  assert.equal(persisted(storage, 'cleanup-denied').text, 'new caption');
});

test('unparseable cached JSON does not prevent in-memory editing and persistence', () => {
  const storage = memoryStorage({ 'cockpit:composer:invalid': '{invalid JSON' });
  const draft = new SessionDraft('invalid', storage);
  assert.deepEqual(draft.getSnapshot(), { text: '', revision: 0, pending: false });
  draft.edit('recovered caption');
  assert.deepEqual(persisted(storage, 'invalid'), {
    version: 1, text: 'recovered caption', pending: false,
  });
});

for (const unavailable of ['missing', 'get-throws', 'set-throws', 'both-throw'] as const) {
  test(`storage ${unavailable} falls back to the same in-memory owner through upload and send`, async (t) => {
    const values = memoryStorage({
      'cockpit:composer:unavailable': JSON.stringify({ version: 1, text: 'hydrated caption', pending: false }),
    });
    const storage = unavailable === 'missing' ? undefined : {
      getItem: (key: string) => {
        if (unavailable === 'get-throws' || unavailable === 'both-throw') throw new Error('Storage access denied');
        return values.getItem(key);
      },
      setItem: (key: string, value: string) => {
        if (unavailable === 'set-throws' || unavailable === 'both-throw') throw new Error('Storage quota exceeded');
        values.setItem(key, value);
      },
      removeItem: values.removeItem,
    };
    const getSessionDraft = storage ? createSessionDrafts(storage) : undefined;
    const draft = getSessionDraft ? getSessionDraft('unavailable') : new SessionDraft('unavailable');
    assert.equal(draft.getSnapshot().text, unavailable === 'set-throws' ? 'hydrated caption' : '');
    const listener = t.mock.fn();
    const unsubscribe = draft.subscribe(listener);
    draft.edit('  in-memory caption \n');
    const reference = await stage(draft);
    const post = deferred<boolean>();
    const result = draft.send(() => post.promise);
    unsubscribe();
    if (getSessionDraft) assert.equal(getSessionDraft('unavailable'), draft);
    draft.edit('  latest in-memory caption \n');
    const notifications = listener.mock.callCount();
    post.resolve(false);
    assert.equal(await result, false);
    assert.equal(draft.getSnapshot().text, '  latest in-memory caption \n');
    assert.equal(draft.getSnapshot().staged?.attachment, reference);
    assert.equal(draft.getSnapshot().pending, false);
    assert.equal(await draft.send(async () => true), true);
    assert.equal(draft.getSnapshot().text, '');
    assert.equal(draft.getSnapshot().staged, undefined);
    assert.equal(listener.mock.callCount(), notifications);
  });
}

test('the default registry uses browser localStorage when available and tolerates its throwing getter', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const storage = memoryStorage({
    'cockpit:composer:browser': JSON.stringify({ version: 1, text: '  browser caption \n', pending: false }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const browserDraft = createSessionDrafts()('browser');
  assert.equal(browserDraft.getSnapshot().text, '  browser caption \n');
  browserDraft.edit('  persisted browser edit \n');
  assert.equal(persisted(storage, 'browser').text, '  persisted browser edit \n');

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new Error('Browser storage disabled'); },
  });
  const getSessionDraft = createSessionDrafts();
  const draft = getSessionDraft('no-browser-storage');
  draft.edit('in-memory browser fallback');
  await stage(draft);
  assert.equal(getSessionDraft('no-browser-storage'), draft);
  assert.equal(await draft.send(async () => true), true);
  assert.equal(draft.getSnapshot().text, '');
  assert.equal(draft.getSnapshot().staged, undefined);
  assert.equal(draft.getSnapshot().pending, false);
});
