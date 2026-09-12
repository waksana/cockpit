import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { inventory } from '../.delivery/toolkit/lib/artifact.mjs';
import { bootstrapFiles, packageConsumerRelease } from './package-consumer-release.mjs';
import { check, download, initialize, callLauncher, consumerRootFromEnvironment, reconcileDownload } from './consumer/cli.mjs';
import { ConsumerLauncher, serve } from './consumer/launcher.mjs';
import { freshDirectory, loadAuthority, readJson, rejectPrivateAuthority, writeJson } from './consumer/state.mjs';
import { verifyConsumerMetadata } from './consumer/channel.mjs';
import { validateRelease } from './consumer/archive.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
process.env.TSX_DISABLE_CACHE = '1';
// This isolated test process is not a private-CD installation; do not inherit its launcher provenance.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SERVICE_DELIVERY_') || key.startsWith('COCKPIT_CONSUMER_')
    || ['COCKPIT_DELIVERY_VIEWER_CREDENTIAL', 'COCKPIT_API_TOKEN', 'WORK_GATEWAY_URL'].includes(key)) delete process.env[key];
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Fixture timed out waiting for authoritative receipt');
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const program = `
import { createServer } from 'node:http';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryIdentity as identity } from './delivery-identity.ts';
import { connectConsumerLifecycle, restartConsumer } from '../../../scripts/consumer/cli.mjs';
let pending=false, exiting=false;
const root=process.env.COCKPIT_USER_ROOT;
const busy=()=>existsSync(join(root,'data/busy'));
const server=createServer(async (req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/version') return res.end(JSON.stringify(identity));
  if(req.url==='/health') return res.end(JSON.stringify({ok:!existsSync(join(root,'data','unhealthy-'+identity.version)),instanceId:identity.instanceId}));
  if(req.method==='POST'&&['/fixture/restart','/admin/restart'].includes(req.url)) {
    appendFileSync(join(root,'data/public-restart-requests'),'public\\n');
    let body='';for await(const chunk of req) body+=chunk;
    try{return res.end(JSON.stringify(await restartConsumer(JSON.parse(body).operationId)));}
    catch(error){res.statusCode=409;return res.end(JSON.stringify({error:error.message}));}
  }
  if(req.method==='POST'&&req.url==='/fixture/crash') {
    res.end('{}');setTimeout(()=>process.exit(23),20);return;
  }
  if(req.method==='POST'&&req.url==='/fixture/exit') {
    res.end('{}');setImmediate(()=>server.close(()=>process.exit(0)));return;
  }
  res.statusCode=404;res.end('{}');
});
await connectConsumerLifecycle(()=>{
  appendFileSync(join(root,'data/drain-requests'),'request\\n');
  if(existsSync(join(root,'data/drop-drain-response'))) throw new Error('Fixture native drain acknowledgement is unknown');
  pending=true;
});
server.listen(Number(process.env.COCKPIT_PORT),'127.0.0.1');
process.on('SIGTERM',()=>{pending=true;});
process.on('SIGINT',()=>{pending=true;});
setInterval(()=>{
  if(!pending||busy()||exiting)return;
  pending=false;exiting=true;
  server.close(()=>process.exit(0));
},20);
`;

async function fixture(t) {
  const directory = await mkdtemp(join(repo, '.consumer-'));
  let initialized = false;
  t.after(() => initialized ? undefined : rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'install'), userRoot = join(directory, 'user');
  const keys = generateKeyPairSync('ed25519');
  const channel = { metadataUrl: 'https://publisher.invalid/stable.json',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    allowedDownloadOrigins: ['https://publisher.invalid'] };
  const previousHome = process.env.COCKPIT_HOME;
  process.env.COCKPIT_HOME = join(directory, 'native');
  try { initialize({ root, userRoot, channel, port: await freePort() }); }
  finally {
    if (previousHome === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = previousHome;
  }
  await mkdir(join(userRoot, 'data'), { mode: 0o700 });
  const keyFile = join(directory, 'fixture-signing-key');
  await writeFile(keyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const fixture = { directory, root, userRoot, channel, keyFile, launcher: null };
  initialized = true;
  t.after(async () => {
    await rm(join(userRoot, 'data/busy'), { force: true });
    await rm(join(userRoot, 'data/drop-drain-response'), { force: true });
    const launcher = fixture.launcher;
    if (launcher?.inFlight) await until(() => !launcher.inFlight);
    if (launcher?.child) {
      const child = launcher.child;
      await fetch(launcher.endpoint('/fixture/exit'), { method: 'POST' });
      await child.exited;
    }
    if (launcher?.server?.listening) {
      launcher.active = null;
      await launcher.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

async function build(f, version, sequence, compatibility = 'cockpit-core-user-root-v2') {
  const source = join(f.directory, `source-${version}`);
  const files = {
    'consumer-runtime.json': JSON.stringify({ schemaVersion: 2, dataCompatibility: compatibility,
      automaticDataMigrations: false, mainLifecycleApi: 1 }),
    'apps/server/src/index.ts': program,
    'apps/server/src/delivery-identity.ts': await readFile(join(repo, 'apps/server/src/delivery-identity.ts')),
    'apps/server/package.json': JSON.stringify({ type: 'module', version }),
    'apps/server/node_modules/tsx/package.json': '{"type":"module","exports":"./index.mjs"}',
    'apps/server/node_modules/tsx/index.mjs': '// Fixture only: Node24 directly strips the simple fixture TypeScript.',
    'apps/web/dist/index.html': '<html>consumer fixture</html>',
    [`apps/web/dist/assets/app-${version}.js`]: `console.log('${version}');`,
    'packages/core/src/index.ts': 'export {};',
    'packages/protocol/src/index.ts': 'export {};',
    'node_modules/thread-stream/test/dir with spaces/data.txt': 'ordinary dependency data',
    'scripts/consumer/artifact.mjs': await readFile(join(repo, 'scripts/consumer/artifact.mjs')),
    'scripts/consumer/release-transport.mjs': await readFile(join(repo, 'scripts/consumer/release-transport.mjs')),
  };
  for (const path of Object.values(bootstrapFiles)) files[path] = await readFile(join(repo, path), 'utf8');
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), body);
  }
  const sourceSha = String(sequence).repeat(40);
  await writeFile(join(source, 'delivery-manifest.json'), JSON.stringify({ format: 1, sourceSha,
    configSha256: 'e'.repeat(64), requestId: 'fixture-release', node: process.versions.node,
    platform: process.platform, arch: process.arch, files: await inventory(source) }));
  const runtime = join(f.directory, `runtime-${version}.tar.gz`);
  execFileSync('tar', ['-czf', runtime, '-C', source, '.']);
  const metadataFile = join(f.directory, `spec-${version}.json`);
  await writeFile(metadataFile, JSON.stringify({ schemaVersion: 2, channel: 'stable', sequence, version, sourceSha,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    url: `https://publisher.invalid/${version}.zip` }));
  const published = await packageConsumerRelease({ runtime, metadataFile, keyFile: f.keyFile,
    output: join(f.directory, `published-${version}`) });
  const envelope = JSON.parse(await readFile(published.envelope, 'utf8'));
  const archive = await readFile(published.archive);
  const fetchImpl = async url => new Response(String(url).endsWith('stable.json') ? JSON.stringify(envelope) : archive);
  await check(f.root, `check-${version}`, fetchImpl);
  const downloaded = await download(f.root, `download-${version}`, `check-${version}`, version, fetchImpl);
  assert.equal(downloaded.state, 'downloaded');
  return { ...published, envelope };
}

function receipt(f, id) { return readJson(join(f.root, 'operations', `${id}.json`)); }
async function install(f, version) {
  const id = `install-${version}`;
  const result = await callLauncher(f.root, { action: 'install', operationId: id, downloadId: `download-${version}` });
  assert.equal(result.operationId, id);
  return id;
}

test('signed activation drains native work and retains immutable releases, assets and unrelated data', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  const oldIdentity = receipt(f, first).observed, oldSelection = f.launcher.selection();
  assert.equal((await callLauncher(f.root, { action: 'status' })).mainLifecycle.ready, true);
  assert.equal('moduleRunner' in await callLauncher(f.root, { action: 'status' }), false);
  assert.equal(existsSync(join(f.root, 'launcher/module-runner.mjs')), false);
  assert.equal(existsSync(join(f.userRoot, 'modules')), false);
  await writeFile(join(f.userRoot, 'data/business-state'), 'do not roll this back');
  await writeFile(join(f.userRoot, 'data/busy'), 'native busy fixture');
  await build(f, '1.2.4', 2);
  const second = await install(f, '1.2.4');
  await until(() => receipt(f, second).drainAcknowledged);
  assert.equal(receipt(f, second).state, 'waiting-idle');
  assert.equal(f.launcher.child.identity.instanceId, oldIdentity.instanceId);
  assert.deepEqual(f.launcher.selection(), oldSelection);
  assert.equal((await callLauncher(f.root, { action: 'install', operationId: second, downloadId: 'download-1.2.4' })).state, 'waiting-idle');
  await assert.rejects(callLauncher(f.root, { action: 'install', operationId: 'competing-install', downloadId: 'download-1.2.3' }), /operation|sequence/i);
  await rm(join(f.userRoot, 'data/busy'));
  await until(() => receipt(f, second).state === 'succeeded');
  assert.notEqual(receipt(f, second).observed.instanceId, oldIdentity.instanceId);
  assert.equal(receipt(f, second).observed.artifactSha256, f.launcher.selection().target.sha256);
  assert.equal(receipt(f, second).nativeDrainReply.instanceId, oldIdentity.instanceId);
  assert.equal(existsSync(join(f.userRoot, 'data/public-restart-requests')), false);
  assert.ok(existsSync(oldSelection.release));
  assert.ok(existsSync(join(f.root, 'assets/app-1.2.3.js')));
  assert.equal(await readFile(join(f.userRoot, 'data/business-state'), 'utf8'), 'do not roll this back');
  await callLauncher(f.root, { action: 'stop', operationId: 'fixture-safe-stop' });
  await until(() => receipt(f, 'fixture-safe-stop').state === 'stopped');
  await until(() => !f.launcher.server.listening);
  assert.equal(f.launcher.child, null);
});

test('unhealthy live candidate remains owned; explicit safe drain then compatible known-good code fallback never rolls data back', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  await build(f, '1.2.4', 2);
  await writeFile(join(f.userRoot, 'data/unhealthy-1.2.4'), 'fixture');
  await writeFile(join(f.userRoot, 'data/business-state'), 'new live data remains');
  f.launcher.healthTimeout = 1500;
  const second = await install(f, '1.2.4');
  await until(() => receipt(f, second).state === 'unknown' && !f.launcher.inFlight);
  const candidate = f.launcher.child;
  assert.ok(candidate, 'unhealthy process was not killed');
  await until(() => f.launcher.version(candidate.identity, false).then(() => true, () => false));
  await callLauncher(f.root, { action: 'recover', operationId: second, recovery: 'fallback' });
  await until(() => !f.launcher.inFlight);
  assert.equal(f.launcher.child, candidate, 'fallback must refuse a live candidate');
  assert.match(receipt(f, second).error, /still alive/);
  await callLauncher(f.root, { action: 'recover', operationId: second, recovery: 'drain' });
  await until(() => receipt(f, second).candidateExited && !f.launcher.inFlight);
  assert.equal(f.launcher.child, null);
  f.launcher.healthTimeout = 5000;
  await callLauncher(f.root, { action: 'recover', operationId: second, recovery: 'fallback' });
  await until(() => receipt(f, second).state === 'recovered');
  assert.equal(f.launcher.selection().target.version, '1.2.3');
  assert.equal(f.launcher.runtime().identity.version, '1.2.3');
  assert.equal(await readFile(join(f.userRoot, 'data/business-state'), 'utf8'), 'new live data remains');
});

test('consumer refuses nonempty roots, competing selectors, another launcher and incompatible data before draining', async t => {
  const f = await fixture(t);
  assert.throws(() => initialize({ root: f.root, userRoot: f.userRoot, channel: f.channel }), /nonempty/);
  assert.throws(() => rejectPrivateAuthority({ SERVICE_DELIVERY_SHA: 'a'.repeat(40) }), /Private CD/);
  await writeFile(join(f.root, 'current'), 'competing authority');
  assert.throws(() => loadAuthority(f.root), /Competing/);
  await rm(join(f.root, 'current'));
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  await assert.rejects(serve(f.root), /Existing control socket/);
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  const oldChild = f.launcher.child;
  await build(f, '1.2.4', 2, 'incompatible-v2');
  const second = await install(f, '1.2.4');
  await until(() => receipt(f, second).state === 'failed');
  assert.match(receipt(f, second).error, /compatibility/);
  assert.equal(f.launcher.child, oldChild);
  assert.equal(receipt(f, second).drainRequested, undefined);
  assert.throws(() => f.launcher.checkCompatibility({ ...f.launcher.selection(), mainLifecycleApi: 2 }), /API1/);
  assert.throws(() => f.launcher.checkCompatibility({ ...f.launcher.selection(), mainLifecycleApi: undefined }), /lifecycle API1/);
  const source = join(f.directory, 'source-1.2.4');
  writeJson(join(source, 'consumer-runtime.json'), { schemaVersion: 2, automaticDataMigrations: false,
    dataCompatibility: 'cockpit-core-user-root-v2', mainLifecycleApi: 2 });
  const manifestPath = join(source, 'delivery-manifest.json'), manifest = readJson(manifestPath);
  await rm(manifestPath);
  writeJson(manifestPath, { ...manifest, files: await inventory(source) });
  await assert.rejects(validateRelease(source, receipt(f, 'download-1.2.4').target), /lifecycle API1/);
  assert.equal(f.launcher.child, oldChild);
});

test('consumer metadata uses a distinct main target and rejects wrong publisher or sequence', async t => {
  const f = await fixture(t);
  const published = await build(f, '1.2.3', 1);
  assert.equal(verifyConsumerMetadata(published.envelope, f.channel).targets[0].product, 'cockpit');
  assert.throws(() => verifyConsumerMetadata(published.envelope, f.channel, 2), /sequence/);
  const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => verifyConsumerMetadata(published.envelope, { ...f.channel, publicKey: wrongKey }), /signature/);
  const downloadPath = join(f.root, 'operations/download-1.2.3.json');
  const original = readJson(downloadPath);
  writeJson(downloadPath, { ...original, state: 'failed', error: 'Synthetic receipt interruption after verified bytes' });
  assert.equal((await reconcileDownload(f.root, 'download-1.2.3')).state, 'downloaded');
  writeJson(downloadPath, { ...original, state: 'downloading' });
  await assert.rejects(reconcileDownload(f.root, 'download-1.2.3'), /still be alive/);
});

test('uncertain original drain is never retried or hidden by candidate recovery', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  const oldChild = f.launcher.child;
  await build(f, '1.2.4', 2);
  await writeFile(join(f.userRoot, 'data/drop-drain-response'), 'fixture');
  const second = await install(f, '1.2.4');
  await until(() => receipt(f, second).state === 'unknown' && !f.launcher.inFlight);
  assert.equal(f.launcher.child, oldChild);
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
  await callLauncher(f.root, { action: 'recover', operationId: second, recovery: 'drain' });
  await until(() => !f.launcher.inFlight);
  assert.match(receipt(f, second).error, /cannot replay/);
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
});

test('fresh directory preflight rejects symlink ancestors before writing either installation root', async t => {
  const f = await fixture(t);
  const target = join(f.directory, 'untouched-target'), link = join(f.directory, 'linked-ancestor');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  assert.throws(() => freshDirectory(join(link, 'missing/leaf')), /canonical|symbolic/);
  assert.deepEqual(await readdir(target), [], 'no recursive mkdir followed the symlink before rejection');
  const installRoot = join(f.directory, 'must-not-be-created');
  assert.throws(() => initialize({ root: installRoot, userRoot: join(link, 'missing/user'), channel: f.channel }), /canonical|symbolic/);
  assert.equal(existsSync(installRoot), false, 'both roots are preflighted before the first mkdir');
  assert.deepEqual(await readdir(target), []);
  const dangling = join(f.directory, 'dangling');
  await symlink(join(f.directory, 'absent-target'), dangling);
  assert.throws(() => freshDirectory(join(dangling, 'leaf')), /canonical|symbolic/);
  assert.equal(existsSync(join(f.directory, 'absent-target')), false);
});

test('core-only launcher rejects older authority without reading or replacing its runtime and data', async t => {
  const f = await fixture(t);
  const authority = loadAuthority(f.root);
  writeJson(join(f.root, 'authority.json'), { ...authority, schemaVersion: 1 });
  writeJson(join(f.root, 'runtime.json'), { state: 'unknown', originalOperationId: 'retained-original' });
  const retained = join(f.userRoot, 'data/keep.json');
  await writeFile(retained, '{"state":"unknown","resend":false}');
  assert.throws(() => loadAuthority(f.root), /authority v2 required/);
  assert.throws(() => new ConsumerLauncher(f.root), /authority v2 required/);
  assert.deepEqual(readJson(join(f.root, 'runtime.json')), { state: 'unknown', originalOperationId: 'retained-original' });
  assert.equal(await readFile(retained, 'utf8'), '{"state":"unknown","resend":false}');
  assert.equal(existsSync(join(f.root, 'launcher.lock')), false);
});

test('consumer sequence floor binds signed envelope, rejects equivocation at check/download/activation, and preserves readback', async t => {
  const f = await fixture(t);
  const original = await build(f, '1.2.3', 1);
  const floorPath = join(f.root, 'sequence.json');
  const floor = readJson(floorPath);
  assert.equal(floor.digest, createHash('sha256').update(JSON.stringify(original.envelope)).digest('hex'));
  const again = await check(f.root, 'check-original-again', async () => new Response(JSON.stringify(original.envelope)));
  assert.equal(again.state, 'checked');
  assert.deepEqual(readJson(floorPath), floor);
  assert.deepEqual(await check(f.root, 'check-original-again', async () => { throw new Error('must not fetch on readback'); }), again);
  assert.equal((await download(f.root, 'download-1.2.3', 'check-1.2.3', '1.2.3',
    async () => { throw new Error('must not download twice'); })).state, 'downloaded');

  const metadata = JSON.parse(Buffer.from(original.envelope.payload, 'base64').toString());
  const key = createPrivateKey(await readFile(f.keyFile));
  const signed = value => {
    const payload = Buffer.from(JSON.stringify(value));
    return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
  };
  const forkedMetadata = { ...metadata, expiresAt: new Date(Date.now() + 180_000).toISOString() };
  const fork = signed(forkedMetadata);
  await assert.rejects(check(f.root, 'check-equivocation', async () => new Response(JSON.stringify(fork))), /reused a release sequence/);
  assert.deepEqual(readJson(floorPath), floor, 'rejected counter fork cannot replace the accepted digest');
  writeJson(join(f.root, 'checks/check-fork-cache.json'),
    { checkId: 'check-fork-cache', state: 'checked', envelope: fork, metadata: forkedMetadata }, true);
  await assert.rejects(download(f.root, 'download-fork-attempt', 'check-fork-cache', '1.2.3',
    async () => { throw new Error('unauthorized fork must never reach transport'); }), /reused a release sequence/);
  assert.equal(existsSync(join(f.root, 'downloads/download-fork-attempt.zip')), false);

  const originalDownload = receipt(f, 'download-1.2.3');
  writeJson(join(f.root, 'operations/download-fork-cache.json'),
    { ...originalDownload, operationId: 'download-fork-cache', envelope: fork }, true);
  const launcher = new ConsumerLauncher(f.root);
  assert.throws(() => launcher.acceptInstall({ operationId: 'install-fork-attempt', downloadId: 'download-fork-cache' }), /reused a release sequence/);
  assert.equal(existsSync(join(f.root, 'active.json')), false);
  launcher.verifyInstallAuthorization(originalDownload);

  const higher = signed({ ...metadata, sequence: 2 });
  await check(f.root, 'check-higher-counter', async () => new Response(JSON.stringify(higher)));
  await assert.rejects(download(f.root, 'download-stale-attempt', 'check-1.2.3', '1.2.3'), /sequence floor/);
  assert.throws(() => launcher.verifyInstallAuthorization(originalDownload), /sequence floor/);
  assert.throws(() => launcher.verifyInstallAuthorization({ ...originalDownload, envelope: fork }), /sequence floor/);
  assert.equal((await download(f.root, 'download-1.2.3', 'check-1.2.3', '1.2.3')).state, 'downloaded',
    'retained receipt readback is not a new authorization to activate old metadata');
});

test('public backend restart and CLI share one operation, drain once over owned IPC and verify a fresh instance', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  const selection = f.launcher.selection(), oldIdentity = f.launcher.child.identity;
  const authority = loadAuthority(f.root);
  const env = { COCKPIT_CONSUMER_ROOT: f.root, COCKPIT_CONSUMER_INSTALLATION: authority.installationId,
    COCKPIT_USER_ROOT: f.userRoot };
  assert.equal(consumerRootFromEnvironment(env), f.root);
  assert.throws(() => consumerRootFromEnvironment({ ...env, COCKPIT_CONSUMER_INSTALLATION: randomUUID() }), /does not match/);
  assert.throws(() => consumerRootFromEnvironment({ ...env, COCKPIT_USER_ROOT: f.root }), /does not match/);
  assert.throws(() => consumerRootFromEnvironment({ ...env, SERVICE_DELIVERY_SHA: 'a'.repeat(40) }), /Private CD/);
  assert.throws(() => f.launcher.handle({ action: 'restart', operationId: 'wrong-installation', installationId: randomUUID() }), /identity mismatch/);
  assert.equal(existsSync(join(f.root, 'operations/wrong-installation.json')), false);

  await writeFile(join(f.userRoot, 'data/busy'), 'busy native fixture');
  const operationId = 'restart-from-backend';
  const response = await fetch(f.launcher.endpoint('/admin/restart'), { method: 'POST',
    body: JSON.stringify({ operationId, root: '/untrusted-client-supplied-root-is-ignored' }), signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).operationId, operationId);
  await until(() => receipt(f, operationId).drainAcknowledged);
  assert.equal(f.launcher.child.identity.instanceId, oldIdentity.instanceId);
  assert.deepEqual(f.launcher.selection(), selection);
  await callLauncher(f.root, { action: 'restart', operationId });
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
  await rm(join(f.userRoot, 'data/busy'));
  await until(() => receipt(f, operationId).state === 'succeeded');
  const result = receipt(f, operationId);
  assert.notEqual(result.observed.instanceId, oldIdentity.instanceId);
  assert.equal(result.observed.requestId, operationId);
  assert.equal(result.observed.artifactSha256, oldIdentity.artifactSha256);
  assert.equal(result.observed.sha, oldIdentity.sha);
  assert.deepEqual(f.launcher.selection(), selection);
  assert.equal(f.launcher.server.listening, true);
  assert.equal((await callLauncher(f.root, { action: 'status' })).health.state, 'healthy');
  assert.deepEqual(await callLauncher(f.root, { action: 'restart', operationId }), result);
  const reread = await fetch(f.launcher.endpoint('/admin/restart'), { method: 'POST', body: JSON.stringify({ operationId }) });
  assert.deepEqual(await reread.json(), result, 'public HTTP and CLI read the same retained operation without another native drain');
  assert.equal(await readFile(join(f.userRoot, 'data/public-restart-requests'), 'utf8'), 'public\npublic\n');
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');

  await fetch(f.launcher.endpoint('/fixture/crash'), { method: 'POST' });
  await until(() => f.launcher.child === null);
  await sleep(100);
  assert.equal(f.launcher.child, null, 'a later crash is not an automatic restart request');
  assert.equal(f.launcher.server.listening, true);
  await assert.rejects(callLauncher(f.root, { action: 'restart', operationId: 'restart-after-crash' }), /already owned/);
});

test('unknown restart acknowledgement and abnormal drain exit retain original ID without replay or crash respawn', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  const oldChild = f.launcher.child;
  await writeFile(join(f.userRoot, 'data/drop-drain-response'), 'unknown mutation fixture');
  const operationId = 'restart-unknown-ack';
  await callLauncher(f.root, { action: 'restart', operationId });
  await until(() => receipt(f, operationId).state === 'unknown' && !f.launcher.inFlight);
  const result = receipt(f, operationId);
  assert.deepEqual(await callLauncher(f.root, { action: 'restart', operationId }), result);
  assert.equal(f.launcher.child, oldChild);
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
  await assert.rejects(callLauncher(f.root, { action: 'restart', operationId: 'restart-new-id-must-not-hide-unknown' }), /Another operation/);
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'drain' });
  await until(() => !f.launcher.inFlight);
  assert.match(receipt(f, operationId).error, /cannot replay/);
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
  const beforeUnsupported = receipt(f, operationId);
  await assert.rejects(callLauncher(f.root, { action: 'recover', operationId, recovery: 'continue' }), /Recovery is/);
  assert.deepEqual(receipt(f, operationId), beforeUnsupported);
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
});

test('restart refuses automatic replacement when its draining child crashes instead of exiting cleanly', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  await writeFile(join(f.userRoot, 'data/busy'), 'keep native drain pending');
  const operationId = 'restart-crashed-drain';
  await callLauncher(f.root, { action: 'restart', operationId });
  await until(() => receipt(f, operationId).drainAcknowledged);
  await fetch(f.launcher.endpoint('/fixture/crash'), { method: 'POST' });
  await until(() => receipt(f, operationId).state === 'unknown' && !f.launcher.inFlight);
  assert.equal(receipt(f, operationId).oldExit.code, 23);
  assert.equal(f.launcher.child, null);
  assert.match(receipt(f, operationId).error, /no automatic crash respawn/);
  assert.equal((await callLauncher(f.root, { action: 'restart', operationId })).state, 'unknown');
  assert.equal(f.launcher.server.listening, true);
});

test('a stable GitHub discovery URL finds new signed main sequences without trusting the list or relaxing counter/signature checks', async t => {
  const f = await fixture(t);
  const tokenFile = join(f.directory, 'fixture-github-read-token');
  await writeFile(tokenFile, 'fixture-consumer-github-read', { mode: 0o600 });
  const channel = { ...f.channel, metadataUrl: 'https://api.github.com/repos/fixture/project/releases/latest',
    metadataAssetName: 'stable.signed.json', tokenFile,
    allowedDownloadOrigins: ['https://api.github.com', 'https://release-assets.githubusercontent.com'] };
  writeJson(join(f.userRoot, 'consumer-config.json'), { channel });
  const privateKey = createPrivateKey(await readFile(f.keyFile));
  const metadata = sequence => ({ schemaVersion: 2, channel: 'stable', sequence,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    targets: [{ product: 'cockpit', version: `1.0.${sequence}`, platform: 'linux', arch: 'x64', nodeMajor: 24,
      sourceSha: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 1,
      url: 'https://api.github.com/repos/fixture/project/releases/assets/99' }] });
  const signed = (value, key = privateKey) => {
    const payload = Buffer.from(JSON.stringify(value));
    return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
  };
  let assetId = 21, envelope = signed(metadata(1));
  const seen = [];
  const transport = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers);
    seen.push({ url: url.href, accept: headers.get('accept'), bearer: headers.get('authorization') });
    if (url.href === channel.metadataUrl) return new Response(JSON.stringify({
      id: 10, url: 'https://api.github.com/repos/fixture/project/releases/10',
      tag_name: 'v1', draft: false, prerelease: false,
      assets: [{ id: assetId, url: `https://api.github.com/repos/fixture/project/releases/assets/${assetId}`,
        name: channel.metadataAssetName, state: 'uploaded', size: JSON.stringify(envelope).length }],
    }));
    if (url.origin === 'https://api.github.com') {
      assert.equal(url.href, `https://api.github.com/repos/fixture/project/releases/assets/${assetId}`);
      return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/fixture/${assetId}` } });
    }
    return new Response(JSON.stringify(envelope));
  };
  assert.equal((await check(f.root, 'github-main-check-1', transport)).metadata.sequence, 1);
  assetId = 22; envelope = signed(metadata(2));
  assert.equal((await check(f.root, 'github-main-check-2', transport)).metadata.targets[0].version, '1.0.2');
  assert.deepEqual(seen.slice(0, 6).map(request => request.accept),
    ['application/vnd.github+json', 'application/octet-stream', 'application/octet-stream',
      'application/vnd.github+json', 'application/octet-stream', 'application/octet-stream']);
  assert.ok(seen.filter(request => request.url.startsWith('https://api.github.com'))
    .every(request => request.bearer === 'Bearer fixture-consumer-github-read'));
  assert.ok(seen.filter(request => request.url.startsWith('https://release-assets.githubusercontent.com'))
    .every(request => request.bearer === null));
  const floor = readJson(join(f.root, 'sequence.json'));
  assetId = 23; envelope = signed(metadata(1));
  await assert.rejects(check(f.root, 'github-main-stale', transport), /sequence floor/);
  envelope = signed({ ...metadata(2), targets: [] });
  await assert.rejects(check(f.root, 'github-main-equivocation', transport), /reused a release sequence/);
  envelope = signed(metadata(3), generateKeyPairSync('ed25519').privateKey);
  await assert.rejects(check(f.root, 'github-main-wrong-key', transport), /signature/);
  envelope = signed({ ...metadata(3), expiresAt: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(check(f.root, 'github-main-expired', transport), /expired/);
  assert.deepEqual(readJson(join(f.root, 'sequence.json')), floor);
});
