import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = join(repository, 'packages/module-api');

test('module SDK pack is a standalone JS and declaration package', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-module-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packOutput = execFileSync('pnpm', ['pack', '--pack-destination', root, '--json'], {
    cwd: sdkRoot,
    encoding: 'utf8',
  });
  const packed = JSON.parse(packOutput.slice(packOutput.lastIndexOf('\n{') + 1));
  const archive = packed.filename;
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  for (const required of [
    'package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/contract.js',
    'package/runtime.js', 'package/runtime.d.ts',
  ]) {
    assert.ok(files.includes(required), `${required} is missing`);
  }
  assert.ok(files.every(file => !file.startsWith('package/src/')), 'source TypeScript must not be published');

  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, '@waksana/cockpit-module-sdk');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, './dist/index.js');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(manifest.dependencies, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /(?:workspace|file):/);

  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--legacy-peer-deps', archive,
  ], { cwd: consumer, stdio: 'pipe' });
  const sdk = await import(pathToFileURL(join(consumer, 'node_modules/@waksana/cockpit-module-sdk/dist/index.js')));
  assert.equal(sdk.MAX_MODULE_EVENT_BYTES, 65_536);
  assert.equal(sdk.MCP_INVOCATION_META_KEY, 'cockpit/invocation');

  const typeRoot = join(consumer, 'node_modules/@types');
  mkdirSync(typeRoot, { recursive: true });
  for (const name of ['node', 'react']) {
    symlinkSync(join(sdkRoot, 'node_modules/@types', name), join(typeRoot, name), 'dir');
  }
  writeFileSync(join(consumer, 'consume.mts'), `
    import {
      MAX_MODULE_EVENT_BYTES,
      type ModuleBackend,
      type ModuleFrontendContext,
      type ModuleHostIntentResult,
    } from '@waksana/cockpit-module-sdk';
    const backend: ModuleBackend = { routes: [] };
    const created: ModuleHostIntentResult<'session/new'> = { sessionId: 's' };
    declare const frontend: ModuleFrontendContext;
    console.log(MAX_MODULE_EVENT_BYTES, backend.routes.length, created.sessionId, frontend.apiVersion);
  `);
  execFileSync(join(repository, 'node_modules/.bin/tsc'), [
    '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022', '--types', 'node,react', join(consumer, 'consume.mts'),
  ], { cwd: consumer, stdio: 'pipe' });
});
