import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportModuleApi } from './export-module-api.mjs';

test('module API export contains its canonical types and local protocol dependency, without tests', async t => {
  const parent = new URL('../node_modules/', import.meta.url);
  const root = await mkdtemp(new URL('module-sdk-export-', parent));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'sdk');
  await exportModuleApi(target);
  const api = JSON.parse(await readFile(join(target, 'module-api/package.json'), 'utf8'));
  assert.equal(api.dependencies['@cockpit/protocol'], 'file:../protocol');
  assert.equal(api.devDependencies, undefined);
  assert.equal(api.scripts, undefined);
  const types = await readFile(join(target, 'module-api/src/index.ts'), 'utf8');
  assert.match(types, /interface ModuleFrontendContext/);
  assert.match(types, /interface ModuleBackendContext/);
  for (const entry of await readdir(join(target, 'protocol/src'))) assert.doesNotMatch(entry, /\.test\./);
  assert.match(await readFile(join(target, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/);
  await assert.rejects(exportModuleApi(target), { code: 'EEXIST' });
  await mkdir(join(root, 'existing'));
  await assert.rejects(exportModuleApi(join(root, 'existing')), { code: 'EEXIST' });
});
