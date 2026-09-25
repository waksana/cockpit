import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkSdkChanges, checkSdkVersionChange } from './check-sdk-changes.mjs';

const record = (version, kind = 'fix') => [{ version, kind, summary: 'A deliberate SDK change.' }];

test('SDK versions guard changed contracts and explicit compatibility decisions', () => {
  checkSdkVersionChange('0.2.0', '0.2.0', false, record('0.2.0'));
  assert.throws(() => checkSdkVersionChange('0.2.0', '0.2.0', true, record('0.2.0')), /without a version bump/);
  checkSdkVersionChange('0.2.0', '0.2.1', true, record('0.2.1'));
  checkSdkVersionChange('0.2.0', '0.3.0', true, record('0.3.0', 'breaking'));
  checkSdkVersionChange('1.2.0', '2.0.0', true, record('2.0.0', 'breaking'));
  assert.throws(() => checkSdkVersionChange('0.2.0', '0.2.1', true, record('0.2.1', 'breaking')), /minor bump/);
  assert.throws(() => checkSdkVersionChange('1.2.0', '1.3.0', true, record('1.3.0', 'breaking')), /major bump/);
  assert.throws(() => checkSdkVersionChange('0.2.0', '0.2.1', true, record('0.2.1', 'additive')), /minor bump/);
  assert.throws(() => checkSdkVersionChange('0.2.0', '0.1.9', true, record('0.1.9')), /must increase/);
  assert.throws(() => checkSdkVersionChange('0.2.0', '0.2.1', true, []), /records are required/);
  assert.throws(() => checkSdkVersionChange('0.2.0', '0.2.1', true, record('0.2.0')), /must match/);
});

test('Git comparison ignores host-only changes but catches SDK exports and runtime behavior', t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-sdk-changes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'SDK fixture']);
  git(['config', 'user.email', 'sdk@example.invalid']);
  mkdirSync(join(root, 'packages/module-api/src'), { recursive: true });
  const manifest = { name: '@waksana/cockpit-module-sdk', version: '0.2.0', exports: { '.': './dist/index.js' } };
  const save = () => writeFileSync(join(root, 'packages/module-api/package.json'), JSON.stringify(manifest));
  save();
  writeFileSync(join(root, 'packages/module-api/src/index.ts'), 'export const value = 1;');
  writeFileSync(join(root, 'packages/module-api/runtime.js'), 'export const limit = 1;');
  writeFileSync(join(root, 'packages/module-api/changes.json'), JSON.stringify(record('0.2.0')));
  git(['add', '.']);
  git(['commit', '-qm', 'Fixture baseline']);
  const base = git(['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'package.json'), '{"version":"9.9.9"}');
  assert.equal(checkSdkChanges(base, root).changed, false);
  writeFileSync(join(root, 'packages/module-api/runtime.js'), 'export const limit = 2;');
  assert.throws(() => checkSdkChanges(base, root), /without a version bump/);
  writeFileSync(join(root, 'packages/module-api/runtime.js'), 'export const limit = 1;');
  manifest.exports['./new'] = './dist/new.js';
  save();
  assert.throws(() => checkSdkChanges(base, root), /without a version bump/);
  manifest.version = '0.3.0';
  save();
  writeFileSync(join(root, 'packages/module-api/changes.json'), JSON.stringify(record('0.3.0', 'additive')));
  assert.equal(checkSdkChanges(base, root).changed, true);
});
