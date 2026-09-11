import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { OfficialRuntime } from '../runtime.ts';
import { ModuleManager, type ModuleServiceController } from './manager.ts';
import type { ModuleRunnerJob, ModuleRunnerStatus } from './supervisor.ts';

async function fixture(t: test.TestContext, ownership: 'managed' | 'external' = 'managed') {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-manager-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'entry.js'), '// Synthetic service; never launched by this manager test.\n');
  writeFileSync(join(source, 'module.json'), JSON.stringify({
    schemaVersion: 1, id: 'task', version: '1.2.0', name: 'Task', description: 'Synthetic module',
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
    service: { entry: 'entry.js', healthPath: '/health', versionPath: '/version', drainPath: '/drain' },
  }));
  const jobs = new Map<string, ModuleRunnerJob>();
  const calls: string[] = [];
  let actual: ModuleRunnerStatus = { id: 'task', status: 'stopped', owned: false, recoveryRequired: false };
  const services: ModuleServiceController = {
    submit: async command => {
      calls.push('submit');
      const job: ModuleRunnerJob = { schemaVersion: 1, command, phase: 'accepted', step: 'queued',
        acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(command.operationId, job);
      return job;
    },
    job: async id => { calls.push('job'); return jobs.get(id) ?? null; },
    status: async () => { calls.push('status'); return actual; },
  };
  const manager = new ModuleManager({ runtime: new OfficialRuntime(), userRoot: join(root, 'user'),
    sources: { task: source }, services });
  await manager.install('task');
  manager.setConfig({ ...manager.getConfig('task'), values: { ownership, activationEnabled: true } });
  const installed = manager.catalog.getInstalled('task')!;
  calls.length = 0;
  return { manager, calls, installed, source, setActual: (value: ModuleRunnerStatus) => { actual = value; } };
}

test('stop resolves the owned version instead of an unreadable newer selection', async t => {
  const { manager, calls, installed, source, setActual } = await fixture(t);
  const next = JSON.parse(readFileSync(join(source, 'module.json'), 'utf8'));
  writeFileSync(join(source, 'module.json'), JSON.stringify({ ...next, version: '1.3.0' }));
  const newer = manager.catalog.installFromDirectory(source);
  writeFileSync(join(newer.release, 'module.json'), '{"unsupportedFutureManifest":true}');
  setActual({ id: 'task', status: 'running', owned: true, recoveryRequired: false,
    identity: { moduleId: 'task', moduleVersion: installed.manifest.version,
      moduleDigest: installed.digest, instanceId: 'owned-original' } });
  const result = await manager.control({ moduleId: 'task', action: 'stop', operationId: 'stop-owned-old-0001' });
  assert.equal(result.command.action, 'stop');
  assert.deepEqual(calls, ['status', 'submit']);
});

test('manager submits an exact version job, keeps acceptance distinct, and readback cannot replay it', async t => {
  const { manager, calls, installed } = await fixture(t);
  const request = { moduleId: 'task' as const, action: 'start' as const, operationId: 'manager-start-0001',
    version: installed.manifest.version, digest: installed.digest };
  const job = await manager.control(request);
  assert.equal(job.phase, 'accepted');
  assert.deepEqual(job.command, { id: 'task', action: 'start', operationId: request.operationId,
    version: request.version, digest: request.digest });
  assert.equal((await manager.serviceJob(request.operationId))?.phase, 'accepted');
  assert.equal(await manager.serviceJob('missing-operation'), null);
  assert.deepEqual(calls, ['submit', 'job', 'job']);
  await assert.rejects(manager.control({ ...request, digest: 'f'.repeat(64) }), /digest changed/);
  assert.deepEqual(calls, ['submit', 'job', 'job']);
});

test('managed inventory reports runner actual version rather than selected installation, and stopped services can unregister', async t => {
  const { manager, calls, setActual } = await fixture(t);
  setActual({ id: 'task', status: 'running', owned: true, recoveryRequired: false,
    identity: { moduleId: 'task', moduleVersion: '1.1.0', moduleDigest: 'b'.repeat(64), instanceId: 'running-instance' } });
  const task = (await manager.list()).find(module => module.id === 'task')!;
  assert.equal(task.selectedVersion, '1.2.0');
  assert.equal(task.service.version, '1.1.0');
  assert.equal(task.service.digest, 'b'.repeat(64));
  assert.equal(task.service.runner?.owned, true);
  await assert.rejects(manager.uninstall('task'), /running|stop is unconfirmed/);
  setActual({ id: 'task', status: 'stopped', owned: false, recoveryRequired: false });
  await manager.uninstall('task');
  assert.equal(manager.catalog.getInstalled('task'), undefined);
  assert.ok(!calls.includes('submit'));
});

test('external management cannot gain a second service-switch authority', async t => {
  const { manager, installed, calls } = await fixture(t, 'external');
  await assert.rejects(manager.control({ moduleId: 'task', action: 'apply', operationId: 'external-apply-0001',
    version: installed.manifest.version, digest: installed.digest }), /External services/);
  assert.deepEqual(calls, []);
});
