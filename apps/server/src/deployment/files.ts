import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { directory, regularBytes, syncModuleDirectory, writeModuleBytes } from '../module-install.ts';
import { acquireAbstractLease } from '../module-lease.ts';

export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const missing = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

export async function privateDirectory(path: string): Promise<void> {
  await directory(path, true);
  const stat = await lstat(path);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error(`Expected an owner-only directory: ${path}`);
}

export async function privateBytes(path: string, max = 1024 * 1024): Promise<Buffer> {
  const stat = await lstat(path);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error(`Expected an owner-only file: ${path}`);
  return regularBytes(path, max);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeModuleBytes(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function exclusiveJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await syncModuleDirectory(dirname(path));
}

export async function fileHash(path: string): Promise<string> {
  const sum = createHash('sha256');
  for await (const chunk of createReadStream(path)) sum.update(chunk);
  return sum.digest('hex');
}

export async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) for await (const bytes of response.body) {
    size += bytes.byteLength;
    if (size > maximum) throw new Error('HTTP response exceeds its expected size limit');
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}

export async function deploymentLease(root: string, hostRoot: string): Promise<() => Promise<void>> {
  await privateDirectory(root);
  await directory(hostRoot, false);
  const releaseState = await acquireAbstractLease(await realpath(root), 'host', 'Another deployment service owns this state root');
  try {
    const releaseHost = await acquireAbstractLease(await realpath(hostRoot), 'deployment', 'Another deployment service manages this host');
    return async () => { try { await releaseHost(); } finally { await releaseState(); } };
  } catch (error) { await releaseState(); throw error; }
}

export async function plainTree(root: string, maximum: number): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  let total = 0;
  const walk = async (path: string, prefix: string) => {
    await directory(path, false);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else {
        const stat = await lstat(absolute);
        if (!entry.isFile() || stat.nlink !== 1) throw new Error(`Backup refuses links or special files: ${relative}`);
        total += stat.size;
        if (total > maximum || files.length >= 100000) throw new Error('Backup exceeds its configured size or entry limit');
        files.push({ path: relative, size: stat.size, sha256: await fileHash(absolute) });
      }
    }
  };
  try { await lstat(root); }
  catch (error) { if (missing(error)) return []; throw error; }
  await walk(resolve(root), '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function newDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await syncModuleDirectory(dirname(path));
}
