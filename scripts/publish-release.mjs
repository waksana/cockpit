import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { checkRelease, checkTagTarget } from './check-release.mjs';

const names = ['runtime.tar.gz', 'runtime.tar.gz.sha256'];
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const validId = id => Number.isSafeInteger(id) && id > 0;

export function githubClient(token) {
  assert.ok(token, 'GH_TOKEN is required for authenticated draft discovery');
  async function request(path, { method = 'GET', body, upload, allowNotFound = false } = {}) {
    const url = upload
      ? `https://uploads.github.com/${path}`
      : `https://api.github.com/${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(upload ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      body: upload ? readFileSync(upload) : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 404 && method === 'GET' && allowNotFound) return null;
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}; no retry was attempted`);
    return response.json();
  }
  return {
    request,
    async download(path, destination) {
      const response = await fetch(`https://api.github.com/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(120_000),
      });
      assert.ok(response.ok, `Asset download failed: HTTP ${response.status}`);
      await pipeline(response.body, createWriteStream(destination, { flags: 'wx' }));
    },
  };
}

export async function list(client, path) {
  const entries = [];
  for (let page = 1; ; page++) {
    const batch = await client.request(`${path}?per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch), 'Invalid paginated API response');
    entries.push(...batch);
    if (batch.length < 100) break;
  }
  assert.ok(entries.every(entry => validId(entry.id)), 'Invalid API identity');
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length,
    'Repeated IDs during pagination; remote state is unstable');
  return entries;
}

export async function findRelease(client, repository, tag) {
  const path = `repos/${repository}/releases`;
  const first = await list(client, path);
  const second = await list(client, path);
  const identity = entries => entries.map(({ id, tag_name, draft, prerelease, published_at }) =>
    ({ id, tag_name, draft, prerelease, published_at }));
  // Offset pagination can skip a draft when another release is deleted mid-scan.
  assert.deepEqual(identity(second), identity(first), 'Release listing changed between scans; stop and inspect remote state');
  const matches = second.filter(release => release.tag_name === tag);
  assert.ok(matches.length <= 1, `Multiple releases match ${tag}; refusing a conflict`);
  return matches[0] ?? null;
}

function checkState(release, id, tag, draft) {
  assert.ok(validId(id), 'Invalid release ID');
  assert.equal(release.id, id, 'Release ID changed');
  assert.equal(release.tag_name, tag, 'Release tag mismatch');
  assert.equal(release.draft, draft, draft ? 'Release is already published; refusing mutation' : 'Release is still a draft');
  assert.equal(release.prerelease, false, 'Prerelease conflict');
  if (draft) assert.equal(release.published_at, null, 'Draft has already been published');
  else assert.ok(release.published_at, 'Missing publication time');
}

async function assets(client, base) {
  const result = await list(client, `${base}/assets`);
  assert.deepEqual(result.map(asset => asset.name).sort(), names, 'Incomplete or conflicting asset set');
  for (const asset of result) {
    assert.equal(asset.state, 'uploaded', 'Asset is not fully uploaded');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid asset size');
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function assetIdentity(entries) {
  return entries.map(({ id, name, size, state, digest }) => ({ id, name, size, state, digest }));
}

export async function mutate(client, path, options) {
  try {
    return await client.request(path, options);
  } catch (cause) {
    throw new Error(`Unknown write outcome for ${options.method} ${path}. Stop and inspect remote state before recovery; do not retry blindly.`, { cause });
  }
}

export async function publishRelease(options, client, verifySource) {
  const { repository, tag, sourceSha, sourceDirectory, mode } = options;
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok(mode === 'create' || mode === 'recover', 'Expected create or recover mode');
  if (mode === 'recover') {
    assert.ok(validId(options.releaseId), 'Recovery requires an exact release ID');
    assert.match(options.archiveSha256, /^[a-f0-9]{64}$/, 'Recovery requires the original archive digest');
    assert.match(options.checksumSha256, /^[a-f0-9]{64}$/, 'Recovery requires the original checksum asset digest');
  }
  await verifySource();
  let release = await findRelease(client, repository, tag);
  let expected;
  if (mode === 'create') {
    assert.equal(release, null, 'Release already exists; inspect it and use explicit recovery for a complete draft');
    const archive = join(options.artifactDirectory, names[0]);
    checkRelease(tag, sourceSha, archive, sourceDirectory);
    expected = [digest(archive), digest(`${archive}.sha256`)];
    const notes = await client.request(`repos/${repository}/releases/generate-notes`, {
      method: 'POST', body: { tag_name: tag, target_commitish: sourceSha },
    });
    assert.equal(typeof notes.body, 'string', 'Invalid generated notes');
    release = await mutate(client, `repos/${repository}/releases`, {
      method: 'POST',
      body: {
        tag_name: tag, target_commitish: sourceSha, name: `Cockpit ${tag}`,
        body: `${readFileSync(join(sourceDirectory, 'docs/release-notes.md'), 'utf8')}\n\n${notes.body}`,
        draft: true, prerelease: false,
      },
    });
    checkState(release, release.id, tag, true);
    const found = await findRelease(client, repository, tag);
    assert.ok(found, 'Created draft was not visible; stop and inspect remote state');
    checkState(found, release.id, tag, true);
    assert.deepEqual(await list(client, `repos/${repository}/releases/${release.id}/assets`), [],
      'New draft unexpectedly contains assets');
    for (const name of names) {
      await mutate(client, `repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', upload: join(options.artifactDirectory, name),
      });
    }
  } else {
    assert.ok(release, 'No exact-tag release exists; recovery never creates a replacement');
    checkState(release, options.releaseId, tag, true);
    expected = [options.archiveSha256, options.checksumSha256];
  }

  const id = release.id;
  const base = `repos/${repository}/releases/${id}`;
  checkState(await client.request(base), id, tag, true);
  const staged = await assets(client, base);
  const directory = mkdtempSync(join(tmpdir(), 'cockpit-release-verify-'));
  try {
    for (const asset of staged) {
      const path = join(directory, asset.name);
      const expectedDigest = expected[names.indexOf(asset.name)];
      if (asset.digest != null) assert.equal(asset.digest, `sha256:${expectedDigest}`, 'Asset digest conflict');
      await client.download(`repos/${repository}/releases/assets/${asset.id}`, path);
      assert.equal(statSync(path).size, asset.size, 'Downloaded asset size mismatch');
      assert.equal(digest(path), expectedDigest, 'Downloaded bytes differ from the original checked asset');
    }
    checkRelease(tag, sourceSha, join(directory, names[0]), sourceDirectory);
    await verifySource();
    const found = await findRelease(client, repository, tag);
    assert.ok(found, 'Draft disappeared before publication');
    checkState(found, id, tag, true);
    checkState(await client.request(base), id, tag, true);
    assert.deepEqual(assetIdentity(await assets(client, base)), assetIdentity(staged), 'Assets changed during verification');
    const published = await mutate(client, base, {
      method: 'PATCH', body: { draft: false, prerelease: false, make_latest: 'true' },
    });
    checkState(published, id, tag, false);
    checkState(await client.request(base), id, tag, false);
    assert.deepEqual(assetIdentity(await assets(client, base)), assetIdentity(staged), 'Published assets changed');
    checkState(await client.request(`repos/${repository}/releases/latest`), id, tag, false);
    return { id, tag, sourceSha, archiveSha256: expected[0], checksumSha256: expected[1] };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const sourceDirectory = resolve(env.RELEASE_SOURCE_DIRECTORY || '.');
  const options = {
    repository: env.GITHUB_REPOSITORY, tag: env.RELEASE_TAG, sourceSha: env.RELEASE_SOURCE_SHA,
    sourceDirectory, mode: env.RELEASE_MODE, artifactDirectory: resolve('release-artifact'),
    releaseId: Number(env.RELEASE_ID), archiveSha256: env.RELEASE_ARCHIVE_SHA256,
    checksumSha256: env.RELEASE_CHECKSUM_SHA256,
  };
  const result = await publishRelease(options, githubClient(env.GH_TOKEN), () => {
    const git = args => execFileSync('git', args, { cwd: sourceDirectory, encoding: 'utf8', timeout: 30_000 });
    assert.equal(git(['rev-parse', 'HEAD']).trim(), options.sourceSha, 'Source checkout differs from the authorized commit');
    git(['merge-base', '--is-ancestor', options.sourceSha, 'origin/main']);
    checkTagTarget(options.tag, options.sourceSha,
      git(['ls-remote', '--exit-code', 'origin', `refs/tags/${options.tag}`, `refs/tags/${options.tag}^{}`]));
  });
  console.log(JSON.stringify(result, null, 2));
}
