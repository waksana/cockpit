import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  command, firstPartyRuntimePath, inventoryTree, MCP_START_COMMAND, MODULE_COMMAND, packageRuntime, REQUIRED_FILES, safeRelativePath, sha256, START_COMMAND,
} from './package-runtime.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const fixtureParent = join(repository, '.runtime-package-tests');
const sourceSha = 'a'.repeat(40);
const nativePlatform = `${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform}-${process.arch}`;
const nativePackage = `@github/copilot-sdk-${nativePlatform}`;
const wrapper = `prebuilds/${nativePlatform}/copilot-runtime${process.platform === 'win32' ? '.exe' : ''}`;

function put(root, path, contents, mode = 0o644) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`, { mode });
  chmodSync(destination, mode);
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(relative(dirname(path), target), path, 'dir');
}

function fakeDeploy(source, target, app, state) {
  mkdirSync(target, { recursive: true });
  cpSync(join(source, `apps/${app}/package.json`), join(target, 'package.json'));
  cpSync(join(source, `apps/${app}/dist`), join(target, 'dist'), { recursive: true });
  const modules = join(target, 'node_modules');
  const published = {
    core: ['dist', 'src'],
    protocol: ['dist', 'src'],
    'module-api': ['dist', 'runtime.js', 'runtime.d.ts'],
  };
  const workspace = name => {
    const packageName = name === 'module-api' ? '@waksana/cockpit-module-sdk' : `@cockpit/${name}`;
    const scope = packageName.slice(1).split('/')[0];
    const basename = packageName.split('/')[1];
    const peers = join(modules, '.pnpm', `${scope}+${basename}@file+packages+${name}`, 'node_modules');
    const path = join(peers, `@${scope}`, basename);
    mkdirSync(path, { recursive: true });
    cpSync(join(source, 'packages', name, 'package.json'), join(path, 'package.json'));
    for (const directory of published[name]) cpSync(join(source, 'packages', name, directory), join(path, directory), { recursive: true });
    link(path, join(modules, '@cockpit', name));
    return { path, peers };
  };
  const protocol = workspace('protocol');
  put(protocol.peers, 'zod/package.json', { name: 'zod', version: '3.25.76', main: 'index.js' });
  put(protocol.peers, 'zod/index.js', 'module.exports = {};');
  put(protocol.peers, 'zod/LICENSE', 'Synthetic dependency license');
  if (app === 'server') {
    const moduleApi = workspace('module-api');
    link(moduleApi.path, join(protocol.peers, '@waksana/cockpit-module-sdk'));
    const core = workspace('core');
    link(protocol.path, join(core.peers, '@cockpit/protocol'));
    put(core.peers, '.bin/build-shim', 'Must not retain a package-manager shim with a build-machine path');
    const sdk = join(core.peers, '@github/copilot-sdk');
    put(sdk, 'package.json', { name: '@github/copilot-sdk', version: state.sdkVersion ?? '1.0.13', main: 'dist/index.js' });
    put(sdk, 'dist/index.js', 'exports.CopilotClient = class {};');
    put(sdk, 'LICENSE', 'Synthetic SDK license');
    const native = join(core.peers, nativePackage);
    put(native, 'package.json', { name: nativePackage, version: '1.0.13' });
    put(native, wrapper, 'Never executed: synthetic native runtime', 0o755);
    if (!state.missingNative) put(native, `prebuilds/${nativePlatform}/runtime.node`, 'Synthetic native asset');
    for (const path of ['copilot-sdk/index.js', 'sdk/index.js', 'preloads/extension_bootstrap.mjs',
      'definitions/test-sidekick-restart.yaml', 'consumer/updater.native', 'tests/native.test.mjs', 'docs/README.md', 'LICENSE']) {
      put(native, path, `Preserve dependency-owned bytes: ${path}`);
    }
  }
  if (state.devLoader) put(modules, '.pnpm/tsx@4.23.13/node_modules/tsx/dist/loader.mjs', 'export {};');
  put(modules, '.modules.yaml', 'Must not retain build-machine package-manager metadata');
  put(modules, '.pnpm/lock.yaml', 'Must not retain generated deployment metadata');
  if (state.externalLink) link(state.externalLink, join(modules, 'external-link'));
}

async function fixture(t, { realDeploy = false } = {}) {
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'repository');
  await mkdir(source);
  const tracked = new Map();
  const track = (path, contents, mode = '100644') => {
    put(source, path, contents, mode === '100755' ? 0o755 : 0o644);
    tracked.set(path, mode);
  };
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/web/package.json',
    'apps/server/package.json', 'apps/mcp/package.json', 'packages/core/package.json', 'packages/protocol/package.json',
    'packages/module-api/package.json', 'packages/module-api/runtime.js', 'packages/module-api/runtime.d.ts']) {
    track(path, readFileSync(join(repository, path), 'utf8'));
  }
  track('LICENSE', 'Synthetic first-party license');
  track('NOTICE.md', 'Synthetic third-party attribution');
  track('apps/server/src/index.ts', `
import Fastify from 'fastify';
import { marker } from '@cockpit/core';
import { protocolMarker } from '@cockpit/protocol';
console.log(JSON.stringify({ pid: process.pid, marker, protocolMarker, fastify: typeof Fastify }));
`);
  track('packages/core/src/index.ts', `
import { CopilotClient } from '@github/copilot-sdk';
import { protocolMarker } from '@cockpit/protocol';
enum Fixture { READY = 7 }
export const marker = [Fixture.READY, typeof CopilotClient, protocolMarker];
`);
  track('packages/protocol/src/index.ts', 'export const protocolMarker: string = "synthetic";');
  put(source, 'packages/module-api/dist/index.js', 'export const MAX_MODULE_EVENT_BYTES = 65536;\n');
  put(source, 'packages/module-api/dist/index.d.ts', 'export declare const MAX_MODULE_EVENT_BYTES = 65536;\n');
  track('apps/server/src/module-cli.ts', 'console.log("Synthetic local module CLI");');
  // Build outputs, as `pnpm build` leaves them in the checkout.
  put(source, 'apps/server/dist/index.js', `
import Fastify from 'fastify';
import { marker } from '@cockpit/core';
import { protocolMarker } from '@cockpit/protocol';
console.log(JSON.stringify({ pid: process.pid, marker, protocolMarker, fastify: typeof Fastify }));
//# sourceMappingURL=index.js.map
`);
  put(source, 'apps/server/dist/index.js.map', { version: 3, file: 'index.js', sources: ['../src/index.ts'], mappings: '' });
  put(source, 'apps/server/dist/module-cli.js', 'console.log("Synthetic local module CLI");');
  put(source, 'apps/server/dist/test-support/module-fixture.js', 'Must not ship compiled test support');
  put(source, 'packages/core/dist/index.js', `
import { CopilotClient } from '@github/copilot-sdk';
import { protocolMarker } from '@cockpit/protocol';
const Fixture = { READY: 7 };
export const marker = [Fixture.READY, typeof CopilotClient, protocolMarker];
`);
  put(source, 'packages/core/dist/index.js.map', { version: 3, file: 'index.js', sources: ['../src/index.ts'], mappings: '' });
  for (const name of ['index', 'chat', 'validation']) {
    put(source, `packages/protocol/dist/${name}.js`, 'export const protocolMarker = "synthetic";');
  }
  for (const path of ['apps/server/src/example.test.ts', 'apps/server/src/example.test.mjs',
    'apps/server/src/fixtures/payload.ts', 'apps/server/src/__tests__/unit.ts',
    'packages/core/test-support/regress.mts', 'packages/core/src/test-support/helper.ts', 'packages/core/src/consumer/cli.ts',
    'packages/core/src/updater/entry.ts', 'apps/server/src/supervisor.ts',
    'packages/core/src/docs/design.md', 'packages/protocol/src/__fixtures__/payload.json',
    'module-staging/original.ts', '.delivery/toolkit/bin/launch.mjs', '.github/workflows/old.yml',
    'scripts/start.mjs', 'scripts/consumer/cli.mjs', 'docs/archive.md', '.git/config',
    'consumer-runtime.json', 'service-delivery.json']) track(path, 'Must not ship');
  put(source, 'apps/server/src/untracked.ts', 'Must not ship untracked source');
  put(source, 'apps/web/dist/index.html', '<!doctype html><title>Synthetic Web</title>');
  for (const name of ['lucide', 'frontend']) {
    put(source, `apps/web/dist/licenses/${name}.txt`, `Synthetic ${name} license`);
  }
  put(source, 'apps/web/dist/assets/app.js', 'console.log("synthetic Web");');
  put(source, 'apps/web/dist/assets/app.test.mjs', 'Must not ship a first-party test');
  put(source, 'apps/mcp/dist/index.js', `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { protocolMarker } from '@cockpit/protocol';
console.log(JSON.stringify({ pid: process.pid, server: typeof Server, protocolMarker }));
`);
  put(source, 'apps/mcp/dist/old.test.js', 'Must not ship stale compiled tests');
  put(source, 'apps/mcp/dist/tools/deploy.js', 'Must not ship stale deployment tooling');
  put(source, 'apps/web/dist/assets/app.js.map', 'Must not ship Web source maps');
  const state = { head: sourceSha, dirty: false };
  const calls = [];
  const run = (program, args, cwd) => {
    calls.push({ program, args, cwd });
    if (program === 'git') {
      if (args[0] === 'rev-parse') return `${args[1] === 'HEAD' ? state.head : source}\n`;
      if (args[0] === 'status') return state.dirty ? ' M package.json\n' : '';
      if (args[0] === 'show') return '1700000000\n';
      if (args[0] === 'ls-tree') {
        const roots = args.slice(args.indexOf('--') + 1);
        return [...tracked].filter(([path]) => roots.some(root => path === root || path.startsWith(`${root}/`)))
          .map(([path, mode]) => `${mode} blob ${'b'.repeat(40)}\t${path}\0`).join('');
      }
      if (args[0] === 'archive') {
        const output = args.find(arg => arg.startsWith('--output=')).slice('--output='.length);
        return execFileSync('tar', ['-cf', output, '-C', source, '--', ...args.slice(args.indexOf('--') + 1)], { encoding: 'utf8' });
      }
      throw new Error(`Unexpected fixture Git invocation: ${args}`);
    }
    if (program === 'pnpm' && !realDeploy) {
      if (args[0] === '--version') return '10.34.5\n';
      if (state.deployFailure) throw new Error('Synthetic pnpm deployment failure');
      fakeDeploy(cwd, args.at(-1), args[1].replace('@cockpit/', ''), state);
      if (state.dirtyDuringDeploy) state.dirty = true;
      return '';
    }
    return execFileSync(program, args, {
      cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TMPDIR: root, XDG_CACHE_HOME: join(root, 'empty-registry-cache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  return { root, source, state, calls, tracked, track, run,
    package: (options = {}) => packageRuntime({ repository: source, sourceSha, ...options }, run) };
}

async function unpack(archive, destination) {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim().split('\n').filter(name => name !== './').map(name => name.replace(/^\.\//, '').replace(/\/$/, ''));
  assert.equal(new Set(names).size, names.length, 'Duplicate archive entries');
  assert.ok(names.every(safeRelativePath), 'Unsafe archive paths');
  const details = execFileSync('tar', ['-tvzf', archive, '--numeric-owner', '--quoting-style=literal'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim().split('\n');
  for (const line of details) {
    assert.ok(['-', 'd', 'l'].includes(line[0]), `Unsupported archive entry: ${line}`);
    if (line[0] !== 'l') continue;
    const match = / \.\/(.+) -> (.+)$/.exec(line);
    assert.ok(match, `Unrecognized archive link: ${line}`);
    const [, path, target] = match;
    assert.ok(safeRelativePath(path) && !isAbsolute(target) && !/[\x00-\x1f\x7f\\:]/.test(target));
    const resolved = relative(destination, resolve(destination, dirname(path), target));
    assert.ok(resolved && resolved !== '..' && !resolved.startsWith(`..${sep}`) && !isAbsolute(resolved), `External archive link: ${line}`);
  }
  await mkdir(destination);
  execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--same-permissions', '-C', destination]);
  const manifest = JSON.parse(await readFile(join(destination, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.product, 'cockpit');
  assert.match(manifest.sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(manifest.node, process.versions.node);
  assert.equal(manifest.version, JSON.parse(await readFile(join(destination, 'apps/server/package.json'), 'utf8')).version);
  assert.equal(manifest.start, START_COMMAND);
  assert.equal(manifest.mcpStart, MCP_START_COMMAND);
  assert.deepEqual(manifest.inventoryExcludes, ['runtime-manifest.json']);
  assert.deepEqual(manifest.files, await inventoryTree(destination));
  for (const path of REQUIRED_FILES) assert.ok((await lstat(join(destination, path))).isFile(), path);
  for (const entry of manifest.files) {
    if (!entry.path.split('/').includes('node_modules')) assert.ok(firstPartyRuntimePath(entry.path), `Unexpected first-party payload: ${entry.path}`);
  }
  return manifest;
}

test('packaged commands run compiled JavaScript directly; tsx stays a development tool', () => {
  const root = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const server = JSON.parse(readFileSync(join(repository, 'apps/server/package.json'), 'utf8'));
  const mcp = JSON.parse(readFileSync(join(repository, 'apps/mcp/package.json'), 'utf8'));
  assert.equal(START_COMMAND, 'node --enable-source-maps apps/server/dist/index.js');
  assert.equal(MCP_START_COMMAND, 'node --enable-source-maps apps/mcp/dist/index.js');
  assert.equal(MODULE_COMMAND, 'node --enable-source-maps apps/server/dist/module-cli.js');
  // Source checkouts resolve workspace packages to TypeScript, so their root commands keep the loader.
  assert.equal(root.scripts.start, 'node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts');
  assert.equal(root.scripts['start:mcp'], 'node --import ./apps/mcp/node_modules/tsx/dist/loader.mjs apps/mcp/dist/index.js');
  assert.equal(root.packageManager, 'pnpm@10.34.5');
  assert.equal(root.engines.node, '>=22.12.0');
  for (const manifest of [server, mcp]) {
    assert.equal(manifest.dependencies.tsx, undefined);
    assert.ok(manifest.devDependencies.tsx);
  }
  assert.equal(server.scripts.build, 'tsc -p tsconfig.json');
  for (const path of ['apps/server', 'apps/mcp', 'packages/core', 'packages/protocol']) {
    const config = JSON.parse(readFileSync(join(repository, path, 'tsconfig.json'), 'utf8'));
    assert.equal(config.extends, '../../tsconfig.runtime.json', path);
  }
  const runtimeConfig = JSON.parse(readFileSync(join(repository, 'tsconfig.runtime.json'), 'utf8')).compilerOptions;
  assert.equal(runtimeConfig.sourceMap, true);
  assert.equal(runtimeConfig.rewriteRelativeImportExtensions, true);
  assert.equal(runtimeConfig.noEmit, undefined);
  const workspace = readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /^injectWorkspacePackages: true$/m);
  assert.match(workspace, /^dedupeInjectedDeps: true$/m);
  assert.match(workspace, /syncInjectedDepsAfterScripts:\s+- build/);
});

test('fresh Web installation keeps static app metadata without a worker or archived pages', () => {
  const web = join(repository, 'apps/web');
  const index = readFileSync(join(web, 'index.html'), 'utf8');
  const config = readFileSync(join(web, 'vite.config.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(web, 'public/manifest.webmanifest'), 'utf8'));
  assert.match(index, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.name, 'cockpit');
  for (const size of ['192x192', '512x512']) assert.ok(manifest.icons.some(icon => icon.sizes === size));
  for (const icon of manifest.icons) assert.ok(existsSync(join(web, 'public', icon.src)));
  for (const path of ['src/sw.ts', 'src/assets/vite.svg', 'fixtures/composer-input.html',
    'public/icons.svg', 'public/icon.svg', 'public/favicon.svg', 'public/apple-touch-icon.png',
    'public/icon-192.png', 'public/icon-512.png']) assert.equal(existsSync(join(web, path)), false, path);
  assert.doesNotMatch(config, /VitePWA|injectManifest|chat-lab\.html/);
  assert.doesNotMatch(config, /rolldownOptions/);
  const devDependencies = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).devDependencies;
  assert.equal(devDependencies['vite-plugin-pwa'], undefined);
});

test('Chat Lab stays an opt-in production-component harness rather than another application', () => {
  const web = join(repository, 'apps/web');
  const entry = readFileSync(join(web, 'chat-lab.html'), 'utf8');
  const source = readFileSync(join(web, 'src/dev/chat-lab.tsx'), 'utf8');
  const plugin = readFileSync(join(web, 'chat-lab-plugin.ts'), 'utf8');
  assert.match(entry, /\/src\/dev\/chat-lab-entry\.ts/);
  const loader = readFileSync(join(web, 'src/dev/chat-lab-entry.ts'), 'utf8');
  assert.match(loader, /await import\('\.\/chat-lab'\)/);
  for (const component of ['Thread', 'ChatHeader']) {
    assert.ok(source.includes(`from '../components/${component}'`));
  }
  assert.match(source, /!import\.meta\.env\.DEV.*COCKPIT_CHAT_LAB !== true/);
  assert.doesNotMatch(source, /\.init\s*\(|new NetClient|fetch\s*\(/);
  assert.match(source, /installWorkspaceFixture\(useCockpit\)/);
  const workspace = readFileSync(join(web, 'src/dev/workspace-fixtures.ts'), 'utf8');
  assert.match(workspace, /init: \(\) => \(\) => \{\}/);
  assert.doesNotMatch(workspace, /new NetClient|fetch\s*\(/);
  assert.match(plugin, /apply: 'serve'/);
  assert.match(plugin, /host: '127\.0\.0\.1'/);
  assert.match(plugin, /path\.startsWith\('\/intent\/'\)/);
  assert.equal(firstPartyRuntimePath('apps/web/fixtures/composer-input.html'), false);
  assert.doesNotMatch(readFileSync(join(web, 'index.html'), 'utf8'), /chat-lab/);
});

test('subprocess failures include the original diagnostic instead of hiding package-manager stdout', () => {
  assert.throws(() => command(process.execPath, [
    '-e', 'process.stdout.write("synthetic dependency diagnostic"); process.exit(1)',
  ], repository), /synthetic dependency diagnostic/);
});

test('CI runs the same read-only checks for pull requests, main and release callers', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/build.yml'), 'utf8');
  assert.match(workflow, /pull_request:\s+branches: \[main\]/);
  assert.match(workflow, /push:\s+branches: \[main\]/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /name: Required checks/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /cancel-in-progress:.*github.event_name == 'pull_request'/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|request_id|requestId|environment:|delivery-|transfer|ssh|scp|curl/i);
  for (const action of [
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    'pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa',
    'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ]) assert.ok(workflow.includes(action));
  const mcpSmoke = 'pnpm --filter @cockpit/mcp exec node --import tsx --test src/fork-native.test.ts';
  const build = workflow.indexOf('run: pnpm build');
  assert.match(workflow, /COCKPIT_NATIVE_FORK: '1'/);
  assert.ok(workflow.includes(mcpSmoke));
  assert.ok(build >= 0 && build < workflow.indexOf(mcpSmoke), 'The MCP native smoke requires the compiled MCP client');
  assert.match(workflow, /name: Chat Lab smoke/);
  assert.ok(workflow.includes('pnpm --filter @cockpit/web test:smoke'));
  assert.match(workflow, /name: chat-lab-screenshots-\$\{\{ github\.sha \}\}/);
});

test('release only publishes the checked fixed-tag artifact and does not deploy a service', () => {
  const workflow = readFileSync(join(repository, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /push:\s+tags: \['v\*'\]/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/build\.yml/);
  assert.match(workflow, /publish:\s+needs: checks/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /needs\.checks\.result == 'success'/);
  assert.match(workflow, /node scripts\/publish-release\.mjs/);
  assert.match(workflow, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /group: release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|systemctl|\bssh\b|\bscp\b|release upload|--clobber/);
  assert.doesNotMatch(workflow, /gh release|releases\/tags\//);
  assert.match(workflow, /actions\/download-artifact@[^\n]+\n\s+if: github\.event_name == 'push'/);
  assert.match(workflow, /ref: \$\{\{ inputs\.source_sha \}\}\n\s+path: release-source/);
});

test('synthetic packaging inventories its complete closure and preserves dependency-owned native assets', async t => {
  const f = await fixture(t);
  const result = await f.package();
  const manifest = await unpack(result.archive, join(f.root, 'unpacked'));
  assert.equal(manifest.sourceSha, sourceSha);
  assert.equal(manifest.nodeRequirement, '>=22.12.0');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.sdk.nativePackage, nativePackage);
  assert.equal(result.sha256, await sha256(result.archive));
  assert.equal(await readFile(result.checksum, 'utf8'), `${result.sha256}  runtime.tar.gz\n`);
  assert.deepEqual(readdirSync(join(f.source, 'runtime-output')).sort(), ['runtime.tar.gz', 'runtime.tar.gz.sha256']);
  const paths = manifest.files.map(file => file.path);
  for (const name of ['definitions/test-sidekick-restart.yaml', 'consumer/updater.native', 'tests/native.test.mjs', 'docs/README.md', 'LICENSE']) {
    assert.ok(paths.some(path => path.includes(nativePackage) && path.endsWith(`/${name}`)), name);
  }
  assert.ok(manifest.files.some(file => file.path.endsWith(wrapper) && file.mode === '0755'));
  assert.ok(paths.includes('apps/web/dist/assets/app.js'));
  for (const path of ['apps/server/dist/index.js.map', 'packages/core/dist/index.js.map']) assert.ok(paths.includes(path), path);
  assert.equal(paths.some(path => /^(?:apps\/server|packages\/core)\/src\//.test(path) || path.endsWith('app.js.map')
    || path.includes('test-support') || /node_modules\/(?:\.pnpm\/)?tsx/.test(path)), false);
  const runtimeRoot = JSON.parse(await readFile(join(f.root, 'unpacked/package.json'), 'utf8'));
  assert.deepEqual(runtimeRoot.scripts, { start: START_COMMAND, 'start:mcp': MCP_START_COMMAND, module: MODULE_COMMAND });
  const protocol = JSON.parse(await readFile(join(f.root, 'unpacked/packages/protocol/package.json'), 'utf8'));
  assert.equal(protocol.main, './dist/index.js');
  assert.equal(protocol.types, undefined);
  assert.deepEqual(protocol.exports, { '.': './dist/index.js', './chat': './dist/chat.js', './validation': './dist/validation.js' });
  assert.ok(paths.includes('packages/protocol/src/index.ts'), 'The type export needs protocol sources');
  const server = JSON.parse(await readFile(join(f.root, 'unpacked/apps/server/package.json'), 'utf8'));
  assert.equal(server.scripts, undefined);
  for (const name of ['lucide', 'frontend']) {
    assert.ok(paths.includes(`apps/web/dist/licenses/${name}.txt`));
  }
  assert.ok(paths.includes('NOTICE.md'));
  assert.equal(paths.some(path => path.includes('untracked.ts') || path.endsWith('.modules.yaml') || path.endsWith('/lock.yaml')
    || path.endsWith('/.bin/build-shim')), false);
  for (const call of f.calls.filter(call => call.program === 'pnpm' && call.args.includes('deploy'))) {
    assert.equal(call.args.includes('--legacy'), false, 'Legacy deploy re-resolves registry metadata instead of deriving the locked graph');
    for (const flag of ['--prod', '--offline', '--frozen-lockfile', '--ignore-scripts', '--config.package-import-method=copy']) {
      assert.ok(call.args.includes(flag), flag);
    }
  }
  const second = await f.package({ output: 'second-output' });
  assert.equal(await sha256(second.archive), result.sha256, 'The same inputs should produce the same archive bytes');
});

test('packaging rejects dirty source, the wrong commit, and unsafe or existing output', async t => {
  const f = await fixture(t);
  f.state.dirty = true;
  await assert.rejects(f.package(), /dirty tracked source/);
  f.state.dirty = false;
  await assert.rejects(f.package({ sourceSha: 'c'.repeat(40) }), /checked-out HEAD/);
  for (const value of ['HEAD', 'a'.repeat(39), 'A'.repeat(40), undefined]) {
    await assert.rejects(f.package({ sourceSha: value }), /full lowercase Git/);
  }
  for (const output of ['../outside', '.', 'apps', '.git', 'a/../output', join(f.source, 'absolute')]) {
    await assert.rejects(f.package({ output }), /ordinary direct child/);
  }
  put(f.source, 'runtime-output/preserve.txt', 'Existing output must be untouched');
  await assert.rejects(f.package(), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.source, 'runtime-output/preserve.txt'), 'utf8'), 'Existing output must be untouched');
  await symlink(f.root, join(f.source, 'linked-output'), 'dir');
  await assert.rejects(f.package({ output: 'linked-output' }), { code: 'EEXIST' });
});

test('packaging fails explicitly on missing inputs and dependency failures without retaining partial output', async t => {
  for (const failure of ['tracked', 'web', 'lucide-license', 'frontend-license',
    'mcp', 'server', 'core', 'loader', 'native', 'sdk-version', 'deploy', 'dirty-during-deploy']) {
    await t.test(failure, async t => {
      const f = await fixture(t);
      if (failure === 'tracked') f.tracked.delete('LICENSE');
      if (failure === 'web') await rm(join(f.source, 'apps/web/dist/index.html'));
      if (failure.endsWith('-license')) await rm(join(f.source, `apps/web/dist/licenses/${failure.slice(0, -8)}.txt`));
      if (failure === 'mcp') await writeFile(join(f.source, 'apps/mcp/dist/index.js'), '');
      if (failure === 'server') await rm(join(f.source, 'apps/server/dist/index.js'));
      if (failure === 'core') await rm(join(f.source, 'packages/core/dist'), { recursive: true });
      if (failure === 'loader') f.state.devLoader = true;
      if (failure === 'native') f.state.missingNative = true;
      if (failure === 'sdk-version') f.state.sdkVersion = '9.9.9';
      if (failure === 'deploy') f.state.deployFailure = true;
      if (failure === 'dirty-during-deploy') f.state.dirtyDuringDeploy = true;
      await assert.rejects(f.package(), /Missing tracked|ENOENT|Required runtime file|exact source dependency|deployment failure|dirty tracked|Development loader/);
      assert.equal(existsSync(join(f.source, 'runtime-output')), false);
    });
  }
});

test('packaging rejects linked source/build inputs and external dependency links', async t => {
  for (const kind of ['tracked', 'asset', 'directory', 'dependency']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (kind === 'tracked') f.tracked.set('apps/server/src/index.ts', '120000');
      if (kind === 'asset') await symlink(f.root, join(f.source, 'apps/web/dist/escape'), 'dir');
      if (kind === 'directory') {
        await rm(join(f.source, 'apps/web/dist'), { recursive: true });
        put(f.root, 'outside-dist/index.html', 'Unsafe linked build directory');
        await symlink(join(f.root, 'outside-dist'), join(f.source, 'apps/web/dist'), 'dir');
      }
      if (kind === 'dependency') f.state.externalLink = f.root;
      await assert.rejects(f.package(), /Unsafe tracked input|cannot contain links|cannot contain symlinks|Unsafe runtime link|External runtime path/);
      assert.equal(existsSync(join(f.source, 'runtime-output')), false);
    });
  }
});

test('the inventory rejects broken links and records hashes, sizes, and executable modes', async t => {
  const f = await fixture(t), tree = join(f.root, 'inventory');
  put(tree, 'entry.js', 'console.log("fixture");', 0o755);
  await symlink('missing.js', join(tree, 'broken'));
  await assert.rejects(inventoryTree(tree), { code: 'ENOENT' });
  await rm(join(tree, 'broken'));
  await symlink('entry.js', join(tree, 'alias'));
  const files = await inventoryTree(tree);
  assert.deepEqual(files[0], { path: 'alias', type: 'symlink', target: 'entry.js' });
  assert.equal(files[1].size, Buffer.byteLength('console.log("fixture");'));
  assert.equal(files[1].sha256, await sha256(join(tree, 'entry.js')));
  assert.equal(files[1].mode, '0755');
  await symlink('entry.js', join(tree, 'runtime-manifest.json'));
  await assert.rejects(inventoryTree(tree), /manifest must be a regular file/);
});

test('real offline pnpm closure needs no registry metadata cache and starts directly after relocation', {
  skip: process.env.COCKPIT_PACKAGE_PNPM_SMOKE !== '1',
}, async t => {
  const f = await fixture(t, { realDeploy: true });
  const result = await f.package();
  const unpacked = join(f.root, 'portable');
  const manifest = await unpack(result.archive, unpacked);
  assert.equal(manifest.files.some(file => /node_modules\/(?:\.pnpm\/)?(?:typescript|vite|eslint|tsx|esbuild|@esbuild)(?:@|\/)/.test(file.path)), false);
  const env = { NODE_ENV: 'production' };
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'COPILOT_HOME', 'TMPDIR']) {
    env[key] = join(f.root, 'isolated', key);
    await mkdir(env[key], { recursive: true });
  }
  const server = spawnSync(process.execPath, START_COMMAND.split(' ').slice(1), {
    cwd: unpacked, env, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(server.error);
  assert.equal(server.status, 0, server.stderr);
  const serverResult = JSON.parse(server.stdout);
  assert.equal(serverResult.pid, server.pid, 'The direct entry must be the process that was started');
  assert.deepEqual(serverResult.marker, [7, 'function', 'synthetic']);
  assert.equal(serverResult.fastify, 'function');
  const mcp = spawnSync(process.execPath, MCP_START_COMMAND.split(' ').slice(1), {
    cwd: unpacked, env, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(mcp.error);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).pid, mcp.pid);
  assert.equal(JSON.parse(mcp.stdout).server, 'function');
});

test('the real fixed-commit archive has the complete inventoried runtime and no extracted originals', {
  skip: !process.env.COCKPIT_RUNTIME_ARCHIVE,
}, async t => {
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, 'archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = resolve(process.env.COCKPIT_RUNTIME_ARCHIVE);
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).trim();
  assert.equal(expected, `${await sha256(archive)}  ${basename(archive)}`);
  await unpack(archive, join(root, 'runtime'));
  const sdk = await import(pathToFileURL(join(root, 'runtime/packages/module-api/dist/index.js')));
  assert.equal(sdk.MAX_MODULE_EVENT_BYTES, 65_536);
});
