import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentTargets } from './markdown.mjs';

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

const isMarkdown = path => /\.md$/i.test(path);
const external = target => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');

export function checkDocs(root, files = trackedFiles(root)) {
  root = realpathSync(root);
  const problems = [];
  const inventory = new Set(files);
  const documents = new Map();
  const fileChecks = new Map();
  const regularFile = file => {
    if (fileChecks.has(file)) return fileChecks.get(file);
    let path = root;
    const parts = file.split('/');
    for (let index = 0; index < parts.length; index++) {
      path = resolve(path, parts[index]);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
        problems.push(`${file}: expected a tracked regular file with no symlink components`);
        fileChecks.set(file, false);
        return false;
      }
    }
    fileChecks.set(file, true);
    return true;
  };
  const document = file => {
    if (!regularFile(file)) return null;
    if (!documents.has(file)) documents.set(file, documentTargets(readFileSync(resolve(root, file), 'utf8')));
    return documents.get(file);
  };
  for (const file of files.filter(isMarkdown)) {
    const source = document(file);
    if (!source) continue;
    for (const { target, line } of source.links) {
      if (external(target)) continue;
      const where = `${file}:${line}`;
      const hash = target.indexOf('#');
      let pathPart, anchor;
      try {
        pathPart = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split('?')[0]);
        anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        problems.push(`${where}: invalid URL encoding in ${target}`);
        continue;
      }
      const absolute = pathPart
        ? (pathPart.startsWith('/') ? resolve(root, `.${pathPart}`) : resolve(root, dirname(file), pathPart))
        : resolve(root, file);
      let destination = relative(root, absolute).split(sep).join('/');
      if (isAbsolute(destination) || destination === '..' || destination.startsWith('../')) {
        problems.push(`${where}: link leaves the repository: ${target}`);
        continue;
      }
      if (!inventory.has(destination)) {
        const prefix = destination ? `${destination}/` : '';
        if (!files.some(path => path.startsWith(prefix))) {
          problems.push(`${where}: missing tracked target ${destination || target}`);
          continue;
        }
        // GitHub renders a directory's README; check fragments against that page.
        const readme = files.find(path => path.startsWith(prefix) && /^readme\.md$/i.test(path.slice(prefix.length)));
        if (readme) destination = readme;
        else if (anchor) {
          problems.push(`${where}: no Markdown README for #${anchor} in ${destination || '.'}`);
          continue;
        }
      }
      if (inventory.has(destination) && !regularFile(destination)) continue;
      if (anchor && isMarkdown(destination) && !document(destination).anchors.has(anchor)) {
        problems.push(`${where}: missing anchor #${anchor} in ${destination}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const problems = checkDocs(root);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
  else console.log('Tracked Markdown relative links and anchors are valid.');
}
