import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainForRestart } from './shutdown.ts';

test('host shutdown waits for native completion', async () => {
  let releaseRuntime!: () => void;
  const runtime = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  let done = false;
  const draining = drainForRestart({ stop: () => runtime }).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  releaseRuntime();
  await draining;
  assert.equal(done, true);
});

test('native shutdown failure remains an explicit failure', async () => {
  await assert.rejects(drainForRestart({
    stop: async () => { throw new Error('runtime still busy'); },
  }), /runtime still busy/);
  await drainForRestart({ stop: async () => {} });
});
