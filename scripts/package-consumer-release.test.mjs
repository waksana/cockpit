import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inventory } from '../.delivery/toolkit/lib/artifact.mjs';
import { bootstrapFiles, packageConsumerRelease } from './package-consumer-release.mjs';
import { verifyConsumerBootstrap } from './verify-consumer-bootstrap.mjs';

const scripts = fileURLToPath(new URL('.', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(scripts, '..', '.publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const files = {
    'apps/server/src/index.ts': 'export {};\n',
    'apps/server/package.json': '{"version":"1.2.3"}',
    'apps/web/dist/index.html': '<html>fixture</html>',
    'packages/core/src/index.ts': 'export {};\n',
    'packages/protocol/src/index.ts': 'export {};\n',
    'consumer-runtime.json': '{"schemaVersion":1,"dataCompatibility":"cockpit-user-root-v1","automaticDataMigrations":false,"moduleRunnerApi":1,"moduleRunnerLifecycleApi":1}',
    'packages/core/src/modules/supervisor-entry.ts': '// Publisher archive fixture only.',
    'node_modules/dependency/data/a real path with spaces.txt': 'real CI archives include spaces\n',
  };
  for (const path of Object.values(bootstrapFiles)) files[path] = await readFile(join(scripts, '..', path), 'utf8');
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), body);
  }
  const sourceSha = 'a'.repeat(40);
  const manifest = { format: 1, sourceSha, configSha256: 'b'.repeat(64), requestId: 'fixture-only',
    node: process.versions.node, platform: process.platform, arch: process.arch, files: await inventory(source) };
  await writeFile(join(source, 'delivery-manifest.json'), JSON.stringify(manifest));
  const runtime = join(root, 'runtime.tar.gz');
  execFileSync('tar', ['-czf', runtime, '-C', source, '.']);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyFile = join(root, 'fixture-only-signing-key.pem');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const specification = { schemaVersion: 1, channel: 'stable', sequence: 7, version: '1.2.3', sourceSha,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    url: 'https://publisher.example/releases/cockpit-linux-x64.zip' };
  const metadataFile = join(root, 'metadata.json');
  await writeFile(metadataFile, JSON.stringify(specification));
  return { root, source, runtime, publicKey, keyFile, metadataFile, specification,
    output: join(root, 'published') };
}

test('consumer publisher signs actual ZIP digest and preserves CI tar bytes and spaced paths', async t => {
  const f = await fixture(t);
  const result = await packageConsumerRelease(f);
  const zip = await readFile(result.archive);
  assert.equal(result.target.sha256, createHash('sha256').update(zip).digest('hex'));
  assert.equal(result.target.bytes, zip.length);
  const original = await readFile(f.runtime);
  const wrapped = execFileSync('python3', ['-c',
    'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.namelist()==["runtime.tar.gz"]\n sys.stdout.buffer.write(z.read("runtime.tar.gz"))',
    result.archive]);
  assert.deepEqual(wrapped, original);
  const envelope = JSON.parse(await readFile(result.envelope, 'utf8'));
  const payload = Buffer.from(envelope.payload, 'base64');
  assert.equal(verify(null, payload, f.publicKey, Buffer.from(envelope.signature, 'base64')), true);
  const signed = JSON.parse(payload.toString());
  assert.equal(signed.targets[0].moduleId, 'cockpit');
  assert.deepEqual(signed.targets[0], result.target);
  assert.equal(signed.sequence, 7);
  const bootstrap = JSON.parse(await readFile(result.bootstrapEnvelope, 'utf8'));
  const bootstrapPayload = Buffer.from(bootstrap.payload, 'base64');
  assert.equal(verify(null, bootstrapPayload, f.publicKey, Buffer.from(bootstrap.signature, 'base64')), true);
  assert.equal(JSON.parse(bootstrapPayload.toString()).sha256,
    createHash('sha256').update(await readFile(result.bootstrapArchive)).digest('hex'));
  const publicKeyFile = join(f.root, 'fixture-public.pem');
  await writeFile(publicKeyFile, f.publicKey.export({ type: 'spki', format: 'pem' }));
  const boot = await verifyConsumerBootstrap({ archive: result.bootstrapArchive, envelopeFile: result.bootstrapEnvelope,
    publicKeyFile, sourceSha: f.specification.sourceSha, destination: join(f.root, 'verified-bootstrap') });
  assert.equal(boot.verified, true);
  const config = join(f.root, 'bootstrap-channel.json');
  await writeFile(config, JSON.stringify({ metadataUrl: 'https://publisher.example/stable.json',
    publicKey: await readFile(publicKeyFile, 'utf8'), allowedDownloadOrigins: ['https://publisher.example'] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SERVICE_DELIVERY_')
    && !key.startsWith('COCKPIT_CONSUMER_') && key !== 'COCKPIT_DELIVERY_VIEWER_CREDENTIAL'));
  const initialized = JSON.parse(execFileSync(process.execPath, [join(boot.destination, 'cli.mjs'), 'init',
    '--root', join(f.root, 'consumer-install'), '--user-root', join(f.root, 'consumer-user'), '--channel', config],
    { env: { ...env, COCKPIT_HOME: join(f.root, 'native-fixture') }, encoding: 'utf8' }));
  assert.equal(initialized.authority, 'consumer', 'bootstrap initializes without repository or node_modules imports');
  await assert.rejects(verifyConsumerBootstrap({ archive: result.bootstrapArchive, envelopeFile: result.bootstrapEnvelope,
    publicKeyFile, sourceSha: 'f'.repeat(40), destination: join(f.root, 'wrong-bootstrap') }), /does not match/);
  await assert.rejects(packageConsumerRelease(f), /EEXIST/);
  assert.deepEqual(await readFile(result.archive), zip, 'published bytes are never replaced');
});

test('consumer publisher rejects modified inventory, wrong source, version and exposed key', async t => {
  const f = await fixture(t);
  await chmod(f.keyFile, 0o644);
  await assert.rejects(packageConsumerRelease(f), /owner-only/);
  await chmod(f.keyFile, 0o600);
  await writeFile(f.metadataFile, JSON.stringify({ ...f.specification, sourceSha: 'c'.repeat(40) }));
  await assert.rejects(packageConsumerRelease(f), /sourceSha mismatch/);
  await assert.rejects(readFile(join(f.output, 'stable.signed.json')), /ENOENT/);
  await writeFile(f.metadataFile, JSON.stringify({ ...f.specification, version: '9.9.9' }));
  await assert.rejects(packageConsumerRelease({ ...f, output: join(f.root, 'wrong-version') }), /packaged server version/);
  await writeFile(f.metadataFile, JSON.stringify(f.specification));
  await writeFile(join(f.source, 'apps/server/src/index.ts'), 'tampered');
  execFileSync('tar', ['-czf', f.runtime, '-C', f.source, '.']);
  await assert.rejects(packageConsumerRelease({ ...f, output: join(f.root, 'bad-inventory') }), /inventory mismatch/);
});

test('consumer publisher rejects stale metadata and non-HTTPS release destinations', async t => {
  const f = await fixture(t);
  await writeFile(f.metadataFile, JSON.stringify({ ...f.specification, expiresAt: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(packageConsumerRelease(f), /validity interval/);
  await writeFile(f.metadataFile, JSON.stringify({ ...f.specification, url: 'http://publisher.example/release.zip' }));
  await assert.rejects(packageConsumerRelease(f), /HTTPS/);
});

test('publisher refuses a main package incompatible with the owned runner API', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'consumer-runtime.json'), JSON.stringify({ schemaVersion: 1,
    automaticDataMigrations: false, dataCompatibility: 'cockpit-user-root-v1', moduleRunnerApi: 2 }));
  const path = join(f.source, 'delivery-manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  await rm(path);
  await writeFile(path, JSON.stringify({ ...manifest, files: await inventory(f.source) }));
  execFileSync('tar', ['-czf', f.runtime, '-C', f.source, '.']);
  await assert.rejects(packageConsumerRelease(f), /API1/);
});

test('publisher refuses an old resident-runner archive without owned lifecycle compatibility', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'consumer-runtime.json'), JSON.stringify({ schemaVersion: 1,
    automaticDataMigrations: false, dataCompatibility: 'cockpit-user-root-v1', moduleRunnerApi: 1 }));
  const path = join(f.source, 'delivery-manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  await rm(path);
  await writeFile(path, JSON.stringify({ ...manifest, files: await inventory(f.source) }));
  execFileSync('tar', ['-czf', f.runtime, '-C', f.source, '.']);
  await assert.rejects(packageConsumerRelease(f), /lifecycle|API1/);
});

test('private GitHub two-pass publication changes signed asset URL without changing the uploaded main ZIP', async t => {
  const f = await fixture(t);
  const draft = await packageConsumerRelease(f);
  const url = 'https://api.github.com/repos/fixture/project/releases/assets/123';
  await writeFile(f.metadataFile, JSON.stringify({ ...f.specification, url }));
  const final = await packageConsumerRelease({ ...f, output: join(f.root, 'final-published') });
  assert.deepEqual(await readFile(final.archive), await readFile(draft.archive));
  assert.equal(final.target.sha256, draft.target.sha256);
  const envelope = JSON.parse(await readFile(final.envelope, 'utf8'));
  const payload = Buffer.from(envelope.payload, 'base64');
  assert.equal(verify(null, payload, f.publicKey, Buffer.from(envelope.signature, 'base64')), true);
  assert.equal(JSON.parse(payload.toString()).targets[0].url, url);
});

test('optional actual CI runtime archive is consumed without rebuilding or repacking tar', {
  skip: !process.env.COCKPIT_CONSUMER_RUNTIME_ARCHIVE || !process.env.COCKPIT_CONSUMER_PUBLISH_SPEC,
}, async t => {
  const f = await fixture(t);
  const result = await packageConsumerRelease({ ...f, runtime: process.env.COCKPIT_CONSUMER_RUNTIME_ARCHIVE,
    metadataFile: process.env.COCKPIT_CONSUMER_PUBLISH_SPEC });
  assert.equal(result.target.moduleId, 'cockpit');
  assert.ok(result.target.bytes > 0);
});
