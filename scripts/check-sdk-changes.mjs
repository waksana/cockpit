import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = 'packages/module-api/package.json';
const inputs = ['packages/module-api/src', manifestPath,
  'packages/module-api/runtime.js', 'packages/module-api/runtime.d.ts',
  'packages/module-api/tsconfig.build.json', 'tsconfig.base.json', 'LICENSE'];

function versionParts(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'SDK version must be MAJOR.MINOR.PATCH');
  const parts = version.split('.').map(Number);
  assert.ok(parts.every(Number.isSafeInteger), 'SDK version components must be safe integers');
  return parts;
}

export function checkSdkVersionChange(previous, current, changed, records) {
  const before = versionParts(previous);
  const after = versionParts(current);
  assert.ok(Array.isArray(records) && records.length > 0, 'SDK change records are required');
  assert.equal(new Set(records.map(record => record.version)).size, records.length, 'Duplicate SDK change version');
  for (const record of records) {
    versionParts(record.version);
    assert.ok(['initial', 'fix', 'additive', 'breaking'].includes(record.kind), 'Unknown SDK change kind');
    assert.ok(typeof record.summary === 'string' && record.summary.trim(), 'SDK change summary is required');
  }
  assert.equal(records[0].version, current, 'Latest SDK change record must match the package version');
  if (previous === current) {
    assert.equal(changed, false, 'Published SDK inputs changed without a version bump');
    return;
  }
  const firstChange = after.findIndex((part, index) => part !== before[index]);
  assert.ok(after[firstChange] > before[firstChange], 'SDK version must increase');
  const kind = records[0].kind;
  assert.notEqual(kind, 'initial', 'An existing SDK needs a fix, additive or breaking change record');
  if (kind === 'breaking') {
    assert.ok(after[0] > before[0] || (before[0] === 0 && after[1] > before[1]),
      'Breaking SDK changes require a major bump (or a minor bump during 0.x)');
  } else if (kind === 'additive') {
    assert.ok(after[0] > before[0] || after[1] > before[1], 'Additive SDK changes require at least a minor bump');
  }
}

function normalized(path, text) {
  if (path !== manifestPath) return text;
  const { version: _version, ...manifest } = JSON.parse(text);
  return JSON.stringify(manifest);
}

export function checkSdkChanges(base, root = repository) {
  assert.match(base, /^[a-f0-9]{40}$/, 'SDK comparison requires an exact base commit');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const previousFiles = git(['ls-tree', '-r', '--name-only', '-z', base, '--', ...inputs]).split('\0').filter(Boolean);
  assert.ok(previousFiles.includes(manifestPath), 'SDK comparison base does not contain the SDK manifest');
  const previous = new Map(previousFiles.map(path => [path, normalized(path, git(['show', `${base}:${path}`]))]));
  const current = new Map();
  const visit = path => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) for (const name of readdirSync(absolute)) visit(`${path}/${name}`);
    else {
      assert.ok(stat.isFile(), `SDK input is not a regular file: ${path}`);
      current.set(path, normalized(path, readFileSync(absolute, 'utf8')));
    }
  };
  for (const path of inputs) visit(path);
  const changed = previous.size !== current.size
    || [...previous].some(([path, text]) => current.get(path) !== text);
  const previousVersion = JSON.parse(git(['show', `${base}:${manifestPath}`])).version;
  const currentVersion = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')).version;
  const records = JSON.parse(readFileSync(join(root, 'packages/module-api/changes.json'), 'utf8'));
  checkSdkVersionChange(previousVersion, currentVersion, changed, records);
  return { base, previousVersion, currentVersion, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, ...extra] = process.argv.slice(2);
  assert.ok(base && extra.length === 0, 'Usage: check-sdk-changes.mjs <base-commit>');
  console.log(JSON.stringify(checkSdkChanges(base)));
}
