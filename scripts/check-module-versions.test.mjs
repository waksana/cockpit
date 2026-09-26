import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogEntries, checkModuleVersions } from './check-module-versions.mjs';

const header = '| Module | Latest release | Paired host release | Status |\n| --- | --- | --- | --- |';
const row = (repo, tag = 'v1.0.0') =>
  `| [Module](https://github.com/${repo}) | [${tag}](https://github.com/${repo}/releases/tag/${tag}) | [Old host](https://github.com/host/app/releases/tag/v0.1.0) | Accepted earlier. |`;
const latest = tag_name => ({ tag_name, draft: false, prerelease: false });

test('queries only the catalog module column, not host pairings or historical prose', async () => {
  const source = [
    header, row('owner/one'), row('owner/two', 'v0.2.0'),
    '', 'Old release [v99.0.0](https://github.com/owner/two/releases/tag/v99.0.0).',
  ].join('\n');
  const calls = [];
  const results = await checkModuleVersions(source, repository => {
    calls.push(repository);
    return latest(repository === 'owner/one' ? 'v1.0.0' : 'v0.3.0');
  });
  assert.deepEqual(calls, ['owner/one', 'owner/two']);
  assert.deepEqual(results, [
    { repository: 'owner/one', documented: 'v1.0.0', latest: 'v1.0.0', current: true },
    { repository: 'owner/two', documented: 'v0.2.0', latest: 'v0.3.0', current: false },
  ]);
});

test('missing, empty, ambiguous or misleading catalogs fail rather than pass vacuously', () => {
  assert.throws(() => catalogEntries('# No table'), /exactly one/);
  assert.throws(() => catalogEntries(header), /no entries/);
  assert.throws(() => catalogEntries(`${header}\n${row('owner/one')}\n${row('owner/one')}`), /Duplicate/);
  assert.throws(() => catalogEntries(`${header}\n${row('owner/one')}\n\n${header}\n${row('owner/two')}`), /exactly one/);
  assert.throws(() => catalogEntries(`${header}\n${row('owner/one').replace('owner/one/releases', 'owner/two/releases')}`), /does not belong/);
  assert.throws(() => catalogEntries(`${header}\n${row('owner/one').replace('[v1.0.0]', '[v2.0.0]')}`), /label\/tag mismatch/);
});

test('API failures and invalid responses are explicit failures, never current-shaped defaults', async () => {
  const source = `${header}\n${row('owner/one')}`;
  await assert.rejects(checkModuleVersions(source, () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  for (const response of [null, {}, latest(''), { ...latest('v1.0.0'), draft: true },
    { ...latest('v1.0.0'), prerelease: true }]) {
    await assert.rejects(checkModuleVersions(source, () => response), /Invalid Latest/);
  }
});

test('the tracked catalog is structurally valid without querying the network', () => {
  const entries = catalogEntries(readFileSync(new URL('../docs/modules.md', import.meta.url), 'utf8'));
  assert.ok(entries.some(entry => entry.repository === 'waksana/cockpit-task'));
  assert.ok(entries.every(entry => entry.tag));
});
