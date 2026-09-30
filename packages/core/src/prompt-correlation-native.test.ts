import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CopilotSession, SessionEvent, SessionConfig } from '@github/copilot-sdk';
import { fixtureModelCatalog } from '../test-support/session-defaults.ts';

test('native prompt receipts correlate queued turns, multipart replies, ask and background continuation', {
  skip: process.env.COCKPIT_NATIVE_CORRELATION !== '1', timeout: 60_000,
}, async t => {
  const originalEnv = { ...process.env };
  const fixture = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.native-correlation-'));
  const dirs = Object.fromEntries(['home', 'state', 'work', 'scratch', 'config', 'cache', 'data']
    .map(name => [name, join(fixture, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env = {
    HOME: dirs.home!, COPILOT_HOME: dirs.state!, COCKPIT_HOME: dirs.data!,
    XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!,
    TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', TSX_DISABLE_CACHE: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const events: SessionEvent[] = [];
  let release: (() => void) | undefined;
  let answer: (() => void) | undefined;
  let session: CopilotSession | undefined;
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(req.headers.authorization === undefined || req.headers.authorization.trim() === 'Bearer');
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const lastUser = input.messages.findLastIndex((message: { role: string }) => message.role === 'user');
      const marker = JSON.stringify(input.messages[lastUser].content).match(/CORRELATION_[A-Z]+/)?.[0]
        ?? (body.includes('CORRELATION_BACKGROUND') ? 'CORRELATION_CONTINUATION' : undefined);
      assert.ok(marker);
      const called = input.messages.slice(lastUser + 1).some((message: { role: string }) => message.role === 'tool');
      const ask = marker === 'CORRELATION_ASK' && !called;
      const background = marker === 'CORRELATION_BACKGROUND' && !called;
      const tool = input.tools?.find((item: { function: { name: string } }) => item.function.name === (background ? 'bash' : 'ask_user'));
      if (ask || background) assert.ok(tool);
      if (marker === 'CORRELATION_NOASK') assert.equal(tool, undefined, 'Disabling the legacy callback also removes ask_user');
      const respond = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1,
            model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: ask ? 'Before question' : `Reply ${marker}`,
          ...(ask || background ? { tool_calls: [{ index: 0, id: background ? 'fixture-background' : 'fixture-ask', type: 'function',
            function: { name: tool.function.name, arguments: JSON.stringify(background
              ? { command: '/usr/bin/sleep 1', mode: 'async', description: 'Synthetic correlation fixture' }
              : { question: 'Fixture?', choices: ['yes'] }) } }] } : {}) }));
        res.write(chunk({}, ask || background ? 'tool_calls' : 'stop'));
        res.end('data: [DONE]\n\n');
      };
      if (marker === 'CORRELATION_HOLD' || marker === 'CORRELATION_ABORT') release = respond;
      else respond();
    } catch (error) { failures.push(error); res.writeHead(500).end(); }
  });
  const { RuntimeConnection } = await import('@github/copilot-sdk');
  const { OfficialRuntime } = await import('./runtime.ts');
  const runtime = new OfficialRuntime({
    clientOptions: {
      connection: RuntimeConnection.forStdio({ env }), mode: 'empty',
      baseDirectory: dirs.state, workingDirectory: dirs.work, builtinPluginDirectories: [],
      useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error',
      onListModels: fixtureModelCatalog,
    },
  });
  const until = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (condition()) return;
      assert.deepEqual(failures, []);
      await sleep(25);
    }
    assert.fail('Native correlation fixture timed out');
  };
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await runtime.start();
    const config: SessionConfig = {
      model: 'gpt-4.1', workingDirectory: dirs.work, configDirectory: dirs.state,
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      enableConfigDiscovery: false, skipCustomInstructions: true, enableSkills: false,
      enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false,
      enableManagedSettings: false, enableSessionTelemetry: false, remoteSession: 'off',
      skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
      pluginDirectories: [], skillDirectories: [], instructionDirectories: [], customAgents: [],
      streaming: true, availableTools: ['ask_user', 'bash'],
      systemMessage: { mode: 'replace', content: 'Synthetic loopback fixture only.' },
      onEvent: event => events.push(event),
      onUserInputRequest: (request, invocation) => new Promise(resolve => {
        assert.deepEqual(Object.keys(request).sort(), ['allowFreeform', 'choices', 'question']);
        assert.deepEqual(Object.keys(invocation), ['sessionId']);
        assert.equal('requestId' in request, false, 'The native event identity is not passed to the legacy callback');
        answer = () => resolve({ answer: 'yes', wasFreeform: false });
      }),
    };
    session = await runtime.createSession(config);
    const held = await session.send('CORRELATION_HOLD');
    await until(() => !!release);
    const queued = await session.send({ prompt: 'CORRELATION_ASK', mode: 'enqueue' });
    assert.ok((await session.rpc.queue.pendingItems()).items.some(item => item.messageId === queued));
    release!();
    await until(() => !!answer && events.some(event => event.type === 'user_input.requested'));
    const nativeRequest = events.find(event => event.type === 'user_input.requested');
    assert.ok(nativeRequest?.type === 'user_input.requested');
    assert.equal(nativeRequest.data.toolCallId, 'fixture-ask');
    assert.ok(nativeRequest.data.requestId);
    answer!();
    await until(() => events.some(event => event.type === 'assistant.message' && event.data.content === 'Reply CORRELATION_ASK'));
    await until(() => events.some(event => event.type === 'session.idle'));
    const ordinary = await session.send('CORRELATION_ORDINARY');
    await until(() => events.some(event => event.type === 'assistant.message' && event.data.content === 'Reply CORRELATION_ORDINARY'));
    const background = await session.send({ prompt: 'CORRELATION_BACKGROUND', mode: 'enqueue' });
    await until(() => events.some(event => event.type === 'tool.execution_complete' && event.data.toolCallId === 'fixture-background'));
    const backgroundResult = events.find(event => event.type === 'tool.execution_complete' && event.data.toolCallId === 'fixture-background');
    assert.ok(backgroundResult?.type === 'tool.execution_complete' && backgroundResult.data.success);
    await until(() => events.some(event => event.type === 'assistant.message' && event.data.content === 'Reply CORRELATION_CONTINUATION'));
    const backgroundMessages = events.filter(event => event.type === 'assistant.message'
      && event.data.content === 'Reply CORRELATION_BACKGROUND');
    const continuation = events.find(event => event.type === 'assistant.message' && event.data.content === 'Reply CORRELATION_CONTINUATION');
    assert.equal(backgroundMessages.length, 2);
    release = undefined;
    const aborted = await session.send({ prompt: 'CORRELATION_ABORT', mode: 'enqueue' });
    await until(() => !!release);
    const idleCount = events.filter(event => event.type === 'session.idle').length;
    await session.abort();
    await until(() => events.some(event => event.type === 'abort'));
    release!();
    await until(() => events.filter(event => event.type === 'session.idle').length > idleCount);
    const beforeAfter = events.filter(event => event.type === 'session.idle').length;
    const after = await session.send('CORRELATION_AFTER');
    await until(() => events.some(event => event.type === 'assistant.message' && event.data.content === 'Reply CORRELATION_AFTER'));
    await until(() => events.filter(event => event.type === 'session.idle').length > beforeAfter);
    const ids = [held, queued, ordinary, background, aborted, after].map(receipt => {
      const user = events.find(event => event.type === 'user.message' && event.data.messageId === receipt);
      assert.ok(user && user.type === 'user.message');
      assert.notEqual(user.id, receipt);
      assert.ok(user.data.interactionId);
      return user.data.interactionId;
    });
    assert.equal(new Set(ids).size, ids.length);
    const byEventId = new Map(events.map(event => [event.id, event]));
    const ancestorInteractions = (event: SessionEvent) => {
      const visited = new Set<string>();
      const interactions = new Set<string>();
      let parentId = event.parentId;
      while (parentId) {
        assert.ok(!visited.has(parentId), 'Native parent chain is acyclic');
        visited.add(parentId);
        const parent = byEventId.get(parentId);
        if (!parent) break;
        if ('interactionId' in parent.data && typeof parent.data.interactionId === 'string') {
          interactions.add(parent.data.interactionId);
        }
        parentId = parent.parentId;
      }
      return [...interactions];
    };
    const finalIdle = events.findLast(event => event.type === 'session.idle');
    assert.ok(finalIdle);
    assert.deepEqual(new Set(ancestorInteractions(finalIdle)), new Set(ids),
      'A later ordinary idle inherits every older interaction through the chronological parent chain, not just its owner');
    const abort = events.find(event => event.type === 'abort');
    assert.ok(abort);
    assert.ok(ancestorInteractions(abort).includes(ids[3]!),
      'Abort ancestry includes the already completed background interaction as well as the aborted one');
    assert.ok(backgroundMessages.every(event => 'interactionId' in event.data && event.data.interactionId === ids[3]));
    assert.ok(continuation?.type === 'assistant.message');
    assert.equal(continuation.data.interactionId, ids[3], 'The real background completion retains its originating interaction');
    const startBackground = events.findIndex(event => event.type === 'user.message' && event.data.messageId === background);
    const resumedBackground = events.indexOf(continuation);
    const beforeContinuation = events.slice(startBackground, resumedBackground);
    assert.ok(beforeContinuation.some(event => event.type === 'assistant.turn_end'));
    assert.ok(beforeContinuation.some(event => event.type === 'assistant.idle'));
    assert.ok(!beforeContinuation.some(event => event.type === 'session.idle'),
      'Session idle is deferred while attached background work is pending, unlike assistant idle');
    assert.ok(!events.some(event => event.type === 'session.completion_receipt'),
      'The experimental completion receipt is not emitted for these ordinary native interactions');
    const parts = events.filter(event => event.type === 'assistant.message' && event.data.interactionId === ids[1]);
    assert.equal(parts.length, 2, 'Both parts, including the resumed answer, retain the delivered interaction');
    assert.ok(parts.every(event => event.type === 'assistant.message' && event.data.content !== 'Reply CORRELATION_ORDINARY'));
    for (const event of events.filter(event => ['assistant.turn_end', 'assistant.idle', 'abort', 'session.idle'].includes(event.type))) {
      assert.equal('interactionId' in event.data, false, `${event.type} cannot identify a delivered interaction`);
    }
    await runtime.closeSession(session);
    session = undefined;
    const directEvents: SessionEvent[] = [];
    session = await runtime.createSession({ ...config, onUserInputRequest: undefined, onEvent: event => directEvents.push(event) });
    await session.send('CORRELATION_NOASK');
    await until(() => directEvents.some(event => event.type === 'session.idle'));
    await runtime.closeSession(session);
    session = undefined;
    t.diagnostic('Native receipts match user data.messageId, not event.id. Ask/background continuation retains interactionId. Assistant idle precedes background continuation; session idle waits. Native ask events have requestId/toolCallId, but legacy callbacks do not; disabling callbacks removes ask_user. Terminal events have no interactionId; ordinary runs emit no completion receipt.');
    assert.deepEqual(failures, []);
  } finally {
    try {
      if (session) {
        await session.abort();
        await runtime.closeSession(session);
      }
      await runtime.stop();
    }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});
