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
import { Intents, type Attachment, type NativeChatEvent, type ScheduleEntry, type SessionMeta, type SessionPanels, type SessionPlan, type Snapshot } from '../../../packages/protocol/src/index.ts';

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
const nativeEvents: NativeChatEvent[] = [
  { id: 'e1', type: 'user.message', data: { content: 'earlier question' } },
  {
    id: 'e2', type: 'assistant.message', data: { messageId: 'm2', content: 'native answer',
      toolRequests: [{ toolCallId: 'tool-1', name: 'read_file', arguments: {} }] },
  },
];
const nativeRead = { source: 'persisted', direction: 'backward', max: 64, includeEphemeral: false, waitMs: 0, bootstrap: false };
let unavailable = false;
let large = false;
const initialLargeContent = 'large "quoted" tool transcript\n'.repeat(4000);
let largeContent = initialLargeContent;
let malformedPreview = false;
let mismatchedCapability = false;
let rejectedIntent: string | undefined;
let intentFailure: number | 'invalid-json' | 'connection' | undefined;
let invalidPolicy = false;
let mcpSessionResult: unknown;
let mcpToggleResult: unknown;
let unconfirmedMcp = false;
let scheduleEntries: ScheduleEntry[] = [];
let scheduleStopped = true;
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
    if (unconfirmedMcp && ['mcp/session', 'mcp/session-toggle', 'session/panels'].includes(name)) {
      return send({ error: 'Native MCP state is unconfirmed for test-server: unknown status "future-status"' }, 409);
    }
    if (name === 'mcp/session') return send(mcpSessionResult);
    if (name === 'mcp/session-toggle') return send(mcpToggleResult);
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
    if (name === 'session/panel') {
      const { section } = Intents['session/panel'].body.parse(body);
      return send({ items: panels[section] });
    }
    if (name === 'schedule/list') return send({ entries: scheduleEntries });
    if (name === 'schedule/stop') return send({ ok: scheduleStopped });
    if (name === 'skills/global') return send({ skills: [{ name: 'review', description: 'Review changes', source: 'project' }] });
    if (name === 'session/chat') {
      const input = Intents['session/chat'].body.parse(body);
      const source = input.agentIds ? [{ id: 'child-event', type: 'assistant.message',
        agentId: input.agentIds[0], data: { messageId: 'child', content: 'subagent result' } }] : nativeEvents;
      const boundary = input.cursor ? Number(input.cursor.slice('native-'.length))
        : input.direction === 'backward' ? source.length : 0;
      const start = input.direction === 'backward' ? Math.max(0, boundary - input.max) : boundary;
      const end = input.direction === 'backward' ? boundary : Math.min(source.length, start + input.max);
      const events = large ? [{ ...nativeEvents[1], data: { ...nativeEvents[1]!.data, content: largeContent } }]
        : source.slice(start, end);
      return send(malformedPreview ? {} : {
        sessionId: input.sessionId, source: input.source, direction: input.direction,
        events, cursor: `native-${input.direction === 'backward' ? start : end}`, cursorStatus: 'ok',
        hasMore: input.direction === 'backward' ? start > 0 : end < source.length,
        ...(input.bootstrap ? { liveCursor: `native-${source.length}` } : {}),
        read: { rpc: input.bootstrap ? 2 : 1, events: events.length },
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
    if (['files/get', 'files/associate'].includes(name)) return send(retainedFile);
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
  mcpSessionResult = { loaded: true, servers: [] };
  mcpToggleResult = undefined;
  unconfirmedMcp = false;
  scheduleEntries = [];
  scheduleStopped = true;
  rejectedIntent = undefined;
  intentFailure = undefined;
  largeContent = initialLargeContent;
});

const ToolReply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});

test('schedule tools preserve self-paced metadata in full and compacted JSON with no extra requests', async () => {
  scheduleEntries = [
    { id: 1, prompt: 'Choose the next run', displayPrompt: '/review', recurring: true, selfPaced: true, nextRunAt: 123 },
    { id: 2, prompt: 'Fixed cadence', recurring: true, selfPaced: false, intervalMs: 60000, nextRunAt: 123 },
    { id: 3, prompt: 'Once', recurring: false, at: 123, nextRunAt: 123 },
  ];
  assert.deepEqual(await json('cockpit_list_schedules', { session_id: 'B', response_format: 'json' }), {
    entries: scheduleEntries, count: 3,
  });
  assert.deepEqual(requests.map(({ path }) => path), ['/intent/schedule/list']);

  scheduleEntries = scheduleEntries.map(entry => ({ ...entry, prompt: 'long prompt '.repeat(CHARACTER_LIMIT) }));
  requests.length = 0;
  const compacted = z.object({
    entries: z.array(Intents['schedule/list'].result.shape.entries.element),
    _compacted: z.literal('field-previews'), count: z.number(),
  }).parse(await json('cockpit_list_schedules', { session_id: 'B', response_format: 'json' }));
  assert.equal(compacted.entries[0]!.selfPaced, true);
  assert.equal(compacted.entries[0]!.intervalMs, undefined);
  assert.equal(compacted.entries[1]!.selfPaced, false);
  assert.equal(compacted.entries[1]!.intervalMs, 60000);
  assert.equal(compacted.entries[2]!.at, 123);
  assert.deepEqual(requests.map(({ path }) => path), ['/intent/schedule/list']);
});

test('schedule markdown distinguishes model-controlled timing from ordinary schedules', async () => {
  scheduleEntries = [
    { id: 1, prompt: 'Choose the next run', displayPrompt: '/review', recurring: true, selfPaced: true, nextRunAt: 123 },
    { id: 2, prompt: 'Fixed cadence', recurring: true, selfPaced: false, intervalMs: 60000, nextRunAt: 123 },
    { id: 3, prompt: 'Calendar', recurring: true, cron: '0 9 * * *', tz: 'Asia/Shanghai', nextRunAt: 123 },
    { id: 4, prompt: 'Once', recurring: false, at: 123, nextRunAt: 123 },
  ];
  const result = await call('cockpit_list_schedules', { session_id: 'B', response_format: 'markdown' });
  assert.equal(result.isError, false);
  assert.match(result.text, /#1 · self-paced \(model-controlled; no fixed cadence\) · next/);
  assert.match(result.text, /\/review/);
  assert.match(result.text, /#2 · every 60s · next/);
  assert.match(result.text, /#3 · cron "0 9 \* \* \*" \(Asia\/Shanghai\) · next/);
  assert.match(result.text, /#4 · once at .* \(one-shot\) · next/);
  assert.doesNotMatch(result.text, /#1[^\n]*(?:one-shot|\?)/);
});

test('schedule panels retain the model-controlled label and next-run time in both tool formats', async t => {
  const previous = panels.schedules;
  t.after(() => { panels.schedules = previous; });
  panels.schedules = [{
    label: '/review', sublabel: 'Self-paced (model-controlled) · next 2026-09-07T12:01:00.000Z',
  }];
  const structured = await json('cockpit_get_panels', { session_id: 'B', response_format: 'json' });
  assert.deepEqual(structured, panels);
  const markdown = await call('cockpit_get_panels', { session_id: 'B', response_format: 'markdown' });
  assert.equal(markdown.isError, false);
  assert.match(markdown.text, /Self-paced \(model-controlled\) · next 2026-09-07T12:01:00.000Z/);
  assert.deepEqual(requests.map(({ path }) => path), ['/intent/session/panels', '/intent/session/panels']);
});

test('MCP single-section panel reads make exactly one narrow HTTP request in either format', async () => {
  assert.deepEqual(await json('cockpit_get_panels', { session_id: 'B', section: 'tasks', response_format: 'json' }),
    { section: 'tasks', items: panels.tasks });
  const markdown = await call('cockpit_get_panels', { session_id: 'B', section: 'instructionSources' });
  assert.equal(markdown.isError, false);
  assert.match(markdown.text, /instructionSources/);
  assert.deepEqual(requests.map(({ path }) => path), ['/intent/session/panel', '/intent/session/panel']);
  assert.deepEqual(requests.map(({ body }) => body), [
    { sessionId: 'B', section: 'tasks' }, { sessionId: 'B', section: 'instructionSources' },
  ]);
});
for (const outcome of ['success', 'not-found', 'failure'] as const) {
  test(`schedule stop tool faithfully reports ${outcome} with one stop request and no list`, async () => {
    scheduleStopped = outcome === 'success';
    if (outcome === 'failure') intentFailure = 503;
    const result = await call('cockpit_stop_schedule', { session_id: 'B', id: 7 });
    assert.equal(result.isError, outcome !== 'success');
    assert.match(result.text, outcome === 'success' ? /Stopped schedule #7/
      : outcome === 'not-found' ? /No schedule #7/ : /authoritative service failure/);
    assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [
      { path: '/intent/schedule/stop', body: { sessionId: 'B', id: 7 } },
    ]);
  });
}

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

for (const status of ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'stopped', 'not_configured']) {
  test(`MCP tools preserve ${status} independently of enablement in list, panels and toggle output`, async t => {
    const previous = panels.mcpServers;
    t.after(() => { panels.mcpServers = previous; });
    for (const enabled of [false, true]) {
      const entry = { name: 'test-server', detail: 'native', enabled, status };
      mcpSessionResult = { loaded: true, servers: [entry] };
      panels.mcpServers = [{ label: entry.name, sublabel: status, enabled }];
      const list = await call('cockpit_list_session_mcp', { session_id: 'B' });
      assert.equal(list.isError, false, list.text);
      assert.ok(list.text.includes(`enabled=${enabled} (${status})`));
      assert.deepEqual(await json('cockpit_list_session_mcp', { session_id: 'B', response_format: 'json' }), {
        loaded: true, servers: [entry], count: 1,
      });
      const info = await call('cockpit_get_panels', { session_id: 'B' });
      assert.equal(info.isError, false, info.text);
      assert.ok(info.text.includes(`test-server · enabled=${enabled}\n    ${status}`));
      assert.deepEqual(await json('cockpit_get_panels', { session_id: 'B', response_format: 'json' }), panels);
      mcpToggleResult = {
        ok: false, applied: false, sessionId: 'B', name: entry.name, enabled, status,
        error: 'native target did not confirm the requested change',
        operation: { id: 'operation', desiredEnabled: true, state: 'failed', startedAt: 1, status },
      };
      const toggle = await call('cockpit_set_session_mcp', { session_id: 'B', name: entry.name, enabled: true });
      assert.equal(toggle.isError, true);
      assert.ok(toggle.text.includes(`target=${status}, native enabled=${enabled}`));
    }
    assert.ok(requests.every(({ path }) => /^\/intent\/(mcp\/session|mcp\/session-toggle|session\/panels)$/.test(path)));
  });
}

test('MCP unknown states fail explicitly across read, panel and setting tools without retries', async () => {
  unconfirmedMcp = true;
  for (const [name, args] of [
    ['cockpit_list_session_mcp', { session_id: 'B' }],
    ['cockpit_get_panels', { session_id: 'B' }],
    ['cockpit_set_session_mcp', { session_id: 'B', name: 'test-server', enabled: true }],
  ] as const) {
    const reply = await call(name, args);
    assert.equal(reply.isError, true);
    assert.match(reply.text, /unconfirmed.*future-status/);
    assert.doesNotMatch(reply.text, /not_configured/);
  }
  assert.equal(requests.length, 3);
});

for (const status of ['needs_auth', 'future-status']) {
  test(`MCP tools reject non-protocol status ${status} rather than synthesizing unconfigured`, async () => {
    mcpSessionResult = { loaded: true, servers: [{ name: 'test-server', detail: 'native', enabled: true, status }] };
    const reply = await call('cockpit_list_session_mcp', { session_id: 'B' });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /invalid result/);
    assert.equal(requests.length, 1);
  });
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
    const page = z.object({ sessionId: z.string(), events: z.array(z.unknown()), source: z.string() })
      .parse(await json('cockpit_read_session', { session_id: sessionId, response_format: 'json' }));
    assert.deepEqual(page.events, nativeEvents, 'the native envelope and payload survive without a server message fold');
    assert.equal(page.sessionId, sessionId);
    assert.equal(page.source, 'persisted');
  }
  assert.deepEqual(requests.map(({ path }) => path), [
    '/intent/session/list', '/intent/session/get',
    '/intent/session/chat', '/intent/session/chat',
  ]);
  assert.ok(requests.every((request) => request.authorization === 'Bearer session-test-token'));
});

test('transcript cursor requests older native events without message or turn offsets', async () => {
  const Page = z.object({ events: z.array(z.unknown()), hasMore: z.boolean(), cursor: z.string() });
  const newest = Page.parse(await json('cockpit_read_session', { session_id: 'B', limit: 1, response_format: 'json' }));
  assert.deepEqual(newest.events, [nativeEvents[1]]);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.cursor, 'native-1');
  const older = Page.parse(await json('cockpit_read_session', {
    session_id: 'B', limit: 1, cursor: newest.cursor, response_format: 'json',
  }));
  assert.deepEqual(older.events, [nativeEvents[0]]);
  assert.equal(older.hasMore, false);
  assert.equal(older.cursor, 'native-0');
  assert.deepEqual(requests[1]?.body, { sessionId: 'B', ...nativeRead, cursor: 'native-1', max: 1 });
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
  const page = Intents['session/chat'].result.parse(JSON.parse(serialized));
  assert.equal(page.events[0]?.data.content, initialLargeContent);
  assert.deepEqual(page.events[0]?.data.toolRequests, nativeEvents[1]?.data.toolRequests);
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
  assert.match(next.text, /native page changed/);
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
  assert.deepEqual(requests.map(({ path }) => path), ['/intent/prompt', '/intent/session/chat']);
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

test('native plan narrative, todos and panel sublabels/enabled flags render nonempty', async () => {
  const renderedPlan = await call('cockpit_get_plan', { session_id: 'B' });
  assert.equal(renderedPlan.isError, false, renderedPlan.text);
  for (const text of ['Canonical narrative', '[done] Implement contract', '[in_progress] Verify MCP', 'Use mocked transports', '[blocked] Wait for parent']) {
    assert.ok(renderedPlan.text.includes(text), text);
  }
  assert.deepEqual(await json('cockpit_get_plan', { session_id: 'B', response_format: 'json' }), plan);
  const renderedPanels = await call('cockpit_get_panels', { session_id: 'B' });
  assert.equal(renderedPanels.isError, false, renderedPanels.text);
  for (const text of ['review · enabled', 'Project review skill', 'test-server · enabled=false', 'unloaded', 'Finding canonical types', '/remote/project/AGENTS.md', 'Tomorrow']) {
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
    for (const text of ['No description', 'Normalized null', 'Empty description', 'Actual description', 'Preserve description', 'Canonical narrative']) {
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

test('native chat generic and semantic tools return the same bounded event page', async () => {
  const generic = await json('cockpit_call_intent', {
    name: 'session/chat', body: { sessionId: 'B', max: 1 },
  });
  const recent = await json('cockpit_read_session', {
    session_id: 'B', limit: 1, response_format: 'json',
  });
  assert.deepEqual(recent, generic);
  const tail = Intents['session/chat'].result.parse(await json('cockpit_read_session', {
    session_id: 'B', direction: 'forward', cursor: 'native-1', response_format: 'json',
  }));
  assert.deepEqual(tail.events, [nativeEvents[1]]);
  assert.equal(tail.cursor, 'native-2');
  assert.deepEqual(requests.at(-1)?.body, { sessionId: 'B', ...nativeRead, direction: 'forward', cursor: 'native-1' });
  const emptyTail = Intents['session/chat'].result.parse(await json('cockpit_read_session', {
    session_id: 'B', direction: 'forward', cursor: tail.cursor, response_format: 'json',
  }));
  assert.deepEqual(emptyTail.events, []);
  assert.equal(emptyTail.cursor, 'native-2');
  assert.ok(requests.every((request) => request.path.startsWith('/intent/') || request.path.startsWith('/capabilities')));
});

test('retired selectors and invalid native page bounds fail before dispatch', async () => {
  for (const args of [
    { operation: 'history', before_message_id: 'm2', after_message_id: 'm1' },
    { after_message_id: 'm1' }, { details: 'summary' }, { tool_call_id: 'old-child' },
    ...[0, -1, 1.5, 257].map((limit) => ({ limit })),
  ]) {
    const result = await call('cockpit_read_session', { session_id: 'B', ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(requests.length, 0, 'semantic validation must fail before dispatch');
  for (const body of [
    { beforeMsgId: 'm2', afterMsgId: 'm1' },
    ...[0, -1, 1.5, 257].map((max) => ({ max })),
  ]) assert.equal((await call('cockpit_call_intent', { name: 'session/chat', body: { sessionId: 'B', ...body } })).isError, true);
  await json('cockpit_read_session', { session_id: 'B', limit: 256, response_format: 'json' });
  malformedPreview = true;
  assert.equal((await call('cockpit_read_session', { session_id: 'B' })).isError, true);
});

test('child native filtering requires live reads and never resumes a session', async () => {
  const invalid = await call('cockpit_read_session', {
    session_id: 'B', agent_ids: ['native-child'], response_format: 'json',
  });
  assert.equal(invalid.isError, true);
  assert.equal(requests.length, 1, 'the authoritative HTTP schema rejects unsupported passive filters');
  const page = Intents['session/chat'].result.parse(await json('cockpit_read_session', {
    session_id: 'B', source: 'live', agent_ids: ['native-child'], limit: 10, response_format: 'json',
  }));
  assert.equal(page.events[0]?.agentId, 'native-child');
  assert.equal(page.events[0]?.data.content, 'subagent result');
  assert.deepEqual(requests.at(-1)?.body, {
    sessionId: 'B', ...nativeRead, source: 'live', agentIds: ['native-child'], max: 10,
  });
  assert.ok(requests.every(({ path }) => path === '/intent/session/chat'));
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

test('retained files remain discoverable and selectable for attachment delivery without native image lookup', async () => {
  const catalog = z.object({ intents: z.array(z.object({ name: z.string() })) })
    .parse(await json('cockpit_capabilities', { prefix: 'files/' }));
  assert.deepEqual(catalog.intents.map(item => item.name), ['files/associate', 'files/get', 'files/list']);
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
