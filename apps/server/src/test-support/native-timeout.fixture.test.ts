import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { OfficialRuntime } from '@cockpit/core';
import { NativeTestLifecycle } from '../../../../packages/core/test-support/native-test-lifecycle.ts';
import { fixtureModelCatalog } from '../../../../packages/core/test-support/session-defaults.ts';

test('synthetic unresponsive MCP deadline', {
  skip: process.env.COCKPIT_NATIVE_TOOL_SCOPE !== '1' || !process.env.COCKPIT_NATIVE_TIMEOUT_ROOT,
  timeout: 2_000,
}, async t => {
  const parent = process.env.COCKPIT_NATIVE_TIMEOUT_ROOT;
  assert.ok(parent, 'This subprocess fixture requires an explicitly owned root');
  const root = join(parent, 'fixture');
  mkdirSync(root);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: root, USERPROFILE: root, COPILOT_HOME: root, COCKPIT_HOME: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root,
    TMPDIR: root, TMP: root, TEMP: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), COCKPIT_PORT: '0',
  });
  process.chdir(root);
  const lifecycle = new NativeTestLifecycle(t.signal, message => console.error(message));
  const pids: number[] = [];
  let port = 0, held = false;
  const evidence = () => writeFileSync(join(parent, 'evidence.json'), JSON.stringify({ pids, port, held }));
  const spawning = channel('child_process');
  const observe = (message: unknown) => {
    const child = (message as { process: ChildProcess }).process;
    child.once('spawn', () => { pids.push(child.pid!); evidence(); });
  };
  spawning.subscribe(observe);
  const server = lifecycle.server(createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (!('id' in message)) { response.writeHead(202).end(); return; }
    if (message.method === 'tools/list') {
      held = true; evidence();
      return; // Deliberately hold the real HTTP request until cancellation.
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-timeout', version: '1' },
      },
    }));
  }));
  const runtime = new OfficialRuntime({
    clientFactory: lifecycle.clientFactory,
    clientOptions: {
      mode: 'empty', baseDirectory: root, workingDirectory: root, builtinPluginDirectories: [],
      useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error', onListModels: fixtureModelCatalog,
    },
    sessionConfig: {
      configDirectory: root, enableFileHooks: false, enableHostGitOperations: false,
      enableSessionStore: false, enableSkills: false, skillDirectories: [], pluginDirectories: [],
      instructionDirectories: [], customAgents: [], enableManagedSettings: false,
      skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
      enableSessionTelemetry: false, remoteSession: 'off',
      availableTools: ['mcp:*'],
    },
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    port = address.port; evidence();
    lifecycle.setPhase('unresponsive synthetic MCP');
    await runtime.start();
    await runtime.createSession({
      model: 'gpt-4.1',
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${port}/v1` },
      mcpServers: { synthetic: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, tools: ['*'] } },
    });
    assert.fail('unresponsive MCP unexpectedly completed');
  } finally {
    await lifecycle.finish(() => runtime.stop(), async () => {
      spawning.unsubscribe(observe);
      process.chdir(parent);
      await rm(root, { recursive: true });
      await writeFile(join(parent, 'removed'), 'closed and removed');
    });
  }
});
