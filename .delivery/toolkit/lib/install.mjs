import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'skills/service-development');
const files = ['SKILL.md', 'references/commands.md', 'references/delivery-contract.md', 'references/git-workflow.md'];

function installedFiles(directory, prefix = '') {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    const relative = prefix + name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing installed symlink: ${relative}`);
    if (stat.isDirectory()) return installedFiles(path, `${relative}/`);
    if (!stat.isFile()) throw new Error(`Refusing non-file entry: ${relative}`);
    return [relative];
  }).sort();
}

export function installSkill(skillsDirectory) {
  const destination = join(resolve(skillsDirectory), 'service-development');
  const content = new Map(files.map(name => [name, readFileSync(join(source, name))]));
  content.set('.toolkit-source.json', Buffer.from(`${JSON.stringify({
    sourceRoot: root,
    files: Object.fromEntries([...content].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  }, null, 2)}\n`));
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error('Refusing an existing non-directory/symlink skill destination');
    }
    if (JSON.stringify(installedFiles(destination)) !== JSON.stringify([...content.keys()].sort()) ||
      [...content].some(([name, bytes]) => !readFileSync(join(destination, name)).equals(bytes))) {
      throw new Error('Existing service-development differs. Inspect/back it up outside skill roots, remove only this skill explicitly, then reinstall. Nothing overwritten.');
    }
    return { installed: true, changed: false, path: destination, sourceRoot: root };
  }
  mkdirSync(resolve(skillsDirectory), { recursive: true });
  // Exclusive creation refuses a concurrent installer; no existing skill is overwritten.
  mkdirSync(destination);
  mkdirSync(join(destination, 'references'));
  for (const [name, bytes] of content) writeFileSync(join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
  return { installed: true, changed: true, path: destination, sourceRoot: root };
}
