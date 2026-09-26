import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSourceVersion } from './check-release.mjs';
import { fileHash, hash, RELEASE_ASSETS, rollingIdentity, verifyRollingArtifacts } from './deployment-manifest.mjs';
import { assetIdentity, findRelease, githubClient, list, mutate } from './publish-release.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const marker = '<!-- cockpit-rolling:';

export function mergedPullRequest(event, repository) {
  assert.equal(event.repository?.full_name, repository);
  assert.equal(event.action, 'closed', 'Only a closed PR can trigger Rolling');
  const pr = event.pull_request;
  assert.equal(pr?.merged, true, 'Unmerged PRs do not publish');
  assert.equal(pr.base?.ref, 'main');
  assert.equal(pr.base?.repo?.full_name, repository);
  assert.ok(positive(pr.number));
  assert.match(pr.merge_commit_sha, /^[a-f0-9]{40}$/);
  assert.equal(typeof pr.title, 'string');
  assert.ok(pr.body === null || typeof pr.body === 'string');
  return { number: pr.number, title: pr.title, body: pr.body ?? '', sourceSha: pr.merge_commit_sha };
}

function provenance(release) {
  const last = release.body?.split('\n').at(-1);
  assert.ok(last?.startsWith(marker) && last.endsWith(' -->'), 'Missing final Rolling provenance record');
  return JSON.parse(Buffer.from(last.slice(marker.length, -4), 'base64').toString('utf8'));
}

function releaseText(pr, identity, runId, digests, assetSeal) {
  const notes = `# ${pr.title}\n\n${pr.body}\n\n---\n\n`
    + `PR: https://github.com/${identity.repository}/pull/${pr.number}\n\n`
    + `Source: ${identity.sourceSha}\n\nRolling sequence: ${identity.sequence}\n\n`
    + `Build: https://github.com/${identity.repository}/actions/runs/${runId}\n\n`
    + RELEASE_ASSETS.map(name => `- \`${name}\`: \`sha256:${digests[name]}\``).join('\n') + '\n\n';
  const record = { ...identity, runId, pullRequest: pr.number, digests, notesSha256: hash(notes),
    ...(assetSeal ? { assetSeal } : {}) };
  return { name: `Cockpit ${identity.tag}`,
    body: `${notes}${marker}${Buffer.from(JSON.stringify(record)).toString('base64')} -->` };
}

async function tagTarget(client, repository, tag) {
  const ref = await client.request(`repos/${repository}/git/ref/tags/${tag}`, { allowNotFound: true });
  if (ref === null) return null;
  assert.equal(ref.ref, `refs/tags/${tag}`);
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
    object = (await client.request(`repos/${repository}/git/tags/${object.sha}`)).object;
  }
  assert.equal(object.type, 'commit', 'Release tag must resolve to a commit');
  assert.match(object.sha, /^[a-f0-9]{40}$/);
  return object.sha;
}

async function releaseAssets(client, base) {
  const entries = await list(client, `${base}/assets`);
  assert.deepEqual(entries.map(asset => asset.name).sort(), [...RELEASE_ASSETS].sort(), 'Incomplete or conflicting asset set');
  for (const asset of entries) {
    assert.equal(asset.state, 'uploaded');
    assert.ok(positive(asset.size));
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/, 'GitHub must report each immutable asset digest');
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function releaseIdentity(release) {
  const { id, tag_name, target_commitish, name, body, created_at, published_at } = release;
  return { id, tag_name, target_commitish, name, body, created_at, published_at };
}

function checkReleaseState(release, identity) {
  assert.ok(positive(release.id));
  assert.equal(release.tag_name, identity.tag);
  assert.equal(release.target_commitish, identity.sourceSha);
  if (release.draft) {
    assert.equal(release.prerelease, true);
    assert.equal(release.published_at, null);
  } else {
    assert.ok(release.published_at);
    assert.equal(typeof release.prerelease, 'boolean');
  }
}

async function verifyRemote(client, identity, release, sourceDirectory) {
  checkReleaseState(release, identity);
  assert.equal(await tagTarget(client, identity.repository, identity.tag), identity.sourceSha, 'Tag identity changed');
  const base = `repos/${identity.repository}/releases/${release.id}`;
  const staged = await releaseAssets(client, base);
  const record = provenance(release);
  const { runId, pullRequest, digests, notesSha256, assetSeal, ...recordIdentity } = record;
  assert.deepEqual(recordIdentity, identity, 'Release provenance differs from Rolling identity');
  assert.ok(positive(runId) && positive(pullRequest));
  assert.equal(release.name, `Cockpit ${identity.tag}`, 'Release title changed from publication');
  assert.equal(hash(release.body.slice(0, release.body.lastIndexOf('\n') + 1)), notesSha256,
    'Release notes changed from publication');
  assert.deepEqual(Object.keys(digests).sort(), [...RELEASE_ASSETS].sort());
  if (!release.draft || assetSeal !== undefined) {
    assert.ok(Array.isArray(assetSeal), 'Published Rolling Release lacks its original asset-ID seal; no automatic repair');
    assert.deepEqual(assetIdentity(staged), assetSeal, 'Assets differ from the original published asset-ID seal');
  }
  const directory = mkdtempSync(join(tmpdir(), 'cockpit-rolling-'));
  try {
    for (const asset of staged) {
      const path = join(directory, asset.name);
      assert.equal(asset.digest, `sha256:${digests[asset.name]}`, 'Asset digest changed from publication provenance');
      await client.download(`repos/${identity.repository}/releases/assets/${asset.id}`, path);
      assert.equal(statSync(path).size, asset.size);
      assert.equal(fileHash(path), digests[asset.name], 'Downloaded asset bytes changed');
    }
    verifyRollingArtifacts(directory, identity, sourceDirectory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(releaseIdentity(await client.request(base)), releaseIdentity(release), 'Release identity changed during verification');
  assert.deepEqual(assetIdentity(await releaseAssets(client, base)), assetIdentity(staged), 'Asset identity changed during verification');
  assert.equal(await tagTarget(client, identity.repository, identity.tag), identity.sourceSha);
  return { assets: staged, record };
}

async function finalGuard(client, identity, release, assets) {
  const base = `repos/${identity.repository}/releases/${release.id}`;
  const current = await client.request(base);
  assert.deepEqual(releaseIdentity(current), releaseIdentity(release), 'Release changed before mutation');
  assert.equal(current.draft, release.draft);
  assert.equal(current.prerelease, release.prerelease);
  assert.deepEqual(assetIdentity(await releaseAssets(client, base)), assetIdentity(assets), 'Assets changed before mutation');
  assert.equal(await tagTarget(client, identity.repository, identity.tag), identity.sourceSha, 'Tag changed before mutation');
}

export async function publishRolling({ repository, event, sequence, runId, sourceDirectory, artifactDirectory }, client, verifySource) {
  const pr = mergedPullRequest(event, repository);
  const identity = rollingIdentity(repository, pr.sourceSha, sequence);
  assert.ok(positive(runId));
  await verifySource(identity.sourceSha);
  assert.equal(checkSourceVersion(sourceDirectory), '0.0.0-dev');
  const checked = verifyRollingArtifacts(artifactDirectory, identity, sourceDirectory);
  const text = releaseText(pr, identity, runId, checked.digests);
  let release = await findRelease(client, repository, identity.tag);
  if (release) {
    // A rerun may only read an already published identity. Draft/uncertain writes need explicit investigation.
    assert.equal(release.draft, false, 'Existing draft: stop and inspect the original attempt; rerun never repairs or republishes it');
    const result = await verifyRemote(client, identity, release, sourceDirectory);
    const originalText = releaseText(pr, identity, runId, checked.digests, assetIdentity(result.assets));
    assert.equal(release.name, originalText.name);
    assert.equal(release.body, originalText.body, 'Rerun changed original PR, source, run or artifact identity');
    return { ...identity, releaseId: release.id, reused: true, assets: result.assets };
  }
  const target = await tagTarget(client, repository, identity.tag);
  if (target === null) {
    await mutate(client, `repos/${repository}/git/refs`, {
      method: 'POST', body: { ref: `refs/tags/${identity.tag}`, sha: identity.sourceSha },
    });
  } else assert.equal(target, identity.sourceSha, 'Existing tag has another source');
  assert.equal(await tagTarget(client, repository, identity.tag), identity.sourceSha);
  release = await mutate(client, `repos/${repository}/releases`, {
    method: 'POST', body: { tag_name: identity.tag, target_commitish: identity.sourceSha, ...text,
      draft: true, prerelease: true, make_latest: 'false' },
  });
  checkReleaseState(release, identity);
  assert.equal(release.draft, true);
  assert.equal(release.name, text.name);
  assert.equal(release.body, text.body);
  const base = `repos/${repository}/releases/${release.id}`;
  assert.deepEqual(await list(client, `${base}/assets`), []);
  for (const name of RELEASE_ASSETS) {
    await mutate(client, `${base}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', upload: join(artifactDirectory, name),
    });
  }
  const staged = await verifyRemote(client, identity, release, sourceDirectory);
  await verifySource(identity.sourceSha);
  await finalGuard(client, identity, release, staged.assets);
  const sealedText = releaseText(pr, identity, runId, checked.digests, assetIdentity(staged.assets));
  const published = await mutate(client, base, {
    method: 'PATCH', body: { draft: false, prerelease: true, make_latest: 'false', body: sealedText.body },
  });
  assert.equal(published.draft, false);
  assert.equal(published.prerelease, true);
  const result = await verifyRemote(client, identity, published, sourceDirectory);
  assert.deepEqual(assetIdentity(result.assets), assetIdentity(staged.assets), 'Publication changed asset identities');
  assert.deepEqual({ ...releaseIdentity(published), published_at: null },
    { ...releaseIdentity(release), body: sealedText.body });
  return { ...identity, releaseId: release.id, reused: false, assets: result.assets };
}

export async function promoteMilestone({ repository, tag, confirmTag, sourceDirectory }, client, verifySource) {
  assert.equal(confirmTag, tag, 'Confirmation must repeat the exact selected Rolling tag');
  const match = /^v0\.0\.0-rolling\.([1-9]\d*)$/.exec(tag);
  assert.ok(match, 'Only an existing Rolling tag can be promoted');
  const sourceSha = await tagTarget(client, repository, tag);
  const identity = rollingIdentity(repository, sourceSha, Number(match[1]));
  await verifySource(sourceSha);
  const release = await findRelease(client, repository, tag);
  assert.ok(release, 'Selected Rolling Release does not exist');
  assert.equal(release.draft, false, 'Only a published Rolling Release can be promoted');
  const staged = await verifyRemote(client, identity, release, sourceDirectory);
  const run = await client.request(`repos/${repository}/actions/runs/${staged.record.runId}`);
  assert.equal(run.id, staged.record.runId);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.run_number, identity.sequence);
  assert.equal(run.event, 'pull_request_target');
  assert.equal(run.conclusion, 'success', 'Rolling workflow must have succeeded before promotion');
  const base = `repos/${repository}/releases/${release.id}`;
  await finalGuard(client, identity, release, staged.assets);
  const promoted = await mutate(client, base, {
    method: 'PATCH', body: { prerelease: false, make_latest: 'true' },
  });
  assert.equal(promoted.draft, false);
  assert.equal(promoted.prerelease, false);
  assert.deepEqual(releaseIdentity(promoted), releaseIdentity(release), 'Promotion changed the original Release identity');
  const result = await verifyRemote(client, identity, promoted, sourceDirectory);
  assert.deepEqual(assetIdentity(result.assets), assetIdentity(staged.assets), 'Promotion changed assets');
  const latest = await client.request(`repos/${repository}/releases/latest`);
  assert.equal(latest.id, release.id, 'Selected milestone is not Latest');
  return { ...identity, releaseId: release.id, assets: result.assets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const sourceDirectory = resolve(env.RELEASE_SOURCE_DIRECTORY || '.');
  const client = githubClient(env.GH_TOKEN);
  const verifySource = sourceSha => {
    const git = args => execFileSync('git', args, { cwd: sourceDirectory, encoding: 'utf8', timeout: 30_000 }).trim();
    assert.equal(git(['rev-parse', 'HEAD']), sourceSha);
    git(['merge-base', '--is-ancestor', sourceSha, 'origin/main']);
  };
  let result;
  if (env.RELEASE_MODE === 'promote') {
    result = await promoteMilestone({ repository: env.GITHUB_REPOSITORY, tag: env.RELEASE_TAG,
      confirmTag: env.RELEASE_CONFIRM_TAG, sourceDirectory }, client, verifySource);
  } else {
    assert.equal(env.RELEASE_MODE, 'rolling');
    result = await publishRolling({ repository: env.GITHUB_REPOSITORY,
      event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), sequence: Number(env.GITHUB_RUN_NUMBER),
      runId: Number(env.GITHUB_RUN_ID), sourceDirectory, artifactDirectory: resolve('release-artifact') }, client, verifySource);
  }
  console.log(JSON.stringify(result, null, 2));
}
