import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OfficialRuntime } from '../runtime.ts';
import { ModuleManager } from './manager.ts';

test('official Assistant install uses independent user root and role lifecycle writes no user workspace files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-module-manager-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'AGENTS.md'), 'Existing project instructions\n');
  const runtime = new OfficialRuntime();
  const manager = new ModuleManager({ runtime, userRoot: join(root, 'user') });
  const installed = await manager.install('assistant');
  assert.equal(installed.selectedVersion, '1.0.0');
  assert.deepEqual(readdirSync(cwd), ['AGENTS.md']);
  const release = manager.catalog.getInstalled('assistant')!;
  const skillPath = join(release.release, 'skills/cockpit-assistant/SKILL.md');
  Object.defineProperty(runtime, 'rpc', { get: () => ({
    skills: { discover: async (input: { skillDirectories: string[] }) => ({
      skills: input.skillDirectories.some(directory => directory.startsWith(release.release))
        ? [{ name: 'cockpit-assistant', path: skillPath }] : [],
    }) },
    mcp: { discover: async () => ({ servers: [] }) },
    user: { settings: { get: async () => ({ settings: { disabledSkills: { value: ['unrelated-disabled-skill'] } } }) } },
  }) });
  const choices = [{ moduleId: 'assistant' as const, roleId: 'assistant', version: '1.0.0' }];
  await manager.prepare('synthetic-session', cwd, choices, 'synthetic-operation');
  const prepared = await manager.read('synthetic-session');
  assert.equal(prepared?.phase, 'preparing');
  assert.deepEqual(prepared?.selections, []);
  await assert.rejects(manager.assertReady('synthetic-session'), /preparing/);
  const config = await manager.configuration('synthetic-session', cwd, true);
  assert.equal(config.systemMessage?.mode, 'append');
  assert.deepEqual(config.skillDirectories, [join(release.release, 'skills')]);
  assert.deepEqual(config.disabledSkills, ['unrelated-disabled-skill']);
  const record = manager.catalog.getSession('synthetic-session')!;
  manager.catalog.writeSession({ ...record, phase: 'applied' });
  await manager.assertReady('synthetic-session');
  const cold = await manager.configuration('synthetic-session', cwd, false);
  assert.deepEqual(cold, config);
  await manager.failed('synthetic-session', new Error('Synthetic post-connect failure'));
  const failed = await manager.read('synthetic-session');
  assert.equal(failed?.phase, 'failed');
  assert.deepEqual(failed?.selections, choices);
  await assert.rejects(manager.prepare('synthetic-session', cwd, choices, 'different-operation'), /unfinished/);
  await assert.rejects(manager.uninstall('assistant'), /session reference/);
  assert.deepEqual(readdirSync(cwd), ['AGENTS.md']);
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), 'Existing project instructions\n');
});

test('module config validates references and revisions, retains backups, and cannot silently take over an external service', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-module-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new ModuleManager({ runtime: new OfficialRuntime(), userRoot: root });
  const initial = manager.getConfig('task');
  const first = manager.setConfig({ ...initial, values: { ownership: 'external',
    serviceUrl: 'http://127.0.0.1:8790', credentialDirectory: join(root, 'existing-credentials') } });
  assert.equal(first.revision, 1);
  const next = manager.setConfig({ ...first, values: { ...first.values, gatewayUrl: 'https://cockpit.invalid' } });
  assert.equal(next.revision, 2);
  assert.equal(JSON.parse(readFileSync(join(root, 'config-backups/task-1.json'), 'utf8')).revision, 1);
  assert.throws(() => manager.setConfig({ ...initial, values: {} }), /authority|Revision conflict/);
  assert.throws(() => manager.setConfig({ ...next, values: { ...next.values, ownership: 'managed' } }), /migration handoff/);
  assert.throws(() => manager.setConfig({ ...next, values: { ...next.values, token: 'do-not-accept' } }), /Unsupported/);
  assert.throws(() => manager.setConfig({ ...next, values: { ...next.values, serviceUrl: 'https://external.invalid' } }), /loopback/);
  assert.equal(manager.getConfig('task').revision, 2);
});
