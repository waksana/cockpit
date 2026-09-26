import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { deploymentManifest, hash, HOST_PACKAGES, rollingIdentity, verifyRollingArtifacts } from './deployment-manifest.mjs';
import { mergedPullRequest, promoteMilestone, publishRolling } from './rolling-release.mjs';

const repository = 'waksana/cockpit', sha = 'a'.repeat(40);
const source = fileURLToPath(new URL('..', import.meta.url));
const rootBase = `repos/${repository}`, releaseBase = `${rootBase}/releases`;
const put = (root, path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-rolling-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source'), artifactDirectory = join(root, 'assets'), packed = join(root, 'packed');
  mkdirSync(artifactDirectory);
  for (const path of HOST_PACKAGES) put(sourceDirectory, join(path, 'package.json'), { version: '0.0.0-dev' });
  put(sourceDirectory, 'docs/release-notes.md', '# Cockpit 0.0.0-dev\n');
  put(sourceDirectory, 'apps/mcp/src/index.ts', "new McpServer({ name: 'cockpit-mcp-server', version: MCP_SERVER_VERSION })");
  for (const path of ['apps/server/src/module-host.ts', 'apps/web/src/lib/moduleRuntime.ts']) {
    put(sourceDirectory, path, readFileSync(join(source, path)));
  }
  const event = { action: 'closed', repository: { full_name: repository }, pull_request: {
    number: 123, title: 'fix: full title $(not-a-command)', body: 'Full **body**\n\nWith `code`, 中文 and\n<!-- arbitrary -->',
    merged: true, merge_commit_sha: sha, base: { ref: 'main', repo: { full_name: repository } },
  } };
  const options = { repository, event, sequence: 1, runId: 1001, sourceDirectory, artifactDirectory };
  function prepare(sequence = 1) {
    options.sequence = sequence;
    options.runId = 1000 + sequence;
    const manifest = deploymentManifest(repository, sha, sequence, sourceDirectory);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    put(packed, 'cockpit-deployment.json', bytes);
    for (const path of HOST_PACKAGES.filter(path => path !== 'apps/web')) {
      put(packed, join(path, 'package.json'), { version: manifest.version });
    }
    put(packed, 'runtime-manifest.json', { format: 1, product: 'cockpit', version: manifest.version, sourceSha: sha,
      node: process.versions.node, platform: 'linux', arch: 'x64',
      files: [{ path: 'cockpit-deployment.json', size: bytes.length, sha256: hash(bytes) }] });
    execFileSync('tar', ['-czf', join(artifactDirectory, 'runtime.tar.gz'), '-C', packed, '.']);
    put(artifactDirectory, 'cockpit-deployment.json', bytes);
    for (const name of ['runtime.tar.gz', 'cockpit-deployment.json']) {
      put(artifactDirectory, `${name}.sha256`, `${hash(readFileSync(join(artifactDirectory, name)))}  ${name}\n`);
    }
    return manifest;
  }
  prepare();
  const state = { calls: [], tags: new Map(), releases: [], assets: new Map(), latest: null, runConclusion: 'success' };
  let nextAsset = 100;
  const client = {
    async request(path, options = {}) {
      const method = options.method ?? 'GET';
      state.calls.push({ path, method, ...options });
      state.onRequest?.(path, method);
      if (state.fail?.(path, method)) throw new Error('Synthetic connection lost');
      if (method === 'GET' && path.startsWith(`${rootBase}/git/ref/tags/`)) {
        const tag = path.slice(`${rootBase}/git/ref/tags/`.length);
        return state.tags.has(tag) ? { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: state.tags.get(tag) } } : null;
      }
      if (method === 'POST' && path === `${rootBase}/git/refs`) {
        const tag = options.body.ref.slice('refs/tags/'.length);
        assert.equal(state.tags.has(tag), false);
        state.tags.set(tag, options.body.sha);
        return { ref: options.body.ref, object: { type: 'commit', sha: options.body.sha } };
      }
      if (path === `${releaseBase}?per_page=100&page=1`) return structuredClone(state.releases);
      if (method === 'POST' && path === releaseBase) {
        const entry = { id: state.releases.length + 42, ...options.body, created_at: '2026-09-26', published_at: null };
        state.releases.push(entry);
        return structuredClone(entry);
      }
      if (path === `${releaseBase}/latest`) return structuredClone(state.releases.find(item => item.id === state.latest));
      const run = new RegExp(`^${rootBase}/actions/runs/(\\d+)$`).exec(path);
      if (run) return { id: Number(run[1]), repository: { full_name: repository }, path: '.github/workflows/release.yml',
        run_number: Number(run[1]) - 1000, event: 'pull_request_target', conclusion: state.runConclusion };
      const match = new RegExp(`^${releaseBase}/(\\d+)(.*)$`).exec(path);
      assert.ok(match, `Unexpected ${method} ${path}`);
      const release = state.releases.find(item => item.id === Number(match[1]));
      if (match[2].startsWith('/assets')) {
        if (options.upload) {
          const name = new URL(`https://test.invalid/${path}`).searchParams.get('name');
          const bytes = readFileSync(options.upload);
          const asset = { id: nextAsset++, name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}` };
          state.assets.set(asset.id, { releaseId: release.id, asset, bytes });
          return structuredClone(asset);
        }
        return structuredClone([...state.assets.values()].filter(item => item.releaseId === release.id).map(item => item.asset));
      }
      if (method === 'PATCH') {
        const { make_latest, ...patch } = options.body;
        Object.assign(release, patch);
        if (release.draft === false) release.published_at ||= '2026-09-26T00:00:00Z';
        if (make_latest === 'true') state.latest = release.id;
        if (state.lostPatch) throw new Error('Lost write acknowledgement');
      }
      return structuredClone(release);
    },
    async download(path, destination) {
      state.calls.push({ path, method: 'DOWNLOAD' });
      const id = Number(path.split('/').at(-1));
      const entry = state.assets.get(id);
      put(dirname(destination), entry.asset.name, entry.bytes);
      state.onDownload?.(entry);
    },
  };
  return { root, options, state, client, prepare, artifactDirectory, sourceDirectory,
    run: () => publishRolling(options, client, async value => assert.equal(value, sha)),
    promote: (tag = `v0.0.0-rolling.${options.sequence}`, confirmTag = tag) =>
      promoteMilestone({ repository, tag, confirmTag, sourceDirectory }, client, async value => assert.equal(value, sha)) };
}
const writes = state => state.calls.filter(item => ['POST', 'PATCH'].includes(item.method));

test('only actual main merged PRs qualify, regardless of title, body or labels', () => {
  const event = { action: 'closed', repository: { full_name: repository }, pull_request: {
    number: 1, title: 'docs: title', body: null, merged: true, merge_commit_sha: sha,
    base: { ref: 'main', repo: { full_name: repository } },
  } };
  assert.equal(mergedPullRequest(event, repository).sourceSha, sha);
  for (const patch of [{ merged: false }, { base: { ref: 'feature' } }, { merge_commit_sha: 'main' }]) {
    assert.throws(() => mergedPullRequest({ ...event, pull_request: { ...event.pull_request, ...patch } }, repository));
  }
  for (const sequence of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => rollingIdentity(repository, sha, sequence));
  }
  assert.throws(() => rollingIdentity('fork/cockpit', sha, 1));
});

test('Rolling uploads four assets once, verifies before and after publication, and never takes Latest', async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.tag, 'v0.0.0-rolling.1');
  assert.equal(result.sourceSha, sha);
  assert.equal(result.assets.length, 4);
  assert.equal(f.state.latest, null);
  assert.equal(f.state.releases[0].draft, false);
  assert.equal(f.state.releases[0].prerelease, true);
  assert.ok(f.state.releases[0].body.includes(f.options.event.pull_request.title));
  assert.ok(f.state.releases[0].body.includes(f.options.event.pull_request.body));
  assert.equal(writes(f.state).filter(item => item.upload).length, 4);
  assert.equal(f.state.calls.filter(item => item.method === 'DOWNLOAD').length, 8);
  const publication = writes(f.state).at(-1).body;
  assert.deepEqual({ ...publication, body: undefined },
    { draft: false, prerelease: true, make_latest: 'false', body: undefined });
  assert.equal(publication.body, f.state.releases[0].body);
});

test('rerun reuses original PR/source/version/assets and never writes or demotes a milestone', async t => {
  const f = fixture(t);
  await f.run();
  await f.promote();
  const before = structuredClone(f.state.releases[0]), count = writes(f.state).length;
  assert.equal((await f.run()).reused, true);
  assert.equal(writes(f.state).length, count);
  assert.deepEqual(f.state.releases[0], before);
  f.options.event.pull_request.body += '\nChanged';
  await assert.rejects(f.run(), /Rerun changed/);
  assert.equal(writes(f.state).length, count);
});

test('in-place promotion changes only prerelease and Latest, with no build, upload or replacement', async t => {
  const f = fixture(t);
  await f.run();
  const before = structuredClone(f.state.releases[0]), assets = structuredClone([...f.state.assets]);
  f.state.calls.length = 0;
  const result = await f.promote();
  assert.equal(result.releaseId, before.id);
  assert.deepEqual({ ...f.state.releases[0], prerelease: true }, before);
  assert.deepEqual(structuredClone([...f.state.assets]), assets);
  assert.equal(f.state.latest, before.id);
  assert.deepEqual(writes(f.state).map(item => item.body), [{ prerelease: false, make_latest: 'true' }]);
});

test('non-Rolling, unconfirmed, failed-run and draft promotion is refused without a write', async t => {
  const f = fixture(t);
  await f.run();
  for (const action of [
    () => f.promote('v1.0.0'), () => f.promote(undefined, 'v0.0.0-rolling.2'),
    () => { f.state.runConclusion = 'failure'; return f.promote(); },
    () => { f.state.releases[0].draft = true; return f.promote(); },
  ]) {
    const count = writes(f.state).length;
    await assert.rejects(action());
    assert.equal(writes(f.state).length, count);
  }
});

test('pre-existing title or notes edits cannot be promoted even when provenance remains intact', async t => {
  for (const field of ['name', 'body']) {
    const f = fixture(t);
    await f.run();
    if (field === 'name') f.state.releases[0].name = 'Changed title';
    else f.state.releases[0].body = `Changed notes\n${f.state.releases[0].body.split('\n').at(-1)}`;
    const count = writes(f.state).length;
    await assert.rejects(f.promote(), /changed from publication/);
    assert.equal(writes(f.state).length, count);
  }
});

test('missing, additional, replaced and changed assets prevent promotion', async t => {
  for (const change of [
    f => f.state.assets.delete(100),
    f => f.state.assets.set(999, { ...f.state.assets.get(100), asset: { ...f.state.assets.get(100).asset, id: 999, name: 'extra' } }),
    f => { f.state.assets.get(100).bytes = Buffer.from('corrupt'); },
    f => { f.state.assets.get(100).asset.digest = `sha256:${'0'.repeat(64)}`; },
    f => { f.state.assets.get(100).asset.id = 999; },
    f => { f.state.onDownload = entry => { entry.asset.id++; }; },
  ]) {
    const f = fixture(t);
    await f.run();
    change(f);
    const count = writes(f.state).length;
    await assert.rejects(f.promote());
    assert.equal(writes(f.state).length, count);
  }
});

test('the original asset-ID seal is published atomically and required by promotion and reruns', async t => {
  const f = fixture(t);
  await f.run();
  assert.equal(writes(f.state).filter(item => item.method === 'PATCH').length, 1);
  assert.equal(writes(f.state).find(item => item.path === releaseBase).body.draft, true);
  const release = f.state.releases[0];
  const lines = release.body.split('\n');
  const record = JSON.parse(Buffer.from(lines.at(-1).slice('<!-- cockpit-rolling:'.length, -4), 'base64'));
  assert.equal(record.assetSeal.length, 4);
  assert.deepEqual(record.assetSeal.map(asset => asset.id).sort(), [100, 101, 102, 103]);
  delete record.assetSeal;
  lines[lines.length - 1] = `<!-- cockpit-rolling:${Buffer.from(JSON.stringify(record)).toString('base64')} -->`;
  release.body = lines.join('\n');
  const count = writes(f.state).length;
  await assert.rejects(f.promote(), /lacks its original asset-ID seal/);
  await assert.rejects(f.run(), /lacks its original asset-ID seal/);
  assert.equal(writes(f.state).length, count);
});

test('unknown publication is not retried and an existing draft is never repaired by rerun', async t => {
  const f = fixture(t);
  f.state.fail = (path, method) => method === 'POST' && path.includes('/assets?');
  await assert.rejects(f.run(), /Unknown write outcome/);
  assert.equal(writes(f.state).filter(item => item.upload).length, 1);
  f.state.fail = undefined;
  const count = writes(f.state).length;
  await assert.rejects(f.run(), /Existing draft/);
  assert.equal(writes(f.state).length, count);
});

test('lost publication acknowledgement is reported as unknown, with no retry or second release', async t => {
  const f = fixture(t);
  f.state.lostPatch = true;
  await assert.rejects(f.run(), /Unknown write outcome/);
  assert.equal(f.state.releases[0].draft, false);
  assert.equal(writes(f.state).filter(item => item.method === 'PATCH').length, 1);
  const count = writes(f.state).length;
  f.state.lostPatch = false;
  assert.equal((await f.run()).reused, true);
  assert.equal(writes(f.state).length, count);
  assert.equal(f.state.releases.length, 1);
});

test('tag conflicts and assets changed after verification stop the final write', async t => {
  const f = fixture(t);
  f.state.tags.set('v0.0.0-rolling.1', 'b'.repeat(40));
  await assert.rejects(f.run(), /another source/);
  assert.equal(writes(f.state).length, 0);
  f.state.tags.clear();
  await f.run();
  const count = writes(f.state).length;
  f.state.onRequest = path => {
    if (path.includes('/actions/runs/')) f.state.assets.get(100).asset.id = 999;
  };
  await assert.rejects(f.promote(), /changed before mutation/);
  assert.equal(writes(f.state).length, count);
});

test('late lower sequence and failed attempts cannot block or supersede a newer candidate', async t => {
  const f = fixture(t);
  f.prepare(2);
  await f.run();
  f.prepare(3);
  f.state.fail = (path, method) => method === 'POST' && path.includes('/assets?');
  await assert.rejects(f.run());
  f.state.fail = undefined;
  f.prepare(1);
  await f.run();
  f.prepare(4);
  await f.run();
  const successful = f.state.releases.filter(release => !release.draft);
  assert.deepEqual(successful.map(release => release.tag_name), ['v0.0.0-rolling.2', 'v0.0.0-rolling.1', 'v0.0.0-rolling.4']);
  assert.equal(Math.max(...successful.map(release => Number(release.tag_name.split('.').at(-1)))), 4);
  assert.equal(f.state.latest, null);
});

test('artifact validation rejects checksum, descriptor, inventory and source capability changes', t => {
  const f = fixture(t), expected = rollingIdentity(repository, sha, 1);
  verifyRollingArtifacts(f.artifactDirectory, expected, f.sourceDirectory);
  put(f.artifactDirectory, 'cockpit-deployment.json.sha256', 'incorrect\n');
  assert.throws(() => verifyRollingArtifacts(f.artifactDirectory, expected, f.sourceDirectory));
  f.prepare();
  put(f.sourceDirectory, 'apps/server/src/module-host.ts', 'apiVersion: 1');
  assert.throws(() => verifyRollingArtifacts(f.artifactDirectory, expected, f.sourceDirectory), /source declaration/);
});

test('workflow keeps every closed merge independent and exposes no legacy tag trigger', () => {
  const rolling = readFileSync(join(source, '.github/workflows/release.yml'), 'utf8');
  const build = readFileSync(join(source, '.github/workflows/build.yml'), 'utf8');
  assert.match(rolling, /pull_request_target:/);
  assert.match(rolling, /types: \[closed\]/);
  assert.match(rolling, /github\.event\.pull_request\.merged == true/);
  assert.match(rolling, /rolling_sequence: \$\{\{ github\.run_number \}\}/);
  assert.doesNotMatch(rolling, /concurrency:|tags:|paths:|labels|workflow_dispatch:/);
  assert.match(build, /github\.run_id/);
  assert.match(build, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});
