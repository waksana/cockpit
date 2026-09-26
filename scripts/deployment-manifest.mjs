import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const HOST_PACKAGES = ['', 'apps/server', 'apps/mcp', 'apps/web', 'packages/core', 'packages/protocol'];
export const RELEASE_ASSETS = [
  'runtime.tar.gz', 'runtime.tar.gz.sha256', 'cockpit-deployment.json', 'cockpit-deployment.json.sha256',
];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileHash = path => hash(readFileSync(path));

export function rollingIdentity(repository, sourceSha, sequence) {
  assert.equal(repository, 'waksana/cockpit', 'Rolling publication is restricted to the host repository');
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0, 'Rolling sequence must be a positive safe integer');
  const version = `0.0.0-rolling.${sequence}`;
  return { format: 2, channel: 'rolling', repository, tag: `v${version}`, sourceSha, version, sequence,
    archive: { name: RELEASE_ASSETS[0] } };
}

function literalVersion(source, field) {
  const matches = [...source.matchAll(new RegExp(`\\b${field}: (\\d+)\\b`, 'g'))];
  assert.equal(matches.length, 1, `Expected exactly one source declaration for ${field}`);
  const version = Number(matches[0][1]);
  assert.ok(Number.isSafeInteger(version) && version > 0);
  return version;
}

// Read actual activation-context declarations, not a version-by-version deployment catalog.
export function hostProduct(repository) {
  const backend = readFileSync(join(repository, 'apps/server/src/module-host.ts'), 'utf8');
  const frontend = readFileSync(join(repository, 'apps/web/src/lib/moduleRuntime.ts'), 'utf8');
  const api = literalVersion(backend, 'apiVersion');
  const capabilities = [`module-api.v${api}`];
  for (const field of ['serviceReady', 'resourcePreparation']) {
    capabilities.push(`${field}.v${literalVersion(backend, `${field}Version`)}`);
  }
  capabilities.push(`frontend-api.v${literalVersion(frontend, 'apiVersion')}`);
  for (const field of ['ui', 'uiSurface', 'menu', 'chatWindow', 'composerInput', 'draftLifecycle', 'draftSubmission']) {
    capabilities.push(`${field}.v${literalVersion(frontend, `${field}Version`)}`);
  }
  return { kind: 'host', api, capabilities };
}

export function deploymentManifest(repository, sourceSha, sequence, sourceDirectory) {
  return { ...rollingIdentity(repository, sourceSha, sequence), product: hostProduct(sourceDirectory) };
}

export function archiveFile(archive, path) {
  return execFileSync('tar', ['-xOzf', archive, `./${path}`], { maxBuffer: 16 * 1024 * 1024 });
}

export function verifyRollingArtifacts(directory, expected, sourceDirectory) {
  assert.deepEqual(readdirSync(directory).sort(), [...RELEASE_ASSETS].sort(), 'Release must contain exactly four assets');
  const archive = join(directory, RELEASE_ASSETS[0]);
  for (const name of [RELEASE_ASSETS[0], 'cockpit-deployment.json']) {
    assert.equal(readFileSync(join(directory, `${name}.sha256`), 'utf8'), `${fileHash(join(directory, name))}  ${name}\n`,
      `Invalid checksum for ${name}`);
  }
  const bytes = readFileSync(join(directory, 'cockpit-deployment.json'));
  const descriptor = JSON.parse(bytes);
  assert.deepEqual(descriptor, deploymentManifest(expected.repository, expected.sourceSha, expected.sequence, sourceDirectory),
    'Deployment descriptor differs from source identity or compatibility declarations');
  assert.equal(descriptor.tag, expected.tag);
  assert.deepEqual(archiveFile(archive, 'cockpit-deployment.json'), bytes, 'Embedded deployment descriptor differs from sidecar');
  const runtime = JSON.parse(archiveFile(archive, 'runtime-manifest.json'));
  assert.equal(runtime.format, 1);
  assert.equal(runtime.product, 'cockpit');
  assert.equal(runtime.version, descriptor.version);
  assert.equal(runtime.sourceSha, descriptor.sourceSha);
  assert.equal(runtime.platform, 'linux');
  assert.equal(runtime.arch, 'x64');
  assert.match(runtime.node, /^\d+\.\d+\.\d+$/);
  const entry = runtime.files.filter(file => file.path === 'cockpit-deployment.json');
  assert.equal(entry.length, 1, 'Runtime inventory must contain the deployment descriptor exactly once');
  assert.equal(entry[0].sha256, hash(bytes));
  assert.equal(entry[0].size, bytes.length);
  for (const path of HOST_PACKAGES.filter(path => path !== 'apps/web')) {
    assert.equal(JSON.parse(archiveFile(archive, `${path ? `${path}/` : ''}package.json`)).version, descriptor.version);
  }
  return { descriptor, digests: Object.fromEntries(RELEASE_ASSETS.map(name => [name, fileHash(join(directory, name))])) };
}
