import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainForRestart } from './shutdown.ts';

test('restart waits for native shutdown and pending notification delivery', async () => {
  let releaseRuntime!: () => void;
  let releasePush!: () => void;
  const runtime = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const push = new Promise<void>((resolve) => { releasePush = resolve; });
  let done = false;
  const draining = drainForRestart({ stop: () => runtime }, new Set([push])).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  releaseRuntime();
  await Promise.resolve();
  assert.equal(done, false);
  releasePush();
  await draining;
  assert.equal(done, true);
});

test('native shutdown failure rejects, while an already-reported push failure does not strand restart', async () => {
  await assert.rejects(drainForRestart({
    stop: async () => { throw new Error('runtime still busy'); },
  }, new Set()), /runtime still busy/);
  const failed = Promise.reject(new Error('push service unavailable'));
  void failed.catch(() => {});
  await drainForRestart({ stop: async () => {} }, new Set([failed]));
});
