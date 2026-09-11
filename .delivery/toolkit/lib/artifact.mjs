import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}
export async function inventory(root, directory = root) {
  const out = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), key = relative(root, path), stat = await lstat(path);
    if (key === 'delivery-manifest.json') continue;
    if (stat.isDirectory()) Object.assign(out, await inventory(root, path));
    else if (stat.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !inside(root, resolve(dirname(path), link)) || !inside(root, await realpath(path))) throw Error(`External artifact link: ${key}`);
      out[key] = { link };
    } else if (stat.isFile()) {
      if (stat.mode & 0o6000) throw Error(`Privileged artifact entry: ${key}`);
      out[key] = { sha256: await hashFile(path), executable: stat.mode & 0o111 };
    } else throw Error(`Unsupported artifact entry: ${key}`);
  }
  return out;
}
export async function verifyArtifact(root, expected) {
  const manifest = JSON.parse(await readFile(join(root, 'delivery-manifest.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) if (manifest[key] !== value) throw Error(`Artifact ${key} mismatch`);
  if (manifest.node !== process.versions.node || manifest.platform !== process.platform || manifest.arch !== process.arch) throw Error('Runtime/toolchain mismatch');
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(manifest.files)) throw Error('Artifact inventory mismatch');
  return manifest;
}
