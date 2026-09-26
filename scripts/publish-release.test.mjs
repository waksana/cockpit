import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findRelease, githubClient, publishRelease } from './publish-release.mjs';

const sha = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'repos/example/cockpit/releases';

function fixture(t, mode = 'recover') {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-publish-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['', 'apps/server', 'apps/mcp', 'apps/web', 'packages/core', 'packages/protocol']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'package.json'), '{"version":"0.1.0"}');
  }
  mkdirSync(join(root, 'apps/mcp/src'));
  writeFileSync(join(root, 'apps/mcp/src/index.ts'),
    "new McpServer({ name: 'cockpit-mcp-server', version: MCP_SERVER_VERSION })");
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/release-notes.md'), '# Cockpit 0.1.0\n');
  const manifest = { format: 1, product: 'cockpit', version: '0.1.0', sourceSha: sha,
    node: process.versions.node, platform: 'linux', arch: 'x64' };
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify(manifest));
  execFileSync('tar', ['-czf', join(root, 'runtime.tar.gz'), '-C', root, './runtime-manifest.json']);
  const archiveSha256 = hash(readFileSync(join(root, 'runtime.tar.gz')));
  writeFileSync(join(root, 'runtime.tar.gz.sha256'), `${archiveSha256}  runtime.tar.gz\n`);
  const checksumSha256 = hash(readFileSync(join(root, 'runtime.tar.gz.sha256')));
  const release = { id: 42, tag_name: 'v0.1.0', draft: true, prerelease: false, published_at: null,
    target_commitish: 'main' };
  const originalAssets = ['runtime.tar.gz', 'runtime.tar.gz.sha256'].map((name, index) => {
    const bytes = readFileSync(join(root, name));
    return { id: index + 101, name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}` };
  });
  const state = { releases: mode === 'create' ? [] : [release],
    assets: mode === 'create' ? [] : structuredClone(originalAssets), calls: [], verifications: 0 };
  const client = {
    async request(path, options = {}) {
      const method = options.method || 'GET';
      state.calls.push({ path, method, ...options });
      if (state.fail?.(path, method)) throw new Error('Synthetic transport failure');
      if (method === 'GET' && path === `${base}?per_page=100&page=1`) return structuredClone(state.releases);
      if (path === `${base}/generate-notes`) return { body: 'Generated notes' };
      if (method === 'POST' && path === base) {
        state.releases.push(release);
        return structuredClone(release);
      }
      if (options.upload) {
        const name = new URL(`https://example.test/${path}`).searchParams.get('name');
        state.assets.push(originalAssets.find(asset => asset.name === name));
        return structuredClone(state.assets.at(-1));
      }
      if (method === 'PATCH') {
        release.draft = false;
        release.published_at = '2026-09-26T00:00:00Z';
        if (state.publishThenFail) throw new Error('Lost publication response');
        return structuredClone(release);
      }
      if (path === `${base}/42` || path === `${base}/latest`) return structuredClone(release);
      if (path === `${base}/42/assets?per_page=100&page=1`) return structuredClone(state.assets);
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    async download(path, destination) {
      state.calls.push({ path, method: 'DOWNLOAD' });
      const asset = originalAssets.find(asset => path === `${base}/assets/${asset.id}`);
      assert.ok(asset, `Unexpected download ${path}`);
      copyFileSync(join(root, asset.name), destination);
    },
  };
  const options = { repository: 'example/cockpit', tag: 'v0.1.0', sourceSha: sha,
    sourceDirectory: root, artifactDirectory: root, mode, releaseId: 42, archiveSha256, checksumSha256 };
  const verify = () => {
    state.verifications++;
    state.onVerify?.();
  };
  return { root, options, state, release, client, run: () => publishRelease(options, client, verify) };
}

const writes = f => f.state.calls.filter(call => call.method === 'PATCH' || call.method === 'POST');

test('discovery exhausts pages and filters exact tags without using the tag endpoint', async () => {
  const calls = [];
  const draft = { id: 999, tag_name: 'v0.1.0', draft: true };
  const client = { async request(path) {
    calls.push(path);
    return path.endsWith('page=1')
      ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: 'v0.1.01' }))
      : [draft];
  } };
  assert.deepEqual(await findRelease(client, 'example/cockpit', 'v0.1.0'), draft);
  assert.deepEqual(calls, [
    `${base}?per_page=100&page=1`, `${base}?per_page=100&page=2`,
    `${base}?per_page=100&page=1`, `${base}?per_page=100&page=2`,
  ]);
});

test('a deletion shifting an unseen draft across a page boundary cannot prove absence or uniqueness', async () => {
  for (const alreadyMatched of [false, true]) {
    let entries = Array.from({ length: 100 }, (_, i) =>
      ({ id: i + 1, tag_name: alreadyMatched && i === 1 ? 'v0.1.0' : 'v0.1.01' }));
    entries.push({ id: 101, tag_name: 'v0.1.0', draft: true });
    let calls = 0;
    const client = { async request(path) {
      const page = Number(new URL(`https://example.test/${path}`).searchParams.get('page'));
      const batch = entries.slice((page - 1) * 100, page * 100);
      if (++calls === 1) entries = entries.slice(1);
      return batch;
    } };
    await assert.rejects(findRelease(client, 'example/cockpit', 'v0.1.0'), /changed between scans/);
  }
});

test('absence is proven only by a successful listing; malformed and failed reads propagate', async () => {
  assert.equal(await findRelease({ request: async () => [] }, 'example/cockpit', 'v0.1.0'), null);
  for (const response of [null, {}, [{ id: '42', tag_name: 'v0.1.0' }]]) {
    await assert.rejects(findRelease({ request: async () => response }, 'example/cockpit', 'v0.1.0'));
  }
  await assert.rejects(findRelease({ request: async () => { throw new Error('HTTP 404'); } },
    'example/cockpit', 'v0.1.0'), /HTTP 404/);
});

test('complete legacy draft recovers original bytes by ID without creating or uploading', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.id, 42);
  assert.equal(result.archiveSha256, f.options.archiveSha256);
  assert.equal(f.state.verifications, 2);
  assert.deepEqual(writes(f).map(({ path, method, body }) => ({ path, method, body })), [
    { path: `${base}/42`, method: 'PATCH', body: { draft: false, prerelease: false, make_latest: 'true' } },
  ]);
  assert.equal(f.state.calls.filter(call => call.method === 'DOWNLOAD').length, 2);
  assert.equal(f.state.calls.at(-1).path, `${base}/latest`);
});

test('new publication creates a draft, uploads once, verifies downloads, then publishes by ID', async t => {
  const f = fixture(t, 'create');
  await f.run();
  assert.equal(writes(f).filter(call => call.path === base).length, 1);
  const create = writes(f).find(call => call.path === base);
  assert.equal(create.body.draft, true);
  assert.equal(create.body.target_commitish, sha);
  assert.equal(writes(f).filter(call => call.upload).length, 2);
  const publishIndex = f.state.calls.findIndex(call => call.method === 'PATCH');
  assert.ok(f.state.calls.slice(0, publishIndex).filter(call => call.method === 'DOWNLOAD').length === 2);
});

test('existing drafts cannot be implicitly reused by a new tag run', async t => {
  const f = fixture(t);
  f.options.mode = 'create';
  await assert.rejects(f.run(), /already exists/);
  assert.deepEqual(writes(f), []);
});

test('recovery refuses absent, duplicate, wrong-ID, published and prerelease identities', async t => {
  for (const change of [
    f => { f.state.releases = []; },
    f => { f.state.releases.push({ ...f.release, id: 43 }); },
    f => { f.state.releases.push({ ...f.release }); },
    f => { f.options.releaseId = 43; },
    f => { f.release.draft = false; },
    f => { f.release.prerelease = true; },
    f => { f.release.published_at = '2026-09-26T00:00:00Z'; },
    f => { f.options.archiveSha256 = ''; },
  ]) {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.run());
    assert.deepEqual(writes(f), []);
  }
});

test('incomplete, duplicate, additional, empty and unfinished assets never publish or upload', async t => {
  for (const change of [
    f => { f.state.assets.pop(); },
    f => { f.state.assets.push({ ...f.state.assets[0], id: 103 }); },
    f => { f.state.assets.push({ ...f.state.assets[0], id: 103, name: 'extra.txt' }); },
    f => { f.state.assets[0].size = 0; },
    f => { f.state.assets[0].state = 'starter'; },
  ]) {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.run());
    assert.deepEqual(writes(f), []);
  }
});

test('download digests, sizes, checksum content, version and source identity are mandatory', async t => {
  for (const change of [
    f => { f.options.archiveSha256 = 'b'.repeat(64); },
    f => { f.options.checksumSha256 = 'b'.repeat(64); },
    f => { f.state.assets[0].size++; },
    f => { delete f.state.assets[0].digest; writeFileSync(join(f.root, 'runtime.tar.gz'), 'bad bytes'); },
    f => { writeFileSync(join(f.root, 'package.json'), '{"version":"0.1.1"}'); },
    f => { f.options.sourceSha = 'b'.repeat(40); },
    f => { f.options.tag = 'v0.1.1'; f.release.tag_name = 'v0.1.1'; },
    f => { writeFileSync(join(f.root, 'docs/release-notes.md'), '# Cockpit 0.1.1\n'); },
    f => {
      const path = join(f.root, 'runtime.tar.gz.sha256');
      writeFileSync(path, `${'b'.repeat(64)}  runtime.tar.gz\n`);
      f.options.checksumSha256 = hash(readFileSync(path));
      f.state.assets[1].digest = `sha256:${f.options.checksumSha256}`;
    },
  ]) {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.run());
    assert.deepEqual(writes(f), []);
  }
});

test('changed tag, release or asset identity at the final guard prevents publication', async t => {
  for (const change of [
    () => { throw new Error('Tag moved'); },
    f => { f.state.assets[0].id = 999; },
    f => { f.release.draft = false; },
    f => { f.release.tag_name = 'v0.1.1'; },
    f => { f.state.releases.push({ ...f.release, id: 43 }); },
  ]) {
    const f = fixture(t);
    f.state.onVerify = () => { if (f.state.verifications === 2) change(f); };
    await assert.rejects(f.run());
    assert.deepEqual(writes(f), []);
  }
});

test('unknown create, upload and publish results stop without another mutation', async t => {
  for (const phase of ['create', 'upload', 'publish']) {
    const f = fixture(t, 'create');
    f.state.fail = (path, method) => phase === 'create' ? path === base && method === 'POST'
      : phase === 'upload' ? path.includes('/assets?name=') : method === 'PATCH';
    await assert.rejects(f.run(), /Unknown write outcome/);
    assert.equal(f.state.calls.at(-1), writes(f).at(-1));
    assert.equal(writes(f).filter(call => phase === 'create' ? call.path === base
      : phase === 'upload' ? call.upload : call.method === 'PATCH').length, 1);
  }
});

test('lost publication response is not retried, and later recovery refuses the now-published release', async t => {
  const f = fixture(t);
  f.state.publishThenFail = true;
  await assert.rejects(f.run(), /Unknown write outcome/);
  assert.equal(writes(f).length, 1);
  await assert.rejects(f.run(), /already published/);
  assert.equal(writes(f).length, 1);
});

test('failed final readback is not treated as success or retried', async t => {
  const f = fixture(t);
  f.state.fail = path => !f.release.draft && path === `${base}/42`;
  await assert.rejects(f.run(), /Synthetic transport failure/);
  assert.equal(writes(f).length, 1);
});

test('GitHub transport authenticates listing and refuses HTTP failures without retries', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('[]', { status: 200 });
  });
  await findRelease(githubClient('synthetic-token'), 'example/cockpit', 'v0.1.0');
  assert.equal(calls[0].url, `https://api.github.com/${base}?per_page=100&page=1`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  t.mock.method(globalThis, 'fetch', async () => {
    calls.push('failure');
    return new Response('', { status: 403 });
  });
  await assert.rejects(findRelease(githubClient('synthetic-token'), 'example/cockpit', 'v0.1.0'), /HTTP 403/);
  assert.equal(calls.length, 3);
});
