import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { chmod, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { installLocalModule, listInstalledModules, modulePaths, readModuleInstallation, readModuleSettings, selectModule } from './module-install.ts';
import { acquireModuleHostLease } from './module-lifetime.ts';
import { ModuleRoles } from './module-roles.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

const installing = (name: string) => /^\.install-/.test(name);

/** Starts an install in a child that stops at the publication rename, holding the writer lease. */
async function stalledWriter(t: TestContext, hostRoot: string, cwd: string, packagePath: string) {
  const script = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (...args) => {
  if (String(args[0]).includes('/.install-')) { process.send('staged'); setInterval(() => {}, 1000); await new Promise(() => {}); }
  return rename(...args);
};
syncBuiltinESMExports();
const { installLocalModule } = await import(${JSON.stringify(new URL('./module-install.ts', import.meta.url).href)});
await installLocalModule(${JSON.stringify(packagePath)}, { hostRoot: ${JSON.stringify(hostRoot)}, trustLocalCode: true, enable: true });`;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    cwd, env: { ...process.env, HOME: cwd, COCKPIT_HOME: hostRoot }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ended = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; });
  await once(child, 'message');
  return { kill: async () => { child.kill('SIGKILL'); await ended; } };
}

test('every packaged file and directory is flushed before publication, and the publication chain after it', async t => {
  const f = await moduleFixture(t);
  const packagePath = await f.package();
  const events: string[] = [];
  const paths = new WeakMap<object, string>();
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  const open = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    paths.set(handle, String(args[0]));
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); events.push(`sync ${paths.get(handle)}`); };
    return handle;
  });
  const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    events.push(`rename ${String(args[0])} ${String(args[1])}`);
  });
  syncBuiltinESMExports();
  let installed;
  try { installed = await installLocalModule(packagePath, { trustLocalCode: true }); }
  finally { open.mock.restore(); rename.mock.restore(); syncBuiltinESMExports(); }
  const base = dirname(installed.root);
  const publish = events.findIndex(event => event.startsWith('rename ') && event.endsWith(` ${base}`));
  assert.ok(publish > 0, 'Installation must publish by one atomic rename');
  const staging = events[publish]!.split(' ')[1]!;
  const before = new Set(events.slice(0, publish));
  for (const file of ['cockpit.module.json', 'backend.mjs', 'web/index.js', 'web/style.css']) {
    assert.ok(before.has(`sync ${join(staging, 'package', file)}`), `${file} was not flushed before publication`);
  }
  for (const directory of ['install.json', 'package', 'package/web', '']) {
    assert.ok(before.has(`sync ${join(staging, directory)}`), `${directory || 'staging'} was not flushed before publication`);
  }
  const after = new Set(events.slice(publish + 1));
  const paths_ = modulePaths(f.hostRoot);
  for (const directory of [dirname(base), dirname(dirname(base)), paths_.installed, paths_.root, paths_.hostRoot]) {
    assert.ok(after.has(`sync ${directory}`), `${directory} was not flushed after publication`);
  }
});

test('SIGKILL before publication leaves nothing installed, no stale lock and staging that the next writer removes', async t => {
  const f = await moduleFixture(t);
  const packagePath = await f.package();
  const writer = await stalledWriter(t, f.hostRoot, f.root, packagePath);
  const modules = modulePaths(f.hostRoot).root;
  const staged = (await readdir(modules)).filter(installing);
  assert.equal(staged.length, 1);
  // A live writer excludes other writers, but not a running host: writes affect the next start.
  await assert.rejects(installLocalModule(await f.package(moduleEntries('other')), { hostRoot: f.hostRoot, trustLocalCode: true }), /being changed/);
  await assert.rejects(selectModule('fixture', { hostRoot: f.hostRoot, enabled: false }), /being changed/);
  const host = await acquireModuleHostLease(f.hostRoot);
  await host();
  await writer.kill();

  assert.deepEqual(await listInstalledModules(f.hostRoot), []);
  assert.deepEqual((await readModuleSettings(f.hostRoot)).selected, {});
  assert.equal((await readdir(modules)).includes('.lock'), false);
  const result = await installLocalModule(packagePath, { hostRoot: f.hostRoot, trustLocalCode: true });
  assert.deepEqual((await readdir(modules)).filter(installing), [], 'Abandoned staging must be removed under the writer lease');
  await readModuleInstallation('fixture', { version: '1.0.0', digest: result.digest }, f.hostRoot);
});

test('concurrent writers serialize fail-closed; every accepted install is complete', async t => {
  const f = await moduleFixture(t);
  const packages = await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map(id => f.package(moduleEntries(id))));
  const results = await Promise.allSettled(packages.map(path => installLocalModule(path, { hostRoot: f.hostRoot, trustLocalCode: true, enable: true })));
  const accepted = results.filter(result => result.status === 'fulfilled');
  assert.ok(accepted.length >= 1);
  for (const result of results) {
    if (result.status === 'rejected') assert.match(String(result.reason?.message), /being changed/);
  }
  const installed = await listInstalledModules(f.hostRoot);
  assert.equal(installed.length, accepted.length, 'A rejected writer must not publish anything');
  const settings = await readModuleSettings(f.hostRoot);
  for (const value of installed) {
    await readModuleInstallation(value.id, value, f.hostRoot);
    assert.equal(settings.selected[value.id]?.digest, value.digest);
  }
  assert.deepEqual((await readdir(modulePaths(f.hostRoot).root)).filter(name => installing(name) || name === '.lock'), []);
});

test('a partial same-version directory is never treated as installed; reinstalling the identical archive repairs it', async t => {
  const f = await moduleFixture(t);
  const packagePath = await f.package();
  const installed = await installLocalModule(packagePath, { trustLocalCode: true, enable: true });
  const identity = { version: '1.0.0', digest: installed.digest };
  const truncated = join(installed.root, 'backend.mjs');
  await chmod(installed.root, 0o755);
  await chmod(truncated, 0o644);
  await writeFile(truncated, '');
  await chmod(installed.root, 0o555);
  await assert.rejects(readModuleInstallation('fixture', identity), /integrity/);
  await assert.rejects(selectModule('fixture', { enabled: true }), /integrity/);

  const repaired = await installLocalModule(packagePath, { trustLocalCode: true });
  assert.equal(repaired.digest, installed.digest);
  await readModuleInstallation('fixture', identity);
  assert.notEqual((await readFile(truncated, 'utf8')).length, 0);
  const modules = modulePaths(f.hostRoot).root;
  const quarantine = (await readdir(modules)).filter(name => name.startsWith('.quarantine-'));
  assert.equal(quarantine.length, 1, 'The failed directory is kept for inspection, not deleted');
  assert.equal((await lstat(join(modules, quarantine[0]!, 'package', 'backend.mjs'))).size, 0);
  assert.deepEqual((await listInstalledModules()).map(value => value.digest), [installed.digest]);
});

test('session role records are flushed before rename and their directory after it', async t => {
  const f = await moduleFixture(t);
  const events: string[] = [];
  const originalFsync = fsSync.fsyncSync;
  const originalOpen = fsSync.openSync;
  const originalRename = fsSync.renameSync;
  const descriptors = new Map<number, string>();
  const open = t.mock.method(fsSync, 'openSync', (...args: Parameters<typeof fsSync.openSync>) => {
    const fd = originalOpen(...args);
    descriptors.set(fd, String(args[0]));
    return fd;
  });
  const fsync = t.mock.method(fsSync, 'fsyncSync', (fd: number) => { originalFsync(fd); events.push(`fsync ${descriptors.get(fd)}`); });
  const rename = t.mock.method(fsSync, 'renameSync', (...args: Parameters<typeof fsSync.renameSync>) => {
    originalRename(...args);
    events.push(`rename ${String(args[1])}`);
  });
  syncBuiltinESMExports();
  try { new ModuleRoles(f.hostRoot, 'http://127.0.0.1:1', () => []).save('synthetic', []); }
  finally { open.mock.restore(); fsync.mock.restore(); rename.mock.restore(); syncBuiltinESMExports(); }
  const directory = join(f.hostRoot, 'session-roles');
  const file = join(directory, 'synthetic.json');
  const renamed = events.indexOf(`rename ${file}`);
  assert.ok(renamed > 0);
  assert.match(events[renamed - 1]!, new RegExp(`^fsync ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f-]+\\.pending$`));
  assert.ok(events.slice(renamed).includes(`fsync ${directory}`));
  assert.ok(events.slice(renamed).includes(`fsync ${f.hostRoot}`), 'A newly created roles directory must be durable in its parent');
  assert.equal(await readFile(file, 'utf8'), '[]');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.pending')), []);
});
