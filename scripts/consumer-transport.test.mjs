import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { downloadVerifiedArchive, readReleaseEnvelope, validateReleaseChannel } from '../packages/core/src/consumer/release-transport.mjs';

test('GitHub asset transport requests binary bytes and permits only configured metadata/archive redirects without forwarding bearer', async t => {
  const root = fileURLToPath(new URL(`../.consumer-transport-${randomUUID().slice(0, 8)}`, import.meta.url));
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, 'fixture-read-token');
  await writeFile(tokenFile, 'fixture-only-private-read-token', { mode: 0o600 });
  const channel = { metadataUrl: 'https://api.github.com/repos/fixture/project/releases/assets/1',
    allowedDownloadOrigins: ['https://api.github.com', 'https://release-assets.githubusercontent.com'], tokenFile };
  const envelope = { payload: 'fixture-envelope-transport-only', signature: 'not-a-real-publisher-signature' };
  const archive = Buffer.from('fixture archive bytes');
  const seen = [];
  const transport = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers);
    seen.push({ origin: url.origin, accept: headers.get('accept'), authorization: headers.get('authorization') });
    if (url.origin === 'https://api.github.com') {
      return new Response(null, { status: 302,
        headers: { location: `https://release-assets.githubusercontent.com/fixture/${url.pathname.split('/').at(-1)}` } });
    }
    return new Response(url.pathname.endsWith('/1') ? JSON.stringify(envelope) : archive);
  };
  assert.deepEqual(await readReleaseEnvelope(channel, transport), envelope);
  await downloadVerifiedArchive({ url: 'https://api.github.com/repos/fixture/project/releases/assets/2',
    bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }, channel, join(root, 'archive.zip'), transport);
  assert.deepEqual(await readFile(join(root, 'archive.zip')), archive);
  assert.equal(seen.length, 4);
  assert.ok(seen.every(request => request.accept === 'application/octet-stream'));
  assert.ok(seen.filter(request => request.origin === 'https://api.github.com')
    .every(request => request.authorization === 'Bearer fixture-only-private-read-token'));
  assert.ok(seen.filter(request => request.origin === 'https://release-assets.githubusercontent.com')
    .every(request => request.authorization === null));

  let requests = 0;
  await assert.rejects(readReleaseEnvelope(channel, async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://unconfigured.invalid/metadata' } });
  }), /not explicitly trusted/);
  assert.equal(requests, 1, 'unknown redirect is rejected before any request to its host');
  await assert.rejects(readReleaseEnvelope({ ...channel, allowedDownloadOrigins: ['https://api.github.com'] }, transport),
    /not explicitly trusted/, 'metadata assets CDN must be explicitly configured too');
});

const discoveryChannel = {
  metadataUrl: 'https://api.github.com/repos/fixture/project/releases/latest',
  metadataAssetName: 'stable.signed.json', publicKey: 'transport-only-fixture',
  allowedDownloadOrigins: ['https://api.github.com', 'https://release-assets.githubusercontent.com'],
};
function releaseListing() {
  return { id: 10, url: 'https://api.github.com/repos/fixture/project/releases/10',
    tag_name: 'channel-stable', draft: false, prerelease: false,
    assets: [{ id: 11, name: 'stable.signed.json', state: 'uploaded', size: 100,
      url: 'https://api.github.com/repos/fixture/project/releases/assets/11',
      browser_download_url: 'https://untrusted.invalid/ignored-field' }] };
}

test('explicit GitHub discovery configuration is strict and tag reads use separate JSON and raw Accept headers', async () => {
  for (const options of [
    { metadataAssetName: '' }, { metadataAssetName: null }, { metadataAssetName: '../stable.json' },
    { metadataAssetName: 'other/file.json' }, { metadataAssetName: 'a b.json' },
    { metadataUrl: 'https://github.com/fixture/project/releases/latest' },
    { metadataUrl: 'https://api.github.com/repos/fixture/project/releases/assets/11' },
    { metadataUrl: 'https://api.github.com/repos/fixture/project/releases/latest?x=1' },
    { metadataUrl: 'https://api.github.com/repos/fixture/project/releases/latest#fragment' },
    { metadataAssetname: 'misspelled-setting' },
  ]) assert.throws(() => validateReleaseChannel({ ...discoveryChannel, ...options }));
  assert.doesNotThrow(() => validateReleaseChannel({ ...discoveryChannel, metadataAssetName: undefined,
    metadataUrl: 'https://ordinary.example/stable.json' }));
  const channel = { ...discoveryChannel, metadataUrl: 'https://api.github.com/repos/fixture/project/releases/tags/channel-stable' };
  const seen = [];
  const expected = { payload: 'transport-only', signature: 'no-real-signature' };
  const envelope = await readReleaseEnvelope(channel, async (input, init) => {
    seen.push({ url: String(input), accept: new Headers(init.headers).get('accept') });
    return new Response(JSON.stringify(seen.length === 1 ? releaseListing() : expected));
  });
  assert.deepEqual(envelope, expected);
  assert.deepEqual(seen, [
    { url: channel.metadataUrl, accept: 'application/vnd.github+json' },
    { url: releaseListing().assets[0].url, accept: 'application/octet-stream' },
  ]);
});

test('malformed, duplicate, foreign and mismatched GitHub discovery assets fail before any binary request', async () => {
  const cases = [
    value => { value.assets = []; },
    value => { value.assets = {}; },
    value => { value.assets[0].name = 'Stable.signed.json'; },
    value => { value.assets.push({ ...value.assets[0], id: 12, url: value.assets[0].url.replace('/11', '/12') }); },
    value => { value.assets.push({ ...value.assets[0], name: 'another.json' }); },
    value => { value.assets[0].id = 99; },
    value => { value.assets[0].url = 'https://untrusted.invalid/repos/fixture/project/releases/assets/11'; },
    value => { value.assets[0].url = 'https://api.github.com/repos/other/project/releases/assets/11'; },
    value => { value.assets[0].url = 'https://api.github.com/repos/fixture/project/releases/assets/11?raw=1'; },
    value => { value.assets[0].url = 'https://api.github.com/repos/fixture/project/releases/assets/not-an-id'; },
    value => { value.assets[0].state = 'starter'; },
    value => { value.assets[0].size = 400_001; },
    value => { value.assets[0].size = -1; },
    value => { value.id = 99; },
    value => { value.url = 'https://api.github.com/repos/other/project/releases/10'; },
    value => { value.draft = true; },
    value => { value.prerelease = true; },
    value => { value.assets = new Array(1001).fill(value.assets[0]); },
  ];
  for (const modify of cases) {
    const release = releaseListing();
    modify(release);
    let requests = 0;
    await assert.rejects(readReleaseEnvelope(discoveryChannel, async () => {
      requests++;
      return new Response(JSON.stringify(release));
    }));
    assert.equal(requests, 1, 'invalid discovery must not select or fetch an asset');
  }
  await assert.rejects(readReleaseEnvelope({ ...discoveryChannel,
    metadataUrl: 'https://api.github.com/repos/fixture/project/releases/tags/another-tag' },
  async () => new Response(JSON.stringify(releaseListing()))), /mismatched/);
  await assert.rejects(readReleaseEnvelope(discoveryChannel, async () => new Response(' '.repeat(1_000_001))), /bounded/);
  await assert.rejects(readReleaseEnvelope(discoveryChannel, async () => new Response(null, { status: 302,
    headers: { location: 'https://api.github.com/repos/another/project/releases/latest' } })), /discovery redirects/);
  let requests = 0;
  await assert.rejects(readReleaseEnvelope(discoveryChannel, async () => {
    requests++;
    return requests === 1 ? new Response(JSON.stringify(releaseListing()))
      : new Response(null, { status: 302, headers: { location: 'https://api.github.com/repos/other/project/releases/assets/11' } });
  }), /same repository/);
  assert.equal(requests, 2, 'a same-origin redirect cannot escape the selected repository identity');
});
