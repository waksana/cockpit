import { constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export function privateModuleDirectory(path: string): void {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!lstatSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor) {
    throw new Error('Module directory must not traverse a symbolic link');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077)
    || stat.uid !== process.getuid?.() || realpathSync(path) !== resolve(path)) {
    throw new Error('Module data directory must be private and canonical');
  }
}
export function writeModuleRecord(path: string, value: object): void {
  privateModuleDirectory(dirname(path));
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || stat.uid !== process.getuid?.()) throw new Error('Module record must be an owner-only regular file');
  }
  const temp = join(dirname(path), `.reference-${randomUUID()}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
