import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_ORIGIN, mockHttp } from '../test-support/mock-http.ts';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { Intents, type Attachment, type ChatMessage, type SessionMeta, type SessionPanels, type SessionPlan, type Snapshot } from '../../../packages/protocol/src/index.ts';

type Request = { path: string; method: string; body: unknown; authorization: string | undefined };
const requests: Request[] = [];
const schemas: Record<string, z.ZodType> = {
  ...Object.fromEntries(Object.entries(Intents).map(([name, definition]) => [name, definition.body])),
  'future/operation': z.object({ value: z.number() }).strict(),
};
const attachment: Attachment = { kind: 'image', name: 'display name.png', url: '/uploads/safe-image.png', size: 20, mime: 'image/png' };
const retainedFile = {
  ...attachment, size: 20, mime: 'image/png', path: '/remote/uploads/safe-image.png',
  source: 'tool-image', sessionId: 'B', sha256: 'a'.repeat(64), createdAt: 1,
};
const messages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'earlier question', timestamp: 1 },
  {
    id: 'm2', role: 'assistant', content: 'canonical answer', timestamp: 2,
    thought: 'reasoning',
    toolCalls: [{ toolCallId: 'tool-1', title: 'Read file', name: 'read_file', args: '{}', status: 'completed', output: 'from backend' }],
    subMessages: [{ id: 'child', role: 'assistant', content: 'subagent result', timestamp: 2 }],
    attachment,
  },
];
let unavailable = false;
let large = false;
const initialLargeContent = 'large "quoted" tool transcript\n'.repeat(4000);
let largeContent = initialLargeContent;
let malformedPreview = false;
let mismatchedCapability = false;
let rejectedIntent: string | undefined;
let intentFailure: number | 'invalid-json' | 'connection' | undefined;
let invalidPolicy = false;
const meta: SessionMeta = {
  sessionId: 'B', title: 'Backend title', cwd: '/only-on-backend/project',
  status: 'unloaded', loaded: false, lastActivity: 1,
  error: null, ask: null, planRequest: null, elicitation: null, intent: null, attention: null,
  currentReasoningEffort: null, currentContextTier: null, currentMode: null,
  queue: [{ id: 'q1', text: 'pending' }],
  todo: { done: 1, total: 3, intent: 'Testing canonical state' },
  availableModels: [{ modelId: 'model-1', name: 'Model one' }],
  loading: true, closing: false, cancelling: true,
};
const snapshot: Snapshot = {
  type: 'snapshot', agentStatus: 'up', models: meta.availableModels ?? [], vapidPublicKey: null,
  sessions: [meta], permissionPolicy: 'allow-all',
};
const plan: SessionPlan = {
  planMarkdown: '## Canonical narrative\nPreserve the real plan.',
  todos: [
    { id: 'todo-1', title: 'Implement contract', status: 'done' },
    { id: 'todo-2', title: 'Verify MCP', description: 'Use mocked transports', status: 'in_progress' },
    { id: 'todo-3', title: 'Wait for parent', status: 'blocked' },
  ],
  changedFiles: [{ path: 'apps/mcp/src/shared.ts', operation: 'edit' }],
};
const panels: SessionPanels = {
  skills: [{ label: 'review', sublabel: 'Project review skill', enabled: true }],
  mcpServers: [{ label: 'test-server', sublabel: 'unloaded', enabled: false }],
  tasks: [{ label: 'Explorer', sublabel: 'Finding canonical types' }],
  instructionSources: [{ label: 'AGENTS.md', sublabel: '/remote/project/AGENTS.md' }],
  schedules: [{ label: 'Daily check', sublabel: 'Tomorrow', enabled: true }],
};
mockHttp((res, req) => {
    const text = req.body.toString();
    const body: unknown = text ? JSON.parse(text) : undefined;
    const path = req.url ?? '';
    requests.push({ path, method: req.method ?? '', body, authorization: req.headers.authorization as string | undefined });
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (unavailable) return send({ error: 'backend unavailable' }, 503);
    const url = new URL(path, 'http://mock.invalid');
    if (url.pathname === '/capabilities') {
      const name = url.searchParams.get('name');
      if (name !== null) {
        if (!Object.hasOwn(schemas, name)) return send({ error: `unknown intent: ${name}` }, 404);
        return send({
          name: mismatchedCapability ? 'wrong/intent' : name, description: name,
          inputSchema: { type: 'object' }, resultSchema: { type: 'object' },
        });
      }
      const prefix = url.searchParams.get('prefix') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return send({
        intents: Object.keys(schemas).sort().filter((name) => name.startsWith(prefix))
          .slice(offset, offset + limit).map((name) => ({ name, description: name })),
        transports: [{ method: 'GET', path: '/capabilities' }, { method: 'POST', path: '/intent/*' }],
      });
    }
    if (url.pathname === '/health') return send({ ok: true });
    if (url.pathname === '/status') return send({ busy: 1, restartPending: false, permissionPolicy: 'allow-all' });
    if (url.pathname === '/admin/restart') return send({ busy: 1, restartPending: true, willRestartWhenIdle: true });
    const name = path.slice('/intent/'.length);
    const schema = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
    if (!path.startsWith('/intent/') || !schema) return send({ error: 'unknown intent' }, 404);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return send({ error: parsed.error.message }, 400);
    if (typeof intentFailure === 'number') return send({ error: 'authoritative service failure' }, intentFailure);
    if (intentFailure === 'invalid-json') return res.end('not JSON');
    if (intentFailure === 'connection') return res.destroy();
    if (name === rejectedIntent) return send({ ok: false, error: 'genuine target failure', operation: { id: 'failed-op', state: 'failed' } });
    if (name === 'runtime/snapshot') return send(invalidPolicy ? { ...snapshot, permissionPolicy: undefined } : snapshot);
    if (name === 'session/list') return send({ sessions: [meta] });
    if (name === 'session/get') return send({ meta });
    if (name === 'session/plan') return send(plan);
    if (name === 'session/usage') return send({
      sessionId: 'B', sampledAt: 123, context: null,
      usage: { sessionStartTime: '2026-09-09T00:00:00Z', totalUserRequests: 1,
        lastCallInputTokens: 321, lastCallOutputTokens: 45, modelMetrics: {} },
    });
    if (name === 'session/panels') return send(panels);
    if (name === 'skills/global') return send({ skills: [{ name: 'review', description: 'Review changes', source: 'project' }] });
    if (name === 'session/peek' || name === 'session/history' || name === 'session/subagent-history') {
      const input = z.object({
        sessionId: z.string(), toolCallId: z.string().optional(), beforeMsgId: z.string().optional(),
        afterMsgId: z.string().optional(), limit: z.number().default(40),
      }).parse(body);
      const source = name === 'session/subagent-history' ? messages[1]!.subMessages! : messages;
      const end = input.beforeMsgId ? source.findIndex((message) => message.id === input.beforeMsgId) : source.length;
      const start = input.afterMsgId ? source.findIndex((message) => message.id === input.afterMsgId) + 1 : Math.max(0, end - input.limit);
      return send(malformedPreview ? {} : {
        sessionId: input.sessionId,
        ...(name === 'session/peek' ? { title: meta.title, cwd: meta.cwd } : {
          latest: input.beforeMsgId === undefined, ...(input.afterMsgId ? { append: true } : {}),
        }),
        ...(name === 'session/subagent-history' ? {
          toolCallId: input.toolCallId,
          subagent: { name: 'task', displayName: 'Child', status: 'completed', prompt: 'Full child prompt' },
        } : {}),
        messages: large ? [{ ...messages[1], content: largeContent }] : source.slice(start, end),
        hasMore: !input.afterMsgId && start > 0,
      });
    }
    if (name === 'session/new') return send({ sessionId: 'new-id' });
    if (name === 'session/fork') return send({ sessionId: 'forked-id' });
    if (name === 'session/interrupt') return send({ ok: true, interrupted: Intents['session/interrupt'].body.parse(body).sessionId === 'running' });
    if (name === 'session/auto-name') return send({
      ok: true, applied: false, title: 'User title', reason: 'user-named',
    });
    if (name === 'future/operation') return send({ echoed: parsed.data });
    if (name === 'files/list') return send({
      files: [retainedFile], hasMore: false,
      errors: [{ url: '/uploads/unreadable.bin', error: 'Missing metadata' }],
    });
    if (['files/get', 'files/from-tool-image', 'files/associate'].includes(name)) return send(retainedFile);
    if (name === 'prompt') {
      const input = Intents.prompt.body.parse(body);
      if (input.attachment && !/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(input.attachment.url)) {
        return send({ error: 'Expected /uploads/<safe-basename>' }, 400);
      }
    }
    if (name === 'session/rewind' && Intents['session/rewind'].body.parse(body).rollbackFiles) {
      return send({ error: 'File rollback is unsupported; no mutation performed' }, 400);
    }
    return send({ ok: true });
});
process.env.COCKPIT_API_TOKEN = 'session-test-token';
// These retired settings point to absent paths. Nothing should consult them.
process.env.COCKPIT_HOME = '/nonexistent-cockpit-session-test';
process.env.COCKPIT_SESSION_STORE = '/nonexistent-cockpit-session-test/session-store.db';
process.env.COCKPIT_SESSION_STATE_DIR = '/nonexistent-cockpit-session-test/session-state';
const { createMcpServer } = await import('./index.ts');
const { CHARACTER_LIMIT } = await import('./config.ts');
const server = createMcpServer();
const client = new Client({ name: 'foundation-client', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
after(async () => {
  await client.close();
  await server.close();
});
beforeEach(() => {
  requests.length = 0;
  unavailable = large = malformedPreview = mismatchedCapability = false;
  invalidPolicy = false;
  rejectedIntent = undefined;
  intentFailure = undefined;
  largeContent = initialLargeContent;
});

const ToolReply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = ToolReply.parse(await client.callTool({ name, arguments: args }));
  assert.ok(result.content[0]);
  return { text: result.content[0].text, isError: result.isError ?? false };
}
async function json(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await call(name, args);
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
}

test('registry exposes foundation, native schedules, manual settings and files, not governance', async () => {
  const { tools } = await client.listTools();
  const names = tools.map(({ name }) => name);
  const expected = [
    'cockpit_capabilities', 'cockpit_call_intent', 'cockpit_service_status', 'cockpit_service_restart',
    'cockpit_read_session', 'cockpit_send_prompt', 'cockpit_upload_file', 'cockpit_download_file',
    'cockpit_schedule_add', 'cockpit_list_schedules', 'cockpit_stop_schedule',
    'cockpit_list_session_mcp', 'cockpit_set_session_mcp', 'cockpit_set_session_skill',
    'cockpit_get_snapshot', 'cockpit_list_sessions', 'cockpit_get_session',
    'cockpit_get_panels', 'cockpit_get_plan', 'cockpit_new_session', 'cockpit_delete_session',
    'cockpit_purge_session', 'cockpit_unload_session', 'cockpit_reload_session',
    'cockpit_rename_session', 'cockpit_set_session_pin', 'cockpit_cancel_turn', 'cockpit_remove_queued',
    'cockpit_respond_ask', 'cockpit_respond_plan', 'cockpit_plan_supersede', 'cockpit_respond_elicitation',
    'cockpit_set_model', 'cockpit_set_mode', 'cockpit_compact_session', 'cockpit_rewind_session',
    'cockpit_list_global_mcp', 'cockpit_set_global_mcp_default', 'cockpit_refresh_mcp',
    'cockpit_reload_session_mcp', 'cockpit_list_global_skills', 'cockpit_list_session_skills',
    'cockpit_refresh_skills', 'cockpit_list_dir',
  ];
  assert.deepEqual(names.sort(), expected.sort());
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.some((name) => /hook|flow|gate|spawned/.test(name)), false);
  const newSession = tools.find(({ name }) => name === 'cockpit_new_session');
  assert.deepEqual(Object.keys(newSession?.inputSchema.properties ?? {}), ['cwd']);
  assert.equal(requests.length, 0, 'registry construction must not read HTTP or local state');
});

test('the published executable starts MCP when invoked through a bin symlink', async () => {
  const fixture = resolve(`.mcp-bin-fixture-${randomUUID()}`);
  await mkdir(fixture);
  const entry = join(fixture, 'cockpit-mcp-server');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', './test-support/guard-network.ts', entry],
    env: { ...process.env, COCKPIT_URL: MOCK_ORIGIN },
    stderr: 'pipe',
  });
  const binClient = new Client({ name: 'bin-client', version: '1.0.0' });
  try {
    await symlink(fileURLToPath(new URL('./index.ts', import.meta.url)), entry);
    await binClient.connect(transport);
    assert.ok((await binClient.listTools()).tools.some(({ name }) => name === 'cockpit_call_intent'));
    assert.equal(requests.length, 0);
  } finally {
    await binClient.close();
    await transport.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('session lists, full state and transcript read exclusively through HTTP', async () => {
  const live = z.object({ sessions: z.array(z.object({ sessionId: z.string(), title: z.string() }).passthrough()) })
    .parse(await json('cockpit_list_sessions', { response_format: 'json' }));
  assert.equal(live.sessions[0]?.title, meta.title);
  assert.ok(live.sessions.every((session) => !('launchState' in session) && !('spawnedBy' in session)));
  await json('cockpit_get_session', { session_id: 'B', response_format: 'json' });
  for (const sessionId of ['B', 'unloaded']) {
    const page = z.object({ messages: z.array(z.unknown()), title: z.string(), cwd: z.string(), source: z.string() })
      .parse(await json('cockpit_read_session', { session_id: sessionId, response_format: 'json' }));
    assert.deepEqual(page.messages, messages, 'all canonical fields must survive, including images and subagents');
    assert.equal(page.title, meta.title);
    assert.equal(page.cwd, meta.cwd);
    assert.equal(page.source, 'api');
  }
  assert.deepEqual(requests.map(({ path }) => path), [
    '/intent/session/list', '/intent/session/get',
    '/intent/session/peek', '/intent/session/peek',
  ]);
  assert.ok(requests.every((request) => request.authorization === 'Bearer session-test-token'));
});

test('transcript cursor requests older canonical messages without turn offsets', async () => {
  const Page = z.object({ messages: z.array(z.unknown()), hasMore: z.boolean(), nextBeforeMsgId: z.string().nullable() });
  const newest = Page.parse(await json('cockpit_read_session', { session_id: 'B', limit: 1, response_format: 'json' }));
  assert.deepEqual(newest.messages, [messages[1]]);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.nextBeforeMsgId, 'm2');
  const older = Page.parse(await json('cockpit_read_session', {
    session_id: 'B', limit: 1, before_message_id: newest.nextBeforeMsgId, response_format: 'json',
  }));
  assert.deepEqual(older.messages, [messages[0]]);
  assert.equal(older.hasMore, false);
  assert.equal(older.nextBeforeMsgId, null);
  assert.deepEqual(requests[1]?.body, { sessionId: 'B', beforeMsgId: 'm2', limit: 1 });
});

test('oversized transcript pages are lossless bounded JSON fragments', async () => {
  large = true;
  const Fragment = z.object({
    format: z.literal('json-fragment'), pageVersion: z.string(),
    nextPageOffset: z.number().nullable(), json: z.string(),
  });
  let offset: number | null = 0;
  let version: string | undefined;
  let serialized = '';
  while (offset !== null) {
    const result = await call('cockpit_read_session', {
      session_id: 'B', limit: 1, page_offset: offset, page_version: version, response_format: 'json',
    });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.length <= CHARACTER_LIMIT);
    const fragment = Fragment.parse(JSON.parse(result.text));
    if (version !== undefined) assert.equal(fragment.pageVersion, version);
    version = fragment.pageVersion;
    serialized += fragment.json;
    offset = fragment.nextPageOffset;
  }
  const page = z.object({ messages: z.array(z.object({ content: z.string(), attachment: z.unknown() })) }).parse(JSON.parse(serialized));
  assert.equal(page.messages[0]?.content, 'large "quoted" tool transcript\n'.repeat(4000));
  assert.deepEqual(page.messages[0]?.attachment, messages[1]?.attachment);
});

test('transcript continuation requires a page version before any backend request', async () => {
  const result = await call('cockpit_read_session', { session_id: 'B', page_offset: 8000 });
  assert.equal(result.isError, true);
  assert.match(result.text, /page_version is required/);
  assert.equal(requests.length, 0);
});

test('transcript continuation rejects same-length content changes instead of mixing messages', async () => {
  large = true;
  const Fragment = z.object({ pageVersion: z.string(), nextPageOffset: z.number(), json: z.string() });
  const first = Fragment.parse(await json('cockpit_read_session', {
    session_id: 'B', limit: 1, response_format: 'json',
  }));
  largeContent = initialLargeContent.replace(/large/g, 'newer');
  assert.equal(largeContent.length, initialLargeContent.length);
  const next = await call('cockpit_read_session', {
    session_id: 'B', limit: 1, page_offset: first.nextPageOffset,
    page_version: first.pageVersion, response_format: 'json',
  });
  assert.equal(next.isError, true);
  assert.match(next.text, /canonical page changed/);
  const restarted = Fragment.parse(await json('cockpit_read_session', {
    session_id: 'B', limit: 1, response_format: 'json',
  }));
  assert.notEqual(restarted.pageVersion, first.pageVersion);
});

test('backend failures and malformed transcript never become local fallback success', async () => {
  unavailable = true;
  for (const name of ['cockpit_list_sessions', 'cockpit_get_session', 'cockpit_read_session']) {
    const result = await call(name, { session_id: 'B' });
    assert.equal(result.isError, true);
    assert.match(result.text, /backend unavailable/);
  }
  unavailable = false;
  malformedPreview = true;
  assert.equal((await call('cockpit_read_session', { session_id: 'B' })).isError, true);
});

test('explicit A to B send and read use the same backend without governance', async () => {
  const sent = await call('cockpit_send_prompt', { session_id: 'B', text: 'From session A: review this image' });
  assert.equal(sent.isError, false, sent.text);
  assert.deepEqual(requests[0]?.body, { sessionId: 'B', text: 'From session A: review this image', mode: 'enqueue' });
  await json('cockpit_read_session', { session_id: 'B', response_format: 'json' });
  assert.deepEqual(requests.map(({ path }) => path), ['/intent/prompt', '/intent/session/peek']);
});

test('discovery lists bounded names or one schema and supports future intents without wrappers', async () => {
  const names = await json('cockpit_capabilities', { prefix: 'session/', limit: 2, offset: 1 });
  assert.ok(names);
  assert.equal(requests[0]?.path, '/capabilities?limit=2&offset=1&prefix=session%2F');
  const detail = z.object({ name: z.string(), inputSchema: z.unknown(), resultSchema: z.unknown() })
    .parse(await json('cockpit_capabilities', { name: 'future/operation' }));
  assert.equal(detail.name, 'future/operation');
  requests.length = 0;
  assert.deepEqual(await json('cockpit_call_intent', { name: 'future/operation', body: { value: 42 } }), { echoed: { value: 42 } });
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [['POST', '/intent/future/operation']]);
  assert.ok(requests.every((request) => request.authorization === 'Bearer session-test-token'));
});

test('generic future invocation is independent of explicit discovery and its failures', async () => {
  mismatchedCapability = true;
  const discovery = await call('cockpit_capabilities', { name: 'future/operation' });
  assert.equal(discovery.isError, true);
  assert.match(discovery.text, /different intent capability/);
  assert.deepEqual(requests.map(({ method }) => method), ['GET']);
  requests.length = 0;
  for (const value of [1, 2]) {
    assert.deepEqual(await json('cockpit_call_intent', { name: 'future/operation', body: { value } }), { echoed: { value } });
  }
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ['POST', '/intent/future/operation'], ['POST', '/intent/future/operation'],
  ]);
});

test('fork is discoverable and callable through the unified MCP intent entry with native fields', async () => {
  const body = { sessionId: 'source', toEventId: 'root-user-event', name: 'Independent' };
  assert.deepEqual(await json('cockpit_call_intent', { name: 'session/fork', body }), { sessionId: 'forked-id' });
  assert.deepEqual(requests.map(request => request.path), ['/intent/session/fork']);
  assert.deepEqual(requests[0]?.body, body);
});

test('generic invocation surfaces authoritative unknown and retired name errors with one POST each', async () => {
  for (const name of [
    'unknown', 'hook/add', 'flow/run', 'flow/write-gate', 'flow-schedule/add', 'session/set-spawned-by',
    '__proto__', 'constructor',
  ]) {
    requests.length = 0;
    const result = await call('cockpit_call_intent', { name, body: {} });
    assert.equal(result.isError, true, name);
    assert.match(result.text, /HTTP 404: unknown intent/);
    assert.deepEqual(requests.map(({ method, path }) => [method, path]), [['POST', `/intent/${name}`]]);
  }
});

test('generic invocation rejects malformed names and non-object bodies before HTTP', async () => {
  for (const name of [
    '', 'a'.repeat(201),
    '../admin/restart', '/admin/restart', 'session/../purge', 'session%2Fpurge', '//evil.invalid',
    'http://evil.invalid', 'session\\purge', 'prompt?x=1', 'prompt#fragment',
  ]) {
    const result = await call('cockpit_call_intent', { name, body: {} });
    assert.equal(result.isError, true, name);
  }
  for (const body of [null, [], 'invalid', 42]) {
    assert.equal((await call('cockpit_call_intent', { name: 'prompt', body })).isError, true);
  }
  assert.equal(requests.length, 0);
});

test('generic service, protocol and connection failures remain MCP errors without retries', async () => {
  for (const [failure, message] of [
    [401, /HTTP 401: authoritative service failure/],
    [421, /HTTP 421: authoritative service failure/],
    [500, /HTTP 500: authoritative service failure/],
    [503, /HTTP 503: authoritative service failure/],
    ['invalid-json', /returned invalid JSON/],
    ['connection', /Cannot connect.*socket hang up/],
  ] as const) {
    requests.length = 0;
    intentFailure = failure;
    const result = await call('cockpit_call_intent', { name: 'session/purge', body: { sessionId: 'B', confirm: true } });
    assert.equal(result.isError, true);
    assert.match(result.text, message);
    assert.deepEqual(requests.map(({ method, path }) => [method, path]), [['POST', '/intent/session/purge']]);
  }
});

test('generic validation and purge confirmation are owned by backend, semantic purge forwards true', async () => {
  for (const body of [{}, { value: 'wrong type' }]) {
    const result = await call('cockpit_call_intent', { name: 'future/operation', body });
    assert.equal(result.isError, true);
    assert.match(result.text, /HTTP 400/);
  }
  for (const body of [{ sessionId: 'B' }, { sessionId: 'B', confirm: false }]) {
    assert.equal((await call('cockpit_call_intent', { name: 'session/purge', body })).isError, true);
  }
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 4);
  assert.equal(requests.length, 4, 'invalid bodies are sent once to the backend without preflight');
  await json('cockpit_call_intent', { name: 'session/purge', body: { sessionId: 'B', confirm: true } });
  requests.length = 0;
  assert.equal((await call('cockpit_purge_session', { session_id: 'B' })).isError, true);
  assert.equal(requests.length, 0);
  assert.equal((await call('cockpit_purge_session', { session_id: 'B', confirm: true })).isError, false);
  assert.deepEqual(requests[0]?.body, { sessionId: 'B', confirm: true });
});

test('session creation forwards cwd only and fixed service tools preserve confirmation and credentials', async () => {
  assert.equal((await call('cockpit_new_session', { cwd: '/remote/cwd' })).isError, false);
  assert.deepEqual(requests[0]?.body, { cwd: '/remote/cwd' });
  await json('cockpit_service_status', { operation: 'health' });
  await json('cockpit_service_status', { operation: 'status' });
  assert.equal((await call('cockpit_service_status', { operation: '../admin/restart' })).isError, true);
  assert.equal((await call('cockpit_service_restart', { pending: true })).isError, true);
  assert.equal(requests.length, 3);
  await json('cockpit_service_restart', { pending: true, confirm: true });
  await json('cockpit_service_restart', { pending: false, confirm: true });
  assert.deepEqual(requests.slice(1).map(({ path }) => path), ['/health', '/status', '/admin/restart', '/admin/restart']);
  assert.deepEqual(requests[3]?.body, { pending: true });
  assert.deepEqual(requests[4]?.body, { pending: false });
  assert.ok(requests.every((request) => request.authorization === 'Bearer session-test-token'));
});

test('permanent delete requires explicit confirmation and retired trash tools are absent', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.some(t => ['cockpit_list_trash', 'cockpit_restore_session'].includes(t.name)), false);
  const tool = tools.find(t => t.name === 'cockpit_delete_session')!;
  assert.ok(tool.inputSchema.required?.includes('confirm'));
  assert.match(tool.description!, /IRREVERSIBLE/);
  for (const args of [{ session_id: 'B' }, { session_id: 'B', reason: 'declutter' },
    { session_id: 'B', confirm: false }, { session_id: 'B', confirm: 'true' }]) {
    assert.equal((await call('cockpit_delete_session', args)).isError, true);
    assert.equal(requests.length, 0);
  }
  assert.equal((await call('cockpit_delete_session', { session_id: 'B', confirm: true })).isError, false);
  assert.deepEqual(requests.map(r => ({ path: r.path, body: r.body })), [
    { path: '/intent/session/purge', body: { sessionId: 'B', confirm: true } },
  ]);
});

test('canonical plan narrative, todos, changed files and panel sublabels/enabled flags render nonempty', async () => {
  const renderedPlan = await call('cockpit_get_plan', { session_id: 'B' });
  assert.equal(renderedPlan.isError, false, renderedPlan.text);
  for (const text of ['Canonical narrative', '[done] Implement contract', '[in_progress] Verify MCP', 'Use mocked transports', '[blocked] Wait for parent', 'edit: apps/mcp/src/shared.ts']) {
    assert.ok(renderedPlan.text.includes(text), text);
  }
  assert.deepEqual(await json('cockpit_get_plan', { session_id: 'B', response_format: 'json' }), plan);
  const renderedPanels = await call('cockpit_get_panels', { session_id: 'B' });
  assert.equal(renderedPanels.isError, false, renderedPanels.text);
  for (const text of ['review · enabled', 'Project review skill', 'test-server · disabled', 'unloaded', 'Finding canonical types', '/remote/project/AGENTS.md', 'Tomorrow']) {
    assert.ok(renderedPanels.text.includes(text), text);
  }
  assert.deepEqual(await json('cockpit_get_panels', { session_id: 'B', response_format: 'json' }), panels);
});

test('plan description absence and empty text survive semantic and generic MCP reads', async () => {
  const original = plan.todos;
  try {
    plan.todos = [
      { id: 'missing', title: 'No description', status: 'pending' },
      { id: 'normalized', title: 'Normalized null', description: undefined, status: 'blocked' },
      { id: 'empty', title: 'Empty description', description: '', status: 'done' },
      { id: 'text', title: 'Actual description', description: 'Preserve description', status: 'in_progress' },
    ];
    const expected = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(await json('cockpit_get_plan', { session_id: 'B', response_format: 'json' }), expected);
    assert.deepEqual(await json('cockpit_call_intent', { name: 'session/plan', body: { sessionId: 'B' } }), expected);
    const rendered = await call('cockpit_get_plan', { session_id: 'B' });
    assert.equal(rendered.isError, false, rendered.text);
    for (const text of ['No description', 'Normalized null', 'Empty description', 'Actual description', 'Preserve description', 'Canonical narrative', 'apps/mcp/src/shared.ts']) {
      assert.ok(rendered.text.includes(text), text);
    }
    assert.doesNotMatch(rendered.text, /undefined/);
  } finally {
    plan.todos = original;
  }
});

test('canonical nullable status and todo intent survive JSON and render without undefined', async () => {
  assert.deepEqual(await json('cockpit_get_session', { session_id: 'B', response_format: 'json' }), meta);
  const rendered = await call('cockpit_get_session', { session_id: 'B' });
  assert.equal(rendered.isError, false, rendered.text);
  assert.match(rendered.text, /interaction mode: — \(not a permission policy\)/);
  assert.match(rendered.text, /1\/3 done · now: Testing canonical state/);
  assert.match(rendered.text, /loading: true/);
  assert.match(rendered.text, /cancelling: true/);
  assert.doesNotMatch(rendered.text, /undefined|null|closing: true/);
  const originalTodo = meta.todo;
  const originalPlan = plan.planMarkdown;
  const originalTodos = plan.todos;
  try {
    meta.todo = { done: 0, total: 0, intent: null };
    assert.doesNotMatch((await call('cockpit_get_session', { session_id: 'B' })).text, /now:|undefined|null/);
    meta.todo = null;
    assert.equal((await call('cockpit_get_session', { session_id: 'B' })).isError, false);
    plan.planMarkdown = null;
    plan.todos = [];
    const empty = await call('cockpit_get_plan', { session_id: 'B' });
    assert.equal(empty.isError, false, empty.text);
    assert.match(empty.text, /No plan narrative/);
    assert.match(empty.text, /No todos/);
  } finally {
    meta.todo = originalTodo;
    plan.planMarkdown = originalPlan;
    plan.todos = originalTodos;
  }
});

test('native global skill configuration is available through the shared generic API tool', async () => {
  assert.deepEqual(await json('cockpit_call_intent', {
    name: 'skills/global-toggle', body: { name: 'review', enabled: false, cwd: '/backend/project' },
  }), { ok: true });
  assert.deepEqual(requests.map(({ path }) => path), [
    '/intent/skills/global-toggle',
  ]);
  assert.deepEqual(requests.at(-1)?.body, { name: 'review', enabled: false, cwd: '/backend/project' });
});

test('automatic naming uses the shared API without pretending a manual title was replaced', async () => {
  const result = await json('cockpit_call_intent', {
    name: 'session/auto-name', body: { sessionId: 'B' },
  });

  assert.deepEqual(result, { ok: true, applied: false, title: 'User title', reason: 'user-named' });
  assert.deepEqual(requests.map(({ path }) => path), [
    '/intent/session/auto-name',
  ]);
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B' });
});

for (const interrupted of [false, true]) {
  test(`generic native interrupt preserves interrupted:${interrupted} and makes exactly one mutation`, async () => {
    const sessionId = interrupted ? 'running' : 'idle';
    assert.deepEqual(await json('cockpit_call_intent', {
      name: 'session/interrupt', body: { sessionId },
    }), { ok: true, interrupted });
    assert.deepEqual(requests.map(({ path }) => path), [
      '/intent/session/interrupt',
    ]);
    assert.deepEqual(requests.at(-1)?.body, { sessionId });
  });
}

test('naming progress and errors remain distinct from ordinary execution errors', async () => {
  const previous = { autoNaming: meta.autoNaming, autoNameError: meta.autoNameError };
  try {
    meta.autoNaming = true;
    meta.autoNameError = null;
    assert.match((await call('cockpit_get_session', { session_id: 'B' })).text, /automatic naming: in progress \(not a chat turn\)/);
    meta.autoNaming = false;
    meta.autoNameError = 'Auxiliary query unavailable';
    assert.match((await call('cockpit_get_session', { session_id: 'B' })).text, /naming error: Auxiliary query unavailable/);
    assert.equal(meta.error, null);
  } finally {
    Object.assign(meta, previous);
    if (previous.autoNaming === undefined) delete meta.autoNaming;
    if (previous.autoNameError === undefined) delete meta.autoNameError;
  }
});

test('snapshot exposes required allow-all policy and complete canonical state through semantic and generic tools', async () => {
  assert.deepEqual(await json('cockpit_get_snapshot'), snapshot);
  assert.deepEqual(requests[0]?.body, {});
  assert.deepEqual(await json('cockpit_call_intent', { name: 'runtime/snapshot' }), snapshot);
  const { tools } = await client.listTools();
  for (const name of ['cockpit_get_snapshot', 'cockpit_set_mode', 'cockpit_respond_plan']) {
    assert.match(tools.find((tool) => tool.name === name)?.description ?? '', /allow-all/);
  }
  assert.equal(tools.some((tool) => /permission|approval/.test(tool.name)), false);
  for (const mode of ['interactive', 'plan', 'autopilot']) {
    const result = await call('cockpit_set_mode', { session_id: 'B', mode });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /interaction mode/);
    assert.match(result.text, /permissionPolicy remains allow-all/);
    assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', mode });
  }
  invalidPolicy = true;
  const missing = await call('cockpit_get_snapshot');
  assert.equal(missing.isError, true);
  assert.match(missing.text, /permissionPolicy/);
});

test('history returns synchronous canonical HistoryPage and supports before/after with no SSE wrapper', async () => {
  const generic = await json('cockpit_call_intent', {
    name: 'session/history', body: { sessionId: 'B', limit: 1 },
  });
  assert.deepEqual(generic, { sessionId: 'B', messages: [messages[1]], hasMore: true, latest: true });
  const recent = await json('cockpit_read_session', {
    session_id: 'B', operation: 'history', limit: 1, response_format: 'json',
  });
  assert.deepEqual(recent, {
    ...generic as object, source: 'api', returned: 1, nextBeforeMsgId: 'm2', nextAfterMsgId: 'm2',
  });
  const older = await json('cockpit_read_session', {
    session_id: 'B', operation: 'history', before_message_id: 'm2', limit: 1, response_format: 'json',
  });
  assert.deepEqual(older, {
    sessionId: 'B', messages: [messages[0]], hasMore: false, latest: false,
    source: 'api', returned: 1, nextBeforeMsgId: null, nextAfterMsgId: 'm1',
  });
  const tail = await json('cockpit_read_session', {
    session_id: 'B', operation: 'history', after_message_id: 'm1', response_format: 'json',
  });
  assert.deepEqual(tail, {
    sessionId: 'B', messages: [messages[1]], hasMore: false, latest: true, append: true,
    source: 'api', returned: 1, nextBeforeMsgId: null, nextAfterMsgId: 'm2',
  });
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', afterMsgId: 'm1', limit: 40 });
  const emptyTail = z.object({ messages: z.array(z.unknown()), nextAfterMsgId: z.string() })
    .parse(await json('cockpit_read_session', {
      session_id: 'B', operation: 'history', after_message_id: 'm2', response_format: 'json',
    }));
  assert.deepEqual(emptyTail.messages, []);
  assert.equal(emptyTail.nextAfterMsgId, 'm2', 'an empty tail must not discard the resume cursor');
  assert.ok(requests.every((request) => request.path.startsWith('/intent/') || request.path.startsWith('/capabilities')));
});

test('history cursors are mutually exclusive and limits are positive integers at most 200', async () => {
  for (const args of [
    { operation: 'history', before_message_id: 'm2', after_message_id: 'm1' },
    { after_message_id: 'm1' },
    ...[0, -1, 1.5, 201].map((limit) => ({ operation: 'history', limit })),
  ]) {
    const result = await call('cockpit_read_session', { session_id: 'B', ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(requests.length, 0, 'semantic validation must fail before dispatch');
  for (const body of [
    { beforeMsgId: 'm2', afterMsgId: 'm1' },
    ...[0, -1, 1.5, 201].map((limit) => ({ limit })),
  ]) assert.equal((await call('cockpit_call_intent', { name: 'session/history', body: { sessionId: 'B', ...body } })).isError, true);
  await json('cockpit_read_session', { session_id: 'B', operation: 'history', limit: 200, response_format: 'json' });
  malformedPreview = true;
  assert.equal((await call('cockpit_read_session', { session_id: 'B', operation: 'history' })).isError, true);
});

test('summary and subagent transcript reads use the same API without loading a session', async () => {
  await json('cockpit_read_session', { session_id: 'B', details: 'summary', response_format: 'json' });
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', details: 'summary', limit: 40 });
  const page = await json('cockpit_read_session', {
    session_id: 'B', operation: 'subagent', tool_call_id: 'native-child', limit: 10, response_format: 'json',
  });
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', toolCallId: 'native-child', limit: 10 });
  assert.equal(requests.at(-1)?.path, '/intent/session/subagent-history');
  assert.deepEqual(page, {
    sessionId: 'B', toolCallId: 'native-child', latest: true, hasMore: false,
    subagent: { name: 'task', displayName: 'Child', status: 'completed', prompt: 'Full child prompt' },
    messages: messages[1]!.subMessages, source: 'api', returned: 1,
    nextBeforeMsgId: null, nextAfterMsgId: 'child',
  });
  for (const args of [
    { operation: 'subagent' }, { tool_call_id: 'native-child' },
    { operation: 'subagent', tool_call_id: 'native-child', before_message_id: 'a', after_message_id: 'b' },
  ]) assert.equal((await call('cockpit_read_session', { session_id: 'B', ...args })).isError, true);
  assert.ok(requests.every(({ path }) => ['/intent/session/peek', '/intent/session/subagent-history'].includes(path)));
});
test('semantic and generic prompt deliver attachment JSON unchanged with no marker or local/backend path', async () => {
  for (const text of ['Review this image', '']) {
    const semantic = await call('cockpit_send_prompt', { session_id: 'B', text, attachment });
    assert.equal(semantic.isError, false, semantic.text);
    assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', text, attachment, mode: 'enqueue' });
    await json('cockpit_call_intent', { name: 'prompt', body: { sessionId: 'B', text, attachment } });
    assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', text, attachment });
  }
  const minimal: Attachment = { kind: 'file', name: 'Report', url: '/uploads/report.pdf' };
  assert.equal((await call('cockpit_send_prompt', { session_id: 'B', text: '', attachment: minimal })).isError, false);
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', text: '', mode: 'enqueue', attachment: minimal });
  assert.equal((await call('cockpit_send_prompt', {
    session_id: 'B', text: '', attachment: { ...attachment, path: '/server-only/image.png', storedName: 'safe-image.png' },
  })).isError, false);
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', text: '', mode: 'enqueue', attachment });
  assert.ok(requests.every((request) => !JSON.stringify(request.body ?? {}).includes('<cockpit-attachment')));
  requests.length = 0;
  for (const url of ['https://evil.invalid/file', '/uploads/../secret', '/uploads/a..png', '/uploads/a.png?x=1', '/uploads/%2e%2e', '/local/path']) {
    assert.equal((await call('cockpit_send_prompt', { session_id: 'B', text: 'Review', attachment: { ...attachment, url } })).isError, true);
  }
  assert.equal((await call('cockpit_send_prompt', { session_id: 'B', text: '' })).isError, true);
  assert.equal(requests.length, 0);
  assert.equal((await call('cockpit_call_intent', {
    name: 'prompt', body: { sessionId: 'B', text: 'Review', attachment: { ...attachment, url: 'https://evil.invalid/file' } },
  })).isError, true, 'generic body validation belongs to the backend');
});

test('global skills forwards optional backend cwd and omits it for server-home default', async () => {
  await json('cockpit_list_global_skills', { response_format: 'json' });
  assert.deepEqual(requests.at(-1)?.body, {});
  await json('cockpit_list_global_skills', { cwd: '/backend/project', response_format: 'json' });
  assert.deepEqual(requests.at(-1)?.body, { cwd: '/backend/project' });
  await json('cockpit_call_intent', { name: 'skills/global', body: { cwd: '/backend/other' } });
  assert.deepEqual(requests.at(-1)?.body, { cwd: '/backend/other' });
});

test('retained files are discoverable, selectable and explicitly retained through generic intents for attachment delivery', async () => {
  const catalog = z.object({ intents: z.array(z.object({ name: z.string() })) })
    .parse(await json('cockpit_capabilities', { prefix: 'files/' }));
  assert.deepEqual(catalog.intents.map(item => item.name), ['files/associate', 'files/from-tool-image', 'files/get', 'files/list']);
  const image = { eventId: 'event-1', toolCallId: 'tool-1', part: 0, cursor: 'native-cursor' };
  assert.deepEqual(await json('cockpit_call_intent', {
    name: 'files/from-tool-image', body: { sessionId: 'B', image, name: 'retained.png' },
  }), retainedFile);
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', image, name: 'retained.png' });
  const listing = await json('cockpit_call_intent', {
    name: 'files/list', body: { query: 'display', sessionId: 'B', limit: 10, offset: 0 },
  });
  assert.deepEqual(listing, {
    files: [retainedFile], hasMore: false,
    errors: [{ url: '/uploads/unreadable.bin', error: 'Missing metadata' }],
  });
  for (const [name, body] of [
    ['files/get', { url: attachment.url }],
    ['files/associate', { url: attachment.url, sessionId: 'B' }],
  ] as const) assert.deepEqual(await json('cockpit_call_intent', { name, body }), retainedFile);
  const result = await call('cockpit_send_prompt', { session_id: 'B', text: 'Retained native image', attachment });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', text: 'Retained native image', attachment, mode: 'enqueue' });
  assert.ok(requests.every(request => !JSON.stringify(request.body ?? {}).includes('/remote/')));
});

test('multiple attachments and ordered parts preserve input order in semantic and generic prompt tools', async () => {
  const video: Attachment = { kind: 'file', name: 'video.mp4', url: '/uploads/video.mp4', mime: 'video/mp4' };
  const parts = [{ type: 'text', text: 'Before' }, { type: 'file', attachment }, { type: 'text', text: 'Then' },
    { type: 'file', attachment: video }, { type: 'text', text: 'After' }];
  for (const form of [{ attachments: [attachment, video], text: 'Review both' }, { parts, text: '' }]) {
    const result = await call('cockpit_send_prompt', { session_id: 'B', ...form });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', mode: 'enqueue', ...form });
    await json('cockpit_call_intent', { name: 'prompt', body: { sessionId: 'B', ...form } });
    assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', ...form });
  }
});

test('prompt rejects conflicting, empty, excessive and unsafe attachment forms before network dispatch', async () => {
  for (const form of [
    { attachment, attachments: [attachment] }, { attachment, parts: [{ type: 'file', attachment }] },
    { attachments: [attachment], parts: [{ type: 'file', attachment }] },
    { parts: [{ type: 'text', text: 'hello' }], text: 'not empty' },
    { attachments: [] }, { attachments: Array(21).fill(attachment) },
    { parts: [] }, { parts: Array(101).fill({ type: 'text', text: 'x' }) },
    { parts: Array(21).fill({ type: 'file', attachment }) },
    { parts: [{ type: 'text', text: ' ' }] },
    { attachments: [{ ...attachment, url: '/uploads/../private' }] },
    { parts: [{ type: 'file', attachment: { ...attachment, url: 'https://example.invalid/image' } }] },
  ]) {
    const result = await call('cockpit_send_prompt', { session_id: 'B', text: '', ...form });
    assert.equal(result.isError, true, JSON.stringify(form));
  }
  assert.equal(requests.length, 0);
});

test('semantic and generic mutations surface HTTP-200 ok:false as genuine errors', async () => {
  for (const [name, tool, args] of [
    ['prompt', 'cockpit_send_prompt', { session_id: 'B', text: 'hello' }],
    ['setMode', 'cockpit_set_mode', { session_id: 'B', mode: 'plan' }],
    ['session/rewind', 'cockpit_rewind_session', { session_id: 'B', to_msg_id: 'm1', confirm: true }],
    ['session/purge', 'cockpit_purge_session', { session_id: 'B', confirm: true }],
    ['session/purge', 'cockpit_delete_session', { session_id: 'B', confirm: true }],
    ['respondAsk', 'cockpit_respond_ask', { session_id: 'B', request_id: 'q1', answer: 'yes' }],
    ['mcp/global-default', 'cockpit_set_global_mcp_default', { name: 'test-server', on: true }],
    ['skills/session-toggle', 'cockpit_set_session_skill', { session_id: 'B', name: 'review', enabled: true }],
  ] as const) {
    rejectedIntent = name;
    const semantic = await call(tool, args);
    assert.equal(semantic.isError, true, tool);
    assert.match(semantic.text, /genuine target failure/);
    assert.match(semantic.text, /failed-op/);
    const generic = await call('cockpit_call_intent', { name, body: requests.at(-1)?.body });
    assert.equal(generic.isError, true, name);
    assert.match(generic.text, /genuine target failure/);
  }
});

test('rewind delegates file rollback support to the backend and propagates rejection', async () => {
  const { tools } = await client.listTools();
  assert.match(tools.find((tool) => tool.name === 'cockpit_rewind_session')?.description ?? '', /backend owns support/);
  const args = { session_id: 'B', to_msg_id: 'm1', confirm: true };
  const rejected = await call('cockpit_rewind_session', { ...args, rollback_files: true });
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /File rollback is unsupported/);
  assert.deepEqual(requests[0]?.body, { sessionId: 'B', toMsgId: 'm1', rollbackFiles: true });
  const result = await call('cockpit_rewind_session', args);
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /Files were not rolled back/);
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', toMsgId: 'm1' });
  const generic = await call('cockpit_call_intent', {
    name: 'session/rewind', body: { sessionId: 'B', toMsgId: 'm1', rollbackFiles: true },
  });
  assert.equal(generic.isError, true);
  assert.match(generic.text, /rollback|false/i);
});

test('discovery and generic invocation cover the entire current canonical intent catalog', async () => {
  const listing = z.object({ intents: z.array(z.object({ name: z.string() })) })
    .parse(await json('cockpit_capabilities', { limit: 100 }));
  assert.deepEqual(listing.intents.map((item) => item.name), Object.keys(schemas).sort());
  assert.ok(Object.hasOwn(Intents, 'runtime/snapshot'));
  assert.equal(Object.hasOwn(Intents, 'session/history-page'), false);
  for (const name of Object.keys(Intents)) {
    requests.length = 0;
    const result = await call('cockpit_call_intent', { name, body: {} });
    assert.deepEqual(requests.map((request) => request.path), [
      `/intent/${name}`,
    ], name);
    assert.equal(result.isError, !schemas[name]!.safeParse({}).success, name);
  }
});

test('native usage discovery and generic read use the same typed backend without extra semantic tools', async () => {
  const detail = await json('cockpit_capabilities', { name: 'session/usage' });
  assert.ok(detail);
  const result = Intents['session/usage'].result.parse(await json('cockpit_call_intent', {
    name: 'session/usage', body: { sessionId: 'B' },
  }));
  assert.equal(result.context, null);
  assert.equal(result.usage.lastCallInputTokens, 321);
  assert.deepEqual(requests.map(r => r.path), [
    '/capabilities?name=session%2Fusage', '/intent/session/usage',
  ]);
});
