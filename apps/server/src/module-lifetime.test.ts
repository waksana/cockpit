import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { moduleCli } from './module-cli.ts';
import { acquireModuleLease, guardModuleHostStartup } from './module-lifetime.ts';
import { moduleFixture } from './test-support/module-fixture.ts';

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform} host guard checks journals without claiming a lease; migration rejects before writes`, async t => {
    const fixture = await moduleFixture(t);
    const modules = join(fixture.hostRoot, 'modules');
    await mkdir(modules, { recursive: true, mode: 0o700 });
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      assert.deepEqual(await guardModuleHostStartup(fixture.hostRoot), { fencing: 'unsupported-platform', platform });
      assert.deepEqual(await readdir(modules), []);
      await assert.rejects(acquireModuleLease(fixture.hostRoot), /requires Linux/);
      const args = ['migrate-id', 'old-module', 'new-module', '--version', '1.0.0', '--digest', 'a'.repeat(64), '--offline'];
      for (const mode of [[], ['--apply'], ['--resume']]) {
        await assert.rejects(moduleCli([...args, ...mode], { hostRoot: fixture.hostRoot }), /requires Linux/);
        assert.deepEqual(await readdir(modules), []);
      }
      const packagePath = await fixture.package();
      await assert.rejects(moduleCli(['install', packagePath, '--trust-local-code', '--enable'], { hostRoot: fixture.hostRoot }), /require Linux/);
      await assert.rejects(moduleCli(['disable', 'fixture'], { hostRoot: fixture.hostRoot }), /require Linux/);
      assert.deepEqual(await readdir(modules), []);
      const journal = join(modules, '.migration.json');
      await writeFile(journal, 'even a corrupt journal blocks startup', { mode: 0o600 });
      await assert.rejects(guardModuleHostStartup(fixture.hostRoot), /migration is pending/);
      assert.equal(await readFile(journal, 'utf8'), 'even a corrupt journal blocks startup');
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  for (const pending of [false, true]) {
    test(`${platform} mocked server entry ${pending ? 'refuses pending migration before native construction' : 'starts and shuts down normally without a migration lease'}`, {
      timeout: 20_000,
    }, async t => {
      const fixture = await moduleFixture(t);
      await mkdir(join(fixture.hostRoot, 'modules'), { recursive: true, mode: 0o700 });
      if (pending) await writeFile(join(fixture.hostRoot, 'modules', '.migration.json'), 'pending');
      const sdk = `data:text/javascript,${encodeURIComponent(`
export const approveAll = () => ({kind:'approved'});
export const RuntimeConnection = {forStdio: () => ({kind:'stdio'})};
export class CopilotClient {
  constructor() { console.error('SYNTHETIC_NATIVE_CONSTRUCTED'); }
  rpc = {};
  async start() {}
  async getStatus() { return {version:'1.0.83', protocolVersion:3}; }
  async getAuthStatus() { return {isAuthenticated:false, login:'synthetic'}; }
  async listSessions() { return []; }
  async listModels() { return []; }
  async stop() { return []; }
}
`)}`;
      const preload = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}, configurable:true});
registerHooks({resolve(specifier, context, next) { return specifier === '@github/copilot-sdk'
  ? {url:${JSON.stringify(sdk)}, shortCircuit:true} : next(specifier, context); }});
`)}`;
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload,
        fileURLToPath(new URL('./index.ts', import.meta.url))], {
        cwd: fixture.root,
        env: {
          HOME: fixture.root, COPILOT_HOME: fixture.root, COCKPIT_HOME: fixture.hostRoot,
          COCKPIT_PORT: '0', COCKPIT_SERVE_WEB: '0', TMPDIR: fixture.root, PATH: process.env.PATH,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const ended = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code));
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await ended;
      });
      child.stderr.on('data', chunk => { output += chunk; });
      if (pending) {
        child.stdout.on('data', chunk => { output += chunk; });
        assert.equal(await ended, 1, output);
        assert.match(output, /migration is pending/);
        assert.doesNotMatch(output, /SYNTHETIC_NATIVE_CONSTRUCTED/);
      } else {
        const base = await new Promise<string>((resolve, reject) => {
          child.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) resolve(match[1]!);
          });
          void ended.then(() => reject(new Error(`Entry exited before readiness: ${output}`)), reject);
        });
        assert.equal((await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).status, 200);
        assert.match(output, /migration fencing unavailable/);
        assert.match(output, /SYNTHETIC_NATIVE_CONSTRUCTED/);
        child.kill('SIGTERM');
        assert.equal(await ended, 0, output);
      }
    });
  }
}
