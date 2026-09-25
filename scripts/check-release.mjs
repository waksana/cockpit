import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSdkVersionChange } from './check-sdk-changes.mjs';

function checkExactTagTarget(tag, sourceSha, refs) {
  const targets = new Map();
  for (const line of refs.trim().split('\n').filter(Boolean)) {
    const [sha, ref, extra] = line.trim().split(/\s+/);
    assert.match(sha, /^[a-f0-9]{40}$/);
    assert.ok(ref === `refs/tags/${tag}` || ref === `refs/tags/${tag}^{}`);
    assert.ok(!extra && !targets.has(ref), 'Unexpected tag lookup result');
    targets.set(ref, sha);
  }
  assert.ok(targets.has(`refs/tags/${tag}`), 'Release tag no longer exists');
  assert.equal(targets.get(`refs/tags/${tag}^{}`) ?? targets.get(`refs/tags/${tag}`),
    sourceSha, 'Release tag moved after this workflow started');
}

export function checkTagTarget(tag, sourceSha, refs) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  checkExactTagTarget(tag, sourceSha, refs);
}

export function checkSdkTagTarget(tag, sourceSha, refs) {
  assert.match(tag, /^module-sdk-v\d+\.\d+\.\d+$/);
  checkExactTagTarget(tag, sourceSha, refs);
}

export function checkSourceVersion(repository = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const { version } = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Delivery versions use MAJOR.MINOR.PATCH');
  for (const name of ['', 'apps/server', 'apps/mcp', 'apps/web', 'packages/core', 'packages/protocol']) {
    const metadata = JSON.parse(readFileSync(resolve(repository, name, 'package.json'), 'utf8'));
    assert.equal(metadata.version, version, `${name || 'root'} version does not match ${version}`);
  }
  const mcp = readFileSync(resolve(repository, 'apps/mcp/src/index.ts'), 'utf8');
  // apps/mcp/package.json is checked above and is the handshake's only version source.
  assert.ok(mcp.includes("new McpServer({ name: 'cockpit-mcp-server', version: MCP_SERVER_VERSION })"),
    'MCP self-reported version must come from apps/mcp/package.json');
  const notes = readFileSync(resolve(repository, 'docs/release-notes.md'), 'utf8').split(/\r?\n/);
  assert.equal(notes[0], `# Cockpit ${version}`, 'Release notes must match the workspace version');
  let fenced = false;
  const extra = notes.slice(1).find(line => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && (/^#\s/.test(line) || /^#{1,6}\s+(Cockpit\s+)?(v?\d+\.\d+\.\d+|unreleased)\b/i.test(line));
  });
  assert.equal(extra, undefined, 'Release notes must describe only the current version; earlier notes belong in GitHub Releases');
  return version;
}

export function checkSdkSourceVersion(repository = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const manifest = JSON.parse(readFileSync(resolve(repository, 'packages/module-api/package.json'), 'utf8'));
  assert.equal(manifest.name, '@waksana/cockpit-module-sdk');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'SDK versions use MAJOR.MINOR.PATCH');
  assert.equal(manifest.publishConfig?.registry, 'https://npm.pkg.github.com');
  assert.equal(manifest.dependencies, undefined, 'SDK publication must not have runtime dependencies');
  assert.doesNotMatch(JSON.stringify(manifest), /(?:workspace|file):/, 'SDK publication must not reference the workspace');
  const records = JSON.parse(readFileSync(resolve(repository, 'packages/module-api/changes.json'), 'utf8'));
  checkSdkVersionChange(manifest.version, manifest.version, false, records);
  return manifest.version;
}

export function checkSdkRelease(tag, sourceSha, archive, repository = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  assert.match(tag, /^module-sdk-v\d+\.\d+\.\d+$/, 'SDK release tags use module-sdk-vMAJOR.MINOR.PATCH');
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'SDK release source must be an exact commit');
  const version = tag.slice('module-sdk-v'.length);
  assert.equal(checkSdkSourceVersion(repository), version, 'SDK version must match the tag');
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }));
  assert.equal(manifest.name, '@waksana/cockpit-module-sdk');
  assert.equal(manifest.version, version);
  assert.equal(manifest.publishConfig?.registry, 'https://npm.pkg.github.com');
  assert.equal(manifest.dependencies, undefined, 'Packed SDK must not have runtime dependencies');
  assert.doesNotMatch(JSON.stringify(manifest), /(?:workspace|file):/, 'Packed SDK must not reference the workspace');
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(files.includes('package/dist/index.js'), 'Packed SDK is missing JavaScript');
  assert.ok(files.includes('package/dist/index.d.ts'), 'Packed SDK is missing declarations');
  return { tag, sourceSha, version, package: manifest.name, registry: manifest.publishConfig.registry };
}

export function checkRelease(tag, sourceSha, archive, repository = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Release tags use vMAJOR.MINOR.PATCH');
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'Release source must be an exact commit');
  const version = tag.slice(1);
  assert.equal(checkSourceVersion(repository), version, 'Workspace version must match the tag');
  const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8').trim(), `${checksum}  ${basename(archive)}`);
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, './runtime-manifest.json'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.product, 'cockpit');
  assert.equal(manifest.version, version);
  assert.equal(manifest.sourceSha, sourceSha);
  assert.equal(manifest.node, process.versions.node);
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.arch, 'x64');
  return { tag, sourceSha, version, sha256: checksum, node: manifest.node, platform: manifest.platform, arch: manifest.arch };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, archive, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'Usage: check-release.mjs <tag> <source-sha> <archive>');
  assert.ok(tag && sha && archive, 'Usage: check-release.mjs <tag> <source-sha> <archive>');
  const result = checkRelease(tag, sha, archive);
  const refs = execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: 'utf8', timeout: 30_000,
  });
  checkTagTarget(tag, sha, refs);
  console.log(JSON.stringify(result, null, 2));
}
