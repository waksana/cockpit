import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import { directory, syncModuleDirectory } from '../module-install.ts';
import { digest, relative, type PinnedRelease } from './contracts.ts';
import { fileHash, hash, missing } from './files.ts';

const file = z.object({
  path: relative, type: z.literal('file'), size: z.number().int().nonnegative().max(512 * 1024 ** 2),
  mode: z.enum(['0644', '0755']), sha256: digest,
}).strict();
const link = z.object({ path: relative, type: z.literal('symlink'), target: z.string().min(1).max(4096) }).strict();
const RuntimeManifest = z.object({
  format: z.literal(1), product: z.literal('cockpit'), version: z.string(),
  sourceSha: z.string(), node: z.string(), platform: z.literal('linux'), arch: z.literal('x64'),
  files: z.array(z.discriminatedUnion('type', [file, link])).min(1).max(100000),
});
export type RuntimeManifest = z.infer<typeof RuntimeManifest>;
type Entry = { type: 'file'; bytes: Buffer; mode: string } | { type: 'symlink'; target: string };
const required = ['package.json', 'apps/server/dist/index.js', 'apps/server/dist/module-cli.js',
  'apps/web/dist/index.html', 'packages/protocol/dist/index.js', 'packages/core/package.json'];

function inside(path: string, target: string): void {
  if (isAbsolute(target) || /[\\:\x00-\x1f\x7f]/.test(target)) throw new Error('Unsafe runtime symlink');
  const root = '/runtime';
  const resolved = resolve(root, dirname(path), target);
  if (resolved === root || !resolved.startsWith(`${root}/`)) throw new Error('Runtime symlink escapes its installation');
}

async function unpack(archive: string): Promise<Map<string, Entry>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(archive).pipe(createGunzip())) {
    size += chunk.length;
    if (size > 1024 ** 3) throw new Error('Expanded runtime archive exceeds 1 GiB');
    chunks.push(chunk);
  }
  const tar = Buffer.concat(chunks);
  const entries = new Map<string, Entry>();
  const seen = new Set<string>();
  const string = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
  const number = (bytes: Buffer) => {
    const value = string(bytes).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('Unsupported tar numeric field');
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new Error('Oversized tar numeric field');
    return parsed;
  };
  let longName: string | undefined, longTarget: string | undefined, offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every(byte => byte === 0) || longName || longTarget) {
        throw new Error('Invalid runtime tar terminator');
      }
      terminated = true;
      break;
    }
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (checksum !== number(header.subarray(148, 156))) throw new Error('Invalid runtime tar checksum');
    const kind = String.fromCharCode(header[156]!);
    const length = number(header.subarray(124, 136));
    const start = offset + 512, end = start + length;
    offset = start + Math.ceil(length / 512) * 512;
    if (offset > tar.length) throw new Error('Truncated runtime tar');
    const bytes = tar.subarray(start, end);
    if (kind === 'L' || kind === 'K') {
      if (length > 4096 || !length || bytes[length - 1] !== 0) throw new Error('Invalid GNU long-name record');
      if (kind === 'L') { if (longName) throw new Error('Duplicate GNU name'); longName = string(bytes); }
      else { if (longTarget) throw new Error('Duplicate GNU link'); longTarget = string(bytes); }
      continue;
    }
    let name = longName ?? string(header.subarray(0, 100));
    const target = longTarget ?? string(header.subarray(157, 257));
    longName = undefined; longTarget = undefined;
    if (name.startsWith('./')) name = name.slice(2);
    if (kind === '5' && name.endsWith('/')) name = name.slice(0, -1);
    if (!name && kind === '5' && !length) continue;
    relative.parse(name);
    if (seen.has(name) || seen.size >= 100000) throw new Error('Duplicate runtime archive entry or entry limit exceeded');
    seen.add(name);
    for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) {
      if (entries.has(parent)) throw new Error('Runtime archive entry traverses a file or symlink');
    }
    if (kind === '5') {
      if (length || target) throw new Error('Invalid runtime directory');
    } else if (kind === '2') {
      if (length) throw new Error('Runtime symlink has content');
      inside(name, target);
      entries.set(name, { type: 'symlink', target });
    } else if (kind === '0' || kind === '\0') {
      if (target) throw new Error('Unexpected runtime link target');
      entries.set(name, { type: 'file', bytes, mode: number(header.subarray(100, 108)).toString(8).padStart(4, '0') });
    } else throw new Error('Unsupported runtime tar entry (only files, directories and internal symlinks are allowed)');
  }
  if (!terminated) throw new Error('Unterminated runtime tar');
  for (const path of seen) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      if (entries.has(parent)) throw new Error('Runtime archive shadows a parent directory');
    }
  }
  return entries;
}

export async function verifyRuntime(root: string, expected?: PinnedRelease): Promise<RuntimeManifest> {
  await directory(root, false);
  const manifest = RuntimeManifest.parse(JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8')));
  const report = z.object({ header: z.object({ glibcVersionRuntime: z.string() }) }).safeParse(process.report.getReport());
  if (manifest.node !== process.versions.node || process.platform !== 'linux' || process.arch !== 'x64'
    || !report.success) throw new Error('Runtime requires the exact Node version and Linux x64 glibc platform');
  if (expected && (manifest.version !== expected.version || manifest.sourceSha !== expected.sourceSha)) throw new Error('Runtime release/source identity mismatch');
  const inventory = new Map(manifest.files.map(entry => [entry.path, entry]));
  if (inventory.size !== manifest.files.length || inventory.has('runtime-manifest.json')
    || required.some(path => !inventory.has(path))) throw new Error('Invalid or incomplete runtime inventory');
  const seen = new Set<string>();
  const walk = async (path: string, prefix = ''): Promise<void> => {
    await directory(path, false);
    for (const name of await readdir(path)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const absolute = join(path, name);
      const stat = await lstat(absolute);
      if (rel === 'runtime-manifest.json') { if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid runtime manifest file'); continue; }
      if (stat.isDirectory()) { await walk(absolute, rel); continue; }
      const entry = inventory.get(rel);
      if (!entry) throw new Error(`Unexpected runtime file: ${rel}`);
      if (entry.type === 'file') {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size || (stat.mode & 0o777).toString(8).padStart(4, '0') !== entry.mode
          || await fileHash(absolute) !== entry.sha256) throw new Error(`Runtime integrity mismatch: ${rel}`);
      } else {
        inside(rel, entry.target);
        const actual = await realpath(absolute);
        if (!stat.isSymbolicLink() || await readlink(absolute) !== entry.target || !actual.startsWith(`${resolve(root)}/`)) {
          throw new Error(`Runtime link mismatch: ${rel}`);
        }
      }
      seen.add(rel);
    }
  };
  await walk(root);
  if (seen.size !== inventory.size) throw new Error('Runtime inventory file is missing');
  return manifest;
}

export async function installRuntime(archive: string, pin: PinnedRelease, installRoot: string): Promise<string> {
  await directory(installRoot, true);
  const root = join(installRoot, `${pin.version}-${pin.sha256}`);
  const versions = (await readdir(installRoot)).filter(name => name.startsWith(`${pin.version}-`));
  if (versions.some(name => name !== `${pin.version}-${pin.sha256}`)) throw new Error('This host version is already installed with different bytes');
  let existing = true;
  try { await lstat(root); }
  catch (error) { if (!missing(error)) throw error; existing = false; }
  if (existing) { await verifyRuntime(root, pin); return root; }
  const entries = await unpack(archive);
  const raw = entries.get('runtime-manifest.json');
  if (raw?.type !== 'file' || raw.bytes.length > 16 * 1024 ** 2) throw new Error('Missing or oversized runtime manifest');
  const manifest = RuntimeManifest.parse(JSON.parse(raw.bytes.toString('utf8')));
  if (manifest.version !== pin.version || manifest.sourceSha !== pin.sourceSha || manifest.node !== process.versions.node) {
    throw new Error('Candidate runtime manifest does not match the pinned Release or Node');
  }
  if (manifest.files.length !== entries.size - 1) throw new Error('Runtime archive and manifest have different file sets');
  for (const file of manifest.files) {
    const entry = entries.get(file.path);
    if (!entry || entry.type !== file.type) throw new Error(`Missing runtime archive entry: ${file.path}`);
    if (entry.type === 'file' && file.type === 'file'
      && (entry.bytes.length !== file.size || entry.mode !== file.mode || hash(entry.bytes) !== file.sha256)) {
      throw new Error(`Runtime archive digest mismatch: ${file.path}`);
    }
    if (entry.type === 'symlink' && file.type === 'symlink' && entry.target !== file.target) throw new Error('Runtime archive link differs from its manifest');
  }
  const staging = join(installRoot, `.deployment-${pin.sha256}`);
  await mkdir(staging, { mode: 0o700 });
  // Interrupted staging is preserved; a later request never overwrites or silently repairs it.
  for (const [name, entry] of entries) {
    const path = join(staging, name);
    await mkdir(dirname(path), { recursive: true });
    if (entry.type !== 'file') continue;
    const output = await open(path, 'wx', Number.parseInt(entry.mode, 8));
    try { await output.writeFile(entry.bytes); await output.sync(); } finally { await output.close(); }
    await chmod(path, Number.parseInt(entry.mode, 8));
  }
  for (const [name, entry] of entries) if (entry.type === 'symlink') await symlink(entry.target, join(staging, name));
  await verifyRuntime(staging, pin);
  const seal = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await seal(join(path, entry.name));
    await syncModuleDirectory(path);
  };
  await seal(staging);
  await rename(staging, root);
  await syncModuleDirectory(installRoot);
  return root;
}

export function inInstallation(root: string, path: string): boolean {
  const name = relativePath(root, path);
  return !!name && !name.startsWith('..') && !isAbsolute(name);
}
