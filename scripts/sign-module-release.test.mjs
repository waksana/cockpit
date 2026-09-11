import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
test('publisher produces verifiable envelopes without overwrite or accepting an exposed signing key',
  { skip: Number(process.versions.node.split('.')[0]) !== 24 }, async t => {
  const { signModuleRelease } = await import('./sign-module-release.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'module-release-publisher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = join(dir, 'key.pem'), input = join(dir, 'metadata.json'), output = join(dir, 'signed.json');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const metadata = { schemaVersion: 1, channel: 'stable', sequence: 1,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), targets: [] };
  writeFileSync(input, JSON.stringify(metadata));
  assert.deepEqual(signModuleRelease(input, key, output), { sequence: 1, targets: 0 });
  const envelope = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(verify(null, Buffer.from(envelope.payload, 'base64'), publicKey, Buffer.from(envelope.signature, 'base64')), true);
  assert.deepEqual(JSON.parse(Buffer.from(envelope.payload, 'base64').toString()), metadata);
  assert.throws(() => signModuleRelease(input, key, output), /EEXIST/);
  chmodSync(key, 0o644);
  assert.throws(() => signModuleRelease(input, key, join(dir, 'refused.json')), /owner-only/);
});
