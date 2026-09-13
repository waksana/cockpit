import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CopilotSession } from '@github/copilot-sdk';
import type { ModuleSelection } from '@cockpit/protocol';
import { OfficialRuntime } from '../runtime.ts';
import { ModuleManager } from './manager.ts';
import type { ModuleManifest } from './catalog.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'module-initialization-'));
  const userRoot = join(root, 'user'), cwd = join(root, 'project'), credentials = join(root, 'credentials');
  mkdirSync(cwd, { mode: 0o700 }); mkdirSync(credentials, { mode: 0o700 });
  const managerCredentialFile = join(root, 'manager.json');
  writeFileSync(managerCredentialFile, JSON.stringify({ token: 'synthetic-manager-credential' }), { mode: 0o600 });
  const principals = new Map<string, { sessionId: string; credentialFile: string; token: string; revoked: boolean }>();
  const calls = { provisions: [] as Array<{ requestId: string; sessionId: string }>, reads: 0, mints: 0 };
  let loseReply = false;
  let replaceDuringRead = false;
  const server = createServer(async (request, response) => {
    if (Object.keys(request.headers).some(name => ['origin', 'referer'].includes(name) || name.startsWith('sec-fetch-'))) {
      response.writeHead(403); response.end('Nonbrowser client required'); return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/version' || request.url === '/health') {
      response.end(JSON.stringify({ moduleApi: 1, instanceId: 'synthetic-task-instance', ok: true }));
    } else if (request.url === '/admin/module/caller') {
      assert.equal(request.headers.authorization, 'Bearer synthetic-manager-credential');
      const body: { requestId: string; sessionId: string } = JSON.parse(raw);
      calls.provisions.push(body);
      let principal = principals.get(body.requestId);
      if (!principal) {
        calls.mints++;
        const credentialFile = join(credentials, `module-caller-${createHash('sha256').update(body.requestId).digest('hex')}.json`);
        principal = { sessionId: body.sessionId, credentialFile, token: randomUUID(), revoked: false };
        principals.set(body.requestId, principal);
        writeFileSync(credentialFile, JSON.stringify({ token: principal.token }), { mode: 0o600 });
      }
      assert.equal(principal.sessionId, body.sessionId);
      if (loseReply) { response.destroy(); return; }
      response.end(JSON.stringify({ credentialFile: principal.credentialFile }));
    } else if (request.url === '/api/read') {
      calls.reads++;
      assert.deepEqual(JSON.parse(raw), { view: 'summary', limit: 1, before: 1 });
      const token = request.headers.authorization?.slice(7);
      if (![...principals.values()].some(principal => principal.token === token && !principal.revoked)) {
        response.writeHead(401); response.end('{}'); return;
      }
      if (replaceDuringRead) {
        const principal = [...principals.values()].find(value => value.token === token)!;
        writeFileSync(principal.credentialFile, JSON.stringify({ token: randomUUID() }), { mode: 0o600 });
      }
      response.end(JSON.stringify({ items: [], nextBefore: null }));
    } else {
      response.writeHead(404); response.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const runtime = new OfficialRuntime();
  Object.defineProperty(runtime, 'rpc', { get: () => ({
    skills: { discover: async () => ({ skills: [] }) },
    mcp: { discover: async () => ({ servers: [] }) },
    user: { settings: { get: async () => ({ settings: { disabledSkills: { value: [] } } }) } },
  }) });
  const sources = { task: join(root, 'task'), wechat: join(root, 'wechat') };
  for (const source of Object.values(sources)) mkdirSync(source, { mode: 0o700 });
  const makeManager = () => new ModuleManager({ userRoot, runtime, sources });
  const manager = makeManager();
  for (const id of ['task', 'wechat'] as const) {
    for (const version of ['1.0.0', '2.0.0']) {
      const manifest: ModuleManifest = { schemaVersion: 1, id, version, name: id, description: 'Offline integration fixture',
        compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
        roles: id === 'task' ? ['commander', 'owner'].map(roleId => ({ id: roleId, name: roleId, description: roleId,
          mcp: { work: { entry: 'mcp.mjs' } } })) : [{ id: 'binding', name: 'Binding', description: 'Binding' }] };
      writeFileSync(join(sources[id], 'module.json'), JSON.stringify(manifest));
      if (id === 'task') writeFileSync(join(sources[id], 'mcp.mjs'), 'export {};\n');
      else {
        mkdirSync(join(sources[id], 'src'), { recursive: true });
        copyFileSync(new URL('./manager-initialization-wechat.fixture.mjs', import.meta.url), join(sources[id], 'src/module-control.js'));
        writeFileSync(join(sources[id], 'package.json'), '{"type":"module"}');
      }
      manager.catalog.installFromDirectory(sources[id]);
    }
  }
  manager.catalog.updateConfig('task', { serviceUrl, credentialDirectory: credentials, managerCredentialFile }, 0);
  const configFile = join(root, 'wechat.json'), modeFile = join(root, 'wechat-mode.json'), stateFile = join(root, 'wechat-state.json');
  const callsFile = join(root, 'wechat-calls.jsonl');
  writeFileSync(configFile, JSON.stringify({ stateFile, modeFile, callsFile }), { mode: 0o600 });
  writeFileSync(modeFile, '{}', { mode: 0o600 });
  writeFileSync(stateFile, JSON.stringify({ boundSessionId: null, revision: 0 }), { mode: 0o600 });
  manager.catalog.updateConfig('wechat', { configFile }, 0);
  // Only this synthetic SDK boundary is cast; no native service is started.
  const session = { rpc: { metadata: { snapshot: async () => ({ workingDirectory: cwd }) },
    mcp: { list: async () => ({ servers: [{ name: 'work', status: 'connected' }] }) } } } as unknown as CopilotSession;
  const sessionId = randomUUID();
  const task = (version = '1.0.0', roleId = 'commander'): ModuleSelection => ({ moduleId: 'task', roleId, version });
  const wechat = (version = '1.0.0'): ModuleSelection => ({ moduleId: 'wechat', roleId: 'binding', version });
  async function apply(selections: ModuleSelection[], operationId: string, target = manager) {
    await target.prepare(sessionId, cwd, selections, operationId);
    await target.configuration(sessionId, cwd, true);
    try { await target.connected(sessionId, session, true); }
    catch (error) { await target.failed(sessionId, error); throw error; }
  }
  const accessFile = join(userRoot, 'data/task/session-access', `${sessionId}.json`);
  const receiptFile = (id: 'task' | 'wechat') => join(userRoot, `data/${id}/session-initialization`, `${sessionId}.json`);
  const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const binds = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(call => call.operation === 'bind') : [];
  return { root, userRoot, cwd, configFile, modeFile, stateFile, manager, makeManager, session, sessionId,
    calls, principals, credentials, serviceUrl, managerCredentialFile, task, wechat, apply, accessFile, receiptFile, json, binds,
    mode(value: object) { writeFileSync(modeFile, JSON.stringify(value), { mode: 0o600 }); },
    loseReply() { loseReply = true; }, replaceDuringRead() { replaceDuringRead = true; } };
}

test('version apply, cold load and commander-owner-commander reuse one caller and one WeChat binding', async t => {
  const f = await fixture(t);
  await f.apply([f.task(), f.wechat()], 'initial-operation');
  const reference = readFileSync(f.accessFile, 'utf8');
  const initialTask = f.json(f.receiptFile('task')), initialWechat = f.json(f.receiptFile('wechat'));
  assert.equal(statSync(f.receiptFile('task')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.userRoot, 'data/task/session-initialization')).mode & 0o777, 0o700);
  f.mode({ running: true });
  await f.apply([f.task('2.0.0'), f.wechat('2.0.0')], 'version-operation');
  const reopened = f.makeManager();
  await reopened.configuration(f.sessionId, f.cwd, false);
  await reopened.connected(f.sessionId, f.session, false);
  await f.apply([f.task('2.0.0', 'owner'), f.wechat('2.0.0')], 'owner-operation');
  const owner = await f.manager.configuration(f.sessionId, f.cwd, false);
  const work = owner.mcpServers?.work;
  assert.ok(work && 'env' in work);
  assert.equal(work.env?.COCKPIT_TASK_ACCESS_FILE, undefined, 'caller access must not enter owner MCP environment');
  assert.equal(f.manager.catalog.getSession(f.sessionId)?.configRefs?.task?.accessFile, f.accessFile);
  rmSync(f.managerCredentialFile);
  await f.apply([f.task(), f.wechat()], 'commander-operation', reopened);
  assert.equal(readFileSync(f.accessFile, 'utf8'), reference);
  assert.deepEqual(f.json(f.receiptFile('task')), initialTask);
  assert.deepEqual(f.json(f.receiptFile('wechat')), initialWechat);
  assert.deepEqual(f.calls.provisions, [{ requestId: 'initial-operation', sessionId: f.sessionId }]);
  assert.equal(f.calls.mints, 1);
  assert.equal(f.binds().length, 1);
  assert.ok(f.calls.reads > 1, 'reused credentials are checked at the service, not only for file existence');
});

test('Task identity drift, missing/revoked credentials and unsafe or legacy access fail without provisioning', async t => {
  for (const failure of ['service', 'directory', 'credential-missing', 'credential-replaced', 'revoked',
    'access-missing', 'access-session', 'access-public', 'access-symlink', 'receipt-missing', 'legacy-owner']) {
    await t.test(failure, async inner => {
      const f = await fixture(inner);
      await f.apply([f.task()], 'initial-operation');
      const principal = f.principals.get('initial-operation')!;
      if (failure === 'service' || failure === 'directory') {
        const config = f.manager.catalog.readConfig('task');
        const alternate = join(f.root, 'alternate');
        mkdirSync(alternate, { mode: 0o700 });
        f.manager.catalog.updateConfig('task', { ...config.values,
          ...(failure === 'service' ? { serviceUrl: 'http://127.0.0.1:1' } : { credentialDirectory: alternate }) }, config.revision);
      } else if (failure === 'credential-missing') rmSync(principal.credentialFile);
      else if (failure === 'credential-replaced') writeFileSync(principal.credentialFile, JSON.stringify({ token: randomUUID() }));
      else if (failure === 'revoked') principal.revoked = true;
      else if (failure === 'access-missing') rmSync(f.accessFile);
      else if (failure === 'access-session') writeFileSync(f.accessFile, JSON.stringify({ ...f.json(f.accessFile), sessionId: 'another-session' }));
      else if (failure === 'access-public') chmodSync(f.accessFile, 0o644);
      else if (failure === 'access-symlink') {
        const alternate = join(f.root, 'alternate.json');
        copyFileSync(f.accessFile, alternate); rmSync(f.accessFile); symlinkSync(alternate, f.accessFile);
      } else {
        rmSync(f.receiptFile('task'));
        if (failure === 'legacy-owner') {
          const record = f.manager.catalog.getSession(f.sessionId)!;
          f.manager.catalog.writeSession({ ...record, selections: [{ moduleId: 'task', roleId: 'owner', version: '1.0.0' }],
            configRefs: { task: { config: f.manager.catalog.moduleConfigPath('task') } } });
        }
      }
      await assert.rejects(f.manager.connected(f.sessionId, f.session, false));
      await assert.rejects(f.manager.configuration(f.sessionId, f.cwd, false));
      await assert.rejects(f.apply([f.task('2.0.0')], 'new-version-operation'));
      assert.equal(f.calls.mints, 1);
      assert.equal(f.calls.provisions.length, 1);
    });
  }
});

test('confirmed WeChat cold loads and same-binding version applies ignore business work and unavailable WAL diagnostics', async t => {
  for (const mode of [
    { running: true, pendingJobs: 2, unknownJobs: 0 },
    { running: true, pendingJobs: 2, unknownJobs: 1 },
    { running: true, detailsAvailable: false, pendingJobs: null, unknownJobs: null },
    { running: false, pendingJobs: 2, unknownJobs: 0, reason: 'PENDING_JOBS', bindingConfirmed: true },
    { running: false, pendingJobs: 2, unknownJobs: 1, reason: 'UNKNOWN_OUTCOMES', bindingConfirmed: true },
  ]) {
    const f = await fixture(t);
    await f.apply([f.wechat()], 'initial-operation');
    const receipt = readFileSync(f.receiptFile('wechat'), 'utf8');
    f.mode(mode);
    const reopened = f.makeManager();
    await reopened.configuration(f.sessionId, f.cwd, false);
    await reopened.connected(f.sessionId, f.session, false);
    await f.apply([f.wechat('2.0.0')], 'same-binding-version', reopened);
    assert.equal(readFileSync(f.receiptFile('wechat'), 'utf8'), receipt);
    assert.equal(f.binds().length, 1);
    assert.equal(f.calls.mints, 0);
    assert.equal(f.manager.catalog.getSession(f.sessionId)?.phase, 'applied');
  }
});

test('initial WeChat binding still refuses busy, unknown business outcomes and unavailable diagnostic counts', async t => {
  for (const mode of [
    { pendingJobs: 1 }, { unknownJobs: 1 }, { pendingJobs: null, unknownJobs: null, detailsAvailable: false },
    { running: true }, { unknown: true }, { runnerUnknown: true },
  ]) {
    const f = await fixture(t);
    f.mode(mode);
    await assert.rejects(f.apply([f.wechat()], 'initial-operation'));
    assert.equal(f.binds().length, 0);
    assert.equal(existsSync(f.receiptFile('wechat')), false);
  }
});

test('new WeChat bind uses its exact receipt before Store startup but cold/apply never ignore an explicit false proof', async t => {
  const f = await fixture(t);
  f.mode({ bindingConfirmed: false });
  await f.apply([f.wechat()], 'initial-operation');
  const receipt = readFileSync(f.receiptFile('wechat'), 'utf8');
  for (const running of [false, true]) {
    f.mode({ running, bindingConfirmed: false });
    await assert.rejects(f.manager.configuration(f.sessionId, f.cwd, false), /missing or changed/);
    await assert.rejects(f.apply([f.wechat('2.0.0')], 'same-binding-version'), /missing or changed/);
  }
  f.mode({ running: true, bindingConfirmed: true, detailsAvailable: false, pendingJobs: null, unknownJobs: null });
  const reopened = f.makeManager();
  await reopened.configuration(f.sessionId, f.cwd, false);
  await reopened.connected(f.sessionId, f.session, false);
  await f.apply([f.wechat('2.0.0')], 'same-binding-version', reopened);
  assert.equal(readFileSync(f.receiptFile('wechat'), 'utf8'), receipt);
  assert.equal(f.binds().length, 1);
});

test('WeChat missing/changed/unknown binding and changed config never trigger a new bind', async t => {
  for (const failure of ['missing', 'different-session', 'revision', 'unknown', 'runner-unknown', 'not-ready', 'config', 'cwd', 'receipt']) {
    await t.test(failure, async inner => {
      const f = await fixture(inner);
      await f.apply([f.wechat()], 'initial-operation');
      const running = { running: true, detailsAvailable: false, pendingJobs: null, unknownJobs: null };
      f.mode(running);
      if (['missing', 'different-session', 'revision'].includes(failure)) {
        const state = f.json(f.stateFile);
        if (failure === 'revision') state.revision++;
        else state.boundSessionId = failure === 'missing' ? null : 'different-session';
        writeFileSync(f.stateFile, JSON.stringify(state));
      } else if (failure === 'config') writeFileSync(f.configFile, JSON.stringify({ ...f.json(f.configFile), changed: true }));
      else if (failure === 'receipt') rmSync(f.receiptFile('wechat'));
      else f.mode({ ...running, unknown: failure === 'unknown', runnerUnknown: failure === 'runner-unknown', notReady: failure === 'not-ready' });
      if (failure === 'cwd') await assert.rejects(f.manager.prepare(f.sessionId, f.root, [f.wechat('2.0.0')], 'new-version-operation'));
      else {
        await assert.rejects(f.manager.connected(f.sessionId, f.session, false));
        await assert.rejects(f.apply([f.wechat('2.0.0')], 'new-version-operation'));
      }
      assert.equal(f.binds().length, 1);
    });
  }
});

test('a partial first initialization retains original identities and reuses completed hooks on explicit continuation', async t => {
  const f = await fixture(t);
  const write = f.manager.catalog.writeSession.bind(f.manager.catalog);
  const fault = t.mock.method(f.manager.catalog, 'writeSession', (record, revision) => {
    if (record.phase === 'applied') throw new Error('Synthetic final local receipt failure');
    return write(record, revision);
  });
  await assert.rejects(f.apply([f.task(), f.wechat()], 'initial-operation'), /Synthetic/);
  assert.equal(f.manager.catalog.getSession(f.sessionId)?.phase, 'failed');
  fault.mock.restore();
  await assert.rejects(f.apply([f.task('2.0.0'), f.wechat('2.0.0')], 'replacement-operation'), /unfinished/);
  await f.apply([f.task(), f.wechat()], 'initial-operation', f.makeManager());
  assert.equal(f.calls.mints, 1); assert.equal(f.calls.provisions.length, 1); assert.equal(f.binds().length, 1);
  assert.equal(f.json(f.receiptFile('task')).operationId, 'initial-operation');
  assert.equal(f.json(f.receiptFile('wechat')).operationId, 'initial-operation');
});

test('lost Task provision reply or WeChat bind reply remains unknown and never retries even the same ID', async t => {
  for (const id of ['task', 'wechat'] as const) await t.test(id, async inner => {
    const f = await fixture(inner);
    if (id === 'task') f.loseReply(); else f.mode({ loseReply: true });
    const choices = id === 'task' ? [f.task()] : [f.wechat()];
    await assert.rejects(f.apply(choices, 'initial-operation'), /inspect original operation/);
    assert.equal(f.json(f.receiptFile(id)).state, 'attempted');
    assert.equal(f.manager.catalog.getSession(f.sessionId)?.phase, 'unknown');
    f.mode({});
    const reopened = f.makeManager();
    await assert.rejects(f.apply(choices, 'initial-operation', reopened), /original operation/);
    await assert.rejects(f.apply(choices, 'replacement-operation', reopened), /unfinished/);
    await assert.rejects(reopened.connected(f.sessionId, f.session, true), /original operation/);
    assert.equal(id === 'task' ? f.calls.provisions.length : f.binds().length, 1);
  });
});

test('Task completion before WeChat failure survives without reminting or bypassing the original bind attempt', async t => {
  const f = await fixture(t);
  f.mode({ failBind: true });
  await assert.rejects(f.apply([f.task(), f.wechat()], 'initial-operation'));
  assert.equal(f.json(f.receiptFile('task')).state, 'ready');
  assert.equal(f.json(f.receiptFile('wechat')).state, 'attempted');
  f.mode({});
  await assert.rejects(f.apply([f.task(), f.wechat()], 'initial-operation'));
  assert.equal(f.calls.provisions.length, 1);
  assert.equal(f.binds().length, 1);
  assert.equal(f.manager.catalog.getSession(f.sessionId)?.sessionId, f.sessionId);
});

test('concurrent Managers cannot execute the same initialization twice and stale locks are never stolen', async t => {
  const f = await fixture(t);
  await f.manager.prepare(f.sessionId, f.cwd, [f.task()], 'initial-operation');
  const outcomes = await Promise.allSettled([
    f.manager.connected(f.sessionId, f.session, true),
    f.makeManager().connected(f.sessionId, f.session, true),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(f.calls.provisions.length, 1);
  const g = await fixture(t);
  await g.manager.prepare(g.sessionId, g.cwd, [g.wechat()], 'initial-operation');
  writeFileSync(`${g.receiptFile('wechat')}.lock`, '', { mode: 0o600 });
  await assert.rejects(g.manager.connected(g.sessionId, g.session, true), /locked/);
  assert.equal(g.binds().length, 0);
});

test('owner-first never provisions a caller until the first explicit commander selection', async t => {
  const f = await fixture(t);
  await f.apply([f.task('1.0.0', 'owner')], 'owner-operation');
  assert.equal(f.calls.provisions.length, 0);
  assert.equal(f.json(f.receiptFile('task')).state, 'unprovisioned');
  await f.manager.connected(f.sessionId, f.session, false);
  await f.apply([f.task('2.0.0')], 'first-commander-operation');
  assert.deepEqual(f.calls.provisions, [{ requestId: 'first-commander-operation', sessionId: f.sessionId }]);
});

test('owner-first pins its Task service realm without minting a caller or silently adopting a different service', async t => {
  const f = await fixture(t);
  await f.apply([f.task('1.0.0', 'owner')], 'owner-operation');
  const config = f.manager.catalog.readConfig('task');
  f.manager.catalog.updateConfig('task', { ...config.values, serviceUrl: 'http://127.0.0.1:1' }, config.revision);
  await assert.rejects(f.manager.configuration(f.sessionId, f.cwd, false), /identity\/configuration changed/);
  await assert.rejects(f.apply([f.task('2.0.0')], 'commander-operation'), /identity\/configuration changed/);
  assert.equal(f.calls.mints, 0);
});

test('pending initialization is never run by cold loading and a readiness failure leaves the original claim reusable', async t => {
  const f = await fixture(t);
  await f.manager.prepare(f.sessionId, f.cwd, [f.task()], 'initial-operation');
  await assert.rejects(f.manager.connected(f.sessionId, f.session, false), /cold loading/);
  await assert.rejects(f.manager.configuration(f.sessionId, f.cwd, false), /incomplete/);
  const bad = t.mock.method(f.session.rpc.mcp, 'list', async () => ({
    servers: [{ name: 'work', status: 'failed', enabled: true, source: 'session' }],
  }));
  await assert.rejects(f.manager.connected(f.sessionId, f.session, true), /connection/);
  bad.mock.restore();
  assert.equal(f.calls.provisions.length, 0);
  assert.equal(f.json(f.receiptFile('task')).state, 'prepared');
  await f.manager.connected(f.sessionId, f.session, true);
  assert.equal(f.calls.provisions.length, 1);
});

test('credential replacement during the authenticated readiness request is rejected without issuing another caller', async t => {
  const f = await fixture(t);
  await f.apply([f.task()], 'initial-operation');
  f.replaceDuringRead();
  await assert.rejects(f.manager.connected(f.sessionId, f.session, false), /changed during/);
  assert.equal(f.calls.provisions.length, 1);
});

test('a completed first WeChat bind is not repeated when a later Task initialization loses its acknowledgement', async t => {
  const f = await fixture(t);
  f.loseReply();
  await assert.rejects(f.apply([f.wechat(), f.task()], 'initial-operation'));
  assert.equal(f.json(f.receiptFile('wechat')).state, 'ready');
  assert.equal(f.json(f.receiptFile('wechat')).operationId, 'initial-operation');
  await assert.rejects(f.apply([f.wechat(), f.task()], 'initial-operation', f.makeManager()));
  assert.equal(f.binds().length, 1);
  assert.equal(f.calls.provisions.length, 1);
});
