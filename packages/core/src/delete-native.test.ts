import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { RuntimeConnection } from '@github/copilot-sdk';
import { OfficialRuntime } from './runtime.ts';
import { Engine } from './engine.ts';
import { ModuleManager } from './modules/manager.ts';

test('confirmed Engine deletion uses native SDK without module unbind and preserves module unknown evidence', {
  skip: process.env.COCKPIT_NATIVE_DELETE_TEST !== '1', timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-delete-native-'));
  const state = join(root, 'state');
  const work = join(root, 'work');
  mkdirSync(state);
  mkdirSync(work);
  const retained = join(root, 'retained-upload.txt');
  const code = join(work, 'keep.txt');
  writeFileSync(retained, 'retained independently of session');
  writeFileSync(code, 'workspace survives deletion');
  const provider = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: 'Owned deletion fixture response' }, null], [{}, 'stop'],
      ]) {
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
          created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = new OfficialRuntime({
    clientOptions: {
      connection: RuntimeConnection.forStdio({ env: {
        HOME: root, COPILOT_HOME: state, XDG_CONFIG_HOME: root,
        TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      } }),
      mode: 'empty', baseDirectory: state, workingDirectory: work,
      builtinPluginDirectories: [], useLoggedInUser: false,
      enableRemoteSessions: false, logLevel: 'error', onListModels: () => [],
    },
    sessionConfig: {
      model: 'gpt-4.1', workingDirectory: work, configDirectory: state,
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      skipCustomInstructions: true, enableFileHooks: false, enableHostGitOperations: false,
      enableSessionStore: false, enableSkills: false, enableManagedSettings: false,
      skillDirectories: [], pluginDirectories: [], instructionDirectories: [],
      customAgents: [], availableTools: [], enableSessionTelemetry: false, remoteSession: 'off',
    },
  });
  const source = join(root, 'module-source');
  mkdirSync(source);
  const hookCalled = join(root, 'hook-called');
  writeFileSync(join(source, 'module.json'), JSON.stringify({
    schemaVersion: 1, id: 'wechat', version: '1.0.0', name: 'Isolated WeChat', description: 'Native deletion fixture',
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' }, configVersion: 1,
    roles: [{ id: 'wechat', name: 'WeChat', description: 'Binding-only fixture' }],
    sessionLifecycle: { unbind: { entry: 'unbind.mjs' } },
  }));
  writeFileSync(join(source, 'unbind.mjs'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(hookCalled)}, 'unexpected'); throw new Error('UNKNOWN_SEND');`);
  const modules = new ModuleManager({ runtime, userRoot: join(root, 'user'), sources: { wechat: source } });
  modules.catalog.installFromDirectory(source);
  const data = modules.catalog.dataDirectory('wechat');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const unknown = join(data, 'unknown-send.json');
  writeFileSync(unknown, '{"outcome":"unknown","resend":false}', { mode: 0o600 });
  const engine = new Engine({ runtime, modules, prefsFile: join(root, 'prefs.json') });
  let deleted = false;
  try {
    await engine.start();
    assert.deepEqual(await runtime.listSessions(), [], 'isolated native home must contain no user sessions');
    const sdk = await runtime.createSession({ workingDirectory: work });
    const id = sdk.sessionId;
    await sdk.sendAndWait({ prompt: 'Owned permanent deletion fixture only' }, 10_000);
    await runtime.closeSession(sdk);
    await engine.refreshList();
    await engine.reload(id);
    await engine.rename(id, 'Owned permanent-delete fixture');
    assert.equal((await engine.getMeta(id))?.cwd, work);
    assert.equal((await engine.getMeta(id))?.title, 'Owned permanent-delete fixture');
    assert.equal((await runtime.getSessionMetadata(id))?.sessionId, id);
    await engine.pin(id, true);
    modules.catalog.writeSession({ sessionId: id, selections: [],
      pendingSelections: [{ moduleId: 'wechat', roleId: 'wechat', version: '1.0.0' }],
      phase: 'unknown', operationId: 'unknown-binding-operation' });
    await assert.rejects(engine.deleteSession(id), /confirm:true/);
    assert.equal((await engine.getMeta(id))?.loaded, true);
    assert.equal(runtime.liveCount, 1);
    await engine.deleteSession(id, true);
    deleted = true;
    assert.equal(runtime.liveCount, 0);
    assert.equal(await engine.getMeta(id), null);
    assert.equal(await runtime.getSessionMetadata(id), undefined);
    assert.equal((await runtime.listSessions()).some(s => s.sessionId === id), false);
    assert.equal(modules.catalog.getSession(id), undefined);
    assert.equal(existsSync(hookCalled), false);
    assert.equal(readFileSync(unknown, 'utf8'), '{"outcome":"unknown","resend":false}');
    const prefs = JSON.parse(readFileSync(join(root, 'prefs.json'), 'utf8'));
    assert.deepEqual(prefs.pinnedSessions, []);
    assert.equal(readFileSync(retained, 'utf8'), 'retained independently of session');
    assert.equal(readFileSync(code, 'utf8'), 'workspace survives deletion');
  } finally {
    await engine.stop();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    if (deleted) rmSync(root, { recursive: true });
    else console.error(`Native deletion fixture retained for investigation: ${root}`);
  }
});
