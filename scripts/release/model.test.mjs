import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inventory, inside, readState, selectCandidate, validateBuild, writeState } from './model.mjs';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
const candidate = commit => ({ id: `${commit}-1`, commit });
const ancestor = async (before, after) => [a, b, c].indexOf(before) <= [a, b, c].indexOf(after);

test('A/B build order cannot move desired backwards; active may lag main', async () => {
  let state = await selectCandidate({ active: candidate(a) }, candidate(b), ancestor);
  assert.equal(state.active.commit, a);
  assert.equal(state.desired.commit, b);
  assert.deepEqual(await selectCandidate(state, candidate(a), ancestor), state);
  state = await selectCandidate(state, candidate(c), ancestor);
  assert.equal(state.desired.commit, c);
  assert.equal(state.phase, 'pending-idle');
  assert.deepEqual(await selectCandidate(state, candidate(c), ancestor), state);
});

test('same commit rebuilt with different bytes is not an implicit replacement', async () => {
  const state = await selectCandidate({}, candidate(a), ancestor);
  await assert.rejects(selectCandidate(state, { commit: a, id: `${a}-2` }, ancestor), /conflicting/);
});

test('rollback retains the high-watermark', async () => {
  const state = { active: candidate(a), highWatermark: c };
  await assert.rejects(selectCandidate(state, candidate(b), ancestor), /Superseded/);
});

test('resending a failed candidate cannot trigger a rollback/restart loop', async () => {
  const bRelease = candidate(b);
  await assert.rejects(selectCandidate({ desired: bRelease, failed: bRelease }, bRelease, ancestor), /already failed/);
});

test('unrelated history cannot replace a production candidate', async () => {
  await assert.rejects(selectCandidate({ highWatermark: a }, candidate(b), async () => false), /Superseded/);
});

test('artifact must come from the exact successful main workflow run', () => {
  const run = { id: 12, repository: { full_name: 'owner/repo' }, event: 'push', head_branch: 'main',
    path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_sha: a, run_attempt: 1 };
  const artifact = { id: 23, name: `release-${a}`, expired: false, digest: `sha256:${'1'.repeat(64)}`,
    workflow_run: { id: 12, head_sha: a } };
  const config = { repository: 'owner/repo' };
  assert.equal(validateBuild(run, artifact, config).artifactId, 23);
  for (const change of [{ event: 'pull_request' }, { head_branch: 'work/feature' },
    { conclusion: 'failure' }, { status: 'in_progress' }, { path: 'other.yml' }]) {
    assert.throws(() => validateBuild({ ...run, ...change }, artifact, config), /trusted/);
  }
  for (const change of [{ expired: true }, { digest: null },
    { workflow_run: { id: 99, head_sha: a } }, { name: 'latest' }]) {
    assert.throws(() => validateBuild(run, { ...artifact, ...change }, config), /trusted/);
  }
});

test('inventory permits internal pnpm links and rejects shared-worktree links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'lib', 'index.js'), 'export const version=1;\n');
  await symlink('lib', join(root, 'package'));
  assert.equal((await inventory(root)).package.link, 'lib');
  await symlink('../shared-worktree', join(root, 'outside'));
  await assert.rejects(inventory(root), /escapes/);
  assert.equal(inside(root, `${root}-other/file`), false);
});

test('state is persisted atomically; malformed state is not silently reset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  assert.equal((await readState(path)).phase, 'uninitialized');
  await writeState(path, { desired: candidate(a) });
  assert.equal((await readState(path)).desired.commit, a);
  await writeFile(path, '{');
  await assert.rejects(readState(path), SyntaxError);
});

test('extractor refuses path traversal before writing outside release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release-extract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zip = join(root, 'artifact.zip');
  const stage = join(root, 'stage');
  await mkdir(stage);
  execFileSync('python3', ['-c', [
    'import io,tarfile,zipfile,sys',
    'payload=io.BytesIO()',
    'with tarfile.open(fileobj=payload,mode="w:gz") as t:',
    ' i=tarfile.TarInfo("../escaped"); i.size=1; t.addfile(i,io.BytesIO(b"x"))',
    'with zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr("release.tar.gz",payload.getvalue())',
  ].join('\n'), zip]);
  assert.throws(() => execFileSync('python3', [new URL('./extract.py', import.meta.url).pathname, zip, stage],
    { stdio: 'pipe' }), /Invalid or duplicate release path/);
  await assert.rejects(readFile(join(root, 'escaped')), { code: 'ENOENT' });
});
