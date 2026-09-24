import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { moduleCli } from './module-cli.ts';
import { installLocalModule, moduleDataRoot, modulePaths, readModuleSettings, selectModule } from './module-install.ts';
import { acquireModuleHostLease, acquireModuleLease } from './module-lifetime.ts';
import { migrateModuleId } from './module-migration.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

async function fixture(t: TestContext, targetRoles = [{ id: 'worker', name: 'New worker' }]) {
  const f = await moduleFixture(t);
  const old = await installLocalModule(await f.package(moduleEntries('old-module', undefined, {
    name: 'Old module', roles: [{ id: 'worker', name: 'Old worker' }],
  })), { hostRoot: f.hostRoot, trustLocalCode: true, enable: true });
  const target = await installLocalModule(await f.package(moduleEntries('new-module', undefined, {
    name: 'New module', roles: targetRoles,
  })), { hostRoot: f.hostRoot, trustLocalCode: true });
  await selectModule('old-module', { hostRoot: f.hostRoot, enabled: true, config: { token: 'synthetic-secret', nested: { preserved: [1, 2] } } });
  const paths = modulePaths(f.hostRoot);
  const data = await moduleDataRoot('old-module', f.hostRoot);
  await writeFile(join(data, 'opaque.bin'), Buffer.from([0, 255, 23, 42]));
  const roleRoot = join(f.hostRoot, 'session-roles');
  await mkdir(roleRoot, { mode: 0o700 });
  const roles = [
    { moduleId: 'old-module', moduleName: 'Old module', roleId: 'worker', name: 'Old worker' },
    { moduleId: 'unrelated', moduleName: 'Unrelated', roleId: 'worker', name: 'Unrelated worker' },
  ];
  const roleFile = join(roleRoot, 'synthetic-session.json');
  await writeFile(roleFile, JSON.stringify(roles), { mode: 0o600 });
  const unchanged = join(roleRoot, 'unchanged.json');
  await writeFile(unchanged, JSON.stringify([roles[1]], null, 2), { mode: 0o600 });
  const options = { hostRoot: f.hostRoot, from: 'old-module', to: 'new-module', version: target.manifest.version, digest: target.digest, offline: true };
  const args = ['migrate-id', options.from, options.to, '--version', options.version, '--digest', options.digest, '--offline'];
  return { ...f, old, target, paths, data, roleRoot, roleFile, roles, unchanged, options, args };
}

async function snapshot(root: string): Promise<unknown> {
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), info = await lstat(path);
    entries.push([name, info.mode, info.isDirectory() ? await snapshot(path) : info.isFile() ? (await readFile(path)).toString('base64') : 'link']);
  }
  return entries;
}

test('migration CLI defaults to a secret-free plan without persistent mutation; explicit apply preserves identity/data', async t => {
  const f = await fixture(t);
  const original = await snapshot(f.hostRoot);
  const modified = (await lstat(f.paths.root)).mtimeMs;
  const result = await moduleCli(f.args, { hostRoot: f.hostRoot });
  assert.equal((result as { applied: boolean }).applied, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  assert.deepEqual(await snapshot(f.hostRoot), original);
  assert.equal((await lstat(f.paths.root)).mtimeMs, modified);
  const inode = (await lstat(f.data)).ino;
  const unrelated = await readFile(f.unchanged, 'utf8');
  const configBefore = await readFile(f.paths.config, 'utf8');
  const roleBefore = await readFile(f.roleFile, 'utf8');
  const applied = await migrateModuleId({ ...f.options, mode: 'apply' });
  assert.equal(applied.applied, true);
  assert.equal(applied.changedRoleRecords, 1);
  const settings = await readModuleSettings(f.hostRoot);
  assert.deepEqual(Object.keys(settings.selected), ['new-module']);
  assert.equal(settings.selected['new-module']!.enabled, true);
  assert.deepEqual(settings.selected['new-module']!.config, JSON.parse(configBefore).selected['old-module'].config);
  assert.equal(settings.selected['new-module']!.digest, f.target.digest);
  assert.deepEqual(JSON.parse(await readFile(f.roleFile, 'utf8')), [
    { moduleId: 'new-module', moduleName: 'New module', roleId: 'worker', name: 'New worker' }, f.roles[1],
  ]);
  assert.equal(await readFile(f.unchanged, 'utf8'), unrelated);
  const moved = join(f.paths.data, 'new-module');
  assert.equal((await lstat(moved)).ino, inode);
  assert.deepEqual(await readFile(join(moved, 'opaque.bin')), Buffer.from([0, 255, 23, 42]));
  await assert.rejects(lstat(f.data), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.paths.root, '.migration.json')), { code: 'ENOENT' });
  assert.ok('backup' in applied);
  const backupPath = applied.backup;
  if (typeof backupPath !== 'string') assert.fail('expected migration backup path');
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.settings.before, configBefore);
  assert.equal(backup.roles.find((r: { file: string }) => r.file === 'synthetic-session.json').before, roleBefore);
  assert.equal((await lstat(backupPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(f.paths.root)).mode & 0o777, 0o700);
  await assert.rejects(migrateModuleId({ ...f.options, mode: 'apply' }), /Source module|Destination data root/);
  const release = await acquireModuleHostLease(f.hostRoot);
  await release();
});

test('absent source data is explicit and disabled/config/unrelated selections are preserved', async t => {
  const f = await fixture(t);
  await rm(f.data, { recursive: true });
  await selectModule('old-module', { hostRoot: f.hostRoot, enabled: false });
  const settings = await readModuleSettings(f.hostRoot);
  settings.selected.unrelated = { ...settings.selected['old-module']!, config: { intact: true } };
  await writeFile(f.paths.config, JSON.stringify(settings));
  const result = await migrateModuleId({ ...f.options, mode: 'apply' });
  assert.equal(result.sourceData, 'absent-no-directory-created');
  const after = await readModuleSettings(f.hostRoot);
  assert.equal(after.selected['new-module']!.enabled, false);
  assert.deepEqual(after.selected.unrelated, settings.selected.unrelated);
  await assert.rejects(lstat(join(f.paths.data, 'new-module')), { code: 'ENOENT' });
});

test('all metadata and conflicts are refused before cutover', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>]> = [
    ['selected target', f => selectModule('new-module', { hostRoot: f.hostRoot, enabled: false })],
    ['existing target data', f => mkdir(join(f.paths.data, 'new-module'))],
    ['target role references', f => writeFile(f.roleFile, JSON.stringify([{ ...f.roles[0], moduleId: 'new-module' }]))],
    ['missing target role', f => writeFile(f.roleFile, JSON.stringify([{ ...f.roles[0], roleId: 'missing' }]))],
    ['duplicate source role', f => writeFile(f.roleFile, JSON.stringify([f.roles[0], f.roles[0]]))],
    ['malformed roles', f => writeFile(f.roleFile, '{"invalid":true}')],
    ['unexpected role metadata', f => writeFile(f.roleFile, JSON.stringify([{ ...f.roles[0], unexpected: true }]))],
    ['unexpected role file', f => writeFile(join(f.roleRoot, 'unexpected.pending'), '[]')],
    ['invalid UTF-8 metadata', f => writeFile(f.roleFile, Buffer.concat([Buffer.from('[{"name":"'), Buffer.from([255]), Buffer.from('"}]')]))],
    ['symlink role', async f => { await rm(f.roleFile); await symlink(f.unchanged, f.roleFile); }],
    ['hardlinked role', async f => { await rm(f.roleFile); await link(f.unchanged, f.roleFile); }],
    ['symlink data', async f => { await rm(f.data, { recursive: true }); await symlink(f.roleRoot, f.data); }],
    ['symlink role directory', async f => { await rm(f.roleRoot, { recursive: true }); await symlink(f.data, f.roleRoot); }],
    ['malformed config', f => writeFile(f.paths.config, '{}')],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await mutate(f);
    const before = await snapshot(f.hostRoot);
    await assert.rejects(migrateModuleId({ ...f.options, mode: 'apply' }));
    assert.deepEqual(await snapshot(f.hostRoot), before);
  });
});

test('CLI requires offline acknowledgment, explicit target, and mutually exclusive operations', async t => {
  const f = await fixture(t);
  for (const args of [
    f.args.filter(arg => arg !== '--offline'), ['migrate-id', 'old-module', 'new-module', '--offline'],
    [...f.args, '--apply', '--resume'], [...f.args, '--enable'], [...f.args, '--offline'],
    [...f.args.slice(0, 1), '../old', ...f.args.slice(2)],
  ]) await assert.rejects(moduleCli(args, { hostRoot: f.hostRoot }));
  await assert.rejects(migrateModuleId({ ...f.options, digest: '0'.repeat(64) }));
  const absent = join(f.root, 'missing-host-root');
  await assert.rejects(migrateModuleId({ ...f.options, hostRoot: absent }));
  await assert.rejects(lstat(absent), { code: 'ENOENT' });
  const linked = join(f.root, 'linked-host-root');
  await symlink(f.hostRoot, linked);
  await assert.rejects(acquireModuleHostLease(join(linked, 'must-not-be-created')), /symlink/);
  await assert.rejects(lstat(join(f.hostRoot, 'must-not-be-created')), { code: 'ENOENT' });
});

test('host/startup and migration leases mutually exclude, but abrupt death leaves no stale startup lock', async t => {
  const f = await fixture(t);
  const releaseHost = await acquireModuleHostLease(f.hostRoot);
  await assert.rejects(migrateModuleId(f.options), /in use/);
  await assert.rejects(acquireModuleHostLease(f.hostRoot), /in use/);
  await releaseHost();
  const releaseMigration = await acquireModuleLease(f.hostRoot);
  await assert.rejects(acquireModuleHostLease(f.hostRoot), /in use/);
  await releaseMigration();
  const script = `import { acquireModuleHostLease } from ${JSON.stringify(new URL('./module-lifetime.ts', import.meta.url).href)};
await acquireModuleHostLease(${JSON.stringify(f.hostRoot)}); process.send('leased'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    cwd: f.root, env: { ...process.env, HOME: f.root, COCKPIT_HOME: f.hostRoot },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ended = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; });
  await once(child, 'message');
  await assert.rejects(migrateModuleId(f.options), /in use/);
  child.kill('SIGKILL');
  await ended;
  const restarted = await acquireModuleHostLease(f.hostRoot);
  await restarted();
});

test('partial cutover blocks boot and config writers; explicit same-parameter resume rejects drift then completes', async t => {
  const f = await fixture(t);
  const before = await readFile(f.paths.config, 'utf8');
  await chmod(f.roleRoot, 0o500);
  t.after(() => chmod(f.roleRoot, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  await assert.rejects(migrateModuleId({ ...f.options, mode: 'apply' }), { code: 'EACCES' });
  await chmod(f.roleRoot, 0o700);
  await assert.rejects(lstat(f.data), { code: 'ENOENT' });
  assert.ok(await lstat(join(f.paths.data, 'new-module')));
  assert.equal(await readFile(f.paths.config, 'utf8'), before);
  await assert.rejects(acquireModuleHostLease(f.hostRoot), /pending/);
  await assert.rejects(selectModule('old-module', { hostRoot: f.hostRoot, enabled: false }), /pending/);
  await assert.rejects(installLocalModule(await f.package(moduleEntries('third')), { hostRoot: f.hostRoot, trustLocalCode: true }), /pending/);
  await assert.rejects(migrateModuleId(f.options), /pending/);
  await assert.rejects(migrateModuleId({ ...f.options, version: '2.0.0', mode: 'resume' }), /parameters/);
  const originalRole = await readFile(f.roleFile, 'utf8');
  await writeFile(f.roleFile, '[]');
  await assert.rejects(migrateModuleId({ ...f.options, mode: 'resume' }), /drifted/);
  assert.equal(await readFile(f.paths.config, 'utf8'), before);
  await writeFile(f.roleFile, originalRole);
  const journal = JSON.parse(await readFile(join(f.paths.root, '.migration.json'), 'utf8'));
  const roleAfter = journal.roles.find((role: { file: string }) => role.file === 'synthetic-session.json').after;
  await writeFile(f.roleFile, roleAfter);
  await writeFile(join(f.paths.root, `.migration-staging-${journal.id}`, '.metadata-11111111-1111-1111-1111-111111111111.pending'), 'partial interrupted write');
  const result = await moduleCli([...f.args, '--resume'], { hostRoot: f.hostRoot }) as { applied: boolean };
  assert.equal(result.applied, true);
  const release = await acquireModuleHostLease(f.hostRoot);
  await release();
});

test('SIGKILL during cutover keeps the journal boot fence and leaves no stale writer lock', async t => {
  const f = await fixture(t);
  const script = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (...args) => {
  await rename(...args);
  if (args[0] === ${JSON.stringify(f.data)}) {
    process.send('partial'); setInterval(() => {}, 1000); await new Promise(() => {});
  }
};
syncBuiltinESMExports();
const { migrateModuleId } = await import(${JSON.stringify(new URL('./module-migration.ts', import.meta.url).href)});
await migrateModuleId(${JSON.stringify({ ...f.options, mode: 'apply' })});`;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    cwd: f.root, env: { ...process.env, HOME: f.root, COCKPIT_HOME: f.hostRoot },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ended = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; });
  await once(child, 'message');
  child.kill('SIGKILL');
  await ended;
  await assert.rejects(acquireModuleHostLease(f.hostRoot), /pending/);
  // The kernel released the dead writer's lease: no stale lock needs manual removal.
  await assert.rejects(lstat(join(f.paths.root, '.lock')), { code: 'ENOENT' });
  assert.equal((await migrateModuleId({ ...f.options, mode: 'resume' })).applied, true);
});

test('server entry refuses pending migration before constructing native runtime', async t => {
  const f = await fixture(t);
  await writeFile(join(f.paths.root, '.migration.json'), 'corrupt marker must still block boot');
  const mockSdk = `data:text/javascript,${encodeURIComponent(`
export const approveAll = () => ({kind:'approved'});
export const RuntimeConnection = {forStdio: () => ({kind:'stdio'})};
export class CopilotClient { constructor() { throw new Error('NATIVE_MUST_NOT_BE_CONSTRUCTED'); } }
`)}`;
  const preload = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { return specifier === '@github/copilot-sdk'
? {url:${JSON.stringify(mockSdk)}, shortCircuit:true} : next(specifier, context); }});
`)}`;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload,
    fileURLToPath(new URL('./index.ts', import.meta.url))], {
    cwd: f.root,
    env: { HOME: f.root, COPILOT_HOME: f.root, COCKPIT_HOME: f.hostRoot, COCKPIT_PORT: '0', COCKPIT_SERVE_WEB: '0', PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ended = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; });
  const [code] = await ended;
  assert.equal(code, 1, output);
  assert.match(output, /migration is pending/);
  assert.doesNotMatch(output, /NATIVE_MUST_NOT_BE_CONSTRUCTED/);
});
