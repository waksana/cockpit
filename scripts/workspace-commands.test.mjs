import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('project pnpm configuration rejects empty filters but executes a matched package', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const run = name => spawnSync('pnpm', ['--filter', name, 'exec', process.execPath,
    '-e', 'process.stdout.write("selected-package-executed")'], { cwd, encoding: 'utf8', timeout: 30_000 });
  const missing = run('@cockpit/nonexistent-docs-check-package');
  assert.ifError(missing.error);
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.doesNotMatch(missing.stdout, /selected-package-executed/);
  const matched = run('@cockpit/protocol');
  assert.ifError(matched.error);
  assert.equal(matched.status, 0, matched.stdout + matched.stderr);
  assert.match(matched.stdout, /selected-package-executed/);
});
