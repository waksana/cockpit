import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DeploymentConfig, DeploymentPlan, DeploymentReceipt, type PinnedRelease, type ReleaseTarget } from './contracts.ts';
import { hash, privateDirectory } from './files.ts';
import { GithubReleases } from './releases.ts';
import { DeploymentStore } from './store.ts';
import { DeploymentRunner } from './runner.ts';
import { createDeploymentService } from './service.ts';
import { installRuntime, verifyRuntime } from './runtime-package.ts';
import { installLocalModule, readModuleSettings, selectModule } from '../module-install.ts';
import { snapshotData } from './data.ts';
import type { HostManager, ServiceState } from './systemd.ts';
import { removeFixture } from '../test-support/module-fixture.ts';

const token = 'fixture-only-deployment-token-0123456789';
const authorization = { authorization: `Bearer ${token}` };
const hostFixture = fileURLToPath(new URL('../test-support/deployment-host.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const sha = (letter: string) => letter.repeat(40);
const targets = new Map<string, { target: ReleaseTarget; bytes: Buffer; assetId: number }>();

async function put(root: string, path: string, bytes: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), bytes, { mode: 0o644 });
  await chmod(join(root, path), 0o644);
}

async function archive(root: string, name: string, files: Record<string, string>) {
  const source = join(root, name);
  await mkdir(source);
  for (const [path, bytes] of Object.entries(files)) await put(source, path, bytes);
  const path = join(root, `${name}.tgz`);
  execFileSync('tar', ['--format=gnu', '--hard-dereference', '-czf', path, '-C', source, '.']);
  return { source, path, bytes: await readFile(path) };
}

async function hostArchive(root: string, version: string, sourceSha: string, fail = false) {
  const files = {
    'package.json': JSON.stringify({ type: 'module', version }),
    'apps/server/dist/index.js': fail ? 'process.exit(7);' : `
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from ${JSON.stringify(hostFixture)};
await startFixture(resolve(fileURLToPath(new URL('../../../', import.meta.url))));
`,
    'apps/server/dist/module-cli.js': 'export {};',
    'packages/protocol/dist/index.js': 'export const Intents = {"session/new":{}, "session/resources-prepare":{}};',
    'packages/core/package.json': JSON.stringify({ dependencies: { '@github/copilot-sdk': '1.0.13' } }),
    'apps/web/dist/index.html': `<!doctype html><title>${version}</title><script src="/assets/app.js"></script>`,
    'apps/web/dist/assets/app.js': `console.log(${JSON.stringify(version)});`,
  };
  const manifest = {
    format: 1, product: 'cockpit', version, sourceSha, node: process.versions.node, platform: 'linux', arch: 'x64',
    files: Object.entries(files).map(([path, bytes]) => ({ path, type: 'file', mode: '0644', size: Buffer.byteLength(bytes), sha256: hash(bytes) })),
  };
  return archive(root, `host-${version}`, { ...files, 'runtime-manifest.json': JSON.stringify(manifest) });
}

async function moduleArchive(root: string, id: string, version: string, migration: 'good' | 'bad' | 'preflight-fail' = 'good') {
  return archive(root, `${id}-${version}`, {
    'package.json': '{"type":"module"}',
    'cockpit.module.json': JSON.stringify({ apiVersion: 1, id, name: id, version, backend: 'backend.js',
      frontend: { entry: 'web/index.js', assets: ['web'] } }),
    'backend.js': 'export function activate() { return {routes:[]}; }',
    'web/index.js': 'export const marker = "synthetic-module";',
    'migrate.mjs': `
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const data = process.argv[process.argv.indexOf('--data-root')+1];
const db = new DatabaseSync(join(data,'records.sqlite'));
if (process.argv.includes('--preflight')) {
  process.stdout.write(JSON.stringify({ready:${migration !== 'preflight-fail'}}));
} else {
  db.exec(${JSON.stringify(migration === 'bad' ? 'PRAGMA user_version=2; DELETE FROM records;' : 'PRAGMA user_version=2;')});
  process.stdout.write(JSON.stringify({migrated:true}));
}
db.close();
`,
  });
}

function releaseTarget(repository: string, version: string, sourceSha: string, bytes: Buffer): ReleaseTarget {
  const target = { repository, tag: `v${version}`, version, sourceSha, asset: 'runtime.tgz', sha256: hash(bytes) };
  targets.set(`${repository}/${target.tag}`, { target, bytes, assetId: targets.size + 1 });
  return target;
}

const githubFetch: typeof fetch = async input => {
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
  for (const { target, bytes, assetId } of targets.values()) {
    const base = `/repos/${target.repository}`;
    if (path === `${base}/releases/tags/${target.tag}`) return Response.json({
      id: assetId, tag_name: target.tag, draft: false, prerelease: false, published_at: '2026-09-26T00:00:00Z',
      assets: [{ id: assetId, name: target.asset, size: bytes.length }],
    });
    if (path === `${base}/git/ref/tags/${target.tag}`) return Response.json({ object: { type: 'commit', sha: target.sourceSha } });
    if (path === `${base}/releases/assets/${assetId}`) return new Response(new Uint8Array(bytes));
  }
  return new Response('No fixture', { status: 404 });
};

class FixtureHost implements HostManager {
  child?: ChildProcess;
  stopped = false;
  starts = 0;
  stops = 0;
  constructor(readonly config: DeploymentConfig) {}
  async inspect(): Promise<ServiceState> {
    return this.child && this.child.exitCode === null && this.child.signalCode === null
      ? { pid: this.child.pid!, active: this.stopped ? 'deactivating' : 'active', sub: this.stopped ? 'stop-sigterm' : 'running' }
      : { pid: 0, active: 'inactive', sub: 'dead' };
  }
  async start() {
    this.starts++;
    this.stopped = false;
    this.child = spawn(this.config.host.node, ['--import', tsx, '--enable-source-maps', join(this.config.host.currentLink, 'apps/server/dist/index.js')], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: this.config.host.installRoot,
      env: {
        PATH: '/usr/bin:/bin', HOME: this.config.host.home, COCKPIT_HOME: this.config.host.home,
        COPILOT_HOME: join(this.config.host.home, 'synthetic-native'), COCKPIT_PORT: new URL(this.config.host.origin).port,
      },
    });
    this.child.stderr?.on('data', () => {});
  }
  async stop() {
    this.stops++;
    this.stopped = true;
    this.child?.kill('SIGTERM');
  }
  async dispose() {
    await rm(join(this.config.host.home, 'fixture-busy'), { force: true });
    await this.stop();
    if (this.child?.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>(resolve => this.child!.once('exit', () => resolve()));
    }
  }
}

async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function eventually(check: () => Promise<boolean>, message: string, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(message);
}

async function fixture(t: TestContext, options: { failStart?: boolean; migration?: 'good' | 'bad' | 'preflight-fail'; badDigest?: boolean; unchanged?: boolean } = {}) {
  targets.clear();
  const root = await mkdtemp(join(tmpdir(), 'cockpit-deployment-test-'));
  const owned: { closeService?: () => Promise<void>; manager?: FixtureHost } = {};
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    await owned.closeService?.(); await owned.manager?.dispose(); await removeFixture(root);
  });
  const home = join(root, 'home'), installs = join(root, 'installs'), plans = join(root, 'plans'), state = join(root, 'state');
  for (const path of [home, installs, plans, state]) await privateDirectory(path);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const config = DeploymentConfig.parse({
    format: 1, stateRoot: state, plansRoot: plans, tokenFile, port: 0,
    host: { origin: `http://127.0.0.1:${await port()}`, home, installRoot: installs, currentLink: join(installs, 'current'),
      node: process.execPath, service: { scope: 'user', unit: 'synthetic.service', systemctl: '/usr/bin/systemctl' } },
    limits: { requestMs: 10000, startMs: options.failStart ? 500 : 10000, hookMs: 10000 },
  });
  const oldVersion = options.unchanged ? '0.0.2' : '0.0.1';
  const old = await hostArchive(root, oldVersion, sha(options.unchanged ? 'b' : 'a'));
  const next = options.unchanged ? old : await hostArchive(root, '0.0.2', sha('b'), options.failStart);
  const oldTarget = releaseTarget('fixture/cockpit', oldVersion, sha(options.unchanged ? 'b' : 'a'), old.bytes);
  const target = releaseTarget('fixture/cockpit', '0.0.2', sha('b'), next.bytes);
  const releases = new GithubReleases(10000, githubFetch);
  const oldRoot = await installRuntime(old.path, await releases.pin(oldTarget), installs);
  await symlink(oldRoot, config.host.currentLink);
  const moduleOld = await moduleArchive(root, 'fixture-module', oldVersion);
  const moduleNew = options.unchanged ? moduleOld : await moduleArchive(root, 'fixture-module', '0.0.2', options.migration);
  const moduleOff = await moduleArchive(root, 'disabled-module', '0.0.1');
  const m = await installLocalModule(moduleOld.path, { hostRoot: home, trustLocalCode: true, enable: true });
  const off = await installLocalModule(moduleOff.path, { hostRoot: home, trustLocalCode: true });
  await selectModule('fixture-module', { hostRoot: home, enabled: true, version: m.manifest.version, digest: m.digest, config: { retained: 'private fixture value' } });
  await selectModule('disabled-module', { hostRoot: home, enabled: false, version: off.manifest.version, digest: off.digest, config: { keep: true } });
  await mkdir(join(home, 'modules/data/fixture-module'), { recursive: true });
  await writeFile(join(home, 'config.json'), '{"schemaVersion":1,"revision":1,"values":{"sessionDefaults":{"modelId":"fixture"}}}');
  await mkdir(join(home, 'session-roles'));
  await writeFile(join(home, 'session-roles/synthetic.json'), '{"sessionId":"synthetic","roles":[]}');
  const database = join(home, 'modules/data/fixture-module/records.sqlite');
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO records VALUES (\'existing-task\', \'preserved\');');
  if (options.unchanged) db.exec('PRAGMA user_version=2');
  db.close();
  const plan = DeploymentPlan.parse({
    format: 1, id: 'fixture-plan', host: options.badDigest ? { ...target, sha256: 'f'.repeat(64) } : target,
    reviewedBy: 'isolated-test', writers: 'only-the-managed-host',
    modules: {
      'fixture-module': {
        release: releaseTarget('fixture/module', '0.0.2', sha('c'), moduleNew.bytes), compatibleHost: '0.0.2',
        requiredIntents: ['session/new'], databases: [{ path: 'records.sqlite', schema: 2, preserve: [{ table: 'records', columns: ['id', 'value'] }] }],
        migrations: [{ database: 'records.sqlite', from: 1, to: 2, nondestructive: true,
          preflight: { entry: 'migrate.mjs', args: ['--data-root', { path: 'data' }, '--preflight'], expected: { ready: true } },
          apply: { entry: 'migrate.mjs', args: ['--data-root', { path: 'data' }], expected: { migrated: true } } }],
      },
      'disabled-module': {
        release: releaseTarget('fixture/disabled', '0.0.1', sha('d'), moduleOff.bytes),
        compatibleHost: '0.0.2', requiredIntents: [], databases: [],
      },
    },
  });
  const bytes = Buffer.from(JSON.stringify(plan));
  await writeFile(join(plans, 'fixture-plan.json'), bytes, { mode: 0o600 });
  const manager = new FixtureHost(config);
  owned.manager = manager;
  await manager.start();
  await eventually(async () => {
    try { return (await fetch(`${config.host.origin}/health`)).ok; } catch { return false; }
  }, 'old synthetic host must be responsive');
  const store = new DeploymentStore(state);
  const runner = new DeploymentRunner(config, store, manager, releases);
  const service = await createDeploymentService(config, runner);
  owned.closeService = async () => { await service.app.close(); };
  const serviceOrigin = await service.app.listen({ host: '127.0.0.1', port: 0 });
  const input = { requestId: 'fixture-run', planId: plan.id, planSha256: hash(bytes) };
  return { root, config, plan, bytes, manager, service, serviceOrigin, store, runner, input, database, oldRoot, oldTarget, cleanup };
}

test('HTTP trigger automatically prepares, waits for real host exit, migrates and accepts a different process', async t => {
  const f = await fixture(t);
  await writeFile(join(f.config.host.home, 'fixture-busy'), 'busy');
  const oldPid = (await f.manager.inspect()).pid;
  const initial = await readModuleSettings(f.config.host.home);
  const response = await fetch(`${f.serviceOrigin}/runs`, {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify(f.input),
  });
  assert.equal(response.status, 202);
  assert.equal(DeploymentReceipt.parse(await response.json()).state, 'running');
  await eventually(async () => (await f.store.read(f.input.requestId)).phase === 'stopping', 'shutdown must be requested after preparation');
  assert.equal((await f.manager.inspect()).pid, oldPid);
  await eventually(async () => z.object({ phase: z.string() }).parse(await fetch(`${f.config.host.origin}/status`).then(value => value.json())).phase === 'waiting',
    'the persisted attempt is followed by the real host entering graceful waiting');
  assert.equal(await realpath(f.config.host.currentLink), f.oldRoot);
  const replay = await f.service.app.inject({ method: 'POST', url: '/runs', headers: authorization, payload: f.input });
  assert.equal(replay.statusCode, 200);
  const concurrent = await f.service.app.inject({ method: 'POST', url: '/runs', headers: authorization, payload: { ...f.input, requestId: 'second-run' } });
  assert.equal(concurrent.statusCode, 409);
  const cancel = await f.service.app.inject({ method: 'POST', url: `/runs/${f.input.requestId}/cancel`, headers: authorization, payload: {} });
  assert.equal(cancel.statusCode, 409);
  await rm(join(f.config.host.home, 'fixture-busy'));
  await f.service.active;
  const result = await f.store.read(f.input.requestId);
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.notEqual(result.newInstance?.pid, oldPid);
  assert.notEqual(result.newInstance?.instanceId, result.oldInstance?.instanceId);
  assert.equal(f.manager.stops, 1, 'duplicates never request another shutdown');
  assert.equal(f.manager.starts, 2, 'the original process plus one replacement');
  const selected = await readModuleSettings(f.config.host.home);
  assert.deepEqual(selected.selected['fixture-module']?.config, initial.selected['fixture-module']?.config);
  assert.equal(selected.selected['disabled-module']?.enabled, false);
  assert.equal(selected.selected['disabled-module']?.digest, initial.selected['disabled-module']?.digest);
  const db = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(db.prepare('SELECT value FROM records').get()?.value, 'preserved');
  db.close();
  const backup = new DatabaseSync(join(result.backups[1]!, 'records.sqlite'), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 1);
  backup.close();
  assert.equal(result.checks.some(check => check.status === 'not-covered'), true);
  t.diagnostic(JSON.stringify({ old: result.oldInstance, next: result.newInstance, phases: result.events.map(event => event.phase),
    backups: result.backups.length, checks: result.checks }));
});

test('an already loaded target is accepted without another shutdown, migration or restart', async t => {
  const f = await fixture(t, { unchanged: true });
  const before = await realpath(f.config.host.currentLink);
  const response = await f.service.app.inject({ method: 'POST', url: '/runs', headers: authorization, payload: f.input });
  assert.equal(response.statusCode, 202);
  await f.service.active;
  const result = await f.store.read(f.input.requestId);
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.changed, false);
  assert.equal(f.manager.stops, 0);
  assert.equal(f.manager.starts, 1);
  assert.equal(await realpath(f.config.host.currentLink), before);
  assert.equal(result.events.some(event => event.phase === 'migrating'), false);
});

test('missing capability and undeclared compatibility refuse before stopping the existing host', async t => {
  const f = await fixture(t);
  const incompatible = structuredClone(f.plan);
  incompatible.modules['fixture-module']!.compatibleHost = '9.9.9';
  const file = join(f.config.plansRoot, 'fixture-plan.json');
  let bytes = JSON.stringify(incompatible);
  await writeFile(file, bytes, { mode: 0o600 });
  const rejected = await f.service.app.inject({
    method: 'POST', url: '/runs', headers: authorization, payload: { ...f.input, planSha256: hash(bytes) },
  });
  assert.equal(rejected.statusCode, 400);
  const missing = structuredClone(f.plan);
  missing.modules['fixture-module']!.requiredIntents.push('absent/capability');
  bytes = JSON.stringify(missing);
  await writeFile(file, bytes, { mode: 0o600 });
  const accepted = await f.service.app.inject({
    method: 'POST', url: '/runs', headers: authorization, payload: { ...f.input, planSha256: hash(bytes) },
  });
  assert.equal(accepted.statusCode, 202);
  await f.service.active;
  assert.match((await f.store.read(f.input.requestId)).error ?? '', /capability/);
  assert.equal(f.manager.stops, 0);
});

for (const [name, options, phase, stops] of [
  ['bad archive', { badDigest: true }, 'preparing', 0],
  ['preflight refusal', { migration: 'preflight-fail' as const }, 'preparing', 0],
  ['startup failure', { failStart: true }, 'starting', 1],
  ['lost records', { migration: 'bad' as const }, 'verifying', 1],
] as const) {
  test(`${name} leaves a truthful independent final receipt without automatic rollback`, async t => {
    const f = await fixture(t, options);
    const response = await f.service.app.inject({ method: 'POST', url: '/runs', headers: authorization, payload: f.input });
    assert.equal(response.statusCode, 202);
    await f.service.active;
    const result = await f.store.read(f.input.requestId);
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.equal(result.phase, phase, JSON.stringify(result));
    assert.equal(f.manager.stops, stops);
    assert.equal(result.attentionRequired, stops > 0);
    assert.ok(result.error);
    const get = await f.service.app.inject({ method: 'GET', url: `/runs/${f.input.requestId}`, headers: authorization });
    assert.equal(get.statusCode, 200, 'receipt remains available even when the target host is down');
    if (phase === 'preparing') assert.equal(await realpath(f.config.host.currentLink), f.oldRoot);
  });

}

test('two independently configured services cannot deploy to the same host concurrently', async t => {
  const f = await fixture(t);
  const second = { ...f.config, stateRoot: join(f.root, 'second-state') };
  await assert.rejects(createDeploymentService(second), /manages this host/);
  assert.equal(f.manager.stops, 0);
});

test('a killed deployment-service process recovers a readable interrupted result without replay', async t => {
  const f = await fixture(t);
  await f.service.app.close();
  const configFile = join(f.root, 'deployment-config.json');
  await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
  const helper = fileURLToPath(new URL('../test-support/deployment-service-process.ts', import.meta.url));
  let child: ChildProcess | undefined;
  const close = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await done;
  };
  f.cleanup.push(close);
  const launch = async () => {
    let origin: string | undefined;
    const claimed: string[] = [];
    child = spawn(process.execPath, ['--import', tsx, helper, configFile], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: '/usr/bin:/bin', HOME: f.root, COPILOT_HOME: join(f.root, 'native'), COCKPIT_HOME: f.config.host.home },
    });
    child.stderr?.on('data', () => {});
    child.on('message', value => {
      const event = z.object({ origin: z.string().optional(), claimed: z.string().optional() }).parse(value);
      if (event.origin) origin = event.origin;
      if (event.claimed) claimed.push(event.claimed);
    });
    await eventually(async () => !!origin, 'independent deployment process must listen');
    return { origin: origin!, claimed, pid: child.pid! };
  };
  const first = await launch();
  const accepted = await fetch(`${first.origin}/runs`, {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify(f.input),
  });
  assert.equal(accepted.status, 202);
  await eventually(async () => first.claimed.length === 1, 'work claim must be durably recorded before interruption');
  await close();
  const second = await launch();
  assert.notEqual(second.pid, first.pid);
  const result = DeploymentReceipt.parse(await fetch(`${second.origin}/runs/${f.input.requestId}`, { headers: authorization }).then(response => response.json()));
  assert.equal(result.state, 'interrupted');
  assert.equal(result.attentionRequired, true);
  assert.equal(result.phase, 'prepared');
  const duplicate = await fetch(`${second.origin}/runs`, {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify(f.input),
  });
  assert.equal(duplicate.status, 200);
  assert.equal(DeploymentReceipt.parse(await duplicate.json()).state, 'interrupted');
  assert.deepEqual(second.claimed, [], 'startup and request replay never run the interrupted job');
  const cli = fileURLToPath(new URL('../deployment-cli.ts', import.meta.url));
  const offline = execFileSync(process.execPath, ['--import', tsx, cli, 'read-receipt', f.config.stateRoot, f.input.requestId], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(DeploymentReceipt.parse(JSON.parse(offline)).state, 'interrupted');
  assert.equal(f.manager.stops, 0, 'the interruption fixture never touches the already running synthetic host');
});

test('authentication, input binding and recovery never turn interrupted work into a repeat', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.app.inject({ method: 'POST', url: '/runs', payload: f.input })).statusCode, 401);
  assert.equal((await f.service.app.inject({ method: 'POST', url: '/runs', headers: { ...authorization, origin: 'http://evil.invalid' }, payload: f.input })).statusCode, 403);
  const receipt = await f.store.create(f.input.requestId, f.plan, f.bytes);
  await f.store.save(receipt, 'switching');
  await f.store.initialize();
  const recovered = await f.store.read(f.input.requestId);
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.attentionRequired, true);
  assert.equal((await f.service.app.inject({ method: 'POST', url: '/runs', headers: authorization, payload: { ...f.input, requestId: 'another-run' } })).statusCode, 409);
  assert.equal((await f.service.app.inject({ method: 'POST', url: '/runs', headers: authorization, payload: { ...f.input, planSha256: 'a'.repeat(64) } })).statusCode, 409);
  assert.equal(f.manager.stops, 0);
  assert.equal((await readdir(join(f.config.stateRoot, 'runs'))).length, 1);
});

test('SQLite backup includes committed WAL and fails on undeclared databases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-deployment-wal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const db = new DatabaseSync(join(source, 'records.sqlite'));
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=3; CREATE TABLE records(id TEXT); INSERT INTO records VALUES (\'committed-wal\');');
  const target: DeploymentPlan['modules'][string] = {
    release: { repository: 'fixture/module', tag: 'v0.0.1', version: '0.0.1', sourceSha: sha('a'), sha256: 'b'.repeat(64), asset: 'module.tgz' },
    compatibleHost: '0.0.1', requiredIntents: [], databases: [{ path: 'records.sqlite', schema: 3, preserve: [] }], migrations: [],
  };
  await snapshotData(source, join(root, 'copy'), target, 1024 ** 2);
  const copied = new DatabaseSync(join(root, 'copy/records.sqlite'), { readOnly: true });
  assert.equal(copied.prepare('SELECT id FROM records').get()?.id, 'committed-wal');
  copied.close();
  await assert.rejects(snapshotData(source, join(root, 'undeclared'), { ...target, databases: [] }, 1024 ** 2), /Undeclared/);
});

test('release/source and runtime identity checks are independent of HTTP health', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-deployment-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const built = await hostArchive(root, '0.0.1', sha('a'));
  const target = releaseTarget('identity/host', '0.0.1', sha('a'), built.bytes);
  const releases = new GithubReleases(1000, githubFetch);
  await assert.rejects(releases.pin({ ...target, sourceSha: sha('b') }), /source commit/);
  const pin: PinnedRelease = await releases.pin(target);
  const installed = await installRuntime(built.path, pin, join(root, 'installs'));
  await put(installed, 'apps/web/dist/assets/app.js', 'changed');
  await assert.rejects(verifyRuntime(installed, pin), /integrity/);
});
