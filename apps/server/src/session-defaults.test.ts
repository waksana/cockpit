import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { HostSessionDefaults } from './session-defaults.ts';

test('host defaults use Astra when absent and survive new storage instances without Copilot writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = join(root, 'cockpit');
  const store = new HostSessionDefaults(host);
  assert.deepEqual(await store.read(), { modelId: 'gpt-6-astra' });
  await store.write({ modelId: 'second' });
  assert.deepEqual(await new HostSessionDefaults(host).read(), { modelId: 'second' });
  assert.deepEqual(JSON.parse(await readFile(join(host, 'config.json'), 'utf8')), { modelId: 'second' });
  await store.write({ modelId: 'gpt-6-astra' });
  assert.deepEqual(await new HostSessionDefaults(host).read(), { modelId: 'gpt-6-astra' });
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
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.write({ modelId: 'second' }));
  await assert.rejects(store.read());
});
