import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { inventory } from '../.delivery/toolkit/lib/artifact.mjs';
import { packageModuleRelease } from './package-module-release.mjs';

async function fixture(t, moduleId) {
  const root = await mkdtemp(join(tmpdir(), 'module-publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), modulePath = moduleId === 'assistant' ? join(source, 'modules/assistant') : source;
  await mkdir(modulePath, { recursive: true });
  await writeFile(join(modulePath, 'module.json'), JSON.stringify({
    schemaVersion: 1, id: moduleId, version: '1.0.0', name: moduleId, description: 'Isolated publisher fixture',
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
  }));
  if (moduleId === 'assistant') await writeFile(join(source, 'host-only.txt'), 'Must not be published as Assistant');
  const specification = { moduleId, version: '1.0.0', sourceSha: 'a'.repeat(40) };
  const manifest = { format: 1, sourceSha: specification.sourceSha, platform: process.platform, arch: process.arch,
    node: process.versions.node, files: await inventory(source), buildRunId: 'synthetic-ci-run' };
  await writeFile(join(source, 'delivery-manifest.json'), JSON.stringify(manifest));
  execFileSync('tar', ['-czf', join(root, 'runtime.tar.gz'), '-C', source, '.']);
  const archive = join(root, 'runtime.zip');
  execFileSync('python3', ['-c',
    'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],"x") as z:z.write(sys.argv[1],"runtime.tar.gz")',
    join(root, 'runtime.tar.gz'), archive]);
  return { root, source, archive, specification, output: join(root, 'publish') };
}
for (const moduleId of ['task', 'wechat', 'assistant']) test(`${moduleId} publisher derives only the fixed verified CI module and anonymous Release URL`, async t => {
  const f = await fixture(t, moduleId);
  const result = await packageModuleRelease(f);
  assert.equal(result.target.sourceSha, f.specification.sourceSha);
  assert.equal(result.target.moduleId, moduleId);
  assert.ok(result.target.url.startsWith('https://github.com/waksana/'));
  assert.equal(result.target.url.includes('?'), false);
  if (moduleId !== 'assistant') assert.deepEqual(await readFile(result.archive), await readFile(f.archive));
  else {
    const dest = join(f.root, 'assistant-verify', 'package');
    await mkdir(dest, { recursive: true });
    execFileSync('python3', ['.delivery/toolkit/bin/extract.py', result.archive, dest]);
    await assert.rejects(readFile(join(dest, 'host-only.txt')), /ENOENT/);
    assert.equal(JSON.parse(await readFile(join(dest, 'module.json'), 'utf8')).id, 'assistant');
  }
  await assert.rejects(packageModuleRelease(f), /EEXIST/);
});

test('module publisher rejects a different source SHA or package version before emitting an archive', async t => {
  const f = await fixture(t, 'task');
  await assert.rejects(packageModuleRelease({ ...f, specification: { ...f.specification, sourceSha: 'b'.repeat(40) } }), /sourceSha mismatch/);
  await assert.rejects(packageModuleRelease({ ...f, output: join(f.root, 'wrong-version'),
    specification: { ...f.specification, version: '2.0.0' } }), /different module identity/);
});
