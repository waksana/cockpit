import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { CopilotSession, SessionConfig } from '@github/copilot-sdk';

test('managed original files reach the isolated native attachment parser and persisted history', {
  skip: process.env.COCKPIT_MANAGED_NATIVE_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-managed-native-'));
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const home = join(root, 'home');
  const work = join(root, 'work');
  const state = join(root, 'state');
  for (const dir of [home, work, state]) mkdirSync(dir, { mode: 0o700 });
  const env = {
    HOME: home, COPILOT_HOME: state, COCKPIT_HOME: state, COCKPIT_UPLOAD_DIR: join(root, 'uploads'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'run'),
    TMPDIR: root, TMP: root, TEMP: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: root,
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(work);
  const requests: string[] = [];
  const errors: unknown[] = [];
  const mediaPaths: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(!req.headers.authorization || req.headers.authorization.trim() === 'Bearer');
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        assert.ok(text.length < 1_000_000);
      }
      requests.push(text);
      const body = JSON.parse(text);
      const answer = 'Synthetic parser receipt; no remote model or external delivery was exercised.';
      const toolCount = body.messages.filter((message: { role: string }) => message.role === 'tool').length;
      const tool = body.tools?.find((item: { function: { name: string } }) => item.function.name === 'view' || item.function.name.endsWith('__view'));
      const toolCall = toolCount < mediaPaths.length ? {
        id: `media-view-${toolCount}`, type: 'function',
        function: { name: tool?.function.name, arguments: JSON.stringify({ path: mediaPaths[toolCount] }) },
      } : undefined;
      if (toolCall) assert.ok(tool, 'native view must be available to read referenced attachments');
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', ...(toolCall
          ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: answer }) }, null], [{}, toolCall ? 'tool_calls' : 'stop']]) {
          res.write(`data: ${JSON.stringify({ id: 'managed-fixture', object: 'chat.completion.chunk',
            model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'managed-fixture', object: 'chat.completion', model: body.model,
          created: 1, choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : answer,
            ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    } catch (error) { errors.push(error); res.writeHead(500).end(); }
  });
  let runtime: import('./runtime.ts').OfficialRuntime | undefined;
  let session: CopilotSession | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { RuntimeConnection } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { saveUploadStream } = await import('../../../apps/server/src/uploads.ts');
    const { partsPrompt } = await import('@cockpit/protocol');
    const { newFoldState, foldEvent } = await import('./fold.ts');
    const { normalizeEvent } = await import('./sdk-types.ts');
    const token = 'managed-file-native-parser-unique-fixture';
    const file = await saveUploadStream(Readable.from([Buffer.from(token)]), 'original.txt', 'text/plain',
      { source: 'org.example.external-feed', sessionId: 'fixture', sourceId: 'text-0' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64');
    const image = await saveUploadStream(Readable.from([png]), 'misnamed-image.txt', 'image/png',
      { source: 'org.example.external-feed', sessionId: 'fixture', sourceId: 'image-1' });
    assert.equal(image.name, 'misnamed-image.txt');
    assert.ok(image.path.endsWith('.png'), 'byte-verified suffix lets native view recognize the image without renaming the original');
    mediaPaths.push(file.path, image.path);
    const sessionConfig: Partial<SessionConfig> = {
      model: 'gpt-6-astra',
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-6-astra' },
      workingDirectory: work, configDirectory: state,
      enableConfigDiscovery: false, skipCustomInstructions: true, enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false, enableSkills: false,
      skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
      enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
      enableSessionTelemetry: false, remoteSession: 'off', streaming: true, availableTools: ['view'],
      systemMessage: { mode: 'replace', content: 'Synthetic parser fixture. Read only the supplied fixture file paths.' },
    };
    runtime = new OfficialRuntime({ sessionConfig, clientOptions: {
      connection: RuntimeConnection.forStdio({ env }), mode: 'empty',
      baseDirectory: state, workingDirectory: work, builtinPluginDirectories: [],
      useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error', onListModels: () => [],
    } });
    await runtime.start();
    session = await runtime.createSession({});
    await session.sendAndWait({
      prompt: partsPrompt([{ type: 'text', text: 'fixture before\n' }, { type: 'file', attachment: file },
        { type: 'text', text: '\nfixture between\n' }, { type: 'file', attachment: image }]),
      attachments: [file, image].map(upload => ({ type: 'file' as const, path: upload.path, displayName: upload.name })),
    }, 20_000);
    assert.deepEqual(errors, []);
    assert.ok(requests.some(request => request.includes(token)), `native parser must expose retained text bytes, not just a link: ${
      requests.map(request => JSON.stringify(JSON.parse(request).messages.filter((message: { role: string }) => message.role === 'user'))).join('\n').slice(0, 4000)}`);
    assert.ok(requests.some(request => request.includes('data:image/png;base64,')), 'retained image must reach native image parsing, not be tagged as text');
    const events = await session.getEvents();
    const folded = newFoldState();
    for (const event of events) foldEvent(folded, normalizeEvent(event));
    const message = folded.messages.find(item => item.role === 'user');
    assert.equal(message?.attachments?.length, 2);
    assert.equal(message?.parts?.[0]?.type, 'text');
    assert.equal(message?.attachments?.[1]?.url, image.url);
    await runtime.closeSession(session);
    session = undefined;
  } finally {
    try {
      if (session && runtime) await runtime.closeSession(session);
      await runtime?.stop();
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
