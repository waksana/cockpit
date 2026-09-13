import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { OfficialRuntime } from '../runtime.ts';
import { ModuleManager } from './manager.ts';

function fixture(t: TestContext, capability = true) {
  const root = mkdtempSync(join(tmpdir(), 'module-admission-'));
  const source = join(root, 'source'), configFile = join(root, 'config.json'), calls = join(root, 'calls.jsonl');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'module.json'), JSON.stringify({
    schemaVersion: 1, id: 'wechat', version: '1.0.0', name: 'WeChat', description: 'Isolated admission fixture',
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
    roles: [{ id: 'wechat', name: 'WeChat', description: 'Binding only' }], binding: 'wechat',
    ...(capability ? { sessionLifecycle: { canBind: { entry: 'src/module-control.js' } } } : {}),
  }));
  writeFileSync(join(source, 'src/module-control.js'), `
    const { appendFileSync, readFileSync } = require('node:fs');
    let input = '';
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
      appendFileSync(config.calls, JSON.stringify(request) + '\\n');
      const checking = request.operation === 'can-bind';
      if (checking && config.mode === 'failure') {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: 'NATIVE_TARGET_UNCONFIRMED' } }));
        process.exitCode = 2;
        return;
      }
      process.stdout.write(JSON.stringify({ ok: true, status: {
        available: checking, boundSessionId: checking && config.mode !== 'invalid' ? null : 'old-native-target',
        reason: checking ? 'AVAILABLE' : 'ALREADY_BOUND'
      } }));
    });
  `);
  writeFileSync(configFile, JSON.stringify({ calls }), { mode: 0o600 });
  const runtime = new OfficialRuntime();
  t.mock.method(runtime, 'getSessionMetadata', async () => { throw new Error('Host must not scan or manufacture module targets'); });
  const manager = new ModuleManager({ runtime, userRoot: join(root, 'user'), sources: { wechat: source } });
  manager.catalog.installFromDirectory(source);
  manager.catalog.updateConfig('wechat', { configFile }, 0);
  t.after(async () => {
    for (let i = 0; i < 100 && manager.activeCount(); i++) await sleep(10);
    assert.equal(manager.activeCount(), 0, 'Admission control children must actually exit');
    rmSync(root, { recursive: true, force: true });
  });
  return { manager,
    requests: () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    mode: (mode: string) => writeFileSync(configFile, JSON.stringify({ calls, mode }), { mode: 0o600 }) };
}

test('only explicit admission reads invoke the installed optional hook, without a prospective identity', async t => {
  const f = fixture(t);
  assert.equal((await f.manager.list()).find(item => item.id === 'wechat')?.roles[0]?.available, false);
  assert.deepEqual(f.requests(), [{ operation: 'status' }]);
  const checked = (await f.manager.list(undefined, true)).find(item => item.id === 'wechat')!;
  assert.equal(checked.roles[0]?.available, true);
  assert.equal(checked.roles[0]?.boundSessionId, undefined);
  assert.deepEqual(f.requests(), [{ operation: 'status' }, { operation: 'can-bind' }]);
  assert.deepEqual(f.manager.catalog.listBindings(), [], 'Admission does not reserve a slot or create a role identity');
});

test('a module without conditional admission receives no invented check hook', async t => {
  const f = fixture(t, false);
  assert.equal((await f.manager.list(undefined, true)).find(item => item.id === 'wechat')?.roles[0]?.available, false);
  assert.deepEqual(f.requests(), [{ operation: 'status' }]);
});

for (const mode of ['failure', 'invalid']) {
  test(`admission ${mode} stays unavailable and never becomes an empty available binding`, async t => {
    const f = fixture(t);
    f.mode(mode);
    const role = (await f.manager.list(undefined, true)).find(item => item.id === 'wechat')!.roles[0]!;
    assert.equal(role.available, false);
    assert.ok(role.reason);
    assert.equal(f.requests().length, 1, 'An unknown check is not automatically retried');
  });
}
