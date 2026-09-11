import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { InstalledModule } from './catalog.ts';
import { assertWechatReady, provisionTaskCaller, readLocalJson, wechatControl, type AdapterConfig } from './adapters.ts';

test('existing WeChat binding proof is independent of business blockers without trusting masked legacy mismatches', () => {
  const bound = { sessionId: 'existing-session', revision: 3 };
  const status = { managed: true, configReady: true, credentialsPresent: true, unknownOperation: false, runnerUnknown: false,
    boundSessionId: bound.sessionId, revision: bound.revision, running: false, available: false,
    detailsAvailable: false, pendingJobs: null, unknownJobs: null };
  for (const reason of ['PENDING_JOBS', 'UNKNOWN_OUTCOMES', 'NATIVE_FOLLOWUP_UNRESOLVED',
    'PENDING_INBOX_BATCH', 'TYPING_STATE_UNRESOLVED', 'STATE_SNAPSHOT_UNAVAILABLE']) {
    assert.doesNotThrow(() => assertWechatReady({ ...status, reason, bindingConfirmed: true }, bound));
    assert.throws(() => assertWechatReady({ ...status, reason }, bound), /missing or changed/);
    assert.throws(() => assertWechatReady({ ...status, reason, bindingConfirmed: false }, bound), /missing or changed/);
    assert.throws(() => assertWechatReady({ ...status, reason, bindingConfirmed: true }), /initial binding/);
  }
  for (const reason of ['PERSISTED_BINDING_CHANGED', 'MODULE_CONTROL_BUSY', 'OPERATION_OUTCOME_UNKNOWN',
    'RUNNER_STATE_UNKNOWN', 'LEGACY_ADOPTION_REQUIRED', 'NOT_CONFIGURED']) {
    assert.throws(() => assertWechatReady({ ...status, reason, bindingConfirmed: true }, bound));
  }
  assert.throws(() => assertWechatReady({ ...status, reason: 'RUNNING', bindingConfirmed: false }, bound));
  assert.throws(() => assertWechatReady({ ...status, reason: 'ALREADY_BOUND', bindingConfirmed: false }, bound));
  assert.throws(() => assertWechatReady({ ...status, reason: 'RUNNING', bindingConfirmed: 'true' }, bound));
  assert.throws(() => assertWechatReady({ ...status, reason: 'RUNNING', unknownOperation: true, bindingConfirmed: true }, bound));
  assert.throws(() => assertWechatReady({ ...status, reason: 'RUNNING', runnerUnknown: true, bindingConfirmed: true }, bound));
});

async function loopback(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config: AdapterConfig = { ownership: 'external', activationEnabled: false, serviceUrl: `http://127.0.0.1:${address.port}` };
  return config;
}

test('native control HTTP provisions and drains through strict nonbrowser/auth fences without generated fetch headers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-control-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const managerCredentialFile = join(root, 'manager.json'), credentialDirectory = join(root, 'credentials');
  mkdirSync(credentialDirectory, { mode: 0o700 });
  writeFileSync(managerCredentialFile, JSON.stringify({ token: 'synthetic-manager' }), { mode: 0o600 });
  const calls: Array<{ path: string; method: string; body: string }> = [];
  const config = await loopback(t, async (request, response) => {
    const invalidHeader = Object.keys(request.headers).some(name => ['origin', 'referer'].includes(name) || name.startsWith('sec-fetch-'));
    if (invalidHeader || request.headers.host !== new URL(config.serviceUrl!).host || request.socket.remoteAddress !== '127.0.0.1') {
      response.writeHead(403); response.end('nonbrowser loopback client required'); return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ path: request.url!, method: request.method!, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/version' || request.url === '/health') {
      response.end(JSON.stringify({ moduleApi: 1, ok: true, instanceId: 'same-instance' })); return;
    }
    if (request.headers.authorization !== 'Bearer synthetic-manager') {
      response.writeHead(403); response.end('manager credential required'); return;
    }
    if (request.url === '/admin/module/caller') {
      assert.deepEqual(JSON.parse(body), { requestId: 'initial-operation', sessionId: 'test-session' });
      const credentialFile = join(credentialDirectory, `module-caller-${createHash('sha256').update('initial-operation').digest('hex')}.json`);
      writeFileSync(credentialFile, '{"token":"synthetic-caller"}', { mode: 0o600 });
      response.end(JSON.stringify({ credentialFile })); return;
    }
    assert.equal(request.url, '/drain');
    assert.deepEqual(JSON.parse(body), { pending: true });
    response.end(JSON.stringify({ ok: true, pending: true, instanceId: 'same-instance' }));
  });
  Object.assign(config, { managerCredentialFile, credentialDirectory });
  assert.ok(await provisionTaskCaller(config, 'test-session', 'initial-operation'));
  const response = await readLocalJson(config, '/drain', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-manager' }, body: '{"pending":true}' });
  assert.equal(response.pending, true);
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['GET', '/version'], ['GET', '/health'], ['POST', '/admin/module/caller'], ['POST', '/drain'],
  ]);
  await assert.rejects(readLocalJson(config, '/drain', { method: 'POST', body: '{"pending":true}' }), /returned 403/);
});

test('control HTTP status, redirects, malformed/empty JSON and response bounds fail without retries', async t => {
  const calls: string[] = [];
  const limit = 128 * 1024;
  const exact = JSON.stringify({ data: 'x'.repeat(limit - '{"data":""}'.length) });
  const config = await loopback(t, (request, response) => {
    calls.push(request.url!);
    switch (request.url) {
      case '/redirect': response.writeHead(307, { location: '/unexpected' }); response.end(); break;
      case '/forbidden': response.writeHead(403); response.end('private server diagnostic'); break;
      case '/failed': response.writeHead(503); response.end('private server diagnostic'); break;
      case '/empty': response.writeHead(204); response.end(); break;
      case '/malformed': response.end('{'); break;
      case '/array': response.end('[]'); break;
      case '/null': response.end('null'); break;
      case '/exact': response.end(exact); break;
      case '/large': response.write(exact); response.end(' '); break;
      case '/truncated': response.writeHead(200, { 'content-length': 100 }); response.end('{}'); break;
      default: response.end('{}');
    }
  });
  assert.equal(JSON.stringify(await readLocalJson(config, '/exact')).length, limit);
  for (const [path, error] of [
    ['/redirect', /returned 307/], ['/forbidden', /returned 403/], ['/failed', /returned 503/],
    ['/empty', /empty/], ['/malformed', /JSON|position|property/i], ['/array', /Invalid module control response/],
    ['/null', /Invalid module control response/], ['/large', /exceeds limit/], ['/truncated', /interrupted|aborted|reset/i],
  ] as const) {
    await assert.rejects(readLocalJson(config, path, { method: 'POST', body: '{}' }), error);
    assert.equal(calls.filter(value => value === path).length, 1);
  }
  assert.ok(!calls.includes('/unexpected'));
});

test('control HTTP enforces its absolute ten-second deadline before headers and during an unfinished body', async t => {
  for (const body of [false, true]) await t.test(body ? 'body' : 'headers', async inner => {
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    let calls = 0;
    const config = await loopback(inner, (_request, response) => {
      calls++;
      if (body) { response.writeHead(200); response.write('{'); }
      arrived();
    });
    inner.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    const pending = readLocalJson(config, '/stall');
    const failed = assert.rejects(pending, error => error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT');
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await arrival; await nextTurn();
    inner.mock.timers.tick(9999);
    await nextTurn();
    assert.equal(settled, false);
    inner.mock.timers.tick(1);
    await failed;
    assert.equal(calls, 1);
  });
});

test('control HTTP refuses off-origin targets and browser or Host headers before sending', async t => {
  let calls = 0;
  const config = await loopback(t, (_request, response) => { calls++; response.end('{}'); });
  for (const path of ['http://127.0.0.1:1/drain', '//example.invalid/drain', 'https://127.0.0.1/drain', '/drain#fragment']) {
    await assert.rejects(readLocalJson(config, path), /loopback/);
  }
  for (const name of ['Origin', 'Referer', 'Sec-Fetch-Mode', 'sec-fetch-site', 'Host']) {
    await assert.rejects(readLocalJson(config, '/drain', { headers: { [name]: 'forbidden' } }), /headers|Host/);
  }
  await assert.rejects(readLocalJson({ ...config, serviceUrl: config.serviceUrl!.replace('127.0.0.1', 'localhost') }, '/drain'), /loopback/);
  assert.equal(calls, 0);
});

test('WeChat control uses its native wire contract and never mistakes an unconfirmed mutation for a known failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-wechat-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/module-control.js'), `
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(config.requestFile, input);
  process.stdout.write(config.stdout);
  process.stderr.write('synthetic-private-diagnostic');
  process.exitCode = config.exitCode;
});
`);
  const installed: InstalledModule = {
    release: root, digest: '0'.repeat(64),
    manifest: { schemaVersion: 1, id: 'wechat', version: '0.1.0', name: 'WeChat', description: 'Control fixture',
      configVersion: 1, compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' } },
  };
  const configFile = join(root, 'config.json');
  const requestFile = join(root, 'request.json');
  const config = { ownership: 'external' as const, activationEnabled: false, configFile };
  const mutation = { action: 'bind' as const, operationId: 'operation-12345', sessionId: 'synthetic-session', cwd: root };
  const receipt = { ok: true, operationId: mutation.operationId, boundSessionId: mutation.sessionId, revision: 1, replayed: false };
  function response(stdout: string, exitCode = 0) {
    writeFileSync(configFile, JSON.stringify({ stdout, exitCode, requestFile }), { mode: 0o600 });
  }

  response(JSON.stringify({ ok: true, status: { available: true, boundSessionId: null } }));
  assert.deepEqual(await wechatControl(installed, config, { action: 'status' }), { available: true, boundSessionId: null });
  assert.deepEqual(JSON.parse(readFileSync(requestFile, 'utf8')), { operation: 'status' });
  response(JSON.stringify(receipt));
  assert.deepEqual(await wechatControl(installed, config, mutation), receipt);
  assert.deepEqual(JSON.parse(readFileSync(requestFile, 'utf8')), {
    operation: 'bind', operationId: mutation.operationId, sessionId: mutation.sessionId, cwd: root,
  });
  response(JSON.stringify({ ...receipt, boundSessionId: null }));
  await wechatControl(installed, config, { ...mutation, action: 'unbind' });
  assert.equal(JSON.parse(readFileSync(requestFile, 'utf8')).cwd, root);

  for (const code of ['ALREADY_BOUND', 'OPERATION_OUTCOME_UNKNOWN']) {
    response(JSON.stringify({ ok: false, operationId: mutation.operationId, error: { code } }), 2);
    await assert.rejects(wechatControl(installed, config, mutation), error =>
      error instanceof Error && error.message.endsWith(code)
      && 'moduleOutcomeUnknown' in error && error.moduleOutcomeUnknown === code.includes('UNKNOWN'));
  }
  for (const [stdout, exitCode] of [
    ['not JSON', 2], ['null', 0], ['[]', 0], ['{}', 0],
    [JSON.stringify({ ok: true }), 0],
    [JSON.stringify({ ...receipt, operationId: 'wrong-operation' }), 0],
    [JSON.stringify({ ...receipt, boundSessionId: 'wrong-session' }), 0],
    [JSON.stringify(receipt), 1],
    [JSON.stringify({ ok: false, error: { code: 'ALREADY_BOUND' } }), 1],
    [JSON.stringify({ ok: false, error: { code: 'private diagnostic text' } }), 2],
  ] as const) {
    response(stdout, exitCode);
    await assert.rejects(wechatControl(installed, config, mutation), error =>
      error instanceof Error && 'moduleOutcomeUnknown' in error && error.moduleOutcomeUnknown === true
      && !error.message.includes('private'));
  }
});
