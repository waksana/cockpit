import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = join(repository, 'packages/module-api');
const npmOptions = ['--ignore-scripts', '--no-audit', '--no-fund'];
const fixtures = [
  { name: 'common', types: [], lib: ['ES2022'], source: `
    import { MAX_MODULE_EVENT_BYTES, type SessionMeta } from '@waksana/cockpit-module-sdk';
    import { MCP_INVOCATION_META_KEY } from '@waksana/cockpit-module-sdk/runtime';
    declare const session: SessionMeta;
    const id: string = session.sessionId;
    void [id, MAX_MODULE_EVENT_BYTES, MCP_INVOCATION_META_KEY];
  ` },
  ...['backend', 'backend-current'].map(name => ({ name, types: ['node'], lib: ['ES2022'], source: `
    import { Readable } from 'node:stream';
    import type { ModuleBackend, ModuleHostIntentResult, ModuleResponse } from '@waksana/cockpit-module-sdk/backend';
    const backend: ModuleBackend = { routes: [] };
    const response: ModuleResponse = { body: Readable.from('ok') };
    const created: ModuleHostIntentResult<'session/new'> = { sessionId: 's' };
    // @ts-expect-error sessionId is part of the canonical host result.
    const invalid: ModuleHostIntentResult<'session/new'> = { id: 's' };
    void [backend, response, created, invalid];
  ` })),
  ...['frontend-18', 'frontend-19'].map(name => ({ name, types: ['react'], lib: ['ES2022', 'DOM'], source: `
    import type * as React from 'react';
    import type { ModuleFrontendContext, ModuleAsset, ComposerProps } from '@waksana/cockpit-module-sdk/frontend';
    declare const frontend: ModuleFrontendContext;
    declare const asset: ModuleAsset;
    declare const props: ComposerProps;
    const children: React.ReactNode = props.children;
    const apiVersion: 2 = frontend.apiVersion;
    void [children, apiVersion, asset.id];
  ` })),
];

test('module SDK archive is standalone across the supported consumer matrix', { timeout: 300_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-module-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (command, args, cwd) => execFileSync(command, args, {
    cwd, encoding: 'utf8', timeout: 120_000, stdio: 'pipe',
  });
  const packOutput = run('pnpm', ['pack', '--pack-destination', root, '--json'], sdkRoot);
  const archive = JSON.parse(packOutput.slice(packOutput.lastIndexOf('\n{') + 1)).filename;
  const files = run('tar', ['-tzf', archive], root).trim().split('\n');
  for (const entry of ['index', 'backend', 'frontend', 'contract', 'wire', 'manifest']) {
    for (const extension of ['js', 'd.ts']) assert.ok(files.includes(`package/dist/${entry}.${extension}`));
  }
  for (const file of ['runtime.js', 'runtime.d.ts', 'LICENSE']) assert.ok(files.includes(`package/${file}`));
  assert.ok(files.every(file => /^(?:package\/(?:dist\/[^/]+|runtime\.(?:js|d\.ts)|package\.json|LICENSE))$/.test(file)),
    'SDK archive must not include host, source, runtime dependencies or workspace files');

  const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json'], root));
  assert.equal(manifest.name, '@waksana/cockpit-module-sdk');
  assert.equal(manifest.version, JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version);
  assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(manifest.dependencies, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /(?:workspace|file):/);

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const consumer = join(root, fixture.name);
      cpSync(join(repository, 'scripts/fixtures/module-sdk', fixture.name), consumer, { recursive: true });
      run('npm', ['ci', ...npmOptions], consumer);
      run('npm', ['install', '--no-save', ...npmOptions, archive], consumer);
      const frontend = fixture.name.startsWith('frontend');
      assert.equal(existsSync(join(consumer, 'node_modules/react')), frontend);
      assert.equal(existsSync(join(consumer, 'node_modules/@types/react')), frontend);
      assert.equal(existsSync(join(consumer, 'node_modules/@types/node')), fixture.name.startsWith('backend'));
      writeFileSync(join(consumer, 'consume.mts'), fixture.source);
      for (const [module, moduleResolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
        writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { noEmit: true, strict: true, skipLibCheck: false, target: 'ES2022',
            module, moduleResolution, lib: fixture.lib, types: fixture.types },
          files: ['consume.mts'],
        }));
        run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer);
      }
      if (fixture.name === 'common') {
        writeFileSync(join(consumer, 'consume.mts'), `
          import type { ModuleBackend } from '@waksana/cockpit-module-sdk/backend';
          import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
          declare const backend: ModuleBackend, frontend: ModuleFrontendContext;
          void [backend, frontend];
        `);
        assert.throws(() => run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer),
          error => error.status !== 0 && /Cannot find module 'node:stream'/.test(error.stdout)
            && /Cannot find module 'react'/.test(error.stdout),
          'Environment entries must require their peers rather than degrade to any');
      }
      run(process.execPath, ['--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { MAX_MODULE_EVENT_BYTES } from '@waksana/cockpit-module-sdk';
        import { MCP_INVOCATION_META_KEY } from '@waksana/cockpit-module-sdk/runtime';
        import '@waksana/cockpit-module-sdk/backend';
        import '@waksana/cockpit-module-sdk/frontend';
        assert.equal(MAX_MODULE_EVENT_BYTES, 65536);
        assert.equal(MCP_INVOCATION_META_KEY, 'cockpit/invocation');
        await assert.rejects(import('@waksana/cockpit-module-sdk/dist/contract.js'),
          { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      `], consumer);
    });
  }

  await t.test('runtime-only installation does not auto-install optional peers', () => {
    const consumer = join(root, 'runtime');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    run('npm', ['install', ...npmOptions, archive], consumer);
    for (const dependency of ['react', '@types/react', '@types/node']) {
      assert.equal(existsSync(join(consumer, 'node_modules', dependency)), false);
    }
    assert.equal(run(process.execPath, ['--input-type=module', '--eval',
      "import { MAX_MODULE_EVENT_BYTES } from '@waksana/cockpit-module-sdk/runtime'; process.stdout.write(String(MAX_MODULE_EVENT_BYTES));"],
    consumer), '65536');
  });
});
