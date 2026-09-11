import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { ModuleCatalog, type InstalledModule, type ModuleManifest } from './catalog.ts';
import { buildModuleLaunch, ModuleRunnerClient, ModuleSupervisor, type ModuleRunnerJob, type ServiceModuleId } from './supervisor.ts';
import type { AdapterConfig } from './adapters.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function manifest(version: string, id: ServiceModuleId = 'task'): ModuleManifest {
  return { schemaVersion: 1, id, version, name: 'Synthetic Module', description: 'Isolated service lifecycle test',
    configVersion: 1, compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' },
    service: { entry: 'service.mjs', ...(id === 'wechat' ? { args: ['run'] } : {}), healthPath: '/health',
      versionPath: '/version', drainPath: id === 'wechat' ? '/admin/restart' : '/drain', publicPath: `/modules/${id}` } };
}
async function fixture(t: test.TestContext, startupTimeoutMs = 1500, id: ServiceModuleId = 'task') {
  const root = mkdtempSync(join(process.cwd(), '.runner-'));
  const userRoot = join(root, 'u'), source = join(root, 'source');
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, 'service.mjs'), readFileSync(new URL('./supervisor-service.fixture.mjs', import.meta.url)));
  const catalog = new ModuleCatalog({ userRoot, trustedSources: [source] });
  const install = (version: string): InstalledModule => {
    writeFileSync(join(source, 'module.json'), JSON.stringify(manifest(version, id)));
    return catalog.installFromDirectory(source);
  };
  const first = install('1.0.0');
  const port = await freePort();
  const managerCredentialFile = join(root, 'manager.json');
  writeFileSync(managerCredentialFile, JSON.stringify({ token: 'synthetic-module-manager' }), { mode: 0o600 });
  const config: AdapterConfig = { ownership: 'managed', serviceUrl: `http://127.0.0.1:${port}`,
    activationEnabled: true, dataDirectory: catalog.dataDirectory(id), managerCredentialFile };
  if (id === 'wechat') {
    config.configFile = join(root, 'wechat.json');
    writeFileSync(config.configFile, JSON.stringify({ moduleManaged: true, stateDir: catalog.dataDirectory(id) }), { mode: 0o600 });
  }
  catalog.updateConfig(id, { ...config }, 0);
  const set = (values: object): void => writeFileSync(join(catalog.dataDirectory(id), 'fixture-control.json'), JSON.stringify(values), { mode: 0o600 });
  const runner = await ModuleSupervisor.start({ userRoot, startupTimeoutMs, readinessIntervalMs: 10, cockpitUrl: 'http://127.0.0.1:1' });
  const client = new ModuleRunnerClient({ userRoot, timeoutMs: 5000 });
  t.after(async () => {
    set({});
    try { await fetch(`${config.serviceUrl}/fixture/exit`, { method: 'POST', signal: AbortSignal.timeout(1000) }); } catch { /* Fixture may already be stopped. */ }
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await runner.close(); break; } catch { await sleep(10); }
    }
    await runner.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, userRoot, catalog, config, first, source, runner, client, install, set };
}
async function finished(client: ModuleRunnerClient, operationId: string): Promise<ModuleRunnerJob> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = await client.job(operationId);
    if (job && ['done', 'failed', 'unknown'].includes(job.phase)) return job;
    await sleep(10);
  }
  throw new Error(`Fixture operation did not finish: ${operationId}`);
}
async function waiting(client: ModuleRunnerClient, operationId: string): Promise<ModuleRunnerJob> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await client.job(operationId);
    if (job?.phase === 'waiting') return job;
    if (job && ['failed', 'unknown'].includes(job.phase)) throw new Error(`Operation failed before drain wait: ${job.reason}`);
    await sleep(10);
  }
  throw new Error('Fixture never reached drain wait');
}
async function start(client: ModuleRunnerClient, first: InstalledModule, operationId = 'start-op-0001') {
  const receipt = await client.submit({ operationId, id: 'task', action: 'start', version: first.manifest.version, digest: first.digest });
  assert.equal(receipt.phase, 'accepted');
  const result = await finished(client, operationId);
  assert.equal(result.phase, 'done', result.reason);
  return result;
}
async function raw(userRoot: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(userRoot, '.module-runner.sock'));
    let text = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      text += chunk.toString();
      if (text.includes('\n')) { socket.destroy(); resolve(JSON.parse(text)); }
    });
  });
}

test('a rejected newer selection cannot prevent safe drain of the actual owned release', async t => {
  const { client, first, install } = await fixture(t);
  await start(client, first);
  const newer = install('1.1.0');
  writeFileSync(join(newer.release, 'module.json'), '{"unsupportedFutureManifest":true}');
  await assert.rejects(client.submit({ id: 'task', action: 'apply', operationId: 'reject-newer-0001',
    version: '1.1.0', digest: newer.digest }), /integrity|manifest/i);
  assert.equal(await client.job('reject-newer-0001'), null);
  assert.equal((await client.status('task')).identity?.moduleVersion, '1.0.0');
  await client.submit({ id: 'task', action: 'stop', operationId: 'stop-old-release-0001' });
  assert.equal((await finished(client, 'stop-old-release-0001')).phase, 'done');
  assert.equal((await client.status('task')).status, 'stopped');
});

test('real child startup returns accepted then durable done, verified identity and private IPC', async t => {
  const { client, runner, first, userRoot, catalog } = await fixture(t);
  const result = await start(client, first);
  assert.equal(result.result?.identity?.moduleDigest, first.digest);
  const status = await client.status('task');
  assert.equal(status.status, 'running');
  assert.equal(status.owned, true);
  assert.equal(status.identity?.instanceId, result.result?.identity?.instanceId);
  assert.equal(statSync(runner.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(userRoot, '.module-runner', 'jobs', 'start-op-0001.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(userRoot, '.module-runner')).mode & 0o777, 0o700);
  const launch = JSON.parse(readFileSync(join(catalog.dataDirectory('task'), `launch-${status.identity!.instanceId}.json`), 'utf8'));
  assert.equal(launch.env.COCKPIT_MODULE_DIGEST, first.digest);
  assert.equal(launch.env.SERVICE_DELIVERY_SHA, undefined);
  assert.equal(launch.env.NODE_OPTIONS, undefined);
  assert.equal(launch.env.WORK_PORT, launch.env.COCKPIT_MODULE_PORT);
  await assert.rejects(runner.close(), /active children/);
});

test('apply drains and waits without force deadline, then starts independently verified new identity', async t => {
  const { client, first, install, set, catalog } = await fixture(t, 1000);
  const initial = await start(client, first);
  const next = install('2.0.0');
  set({ busy: true });
  const configBefore = catalog.readConfig('task');
  const pid = (await client.status('task')).pid;
  const receipt = await client.submit({ operationId: 'apply-op-0001', id: 'task', action: 'apply', version: '2.0.0', digest: next.digest });
  assert.equal(receipt.phase, 'accepted');
  assert.equal((await waiting(client, receipt.command.operationId)).step, 'waiting-exit');
  await sleep(1100);
  const busy = await client.status('task');
  assert.equal(busy.status, 'draining');
  assert.equal(busy.pid, pid);
  assert.equal(busy.identity?.moduleVersion, '1.0.0');
  assert.equal((await client.job(receipt.command.operationId))?.phase, 'waiting');
  set({});
  const applied = await finished(client, receipt.command.operationId);
  assert.equal(applied.phase, 'done', applied.reason);
  assert.equal(applied.result?.identity?.moduleVersion, '2.0.0');
  assert.notEqual(applied.result?.identity?.instanceId, initial.result?.identity?.instanceId);
  assert.notEqual((await client.status('task')).pid, pid);
  assert.equal(catalog.getInstalled('task')?.manifest.version, '1.0.0', 'runner must not fabricate disk selection');
  assert.ok(existsSync(first.release));
  assert.deepEqual(catalog.readConfig('task'), configBefore);
  assert.ok(existsSync(join(catalog.dataDirectory('task'), `launch-${initial.result!.identity!.instanceId}.json`)));
});

test('explicit recovery drains only the still-owned identity and preserves the original unknown operation', async t => {
  const { client, first, set, catalog } = await fixture(t);
  await start(client, first);
  writeFileSync(join(catalog.dataDirectory('task'), 'retained-data.txt'), 'Preserve live data');
  set({ denyDrain: true });
  await client.submit({ id: 'task', action: 'stop', operationId: 'uncertain-stop-0001' });
  assert.equal((await finished(client, 'uncertain-stop-0001')).phase, 'unknown');
  const unknown = await client.status('task');
  assert.equal(unknown.owned, true);
  assert.equal(unknown.canRecoverStop, true);
  await assert.rejects(client.submit({ id: 'task', action: 'stop', operationId: 'wrong-recovery-0001',
    recoveryOf: 'different-operation', confirmRecovery: true }), /recovery/);
  await assert.rejects(client.submit({ id: 'task', action: 'apply', operationId: 'bad-recovery-0001',
    recoveryOf: 'uncertain-stop-0001', confirmRecovery: true }), /safe stop/);
  set({ unhealthy: true });
  const recovery = { id: 'task' as const, action: 'stop' as const, operationId: 'explicit-stop-recovery-0001',
    recoveryOf: 'uncertain-stop-0001', confirmRecovery: true as const };
  assert.equal((await client.submit(recovery)).phase, 'accepted');
  const stopped = await finished(client, recovery.operationId);
  assert.equal(stopped.phase, 'done', stopped.reason);
  assert.equal(stopped.result?.state, 'stopped');
  assert.equal((await client.job('uncertain-stop-0001'))?.phase, 'unknown');
  assert.deepEqual(await client.submit(recovery), stopped);
  assert.equal((await client.status('task')).canRecoverStop, false);
  assert.equal(readFileSync(join(catalog.dataDirectory('task'), 'retained-data.txt'), 'utf8'), 'Preserve live data');
  set({});
  assert.equal((await start(client, first, 'explicit-start-after-recovery')).phase, 'done');
});

test('singleton lock is never stolen and graceful runner close waits for an owned drain', async t => {
  const { client, first, runner, userRoot, set } = await fixture(t);
  await assert.rejects(ModuleSupervisor.start({ userRoot }), /singleton lock/);
  await start(client, first);
  set({ busy: true });
  let closed = false;
  const closing = runner.close({ drain: true }).then(() => { closed = true; });
  for (let count = 0; count < 100 && (await client.status('task')).status !== 'draining'; count++) await sleep(10);
  await sleep(100);
  assert.equal(closed, false);
  set({});
  await closing;
  assert.equal(existsSync(runner.socketPath), false);
  assert.equal(existsSync(join(userRoot, '.module-runner.lock')), false);
});

test('durable operation idempotency prevents another launch and rejects changed bodies', async t => {
  const { client, first, catalog } = await fixture(t);
  const request = { operationId: 'start-idempotent', id: 'task' as const, action: 'start' as const, version: '1.0.0', digest: first.digest };
  assert.equal((await client.submit(request)).phase, 'accepted');
  const done = await finished(client, request.operationId);
  assert.equal(done.phase, 'done');
  assert.deepEqual(await client.submit(request), done);
  await assert.rejects(client.submit({ ...request, action: 'apply' }), /conflicts/);
  assert.equal(readdirSync(catalog.dataDirectory('task')).filter(file => file.startsWith('launch-')).length, 1);
});

test('external ownership and disabled activation refuse startup before recording or launching', async t => {
  const { client, catalog, config } = await fixture(t);
  catalog.updateConfig('task', { ownership: 'external' }, 1);
  await assert.rejects(client.submit({ operationId: 'external-start', id: 'task', action: 'start' }), /external/);
  assert.equal(await client.job('external-start'), null);
  catalog.updateConfig('task', { ownership: 'managed', activationEnabled: false }, 2);
  await assert.rejects(client.submit({ operationId: 'disabled-start', id: 'task', action: 'start' }), /activationEnabled/);
  assert.equal(await client.job('disabled-start'), null);
  assert.equal((await client.status('task')).status, 'stopped');
  assert.equal(config.activationEnabled, true);
});

test('occupied unowned endpoint is never adopted, drained or stopped', async t => {
  const { client, config } = await fixture(t);
  let requests = 0;
  const external = createServer((_request, response) => { requests++; response.end('{}'); });
  await new Promise<void>(resolve => external.listen(Number(new URL(config.serviceUrl!).port), '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => external.close(error => error ? reject(error) : resolve())));
  const accepted = await client.submit({ operationId: 'occupied-start', id: 'task', action: 'start' });
  assert.equal(accepted.phase, 'accepted');
  const result = await finished(client, 'occupied-start');
  assert.equal(result.phase, 'unknown');
  assert.match(result.reason!, /occupied/);
  assert.equal(requests, 0);
  assert.equal((await client.status('task')).owned, false);
  await assert.rejects(client.submit({ operationId: 'occupied-stop-2', id: 'task', action: 'stop' }), /recovery/);
});

test('digest mismatch, tampering and arbitrary IPC fields fail closed', async t => {
  const { client, first, userRoot } = await fixture(t);
  await assert.rejects(client.submit({ operationId: 'bad-digest-0001', id: 'task', action: 'start', digest: '0'.repeat(64) }), /digest/);
  const response = await raw(userRoot, { type: 'control', command: {
    operationId: 'unsafe-command', id: 'task', action: 'start', command: '/bin/sh', serviceUrl: 'http://example.com',
  } });
  assert.equal(response.ok, false);
  writeFileSync(join(first.release, 'service.mjs'), 'throw new Error("tampered");');
  await assert.rejects(client.submit({ operationId: 'tampered-start', id: 'task', action: 'start' }), /integrity/);
});

test('restart marks interrupted durable acceptance unknown and refuses replay or automatic startup', async t => {
  const { runner, client, userRoot } = await fixture(t);
  await runner.close();
  const interrupted = { schemaVersion: 1, command: { operationId: 'interrupted-job', id: 'task', action: 'start' },
    phase: 'accepted', step: 'queued', acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeFileSync(join(userRoot, '.module-runner', 'jobs', 'interrupted-job.json'), JSON.stringify(interrupted), { mode: 0o600 });
  const restarted = await ModuleSupervisor.start({ userRoot });
  t.after(() => restarted.close());
  assert.equal((await client.job('interrupted-job'))?.phase, 'unknown');
  assert.equal((await client.status('task')).recoveryRequired, true);
  assert.equal((await client.submit({ operationId: 'interrupted-job', id: 'task', action: 'start' })).phase, 'unknown');
  await assert.rejects(client.submit({ operationId: 'new-after-crash', id: 'task', action: 'start' }), /recovery/);
  assert.equal((await client.status('task')).canRecoverStop, true);
  await client.submit({ id: 'task', action: 'stop', operationId: 'confirm-unstarted-stop',
    recoveryOf: 'interrupted-job', confirmRecovery: true });
  assert.equal((await finished(client, 'confirm-unstarted-stop')).result?.state, 'stopped');
  assert.equal((await client.job('interrupted-job'))?.phase, 'unknown');
  await restarted.close();
});

test('stale singleton lock is an explicit blocker and is not removed', async t => {
  const { runner, userRoot } = await fixture(t);
  await runner.close();
  const lock = join(userRoot, '.module-runner.lock');
  writeFileSync(lock, '{"pid":99999999}', { mode: 0o600 });
  await assert.rejects(ModuleSupervisor.start({ userRoot }), /never automatically steal/);
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":99999999}');
});

test('child nonzero startup exit is durable failed and cannot automatically restart', async t => {
  const { client, runner, userRoot, set } = await fixture(t);
  set({ exitBeforeReady: true });
  await client.submit({ operationId: 'nonzero-startup', id: 'task', action: 'start' });
  const job = await finished(client, 'nonzero-startup');
  assert.equal(job.phase, 'failed');
  assert.match(job.reason!, /exited/);
  assert.equal((await client.status('task')).canRecoverStop, false);
  await assert.rejects(client.submit({ id: 'task', action: 'stop', operationId: 'unclean-exit-recovery',
    recoveryOf: 'nonzero-startup', confirmRecovery: true }), /not clean/);
  await assert.rejects(client.submit({ operationId: 'retry-nonzero-1', id: 'task', action: 'start' }), /recovery/);
  await runner.close();
  const restarted = await ModuleSupervisor.start({ userRoot });
  await assert.rejects(client.submit({ operationId: 'retry-nonzero-2', id: 'task', action: 'start' }), /recovery/);
  assert.equal((await client.status('task')).canRecoverStop, false);
  await assert.rejects(client.submit({ id: 'task', action: 'stop', operationId: 'unowned-stop-recovery',
    recoveryOf: 'nonzero-startup', confirmRecovery: true }), /not owned/);
  await restarted.close();
});

test('unhealthy startup becomes unknown without killing or restarting its child', async t => {
  const { client, runner, set } = await fixture(t, 100);
  set({ unhealthy: true });
  await client.submit({ operationId: 'unhealthy-start', id: 'task', action: 'start' });
  const job = await finished(client, 'unhealthy-start');
  assert.equal(job.phase, 'unknown');
  const status = await client.status('task');
  assert.equal(status.status, 'unknown');
  assert.equal(status.owned, true);
  assert.equal(status.recoveryRequired, true);
  assert.ok(status.pid);
  process.kill(status.pid, 0);
  await assert.rejects(runner.close(), /active children/);
  await assert.rejects(client.submit({ operationId: 'unhealthy-retry', id: 'task', action: 'start' }), /recovery/);
});

test('uncertain drain is never retried and does not start the target release', async t => {
  const { client, first, install, set, catalog } = await fixture(t);
  await start(client, first);
  const next = install('2.0.0');
  set({ denyDrain: true });
  await client.submit({ operationId: 'uncertain-apply', id: 'task', action: 'apply', version: '2.0.0', digest: next.digest });
  const job = await finished(client, 'uncertain-apply');
  assert.equal(job.phase, 'unknown');
  assert.match(job.reason!, /no retry/);
  assert.equal((await client.status('task')).identity?.moduleVersion, '1.0.0');
  assert.equal(readdirSync(catalog.dataDirectory('task')).filter(file => file.startsWith('launch-')).length, 1);
  await assert.rejects(client.submit({ operationId: 'uncertain-retry', id: 'task', action: 'apply', version: '2.0.0' }), /recovery/);
});

test('nonzero drain exit prevents replacement and preserves old releases/config/data', async t => {
  const { client, first, install, set, catalog } = await fixture(t);
  await start(client, first);
  const next = install('2.0.0');
  set({ drainExitCode: 7 });
  await client.submit({ operationId: 'bad-drain-exit', id: 'task', action: 'apply', version: '2.0.0', digest: next.digest });
  const job = await finished(client, 'bad-drain-exit');
  assert.equal(job.phase, 'unknown');
  assert.match(job.reason!, /not clean/);
  assert.ok(existsSync(first.release) && existsSync(next.release));
  assert.equal(readdirSync(catalog.dataDirectory('task')).filter(file => file.startsWith('launch-')).length, 1);
  assert.equal(catalog.readConfig('task').revision, 1);
});

test('launch builder excludes inherited delivery credentials and passes explicit WeChat config reference', async t => {
  const { first, config, userRoot } = await fixture(t);
  const old = process.env.SERVICE_DELIVERY_SHA;
  process.env.SERVICE_DELIVERY_SHA = 'must-not-inherit';
  try {
    const task = buildModuleLaunch(first, config, { moduleId: 'task', moduleVersion: '1.0.0', moduleDigest: first.digest, instanceId: 'instance-12345678' }, userRoot, 'http://127.0.0.1:1');
    assert.equal(task.executable, process.execPath);
    assert.equal(task.env.SERVICE_DELIVERY_SHA, undefined);
    const installed: InstalledModule = { ...first, manifest: { ...first.manifest, id: 'wechat',
      service: { ...first.manifest.service!, entry: 'src/cli.js', args: ['run'] } } };
    const launch = buildModuleLaunch(installed, { ...config, configFile: join(userRoot, 'wechat.json') },
      { moduleId: 'wechat', moduleVersion: '1.0.0', moduleDigest: installed.digest, instanceId: 'instance-87654321' }, userRoot);
    assert.deepEqual(launch.args.slice(1), ['run', '--config', join(userRoot, 'wechat.json')]);
  } finally {
    if (old === undefined) delete process.env.SERVICE_DELIVERY_SHA; else process.env.SERVICE_DELIVERY_SHA = old;
  }
});

test('client refuses a broadly accessible socket', async t => {
  const { runner, client } = await fixture(t);
  chmodSync(runner.socketPath, 0o666);
  await assert.rejects(client.status('task'), /owner-only/);
  chmodSync(runner.socketPath, 0o600);
});

test('the explicit entry runs independently of its IPC consumer and exits only after graceful child drain', async t => {
  const { runner, client, userRoot, first } = await fixture(t);
  await runner.close();
  const entry = new URL('./supervisor-entry.ts', import.meta.url);
  const processChild = spawn(process.execPath, ['--import', 'tsx', entry.pathname, '--user-root', userRoot,
    '--cockpit-url', 'http://127.0.0.1:1'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let stderr = '';
  processChild.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = new Promise<number | null>((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('exit', code => resolve(code));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Independent runner did not become ready: ${stderr}`)), 5000);
      processChild.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('\n')) {
          clearTimeout(timer);
          try {
            const ready = JSON.parse(output.trim());
            assert.equal(ready.ready, true);
            assert.equal(ready.pid, processChild.pid);
            assert.notEqual(ready.pid, process.pid);
            resolve();
          } catch (error) { reject(error); }
        }
      });
      processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`Runner exited before readiness: ${code} ${stderr}`)); });
    });
    await start(client, first, 'separate-start');
    assert.equal((await new ModuleRunnerClient({ userRoot }).status('task')).status, 'running');
  } finally {
    processChild.kill('SIGTERM');
    assert.equal(await exit, 0, stderr);
  }
  assert.equal(existsSync(join(userRoot, '.module-runner.sock')), false);
  const stopJobs = readdirSync(join(userRoot, '.module-runner', 'jobs')).map(file => JSON.parse(readFileSync(join(userRoot, '.module-runner', 'jobs', file), 'utf8')));
  assert.ok(stopJobs.some(job => job.command.action === 'stop' && job.phase === 'done'));
});

test('owned parent IPC refuses active-module shutdown and closes only an idle runner', async t => {
  const { runner, client, userRoot, first } = await fixture(t);
  await runner.close();
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./supervisor-entry.ts', import.meta.url).pathname,
    '--user-root', userRoot, '--cockpit-url', 'http://127.0.0.1:1'],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const exited = once(child, 'exit');
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(ready, { type: 'module-runner-ready', apiVersion: 1, pid: child.pid,
      socket: join(userRoot, '.module-runner.sock') });
    await start(client, first, 'parent-ipc-start');
    const refused = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.send({ type: 'shutdown-if-idle', operationId: 'parent-ipc-refusal' });
    const [failure] = await refused;
    assert.equal(failure.ok, false);
    assert.match(failure.error, /active children\/jobs/);
    assert.equal((await client.status('task')).status, 'running');
    await client.submit({ id: 'task', action: 'stop', operationId: 'parent-ipc-explicit-stop' });
    assert.equal((await finished(client, 'parent-ipc-explicit-stop')).phase, 'done');
    const completed = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.send({ type: 'shutdown-if-idle', operationId: 'parent-ipc-idle-close' });
    assert.deepEqual((await completed)[0], { type: 'module-runner-shutdown',
      operationId: 'parent-ipc-idle-close', pid: child.pid, ok: true });
    assert.deepEqual(await exited, [0, null], stderr);
    assert.equal(existsSync(join(userRoot, '.module-runner.sock')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
});

test('consumer disconnect does not cancel or replay an accepted operation', async t => {
  const { client, userRoot } = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(join(userRoot, '.module-runner.sock'));
    socket.on('error', reject);
    socket.once('connect', () => {
      socket.end(`${JSON.stringify({ type: 'control', command: { operationId: 'disconnected-start', id: 'task', action: 'start' } })}\n`);
      resolve();
    });
  });
  const result = await finished(client, 'disconnected-start');
  assert.equal(result.phase, 'done', result.reason);
  assert.equal((await client.status('task')).identity?.instanceId, result.result?.identity?.instanceId);
});

test('wrong drain acknowledgement identity is unknown and never starts the target', async t => {
  const { client, first, install, set, catalog } = await fixture(t);
  await start(client, first);
  const next = install('2.0.0');
  set({ busy: true, wrongDrainIdentity: true });
  await client.submit({ operationId: 'wrong-drain-id', id: 'task', action: 'apply', version: '2.0.0', digest: next.digest });
  const result = await finished(client, 'wrong-drain-id');
  assert.equal(result.phase, 'unknown');
  assert.match(result.reason!, /different or incomplete/);
  assert.equal(readdirSync(catalog.dataDirectory('task')).filter(file => file.startsWith('launch-')).length, 1);
});

test('target tampering during a busy drain is reverified before replacement launch', async t => {
  const { client, first, install, set, catalog } = await fixture(t);
  await start(client, first);
  const next = install('2.0.0');
  set({ busy: true });
  await client.submit({ operationId: 'tamper-during-drain', id: 'task', action: 'apply', version: '2.0.0', digest: next.digest });
  await waiting(client, 'tamper-during-drain');
  writeFileSync(join(next.release, 'service.mjs'), 'throw new Error("modified");');
  set({});
  const result = await finished(client, 'tamper-during-drain');
  assert.equal(result.phase, 'failed');
  assert.match(result.reason!, /integrity/);
  assert.equal(readdirSync(catalog.dataDirectory('task')).filter(file => file.startsWith('launch-')).length, 1);
});

test('new unhealthy runtime observation fences further mutations even if health later recovers', async t => {
  const { client, first, set } = await fixture(t);
  await start(client, first);
  set({ unhealthy: true });
  const unhealthy = await client.status('task');
  assert.equal(unhealthy.status, 'unknown');
  assert.equal(unhealthy.recoveryRequired, true);
  set({});
  const restored = await client.status('task');
  assert.equal(restored.status, 'running', 'current upstream health can recover without clearing the durable uncertainty fence');
  assert.equal(restored.recoveryRequired, true);
  await assert.rejects(client.submit({ operationId: 'health-recovery-retry', id: 'task', action: 'start' }), /recovery/);
});

test('activation disabled after launch still allows explicit graceful stop, never another start', async t => {
  const { client, first, catalog } = await fixture(t);
  await start(client, first);
  catalog.updateConfig('task', { activationEnabled: false }, 1);
  await assert.rejects(client.submit({ operationId: 'disabled-live-start', id: 'task', action: 'start' }), /activationEnabled/);
  const receipt = await client.submit({ operationId: 'disabled-live-stop', id: 'task', action: 'stop' });
  assert.equal(receipt.phase, 'accepted');
  assert.equal((await finished(client, receipt.command.operationId)).phase, 'done');
  assert.equal((await client.status('task')).status, 'stopped');
  assert.equal(catalog.readConfig('task').values.activationEnabled, false);
});

test('pre-existing socket path is never removed as stale cleanup', async t => {
  const { runner, userRoot } = await fixture(t);
  await runner.close();
  const path = join(userRoot, '.module-runner.sock');
  writeFileSync(path, 'operator must inspect', { mode: 0o600 });
  await assert.rejects(ModuleSupervisor.start({ userRoot }), /requires explicit inspection/);
  assert.equal(readFileSync(path, 'utf8'), 'operator must inspect');
  assert.equal(existsSync(join(userRoot, '.module-runner.lock')), false);
});

test('WeChat unified identity, config, port and unauthenticated declared drain match its actual contract', async t => {
  const { client, first, catalog, config } = await fixture(t, 1500, 'wechat');
  const accepted = await client.submit({ operationId: 'wechat-start-0001', id: 'wechat', action: 'start', version: first.manifest.version, digest: first.digest });
  assert.equal(accepted.phase, 'accepted');
  const started = await finished(client, accepted.command.operationId);
  assert.equal(started.phase, 'done', started.reason);
  const wire = await (await fetch(`${config.serviceUrl}/version`)).json();
  assert.equal(wire.version, first.manifest.version);
  assert.equal(wire.moduleVersion, wire.version);
  assert.equal(started.result?.identity?.moduleVersion, wire.version);
  const launch = JSON.parse(readFileSync(join(catalog.dataDirectory('wechat'), `launch-${started.result!.identity!.instanceId}.json`), 'utf8'));
  assert.deepEqual(launch.argv, ['run', '--config', config.configFile]);
  assert.equal(launch.env.COCKPIT_MODULE_PORT, new URL(config.serviceUrl!).port);
  assert.equal(launch.env.COCKPIT_API_TOKEN, undefined);
  assert.equal(launch.env.WORK_MODULE_MANAGER_CREDENTIAL, undefined);
  await client.submit({ operationId: 'wechat-stop-0001', id: 'wechat', action: 'stop' });
  assert.equal((await finished(client, 'wechat-stop-0001')).phase, 'done');
  const drain = JSON.parse(readFileSync(join(catalog.dataDirectory('wechat'), 'drain-request.json'), 'utf8'));
  assert.equal(drain.path, '/admin/restart');
  assert.deepEqual(drain.body, { pending: true });
  assert.equal(drain.authorization, undefined);
});

test('WeChat cannot contradict its actual version with a different moduleVersion alias', async t => {
  const { client, first, set } = await fixture(t, 1500, 'wechat');
  await client.submit({ operationId: 'wechat-alias-start', id: 'wechat', action: 'start', version: first.manifest.version, digest: first.digest });
  assert.equal((await finished(client, 'wechat-alias-start')).phase, 'done');
  set({ contradictoryVersion: true });
  const status = await client.status('wechat');
  assert.equal(status.status, 'unknown');
  assert.equal(status.recoveryRequired, true);
});

test('WeChat requires the unified moduleVersion alias and does not downgrade to version-only identity', async t => {
  const { client, first, set } = await fixture(t, 1500, 'wechat');
  await client.submit({ operationId: 'wechat-required-alias', id: 'wechat', action: 'start', version: first.manifest.version, digest: first.digest });
  assert.equal((await finished(client, 'wechat-required-alias')).phase, 'done');
  set({ omitModuleVersion: true });
  const status = await client.status('wechat');
  assert.equal(status.status, 'unknown');
  assert.equal(status.recoveryRequired, true);
});
