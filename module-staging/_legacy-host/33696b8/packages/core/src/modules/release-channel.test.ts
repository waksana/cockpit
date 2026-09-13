import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkReleaseChannel, downloadRelease, verifyReleaseMetadata, type ReleaseChannel, type ReleaseMetadata } from './release-channel.ts';

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const channel: ReleaseChannel = { metadataUrl: 'https://publisher.invalid/releases/stable.json',
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    allowedDownloadOrigins: ['https://publisher.invalid', 'https://assets.invalid'] };
  const bytes = Buffer.from('synthetic module archive');
  const metadata: ReleaseMetadata = { schemaVersion: 1, channel: 'stable', sequence: 5,
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    targets: [{ moduleId: 'assistant', version: '1.0.0', platform: 'linux', arch: 'x64', nodeMajor: 24,
      sourceSha: 'a'.repeat(40), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      url: 'https://publisher.invalid/archive.zip' }] };
  const envelope = (value: unknown = metadata) => {
    const payload = Buffer.from(JSON.stringify(value));
    return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  };
  return { channel, bytes, metadata, envelope };
}

test('release metadata requires pinned publisher signature, bounded validity, sequence and allowed origins', () => {
  const f = fixture();
  assert.deepEqual(verifyReleaseMetadata(f.envelope(), f.channel, 5), f.metadata);
  assert.throws(() => verifyReleaseMetadata(f.envelope(), fixture().channel), /signature/);
  assert.throws(() => verifyReleaseMetadata({ ...f.envelope(), payload: Buffer.from('{}').toString('base64') }, f.channel), /signature/);
  assert.throws(() => verifyReleaseMetadata(f.envelope(), f.channel, 6), /sequence/);
  assert.throws(() => verifyReleaseMetadata(f.envelope({ ...f.metadata, expiresAt: new Date(0).toISOString() }), f.channel), /expired/);
  assert.throws(() => verifyReleaseMetadata(f.envelope({
    ...f.metadata, targets: [{ ...f.metadata.targets[0], url: 'https://untrusted.invalid/steal' }],
  }), f.channel), /outside local policy/);
  assert.throws(() => verifyReleaseMetadata(f.envelope({
    ...f.metadata, targets: [f.metadata.targets[0], f.metadata.targets[0]],
  }), f.channel), /Duplicate/);
});

test('release archive verifies streamed bytes without overwriting existing files or leaking private auth on redirects', async t => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  f.channel.tokenFile = join(dir, 'credential');
  writeFileSync(f.channel.tokenFile, 'synthetic-readonly-credential', { mode: 0o600 });
  const requests: { url: string; auth: string | null }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('stable.json')) return new Response(JSON.stringify(f.envelope()));
    if (url.startsWith('https://publisher.invalid')) {
      return new Response(null, { status: 302, headers: { location: 'https://assets.invalid/archive.zip' } });
    }
    return new Response(f.bytes);
  };
  const checked = await checkReleaseChannel(f.channel, 0, transport);
  const target = checked.metadata.targets[0]!;
  const file = join(dir, 'archive.zip');
  await downloadRelease(target, f.channel, file, transport);
  assert.deepEqual(readFileSync(file), f.bytes);
  assert.ok(requests.filter(request => request.url.startsWith('https://publisher.invalid')).every(request => request.auth));
  assert.ok(requests.filter(request => request.url.startsWith('https://assets.invalid')).every(request => request.auth === null));
  await assert.rejects(downloadRelease(target, f.channel, file, transport), /EEXIST/);
  assert.deepEqual(readFileSync(file), f.bytes);
  const corrupt = join(dir, 'corrupt.zip');
  await assert.rejects(downloadRelease(target, f.channel, corrupt, async () => new Response('bad')), /signed size and digest/);
  assert.equal(existsSync(corrupt), false);
  await assert.rejects(downloadRelease(target, f.channel, join(dir, 'redirect.zip'), async () =>
    new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/archive.zip' } })), /not explicitly trusted/);
  assert.equal(existsSync(join(dir, 'redirect.zip')), false);
});
