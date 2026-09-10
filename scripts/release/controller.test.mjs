import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readState, writeState } from './model.mjs';

const controller = new URL('./controller.mjs', import.meta.url).pathname;
const candidate = (letter, rollbackSafe = false) => ({
  id: `${letter.repeat(40)}-1`, commit: letter.repeat(40), rollbackSafe,
  owners: [{ sessionId: '218afa58-c524-4f52-b73b-bab680231c44', commit: letter.repeat(40) }],
});
async function fixture(t, state) {
  const root = await mkdtemp(join(tmpdir(), 'release-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'releases'));
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({
    repository: 'fixture/repo', root, url: 'http://127.0.0.1:1', service: 'fixture.service',
  }));
  await writeState(join(root, 'state.json'), state);
  const call = (operation, data = {}) => JSON.parse(execFileSync('flock',
    ['-x', join(root, 'state.lock'), process.execPath, controller, 'locked', operation],
    { input: JSON.stringify(data), encoding: 'utf8',
      env: { ...process.env, COCKPIT_DEPLOY_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe'] }));
  return { call, state: () => readState(join(root, 'state.json')),
    set: value => writeState(join(root, 'state.json'), value) };
}

test('selection is distinct from health and rejects the wrong healthy identity', async t => {
  const a = candidate('a');
  const b = candidate('b');
  const f = await fixture(t, { active: a, desired: b, highWatermark: b.commit });
  assert.equal(f.call('choose').candidate.id, b.id);
  assert.equal((await f.state()).active, undefined);
  assert.equal((await f.state()).lastHealthy.id, a.id);
  assert.throws(() => f.call('healthy', a), /Unexpected active release identity/);
  f.call('healthy', b);
  assert.equal((await f.state()).active.id, b.id);
  assert.equal((await f.state()).phase, 'healthy');
});

test('unsafe failed startup is blocked, but a forward desired candidate can start', async t => {
  const a = candidate('a');
  const b = candidate('b');
  const c = candidate('c');
  const f = await fixture(t, { active: a, desired: b, highWatermark: b.commit });
  f.call('choose');
  f.call('failed', b);
  assert.equal(f.call('choose').blocked, true);
  await f.set({ ...await f.state(), desired: c, highWatermark: c.commit });
  assert.equal(f.call('choose').candidate.id, c.id);
});

test('safe rollback keeps failure attribution and high-watermark', async t => {
  const a = candidate('a');
  const b = candidate('b', true);
  const f = await fixture(t, { active: a, desired: b, failed: b, highWatermark: b.commit });
  const choice = f.call('choose');
  assert.equal(choice.candidate.id, a.id);
  assert.equal(choice.failed.id, b.id);
  assert.equal(choice.rollback, true);
  f.call('rolled-back', a);
  assert.equal((await f.state()).phase, 'rolled-back');
  assert.equal((await f.state()).highWatermark, b.commit);
  assert.equal((await f.state()).failed.id, b.id);
});

test('uncertain callbacks are not automatically replayed', async t => {
  const f = await fixture(t, { notified: [] });
  assert.equal(f.call('notify', { key: 'healthy:owner:commit' }).send, true);
  assert.equal(f.call('notify', { key: 'healthy:owner:commit' }).send, false);
  assert.equal(f.call('notify', { key: 'rolled-back:owner:other' }).send, true);
});
