import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const required = [
  'apps/server/src/index.ts', 'packages/core/src/index.ts', 'packages/protocol/src/index.ts',
  'apps/mcp/dist/index.js', 'apps/web/dist/index.html', 'consumer-runtime.json',
  'scripts/consumer/cli.mjs', 'delivery-manifest.json',
];
const retired = [
  'modules/', 'module-staging/', 'skills/',
  'packages/core/src/modules/', 'packages/core/src/context-reset.ts',
  'packages/core/src/prefs.ts', 'packages/core/src/attention.ts', 'packages/core/src/auto-name.ts',
  'apps/server/src/uploads.ts', 'apps/server/src/push.ts', 'apps/server/src/speech.ts',
  'apps/server/src/delivery-status.ts', 'scripts/consumer/module-runner.mjs',
];

function checkArchive(archive) {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim().split('\n').map(path => path.replace(/^\.\//, ''));
  assert.ok(entries.every(path => !path.startsWith('/') && !path.split('/').includes('..')));
  for (const path of required) assert.ok(entries.includes(path), `Missing native runtime file: ${path}`);
  for (const path of retired) {
    assert.equal(entries.some(entry => path.endsWith('/') ? entry.startsWith(path) : entry === path),
      false, `Parked capability must not ship: ${path}`);
  }
  assert.equal(entries.some(path => /node_modules\/(?:\.pnpm\/)?(?:microsoft-cognitiveservices-speech-sdk|web-push)(?:@|\/)/.test(path)),
    false, 'Detached speech/push dependencies must not leak through an old node_modules tree');
}

test('the runtime closure excludes parked capabilities and preserves the native source and launcher', async () => {
  const config = JSON.parse(await readFile(join(repository, 'service-delivery.json'), 'utf8'));
  const paths = config.build.artifactPaths;
  for (const path of ['packages/core/src', 'packages/protocol/src', 'apps/server/src', 'apps/web/dist', 'scripts/consumer']) {
    assert.ok(paths.includes(path), path);
  }
  for (const path of ['.', 'modules', 'module-staging', 'skills']) assert.equal(paths.includes(path), false, path);
  assert.equal(paths.some(path => path.startsWith('module-staging/')), false);
});

test('parked source inventory preserves ordinary immutable source bytes and original file modes', async () => {
  const inventory = JSON.parse(await readFile(join(repository, 'module-staging/source-inventory.json'), 'utf8'));
  assert.equal(inventory.kind, 'parked-source-inventory');
  const seen = new Set();
  for (const entry of inventory.records) {
    assert.match(entry.sourceSha, /^[a-f0-9]{40}$/);
    assert.ok(entry.destination.startsWith('module-staging/'));
    assert.equal(entry.destination.split('/').includes('..'), false);
    assert.equal(seen.has(entry.destination), false);
    seen.add(entry.destination);
    const path = join(repository, entry.destination);
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), entry.sha256, entry.destination);
    assert.equal(Boolean(stat.mode & 0o111), entry.mode === '100755', entry.destination);
  }
});

test('the archive guard rejects reintroduced parked payloads or missing native entry files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), archive = join(root, 'runtime.tar.gz');
  for (const path of required) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), path.endsWith('.json') ? '{}' : 'export {};');
  }
  const pack = () => execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  pack();
  checkArchive(archive);
  await mkdir(join(source, 'module-staging/files'), { recursive: true });
  await writeFile(join(source, 'module-staging/files/parked.txt'), 'Must not be in the runtime');
  pack();
  assert.throws(() => checkArchive(archive), /Parked capability/);
  await rm(join(source, 'module-staging'), { recursive: true });
  await rm(join(source, 'apps/server/src/index.ts'));
  pack();
  assert.throws(() => checkArchive(archive), /Missing native runtime file/);
});

test('the actual fixed-commit archive contains native runtime files and no parked capabilities', {
  skip: !process.env.COCKPIT_RELEASE_ARCHIVE,
}, () => {
  checkArchive(resolve(process.env.COCKPIT_RELEASE_ARCHIVE));
});
