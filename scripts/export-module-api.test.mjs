import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
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
  assert.match(types, /export type \* from '\.\/frontend\.ts'/);
  const frontend = await readFile(join(target, 'module-api/src/frontend.ts'), 'utf8');
  assert.match(frontend, /interface ModuleFrontendContext/);
  assert.match(frontend, /interface DraftSchemaRegistration/);
  assert.match(frontend, /interface ModuleMenuRegistration/);
  assert.match(frontend, /readonly menuVersion: 1/);
  assert.match(frontend, /readonly uiSurfaceVersion: 1/);
  assert.match(frontend, /readonly composerInputVersion: 1/);
  assert.match(frontend, /readonly draftLifecycleVersion: 1/);
  assert.match(frontend, /readonly draftSubmissionVersion: 1/);
  assert.match(frontend, /readonly sends\?: readonly 'draft'\[\]/);
  assert.match(frontend, /captureSend\(\): CapturedDraftSend/);
  assert.match(frontend, /send\(expectedRevision: number\): Promise<DraftSendResult>/);
  assert.match(frontend, /readonly retired: boolean/);
  assert.match(frontend, /editTextIfRevision\(text: string, revision: number\): boolean/);
  assert.match(frontend, /composerInput: ComposerInputProps/);
  assert.match(frontend, /readonly chatWindowVersion: 1/);
  assert.doesNotMatch(frontend, /composerActionsVersion/);
  assert.doesNotMatch(frontend.match(/interface ComposerEditorProps[\s\S]*?\{\}/)?.[0] ?? assert.fail('Missing input row type'), /actions/);
  assert.doesNotMatch(frontend, /GlobalNavigationProps|globalNavigation:/);
  assert.match(types, /interface ModuleBackendContext/);
  assert.match(types, /readonly serviceReadyVersion: 1/);
  assert.match(types, /onReady\?\(\): void \| Promise<void>/);
  assert.match(types, /publish\(payload: ModuleEventPayload\): void/);
  assert.match(types, /export \{ MAX_MODULE_EVENT_BYTES \}/);
  assert.match(frontend, /onEvent\(listener: \(payload: ModuleEventPayload\) => void\): \(\) => void/);
  const payload = await readFile(join(target, 'protocol/src/module-event.ts'), 'utf8');
  assert.match(payload, /export type ModuleEventPayload/);
  assert.match(payload, /MAX_MODULE_EVENT_BYTES = 64 \* 1024/);
  for (const entry of await readdir(join(target, 'protocol/src'))) assert.doesNotMatch(entry, /\.test\./);
  assert.match(await readFile(join(target, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/);
  await assert.rejects(exportModuleApi(target), { code: 'EEXIST' });
  await mkdir(join(root, 'existing'));
  await assert.rejects(exportModuleApi(join(root, 'existing')), { code: 'EEXIST' });
});

test('an export from a runtime package points back at the shipped sources', async t => {
  const parent = new URL('../node_modules/', import.meta.url);
  const root = await mkdtemp(new URL('module-sdk-runtime-', parent));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = join(root, 'packages');
  for (const name of ['module-api', 'protocol']) {
    await cp(new URL(`../packages/${name}/src`, import.meta.url), join(packages, name, 'src'), { recursive: true });
    await cp(new URL(`../packages/${name}/package.json`, import.meta.url), join(packages, name, 'package.json'));
  }
  // As scripts/package-runtime.mjs rewrites it: compiled entries, no `types`.
  const protocolManifest = join(packages, 'protocol/package.json');
  const { types: _types, ...runtime } = JSON.parse(await readFile(protocolManifest, 'utf8'));
  runtime.main = './dist/index.js';
  runtime.exports = { '.': './dist/index.js', './chat': './dist/chat.js', './validation': './dist/validation.js' };
  await writeFile(protocolManifest, JSON.stringify(runtime));
  const target = join(root, 'sdk');
  await exportModuleApi(target, packages);
  const protocol = JSON.parse(await readFile(join(target, 'protocol/package.json'), 'utf8'));
  assert.equal(protocol.types, './src/index.ts');
  assert.equal(protocol.main, './src/index.ts');
  assert.deepEqual(protocol.exports, { '.': './src/index.ts', './chat': './src/chat.ts', './validation': './src/validation.ts' });
  for (const entry of Object.values(protocol.exports)) await readFile(join(target, 'protocol', entry));
  const api = JSON.parse(await readFile(join(target, 'module-api/package.json'), 'utf8'));
  assert.deepEqual(api.exports, { '.': { types: './src/index.ts', default: './src/index.ts' } });
});
