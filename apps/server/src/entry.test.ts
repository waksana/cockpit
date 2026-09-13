import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const mockSdk = `data:text/javascript,${encodeURIComponent(`
export const approveAll = () => ({kind:'approved'});
export const RuntimeConnection = {forStdio: () => ({kind:'stdio'})};
export class CopilotClient {
  rpc = {};
  async start() {}
  async getStatus() { return {version:'1.0.83', protocolVersion:3}; }
  async getAuthStatus() { return {isAuthenticated:false, login:'synthetic'}; }
  async listSessions() { return []; }
  async listModels() { return []; }
  async stop() { console.error('SYNTHETIC_NATIVE_STOP'); return []; }
}
`)}`;
const preload = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  return specifier === '@github/copilot-sdk'
    ? {url:${JSON.stringify(mockSdk)}, shortCircuit:true} : next(specifier, context);
}});
`)}`;

for (const method of ['api', 'signal'] as const) {
  test(`direct entry serves Web/API and exits normally through ${method}, without a controller or respawn`, {
    timeout: 20_000,
  }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-direct-entry-'));
    const web = join(root, 'web'), home = join(root, 'home');
    mkdirSync(web);
    mkdirSync(home);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Isolated direct entry</title>');
    const child = spawn(process.execPath, [
      '--import', import.meta.resolve('tsx'), '--import', preload,
      fileURLToPath(new URL('./index.ts', import.meta.url)),
    ], {
      cwd: root,
      env: {
        HOME: home, COPILOT_HOME: home, COCKPIT_HOME: home, TMPDIR: root,
        PATH: '/usr/bin:/bin', NODE_DISABLE_COMPILE_CACHE: '1',
        COCKPIT_PORT: '0', COCKPIT_WEB_DIR: web, LOG_LEVEL: 'info',
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
      rmSync(root, { recursive: true });
    });
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]!);
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
    const version = await (await get('/version')).json();
    assert.equal(version.sourceSha, null);
    const health = await (await get('/health')).json();
    assert.equal(health.instanceId, version.instanceId);
    assert.equal(health.login, 'synthetic');
    assert.equal((await fetch(base + '/admin/lifecycle')).status, 404);
    if (method === 'api') {
      const response = await fetch(base + '/intent/system/shutdown', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }), redirect: 'error', signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).shutdown.phase, 'waiting');
    } else {
      assert.equal(child.kill('SIGTERM'), true);
    }
    const exit = await ended;
    assert.deepEqual(exit, { code: 0, signal: null }, `${output}\n${errorOutput}`);
    assert.equal((errorOutput.match(/SYNTHETIC_NATIVE_STOP/g) ?? []).length, 1);
  });
}
