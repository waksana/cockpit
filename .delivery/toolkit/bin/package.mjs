#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectProject, git } from '../lib/project.mjs';
import { inventory } from '../lib/artifact.mjs';

const [configPath, output, requestId = 'push-build'] = process.argv.slice(2);
if (!configPath || !output || !/^[\w.-]{1,120}$/.test(requestId)) throw Error('Expected committed config, output directory and safe request ID');
const repo = process.cwd(), sha = git(repo, 'rev-parse', 'HEAD');
if (git(repo, 'status', '--porcelain', '--untracked-files=no')) throw Error('Tracked build source changed');
const { project, configSha256 } = inspectProject({ repo, sha, config: configPath });
const stage = await mkdtemp(join(tmpdir(), 'delivery-package-'));
try {
  for (const path of project.build.artifactPaths) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(repo, path), join(stage, path), { recursive: true, verbatimSymlinks: true,
      filter: path => !['.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.cache'].includes(basename(path)) });
  }
  const manifest = { format: 1, sourceSha: sha, configSha256, requestId,
    buildRunId: process.env.GITHUB_RUN_ID ?? 'local', node: process.versions.node,
    platform: process.platform, arch: process.arch, files: await inventory(stage) };
  await writeFile(join(stage, 'delivery-manifest.json'), JSON.stringify(manifest));
  await mkdir(resolve(output), { recursive: true });
  execFileSync('tar', ['-czf', join(resolve(output), 'runtime.tar.gz'), '-C', stage, '.'], { stdio: 'inherit' });
  console.log(JSON.stringify({ sourceSha: sha, configSha256, requestId }));
} finally { await rm(stage, { recursive: true, force: true }); }
