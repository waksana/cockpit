import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { writeModuleRecord } from './private-files.ts';
import { OwnedModuleLifecycle } from './owned-lifecycle.ts';
import { ModuleRunnerClient } from './supervisor.ts';

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(process.cwd(), '.ol-'));
  const userRoot = join(root, 'user');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return userRoot;
}

test('server-owned runner restores only the captured empty plan and cold-starts with the next generation', async t => {
  const userRoot = fixture(t);
  const first = new OwnedModuleLifecycle({ userRoot, cockpitUrl: 'http://127.0.0.1:1', startupTimeoutMs: 5000 });
  assert.deepEqual(await first.startAfterReady(), {
    enabled: true, state: 'restored', runnerReady: true, controlsRestored: true,
    operationId: first.status().operationId, services: [],
  });
  assert.equal((await new ModuleRunnerClient({ userRoot }).status('task')).status, 'stopped');
  await first.prepareExit();
  assert.equal(first.status().state, 'captured');
  assert.equal(existsSync(join(userRoot, '.module-runner.sock')), false);

  const second = new OwnedModuleLifecycle({ userRoot, cockpitUrl: 'http://127.0.0.1:1', startupTimeoutMs: 5000 });
  const restored = await second.startAfterReady();
  assert.equal(restored.state, 'restored');
  assert.equal(restored.controlsRestored, true);
  assert.deepEqual(restored.services, []);
  await second.prepareExit();
});

test('a prior unclosed restored generation is exposed as unknown and never replayed under a new ID', async t => {
  const userRoot = fixture(t);
  writeModuleRecord(join(userRoot, '.module-runner', 'owned-host-lifecycle.json'), {
    schemaVersion: 1, state: 'restored', generationId: randomUUID(),
    operationId: `host-old-${randomUUID()}`, services: [], updatedAt: new Date().toISOString(),
  });
  const lifecycle = new OwnedModuleLifecycle({ userRoot, cockpitUrl: 'http://127.0.0.1:1', startupTimeoutMs: 5000 });
  const status = await lifecycle.startAfterReady();
  assert.equal(status.state, 'unknown');
  assert.equal(status.runnerReady, true);
  assert.equal(status.controlsRestored, false);
  assert.match(status.error!, /never automatically replayed/);
  await assert.rejects(new ModuleRunnerClient({ userRoot }).submit({
    operationId: 'blocked-control-0001', id: 'task', action: 'start',
    version: '1.0.0', digest: 'a'.repeat(64),
  }), /initial restoration/);
  await lifecycle.prepareExit();
  assert.equal(lifecycle.status().state, 'unknown');
  assert.equal(existsSync(join(userRoot, '.module-runner.sock')), false);
});
