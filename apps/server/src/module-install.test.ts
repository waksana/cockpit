import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { installLocalModule, inspectModuleArchive, listInstalledModules, MODULE_LIMITS, readModuleInstallation, readModuleSettings, selectModule } from './module-install.ts';
import { moduleCli } from './module-cli.ts';
import { archive, moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

test('local package installation requires explicit code trust before reads or writes', async t => {
  const f = await moduleFixture(t);
  await assert.rejects(installLocalModule(join(f.root, 'does-not-exist.tgz'), { trustLocalCode: false }), /--trust-local-code/);
  await assert.rejects(lstat(f.hostRoot), { code: 'ENOENT' });
  await assert.rejects(installLocalModule(f.root, { trustLocalCode: true }), /local .tgz/);
});

test('archive validation rejects traversal, links, special files, ambiguity and unbounded content', () => {
  const good = moduleEntries();
  for (const path of ['../escape', '/absolute', 'x/../../escape', 'x\\escape', 'C:/escape', 'a//b', 'a/./b', '%2e%2e/escape']) {
    assert.throws(() => inspectModuleArchive(archive([...good, { path, content: 'bad' }])), /path/);
  }
  for (const kind of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K']) {
    assert.throws(() => inspectModuleArchive(archive([...good, { path: 'link', kind, link: '/outside' }])), /only regular files/);
  }
  assert.throws(() => inspectModuleArchive(archive([...good, { path: 'backend.mjs', content: 'duplicate' }])), /Duplicate/);
  assert.throws(() => inspectModuleArchive(archive([...good, { path: 'web', content: 'file' }])), /parent directory/);
  assert.throws(() => inspectModuleArchive(archive([...good, { path: 'huge', size: MODULE_LIMITS.file + 1 }])), /entry size/);
  const raw = gunzipSync(archive(good));
  raw[0] = raw[0]! ^ 1;
  assert.throws(() => inspectModuleArchive(gzipSync(raw)), /checksum/);
  assert.throws(() => inspectModuleArchive(gzipSync(gunzipSync(archive(good)).subarray(0, -1024))), /Unterminated/);
  assert.throws(() => inspectModuleArchive(gzipSync(Buffer.concat([gunzipSync(archive(good)), Buffer.from('hidden tar')]))), /terminator/);
  assert.throws(() => inspectModuleArchive(Buffer.alloc(MODULE_LIMITS.archive + 1)), /archive exceeds/);
});

test('manifest and archive identities validate before copying or executing code', async t => {
  const f = await moduleFixture(t);
  const bad = moduleEntries('fixture', `throw new Error("MUST NOT IMPORT");`, { frontend: { entry: 'backend.mjs', assets: ['web'] } });
  await assert.rejects(installLocalModule(await f.package(bad), { trustLocalCode: true }), /declared asset/);
  await assert.rejects(lstat(f.hostRoot), { code: 'ENOENT' });
  assert.throws(() => inspectModuleArchive(archive(moduleEntries('fixture', '', { apiVersion: 2 as 1 }))), /literal/);
  assert.throws(() => inspectModuleArchive(archive(moduleEntries('../evil'))), /Invalid/);
  const prefixed = moduleEntries().map(entry => ({ ...entry, path: `package/${entry.path}` }));
  assert.equal(inspectModuleArchive(archive(prefixed)).manifest.id, 'fixture');
  assert.throws(() => inspectModuleArchive(archive([...prefixed, { path: 'outside', content: 'bad' }])), /Mixed package roots/);
});

test('installation copies immutable files, never runs scripts/imports, and selects only verified identities', async t => {
  const f = await moduleFixture(t);
  const path = await f.package([
    ...moduleEntries('fixture', 'throw new Error("not imported during installation");'),
    { path: 'package.json', content: JSON.stringify({ scripts: { install: 'must-never-run' } }) },
  ]);
  const installed = await installLocalModule(path, { trustLocalCode: true, enable: true });
  assert.match(installed.root, /modules\/installed\/fixture\/1\.0\.0\/[a-f0-9]{64}\/package$/);
  assert.equal((await lstat(join(installed.root, 'backend.mjs'))).mode & 0o222, 0);
  await writeFile(path, 'source replaced after install');
  assert.match(await readFile(join(installed.root, 'backend.mjs'), 'utf8'), /not imported/);
  assert.equal((await readModuleSettings()).selected.fixture?.enabled, true);
  assert.deepEqual(await listInstalledModules(), [{ id: 'fixture', version: '1.0.0', digest: installed.digest }]);
  await selectModule('fixture', { enabled: false });
  assert.equal((await readModuleSettings()).selected.fixture?.enabled, false);
  await selectModule('fixture', { enabled: true, config: { fixtureFlag: true } });
  assert.deepEqual((await readModuleSettings()).selected.fixture?.config, { fixtureFlag: true });
  assert.equal((await readdir(join(f.hostRoot, 'modules'))).some(name => name.startsWith('.config-') || name === '.lock'), false);
  await assert.rejects(installLocalModule(await f.package(), { trustLocalCode: true }), /different digest/);
  await assert.rejects(selectModule('fixture', { enabled: true, digest: 'a'.repeat(64) }), /missing or ambiguous/);
  await chmod(join(installed.root, 'backend.mjs'), 0o600);
  await writeFile(join(installed.root, 'backend.mjs'), 'changed');
  await assert.rejects(readModuleInstallation('fixture', { version: '1.0.0', digest: installed.digest }), /integrity/);
});

test('installed package and config symlinks cannot escape host-owned roots', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(), { trustLocalCode: true });
  await chmod(installed.root, 0o700);
  await symlink(join(f.root, 'not-a-package-file'), join(installed.root, 'extra-link'));
  await assert.rejects(readModuleInstallation('fixture', { version: '1.0.0', digest: installed.digest }), /Unexpected/);
  await symlink(join(f.root, 'outside-config.json'), join(f.hostRoot, 'modules', 'config.json'));
  await writeFile(join(f.root, 'outside-config.json'), '{"apiVersion":1,"selected":{}}');
  await assert.rejects(readModuleSettings(), /ELOOP/);
  const otherHost = join(f.root, 'other');
  await mkdir(otherHost);
  await symlink(dirname(installed.root), join(otherHost, 'modules'));
  await assert.rejects(installLocalModule(await f.package(), { trustLocalCode: true, hostRoot: otherHost }), /symlink/);
});

test('CLI distinguishes installed/selected/running state without hot-loading and rejects remote installs', async t => {
  const f = await moduleFixture(t);
  await assert.rejects(moduleCli(['install', 'https://untrusted.invalid/module.tgz']), /--trust-local-code/);
  const result = await moduleCli(['install', await f.package(), '--trust-local-code', '--enable']) as { installed: { digest: string } };
  let requests = 0;
  const listing = await moduleCli(['list', '--server', 'http://127.0.0.1:1'], {
    fetch: async input => {
      requests++;
      assert.equal(String(input), 'http://127.0.0.1:1/_modules');
      return new Response(JSON.stringify({ modules: [], active: [], errors: [] }));
    },
  }) as { installed: unknown[]; selected: Record<string, unknown>; running: unknown };
  assert.equal(requests, 1);
  assert.equal(listing.installed.length, 1);
  assert.ok(listing.selected.fixture);
  assert.deepEqual(listing.running, { modules: [], active: [], errors: [] });
  assert.ok(result.installed.digest);
  await moduleCli(['disable', 'fixture']);
  assert.equal((await readModuleSettings()).selected.fixture?.enabled, false);
  await moduleCli(['enable', 'fixture']);
  assert.equal((await readModuleSettings()).selected.fixture?.enabled, true);
  await assert.rejects(moduleCli(['list', '--server', 'https://remote.invalid']), /loopback/);
  await assert.rejects(moduleCli(['enable', 'fixture', '--enable']), /Usage/);
  const unavailable = await moduleCli(['list'], { fetch: async () => { throw new Error('synthetic offline'); } }) as { running: unknown; unavailable: string };
  assert.equal(unavailable.running, null);
  assert.equal(unavailable.unavailable, 'synthetic offline');
});

test('enabling an unselected installation resolves only an unambiguous verified version', async t => {
  const f = await moduleFixture(t);
  const original = await installLocalModule(await f.package(), { trustLocalCode: true });
  const first = await selectModule('fixture', { enabled: true });
  assert.equal(first.digest, original.digest);
  const next = await installLocalModule(await f.package(moduleEntries('fixture', undefined, { version: '2.0.0' })), { trustLocalCode: true });
  const switched = await selectModule('fixture', { enabled: true, version: '2.0.0' });
  assert.equal(switched.digest, next.digest);
  await assert.rejects(installLocalModule('https://synthetic.invalid/file.tgz', { trustLocalCode: true }), /local .tgz/);
});

test('failed publication unseals only unpublished staging and preserves the original rename error', async t => {
  const f = await moduleFixture(t);
  const existing = await installLocalModule(await f.package(), { trustLocalCode: true });
  const nextPackage = await f.package(moduleEntries('fixture', undefined, { version: '2.0.0' }));
  const publicationError = Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' });
  let staging = '';
  const restored: string[] = [];
  const originalChmod = fs.chmod;
  const originalRm = fs.rm;
  const rename = t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0]) => {
    staging = String(from);
    assert.equal((await lstat(join(staging, 'package'))).mode & 0o777, 0o555);
    throw publicationError;
  });
  const chmod = t.mock.method(fs, 'chmod', async (...args: Parameters<typeof fs.chmod>) => {
    if (staging) {
      const path = String(args[0]);
      assert.ok(path === staging || path.startsWith(`${staging}/`), 'Cleanup changed a published or unrelated directory');
      restored.push(path);
    }
    return originalChmod(...args);
  });
  const rm = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === staging) {
      for (const relative of ['', 'package', 'package/web']) assert.ok((await lstat(join(staging, relative))).mode & 0o200,
        'Non-root deletion requires owner-write on each staging directory');
    }
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(installLocalModule(nextPackage, { trustLocalCode: true }), error => error === publicationError); }
  finally { rename.mock.restore(); chmod.mock.restore(); rm.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(restored.includes(join(staging, 'package/web')));
  await assert.rejects(lstat(staging), { code: 'ENOENT' });
  assert.equal((await lstat(existing.root)).mode & 0o777, 0o555);
  assert.equal((await lstat(join(existing.root, 'web'))).mode & 0o777, 0o555);
  await readModuleInstallation('fixture', { version: '1.0.0', digest: existing.digest });
  assert.equal((await readdir(join(f.hostRoot, 'modules'))).some(name => name.startsWith('.install-') || name === '.lock'), false);
});

test('failed staging cleanup preserves both publication and cleanup errors', async t => {
  const f = await moduleFixture(t);
  const packagePath = await f.package();
  const publicationError = new Error('synthetic publication failure');
  const cleanupError = new Error('synthetic cleanup failure');
  let staging = '';
  const originalChmod = fs.chmod;
  const rename = t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0]) => { staging = String(from); throw publicationError; });
  const chmod = t.mock.method(fs, 'chmod', async (...args: Parameters<typeof fs.chmod>) => {
    if (String(args[0]) === staging) throw cleanupError;
    return originalChmod(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(installLocalModule(packagePath, { trustLocalCode: true }), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [publicationError, cleanupError]);
      assert.equal(error.cause, publicationError);
      return true;
    });
  } finally { rename.mock.restore(); chmod.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await readdir(join(f.hostRoot, 'modules'))).includes('.lock'), false);
});
