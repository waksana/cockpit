import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIdentity } from './identity.ts';

test('source identity reports package version and a fresh instance without inventing a source SHA', t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-identity-'));
  t.after(() => rmSync(root, { recursive: true }));
  const file = join(root, 'package.json'), manifest = join(root, 'runtime-manifest.json');
  writeFileSync(file, '{"version":"1.0.0"}');
  const read = () => readIdentity(pathToFileURL(file), pathToFileURL(manifest));
  const first = read(), second = read();
  assert.equal(first.version, '1.0.0');
  assert.equal(first.sourceSha, null);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal('requestId' in first, false);
  assert.equal('installationId' in first, false);
  assert.equal('artifactSha256' in first, false);
});

test('packaged identity comes from a valid matching manifest; corrupt or incompatible metadata fails', t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-packaged-identity-'));
  t.after(() => rmSync(root, { recursive: true }));
  const file = join(root, 'package.json'), manifest = join(root, 'runtime-manifest.json');
  writeFileSync(file, '{"version":"1.0.0"}');
  const value = { format: 1, product: 'cockpit', version: '1.0.0', sourceSha: 'a'.repeat(40),
    node: process.versions.node, platform: process.platform, arch: process.arch, files: {} };
  const read = () => readIdentity(pathToFileURL(file), pathToFileURL(manifest));
  writeFileSync(manifest, JSON.stringify(value));
  assert.equal(read().sourceSha, value.sourceSha);
  for (const changed of [{ version: '2.0.0' }, { node: '0.0.0' }, { platform: 'unsupported' },
    { arch: 'unsupported' }, { sourceSha: 'invalid' }, { product: 'different' }]) {
    writeFileSync(manifest, JSON.stringify({ ...value, ...changed }));
    assert.throws(read);
  }
  writeFileSync(manifest, '{invalid');
  assert.throws(read, SyntaxError);
});
