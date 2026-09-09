import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDirectory } from './directoryResource';
import { createKeyedAsync } from './keyedAsync';

test('unspecified initial directory asks the backend for its actual home', async () => {
  const requested: Array<string | undefined> = [];
  const listing = { path: '/actual/server/home', parent: '/actual/server', entries: [] };
  const result = await readDirectory(async (path) => { requested.push(path); return listing; });
  assert.deepEqual(requested, [undefined]);
  assert.equal(result, listing);
});

test('a chosen directory is sent unchanged and the canonical backend path is used', async () => {
  const listing = await readDirectory(async (path) => {
    assert.equal(path, '~/project');
    return { path: '/actual/server/home/project', parent: '/actual/server/home', entries: [] };
  }, '~/project');
  assert.equal(listing.path, '/actual/server/home/project');
});

test('listing failures and missing canonical paths reject rather than producing an empty directory', async () => {
  await assert.rejects(readDirectory(async () => { throw new Error('Access denied'); }), /Access denied/);
  await assert.rejects(readDirectory(async () => ({ path: ' ', parent: null, entries: [] })), /有效的工作目录/);
});

test('an async picker callback cannot close the dialog on failure or before acknowledgement', async () => {
  const task = createKeyedAsync<void>('directory:/actual/home', () => ({ connState: 'open', connectionGeneration: 1 }));
  task.activate();
  let reject!: (error: Error) => void;
  let closed = 0;
  const failed = task.run(() => new Promise<void>((_resolve, no) => { reject = no; }), () => { closed++; }, true);
  assert.equal(task.getSnapshot().pending, true);
  assert.equal(closed, 0);
  reject(new Error('Session creation failed'));
  await failed;
  assert.equal(closed, 0);
  assert.equal(task.getSnapshot().error, 'Session creation failed');
  await task.run(async () => {}, () => { closed++; }, true);
  assert.equal(closed, 1);
});
