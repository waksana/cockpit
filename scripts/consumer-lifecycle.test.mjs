import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { inventory } from '../.delivery/toolkit/lib/artifact.mjs';
import { bootstrapFiles, packageConsumerRelease } from './package-consumer-release.mjs';
import { check, download, initialize, callLauncher, consumerRootFromEnvironment, reconcileDownload } from './consumer/cli.mjs';
import { ConsumerLauncher, serve } from './consumer/launcher.mjs';
import { freshDirectory, loadAuthority, processIdentity, processStillExists, readJson, rejectPrivateAuthority, writeJson } from './consumer/state.mjs';
import { verifyConsumerMetadata } from './consumer/channel.mjs';
import { ConsumerModuleRunner, moduleServicePins, readModuleRunnerStatus } from './consumer/module-runner.mjs';
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
function moduleControl(f, id, action, operationId) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(f.userRoot, '.module-runner.sock'));
    let text = '';
    socket.on('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'control', command: { id, action, operationId } })}\n`));
    socket.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      socket.destroy();
      const response = JSON.parse(text.slice(0, text.indexOf('\n')));
      if (response.ok) resolve(response.result); else reject(new Error(response.error));
    });
  });
}
async function configureFixtureService(f, id, { enabled = true, activationEnabled = true, ownership = 'managed' } = {}) {
  await mkdir(join(f.userRoot, 'modules', id), { recursive: true, mode: 0o700 });
  writeJson(join(f.userRoot, 'modules', id, 'state.json'), { schemaVersion: 1, enabled, selectedVersion: '1.0.0' });
  writeJson(join(f.userRoot, 'module-config', `${id}.json`), { schemaVersion: 1, configVersion: 1, revision: 1,
    values: { ownership, activationEnabled } });
}
const program = `
import { createServer } from 'node:http';
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryIdentity as identity } from './delivery-identity.ts';
import { connectConsumerLifecycle, prepareConsumerExit, restartConsumer } from '../../../scripts/consumer/cli.mjs';
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
  prepareConsumerExit().then(()=>server.close(()=>process.exit(0))).catch(error=>{
    appendFileSync(join(root,'data/exit-error'),error.message+'\\n');exiting=false;
  });
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
  const keyFile = join(directory, 'fixture-signing-key');
  await writeFile(keyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const fixture = { directory, root, userRoot, channel, keyFile, launcher: null, ownedRunners: [] };
  initialized = true;
  t.after(async () => {
    await rm(join(userRoot, 'data/busy'), { force: true });
    await rm(join(userRoot, 'data/drop-drain-response'), { force: true });
    await rm(join(userRoot, 'data/fixture-runner-busy-job'), { force: true });
    await rm(join(userRoot, 'data/fixture-runner-refuse'), { force: true });
    await rm(join(userRoot, 'data/fixture-module-busy'), { force: true });
    await rm(join(userRoot, 'data/fixture-delay-restore-ack'), { force: true });
    await rm(join(userRoot, 'data/fixture-delay-drain-ack'), { force: true });
    await rm(join(userRoot, 'data/fixture-unknown-restored-ack'), { force: true });
    await rm(join(userRoot, 'data/fixture-race-module-start'), { force: true });
    const launcher = fixture.launcher;
    if (launcher?.inFlight) await until(() => !launcher.inFlight);
    if (launcher?.moduleRunner?.record()?.restore?.state === 'unknown'
      && launcher.moduleRunner.record().restore.error?.includes('acknowledgement unknown')) {
      await until(() => launcher.moduleRunner.record().restore?.state === 'restored');
    }
    if (launcher?.moduleRunner?.child) await launcher.moduleRunner.drainAndStop('fixture-cleanup');
    if (launcher?.child) {
      const child = launcher.child;
      await fetch(launcher.endpoint('/fixture/exit'), { method: 'POST' });
      await child.exited;
    }
    if (launcher?.server?.listening) {
      launcher.active = null;
      await launcher.close();
    }
    for (const runner of [...fixture.ownedRunners].reverse()) {
      if (existsSync(join(userRoot, 'data/task/fixture-control.json'))) {
        await writeFile(join(userRoot, 'data/task/fixture-control.json'), '{}', { mode: 0o600 });
      }
      if (runner.child) {
        if (['accepted', 'stopped'].includes(runner.record().shutdown?.state)) await runner.child.exited;
        else await runner.drainAndStop('real-core-fixture-cleanup');
      }
      runner.assertStopped();
    }
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

async function build(f, version, sequence, compatibility = 'cockpit-user-root-v1') {
  const source = join(f.directory, `source-${version}`);
  const files = {
    'consumer-runtime.json': JSON.stringify({ schemaVersion: 1, dataCompatibility: compatibility,
      automaticDataMigrations: false, moduleRunnerApi: 1, moduleRunnerLifecycleApi: 1 }),
    'packages/core/src/modules/supervisor-entry.ts': await readFile(join(repo, 'scripts/fixtures/consumer-module-runner.mjs')),
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
  await writeFile(metadataFile, JSON.stringify({ schemaVersion: 1, channel: 'stable', sequence, version, sourceSha,
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

test('signed activation restores only owned running pins, not role defaults or installed activation permission', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  await configureFixtureService(f, 'wechat');
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  const oldIdentity = receipt(f, first).observed;
  assert.equal(oldIdentity.authority, 'consumer');
  const oldSelection = f.launcher.selection();
  assert.equal(f.launcher.runtime().identity.instanceId, oldIdentity.instanceId);
  assert.equal((await callLauncher(f.root, { action: 'status' })).health.state, 'healthy');
  assert.equal((await callLauncher(f.root, { action: 'status' })).mainLifecycle.ready, true);
  assert.ok(existsSync(join(f.root, 'launcher/cli.mjs')));
  assert.equal(readJson(join(f.root, 'authority.json')).nativeHome, join(f.directory, 'native'));
  const runner = (await callLauncher(f.root, { action: 'status' })).moduleRunner;
  assert.equal(runner.state, 'ready');
  assert.equal(runner.record.selection.target.version, '1.2.3');
  assert.equal(runner.record.selection.release, oldSelection.release);
  await assert.rejects(f.launcher.moduleRunner.ensure(oldSelection, 'must-not-reuse-runner'), /never reuse/);
  assert.ok(runner.modules.every(value => value.status === 'stopped' && !value.owned && !value.job), 'main installation never starts module business services');
  const launch = readJson(join(f.userRoot, 'data/fixture-runner-launch.json'));
  assert.equal(launch.root, f.userRoot);
  assert.equal(launch.cockpitUrl, f.launcher.endpoint(''));
  await configureFixtureService(f, 'task');
  const moduleConfig = await readFile(join(f.userRoot, 'module-config/task.json'), 'utf8');
  await moduleControl(f, 'task', 'start', 'explicit-task-start');
  const task = await readModuleRunnerStatus(runner.record.socket, 'task');
  assert.equal(task.status, 'running');
  writeJson(join(f.userRoot, 'modules/task/state.json'), { schemaVersion: 1, enabled: true, selectedVersion: '2.0.0' });
  await writeFile(join(f.userRoot, 'data/fixture-runner-busy-job'), 'pending module operation');
  await callLauncher(f.root, { action: 'stop', operationId: 'refuse-live-module' });
  await until(() => receipt(f, 'refuse-live-module').state === 'failed');
  assert.equal(receipt(f, 'refuse-live-module').drainRequested, undefined, 'busy module refusal precedes any main drain');
  assert.equal(f.launcher.child.identity.instanceId, oldIdentity.instanceId);
  assert.equal(existsSync(join(f.root, 'module-resume.json')), false, 'a refused host drain cannot manufacture a restore plan');
  await rm(join(f.userRoot, 'data/fixture-runner-busy-job'));

  await writeFile(join(f.userRoot, 'data/business-state'), 'do not roll this back');
  await writeFile(join(f.userRoot, 'data/busy'), 'native busy fixture');
  await writeFile(join(f.userRoot, 'data/fixture-module-busy'), 'owned service busy fixture');
  await build(f, '1.2.4', 2);
  const second = await install(f, '1.2.4');
  await until(async () => (await readModuleRunnerStatus(runner.record.socket, 'task')).status === 'draining');
  await sleep(100);
  assert.equal(receipt(f, second).state, 'draining-modules');
  assert.equal(f.launcher.runtime().identity.instanceId, oldIdentity.instanceId);
  assert.equal(receipt(f, second).drainRequested, undefined, 'main cannot disappear while owned modules still need its API');
  assert.equal((await callLauncher(f.root, { action: 'status' })).health.state, 'healthy');
  assert.deepEqual(f.launcher.selection(), oldSelection);
  assert.equal((await callLauncher(f.root, { action: 'install', operationId: second, downloadId: 'download-1.2.4' })).state, 'draining-modules');
  await assert.rejects(moduleControl(f, 'wechat', 'start', 'start-during-main-drain'), /quiescing/);
  await assert.rejects(callLauncher(f.root, { action: 'install', operationId: 'competing-install', downloadId: 'download-1.2.3' }), /operation|sequence/i);
  await rm(join(f.userRoot, 'data/fixture-module-busy'));
  await until(() => receipt(f, second).state === 'waiting-idle');
  assert.equal(f.launcher.moduleRunner.child, null);
  assert.equal(f.launcher.moduleRunner.record().state, 'stopped');
  const captured = [{ id: 'task', version: task.identity.moduleVersion, digest: task.identity.moduleDigest }];
  assert.deepEqual(receipt(f, second).resumeServices, captured);
  assert.deepEqual(readJson(join(f.root, 'module-resume.json')).services, captured);
  assert.equal(readJson(join(f.root, 'module-resume.json')).operationId, second);
  assert.equal(processStillExists(runner.record.process), false);
  assert.deepEqual(readJson(join(f.userRoot, 'data/fixture-module-main-task.json')).identity, oldIdentity);
  assert.equal(f.launcher.child.identity.instanceId, oldIdentity.instanceId, 'native busy work also drains without forcing');
  await rm(join(f.userRoot, 'data/busy'));
  await until(() => receipt(f, second).state === 'succeeded');
  assert.notEqual(receipt(f, second).observed.instanceId, oldIdentity.instanceId);
  assert.equal(receipt(f, second).observed.artifactSha256, f.launcher.selection().target.sha256);
  assert.equal(receipt(f, second).nativeDrainReply.instanceId, oldIdentity.instanceId);
  assert.equal(receipt(f, second).nativeDrainReply.state, 'accepted');
  assert.equal(existsSync(join(f.userRoot, 'data/public-restart-requests')), false, 'launcher native drain never calls the public restart endpoint');
  assert.ok(existsSync(oldSelection.release), 'old immutable release retained');
  assert.ok(existsSync(join(f.root, 'assets/app-1.2.3.js')), 'old browser assets retained');
  assert.equal(await readFile(join(f.userRoot, 'data/business-state'), 'utf8'), 'do not roll this back');
  const afterUpdate = (await callLauncher(f.root, { action: 'status' })).moduleRunner;
  assert.notDeepEqual(afterUpdate.record.process, runner.record.process);
  assert.notEqual(afterUpdate.record.instanceId, runner.record.instanceId);
  assert.equal(afterUpdate.record.selection.target.version, '1.2.4');
  assert.equal(afterUpdate.record.selection.release, f.launcher.selection().release);
  const updatedTask = await readModuleRunnerStatus(runner.record.socket, 'task');
  assert.notEqual(updatedTask.pid, task.pid, 'module child exits with old main and is newly restored after update');
  assert.equal(updatedTask.identity.moduleVersion, task.identity.moduleVersion, 'main update must not silently apply a newer role-selection default');
  assert.equal(updatedTask.identity.moduleDigest, task.identity.moduleDigest);
  assert.equal((await readModuleRunnerStatus(runner.record.socket, 'wechat')).status, 'stopped', 'installed/eligible is not desired service startup');
  assert.deepEqual(afterUpdate.record.resumeServices, [{ id: 'task', version: task.identity.moduleVersion, digest: task.identity.moduleDigest }]);
  assert.equal(await readFile(join(f.userRoot, 'module-config/task.json'), 'utf8'), moduleConfig);
  const oldRunnerReceipt = readJson(join(f.root, 'module-runner-history', `${runner.record.generationId}.json`));
  assert.equal(oldRunnerReceipt.state, 'stopped');
  assert.equal(oldRunnerReceipt.shutdown.state, 'stopped');
  await callLauncher(f.root, { action: 'restart', operationId: 'restart-replaces-runner' });
  await until(() => receipt(f, 'restart-replaces-runner').state === 'succeeded');
  assert.notDeepEqual(f.launcher.moduleRunner.record().process, afterUpdate.record.process);
  assert.equal(processStillExists(afterUpdate.record.process), false);
  assert.notEqual((await readModuleRunnerStatus(runner.record.socket, 'task')).pid, updatedTask.pid, 'same-release restart also replaces modules and runner');
  const lockPath = join(f.userRoot, '.module-runner.lock'), lock = readJson(lockPath);
  writeJson(lockPath, { ...lock, instanceId: randomUUID() });
  assert.equal((await f.launcher.moduleRunner.status()).state, 'unknown', 'socket alone is not ownership proof');
  writeJson(lockPath, lock);
  await writeFile(join(f.userRoot, 'data/fixture-module-busy'), 'normal stop waits for active module service');
  await callLauncher(f.root, { action: 'stop', operationId: 'fixture-safe-stop' });
  await until(() => receipt(f, 'fixture-safe-stop').state === 'draining-modules');
  assert.ok(f.launcher.child);
  assert.equal(receipt(f, 'fixture-safe-stop').drainRequested, undefined);
  await rm(join(f.userRoot, 'data/fixture-module-busy'));
  await until(() => receipt(f, 'fixture-safe-stop').state === 'stopped');
  await until(() => !f.launcher.server.listening);
  assert.equal(f.launcher.moduleRunner.record().state, 'stopped');
  assert.equal(f.launcher.moduleRunner.child, null);
  assert.equal(existsSync(runner.record.socket), false);
});

test('unhealthy live candidate remains owned; explicit safe drain then compatible known-good code fallback never rolls data back', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  await configureFixtureService(f, 'task');
  await moduleControl(f, 'task', 'start', 'explicit-start-before-failed-main');
  const originalTask = await readModuleRunnerStatus(f.launcher.moduleRunner.socketPath, 'task');
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
  const restoredTask = await readModuleRunnerStatus(f.launcher.moduleRunner.socketPath, 'task');
  assert.equal(restoredTask.status, 'running', 'a candidate that never reached restoration cannot erase the pending host-cycle pins');
  assert.equal(restoredTask.identity.moduleDigest, originalTask.identity.moduleDigest);
  assert.equal(await readFile(join(f.userRoot, 'data/business-state'), 'utf8'), 'new live data remains');
});

test('direct native shutdown restores owned pins but a manual stop remains stopped despite enabled role/config flags', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  await configureFixtureService(f, 'task');
  await configureFixtureService(f, 'wechat');
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  assert.equal((await readModuleRunnerStatus(f.launcher.moduleRunner.socketPath, 'task')).status, 'stopped');
  await moduleControl(f, 'task', 'start', 'explicit-task-start-before-signal');
  const main = f.launcher.child, runner = f.launcher.moduleRunner.record();
  const task = await readModuleRunnerStatus(runner.socket, 'task');
  assert.equal(task.status, 'running');
  await writeFile(join(f.userRoot, 'data/fixture-module-busy'), 'normal signal must not bypass safe service drain');
  main.handle.kill('SIGTERM');
  await until(async () => (await readModuleRunnerStatus(runner.socket, 'task')).status === 'draining');
  const exitOperationId = f.launcher.active;
  assert.equal(f.launcher.child, main);
  assert.equal((await callLauncher(f.root, { action: 'status' })).health.state, 'healthy');
  assert.equal(existsSync(join(f.userRoot, 'data/drain-requests')), false, 'main shutdown preparation never recurses into /admin/restart');
  await rm(join(f.userRoot, 'data/fixture-module-busy'));
  await until(() => f.launcher.child === null && !f.launcher.inFlight);
  assert.equal(f.launcher.moduleRunner.record().state, 'stopped');
  assert.equal(processStillExists(runner.process), false);
  assert.equal(f.launcher.server.listening, true, 'stable external launcher may outlive the main, but not its modules');
  const preparation = receipt(f, exitOperationId);
  assert.equal(preparation.state, 'stopped');
  const config = await readFile(join(f.userRoot, 'module-config/task.json'), 'utf8');
  await callLauncher(f.root, { action: 'start', operationId: 'explicit-start-after-native-exit' });
  await until(() => receipt(f, 'explicit-start-after-native-exit').state === 'succeeded');
  const restarted = (await callLauncher(f.root, { action: 'status' })).moduleRunner;
  assert.notDeepEqual(restarted.record.process, runner.process);
  assert.equal(restarted.modules.find(module => module.id === 'task').status, 'running');
  assert.equal(restarted.modules.find(module => module.id === 'wechat').status, 'stopped');
  await moduleControl(f, 'task', 'stop', 'explicit-manual-stop-after-resume');
  await callLauncher(f.root, { action: 'restart', operationId: 'restart-must-preserve-manual-stop' });
  await until(() => receipt(f, 'restart-must-preserve-manual-stop').state === 'succeeded');
  assert.ok((await f.launcher.moduleRunner.status()).modules.every(module => module.status === 'stopped' && !module.owned));
  assert.deepEqual(readJson(join(f.root, 'module-resume.json')).services, []);
  assert.equal(await readFile(join(f.userRoot, 'module-config/task.json'), 'utf8'), config);
});

test('explicit recovery captures post-restore manual stops and never reapplies an unknown stopped channel', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  await configureFixtureService(f, 'task');
  await configureFixtureService(f, 'wechat');
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  await moduleControl(f, 'task', 'start', 'explicit-start-task-before-unknown');
  await moduleControl(f, 'wechat', 'start', 'explicit-start-wechat-before-unknown');
  const evidence = join(f.userRoot, 'data/wechat-unknown-evidence');
  await writeFile(evidence, 'unknown send remains retained, never replayed');
  await build(f, '1.2.4', 2);
  await writeFile(join(f.userRoot, 'data/fixture-unknown-restored-ack'), 'simulate only the parent acknowledgement uncertainty');
  const operationId = await install(f, '1.2.4');
  await until(() => receipt(f, operationId).state === 'unknown' && !f.launcher.inFlight);
  const uncertainRunner = f.launcher.moduleRunner.record();
  assert.equal(uncertainRunner.restore.state, 'unknown');
  assert.equal((await readModuleRunnerStatus(uncertainRunner.socket, 'wechat')).status, 'running');
  await moduleControl(f, 'wechat', 'stop', 'manual-wechat-stop-after-unknown');
  await rm(join(f.userRoot, 'data/fixture-unknown-restored-ack'));
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'drain' });
  await until(() => receipt(f, operationId).candidateExited && !f.launcher.inFlight);
  assert.deepEqual(receipt(f, operationId).resumeServices.map(pin => pin.id), ['task']);
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'fallback' });
  await until(() => receipt(f, operationId).state === 'recovered');
  const services = (await f.launcher.moduleRunner.status()).modules;
  assert.equal(services.find(service => service.id === 'task').status, 'running');
  assert.equal(services.find(service => service.id === 'wechat').status, 'stopped');
  assert.equal(await readFile(evidence, 'utf8'), 'unknown send remains retained, never replayed');
  const requests = (await readFile(join(f.userRoot, 'data/fixture-runner-requests'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(request => request.operationId === uncertainRunner.restore.operationId).length, 1);
  assert.equal(readJson(join(f.root, 'module-runner-history', `${uncertainRunner.generationId}.json`)).restore.state, 'unknown');
});

test('late original restore acknowledgement can be verified without resending startup or replacing any process', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  await configureFixtureService(f, 'task');
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20, moduleRunnerAcknowledgementTimeout: 100 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  await moduleControl(f, 'task', 'start', 'manual-start-before-late-restore');
  await writeFile(join(f.userRoot, 'data/fixture-delay-restore-ack'), 'hold only the synthetic parent acknowledgement');
  const operationId = 'restart-with-late-restore';
  await callLauncher(f.root, { action: 'restart', operationId });
  await until(() => receipt(f, operationId).state === 'unknown' && !f.launcher.inFlight);
  const main = f.launcher.child, runner = f.launcher.moduleRunner.record();
  assert.equal(runner.restore.state, 'unknown');
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'verify' });
  await until(() => !f.launcher.inFlight);
  assert.equal(receipt(f, operationId).state, 'unknown');
  await assert.rejects(callLauncher(f.root, { action: 'restart', operationId: 'new-id-cannot-hide-unknown-restore' }), /Another operation/);
  await rm(join(f.userRoot, 'data/fixture-delay-restore-ack'));
  await until(() => f.launcher.moduleRunner.record().restore?.state === 'restored');
  assert.equal(receipt(f, operationId).state, 'unknown', 'late IPC completion alone does not silently finish or replay the launcher operation');
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'verify' });
  await until(() => receipt(f, operationId).state === 'succeeded' && !f.launcher.inFlight);
  assert.equal(f.launcher.child, main);
  assert.deepEqual(f.launcher.moduleRunner.record().process, runner.process);
  assert.match(f.launcher.moduleRunner.record().uncertainties[0].reason, /acknowledgement unknown/);
  const requests = (await readFile(join(f.userRoot, 'data/fixture-runner-requests'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(request => request.type === 'restore-enabled' && request.operationId === runner.restore.operationId).length, 1);
  assert.equal((await readModuleRunnerStatus(runner.socket, 'task')).status, 'running');
});

test('read-only recovery verify never starts modules after a late healthy main; explicit unrequested restore can finish', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  await configureFixtureService(f, 'task');
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const first = await install(f, '1.2.3');
  await until(() => receipt(f, first).state === 'succeeded');
  await moduleControl(f, 'task', 'start', 'manual-start-before-late-health');
  await build(f, '1.2.4', 2);
  await writeFile(join(f.userRoot, 'data/unhealthy-1.2.4'), 'candidate health prevents restoration');
  f.launcher.healthTimeout = 500;
  const operationId = await install(f, '1.2.4');
  await until(() => receipt(f, operationId).state === 'unknown' && !f.launcher.inFlight);
  const candidate = f.launcher.child;
  await rm(join(f.userRoot, 'data/unhealthy-1.2.4'));
  await until(() => f.launcher.version(candidate.identity).then(() => candidate.mainReady, () => false));
  const requestsBefore = await readFile(join(f.userRoot, 'data/fixture-runner-requests'), 'utf8');
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'verify' });
  await until(() => !f.launcher.inFlight);
  assert.equal(receipt(f, operationId).state, 'unknown');
  assert.match(receipt(f, operationId).error, /verify never issues/);
  assert.equal(await readFile(join(f.userRoot, 'data/fixture-runner-requests'), 'utf8'), requestsBefore);
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'restore' });
  await until(() => receipt(f, operationId).state === 'succeeded');
  assert.equal(f.launcher.child, candidate);
  assert.equal((await readModuleRunnerStatus(f.launcher.moduleRunner.socketPath, 'task')).status, 'running');
});

test('late confirmed original runner drain allows explicit continuation without replaying its mutation', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  await configureFixtureService(f, 'task');
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20, moduleRunnerAcknowledgementTimeout: 100 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  await moduleControl(f, 'task', 'start', 'manual-start-before-late-drain');
  const main = f.launcher.child, runner = f.launcher.moduleRunner.record();
  await writeFile(join(f.userRoot, 'data/fixture-delay-drain-ack'), 'hold the original drain acknowledgement');
  const operationId = 'restart-delayed-runner-ack';
  await callLauncher(f.root, { action: 'restart', operationId });
  await until(() => receipt(f, operationId).state === 'unknown' && !f.launcher.inFlight);
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'continue' });
  await until(() => !f.launcher.inFlight);
  assert.equal(receipt(f, operationId).state, 'unknown');
  assert.equal(f.launcher.child, main);
  assert.equal(existsSync(join(f.userRoot, 'data/drain-requests')), false);
  await rm(join(f.userRoot, 'data/fixture-delay-drain-ack'));
  await until(() => f.launcher.moduleRunner.record().state === 'stopped');
  assert.equal(receipt(f, operationId).state, 'unknown', 'late confirmation alone never automatically restarts main');
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'continue' });
  await until(() => receipt(f, operationId).state === 'succeeded');
  assert.notEqual(f.launcher.child.identity.instanceId, main.identity.instanceId);
  assert.notDeepEqual(f.launcher.moduleRunner.record().process, runner.process);
  assert.equal(receipt(f, operationId).continuedAfterRunnerReadback, true);
  const requests = (await readFile(join(f.userRoot, 'data/fixture-runner-requests'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(request => request.type === 'drain-and-stop').length, 1);
  assert.equal(await readFile(join(f.userRoot, 'data/drain-requests'), 'utf8'), 'request\n');
  assert.match(receipt(f, operationId).moduleDrain.uncertainties[0].reason, /acknowledgement unknown/);
  assert.equal((await readModuleRunnerStatus(f.launcher.moduleRunner.socketPath, 'task')).status, 'running');
});

test('a later explicit native stop can follow a known no-effect refusal without overwriting that receipt', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const operationId = await install(f, '1.2.3');
  await until(() => receipt(f, operationId).state === 'succeeded');
  await writeFile(join(f.userRoot, 'data/fixture-runner-refuse'), 'known pre-effect refusal');
  const child = f.launcher.child;
  child.handle.kill('SIGTERM');
  await until(() => existsSync(join(f.userRoot, 'data/exit-error')) && !f.launcher.inFlight);
  const [first] = [...child.preparations];
  assert.equal(receipt(f, first).state, 'failed');
  assert.equal(f.launcher.child, child);
  await rm(join(f.userRoot, 'data/fixture-runner-refuse'));
  child.handle.kill('SIGTERM');
  await until(() => f.launcher.child === null && !f.launcher.inFlight);
  const preparations = [...child.preparations];
  assert.equal(preparations.length, 2);
  assert.equal(receipt(f, preparations[0]).state, 'failed', 'earlier no-effect failure remains historical evidence');
  assert.equal(receipt(f, preparations[1]).state, 'stopped');
  assert.equal(f.launcher.moduleRunner.record().state, 'stopped');
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
  assert.throws(() => f.launcher.checkCompatibility({ ...f.launcher.selection(), moduleRunnerApi: 2 }), /API1/);
  assert.throws(() => f.launcher.checkCompatibility({ ...f.launcher.selection(), moduleRunnerLifecycleApi: undefined }), /lifecycle API1/);
  const source = join(f.directory, 'source-1.2.4');
  writeJson(join(source, 'consumer-runtime.json'), { schemaVersion: 1, automaticDataMigrations: false,
    dataCompatibility: 'cockpit-user-root-v1', moduleRunnerApi: 2 });
  const manifestPath = join(source, 'delivery-manifest.json'), manifest = readJson(manifestPath);
  await rm(manifestPath);
  writeJson(manifestPath, { ...manifest, files: await inventory(source) });
  await assert.rejects(validateRelease(source, receipt(f, 'download-1.2.4').target), /runner API1/);
  assert.equal(f.launcher.child, oldChild);
});

test('consumer runner refuses foreign sockets and unknown shutdown replay, and never respawns a crashed runner', async t => {
  const f = await fixture(t);
  const socketPath = join(f.userRoot, '.module-runner.sock');
  await writeFile(socketPath, 'pre-existing foreign socket marker', { mode: 0o600 });
  assert.throws(() => new ConsumerModuleRunner(f.root), /not be adopted/);
  assert.equal(await readFile(socketPath, 'utf8'), 'pre-existing foreign socket marker');
  await rm(socketPath);

  const uncertain = new ConsumerModuleRunner(f.root);
  let sends = 0;
  uncertain.save({ state: 'ready', installationId: loadAuthority(f.root).installationId });
  uncertain.child = { handle: { send(_message, callback) { sends++; callback(new Error('Synthetic unknown IPC send')); } } };
  uncertain.assertIdentity = () => uncertain.record();
  await assert.rejects(uncertain.drainAndStop('unknown-ipc-stop'), /unknown IPC/);
  await assert.rejects(uncertain.drainAndStop('unknown-ipc-stop'), /no mutation retry/);
  await assert.rejects(uncertain.drainAndStop('another-ipc-stop'), /no mutation retry/);
  assert.equal(sends, 1, 'changing operation IDs never hides an uncertain shutdown mutation');
  await rm(uncertain.recordPath); // Remove only synthetic, never-executed process state.

  await build(f, '1.2.3', 1);
  const runner = new ConsumerModuleRunner(f.root), target = receipt(f, 'download-1.2.3').target;
  const release = join(f.directory, 'source-1.2.3');
  const verified = await validateRelease(release, target);
  const selection = { release, target, moduleRunnerApi: verified.moduleRunnerApi,
    moduleRunnerLifecycleApi: verified.moduleRunnerLifecycleApi, manifestSha256: verified.manifestSha256 };
  await runner.ensure(selection, 'fixture-runner-start');
  const child = runner.child;
  child.handle.send({ type: 'fixture-crash' });
  assert.equal((await child.exited).code, 23);
  assert.equal((await runner.status()).state, 'unknown');
  await assert.rejects(runner.ensure(selection, 'must-not-respawn'), /blocks automatic replacement/);
  assert.throws(() => new ConsumerModuleRunner(f.root), /not be adopted|unknown/);
  assert.equal(runner.child, null);
});

test('consumer adapter owns the real core entry, restores the actual running release pin, and preserves manual stop', async t => {
  const f = await fixture(t);
  assert.equal(readJson(join(repo, 'consumer-runtime.json')).moduleRunnerLifecycleApi, 1, 'Core lifecycle seam must be integrated before starting its child');
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const { tsImport } = await import(require.resolve('tsx/esm/api'));
  const { ModuleCatalog } = await tsImport('../packages/core/src/modules/catalog.ts', import.meta.url);
  const source = join(f.directory, 'real-service');
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'service.mjs'), await readFile(join(repo, 'packages/core/src/modules/supervisor-service.fixture.mjs')));
  await writeFile(join(source, 'module.json'), JSON.stringify({ schemaVersion: 1, id: 'task', version: '1.0.0',
    name: 'Consumer lifecycle fixture', description: 'Owned loopback test child', configVersion: 1,
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' },
    service: { entry: 'service.mjs', healthPath: '/health', versionPath: '/version', drainPath: '/drain', publicPath: '/modules/task' } }));
  const catalog = new ModuleCatalog({ userRoot: f.userRoot, trustedSources: [source] });
  const installed = catalog.installFromDirectory(source);
  const token = join(f.directory, 'fixture-manager.json');
  writeJson(token, { token: 'synthetic-consumer-lifecycle-manager' });
  const serviceUrl = `http://127.0.0.1:${await freePort()}`;
  catalog.updateConfig('task', { ownership: 'managed', activationEnabled: true, serviceUrl,
    dataDirectory: catalog.dataDirectory('task'), managerCredentialFile: token }, 0);
  const configuration = catalog.readConfig('task');
  const businessData = join(catalog.dataDirectory('task'), 'unknown-evidence.json');
  writeJson(businessData, { state: 'unknown', operationId: 'unrelated-business-operation', mustNotReplay: true });
  const main = createHttpServer((_request, response) => response.end('{"ok":true}'));
  await new Promise(resolve => main.listen(loadAuthority(f.root).port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => main.close(resolve)));
  const runner = new ConsumerModuleRunner(f.root, { acknowledgementTimeout: 1000 });
  f.ownedRunners.push(runner);
  // Real source-level supervisor integration; signed full-CI-archive acceptance remains separate.
  const selection = { release: repo.slice(0, -1), moduleRunnerApi: 1, moduleRunnerLifecycleApi: 1 };
  await runner.ensure(selection, 'real-entry-ipc-fixture');
  await runner.restoreEnabled('real-entry-ipc-fixture');
  assert.equal((await readModuleRunnerStatus(runner.socketPath, 'task')).status, 'stopped', 'installed/activation permission does not start a service');
  await moduleControl(f, 'task', 'start', 'real-explicit-task-start');
  await until(async () => (await readModuleRunnerStatus(runner.socketPath, 'task')).status === 'running');
  const status = await runner.status(), child = runner.child;
  assert.equal(status.state, 'ready');
  assert.equal(status.record.process.pid, child.handle.pid);
  assert.equal(status.record.lifecycleApi, 1);
  const service = status.modules.find(value => value.id === 'task'), serviceProcess = processIdentity(service.pid);
  assert.equal(service.status, 'running');
  assert.equal(service.owned, true);
  assert.equal(service.identity.moduleDigest, installed.digest);
  const newerManifest = { ...readJson(join(source, 'module.json')), version: '2.0.0' };
  await writeFile(join(source, 'module.json'), JSON.stringify(newerManifest));
  catalog.installFromDirectory(source);
  catalog.setSelected('task', '2.0.0');
  const control = join(catalog.dataDirectory('task'), 'fixture-control.json');
  writeJson(control, { busy: true });
  const stopping = runner.drainAndStop('real-entry-graceful-shutdown');
  await until(async () => (await readModuleRunnerStatus(runner.socketPath, 'task')).status === 'draining');
  await sleep(1100);
  assert.equal(processStillExists(serviceProcess), true, 'accepted busy drain has no acknowledgement/force timeout');
  assert.equal((await fetch(`http://127.0.0.1:${loadAuthority(f.root).port}/health`)).status, 200);
  await assert.rejects(moduleControl(f, 'task', 'start', 'real-start-during-stop'), /closing|quiesc|drain/i);
  writeJson(control, {});
  await stopping;
  assert.deepEqual(await child.exited, { code: 0, signal: null, clean: true });
  assert.equal(processStillExists(serviceProcess), false);
  assert.equal(existsSync(runner.socketPath), false);
  assert.equal(existsSync(runner.lockPath), false);
  assert.deepEqual(catalog.readConfig('task'), configuration);
  assert.equal(readJson(businessData).state, 'unknown');
  assert.equal(readJson(join(f.userRoot, '.module-runner/services/task.json')).state, 'stopped');

  const resumeServices = runner.record().shutdown.services;
  assert.deepEqual(resumeServices, [{ id: 'task', version: '1.0.0', digest: installed.digest }]);
  const next = new ConsumerModuleRunner(f.root);
  f.ownedRunners.push(next);
  await next.ensure(selection, 'real-next-main-start', resumeServices);
  await next.restoreEnabled('real-next-main-start');
  assert.notDeepEqual(next.record().process, status.record.process);
  const restored = await readModuleRunnerStatus(next.socketPath, 'task');
  assert.equal(restored.status, 'running');
  assert.equal(restored.owned, true);
  assert.equal(restored.identity.moduleVersion, '1.0.0');
  assert.equal(restored.identity.moduleDigest, installed.digest);
  assert.equal(catalog.getInstalled('task').manifest.version, '2.0.0', 'role selection stays independent of restored service version');
  assert.deepEqual(catalog.readConfig('task'), configuration);
  assert.equal(readJson(businessData).mustNotReplay, true);
  assert.equal(existsSync(join(f.directory, 'native')), false, 'no native Copilot state is created or copied');
  await moduleControl(f, 'task', 'stop', 'real-manual-task-stop');
  await until(async () => (await readModuleRunnerStatus(next.socketPath, 'task')).status === 'stopped');
  await next.drainAndStop('real-next-main-stop');
  assert.deepEqual(next.record().shutdown.services, []);
  const stopped = new ConsumerModuleRunner(f.root);
  f.ownedRunners.push(stopped);
  await stopped.ensure(selection, 'real-stopped-main-start', next.record().shutdown.services);
  await stopped.restoreEnabled('real-stopped-main-start');
  assert.equal((await readModuleRunnerStatus(stopped.socketPath, 'task')).status, 'stopped');
  await stopped.drainAndStop('real-stopped-main-stop');
});

test('a module started at the drain fence is included without orphaning it or prematurely exiting main', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  const runner = f.launcher.moduleRunner.record(), main = f.launcher.child;
  await writeFile(join(f.userRoot, 'data/fixture-race-module-start'), 'start immediately before the atomic runner drain fence');
  await writeFile(join(f.userRoot, 'data/fixture-module-busy'), 'racing owned module remains busy');
  await callLauncher(f.root, { action: 'stop', operationId: 'race-drain-stop' });
  await until(async () => (await readModuleRunnerStatus(runner.socket, 'task')).status === 'draining');
  assert.equal(f.launcher.child, main, 'owned module drain must finish before native main drain');
  assert.equal(receipt(f, 'race-drain-stop').drainRequested, undefined);
  assert.equal(existsSync(join(f.userRoot, 'data/drain-requests')), false);
  assert.equal(f.launcher.server.listening, true);
  assert.equal(f.launcher.moduleRunner.record().shutdown.state, 'accepted');
  assert.deepEqual(f.launcher.moduleRunner.record().process, runner.process);
  const task = await readModuleRunnerStatus(runner.socket, 'task');
  assert.equal(task.status, 'draining');
  assert.equal((await callLauncher(f.root, { action: 'stop', operationId: 'race-drain-stop' })).state, 'draining-modules');
  assert.equal((await callLauncher(f.root, { action: 'status' })).health.state, 'healthy');
  assert.equal((await readModuleRunnerStatus(runner.socket, 'task')).pid, task.pid);
  await rm(join(f.userRoot, 'data/fixture-module-busy'));
  await until(() => receipt(f, 'race-drain-stop').state === 'stopped');
  assert.equal(f.launcher.moduleRunner.child, null);
});

test('unknown module-drain acknowledgement keeps backend alive and the original stop unresolved without retry', async t => {
  const f = await fixture(t);
  await build(f, '1.2.3', 1);
  f.launcher = await serve(f.root, { healthTimeout: 5000, pollMs: 20 });
  const installed = await install(f, '1.2.3');
  await until(() => receipt(f, installed).state === 'succeeded');
  const main = f.launcher.child, shutdown = f.launcher.moduleRunner.drainAndStop;
  let sends = 0;
  // Inject at the IPC seam without sending a real request, so fixture cleanup remains safe.
  f.launcher.moduleRunner.drainAndStop = async () => { sends++; throw new Error('Fixture unknown shutdown acknowledgement'); };
  try {
    await callLauncher(f.root, { action: 'stop', operationId: 'stop-unknown-runner' });
    await until(() => receipt(f, 'stop-unknown-runner').state === 'unknown' && !f.launcher.inFlight);
    assert.equal(f.launcher.child, main);
    assert.equal(receipt(f, 'stop-unknown-runner').drainRequested, undefined);
    assert.equal((await callLauncher(f.root, { action: 'stop', operationId: 'stop-unknown-runner' })).state, 'unknown');
    await assert.rejects(callLauncher(f.root, { action: 'stop', operationId: 'stop-new-id-cannot-retry' }), /Another operation/);
    assert.equal(sends, 1);
    assert.equal((await callLauncher(f.root, { action: 'status' })).health.state, 'healthy');
  } finally { f.launcher.moduleRunner.drainAndStop = shutdown; }
});

test('owned service pin validation never treats enablement flags or malformed identities as restoration', () => {
  const task = { id: 'task', version: '1.2.3', digest: 'a'.repeat(64) };
  assert.deepEqual(moduleServicePins([]), []);
  assert.deepEqual(moduleServicePins([task]), [task]);
  for (const value of [undefined, [{ ...task, enabled: true }], [{ ...task, id: 'assistant' }],
    [{ ...task, digest: 'unknown' }], [task, task]]) {
    assert.throws(() => moduleServicePins(value), /pin|restoration/i);
  }
});

test('consumer metadata uses a distinct main target and rejects wrong publisher or sequence', async t => {
  const f = await fixture(t);
  const published = await build(f, '1.2.3', 1);
  assert.equal(verifyConsumerMetadata(published.envelope, f.channel).targets[0].moduleId, 'cockpit');
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
  await callLauncher(f.root, { action: 'recover', operationId, recovery: 'continue' });
  await until(() => !f.launcher.inFlight);
  assert.match(receipt(f, operationId).error, /unknown native mutations are never replayed/);
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
  const metadata = sequence => ({ schemaVersion: 1, channel: 'stable', sequence,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    targets: [{ moduleId: 'cockpit', version: `1.0.${sequence}`, platform: 'linux', arch: 'x64', nodeMajor: 24,
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
