import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModuleCatalog, ModuleInstallError, resolveCockpitUserRoot, validateModuleManifest } from './catalog.ts';
import type { ModuleManifest, ModuleSelection } from './catalog.ts';

function manifest(version = '1.0.0'): ModuleManifest {
  return {
    schemaVersion: 1, id: 'assistant', version, name: 'Assistant', description: 'Test module',
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
    roles: [{ id: 'assistant', name: 'Assistant', description: 'A role', instructions: 'roles/assistant.md', skills: ['skills'] }],
  };
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(process.cwd(), '.catalog-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), userRoot = join(root, 'user');
  mkdirSync(join(source, 'roles'), { recursive: true });
  mkdirSync(join(source, 'skills', 'assistant'), { recursive: true });
  writeFileSync(join(source, 'module.json'), JSON.stringify(manifest()));
  writeFileSync(join(source, 'roles', 'assistant.md'), 'Role instructions');
  writeFileSync(join(source, 'skills', 'assistant', 'SKILL.md'), '---\nname: assistant\n---\nInstructions');
  const catalog = new ModuleCatalog({ userRoot, trustedSources: [source] });
  const choice: ModuleSelection[] = [{ moduleId: 'assistant', roleId: 'assistant', version: '1.0.0' }];
  return { root, source, userRoot, catalog, choice };
}

test('strict manifest validates optional capabilities without fake hooks', () => {
  const { roles: _roles, ...plain } = manifest();
  assert.deepEqual(validateModuleManifest(plain), plain);
  assert.deepEqual(validateModuleManifest({ ...plain, sessionLifecycle: {} }).sessionLifecycle, {});
  const hook = { unbind: { entry: 'control.js', args: ['--offline'] } };
  assert.deepEqual(validateModuleManifest({ ...plain, sessionLifecycle: hook }).sessionLifecycle, hook);
  const admission = { canBind: { entry: 'control.js' } };
  assert.deepEqual(validateModuleManifest({ ...plain, sessionLifecycle: admission }).sessionLifecycle, admission);
  const initialize = { initialize: { entry: 'setup.js' } };
  assert.deepEqual(validateModuleManifest({ ...plain, configLifecycle: initialize }).configLifecycle, initialize);
  for (const invalid of [
    { ...plain, schemaVersion: 2 }, { ...plain, id: 'untrusted' },
    { ...plain, configVersion: 0 }, { ...plain, binding: 'wechat' },
    { ...plain, token: 'secret' }, { ...plain, compatibility: { ...plain.compatibility, nodeMajor: 22 } },
    { ...plain, compatibility: { ...plain.compatibility, extra: true } },
    { ...plain, roles: [{ id: 'a', name: 'A', description: 'A', mcp: { a: { command: 'sh' } } }] },
    { ...plain, service: { entry: 'server.js', healthPath: 'https://example.com', versionPath: '/version', drainPath: '/drain' } },
    { ...plain, sessionLifecycle: { deleted: { entry: 'control.js' } } },
    { ...plain, sessionLifecycle: { unbind: true } },
    { ...plain, sessionLifecycle: { unbind: { entry: '../control.js' } } },
    { ...plain, sessionLifecycle: { unbind: { entry: 'control.js', args: ['--token=private'] } } },
    { ...plain, sessionLifecycle: { unbind: { entry: 'control.js', command: 'sh' } } },
    { ...plain, sessionLifecycle: { canBind: { entry: '../escape.js' } } },
    { ...plain, sessionLifecycle: { canBind: { entry: 'control.js', sessionId: 'virtual' } } },
    { ...plain, configLifecycle: { initialize: true } },
    { ...plain, configLifecycle: { initialize: { entry: '../setup.js' } } },
    { ...plain, configLifecycle: { initialize: { entry: 'setup.js', args: ['--token=secret'] } } },
    { ...plain, configLifecycle: { initialize: { entry: 'setup.js', command: 'sh' } } },
    { ...plain, configLifecycle: { migrate: { entry: 'setup.js' } } },
  ]) assert.throws(() => validateModuleManifest(invalid));
});

test('an optional admission entry must exist in the verified module release', t => {
  const { catalog, source } = fixture(t);
  writeFileSync(join(source, 'module.json'), JSON.stringify({
    ...manifest(), sessionLifecycle: { canBind: { entry: 'can-bind.js' } },
  }));
  assert.throws(() => catalog.installFromDirectory(source), /missing/);
  writeFileSync(join(source, 'can-bind.js'), 'process.exitCode = 0;\n');
  assert.equal(catalog.installFromDirectory(source).manifest.sessionLifecycle?.canBind?.entry, 'can-bind.js');
});
test('a declared session unbind entry must exist in the verified release', t => {
  const { catalog, source } = fixture(t);
  writeFileSync(join(source, 'module.json'), JSON.stringify({
    ...manifest(), sessionLifecycle: { unbind: { entry: 'control.js' } },
  }));
  assert.throws(() => catalog.installFromDirectory(source), /missing/);
  writeFileSync(join(source, 'control.js'), 'process.exitCode = 0;\n');
  assert.equal(catalog.installFromDirectory(source).manifest.sessionLifecycle?.unbind?.entry, 'control.js');
});

test('configuration initialization is opt-in and its entry must be in the verified release', t => {
  const { catalog, source } = fixture(t);
  assert.equal(validateModuleManifest(manifest()).configLifecycle, undefined);
  writeFileSync(join(source, 'module.json'), JSON.stringify({
    ...manifest(), configLifecycle: { initialize: { entry: 'setup.js' } },
  }));
  assert.throws(() => catalog.installFromDirectory(source), /missing/);
  writeFileSync(join(source, 'setup.js'), 'process.exitCode = 0;\n');
  assert.equal(catalog.installFromDirectory(source).manifest.configLifecycle?.initialize?.entry, 'setup.js');
});

test('release paths, entry commands, unsafe arguments, and malformed semver are rejected', () => {
  for (const path of ['../escape', '/absolute', 'a/../../b', 'a\\b', 'a//b', './a', 'a/%2e%2e/b', '.cockpit-inventory.json']) {
    assert.throws(() => validateModuleManifest({ ...manifest(), roles: [{ id: 'a', name: 'A', description: 'A', instructions: path }] }));
  }
  for (const version of ['../v', '1', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3/evil']) {
    assert.throws(() => validateModuleManifest({ ...manifest(), version }));
  }
  assert.equal(validateModuleManifest(manifest('1.2.3-beta.1+build.4')).version, '1.2.3-beta.1+build.4');
  for (const config of [{ entry: '/bin/sh' }, { entry: 'run.sh' }, { entry: 'run.js', args: ['/private/token'] },
    { entry: 'run.js', args: ['--config=/private/path'] }, { entry: 'run.js', args: ['$(whoami)'] },
    { entry: 'run.js', args: ['--token=secret'] }]) {
    assert.throws(() => validateModuleManifest({ ...manifest(), roles: [{ id: 'a', name: 'A', description: 'A', mcp: { test: config } }] }));
  }
});

test('root resolution is explicit then environment then home and never cwd', () => {
  const old = process.env.COCKPIT_USER_ROOT;
  try {
    delete process.env.COCKPIT_USER_ROOT;
    assert.equal(resolveCockpitUserRoot(), join(homedir(), '.cockpit'));
    process.env.COCKPIT_USER_ROOT = join(process.cwd(), 'env-root');
    assert.equal(resolveCockpitUserRoot(), join(process.cwd(), 'env-root'));
    assert.equal(resolveCockpitUserRoot('/explicit/root'), '/explicit/root');
    process.env.COCKPIT_USER_ROOT = 'relative';
    assert.throws(() => new ModuleCatalog(), /absolute/);
    assert.throws(() => new ModuleCatalog({ userRoot: '' }), /absolute/);
    assert.throws(() => new ModuleCatalog({ userRoot: 'relative' }), /absolute/);
  } finally {
    if (old === undefined) delete process.env.COCKPIT_USER_ROOT;
    else process.env.COCKPIT_USER_ROOT = old;
  }
});

test('install requires exact host allowlist and creates private separate user-root storage', t => {
  const { source, userRoot, catalog } = fixture(t);
  assert.deepEqual(catalog.list(), []);
  assert.throws(() => new ModuleCatalog({ userRoot }).installFromDirectory(source), /allowlisted/);
  const installed = catalog.installFromDirectory(source);
  assert.equal(installed.release, join(userRoot, 'modules', 'assistant', 'releases', '1.0.0'));
  assert.match(installed.digest, /^[a-f0-9]{64}$/);
  assert.equal(catalog.getInstalled('assistant')?.digest, installed.digest);
  assert.equal(catalog.list()[0]?.selectedVersion, '1.0.0');
  for (const directory of [userRoot, installed.release, catalog.dataDirectory('assistant'), catalog.logsDirectory('assistant')]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(statSync(join(installed.release, 'module.json')).mode & 0o777, 0o600);
  assert.equal(readdirSync(userRoot).includes('.copilot'), false);
});

test('canonical inventory is deterministic; immutable reinstall rejects changed bytes', t => {
  const { catalog, source } = fixture(t);
  const installed = catalog.installFromDirectory(source);
  assert.deepEqual(catalog.installFromDirectory(source, installed.digest), installed);
  assert.throws(() => catalog.installFromDirectory(source, '0'.repeat(64)), /digest mismatch/);
  writeFileSync(join(source, 'roles', 'assistant.md'), 'Changed');
  assert.throws(() => catalog.installFromDirectory(source), /different bytes/);
  assert.equal(readFileSync(join(installed.release, 'roles', 'assistant.md'), 'utf8'), 'Role instructions');
});

test('inventory preserves ordinary dependency paths with spaces without relaxing declared entry paths', t => {
  const { catalog, source } = fixture(t);
  const directory = join(source, 'node_modules/thread-stream/test/dir with spaces');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'fixture.txt'), 'Packaged dependency data');
  const installed = catalog.installFromDirectory(source);
  assert.equal(readFileSync(join(installed.release, 'node_modules/thread-stream/test/dir with spaces/fixture.txt'), 'utf8'),
    'Packaged dependency data');
  assert.equal(catalog.getInstalled('assistant')?.digest, installed.digest);
  assert.throws(() => validateModuleManifest({ ...manifest(), service: {
    entry: 'unreviewed entry.js', healthPath: '/health', versionPath: '/version', drainPath: '/drain',
  } }), /Unsafe relative release path/);
});

test('pre-publication inventory failures are definite failures, not uncertain published installs', t => {
  const { catalog, source } = fixture(t);
  writeFileSync(join(source, 'invalid\nname'), 'Rejected');
  assert.throws(() => catalog.installFromDirectory(source), error =>
    error instanceof ModuleInstallError && error.outcome === 'not-published');
  assert.deepEqual(catalog.list(), []);
});

test('tampering is rejected on getInstalled execution resolution', t => {
  const { catalog, source } = fixture(t);
  const installed = catalog.installFromDirectory(source);
  writeFileSync(join(installed.release, 'roles', 'assistant.md'), 'Changed');
  assert.throws(() => catalog.getInstalled('assistant', '1.0.0'), /integrity mismatch/);
  assert.throws(() => catalog.list(), /integrity mismatch/);
});

test('extra empty directory is also inventory tampering', t => {
  const { catalog, source } = fixture(t);
  const installed = catalog.installFromDirectory(source);
  mkdirSync(join(installed.release, 'extra'));
  assert.throws(() => catalog.getInstalled('assistant'), /integrity mismatch/);
});

test('symlinks, reserved receipt, and missing declared skill files are rejected', t => {
  const { catalog, source, root } = fixture(t);
  symlinkSync(join(root, 'outside'), join(source, 'escape'));
  assert.throws(() => catalog.installFromDirectory(source), /symlink/);
  rmSync(join(source, 'escape'));
  writeFileSync(join(source, '.cockpit-inventory.json'), '{}');
  assert.throws(() => catalog.installFromDirectory(source), /Reserved/);
  rmSync(join(source, '.cockpit-inventory.json'));
  rmSync(join(source, 'skills', 'assistant', 'SKILL.md'));
  assert.throws(() => catalog.installFromDirectory(source), /missing/);
  assert.equal(catalog.list().length, 0);
});

test('special filesystem entries are rejected without blocking', t => {
  const { catalog, source } = fixture(t);
  const command = spawnSync('mkfifo', [join(source, 'pipe')]);
  assert.equal(command.status, 0);
  assert.throws(() => catalog.installFromDirectory(source), /special files/);
});

test('oversized files and package tree depth are bounded and leave no publication', t => {
  const { catalog, source } = fixture(t);
  const large = join(source, 'large.bin');
  writeFileSync(large, '');
  truncateSync(large, 64 * 1024 * 1024 + 1);
  assert.throws(() => catalog.installFromDirectory(source), /oversized/);
  rmSync(large);
  mkdirSync(join(source, ...Array.from({ length: 34 }, () => 'nested')), { recursive: true });
  assert.throws(() => catalog.installFromDirectory(source), /depth limit/);
  assert.deepEqual(catalog.list(), []);
  assert.deepEqual(readdirSync(join(catalog.userRoot, 'modules')), []);
});

test('existing public user root requires explicit permission repair', t => {
  const { catalog, source, userRoot } = fixture(t);
  mkdirSync(userRoot, { mode: 0o755 });
  chmodSync(userRoot, 0o755);
  assert.throws(() => catalog.installFromDirectory(source), /must already be private/);
  assert.deepEqual(readdirSync(userRoot), []);
});

test('symlink user roots never create module files in their target', t => {
  const { root, source } = fixture(t);
  const target = join(root, 'target');
  mkdirSync(target);
  const linked = join(root, 'linked');
  symlinkSync(target, linked);
  assert.throws(() => new ModuleCatalog({ userRoot: linked, trustedSources: [source] }).installFromDirectory(source), /real directory/);
  assert.deepEqual(readdirSync(target), []);
});

test('install update leaves existing selection pinned until setSelected', t => {
  const { catalog, source, choice } = fixture(t);
  catalog.installFromDirectory(source);
  const prepared = catalog.prepareBinding('session-1', choice, 'operation-1');
  catalog.setBinding({ ...prepared, phase: 'applied' }, prepared.revision);
  writeFileSync(join(source, 'module.json'), JSON.stringify(manifest('2.0.0')));
  catalog.installFromDirectory(source);
  assert.equal(catalog.getInstalled('assistant')?.manifest.version, '1.0.0');
  catalog.setSelected('assistant', '2.0.0');
  assert.equal(catalog.getInstalled('assistant')?.manifest.version, '2.0.0');
  assert.equal(catalog.getBinding('session-1')?.selections[0]?.version, '1.0.0');
  const current = catalog.getBinding('session-1')!;
  const next = catalog.prepareBinding('session-1', [{ ...choice[0]!, version: '2.0.0' }], 'operation-2', current.revision);
  assert.equal(next.selections[0]?.version, '1.0.0');
  assert.equal(next.pendingSelections?.[0]?.version, '2.0.0');
  assert.equal(new ModuleCatalog({ userRoot: catalog.userRoot }).getBinding('session-1')?.phase, 'preparing');
  assert.throws(() => catalog.setSelected('assistant', '3.0.0'), /uninstalled/);
});

test('config optimistic revisions, schema version, and secret-free summaries', t => {
  const { catalog, source } = fixture(t);
  catalog.installFromDirectory(source);
  assert.equal(catalog.readConfig('assistant').revision, 0);
  const current = catalog.updateConfig('assistant', { secret: 'never-public', nested: { keep: true } }, 0);
  assert.equal(current.revision, 1);
  assert.throws(() => catalog.updateConfig('assistant', { lost: true }, 0), /Revision conflict/);
  const next = catalog.updateConfig('assistant', { newKey: 42 }, 1);
  assert.deepEqual(next.values, { secret: 'never-public', nested: { keep: true }, newKey: 42 });
  assert.equal(JSON.stringify(catalog.configSummary('assistant')).includes('never-public'), false);
  assert.equal(statSync(catalog.moduleConfigPath('assistant')).mode & 0o777, 0o600);
  assert.throws(() => catalog.readConfig('assistant', 2), /migration/);
  writeFileSync(catalog.moduleConfigPath('assistant'), JSON.stringify({ ...next, schemaVersion: 2 }));
  assert.throws(() => catalog.updateConfig('assistant', { keep: true }, 2), /schemaVersion/);
});

test('host configuration is separate and preserves values', t => {
  const { catalog } = fixture(t);
  const first = catalog.updateHostConfig({ hostOnly: true }, 0);
  catalog.updateHostConfig({ other: 'value' }, first.revision);
  assert.deepEqual(catalog.readHostConfig().values, { hostOnly: true, other: 'value' });
  assert.throws(() => catalog.updateHostConfig({}, 0), /Revision conflict/);
  assert.equal(statSync(catalog.hostConfigPath).mode & 0o777, 0o600);
});

test('partial session records survive reconstruction and reject conflicting operations', t => {
  const { catalog, source, userRoot, choice } = fixture(t);
  catalog.installFromDirectory(source);
  const prepared = catalog.prepareBinding('session-1', choice, 'operation-1');
  assert.deepEqual(prepared.selections, []);
  assert.deepEqual(prepared.pendingSelections, choice);
  const cold = new ModuleCatalog({ userRoot });
  assert.deepEqual(cold.getBinding('session-1'), prepared);
  assert.throws(() => cold.prepareBinding('session-1', choice, 'operation-2'), /Revision conflict/);
  assert.throws(() => cold.prepareBinding('session-1', choice, 'operation-2', prepared.revision), /unfinished/);
  const failed = cold.setBinding({ ...prepared, phase: 'unknown', error: 'Outcome needs inspection' }, prepared.revision);
  assert.equal(failed.revision, 2);
  assert.throws(() => cold.removeBinding('session-1', failed.revision), /unfinished/);
  assert.throws(() => cold.setBinding({ ...failed, phase: 'applied' }, 1), /Revision conflict/);
  const applied = cold.setBinding({ ...failed, phase: 'applied' }, failed.revision);
  assert.equal(applied.revision, 3);
  assert.deepEqual(applied.selections, choice);
  assert.equal(applied.pendingSelections, undefined);
  assert.equal(applied.error, undefined);
  assert.equal(statSync(join(userRoot, 'session-modules', 'session-1.json')).mode & 0o777, 0o600);
  assert.throws(() => cold.getBinding('../escape'), /session ID/);
});

test('binding validates module role and does not persist arbitrary native status', t => {
  const { catalog, source, choice } = fixture(t);
  catalog.installFromDirectory(source);
  assert.throws(() => catalog.prepareBinding('session-1', [{ ...choice[0]!, roleId: 'missing' }], 'op-1'), /does not exist/);
  assert.throws(() => catalog.prepareBinding('session-1', [...choice, ...choice], 'op-1'), /one role/);
  const input = { sessionId: 'session-1', selections: choice, phase: 'applied' as const, operationId: 'op-1', connected: true };
  assert.throws(() => catalog.setBinding(input, 0), /Unknown session binding/);
});

test('uninstall is disable-only, rejects every session reference, retains code/data/config', t => {
  const { catalog, source, choice } = fixture(t);
  const release = catalog.installFromDirectory(source).release;
  catalog.updateConfig('assistant', { value: 'retained' }, 0);
  writeFileSync(join(catalog.dataDirectory('assistant'), 'private-data'), 'retained');
  const prepared = catalog.prepareBinding('session-1', choice, 'op-1');
  assert.throws(() => catalog.uninstall('assistant'), /session reference/);
  const applied = catalog.setBinding({ ...prepared, phase: 'applied' }, prepared.revision);
  catalog.removeBinding('session-1', applied.revision);
  catalog.uninstall('assistant');
  assert.equal(catalog.getInstalled('assistant'), undefined);
  assert.equal(catalog.getInstalled('assistant', '1.0.0')?.release, release);
  assert.equal(catalog.list()[0]?.enabled, false);
  assert.equal(catalog.readConfig('assistant', 1).values.value, 'retained');
  assert.equal(readFileSync(join(catalog.dataDirectory('assistant'), 'private-data'), 'utf8'), 'retained');
});

test('exclusive lock is bounded, never stolen, and released after errors', t => {
  const { catalog, source, userRoot } = fixture(t);
  catalog.installFromDirectory(source);
  const lock = join(userRoot, '.module-catalog.lock');
  writeFileSync(lock, '{"pid":99999999}');
  assert.throws(() => catalog.updateConfig('assistant', {}, 0), /locked/);
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":99999999}');
  rmSync(lock);
  assert.throws(() => catalog.updateConfig('assistant', {}, 99), /Revision conflict/);
  assert.equal(catalog.updateConfig('assistant', {}, 0).revision, 1);
  assert.equal(readdirSync(userRoot).includes('.module-catalog.lock'), false);
});

test('independent catalog instances reject stale writes with no lost values', t => {
  const { catalog, userRoot } = fixture(t);
  const second = new ModuleCatalog({ userRoot });
  const stale = second.readHostConfig();
  catalog.updateHostConfig({ first: 'preserved' }, 0);
  assert.throws(() => second.updateHostConfig({ second: 'lost' }, stale.revision), /Revision conflict/);
  assert.deepEqual(second.readHostConfig().values, { first: 'preserved' });
});

test('session aliases retain committed selections on failed update and promote only on success', t => {
  const { catalog, source, choice } = fixture(t);
  catalog.installFromDirectory(source);
  const initial = catalog.writeSession({
    sessionId: 'session-1', selections: [], pendingSelections: choice, phase: 'preparing', operationId: 'op-1',
  });
  const applied = catalog.writeSession({ ...initial, phase: 'applied' });
  assert.deepEqual(applied.selections, choice);
  writeFileSync(join(source, 'module.json'), JSON.stringify(manifest('2.0.0')));
  catalog.installFromDirectory(source);
  const target = [{ ...choice[0]!, version: '2.0.0' }];
  const update = catalog.prepareBinding('session-1', target, 'op-2', applied.revision);
  const failed = catalog.writeSession({ ...update, phase: 'failed', error: 'Native configuration failed' });
  assert.deepEqual(catalog.getSession('session-1')?.selections, choice);
  assert.deepEqual(catalog.getSession('session-1')?.pendingSelections, target);
  assert.throws(() => catalog.writeSession({ ...failed, selections: target }), /retain the last/);
  assert.throws(() => catalog.writeSession({ ...update, phase: 'applied' }), /Revision conflict/);
  const done = catalog.writeSession({ ...failed, phase: 'applied' });
  assert.deepEqual(done.selections, target);
  assert.equal(done.pendingSelections, undefined);
  assert.equal(done.error, undefined);
});

test('session configRefs permit only named absolute file references, not token contents', t => {
  const { catalog, source, choice, root } = fixture(t);
  catalog.installFromDirectory(source);
  const input = { sessionId: 'session-1', selections: [], pendingSelections: choice,
    phase: 'preparing' as const, operationId: 'op-1' };
  assert.throws(() => catalog.writeSession({ ...input, configRefs: { task: { credential: 'private-token-value' } } }), /absolute paths/);
  assert.throws(() => catalog.writeSession({ ...input, configRefs: { task: { credential: '/a/../credential' } } }), /absolute paths/);
  const refs = { task: { credential: join(root, 'credential.json') } };
  const prepared = catalog.writeSession({ ...input, configRefs: refs });
  assert.deepEqual(catalog.getSession('session-1')?.configRefs, refs);
  assert.throws(() => catalog.writeSession({ ...prepared, schemaVersion: 2 } as unknown as typeof prepared), /schemaVersion/);
  assert.throws(() => catalog.writeSession(input), /Revision conflict/);
});
