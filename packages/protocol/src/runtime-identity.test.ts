import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { readRuntimeIdentity } from './runtime-identity.ts';

function fixture(t: TestContext) {
  const root = join(process.cwd(), `.runtime-identity-${randomUUID()}`);
  mkdirSync(root);
  t.after(() => rmSync(root, { recursive: true }));
  const packageFile = pathToFileURL(join(root, 'package.json'));
  const manifestFile = pathToFileURL(join(root, 'runtime-manifest.json'));
  writeFileSync(packageFile, '{"version":"0.0.0-dev"}');
  return { root, packageFile, manifestFile, read: () => readRuntimeIdentity(packageFile, manifestFile) };
}

test('development identity reads this checkout, independently of process cwd and Git overrides', t => {
  const root = new URL('../../../', import.meta.url);
  const sha = execFileSync('git', ['-C', fileURLToPath(root), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/nonexistent-synthetic-git-dir';
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  });
  const identity = readRuntimeIdentity(new URL('package.json', root), new URL('runtime-manifest.json', root));
  assert.deepEqual(identity, { version: `dev+${sha.slice(0, 12)}`, sourceSha: sha });
});

test('unversioned source cannot inherit an ancestor Git SHA', t => {
  assert.deepEqual(fixture(t).read(), { version: 'dev+unknown', sourceSha: null });
});

test('corrupt Git metadata fails explicitly instead of claiming an unversioned tree', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.git'), 'invalid Git metadata');
  assert.throws(f.read, (error: unknown) => error instanceof Error
    && error.message === 'Cannot resolve development Git HEAD' && error.cause instanceof Error);
});

for (const gitAvailable of [false, true]) {
  test(`Git ${gitAvailable ? 'invalid SHA output' : 'execution failure'} is an explicit identity error`, t => {
    const f = fixture(t);
    mkdirSync(join(f.root, '.git'));
    if (gitAvailable) writeFileSync(join(f.root, 'git'),
      `#!${process.execPath}\nconsole.log('invalid-sha');\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = f.root;
    t.after(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
    assert.throws(f.read, gitAvailable
      ? /Development Git HEAD is not a valid source SHA/
      : /Cannot resolve development Git HEAD/);
  });
}

test('packaged development identity validates raw version before any display decoration', t => {
  const f = fixture(t);
  writeFileSync(f.manifestFile, JSON.stringify({
    format: 1, product: 'cockpit', version: '0.0.0-dev', sourceSha: 'b'.repeat(40),
    node: process.versions.node, platform: process.platform, arch: process.arch,
  }));
  assert.deepEqual(f.read(), { version: '0.0.0-dev', sourceSha: 'b'.repeat(40) });
});

test('Rolling identity uses the exact manifest source and validates every runtime constraint', t => {
  const f = fixture(t);
  writeFileSync(f.packageFile, '{"version":"0.0.0-rolling.123"}');
  const manifest = {
    format: 1, product: 'cockpit', version: '0.0.0-rolling.123', sourceSha: 'c'.repeat(40),
    node: process.versions.node, platform: process.platform, arch: process.arch,
  };
  writeFileSync(f.manifestFile, JSON.stringify(manifest));
  assert.deepEqual(f.read(), { version: manifest.version, sourceSha: manifest.sourceSha });
  for (const patch of [{ version: '0.0.0-rolling.124' }, { sourceSha: 'short' }, { node: '0' },
    { platform: 'unsupported' }, { arch: 'unsupported' }, { format: 2 }, { product: 'other' }]) {
    writeFileSync(f.manifestFile, JSON.stringify({ ...manifest, ...patch }));
    assert.throws(f.read);
  }
  writeFileSync(f.manifestFile, '{invalid');
  assert.throws(f.read, SyntaxError);
});

test('malformed package versions remain errors', t => {
  const f = fixture(t);
  for (const version of ['', 'dev+invented', 'rolling']) {
    writeFileSync(f.packageFile, JSON.stringify({ version }));
    assert.throws(f.read);
  }
});

test('a Rolling version without its runtime manifest cannot claim a packaged identity', t => {
  const f = fixture(t);
  writeFileSync(f.packageFile, '{"version":"0.0.0-rolling.123"}');
  assert.throws(f.read, /requires its runtime manifest/);
});
