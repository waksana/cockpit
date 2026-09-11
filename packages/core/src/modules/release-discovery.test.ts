import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ModuleCatalog } from './catalog.ts';
import { ModuleUpdates } from './updates.ts';
import { type ReleaseChannel } from './release-channel.ts';
import { officialReleaseChannel } from './official-channel.ts';

test('ordinary official module discovery uses the pinned public channel without a user credential', async t => {
  const root = fileURLToPath(new URL(`../../../../.module-public-${randomUUID().slice(0, 8)}`, import.meta.url));
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ModuleCatalog({ userRoot: root });
  const channel = officialReleaseChannel();
  assert.equal(channel.tokenFile, undefined);
  let calls = 0;
  const updates = new ModuleUpdates(catalog, async (input, init) => {
    calls++;
    assert.equal(String(input), channel.metadataUrl);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    return new Response(null, { status: 404 });
  });
  await assert.rejects(updates.check(), error => error instanceof Error
    && 'code' in error && error.code === 'RELEASE_HTTP_404');
  assert.equal(calls, 1);
  assert.deepEqual(catalog.readHostConfig().values, {}, 'A missing official release is not a confirmed channel or an anonymous retry');
  catalog.updateHostConfig({ releaseChannel: null }, 0);
  await assert.rejects(updates.check(), /channel is not configured/);
  assert.equal(calls, 1, 'An invalid explicit override never falls back to the official channel');
});

test('module strict config supports explicit stable GitHub discovery while signature and sequence/digest remain authoritative', async t => {
  const root = fileURLToPath(new URL(`../../../../.module-discovery-${randomUUID().slice(0, 8)}`, import.meta.url));
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const channel: ReleaseChannel = { metadataUrl: 'https://api.github.com/repos/fixture/modules/releases/tags/channel-stable',
    metadataAssetName: 'modules.signed.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    allowedDownloadOrigins: ['https://api.github.com'] };
  const catalog = new ModuleCatalog({ userRoot: root });
  catalog.updateHostConfig({ releaseChannel: { ...channel } }, 0);
  const issued = new Date(Date.now() - 60_000).toISOString();
  const signed = (sequence: number, key = privateKey, issuedAt = issued) => {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, channel: 'stable', sequence,
      issuedAt, expiresAt: new Date(Date.now() + 120_000).toISOString(), targets: [] }));
    return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
  };
  let assetId = 11, envelope = signed(1), calls = 0;
  const updates = new ModuleUpdates(catalog, async (input, init) => {
    calls++;
    if (String(input) === channel.metadataUrl) {
      assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github+json');
      return new Response(JSON.stringify({ id: 10, url: 'https://api.github.com/repos/fixture/modules/releases/10',
        tag_name: 'channel-stable', draft: false, prerelease: false,
        assets: [{ id: assetId, name: 'modules.signed.json', size: JSON.stringify(envelope).length, state: 'uploaded',
          url: `https://api.github.com/repos/fixture/modules/releases/assets/${assetId}` }] }));
    }
    assert.equal(String(input), `https://api.github.com/repos/fixture/modules/releases/assets/${assetId}`);
    assert.equal(new Headers(init?.headers).get('accept'), 'application/octet-stream');
    return new Response(JSON.stringify(envelope));
  });
  assert.equal((await updates.check()).sequence, 1);
  const first = catalog.readHostConfig().values.releaseMetadataDigest;
  assert.equal((await updates.check()).sequence, 1, 'same original signed envelope is still valid readback');
  assert.equal(catalog.readHostConfig().values.releaseMetadataDigest, first);
  assetId = 12; envelope = signed(2);
  assert.equal((await updates.check()).sequence, 2, 'fixed tag URL discovers the newly published asset ID');
  const accepted = catalog.readHostConfig();
  assetId = 13; envelope = signed(1);
  await assert.rejects(updates.check(), /sequence floor/);
  envelope = signed(2, privateKey, new Date(Date.now() - 120_000).toISOString());
  await assert.rejects(updates.check(), /reused a release sequence/);
  envelope = signed(3, generateKeyPairSync('ed25519').privateKey);
  await assert.rejects(updates.check(), /signature/);
  assert.deepEqual(catalog.readHostConfig(), accepted);
  const beforeInvalid = calls;
  for (const invalid of [{ metadataAssetName: 42 }, { metadataAssetname: 'misspelled' },
    { metadataUrl: 'https://api.github.com/repos/fixture/modules/releases/assets/1' }]) {
    catalog.updateHostConfig({ releaseChannel: { ...channel, ...invalid } }, catalog.readHostConfig().revision);
    await assert.rejects(updates.check(), /channel is not configured/);
  }
  assert.equal(calls, beforeInvalid, 'invalid module config fails before discovery or token use');
});
