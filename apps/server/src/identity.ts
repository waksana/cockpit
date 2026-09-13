import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const PackageVersion = z.object({ version: z.string().min(1) });
const RuntimeManifest = z.object({
  format: z.literal(1), product: z.literal('cockpit'), version: z.string().min(1),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  node: z.string(), platform: z.string(), arch: z.string(),
});

export function readIdentity(
  packageFile = new URL('../package.json', import.meta.url),
  manifestFile = new URL('../../../runtime-manifest.json', import.meta.url),
) {
  const { version } = PackageVersion.parse(JSON.parse(readFileSync(packageFile, 'utf8')));
  let bytes: string | undefined;
  try { bytes = readFileSync(manifestFile, 'utf8'); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const manifest = bytes === undefined ? undefined : RuntimeManifest.parse(JSON.parse(bytes));
  if (manifest && (manifest.version !== version || manifest.node !== process.versions.node
    || manifest.platform !== process.platform || manifest.arch !== process.arch)) {
    throw new Error('Runtime package version or platform does not match this process');
  }
  return Object.freeze({ instanceId: randomUUID(), version, sourceSha: manifest?.sourceSha ?? null });
}

export const serviceIdentity = readIdentity();
