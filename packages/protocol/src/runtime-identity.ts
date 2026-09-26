// Node-only entry point; never re-export this from the browser protocol barrel.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PackageVersion = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
});
const RuntimeManifest = z.object({
  format: z.literal(1), product: z.literal('cockpit'), version: z.string().min(1),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  node: z.string(), platform: z.string(), arch: z.string(),
});

function developmentSource(root: string): string | null {
  // Do not accidentally attribute an unpacked source directory to its ancestor's Git repository.
  try { lstatSync(join(root, '.git')); }
  catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return null;
    throw new Error('Cannot inspect development Git metadata', { cause });
  }
  let sha: string;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
  } catch (cause) {
    throw new Error('Cannot resolve development Git HEAD', { cause });
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Development Git HEAD is not a valid source SHA');
  return sha;
}

export function readRuntimeIdentity(packageFile: URL, manifestFile: URL) {
  const { version: packageVersion } = PackageVersion.parse(JSON.parse(readFileSync(packageFile, 'utf8')));
  let bytes: string | undefined;
  try { bytes = readFileSync(manifestFile, 'utf8'); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const manifest = bytes === undefined ? undefined : RuntimeManifest.parse(JSON.parse(bytes));
  if (manifest && (manifest.version !== packageVersion || manifest.node !== process.versions.node
    || manifest.platform !== process.platform || manifest.arch !== process.arch)) {
    throw new Error('Runtime package version or platform does not match this process');
  }
  if (manifest) return Object.freeze({ version: packageVersion, sourceSha: manifest.sourceSha });
  if (/^0\.0\.0-rolling\./.test(packageVersion)) throw new Error('Rolling runtime requires its runtime manifest');
  const sourceSha = packageVersion === '0.0.0-dev'
    ? developmentSource(dirname(fileURLToPath(manifestFile))) : null;
  return Object.freeze({
    version: packageVersion === '0.0.0-dev' ? `dev+${sourceSha?.slice(0, 12) ?? 'unknown'}` : packageVersion,
    sourceSha,
  });
}
