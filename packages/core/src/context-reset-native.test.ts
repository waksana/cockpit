import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CopilotClient, SessionConfig } from '@github/copilot-sdk';
import type { Engine } from './engine.ts';

test('native self-clear preserves identity/logs, seeds a clean window and survives cold resume', {
  skip: process.env.COCKPIT_NATIVE_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'cockpit-self-clear-'));
  const dirs = Object.fromEntries(['home', 'state', 'work', 'config', 'cache', 'scratch', 'run'].map(n => [n, join(root, n)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
  const env = {
    HOME: dirs.home!, COPILOT_HOME: dirs.state!, XDG_CONFIG_HOME: dirs.config!,
    XDG_STATE_HOME: dirs.state!, XDG_CACHE_HOME: dirs.cache!, XDG_RUNTIME_DIR: dirs.run!,
    TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'), GIT_CEILING_DIRECTORIES: root,
  };
  const handoff = join(dirs.work!, 'handoff.txt');
  writeFileSync(handoff, 'SYNTHETIC_CONTINUATION_742\n');
  const seed = `RESET_SEED Read ${handoff} and report its token. Continue only this synthetic goal; do not repeat old actions.`;
  const requests: { messages: { role: string; content?: unknown; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] }[] = [];
  const mockErrors: Error[] = [];
  let client: CopilotClient | undefined;
  let engine: Engine | undefined;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(!req.headers.authorization || req.headers.authorization.trim() === 'Bearer');
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const lastUserIndex = body.messages.findLastIndex((m: { role: string }) => m.role === 'user');
      const lastUser = JSON.stringify(body.messages[lastUserIndex]?.content);
      const after = body.messages.slice(lastUserIndex + 1);
      let tool: { name: string; arguments: string } | undefined;
      if (lastUser.includes('RESET_START')) {
        if (!after.some((m: { role: string }) => m.role === 'tool')) {
          tool = { name: 'view', arguments: JSON.stringify({ path: handoff }) };
        } else {
          assert.ok(JSON.stringify(after).includes('SYNTHETIC_CONTINUATION_742'));
          assert.ok(!after.some((m: { tool_calls?: { function: { name: string } }[] }) =>
            m.tool_calls?.some(c => c.function.name === 'self_clear_context')), 'Clear failed; do not retry');
          tool = { name: 'self_clear_context', arguments: JSON.stringify({ prompt: seed, handoffFiles: [handoff] }) };
        }
      } else if (lastUser.includes('RESET_SEED') && !after.some((m: { role: string }) => m.role === 'tool')) {
        assert.ok(!JSON.stringify(body.messages).includes('OLD_MARKER'));
        tool = { name: 'view', arguments: JSON.stringify({ path: handoff }) };
      }
      if (tool) assert.ok(body.tools.some((t: { function: { name: string } }) => t.function.name === tool.name));
      const id = `synthetic-${requests.length}`;
      const call = tool && { id: `call-${requests.length}`, type: 'function', function: tool };
      const answer = 'RESET_DONE_SYNTHETIC_CONTINUATION_742';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(chunk({ role: 'assistant', ...(call ? { tool_calls: [{ index: 0, ...call }] } : { content: answer }) }));
      res.write(chunk({}, call ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
    } catch (error) {
      mockErrors.push(error instanceof Error ? error : new Error(String(error)));
      res.writeHead(400).end('{"error":{"message":"synthetic mock rejected request"}}');
    }
  });
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dirs.work!);
    const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { Engine } = await import('./engine.ts');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config: Partial<SessionConfig> = {
      model: 'gpt-4.1', provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      workingDirectory: dirs.work, configDirectory: dirs.state,
      skipCustomInstructions: true, enableOnDemandInstructionDiscovery: false, enableFileHooks: false,
      enableHostGitOperations: false, enableSessionStore: false, enableSkills: true,
      pluginDirectories: [], instructionDirectories: [], customAgents: [], enableManagedSettings: false,
      skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionTelemetry: false,
      remoteSession: 'off', streaming: true, availableTools: ['self_clear_context', 'view', 'skill'],
      systemMessage: { mode: 'replace', content: 'SYNTHETIC_SYSTEM_PRESERVED' },
    };
    const start = async () => {
      const runtime = new OfficialRuntime({
        clientOptions: { connection: RuntimeConnection.forStdio({ env }), mode: 'empty',
          baseDirectory: dirs.state, workingDirectory: dirs.work, builtinPluginDirectories: [],
          useLoggedInUser: false, enableRemoteSessions: false, onListModels: () => [], logLevel: 'error' },
        clientFactory: options => { client = new CopilotClient(options); return client; },
        sessionConfig: config,
      });
      engine = new Engine({ runtime, prefsFile: join(dirs.state!, 'prefs.json') });
      await engine.start();
    };
    const idle = async (id: string, expected: number) => {
      for (let i = 0; i < 200; i++) {
        assert.deepEqual(mockErrors, []);
        if (requests.length >= expected && (await engine!.getMeta(id))?.status === 'idle') return;
        await sleep(50);
      }
      assert.fail('Synthetic session did not complete its recovery');
    };
    await start();
    const id = await engine!.newSession(dirs.work!);
    await engine!.rename(id, 'Synthetic self-clear');
    const skills = await engine!.listSessionSkills(id);
    assert.ok(skills.some(s => s.name === 'self-context-reset' && s.enabled));
    assert.ok((await engine!.listGlobalSkills(dirs.work)).some(s => s.name === 'self-context-reset' && s.enabled));
    await engine!.prompt(id, 'RESET_START OLD_MARKER: persist already exists; reread before clearing.');
    await idle(id, 4);
    assert.deepEqual(mockErrors, []);
    assert.ok(requests[1]!.tools?.some(t => t.function.name === 'self_clear_context'));
    const firstFresh = requests[2]!.messages;
    assert.ok(!JSON.stringify(firstFresh).includes('OLD_MARKER'));
    assert.equal(firstFresh.filter(m => m.role === 'user').length, 1);
    assert.ok(JSON.stringify(firstFresh).includes('SYNTHETIC_SYSTEM_PRESERVED'));
    const events = await client!.rpc.sessions.readPersistedEvents({ sessionId: id, direction: 'forward', max: 200 });
    assert.ok(events.events.some(e => e.type === 'user.message' && e.data.content.includes('OLD_MARKER')));
    assert.equal(events.events.filter(e => e.type === 'session.context_cleared').length, 1);
    await engine!.stop();
    engine = undefined;
    await start();
    await engine!.prompt(id, 'RESET_COLD_RESUME');
    await idle(id, 5);
    assert.equal((await engine!.getMeta(id))?.sessionId, id);
    assert.ok(!JSON.stringify(requests.at(-1)!.messages).includes('OLD_MARKER'));
    assert.ok(requests.at(-1)!.tools?.some(t => t.function.name === 'self_clear_context'));
    assert.ok((await engine!.listSessionSkills(id)).some(s => s.name === 'self-context-reset' && s.enabled));
    await engine!.stop();
    engine = undefined;
  } finally {
    // On failure stop only this test's private runtime, never a shared service.
    if (client) await client.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
