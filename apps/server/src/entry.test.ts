import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installLocalModule } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

const mockSdk = `data:text/javascript,${encodeURIComponent(`
export const approveAll = () => ({kind:'approved'});
export const RuntimeConnection = {forStdio: () => ({kind:'stdio'})};
export class CopilotClient {
  rpc = {};
  async start() {
    if (process.env.SYNTHETIC_FAIL_START) throw new Error('synthetic startup failure');
    globalThis.syntheticRuntimeStarted = true;
  }
  async getStatus() { return {version:'1.0.83', protocolVersion:3}; }
  async getAuthStatus() { return {isAuthenticated:false, login:'synthetic'}; }
  async listSessions() { return []; }
  async listModels() { return []; }
  async stop() { console.error('SYNTHETIC_NATIVE_STOP'); return []; }
}
`)}`;
const preload = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  globalThis.syntheticHttpServer = this;
  if (process.env.SYNTHETIC_STARTUP_SHUTDOWN) process.emit('SIGTERM');
  return listen.apply(this, args);
};
registerHooks({ resolve(specifier, context, next) {
  return specifier === '@github/copilot-sdk'
    ? {url:${JSON.stringify(mockSdk)}, shortCircuit:true} : next(specifier, context);
}});
`)}`;

function jsonObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

for (const method of ['api', 'signal', 'startup', 'listen-failure', 'runtime-failure'] as const) {
  test(`direct entry preserves service readiness and shutdown through ${method}, without a controller or respawn`, {
    timeout: 20_000,
  }, async t => {
    const f = await moduleFixture(t);
    const root = f.root;
    await installLocalModule(await f.package(moduleEntries('service-ready', `
      export function activate(ctx) {
        return { routes: [], async onReady() {
          if (!globalThis.syntheticRuntimeStarted || !globalThis.syntheticHttpServer?.listening) {
            throw new Error('Readiness before runtime and HTTP listener');
          }
          const port = globalThis.syntheticHttpServer.address().port;
          const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: ctx.signal });
          if (!response.ok) throw new Error('HTTP not ready');
          console.log('SYNTHETIC_MODULE_READY');
          ctx.signal.addEventListener('abort', () => console.error('SYNTHETIC_MODULE_ABORT'), { once: true });
          return new Promise(() => {});
        } };
      }
    `)), { trustLocalCode: true, enable: true });
    const web = join(root, 'web'), home = join(root, 'home');
    mkdirSync(web);
    mkdirSync(home);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Isolated direct entry</title>');
    let port = 0;
    if (method === 'listen-failure') {
      const occupied = createServer();
      await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
      port = (occupied.address() as { port: number }).port;
      t.after(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
    }
    const child = spawn(process.execPath, [
      '--import', import.meta.resolve('tsx'), '--import', preload,
      fileURLToPath(new URL('./index.ts', import.meta.url)),
    ], {
      cwd: root,
      env: {
        HOME: home, COPILOT_HOME: home, COCKPIT_HOME: f.hostRoot, TMPDIR: root,
        PATH: '/usr/bin:/bin', NODE_DISABLE_COMPILE_CACHE: '1',
        COCKPIT_PORT: String(port), COCKPIT_WEB_DIR: web, LOG_LEVEL: 'info',
        ...(method === 'startup' ? { SYNTHETIC_STARTUP_SHUTDOWN: '1' } : {}),
        ...(method === 'runtime-failure' ? { SYNTHETIC_FAIL_START: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errorOutput = '';
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await ended;
    });
    if (['startup', 'listen-failure', 'runtime-failure'].includes(method)) {
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errorOutput += chunk; });
      assert.deepEqual(await ended, { code: method === 'startup' ? 0 : 1, signal: null }, `${output}\n${errorOutput}`);
      assert.doesNotMatch(output, /SYNTHETIC_MODULE_READY/);
      if (method === 'startup') assert.match(output, /Server listening at/);
      else assert.match(output, /service startup failed/);
      return;
    }
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match && output.includes('SYNTHETIC_MODULE_READY')) resolve(match[1]!);
      });
      child.stderr.on('data', chunk => { errorOutput += chunk; });
      void ended.then(() => reject(new Error(`Entry exited before readiness: ${output}\n${errorOutput}`)), reject);
    });
    const base = await ready;
    const get = async (path: string) => {
      const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      return response;
    };
    assert.match(await (await get('/')).text(), /Isolated direct entry/);
    const version = jsonObject(await (await get('/version')).json());
    assert.equal(version.sourceSha, null);
    const health = jsonObject(await (await get('/health')).json());
    assert.equal(health.instanceId, version.instanceId);
    assert.equal(health.login, 'synthetic');
    assert.equal((await fetch(base + '/admin/lifecycle')).status, 404);
    if (method === 'api') {
      const response = await fetch(base + '/intent/system/shutdown', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }), redirect: 'error', signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      const body = jsonObject(await response.json());
      const shutdown = jsonObject(body.shutdown);
      assert.equal(shutdown.phase, 'waiting');
    } else {
      assert.equal(child.kill('SIGTERM'), true);
    }
    const exit = await ended;
    assert.deepEqual(exit, { code: 0, signal: null }, `${output}\n${errorOutput}`);
    assert.equal((errorOutput.match(/SYNTHETIC_NATIVE_STOP/g) ?? []).length, 1);
    assert.equal((output.match(/SYNTHETIC_MODULE_READY/g) ?? []).length, 1);
    assert.equal((errorOutput.match(/SYNTHETIC_MODULE_ABORT/g) ?? []).length, 1);
  });
}
