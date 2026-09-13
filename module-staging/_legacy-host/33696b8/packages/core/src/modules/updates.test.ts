import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModuleCatalog } from './catalog.ts';
import { ModuleUpdates } from './updates.ts';
import { writeModuleRecord } from './private-files.ts';

test('the signed published ZIP is consumed unchanged, verified and installed without touching data or applying sessions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-archive-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), archive = join(root, 'release.zip'), userRoot = join(root, 'user');
  mkdirSync(source);
  const manifest = { schemaVersion: 1, id: 'assistant', version: '1.0.0', name: 'Synthetic Assistant',
    description: 'Synthetic package only', compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' },
    configVersion: 1, roles: [{ id: 'assistant', name: 'Assistant', description: 'Synthetic role', instructions: 'role.md' }] };
  writeFileSync(join(source, 'module.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'role.md'), 'SYNTHETIC_RELEASE_ROLE');
  execFileSync('python3', ['-c',
    'import io,os,sys,tarfile,zipfile\nb=io.BytesIO()\nwith tarfile.open(fileobj=b,mode="w:gz") as t:\n for n in sorted(os.listdir(sys.argv[1])): t.add(os.path.join(sys.argv[1],n),arcname=n)\nwith zipfile.ZipFile(sys.argv[2],"w") as z: z.writestr("runtime.tar.gz",b.getvalue())',
    source, archive]);
  const bytes = readFileSync(archive), digest = createHash('sha256').update(bytes).digest('hex');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const metadata = { schemaVersion: 1, channel: 'stable', sequence: 1,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    targets: [{ moduleId: 'assistant', version: '1.0.0', platform: 'linux', arch: 'x64', nodeMajor: 24,
      sourceSha: 'a'.repeat(40), sha256: digest, bytes: bytes.length, url: 'https://publisher.invalid/release.zip' }] };
  const payload = Buffer.from(JSON.stringify(metadata));
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  const catalog = new ModuleCatalog({ userRoot });
  catalog.updateHostConfig({ releaseChannel: { metadataUrl: 'https://publisher.invalid/stable.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), allowedDownloadOrigins: ['https://publisher.invalid'] } }, 0);
  let requests = 0;
  const updates = new ModuleUpdates(catalog, async input => {
    requests++;
    return new Response(String(input).endsWith('stable.json') ? JSON.stringify(envelope) : bytes);
  });
  await updates.check();
  const request = { operationId: 'synthetic-install', moduleId: 'assistant' as const, version: '1.0.0', sha256: digest };
  const result = await updates.install(request);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.sha256, digest);
  const installed = catalog.getInstalled('assistant')!;
  assert.equal(installed.digest, result.installedDigest);
  assert.equal(readFileSync(join(installed.release, 'role.md'), 'utf8'), 'SYNTHETIC_RELEASE_ROLE');
  assert.deepEqual(catalog.listBindings(), []);
  writeFileSync(join(catalog.dataDirectory('assistant'), 'user-memory.txt'), 'USER_OWNED_DATA');
  assert.deepEqual(await updates.install(request), result);
  assert.equal(readFileSync(join(catalog.dataDirectory('assistant'), 'user-memory.txt'), 'utf8'), 'USER_OWNED_DATA');
  assert.equal(existsSync(join(userRoot, 'module-updates/synthetic-install/runtime.zip')), false);
  assert.equal(existsSync(join(userRoot, 'module-updates/synthetic-install/operation.json')), true);
  assert.throws(() => catalog.installFromDirectory(source), /allowlisted/);
  await assert.rejects(updates.install({ ...request, operationId: 'wrong-hash', sha256: '0'.repeat(64) }), /exact target/);
  assert.deepEqual(updates.status(), [result]);
  const operationDirectory = join(userRoot, 'module-updates', request.operationId);
  writeFileSync(join(operationDirectory, 'runtime.zip'), bytes, { mode: 0o600 });
  const receipt = join(userRoot, 'module-updates/assistant.json');
  writeModuleRecord(receipt, { ...result, state: 'unknown', error: 'Synthetic lost final receipt' });
  const reconciled = await updates.reconcile({ moduleId: 'assistant', operationId: request.operationId, confirm: true });
  assert.equal(reconciled.state, 'succeeded');
  assert.equal(reconciled.installedDigest, installed.digest);
  assert.equal(requests, 2, 'Reconciliation never downloads or replays installation');
  assert.equal(readFileSync(join(catalog.dataDirectory('assistant'), 'user-memory.txt'), 'utf8'), 'USER_OWNED_DATA');
  catalog.uninstall('assistant');
  writeModuleRecord(receipt, { ...result, state: 'unknown' });
  writeFileSync(join(operationDirectory, 'runtime.zip'), 'corrupted archive');
  await assert.rejects(updates.reconcile({ moduleId: 'assistant', operationId: request.operationId, confirm: true }), /originally verified release/);
  assert.equal(updates.status()[0]?.state, 'unknown');
  writeFileSync(join(operationDirectory, 'runtime.zip'), bytes);
  const unselected = await updates.reconcile({ moduleId: 'assistant', operationId: request.operationId, confirm: true });
  assert.equal(unselected.state, 'failed');
  assert.match(unselected.error!, /retained but not selected/);
  assert.equal(catalog.getInstalled('assistant'), undefined, 'Reconciliation does not change the selected/disabled state');
  assert.equal(requests, 2);
  const later = { ...result, operationId: 'later-installation', state: 'succeeded', updatedAt: Date.now() };
  writeModuleRecord(receipt, later);
  assert.deepEqual(await updates.install(request), unselected, 'An older operation remains readback-only after later work');
  assert.equal(requests, 2);
  assert.equal(catalog.getInstalled('assistant'), undefined, 'Historical readback never changes version selection');
});

test('explicit reconciliation confirms an absent target but never steals an in-flight install lock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-install-reconcile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ModuleCatalog({ userRoot: root });
  const updates = new ModuleUpdates(catalog, async () => { throw new Error('No transport during reconciliation'); });
  const receipt = { moduleId: 'task', operationId: 'interrupted-install-0001', version: '1.2.0',
    sha256: 'a'.repeat(64), state: 'installing', updatedAt: 1 };
  writeModuleRecord(join(root, 'module-updates/task.json'), receipt);
  writeFileSync(join(root, 'module-updates/task.lock'), 'Existing claim', { mode: 0o600 });
  const input = { moduleId: 'task' as const, operationId: receipt.operationId, confirm: true as const };
  await assert.rejects(updates.reconcile(input), /EEXIST/);
  assert.equal(updates.status()[0]?.state, 'unknown');
  rmSync(join(root, 'module-updates/task.lock'));
  const result = await updates.reconcile(input);
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /not installed/);
  assert.deepEqual(catalog.list(), []);
});
