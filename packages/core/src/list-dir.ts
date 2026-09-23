import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DirListing } from '@cockpit/protocol';
import { CockpitError } from './errors.ts';

export async function listDir(path?: string): Promise<DirListing> {
  let target = path === undefined ? homedir() : path.trim();
  if (!target) throw new CockpitError('INVALID_DIRECTORY_PATH', 'Directory path must not be empty; omit path to list the home directory.');
  if (target === '~' || target.startsWith('~/')) target = join(homedir(), target.slice(1));
  target = resolve(target);
  let names: string[];
  try {
    names = await readdir(target);
    // Readable names without search permission would otherwise look like an empty directory.
    await access(target, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const statusCode = error.code === 'ENOENT' ? 404 : error.code === 'ENOTDIR' ? 400
        : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : undefined;
      if (statusCode !== undefined) Object.assign(error, { statusCode });
    }
    throw error;
  }
  const directory = target;
  const entries = (await Promise.all(names.filter(name => !name.startsWith('.')).map(async name => {
    try { return [{ name, isDir: (await stat(join(directory, name))).isDirectory() }]; }
    catch { return []; }
  }))).flat().sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return { path: target, parent: dirname(target) === target ? null : dirname(target), entries };
}
