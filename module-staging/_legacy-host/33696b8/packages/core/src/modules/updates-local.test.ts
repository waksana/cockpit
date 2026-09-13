import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { inspectModulePackage, ModuleCatalog } from './catalog.ts';
import { writeModuleRecord } from './private-files.ts';
import { ModuleUpdates } from './updates.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(process.cwd(), '.local-module-'));
  t.after(() => rmSync(root, { recursive: true }));
  const source = join(root, 'source'), userRoot = join(root, 'user');
  mkdirSync(source);
  const catalog = new ModuleCatalog({ userRoot, trustedSources: [source] });
  const updates = new ModuleUpdates(catalog, async () => { throw new Error('Local installation must not access the network'); });
  function target(version: string, operationId: string) {
    writeFileSync(join(source, 'module.json'), JSON.stringify({
      schemaVersion: 1, id: 'assistant', version, name: 'Assistant', description: 'Local fixture',
      compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
    }));
    return { moduleId: 'assistant' as const, version, operationId, digest: inspectModulePackage(source).digest };
  }
  return { source, userRoot, catalog, updates, target };
}

test('trusted local installation keeps fixed inventory identity and old IDs never reselect an old release', async t => {
  const f = fixture(t), first = f.target('1.0.0', 'local-first-0001');
  const receipt = await f.updates.installLocal(first, f.source);
  assert.equal(receipt.source, 'local');
  assert.equal(receipt.state, 'succeeded');
  assert.equal(receipt.sha256, first.digest);
  const second = f.target('1.0.1', 'local-second-0001');
  await f.updates.installLocal(second, f.source);
  assert.deepEqual(await f.updates.installLocal(first, f.source), receipt);
  assert.equal(f.catalog.getInstalled('assistant')?.manifest.version, '1.0.1');
  assert.equal(f.updates.get(first.operationId)?.source, 'local');
  assert.equal(existsSync(join(f.userRoot, 'module-updates', first.operationId, 'runtime.zip')), false);
  await assert.rejects(f.updates.install({ moduleId: 'assistant', version: first.version,
    sha256: first.digest, operationId: first.operationId }), /conflict/);
});

test('changed or absent local sources leave a definite receipt without publishing another package', async t => {
  const f = fixture(t), first = f.target('1.0.0', 'local-source-change');
  f.target('1.0.1', 'unused-source-version');
  await assert.rejects(f.updates.installLocal(first, f.source), /no longer matches/);
  assert.equal(f.updates.get(first.operationId)?.state, 'failed');
  assert.equal(f.catalog.getInstalled('assistant'), undefined);
  await assert.rejects(f.updates.installLocal({ ...first, operationId: 'local-missing-source' }), /not configured/);
  assert.equal(f.updates.get('local-missing-source')?.state, 'failed');
});

test('local reconciliation proves inventory and selection without reinstalling or overwriting the old default', async t => {
  const f = fixture(t);
  await f.updates.installLocal(f.target('1.0.0', 'local-known-good'), f.source);
  const next = f.target('1.0.1', 'local-selection-failure');
  const select = f.catalog.setSelected.bind(f.catalog);
  f.catalog.setSelected = () => { throw new Error('Synthetic selection publication interrupted'); };
  await assert.rejects(f.updates.installLocal(next, f.source), /interrupted/);
  f.catalog.setSelected = select;
  assert.equal(f.updates.get(next.operationId)?.state, 'unknown');
  const resolved = await f.updates.reconcile({ moduleId: 'assistant', operationId: next.operationId, confirm: true });
  assert.equal(resolved.state, 'failed');
  assert.equal(f.catalog.getInstalled('assistant')?.manifest.version, '1.0.0');
  assert.equal(f.catalog.getInstalled('assistant', '1.0.1')?.digest, next.digest);
  select('assistant', '1.0.1');
  writeModuleRecord(join(f.userRoot, 'module-updates', 'assistant.json'), { ...resolved, state: 'unknown' });
  assert.equal((await f.updates.reconcile({ moduleId: 'assistant', operationId: next.operationId, confirm: true })).state, 'succeeded');
});

test('local and archive installations share the unresolved-operation fence and publication lock', async t => {
  const f = fixture(t);
  await f.updates.installLocal(f.target('1.0.0', 'local-before-remote'), f.source);
  const next = f.target('1.0.1', 'local-after-remote');
  writeModuleRecord(join(f.userRoot, 'module-updates', 'assistant.json'), {
    moduleId: 'assistant', version: '1.0.1', sha256: 'a'.repeat(64),
    operationId: 'remote-unconfirmed', state: 'unknown', updatedAt: 1,
  });
  await assert.rejects(f.updates.installLocal(next, f.source), /unfinished or unknown/);
  assert.equal(f.catalog.getInstalled('assistant')?.manifest.version, '1.0.0');
  writeFileSync(join(f.userRoot, 'module-updates', 'assistant.lock'), 'owned fixture claim', { mode: 0o600, flag: 'wx' });
  await assert.rejects(f.updates.installLocal(next, f.source), /EEXIST/);
});
