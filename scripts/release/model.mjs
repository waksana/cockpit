import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const SHA = /^[a-f0-9]{40}$/;
export const DIGEST = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith('../'));
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(root, dir = root) {
  const files = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const key = relative(root, path);
    if (key === 'release-manifest.json') continue;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !inside(root, resolve(dirname(path), target))
        || !inside(root, await realpath(path))) throw new Error(`Release link escapes or is broken: ${key}`);
      files[key] = { link: target };
    } else if (stat.isDirectory()) {
      Object.assign(files, await inventory(root, path));
    } else if (stat.isFile()) {
      if (stat.mode & 0o6000) throw new Error(`Privileged file mode: ${key}`);
      files[key] = { sha256: await hashFile(path), executable: stat.mode & 0o111 };
    } else {
      throw new Error(`Unsupported release entry: ${key}`);
    }
  }
  return files;
}

export async function verifyRelease(root, expectedSha) {
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !SHA.test(manifest.commit) || manifest.commit !== expectedSha
    || manifest.node !== process.versions.node || manifest.platform !== process.platform
    || manifest.arch !== process.arch || typeof manifest.rollbackSafe !== 'boolean'
    || !Array.isArray(manifest.owners)
    || manifest.owners.some(owner => !UUID.test(owner.sessionId) || !SHA.test(owner.commit))) {
    throw new Error('Release identity or runtime compatibility mismatch');
  }
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(manifest.files)) {
    throw new Error('Release inventory/hash mismatch');
  }
  for (const required of ['apps/server/src/index.ts', 'packages/core/src/index.ts',
    'packages/protocol/src/index.ts', 'apps/mcp/dist/index.js', 'apps/web/dist/index.html',
    'node_modules/.pnpm/lock.yaml']) {
    if (!manifest.files[required]) throw new Error(`Incomplete release: ${required}`);
  }
  return manifest;
}

export function validateBuild(run, artifact, config) {
  if (run.repository?.full_name !== config.repository || run.event !== 'push'
    || run.head_branch !== 'main' || run.path !== '.github/workflows/ci.yml'
    || run.status !== 'completed' || run.conclusion !== 'success' || !SHA.test(run.head_sha)
    || artifact.expired || artifact.workflow_run?.id !== run.id
    || artifact.workflow_run?.head_sha !== run.head_sha
    || artifact.name !== `release-${run.head_sha}`
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')) {
    throw new Error('Not a successful trusted main build artifact');
  }
  return { commit: run.head_sha, runId: run.id, attempt: run.run_attempt,
    artifactId: artifact.id, digest: artifact.digest.slice(7), id: `${run.head_sha}-${artifact.id}` };
}

export async function selectCandidate(state, candidate, isAncestor) {
  if (state.failed?.id === candidate.id) throw new Error('Candidate already failed; submit a forward fix');
  if (state.desired?.id === candidate.id || state.active?.id === candidate.id) return state;
  const watermark = state.highWatermark;
  if (watermark && (watermark === candidate.commit || !await isAncestor(watermark, candidate.commit))) {
    throw new Error('Superseded or conflicting candidate; explicit rollback is required');
  }
  return { ...state, desired: candidate, highWatermark: candidate.commit, phase: 'pending-idle' };
}

export async function readState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { format: 1, phase: 'uninitialized', notified: [] };
    throw error;
  }
}

export async function writeState(path, state) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
}
