import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inventory, SHA, UUID } from './model.mjs';

const root = process.cwd();
const output = resolve(process.argv[2] ?? 'release-output');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
if (!SHA.test(commit) || git('status', '--porcelain', '--untracked-files=no')) {
  throw new Error('Build requires an unchanged tracked commit');
}
const policy = JSON.parse(await readFile(join(root, 'deploy/release-policy.json'), 'utf8'));
if (typeof policy.rollbackSafe !== 'boolean') throw new Error('Explicit rollback policy required');
const stage = await mkdtemp(join(tmpdir(), 'cockpit-package-'));
try {
  const tracked = git('ls-files').split('\n').filter(path =>
    /^(?:apps\/(?:server|mcp)\/src|packages\/(?:core|protocol)\/src)\//.test(path)
      && !/\.(?:test\.ts|mts)$/.test(path)
    || /^(?:(?:apps|packages)\/[^/]+\/)?(?:package\.json|tsconfig[^/]*\.json)$/.test(path)
    || ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'NOTICE.md'].includes(path));
  for (const path of tracked) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(root, path), join(stage, path), { verbatimSymlinks: true });
  }
  for (const path of ['node_modules', 'apps/server/node_modules', 'apps/mcp/node_modules',
    'apps/web/node_modules', 'packages/core/node_modules', 'packages/protocol/node_modules',
    'apps/web/dist', 'apps/mcp/dist']) {
    await cp(join(root, path), join(stage, path), {
      recursive: true, verbatimSymlinks: true,
      // pnpm's generated command shims can embed checkout paths; runtime imports
      // packages directly and does not need those shims or package-manager state.
      filter: source => !['.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.cache'].includes(basename(source)),
    });
  }
  const owners = [];
  for (const record of git('log', '--format=%H%x1f%B%x1e').split('\x1e')) {
    const [sha, body] = record.trim().split('\x1f');
    for (const match of (body ?? '').matchAll(/^Cockpit-Owner-Session: ([a-f0-9-]+)$/gm)) {
      if (SHA.test(sha) && UUID.test(match[1])) owners.push({ sessionId: match[1], commit: sha });
    }
  }
  const manifest = {
    format: 1, commit, node: process.versions.node, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    platform: process.platform, arch: process.arch, rollbackSafe: policy.rollbackSafe,
    owners, files: await inventory(stage),
  };
  await writeFile(join(stage, 'release-manifest.json'), `${JSON.stringify(manifest)}\n`);
  // Resolve workspace/tsx/SDK from the relocated closure, never the checkout.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'await import("@cockpit/core"); await import("@cockpit/protocol"); await import("@github/copilot-sdk")'],
  { cwd: join(stage, 'packages/core'), env: { ...process.env, COCKPIT_NO_BOOT: '1' }, stdio: 'inherit' });
  await mkdir(output, { recursive: true });
  execFileSync('tar', ['-czf', join(output, 'release.tar.gz'), '-C', stage, '.'], { stdio: 'inherit' });
  console.log(JSON.stringify({ commit, package: join(output, 'release.tar.gz') }));
} finally {
  await rm(stage, { recursive: true, force: true });
}
