import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaged entry points run precompiled JavaScript directly; no TypeScript loader ships.
export const START_COMMAND = 'node --enable-source-maps apps/server/dist/index.js';
export const MCP_START_COMMAND = 'node --enable-source-maps apps/mcp/dist/index.js';
export const MODULE_COMMAND = 'node --enable-source-maps apps/server/dist/module-cli.js';
export const DEPLOYMENT_COMMAND = 'node --enable-source-maps apps/server/dist/deployment-cli.js';
export const REQUIRED_FILES = [
  'LICENSE', 'NOTICE.md', 'package.json',
  'apps/server/package.json', 'apps/server/dist/index.js', 'apps/server/dist/index.js.map',
  'apps/server/dist/module-cli.js',
  'apps/server/dist/deployment-cli.js', 'apps/server/dist/deployment/candidate.js',
  'apps/web/dist/index.html',
  'apps/web/dist/licenses/lucide.txt', 'apps/web/dist/licenses/frontend.txt',
  'apps/mcp/package.json', 'apps/mcp/dist/index.js',
  'packages/core/package.json', 'packages/core/dist/index.js',
  'packages/protocol/package.json', 'packages/protocol/dist/index.js',
  'packages/protocol/src/index.ts',
  'packages/module-api/package.json', 'packages/module-api/dist/index.js',
  'packages/module-api/dist/index.d.ts', 'packages/module-api/runtime.js',
];
// Build outputs copied from the checkout; the Web is separately copied into the runtime.
const compiledPackages = ['apps/server', 'apps/mcp', 'packages/core', 'packages/protocol', 'packages/module-api'];
const compiledMap = /^(?:apps\/(?:server|mcp)|packages\/(?:core|protocol|module-api))\/dist\/.+\.js\.map$/;
// Development-only loaders must never reach the runtime closure.
const forbiddenRuntimeDependency = /(?:^|\/)node_modules\/(?:\.pnpm\/)?(?:tsx|esbuild|@esbuild[+/])/;
const packagePaths = ['apps/server', 'apps/mcp', 'packages/core', 'packages/protocol', 'packages/module-api'];
const sourceRoots = [
  'LICENSE', 'NOTICE.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/web/package.json',
  ...packagePaths.map(path => `${path}/package.json`),
  'packages/module-api/runtime.js', 'packages/module-api/runtime.d.ts',
  'apps/server/src', 'packages/core/src', 'packages/protocol/src',
];
const omittedDirectories = new Set([
  '.git', '.github', '.delivery', 'module-staging', 'modules', 'consumer', 'deploy',
  'updater', 'supervisor', 'installer', 'node_modules',
  'docs', 'archive', 'archives', 'diagnostics', 'fixtures', '__fixtures__', 'test', 'tests', '__tests__', 'test-support',
]);

export function command(program, args, cwd) {
  try {
    return execFileSync(program, args, {
      cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TMPDIR: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).map(value => String(value).trim()).filter(Boolean);
    if (output.length) throw new Error(`${error.message}\n${output.join('\n')}`, { cause: error });
    throw error;
  }
}

function contained(root, path) {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

export function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path)
    && !/[\x00-\x1f\x7f\\:]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function firstPartyRuntimePath(path) {
  if (path === 'NOTICE.md') return true;
  if (compiledMap.test(path)) return safeRelativePath(path) && !path.split('/').some(part => omittedDirectories.has(part));
  return safeRelativePath(path)
    && !path.split('/').some(part => omittedDirectories.has(part))
    && !/(?:\.test\.|\.spec\.|\.map$|\.mdx?$|\.rst$)/i.test(path)
    && !/^(?:(?:consumer|updater|supervisor|installer|deploy|delivery)(?:[-.]|$)|diagnostic-|regress-|service-delivery|heap-config|start\.mjs$)/.test(basename(path))
    && !['delivery-status.ts', 'consumer-runtime.json'].includes(basename(path));
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function nonemptyFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Required runtime file is missing, empty, or not a regular file: ${path}`);
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function copyBuiltTree(source, target, path) {
  const stat = await lstat(source);
  if (!stat.isDirectory()) throw new Error(`Build input is not a regular directory: ${source}`);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const name = `${path}/${entry.name}`;
    if (!safeRelativePath(name)) throw new Error(`Unsafe build input path: ${name}`);
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`Build inputs cannot contain links or special files: ${name}`);
    if (!firstPartyRuntimePath(name)) continue;
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await copyBuiltTree(from, to, name);
    else {
      await copyFile(from, to);
      await chmod(to, (await lstat(from)).mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function cleanHead(repository, sourceSha, run) {
  if (run('git', ['rev-parse', 'HEAD'], repository).trim() !== sourceSha) {
    throw new Error('The requested source SHA must be the checked-out HEAD commit');
  }
  if (run('git', ['status', '--porcelain=v1', '--untracked-files=no'], repository).trim()) {
    throw new Error('Refusing to package dirty tracked source; commit the complete change and rebuild first');
  }
}

async function snapshotSource(repository, target, sourceSha, run) {
  const entries = run('git', ['ls-tree', '-rz', '--full-tree', sourceSha, '--', ...sourceRoots], repository)
    .split('\0').filter(Boolean);
  const paths = [];
  for (const entry of entries) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
    if (!match || !safeRelativePath(match[2])) throw new Error(`Unsafe tracked input (links and submodules are not supported): ${entry}`);
    if (firstPartyRuntimePath(match[2])) paths.push(match[2]);
  }
  for (const path of sourceRoots.filter(path => !path.endsWith('/src'))) {
    if (!paths.includes(path)) throw new Error(`Missing tracked packaging input: ${path}`);
  }
  const archive = join(dirname(target), 'source.tar');
  run('git', ['archive', '--format=tar', `--output=${archive}`, sourceSha, '--', ...paths], repository);
  await mkdir(target);
  run('tar', ['-xf', archive, '-C', target], repository);
}

async function internalPath(root, path) {
  const actual = await realpath(path);
  if (!contained(root, actual)) throw new Error(`External runtime path: ${path}`);
  return actual;
}

async function relocateWorkspace(root, app, name, destination, reuse = false, packageName = name) {
  const source = await internalPath(root, join(root, app, 'node_modules', name));
  const target = join(root, destination);
  if ((await json(join(source, 'package.json'))).name !== packageName) throw new Error(`Unexpected workspace dependency at ${source}`);
  // pnpm's scoped package lives beside its dependency links in a virtual node_modules.
  const peers = dirname(dirname(source));
  if (basename(peers) !== 'node_modules' || !source.includes(`${sep}.pnpm${sep}`)) {
    throw new Error(`Unsupported pnpm deployment layout: ${source}`);
  }
  if (reuse) {
    if ((await json(join(source, 'package.json'))).version !== (await json(join(target, 'package.json'))).version) {
      throw new Error(`Conflicting deployed workspace versions: ${name}`);
    }
    await rm(source, { recursive: true });
  } else {
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    await symlink(relative(target, peers), join(target, 'node_modules'), 'dir');
  }
  await symlink(relative(dirname(source), target), source, 'dir');
}

const compiledEntry = value => typeof value === 'string' ? value.replace(/^\.\/src\/(.+)\.ts$/, './dist/$1.js') : value;
const compiledExport = value => {
  if (typeof value === 'string') return compiledEntry(value);
  if (value && typeof value === 'object') return compiledEntry(value.import ?? value.default);
  return value;
};

// Workspace manifests point at TypeScript sources for development; the runtime resolves compiled output.
// Nested scripts are dropped: the root package.json holds the supported runtime commands.
async function runtimePackageJson(path, compiled) {
  const { devDependencies: _devDependencies, files: _files, scripts: _scripts, ...manifest } = await json(path);
  if (compiled) {
    delete manifest.types;
    if (manifest.main) manifest.main = compiledEntry(manifest.main);
    if (manifest.exports) {
      manifest.exports = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key, compiledExport(value)]));
    }
    for (const value of [manifest.main, ...Object.values(manifest.exports ?? {})]) {
      if (value !== undefined && !/^\.\/(?:dist\/.+|runtime)\.js$/.test(value)) {
        throw new Error(`Unsupported runtime entry in ${path}: ${JSON.stringify(value)}`);
      }
    }
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function removePnpmMetadata(nodeModules) {
  for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json', '.bin', '.pnpm/lock.yaml', '.pnpm/node_modules/.bin']) {
    await rm(join(nodeModules, name), { recursive: true, force: true });
  }
  for (const entry of await readdir(join(nodeModules, '.pnpm'), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      await rm(join(nodeModules, '.pnpm', entry.name, 'node_modules/.bin'), { recursive: true, force: true });
    }
  }
}

export async function inventoryTree(root, { normalizeModes = false } = {}) {
  const files = [];
  const visit = async (directory, prefix = '') => {
    if (normalizeModes) await chmod(directory, 0o755);
    for (const entry of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${entry}` : entry;
      if (!safeRelativePath(path)) throw new Error(`Unsafe runtime path: ${path}`);
      const absolute = join(directory, entry);
      const stat = await lstat(absolute);
      if (path === 'runtime-manifest.json') {
        if (!stat.isFile()) throw new Error('The runtime manifest must be a regular file');
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (isAbsolute(target) || /[\x00-\x1f\x7f\\:]/.test(target) || !contained(root, resolve(directory, target))) {
          throw new Error(`Unsafe runtime link: ${path} -> ${target}`);
        }
        await internalPath(root, absolute);
        files.push({ path, type: 'symlink', target });
      } else if (stat.isDirectory()) {
        await visit(absolute, path);
      } else if (stat.isFile()) {
        const mode = normalizeModes ? stat.mode & 0o111 ? 0o755 : 0o644 : stat.mode & 0o777;
        if (normalizeModes) await chmod(absolute, mode);
        files.push({ path, type: 'file', size: stat.size, mode: mode.toString(8).padStart(4, '0'), sha256: await sha256(absolute) });
      } else throw new Error(`Unsupported runtime file type: ${path}`);
    }
  };
  await visit(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function runtimePlatform() {
  if (!['x64', 'arm64'].includes(process.arch) || !['linux', 'darwin', 'win32'].includes(process.platform)) {
    throw new Error(`Unsupported native runtime platform: ${process.platform}-${process.arch}`);
  }
  const os = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform;
  return `${os}-${process.arch}`;
}

export async function validateRuntime(root, sdkVersion) {
  for (const path of REQUIRED_FILES) await nonemptyFile(join(root, path));
  const require = createRequire(join(root, 'packages/core/package.json'));
  const sdkEntry = await internalPath(root, require.resolve('@github/copilot-sdk'));
  let sdk = dirname(sdkEntry);
  while (contained(root, sdk)) {
    try {
      const manifest = await json(join(sdk, 'package.json'));
      if (manifest.name === '@github/copilot-sdk') break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    sdk = dirname(sdk);
  }
  const sdkManifest = await json(join(sdk, 'package.json'));
  if (sdkManifest.name !== '@github/copilot-sdk' || sdkManifest.version !== sdkVersion) {
    throw new Error('The deployed SDK does not match the exact source dependency');
  }
  const nativePlatform = runtimePlatform();
  const nativePackage = `@github/copilot-sdk-${nativePlatform}`;
  const nativeManifestPath = await internalPath(root, createRequire(join(sdk, 'package.json')).resolve(`${nativePackage}/package.json`));
  const nativeManifest = await json(nativeManifestPath);
  if (nativeManifest.name !== nativePackage || nativeManifest.version !== sdkVersion) {
    throw new Error('The deployed SDK platform package does not match the exact SDK version');
  }
  const nativeRoot = dirname(nativeManifestPath);
  const wrapper = `prebuilds/${nativePlatform}/copilot-runtime${process.platform === 'win32' ? '.exe' : ''}`;
  for (const path of [wrapper, `prebuilds/${nativePlatform}/runtime.node`, 'copilot-sdk/index.js', 'sdk/index.js']) {
    await nonemptyFile(join(nativeRoot, path));
  }
  if (process.platform !== 'win32' && !((await lstat(join(nativeRoot, wrapper))).mode & 0o111)) {
    throw new Error('The native SDK runtime is not executable');
  }
  return { version: sdkVersion, nativePackage, nativePlatform };
}

export async function packageRuntime({ repository, sourceSha, output = 'runtime-output' }, run = command) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('--source-sha must be a full lowercase Git commit SHA');
  repository = await realpath(repository);
  if (await realpath(run('git', ['rev-parse', '--show-toplevel'], repository).trim()) !== repository) {
    throw new Error('Packaging must run at the Git worktree root');
  }
  const outputPath = resolve(repository, output);
  const outputName = relative(repository, outputPath);
  if (output !== outputName || dirname(outputPath) !== repository || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(outputName)
      || ['apps', 'packages', 'scripts', 'node_modules', 'docs', 'deploy', 'module-staging'].includes(outputName)) {
    throw new Error('Output must be a new, ordinary direct child directory of the repository');
  }
  cleanHead(repository, sourceSha, run);
  const sourceTime = run('git', ['show', '-s', '--format=%ct', sourceSha], repository).trim();
  if (!/^\d+$/.test(sourceTime)) throw new Error('Invalid source commit timestamp');
  for (const directory of ['apps/web/dist', ...compiledPackages.map(path => `${path}/dist`)]) {
    const path = join(repository, directory);
    if (await realpath(path) !== path) throw new Error(`Build input paths cannot contain symlinks: ${directory}`);
  }
  for (const path of ['apps/web/dist/index.html', ...compiledPackages.map(path => `${path}/dist/index.js`)]) {
    await nonemptyFile(join(repository, path));
  }
  await mkdir(outputPath); // Exclusive creation: never merge with or replace previous output.
  const work = join(outputPath, '.work'), source = join(work, 'source'), runtime = join(work, 'runtime');
  try {
    await mkdir(work);
    await snapshotSource(repository, source, sourceSha, run);
    const rootPackage = await json(join(source, 'package.json'));
    const serverPackage = await json(join(source, 'apps/server/package.json'));
    const mcpPackage = await json(join(source, 'apps/mcp/package.json'));
    const corePackage = await json(join(source, 'packages/core/package.json'));
    const sdkVersion = corePackage.dependencies?.['@github/copilot-sdk'];
    if (!/^\d+\.\d+\.\d+$/.test(sdkVersion ?? '')) throw new Error('The SDK runtime must be pinned to an exact version');
    if (serverPackage.dependencies?.tsx || mcpPackage.dependencies?.tsx) {
      throw new Error('The runtime runs compiled JavaScript; tsx must stay a development dependency');
    }
    if (!rootPackage.engines?.node || !serverPackage.version) throw new Error('Missing Node prerequisite or server version');
    if (rootPackage.packageManager !== `pnpm@${run('pnpm', ['--version'], source).trim()}`) {
      throw new Error('Use the exact pnpm version pinned in package.json');
    }
    for (const path of compiledPackages) {
      await copyBuiltTree(join(repository, path, 'dist'), join(source, path, 'dist'), `${path}/dist`);
    }
    await mkdir(join(runtime, 'apps'), { recursive: true });
    for (const app of ['server', 'mcp']) {
      run('pnpm', [
        '--filter', `@cockpit/${app}`, 'deploy', '--prod', '--offline',
        '--frozen-lockfile', '--ignore-scripts', '--config.package-import-method=copy',
        join(runtime, 'apps', app),
      ], source);
      await removePnpmMetadata(join(runtime, 'apps', app, 'node_modules'));
    }
    await relocateWorkspace(runtime, 'apps/server', '@cockpit/core', 'packages/core');
    await relocateWorkspace(runtime, 'apps/server', '@cockpit/protocol', 'packages/protocol');
    await relocateWorkspace(runtime, 'apps/server', '@cockpit/module-api', 'packages/module-api', false,
      '@waksana/cockpit-module-sdk');
    await relocateWorkspace(runtime, 'apps/mcp', '@cockpit/protocol', 'packages/protocol', true);
    for (const path of packagePaths) {
      await runtimePackageJson(join(runtime, path, 'package.json'),
        ['packages/core', 'packages/protocol', 'packages/module-api'].includes(path));
    }
    // pnpm always packs a manifest's `main`; core's TypeScript entry is not a runtime input.
    await rm(join(runtime, 'packages/core/src'), { recursive: true, force: true });
    await copyBuiltTree(join(repository, 'apps/web/dist'), join(runtime, 'apps/web/dist'), 'apps/web/dist');
    await copyFile(join(source, 'LICENSE'), join(runtime, 'LICENSE'));
    await copyFile(join(source, 'NOTICE.md'), join(runtime, 'NOTICE.md'));
    await writeFile(join(runtime, 'package.json'), `${JSON.stringify({
      name: 'cockpit', private: true, version: serverPackage.version, type: 'module',
      license: rootPackage.license, engines: rootPackage.engines,
      scripts: { start: START_COMMAND, 'start:mcp': MCP_START_COMMAND, module: MODULE_COMMAND, deployment: DEPLOYMENT_COMMAND },
    }, null, 2)}\n`);
    const sdk = await validateRuntime(runtime, sdkVersion);
    const files = await inventoryTree(runtime, { normalizeModes: true });
    const loader = files.find(file => forbiddenRuntimeDependency.test(file.path));
    if (loader) throw new Error(`Development loader in the runtime closure: ${loader.path}`);
    const manifest = {
      format: 1, product: 'cockpit', version: serverPackage.version, sourceSha,
      node: process.versions.node, nodeRequirement: rootPackage.engines.node, platform: process.platform, arch: process.arch,
      sdk, start: START_COMMAND, mcpStart: MCP_START_COMMAND, inventoryExcludes: ['runtime-manifest.json'], files,
    };
    await writeFile(join(runtime, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    await chmod(join(runtime, 'runtime-manifest.json'), 0o644);
    cleanHead(repository, sourceSha, run);
    const archive = join(outputPath, 'runtime.tar.gz');
    run('tar', [
      '--sort=name', `--mtime=@${sourceTime}`, '--owner=0', '--group=0', '--numeric-owner',
      '--format=gnu', '--hard-dereference', '-czf', archive, '-C', runtime, '.',
    ], repository);
    cleanHead(repository, sourceSha, run);
    const hash = await sha256(archive), checksum = `${archive}.sha256`;
    await writeFile(checksum, `${hash}  runtime.tar.gz\n`, { flag: 'wx' });
    return { archive, checksum, sha256: hash, sourceSha, version: serverPackage.version, platform: process.platform, arch: process.arch };
  } catch (error) {
    await rm(outputPath, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    if (!['--source-sha', '--output'].includes(option) || !value || value.startsWith('--') || option in values) {
      throw new Error('Usage: node scripts/package-runtime.mjs --source-sha <full-HEAD-SHA> [--output runtime-output]');
    }
    values[option] = value;
  }
  return { sourceSha: values['--source-sha'], output: values['--output'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageRuntime({ repository: fileURLToPath(new URL('../', import.meta.url)), ...parseArgs(process.argv.slice(2)) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
