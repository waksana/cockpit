import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { HostSessionDefaults } from './session-defaults.ts';
import { acquireAbstractLease } from './module-lease.ts';
import { harness } from '../../../packages/core/test-support/engine-harness.ts';

test('host defaults use Astra when absent and survive new storage instances without Copilot writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = join(root, 'cockpit');
  const store = new HostSessionDefaults(host);
  assert.deepEqual(await store.read(), { modelId: 'gpt-6-astra' });
  await assert.rejects(readFile(join(host, 'config.json')), { code: 'ENOENT' });
  await store.write({ modelId: 'second' });
  assert.deepEqual(await new HostSessionDefaults(host).read(), { modelId: 'second' });
  assert.deepEqual(JSON.parse(await readFile(join(host, 'config.json'), 'utf8')), {
    schemaVersion: 1, revision: 1, values: { sessionDefaults: { modelId: 'second' } },
  });
  await store.write({ modelId: 'gpt-6-astra' });
  assert.deepEqual(await new HostSessionDefaults(host).read(), { modelId: 'gpt-6-astra' });
});

test('versioned host configuration retains unrelated values and increments its revision on save', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const original = {
    schemaVersion: 1, revision: 4,
    values: { releaseSequence: 23, releaseMetadataDigest: 'synthetic-digest', unrelated: { text: 'x'.repeat(5000), enabled: false } },
  };
  const bytes = JSON.stringify(original);
  await writeFile(path, bytes);
  const store = new HostSessionDefaults(root);
  assert.deepEqual(await store.read(), { modelId: 'gpt-6-astra' });
  assert.equal(await readFile(path, 'utf8'), bytes, 'reading never migrates or overwrites configuration');
  await store.write({ modelId: 'second' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    ...original, revision: 5, values: { ...original.values, sessionDefaults: { modelId: 'second' } },
  });
  await new HostSessionDefaults(root).write({ modelId: 'third' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    ...original, revision: 6, values: { ...original.values, sessionDefaults: { modelId: 'third' } },
  });
  assert.deepEqual(await store.read(), { modelId: 'third' });
});

test('the previously saved flat model is preserved until an explicit save upgrades its format', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const bytes = '{"modelId":"previously-selected"}';
  await writeFile(path, bytes);
  const store = new HostSessionDefaults(root);
  assert.deepEqual(await store.read(), { modelId: 'previously-selected' });
  assert.equal(await readFile(path, 'utf8'), bytes);
  await store.write({ modelId: 'second' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    schemaVersion: 1, revision: 1, values: { sessionDefaults: { modelId: 'second' } },
  });
});

for (const modelId of [undefined, 'second']) {
  test(`Engine settings and creation share versioned defaults: ${modelId ?? 'not set'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'config.json'), JSON.stringify({
      schemaVersion: 1, revision: 1,
      values: { releaseSequence: 23, ...(modelId ? { sessionDefaults: { modelId } } : {}) },
    }));
    const h = harness(t, { sessionDefaults: new HostSessionDefaults(root) });
    h.runtime.models.mock.mockImplementation(async () => [
      { modelId: 'gpt-6-astra', name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' },
    ]);
    const selected = modelId ?? 'gpt-6-astra';
    await t.test('new session', async () => {
      const id = await h.engine.newSession(h.cwd);
      assert.equal(h.runtime.createSession.mock.calls.at(-1)!.arguments[0].model, selected);
      assert.equal((await h.engine.getMeta(id))?.currentModelId, selected);
    });
    await t.test('default-model settings', async () => {
      assert.equal((await h.engine.getSessionDefaults()).modelId, selected);
    });
  });
}

test('invalid envelopes and defaults cannot be read or overwritten by a successful-looking save', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const store = new HostSessionDefaults(root);
  for (const value of [
    { schemaVersion: 2, revision: 1, values: {} },
    { schemaVersion: 1, revision: -1, values: {} },
    { schemaVersion: 1, revision: 1.5, values: {} },
    { schemaVersion: 1, revision: 1, values: [] },
    { schemaVersion: 1, revision: 1, values: {}, unexpected: true },
    ...[null, {}, { modelId: '' }, { modelId: 'second', mode: 'plan' }].map(sessionDefaults => ({
      schemaVersion: 1, revision: 1, values: { sessionDefaults },
    })),
    { modelId: 'second', unexpected: true },
  ]) {
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    await assert.rejects(store.read(), bytes);
    await assert.rejects(store.write({ modelId: 'second' }), bytes);
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('host configuration writers fail explicitly under the shared storage lease without losing values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HostSessionDefaults(root);
  await store.write({ modelId: 'first' });
  const release = await acquireAbstractLease(root, 'writer', 'Fixture writer is busy');
  try {
    await assert.rejects(new HostSessionDefaults(root).write({ modelId: 'second' }), /being changed/);
    assert.deepEqual(await store.read(), { modelId: 'first' });
  } finally { await release(); }
  await store.write({ modelId: 'second' });
  assert.deepEqual(await store.read(), { modelId: 'second' });
});

test('revision exhaustion and oversized writes leave the readable prior configuration intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const store = new HostSessionDefaults(root);
  for (const config of [
    { schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER, values: { sessionDefaults: { modelId: 'first' } } },
    { schemaVersion: 1, revision: 1, values: { padding: 'x'.repeat(1024 * 1024 - 100) } },
  ]) {
    const bytes = JSON.stringify(config);
    await writeFile(path, bytes);
    await store.read();
    await assert.rejects(store.write({ modelId: 'second' }));
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('malformed files and persistence failure are explicit, not a reset to Astra', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HostSessionDefaults(root);
  const path = join(root, 'config.json');
  await writeFile(path, '{"modelId":""}');
  await assert.rejects(store.read());
  await writeFile(path, '{');
  await assert.rejects(store.read(), SyntaxError);
  await assert.rejects(store.write({ modelId: 'second' }), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), '{');
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.write({ modelId: 'second' }));
  await assert.rejects(store.read());
});
