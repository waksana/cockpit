// Regression fixtures for the slim wire contract and retained SDK capabilities.
// Run: pnpm --filter @cockpit/protocol test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as Protocol from './index.ts';
import { ChatMessage } from './validation.ts';
import {
  SessionMeta,
  SessionBrief,
  SessionPanels,
  ScheduleEntry,
  ServerEvent,
  Intents,
  McpToggleResult,
  type IntentName,
  type IntentBody,
  type IntentResult,
} from './index.ts';

test('global MCP connection metadata is typed and not a speculative session field', () => {
  const global = { name: 'fixture', detail: 'legacy full detail', defaultOn: false, config: { command: 'node' } };
  const session = { name: 'fixture', detail: 'native-plugin', status: 'connected', enabled: true };
  for (const method of ['http', 'sse', 'stdio', 'unknown'] as const) {
    const connection = { method, ...(method === 'unknown' ? {} : { target: 'fixture' }) };
    assert.deepEqual(Intents['mcp/global'].result.parse({ servers: [{ ...global, connection }] }).servers[0],
      { ...global, connection });
  }
  assert.deepEqual(Protocol.McpServerGlobal.parse(global), global);
  assert.deepEqual(Protocol.McpServerSession.parse(session), session);
  assert.equal('connection' in Protocol.McpServerSession.shape, false);
  for (const method of ['user', 'workspace', 'plugin', 'builtin', 'custom', 'future']) {
    assert.equal(Protocol.McpConnection.safeParse({ method }).success, false);
  }
});

test('resource module provenance is explicit optional metadata independent of literal names and native source', () => {
  const module = { id: 'fixture', name: 'Fixture module' };
  const mcp = { name: 'fixture-tools', detail: 'user', enabled: true, status: 'failed', error: 'Native error', module };
  const skill = { name: 'fixture-skill', source: 'custom', enabled: false, module };
  assert.deepEqual(Intents['mcp/session'].result.parse({ loaded: true, servers: [mcp] }).servers[0], mcp);
  assert.deepEqual(Intents['skills/session'].result.parse({ skills: [skill] }).skills[0], skill);
  for (const roles of [[], [{ id: 'owner', name: 'Owner' }],
    [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Owner' }]]) {
    const source = { ...module, roles };
    assert.deepEqual(Intents['mcp/session'].result.parse({ loaded: true, servers: [{ ...mcp, module: source }] }).servers[0]?.module, source);
    assert.deepEqual(Intents['skills/session'].result.parse({ skills: [{ ...skill, module: source }] }).skills[0]?.module, source);
  }
  assert.equal(Object.hasOwn(Protocol.ModuleSource.parse(module), 'roles'), false);
  assert.equal(Protocol.ModuleSource.safeParse({ ...module, roles: [{ name: 'Missing identity' }] }).success, false);
  assert.equal(Object.hasOwn(Protocol.McpServerSession.parse({
    name: 'module_fixture__native', detail: 'native', enabled: true, status: 'connected',
  }), 'module'), false);
  assert.equal(Object.hasOwn(Protocol.SkillSession.parse({ name: 'fixture-skill', source: 'custom', enabled: true }), 'module'), false);
  assert.equal(Intents['session/resources'].body.safeParse({ sessionId: 's', resources: ['skills', 'mcp'] }).success, false,
    'session/resources is a metadata-only projection; resource lists have dedicated intents');
});

test('folded-message validators are absent from the production wire entry point', () => {
  for (const name of ['ToolCall', 'ChatRole', 'SubagentInfo', 'ChatMessage']) {
    assert.equal(Object.hasOwn(Protocol, name), false);
  }
});

test('global catalog and skill detail preserve optional provenance without inventing roles or defaults', () => {
  for (const modules of [
    undefined, [{ id: 'fixture', name: 'Fixture' }],
    [{ id: 'fixture', name: 'Fixture', roles: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
      { id: 'another', name: 'Another' }],
  ]) {
    const metadata = modules ? { modules } : {};
    const mcp = { name: 'native-literal', detail: 'native', defaultOn: false, ...metadata };
    const skill = { name: 'native-literal', source: 'custom', ...metadata };
    assert.deepEqual(Intents['mcp/global'].result.parse({ servers: [mcp] }).servers, [mcp]);
    assert.deepEqual(Intents['skills/global'].result.parse({ skills: [skill] }).skills, [skill]);
    assert.deepEqual(Intents['skills/read'].result.parse({ ...skill, body: '# Native' }), { ...skill, body: '# Native' });
  }
});

test('resource preparation has bounded exact identities, strict bodies and honest partial receipts', () => {
  const { body, result } = Intents['session/resources-prepare'];
  const selection = { sessionId: 's', skills: ['optional'], mcpServers: [{ name: 'tools', tools: ['raw_name'] }] };
  assert.deepEqual(body.parse(selection), selection);
  assert.deepEqual(body.parse({ sessionId: 's' }), { sessionId: 's' });
  for (const invalid of [
    { ...selection, roles: [] }, { ...selection, sessionId: ' ' },
    { ...selection, skills: ['a', 'a'] }, { ...selection, skills: [' '] },
    { ...selection, skills: ['a'.repeat(201)] },
    { ...selection, skills: Array.from({ length: 65 }, (_, i) => `s${i}`) },
    { ...selection, mcpServers: [{ name: 'a' }, { name: 'a' }] },
    { ...selection, mcpServers: Array.from({ length: 65 }, (_, i) => ({ name: `s${i}` })) },
    ...[['*'], ['a', 'a'], [''], [' '], ['a'.repeat(201)],
      Array.from({ length: 257 }, (_, i) => `t${i}`)].map(tools => ({ ...selection, mcpServers: [{ name: 'a', tools }] })),
    { ...selection, mcpServers: [{ name: 'a', enabled: true }] },
  ]) assert.equal(body.safeParse(invalid).success, false, JSON.stringify(invalid));
  const receipt = {
    sessionId: 's', ok: false, skills: [{ name: 'optional', effect: 'enabled', enabled: true }],
    mcpServers: [{ name: 'tools', effect: 'unconfirmed', enabled: null, status: null, tools: null }],
    tools: 'not_attempted', error: 'Native readback failed',
  };
  assert.deepEqual(result.parse(receipt), receipt);
  assert.equal(result.safeParse({ ...receipt, error: 'x'.repeat(2000) }).success, true);
  assert.equal(result.safeParse({ ...receipt, error: 'x'.repeat(2001) }).success, false);
  assert.equal(result.safeParse({ ...receipt, readiness: true }).success, false);
  assert.equal(result.safeParse({ ...receipt, tools: 'ready' }).success, false);
  assert.equal(result.safeParse({ ...receipt, mcpServers: [{ ...receipt.mcpServers[0], status: 'unknown' }] }).success, false);
});

test('response messages retain thought, body and explicit incompleteness without provisional state', () => {
  const response = { id: 'native-message', role: 'assistant', content: ' \nBody', thought: 'Thought\n ',
    thoughtKey: 'native-response-parent', timestamp: 1, incomplete: 'Missing native response reference' };
  assert.deepEqual(ChatMessage.parse(response), response);
  assert.equal('provisional' in ChatMessage.parse({ ...response, provisional: true }), false);
});

test('session/load accepts only an existing target selector and a positive identity receipt', () => {
  const schema = Intents['session/load'];
  assert.deepEqual(schema.body.parse({ sessionId: 'original' }), { sessionId: 'original' });
  for (const body of [{ sessionId: '' }, { sessionId: 'original', cwd: '/replacement' },
    { sessionId: 'original', text: 'Do not send' }, { sessionId: 'original', create: true }]) {
    assert.equal(schema.body.safeParse(body).success, false);
  }
  assert.equal(schema.result.safeParse({ ok: true, sessionId: 'original' }).success, true);
  assert.equal(schema.result.safeParse({ ok: true }).success, false);
  assert.equal(schema.result.safeParse({ ok: false, sessionId: 'original' }).success, false);
});

test('native chat rejects retired message-ID and resume-token selectors instead of simulating a seek', () => {
  const schema = Intents['session/chat'].body;
  for (const selector of [{ resume: {} }, { beforeMsgId: 'a' }, { afterMsgId: 'b' }, { details: 'full' }]) {
    assert.equal(schema.safeParse({ sessionId: 's', ...selector }).success, false);
  }
  for (const retired of ['session/history', 'session/peek', 'session/subagent-history']) {
    assert.equal(retired in Intents, false);
  }
});

test('native runtime busy state survives the shared wire projection', () => {
  const patch = ServerEvent.parse({
    type: 'session/patch', sessionId: 'runtime-session', activeOperations: 2, nativeProcessing: true,
  });
  assert.deepEqual(patch, {
    type: 'session/patch', sessionId: 'runtime-session', activeOperations: 2, nativeProcessing: true,
  });
  assert.equal(ServerEvent.safeParse({
    type: 'session/patch', sessionId: 'runtime-session', activeOperations: -1,
  }).success, false);
});

test('control activity requires real flags and counts without idle defaults', () => {
  const schema = Protocol.SessionActivity;
  const result = {
    sampledAt: 1, processing: false, hasActiveWork: true, abortable: false,
    tasks: { activeAgents: 0, activeShells: 1, unknown: 1 },
    queue: { pendingCount: 0, steeringCount: 2, inFlightSteeringCount: 1 },
    mcp: { pendingConnectionCount: 1 },
  };
  roundTrip(schema, result);
  for (const key of ['processing', 'hasActiveWork', 'abortable', 'tasks', 'queue', 'mcp'] as const) {
    const incomplete = { ...result };
    Reflect.deleteProperty(incomplete, key);
    assert.equal(schema.safeParse(incomplete).success, false, key);
  }
  for (const count of [-1, 0.5, undefined]) {
    assert.equal(schema.safeParse({ ...result, queue: { ...result.queue, pendingCount: count } }).success, false);
    assert.equal(schema.safeParse({ ...result, tasks: { ...result.tasks, unknown: count } }).success, false);
  }
  assert.equal('session/activity' in Intents, false);
  for (const projection of [SessionMeta, SessionBrief, Protocol.SessionProjection]) {
    assert.equal('activity' in projection.parse(minimalMeta), false);
    for (const activity of [null, result]) {
      assert.deepEqual(projection.parse({ ...minimalMeta, activity }).activity, activity);
      roundTrip(ServerEvent, { type: 'session/patch', sessionId: 's', activity });
    }
  }
});

function roundTrip(schema: z.ZodTypeAny, value: unknown, label?: string) {
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(value))), value, label);
}

// A minimal, valid SessionMeta: only the keys with no default and no optional.
// `error` and `ask` are nullable-but-required, so they must be present as null.
const minimalMeta = {
  sessionId: 's1',
  title: 'T',
  cwd: '/workspace/project',
  lastActivity: 1,
  status: 'idle',
  error: null,
  loaded: true,
  queue: [],
  ask: null,
} satisfies SessionMeta;

test('role readiness is an explicit result, never a session identity projection', () => {
  const roles = [{ moduleId: 'fixture', roleId: 'owner', moduleName: 'Fixture', name: 'Owner' }];
  const roleReadiness = { sessionId: 's1', roles, loaded: true, ready: true, reasons: [] };
  roundTrip(Intents['roles/readiness'].result, roleReadiness);
  for (const schema of [SessionMeta, SessionBrief, Protocol.SessionProjection]) {
    const value = schema.parse({ ...minimalMeta, roles, roleReadiness });
    assert.deepEqual(value.roles, roles);
    assert.equal('roleReadiness' in value, false);
  }
  assert.deepEqual(ServerEvent.parse({ type: 'session/patch', sessionId: 's1', roles, roleReadiness }), {
    type: 'session/patch', sessionId: 's1', roles,
  });

  test('tool initialization accepts only an explicit session identity and does not claim readiness', () => {
    const intent = Intents['session/tools-initialize'];
    roundTrip(intent.body, { sessionId: 's' });
    for (const body of [{}, { sessionId: '' }, { sessionId: 's', reload: true }, { sessionId: 's', prompt: 'bootstrap' }]) {
      assert.equal(intent.body.safeParse(body).success, false);
    }
    assert.equal(intent.result.safeParse({ ok: false }).success, false);
    assert.match(intent.description, /not role readiness/);
  });
  assert.equal('session/advance-queue' in Intents, false);
  assert.equal('QueueAdvanceOperation' in Protocol, false);
});

test('retired project identity is stripped from session metadata and SSE patches', () => {
  for (const project of [
    { kind: 'unknown' },
    { kind: 'directory', path: '/', error: 'unavailable' },
    { kind: 'git', commonDir: '/repo/.git', path: '/repo', worktreePath: '/task', main: false },
  ]) {
    assert.equal('project' in SessionMeta.parse({ ...minimalMeta, project }), false);
    assert.equal('project' in SessionBrief.parse({ ...minimalMeta, project }), false);
    assert.deepEqual(ServerEvent.parse({ type: 'session/patch', sessionId: 's1', project }), {
      type: 'session/patch', sessionId: 's1',
    });
  }
});

// A fully-populated SessionMeta (snapshot shape): every optional field set to a
// real value, exercising the whole object.
const fullMeta = {
  ...minimalMeta,
  createdAt: 0,
  currentModelId: 'gpt-x',
  currentReasoningEffort: 'high',
  currentContextTier: 'long_context',
  currentMode: 'interactive',
  availableModels: [{
    modelId: 'gpt-x', name: 'GPT-X', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', supportsLongContext: true,
  }],
  loading: false,
  closing: false,
  cancelling: true,
  queue: [{ id: 'q1', text: 'queued' }],
  ask: { requestId: 'r1', question: 'q?', choices: ['A', 'B'], allowFreeform: true },
  planRequest: {
    requestId: 'p1', summary: 's', planContent: '# Plan\nImplement the change.',
    actions: ['exit_only', 'interactive', 'autopilot', 'autopilot_fleet'],
    recommendedAction: 'interactive',
  },
  elicitation: { requestId: 'e1', message: 'm' },
  todo: { done: 1, total: 2, intent: 'doing' },
  intent: 'Investigating',
  scheduleCount: 1,
  activeSubagents: 0,
  compacting: false,
  activeMcpOperations: 1,
} satisfies SessionMeta;

const snapshot = {
  type: 'snapshot',
  agentStatus: 'up',
  models: fullMeta.availableModels,
  sessions: [fullMeta],
  permissionPolicy: 'allow-all',
} satisfies Protocol.Snapshot;

// session/patch is derived exactly as the ServerEvent member is.
const SessionPatch = SessionMeta.partial().required({ sessionId: true });

// ───────────────────────────────────────────────────────────────────────────
// A. SessionMeta round-trip & null discipline
// ───────────────────────────────────────────────────────────────────────────

test('A1: a fully-populated SessionMeta parses', () => {
  roundTrip(SessionMeta, fullMeta);
});

test('A2: a minimal SessionMeta (only required keys) parses', () => {
  assert.ok(SessionMeta.safeParse(minimalMeta).success);
});

test('A3: null for every already-nullable field parses', () => {
  const cleared = {
    ...minimalMeta,
    error: null,
    ask: null,
    planRequest: null,
    elicitation: null,
    todo: null,
    intent: null,
  };
  assert.ok(SessionMeta.safeParse(cleared).success);
});

test('A4: null for a non-nullable key (title) is rejected', () => {
  assert.equal(SessionMeta.safeParse({ ...minimalMeta, title: null }).success, false);
});

test('A5: snapshot gotcha — null for a non-nullable optional (currentModelId) is rejected', () => {
  // Encodes "omit absent optionals, never send null" for the snapshot shape.
  assert.equal(SessionMeta.safeParse({ ...minimalMeta, currentModelId: null }).success, false);
});

// ───────────────────────────────────────────────────────────────────────────
// B. session/patch — the M1/T5 clearable-null contract
// ───────────────────────────────────────────────────────────────────────────

test('B6: patch {sessionId, error:null} parses (baseline clearable)', () => {
  assert.ok(SessionPatch.safeParse({ sessionId: 's1', error: null }).success);
});

test('B7: patch clearing each new nullable field to null parses', () => {
  for (const field of ['currentReasoningEffort', 'currentContextTier', 'currentMode'] as const) {
    const res = SessionPatch.safeParse({ sessionId: 's1', [field]: null });
    assert.ok(res.success, `${field}:null should be a valid patch`);
  }
});

test('B8: over-nullable guard — patch {sessionId, currentModelId:null} is rejected', () => {
  // Proves we did NOT nullable a never-cleared field.
  assert.equal(SessionPatch.safeParse({ sessionId: 's1', currentModelId: null }).success, false);
  assert.equal(SessionPatch.safeParse({ sessionId: 's1', availableModels: null }).success, false);
});

test('B9: a patch without sessionId is rejected (required key preserved)', () => {
  assert.equal(SessionPatch.safeParse({ error: null }).success, false);
});

test('B10: wire fidelity — null survives JSON round-trip, undefined is dropped', () => {
  const withNull = { sessionId: 's1', currentReasoningEffort: null };
  const roundNull = JSON.parse(JSON.stringify(withNull));
  assert.ok('currentReasoningEffort' in roundNull, 'null key must survive JSON');
  assert.ok(SessionPatch.safeParse(roundNull).success);

  const withUndef = { sessionId: 's1', currentReasoningEffort: undefined };
  const roundUndef = JSON.parse(JSON.stringify(withUndef));
  assert.equal('currentReasoningEffort' in roundUndef, false, 'undefined key is dropped by JSON');
  // The dropped key means the client never clears — exactly the bug emit-null fixes.
  assert.ok(SessionPatch.safeParse(roundUndef).success);
});

// ───────────────────────────────────────────────────────────────────────────
// C. Exactly-one-of intent bodies
// ───────────────────────────────────────────────────────────────────────────

test('C11–C13: schedule/add enforces exactly one of interval/at', () => {
  const base = { sessionId: 's1', prompt: 'p' };
  const body = Intents['schedule/add'].body;
  // none
  assert.equal(body.safeParse(base).success, false);
  // two
  assert.equal(body.safeParse({ ...base, interval: '5m', at: 123 }).success, false);
  // exactly one (each kind)
  assert.ok(body.safeParse({ ...base, interval: '5m' }).success);
  assert.equal(body.safeParse({ ...base, cron: '0 * * * *' }).success, false);
  assert.ok(body.safeParse({ ...base, at: 123 }).success);
});

// ───────────────────────────────────────────────────────────────────────────
// E. Union & parity (cheap regression guards)
// ───────────────────────────────────────────────────────────────────────────

test('E19: every ServerEvent variant parses a representative sample', () => {
  const samples = {
    snapshot,
    'module/invalidated': { type: 'module/invalidated', moduleId: 'synthetic-module' },
    'module/event': { type: 'module/event', moduleId: 'synthetic-module', payload: { kind: 'delta', items: [1, null, true] } },
    'agent/status': { type: 'agent/status', status: 'up' },
    'session/added': { type: 'session/added', session: fullMeta },
    'session/invalidated': { type: 'session/invalidated', sessionId: 's1' },
    'session/patch': { type: 'session/patch', ...fullMeta, currentReasoningEffort: null },
    'session/removed': { type: 'session/removed', sessionId: 's1' },
    'chat/invalidated': { type: 'chat/invalidated', sessionId: 's1', reason: 'rewind' },
  } satisfies { [K in Protocol.ServerEventType]: Extract<Protocol.ServerEvent, { type: K }> };
  assert.deepEqual(
    ServerEvent.options.map((schema) => schema.shape.type.value).sort(),
    Object.keys(samples).sort(),
  );
  for (const [type, sample] of Object.entries(samples)) {
    roundTrip(ServerEvent, sample, `ServerEvent ${type}`);
  }
});

test('F20: mcp/session-toggle requires an authoritative target-level result', () => {
  const result = {
    ok: false,
    applied: false,
    sessionId: 's1',
    name: 'agency-icm',
    enabled: false,
    status: 'needs-auth',
    error: 'Sign in to continue',
    operation: {
      id: 'mcp-toggle-1',
      desiredEnabled: true,
      state: 'failed',
      startedAt: 1,
      completedAt: 2,
      status: 'needs-auth',
      error: 'Sign in to continue',
    },
  };
  assert.ok(McpToggleResult.safeParse(result).success);
  assert.ok(Intents['mcp/session-toggle'].result.safeParse(result).success);
  assert.equal(Intents['mcp/session-toggle'].result.safeParse({ ok: true }).success, false);
});

test('E21: ChatMessage schema parses a deeply-nested (sub-agent) sample', () => {
  const nested = {
    id: 'm1',
    role: 'assistant',
    content: 'top',
    thought: 'Delegate investigation',
    timestamp: 1,
    subtype: 'subagent',
    subagent: { name: 'explore', displayName: 'Explore', status: 'running', description: 'Investigate', model: 'gpt-x', toolCount: 2, prompt: 'Find the issue' },
    subMessages: [
      {
        id: 'm2', role: 'assistant', content: 'inner', timestamp: 2,
        subtype: 'subagent', subagent: { name: 'task', displayName: 'Task', status: 'completed' },
        toolCalls: [{ toolCallId: 't1', title: 'ran', status: 'completed', name: 'bash', args: '{"command":"true"}', output: 'done' }],
        subMessages: [{
          id: 'm3', role: 'system', content: 'failed', timestamp: 3, level: 'error',
          subtype: 'subagent', subagent: { name: 'task', displayName: 'Nested task', status: 'failed', error: 'Test failure' },
          subMessages: [{ id: 'm4', role: 'user', content: 'answer', timestamp: 4, subtype: 'ask-reply' }],
        }],
      },
    ],
  } satisfies ChatMessage;
  roundTrip(ChatMessage, nested);
  for (const invalid of [{ role: 'invalid' }, { timestamp: '4' }, { subagent: { name: 'task', displayName: 'Task', status: 'launching' } }]) {
    const broken = structuredClone(nested);
    Object.assign(broken.subMessages[0]!.subMessages[0]!.subMessages[0]!, invalid);
    assert.equal(ChatMessage.safeParse(broken).success, false, 'validate recursively, not just the outer card');
  }
});

test('E22: mcp/session explicitly distinguishes unloaded state and rejects unknown status', () => {
  const result = Intents['mcp/session'].result;
  assert.ok(result.safeParse({
    loaded: false,
    servers: [{
      name: 'cockpit',
      detail: 'node cockpit.js',
      status: 'unloaded',
      enabled: true,
    }],
  }).success);
  assert.equal(result.safeParse({
    servers: [],
  }).success, false, 'loaded is required even when no MCP servers are configured');
  assert.equal(result.safeParse({
    loaded: true,
    servers: [{
      name: 'cockpit',
      detail: 'node cockpit.js',
      status: 'not-a-real-status',
      enabled: true,
    }],
  }).success, false);
});

test('summary cards retain native identity without nested content or mutating full transcripts', () => {
  const message: ChatMessage = {
    id: 'subagent-native-tool', role: 'assistant', subtype: 'subagent', content: '', timestamp: 1,
    subagent: { name: 'explore', displayName: 'Research', status: 'completed', prompt: 'Large task prompt' },
    subMessages: [{ id: 'child', role: 'assistant', content: 'Child detail', timestamp: 2 }],
  };
  const original = structuredClone(message);
  const summary = Protocol.summarizeMessage(message);
  assert.equal(summary.subMessages, undefined);
  assert.equal(summary.subagent?.prompt, undefined);
  assert.equal(summary.subagent?.toolCallId, 'native-tool');
  assert.deepEqual(message, original);
  roundTrip(ChatMessage, summary);
});

test('native passive reads cannot pretend to filter agents, types or ephemeral content', () => {
  const body = Intents['session/chat'].body;
  for (const selector of [{ types: ['assistant.message'] }, { agentIds: ['child'] },
    { agentScope: 'primary' }, { waitMs: 1 }, { includeEphemeral: true }]) {
    assert.equal(body.safeParse({ sessionId: 's', source: 'persisted', ...selector }).success, false);
  }
  assert.equal(body.safeParse({ sessionId: 's', source: 'live', agentIds: ['child'] }).success, true);
});

const sid = { sessionId: 's1' };
const ok = { ok: true };

test('native global skill selection validates the target and preserves authoritative enabled state', () => {
  const schema = Intents['skills/global-toggle'].body;
  assert.deepEqual(schema.parse({ name: 'review', enabled: false }), { name: 'review', enabled: false });
  assert.deepEqual(schema.parse({ name: 'review', enabled: true, cwd: '/project' }), { name: 'review', enabled: true, cwd: '/project' });
  assert.equal(schema.safeParse({ name: 'review', enabled: true, cwd: '' }).success, false);
  for (const body of [{ name: '', enabled: true }, { name: 'review' }, { name: 'review', enabled: 'false' }]) {
    assert.equal(schema.safeParse(body).success, false);
  }
  assert.equal(Protocol.SkillGlobal.parse({ name: 'review', enabled: false }).enabled, false);
  assert.equal(Intents['skills/read'].result.parse({ name: 'review', enabled: false }).enabled, false);
});

const chat = { id: 'm1', role: 'user', content: 'hello', timestamp: 1 } satisfies ChatMessage;
const brief = {
  ...sid, title: 'T', cwd: minimalMeta.cwd, status: 'idle',
  loaded: true, lastActivity: 1, currentModelId: 'gpt-x',
} satisfies SessionBrief;
const panels = {
  skills: [{ label: 'review', sublabel: 'User skill', enabled: true }],
  mcpServers: [{ label: 'tools', sublabel: 'Connected', enabled: true }],
  tasks: [{ label: 'explore', sublabel: 'Running' }],
  instructionSources: [{ label: 'AGENTS.md', sublabel: 'Repository' }],
  schedules: [{ label: 'Check progress', enabled: false }],
} satisfies SessionPanels;
const plan = {
  planMarkdown: '# Plan',
  todos: (['pending', 'in_progress', 'done', 'blocked'] as const).map((status, i) => ({
    id: `todo-${i}`, title: `Step ${i}`, description: 'Details', status,
  })),
} satisfies Protocol.SessionPlan;
const scheduleBase = { prompt: 'check progress', nextRunAt: 123, displayPrompt: 'Check' };
const scheduleEntries = [
  { ...scheduleBase, id: 1, recurring: true, intervalMs: 300_000 },
  { ...scheduleBase, id: 2, recurring: true, cron: '0 * * * *', tz: 'Asia/Shanghai' },
  { ...scheduleBase, id: 3, recurring: false, at: 123 },
  { ...scheduleBase, id: 4, recurring: true, selfPaced: true },
  { ...scheduleBase, id: 5, recurring: true, selfPaced: false, intervalMs: 60_000 },
] satisfies ScheduleEntry[];
const operation = {
  id: 'op1', desiredEnabled: true, state: 'succeeded',
  startedAt: 1, completedAt: 2, status: 'connected',
} satisfies Protocol.McpToggleOperation;
const toggleResult = {
  ...ok, ...sid, applied: true, name: 'tools', enabled: true, status: 'connected', operation,
} satisfies McpToggleResult;
const skill = { name: 'review', description: 'Review code', source: 'user' };
const nativePage: Protocol.NativeChatPage = {
  ...sid, source: 'persisted', direction: 'backward',
  events: [{ id: 'event', type: 'assistant.message', data: { messageId: 'm1', content: 'Answer' } }],
  cursor: 'native-next', cursorStatus: 'ok', hasMore: true, read: { rpc: 1, events: 1 },
};

// Each retained intent must have a lossless body AND result fixture.
const intentFixtures = {
  'system/shutdown': { body: { confirm: true }, result: { ok: true,
    shutdown: { phase: 'waiting', requestedAt: 1, error: null } } },
  'system/status': { body: {}, result: { running: 0, busy: 0, inFlightRequests: 0,
    shutdown: { phase: 'running', requestedAt: null, error: null }, sessions: [] } },
  'runtime/snapshot': { body: {}, result: snapshot },
  'session/new': { body: { cwd: minimalMeta.cwd }, result: sid },
  'roles/list': { body: {}, result: { roles: [] } },
  'roles/add': { body: { ...sid, roles: [{ moduleId: 'fixture', roleId: 'owner' }] },
    result: { ...sid, status: 'saved', roles: [], appliedRoles: [], loaded: true, rolesNeedReload: false } },
  'roles/readiness': { body: sid, result: { ...sid, roles: [], loaded: false, ready: false, reasons: ['Session is unloaded'] } },
  'session/fork': { body: { sessionId: 'parent', toEventId: 'user-event', name: 'Child' }, result: sid },
  'session/chat': { body: { ...sid, source: 'persisted', direction: 'backward', max: 64, waitMs: 0, bootstrap: false }, result: nativePage },
  prompt: { body: { ...sid, text: 'continue', mode: 'enqueue',
    attachments: [{ type: 'file', path: '/fixture/native.txt' }] }, result: { ...ok, queued: true } },
  cancel: { body: sid, result: ok },
  'session/interrupt': { body: sid, result: { ok: true, interrupted: false } },
  'session/control': { body: { ...sid, token: 'native-handle', action: { type: 'clear-queue' } },
    result: { ok: true, outcomes: [{ operation: 'queue.clear', state: 'accepted' }] } },
  setModel: { body: { ...sid, modelId: 'gpt-x', reasoningEffort: 'high', contextTier: 'long_context' }, result: { ok: true, result: { status: 'deferred', deferred: true } } },
  'session/rename': { body: { ...sid, name: 'Renamed' }, result: { ...ok, title: 'Renamed' } },
  'session/compact': { body: { ...sid, customInstructions: 'Keep decisions' }, result: { ok: true, result: { success: true, tokensRemoved: 10, messagesRemoved: 2 } } },
  'session/rewind': { body: { ...sid, toMsgId: 'm1', rollbackFiles: true }, result: { ok: true, result: { outcome: 'success', eventsRemoved: 2, restoredFiles: [], skippedFiles: [] } } },
  setMode: { body: { ...sid, mode: 'plan' }, result: { ok: true, result: { status: 'applied', modelChanged: false } } },
  'session/delete': { body: sid, result: ok },
  'session/unload': { body: sid, result: ok },
  'session/load': { body: sid, result: { ok: true, ...sid } },
  'session/reload': { body: sid, result: ok },
  'session/tools-initialize': { body: sid, result: { ok: true } },
  'session/resources-prepare': { body: sid, result: { sessionId: 's', ok: true, skills: [], mcpServers: [], tools: 'unchanged' } },
  'session/plan': { body: sid, result: plan },
  'session/usage': { body: sid, result: { ...sid, sampledAt: 1, context: null,
    usage: { sessionStartTime: '2026-09-09T00:00:00Z', totalUserRequests: 0,
      lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {} } } },
  'session/panels': { body: sid, result: panels },
  'session/panel': { body: { ...sid, section: 'tasks' }, result: { items: panels.tasks } },
  'session/resources': { body: { ...sid, resources: ['schedule'] }, result: { meta: { ...sid, loaded: true, scheduleCount: 2 } } },
  respondAsk: { body: { ...sid, requestId: 'r1', answer: 'yes', wasFreeform: false }, result: ok },
  respondPlan: { body: { ...sid, requestId: 'r1', action: 'autopilot_fleet' }, result: ok },
  planSupersede: { body: { ...sid, requestId: 'r1', message: 'Do this instead' }, result: ok },
  respondElicitation: { body: { ...sid, requestId: 'r1', action: 'accept' }, result: ok },
  'queue/remove': { body: { ...sid, itemId: 'q1' }, result: ok },
  'session/refresh': { body: {}, result: ok },
  'session/list': { body: {}, result: { sessions: [brief] } },
  'session/get': { body: sid, result: { meta: fullMeta } },
  'mcp/global': {
    body: {},
    result: { servers: [{ name: 'tools', detail: 'node tools.js', defaultOn: true, config: { command: 'node', args: ['tools.js'], env: { TOKEN: '[redacted]' } } }] },
  },
  'mcp/global-default': { body: { name: 'tools', on: true }, result: ok },
  'mcp/refresh': { body: {}, result: ok },
  'mcp/reload-session': { body: sid, result: { ...ok, reconnected: 2 } },
  'mcp/session': { body: sid, result: { loaded: true, servers: [{ name: 'tools', detail: 'node tools.js', status: 'connected', enabled: true, operation }] } },
  'mcp/session-toggle': { body: { ...sid, name: 'tools', on: true }, result: toggleResult },
  'skills/global': { body: { cwd: minimalMeta.cwd }, result: { skills: [{ ...skill, userInvocable: true, enabled: false }] } },
  'skills/read': { body: { name: skill.name }, result: { ...skill, userInvocable: true, enabled: false, body: '# Review\nCheck correctness.' } },
  'skills/global-toggle': { body: { name: skill.name, enabled: true }, result: ok },
  'skills/session': { body: sid, result: { skills: [{ ...skill, enabled: true }] } },
  'skills/session-toggle': { body: { ...sid, name: skill.name, enabled: true }, result: ok },
  'skills/refresh': { body: {}, result: ok },
  'fs/listDir': { body: { path: '/workspace' }, result: { path: '/workspace', parent: '/', entries: [{ name: 'project', isDir: true }, { name: 'file.txt', isDir: false }] } },
  'schedule/add': { body: { ...sid, prompt: scheduleBase.prompt, interval: '5m' }, result: { ...ok, entry: scheduleEntries[0]! } },
  'schedule/stop': { body: { ...sid, id: 1 }, result: ok },
  'schedule/list': { body: sid, result: { entries: scheduleEntries } },
} satisfies { [K in IntentName]: { body: IntentBody<K>; result: IntentResult<K> } };

for (const name of Object.keys(intentFixtures) as Array<keyof typeof intentFixtures>) {
  test(`${name}: retained body and result round-trip without field loss`, () => {
    const { body, result } = intentFixtures[name];
    roundTrip(Intents[name].body, body, `${name} body`);
    roundTrip(Intents[name].result, result, `${name} result`);
  });
}

test('the intent registry contains precisely the retained fixture names', () => {
  assert.deepEqual(Object.keys(Intents).sort(), Object.keys(intentFixtures).sort());
});

test('resource projections distinguish omitted fields, explicit clearing, unknown sessions and invalid selectors', () => {
  for (const meta of [{ ...sid, loaded: false }, { ...sid, loaded: true, currentReasoningEffort: null }, null]) {
    roundTrip(Intents['session/resources'].result, { meta });
  }
  for (const resources of [[], ['unknown'], ['plan']]) {
    assert.equal(Intents['session/resources'].body.safeParse({ ...sid, resources }).success, false);
  }
  assert.equal(Intents['session/panel'].body.safeParse({ ...sid, section: 'unknown' }).success, false);
  roundTrip(ServerEvent, { type: 'session/invalidated', ...sid, resources: ['tasks', 'instructions'] });
  roundTrip(ServerEvent, { type: 'session/invalidated', ...sid });
  assert.equal(ServerEvent.safeParse({ type: 'session/invalidated', ...sid, resources: ['unknown'] }).success, false);
});

const removedExports = [
  'SessionEventType', 'SessionEventCtx', 'HookFilter', 'HookEntry', 'GateSpec',
  'SessionTemplate', 'FlowAction', 'Flow', 'InlineScheduleTarget', 'FlowScheduleEntry',
  'SessionLaunchState', 'SafeBasename',
] as const;
type RemovedIntentName = `hook/${string}` | `flow/${string}` | `flow-schedule/${string}` | 'session/set-spawned-by';
type RemovedMetaField = 'hookCount' | 'spawnedBy' | 'launchState';

test('governance intents and schema exports are absent, not compatibility aliases', () => {
  assert.deepEqual(Object.keys(Intents).filter((name) =>
    /^(hook|flow|flow-schedule)\//.test(name) || name === 'session/set-spawned-by'), []);
  for (const name of removedExports) {
    assert.equal(Object.hasOwn(Protocol, name), false, `${name} must not be exported`);
  }
});

test('session metadata and SSE patches strip removed governance fields', () => {
  const removed = { hookCount: 2, spawnedBy: 'old-worker', launchState: 'launching' };
  for (const field of Object.keys(removed)) {
    assert.equal(Object.hasOwn(SessionMeta.shape, field), false);
    assert.equal(Object.hasOwn(SessionBrief.shape, field), false);
  }
  assert.deepEqual(SessionMeta.parse({ ...fullMeta, ...removed }), fullMeta);
  assert.deepEqual(SessionBrief.parse({ ...brief, ...removed }), brief);
  assert.deepEqual(Intents['session/get'].result.parse({ meta: { ...fullMeta, ...removed } }), { meta: fullMeta });
  assert.deepEqual(Intents['session/list'].result.parse({ sessions: [{ ...brief, ...removed }] }), { sessions: [brief] });
  const patch = { type: 'session/patch', ...sid };
  assert.deepEqual(ServerEvent.parse({ ...patch, ...removed }), patch);
});

test('session/fork uses strict native fields and never accepts cwd or blank boundaries', () => {
  const schema = Intents['session/fork'].body;
  assert.deepEqual(schema.parse({ sessionId: 's', name: '  child  ' }), { sessionId: 's', name: 'child' });
  for (const body of [{}, { sessionId: '' }, { sessionId: 's', toEventId: '' }, { sessionId: 's', name: ' ' },
    { sessionId: 's', cwd: '/different-worktree' }, { sessionId: 's', toMsgId: 'ambiguous' }]) {
    assert.equal(schema.safeParse(body).success, false);
  }
});

test('session/new accepts cwd and explicit roles while rejecting retired module or hidden launch inputs', () => {
  const schema = Intents['session/new'].body;
  assert.deepEqual(Object.keys(schema.shape), ['cwd', 'roles']);
  roundTrip(schema, { cwd: '/workspace', roles: [{ moduleId: 'board', roleId: 'owner' }, { moduleId: 'board', roleId: 'executor' }] });
  assert.equal(schema.safeParse({ cwd: '/workspace', roles: [{ moduleId: 'board', roleId: '../escape' }] }).success, false);
  assert.equal(schema.safeParse({ cwd: '/workspace/project', modules: [] }).success, false);
  for (const cwd of ['/workspace/project', 'relative/path']) {
    roundTrip(schema, { cwd });
    assert.equal(schema.safeParse({
      cwd, spawnedBy: 'old-worker', title: 'Ignored', prompt: 'Do not launch',
      skills: ['review'], mcps: ['tools'], model: 'gpt-x', mode: 'autopilot',
      template: {}, launchState: 'launching', unknown: true,
    }).success, false);
    assert.equal(schema.safeParse({ cwd, sessionId: 'virtual-id' }).success, false);
  }
  for (const value of [{}, null, [], { cwd: '' }, { cwd: undefined }, { cwd: null }, { cwd: false }, { cwd: 1 }, { cwd: [] }, { cwd: {} }]) {
    assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));
  }
});

test('module loading and retired creation/deletion coordinators are not APIs', () => {
  assert.equal(Object.keys(Intents).some(name => name.startsWith('modules/') || name.startsWith('session/modules/')), false);
  assert.equal('ModuleId' in Protocol, false);
  for (const name of ['session/start', 'session/start/get', 'session/delete/preview', 'session/modules/apply', 'modules/list']) {
    assert.equal(Object.hasOwn(Intents, name), false);
  }
});

test('native load descriptions do not promise retired role restoration or empty-session protection', () => {
  for (const name of ['session/load', 'session/reload'] as const) {
    assert.match(Intents[name].description, /native configuration discovery/);
    assert.doesNotMatch(Intents[name].description, /pinned module|refused before close|partial-load failure gates/);
  }
  assert.match(Intents['session/load'].description, /Never creates a replacement, closes an already-loaded handle, or sends a prompt/);
  assert.match(Intents['session/reload'].description, /may disappear on close and then fail to resume; no automatic replacement/);
});

test('session/delete requires sessionId and rejects obsolete confirmation input', () => {
  const schema = Intents['session/delete'].body;
  roundTrip(schema, sid);
  for (const confirm of [true, false, 'true', 'false', '', 0, 1, null, [], {}]) {
    assert.equal(schema.safeParse({ ...sid, confirm }).success, false, `confirm=${JSON.stringify(confirm)}`);
  }
  for (const value of [{}, { sessionId: '' }, { sessionId: 1 }, { sessionId: null }]) {
    assert.equal(schema.safeParse(value).success, false);
  }
  assert.equal('session/purge' in Intents, false);
});

test('native compaction and rewind reject unknown input instead of stripping it', () => {
  for (const [name, body] of [
    ['session/compact', sid],
    ['session/rewind', { ...sid, toMsgId: 'm1' }],
  ] as const) {
    roundTrip(Intents[name].body, body);
    for (const extra of [{ confirm: true }, { confirm: false }, { unexpected: true }]) {
      assert.equal(Intents[name].body.safeParse({ ...body, ...extra }).success, false);
    }
  }
});

test('session reads retain native pages and authoritative metadata wrappers', () => {
  roundTrip(Intents['session/chat'].result, nativePage);
  for (const [name, empty] of [
    ['session/list', { sessions: [] }],
    ['session/get', { meta: null }],
  ] as const) {
    roundTrip(Intents[name].result, empty);
    for (const invalid of [{}, [], null, { ok: true }]) {
      assert.equal(Intents[name].result.safeParse(invalid).success, false, name);
    }
  }
  assert.equal(Intents['session/list'].result.safeParse({ sessions: [minimalMeta.sessionId] }).success, false);
  assert.equal(Intents['session/get'].result.safeParse({ meta: brief }).success, false);
});

test('SessionPanels retains precisely the five native sections', () => {
  const keys = ['skills', 'mcpServers', 'tasks', 'instructionSources', 'schedules'];
  assert.deepEqual(Object.keys(SessionPanels.shape).sort(), [...keys].sort());
  roundTrip(SessionPanels, panels);
  assert.deepEqual(SessionPanels.parse({ ...panels, hooks: [], flows: [], flowSchedules: [] }), panels);
  for (const key of keys) {
    const missing: Record<string, unknown> = { ...panels };
    delete missing[key];
    assert.equal(SessionPanels.safeParse(missing).success, false, `${key} is required`);
    assert.equal(SessionPanels.safeParse({ ...panels, [key]: null }).success, false);
  }
});

test('native schedule creation is narrow while existing entries retain their metadata', () => {
  const timings = [{ interval: '5m' }, { interval: '1d' }, { at: 123 }, { at: 0 }];
  for (const timing of timings) {
    const body = { ...sid, prompt: 'check progress', ...timing };
    roundTrip(Intents['schedule/add'].body, body);
    for (const recurring of ('at' in timing ? [false] : [true, false])) {
      roundTrip(Intents['schedule/add'].body, { ...body, recurring });
    }
  }
  for (const entry of scheduleEntries) {
    roundTrip(ScheduleEntry, entry);
    roundTrip(Intents['schedule/add'].result, { ...ok, entry });
    roundTrip(Intents['schedule/stop'].body, { ...sid, id: entry.id });
    assert.equal(ScheduleEntry.safeParse({ ...entry, id: String(entry.id) }).success, false);
    assert.equal(ScheduleEntry.safeParse({ ...entry, selfPaced: 'true' }).success, false);
  }
  roundTrip(Intents['schedule/list'].result, { entries: scheduleEntries });
  roundTrip(Intents['schedule/list'].result, { entries: [] });
  roundTrip(Intents['schedule/add'].result, ok);
  roundTrip(Intents['schedule/add'].result, { ok: false, error: 'Invalid schedule' });
  assert.equal(Intents['schedule/stop'].body.safeParse({ ...sid, id: '1' }).success, false);
  assert.equal(Intents['schedule/stop'].body.safeParse(sid).success, false);
  // ScheduleEntry is a wire object; only schedule/add enforces timing exclusivity.
  roundTrip(ScheduleEntry, { ...scheduleBase, id: 0, recurring: false });
  roundTrip(ScheduleEntry, { ...scheduleBase, id: 0, recurring: true, intervalMs: 1000, cron: '* * * * *', at: 123 });
});

test('self-paced schedule metadata does not authorize creation or rearming', () => {
  assert.equal(Intents['schedule/add'].body.safeParse({
    ...sid, prompt: 'check progress', selfPaced: true,
  }).success, false);
  assert.equal(Intents['schedule/add'].body.safeParse({
    ...sid, prompt: 'check progress', interval: '5m', selfPaced: true,
  }).success, false);
  assert.ok(!Object.keys(Intents).some(name => /schedule.*(?:rearm|wakeup|self-paced)/.test(name)));
});

test('schedule/add rejects every missing or conflicting timing combination', () => {
  const base = { ...sid, prompt: 'check progress' };
  const timings = [{ interval: '5m' }, { at: 123 }];
  for (let mask = 0; mask < 4; mask++) {
    const selected = timings.filter((_, i) => mask & (1 << i));
    const body = Object.assign({}, base, ...selected);
    assert.equal(Intents['schedule/add'].body.safeParse(body).success, selected.length === 1, JSON.stringify(body));
  }
  for (const invalid of [
    { prompt: '', interval: '5m' }, { interval: 5 }, { cron: 5 }, { at: '123' },
    { interval: null }, { cron: null }, { at: null }, { interval: '5m', recurring: 'true' },
    { interval: '5m', tz: 1 }, { interval: '5m', displayPrompt: false },
    { cron: '0 * * * *' }, { interval: '2d' }, { at: 123, recurring: true },
  ]) {
    assert.equal(Intents['schedule/add'].body.safeParse({ ...base, ...invalid }).success, false);
  }
  assert.equal(Intents['schedule/add'].body.safeParse({ prompt: 'p', interval: '5m' }).success, false);
});

test('MCP and skills controls preserve explicit on/off and authoritative results', () => {
  for (const enabled of [true, false]) {
    roundTrip(Intents['mcp/global-default'].body, { name: 'tools', on: enabled });
    roundTrip(Intents['mcp/session-toggle'].body, { ...sid, name: 'tools', on: enabled });
    roundTrip(Intents['skills/session-toggle'].body, { ...sid, name: skill.name, enabled });
    roundTrip(Intents['mcp/global'].result, { servers: [{ name: 'tools', detail: 'node tools.js', defaultOn: enabled }] });
    roundTrip(Intents['skills/global'].result, { skills: [{ ...skill, userInvocable: enabled }] });
    roundTrip(Intents['skills/session'].result, { skills: [{ ...skill, enabled }] });
    roundTrip(Intents['skills/refresh'].result, ok);
  }
  for (const [name, field] of [
    ['mcp/global-default', 'on'], ['mcp/session-toggle', 'on'], ['skills/session-toggle', 'enabled'],
  ] as const) {
    assert.equal(Intents[name].body.safeParse({ ...sid, name: 'tools' }).success, false);
    for (const value of ['true', 1, null]) {
      assert.equal(Intents[name].body.safeParse({ ...sid, name: 'tools', [field]: value }).success, false);
    }
  }
  for (const status of ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'stopped', 'not_configured', 'unloaded'] as const) {
    roundTrip(Protocol.McpServerStatus, status);
    for (const loaded of [true, false]) {
      roundTrip(Intents['mcp/session'].result, {
        loaded, servers: [{ name: 'tools', detail: 'node tools.js', status, enabled: false, error: 'Detail', operation: { ...operation, status } }],
      });
    }
    roundTrip(McpToggleResult, { ...toggleResult, status, operation: { ...operation, status } });
  }
  for (const state of ['running', 'cancelling', 'settling', 'succeeded', 'failed'] as const) {
    roundTrip(Intents['mcp/session-toggle'].result, {
      ...toggleResult, ok: false, applied: false, enabled: false, error: 'Operation detail',
      operation: { ...operation, desiredEnabled: false, state, error: 'Operation detail' },
    });
  }
  for (const field of ['ok', 'applied', 'sessionId', 'name', 'enabled', 'status', 'operation']) {
    const missing: Record<string, unknown> = { ...toggleResult };
    delete missing[field];
    assert.equal(McpToggleResult.safeParse(missing).success, false, `toggle result requires ${field}`);
  }
  assert.equal(McpToggleResult.safeParse({ ...toggleResult, operation: { ...operation, state: 'unknown' } }).success, false);
  assert.equal(Intents['skills/refresh'].result.safeParse(ok).success, true);
  assert.equal(Intents['mcp/reload-session'].result.safeParse(ok).success, false);
  roundTrip(Intents['skills/read'].result, { name: skill.name });
});

test('native plans, todos and context/model controls remain intact', () => {
  roundTrip(Protocol.SessionPlan, plan);
  roundTrip(Intents['session/plan'].result, { planMarkdown: null, todos: [] });
  for (const invalid of [{ todos: [] }, { planMarkdown: null }, { planMarkdown: null, todos: [{ id: 't1', title: 'T', status: 'cancelled' }] }]) {
    assert.equal(Protocol.SessionPlan.safeParse(invalid).success, false);
  }
  for (const intent of ['Working', null]) {
    roundTrip(Protocol.TodoProgress, { done: 1, total: 2, intent });
  }
  assert.equal(Protocol.TodoProgress.safeParse({ done: 0, total: 1 }).success, false);
  const model = {
    modelId: 'gpt-x', name: 'GPT-X', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', supportsLongContext: true,
  };
  roundTrip(Protocol.ModelOption, model);
  roundTrip(Protocol.ModelOption, { ...model, supportedReasoningEfforts: [], supportsLongContext: false });
  for (const contextTier of ['default', 'long_context'] as const) {
    roundTrip(Intents.setModel.body, { ...sid, modelId: model.modelId, reasoningEffort: 'high', contextTier });
    roundTrip(SessionMeta, { ...fullMeta, currentContextTier: contextTier, availableModels: [model] });
  }
  roundTrip(Intents.setModel.body, { ...sid, modelId: model.modelId });
  for (const contextTier of ['unknown', null]) {
    assert.equal(Intents.setModel.body.safeParse({ ...sid, modelId: model.modelId, contextTier }).success, false);
  }
});

test('queues and decisions retain every plan action and native mode', () => {
  const actions = ['exit_only', 'interactive', 'autopilot', 'autopilot_fleet'] as const;
  assert.deepEqual(Protocol.ExitPlanModeAction.options, [...actions]);
  for (const action of actions) {
    const planRequest = { requestId: 'p1', summary: 'Ready', planContent: '# Plan', actions: [...actions], recommendedAction: action };
    roundTrip(Protocol.PlanRequest, planRequest);
    roundTrip(ServerEvent, { type: 'session/patch', ...sid, planRequest });
    roundTrip(Intents.respondPlan.body, { ...sid, requestId: 'p1', action });
  }
  assert.deepEqual(Protocol.AgentMode.options, ['interactive', 'plan', 'autopilot']);
  for (const mode of ['interactive', 'plan', 'autopilot'] as const) {
    roundTrip(Intents.setMode.body, { ...sid, mode });
    roundTrip(SessionMeta, { ...fullMeta, currentMode: mode });
  }
  for (const action of ['unknown', 'plan', null]) {
    assert.equal(Intents.respondPlan.body.safeParse({ ...sid, requestId: 'p1', action }).success, false);
    assert.equal(Protocol.PlanRequest.safeParse({ requestId: 'p1', summary: 'Ready', actions: [action] }).success, false);
    assert.equal(Protocol.PlanRequest.safeParse({ requestId: 'p1', summary: 'Ready', recommendedAction: action }).success, false);
  }
  for (const mode of ['fleet', 'autopilot_fleet', null]) {
    assert.equal(Intents.setMode.body.safeParse({ ...sid, mode }).success, false);
  }
  roundTrip(Protocol.AskRequest, { requestId: 'r1', question: 'Choose', choices: ['A', 'B'], allowFreeform: true });
  for (const wasFreeform of [true, false]) {
    roundTrip(Intents.respondAsk.body, { ...sid, requestId: 'r1', answer: 'A', wasFreeform });
  }
  for (const action of ['accept', 'decline', 'cancel'] as const) {
    roundTrip(Intents.respondElicitation.body, { ...sid, requestId: 'e1', action });
  }
  assert.equal(Intents.respondElicitation.body.safeParse({ ...sid, requestId: 'e1', action: 'unknown' }).success, false);
  for (const mode of ['enqueue', 'immediate'] as const) {
    roundTrip(Intents.prompt.body, { ...sid, text: 'continue', mode });
    roundTrip(Intents.prompt.result, { ...ok, queued: mode === 'enqueue' });
  }
  roundTrip(Intents.prompt.body, { ...sid, text: 'continue' });
  for (const queue of [[], [{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }]]) {
    roundTrip(ServerEvent, { type: 'session/patch', ...sid, queue });
  }
  assert.equal(Intents['queue/remove'].body.safeParse(sid).success, false);
  assert.equal(ServerEvent.safeParse({ type: 'session/patch', ...sid, queue: [{ text: 'missing id' }] }).success, false);
});

test('all clearable metadata survives snapshots and actual SSE patches as null', () => {
  const cleared = {
    error: null, ask: null, planRequest: null, elicitation: null, todo: null,
    intent: null, currentReasoningEffort: null, currentContextTier: null, currentMode: null,
  };
  roundTrip(SessionMeta, { ...fullMeta, ...cleared });
  roundTrip(ServerEvent, { type: 'session/patch', ...sid, ...cleared });
  for (const key of Object.keys(cleared)) {
    roundTrip(ServerEvent, { type: 'session/patch', ...sid, [key]: null });
  }
  for (const key of ['title', 'currentModelId', 'availableModels', 'queue', 'loaded', 'loading', 'closing', 'cancelling', 'activeSubagents', 'scheduleCount', 'compacting', 'activeMcpOperations']) {
    assert.equal(ServerEvent.safeParse({ type: 'session/patch', ...sid, [key]: null }).success, false, key);
  }
  for (const activeMcpOperations of [0, 2]) {
    roundTrip(ServerEvent, { type: 'session/patch', ...sid, activeMcpOperations });
  }
  for (const activeMcpOperations of [-1, 0.5, '1']) {
    assert.equal(SessionMeta.safeParse({ ...minimalMeta, activeMcpOperations }).success, false);
  }
  for (const required of ['ask']) {
    const missing: Record<string, unknown> = { ...minimalMeta };
    delete missing[required];
    assert.equal(SessionMeta.safeParse(missing).success, false, `${required} is nullable but required`);
  }
  const { error: _error, ...withoutError } = minimalMeta;
  roundTrip(SessionMeta, withoutError);
  assert.equal('error' in SessionMeta.parse(withoutError), false, 'native has no authoritative current-error getter');
});

test('SSE discriminators, pagination flags and nested payload validation are preserved', () => {
  for (const agentStatus of ['starting', 'up', 'stopping', 'failed'] as const) {
    roundTrip(ServerEvent, { ...snapshot, agentStatus });
    roundTrip(ServerEvent, { type: 'agent/status', status: agentStatus });
  }
  for (const status of ['unloaded', 'idle', 'running', 'error'] as const) {
    roundTrip(SessionBrief, { ...brief, status });
    roundTrip(ServerEvent, { type: 'session/added', session: { ...fullMeta, status } });
  }
  for (const reason of ['rewind', 'compaction']) roundTrip(ServerEvent, { type: 'chat/invalidated', ...sid, reason });
  for (const invalid of [
    { type: 'unknown' }, { type: 'session/patch', error: null },
    { type: 'agent/status', status: 'down' }, { type: 'session/added', session: brief },
    { type: 'session/notify', ...sid, title: 'T', body: 'Notice', attention: null },
    { type: 'session/reset', page: { ...sid, messages: [], hasMore: 'false' } },
    { type: 'session/reset', page: { ...sid, messages: [{ ...chat, role: 'invalid' }], hasMore: false } },
    { type: 'msg/upsert', ...sid, message: { id: 'missing-fields' } },
  ]) {
    assert.equal(ServerEvent.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
});

test('Snapshot is the shared SSE and passive runtime result with required allow-all policy', () => {
  assert.equal(Intents['runtime/snapshot'].result, Protocol.Snapshot);
  assert.equal(ServerEvent.options.find((schema) => schema.shape.type.value === 'snapshot'), Protocol.Snapshot);
  const minimalSnapshot = {
    type: 'snapshot', agentStatus: 'starting', models: [], sessions: [], permissionPolicy: 'allow-all',
  } satisfies Protocol.Snapshot;
  for (const schema of [Protocol.Snapshot, Intents['runtime/snapshot'].result, ServerEvent]) {
    roundTrip(schema, snapshot);
    roundTrip(schema, minimalSnapshot);
    for (const field of Object.keys(minimalSnapshot)) {
      const missing: Record<string, unknown> = { ...minimalSnapshot };
      delete missing[field];
      assert.equal(schema.safeParse(missing).success, false, `snapshot requires ${field}`);
    }
    for (const invalid of [
      { models: [{ modelId: 'missing-name' }] },
      { models: [{ ...snapshot.models[0], supportedReasoningEfforts: [1] }] },
      { sessions: [brief] },
      { sessions: [{ ...fullMeta, ask: { requestId: 'r1' } }] },
    ]) {
      assert.equal(schema.safeParse({ ...snapshot, ...invalid }).success, false, JSON.stringify(invalid));
    }
  }
});

test('permission policy stays allow-all independently of every interaction mode', () => {
  for (const mode of ['interactive', 'plan', 'autopilot'] as const) {
    roundTrip(Intents.setMode.body, { ...sid, mode });
    const value = { ...snapshot, sessions: [{ ...fullMeta, currentMode: mode }] };
    for (const schema of [Protocol.Snapshot, Intents['runtime/snapshot'].result, ServerEvent]) {
      roundTrip(schema, value);
      for (const permissionPolicy of [undefined, null, mode, 'deny-all', 'ask', true, {}]) {
        assert.equal(schema.safeParse({ ...value, permissionPolicy }).success, false, `policy=${JSON.stringify(permissionPolicy)}`);
      }
    }
  }
  assert.equal(Protocol.AgentMode.safeParse('allow-all').success, false);
  assert.equal(Intents.setMode.body.safeParse({ ...sid, mode: 'allow-all' }).success, false);
  assert.equal(SessionMeta.safeParse({ ...fullMeta, currentMode: 'allow-all' }).success, false);
  assert.equal(ServerEvent.safeParse({ ...snapshot, sessions: [{ ...fullMeta, currentMode: 'allow-all' }] }).success, false);
});

test('session transition flags are optional booleans in metadata, reads, snapshots and patches', () => {
  roundTrip(SessionMeta, minimalMeta);
  roundTrip(ServerEvent, { type: 'session/patch', ...sid });
  for (const field of ['loading', 'closing', 'cancelling'] as const) {
    const boundaries = [
      { schema: SessionMeta, wrap: (value: unknown) => ({ ...minimalMeta, [field]: value }) },
      { schema: Intents['session/get'].result, wrap: (value: unknown) => ({ meta: { ...minimalMeta, [field]: value } }) },
      { schema: Protocol.Snapshot, wrap: (value: unknown) => ({ ...snapshot, sessions: [{ ...minimalMeta, [field]: value }] }) },
      { schema: ServerEvent, wrap: (value: unknown) => ({ type: 'session/patch', ...sid, [field]: value }) },
    ];
    for (const { schema, wrap } of boundaries) {
      for (const value of [true, false]) {
        roundTrip(schema, wrap(value), `${field}=${value}`);
      }
      for (const value of [null, 'true', 'false', 0, 1, [], {}]) {
        assert.equal(schema.safeParse(wrap(value)).success, false, `${field}=${JSON.stringify(value)}`);
      }
    }
  }
});

test('native pages require bounded counts, directional cursors and explicit expiry status', () => {
  const schema = Intents['session/chat'].body;
  assert.deepEqual(schema.parse(sid), { ...sid, source: 'persisted', direction: 'backward', max: 64, waitMs: 0, bootstrap: false });
  for (const max of [1, 64, 256]) assert.equal(schema.parse({ ...sid, max }).max, max);
  for (const max of [0, -1, 0.5, 257, Infinity, '64', null]) assert.equal(schema.safeParse({ ...sid, max }).success, false);
  for (const cursor of ['', null, 0, false, [], {}, 'a'.repeat(16385)]) {
    assert.equal(schema.safeParse({ ...sid, cursor }).success, false);
  }
  for (const invalid of [{ bootstrap: true, cursor: 'old' }, { bootstrap: true, direction: 'forward' },
    { direction: 'backward', waitMs: 10 }, { source: 'live', direction: 'forward', waitMs: 30001 }]) {
    assert.equal(schema.safeParse({ ...sid, ...invalid }).success, false);
  }
  for (const cursorStatus of ['ok', 'expired']) roundTrip(Intents['session/chat'].result, { ...nativePage, cursorStatus });
  assert.equal(Intents['session/chat'].result.safeParse({ ...nativePage, cursorStatus: undefined }).success, false);
  assert.equal(ServerEvent.safeParse({ type: 'msg/upsert', ...sid, message: chat }).success, false);
  assert.equal(ServerEvent.safeParse({ type: 'session/reset', page: { ...sid, messages: [chat], hasMore: true } }).success, false);
});

test('chat SSE requires an explicit cursor, preserves all-agent scope and bounds native waiting', () => {
  const schema = Protocol.NativeChatStreamRequest;
  assert.deepEqual(schema.parse({ ...sid, cursor: '', agentScope: 'all' }), { ...sid, cursor: '', agentScope: 'all', max: 64 });
  for (const body of [sid, { ...sid, cursor: 'c', max: 65 }, { ...sid, cursor: 'c', source: 'persisted' }]) {
    assert.equal(schema.safeParse(body).success, false);
  }
  assert.equal(Intents['session/chat'].body.parse({ ...sid, source: 'live', direction: 'forward', waitMs: 30000 }).waitMs, 30000);
  assert.equal(Protocol.NativeChatStreamEvent.safeParse({ type: 'error', error: 'Unloaded', code: 'SESSION_UNLOADED' }).success, true);
});

test('skills/global accepts an optional nonempty cwd without a session selector', () => {
  const schema = Intents['skills/global'].body;
  roundTrip(schema, {});
  for (const cwd of ['/workspace/project', 'relative/project', '/']) {
    roundTrip(schema, { cwd });
    assert.deepEqual(schema.parse({ cwd, sessionId: 'not-a-global-selector' }), { cwd });
  }
  assert.deepEqual(schema.parse({ sessionId: 'not-a-global-selector' }), {});
  for (const cwd of ['', null, false, 0, [], {}]) {
    assert.equal(schema.safeParse({ cwd }).success, false, `cwd=${JSON.stringify(cwd)}`);
  }
});

// Compile-time parity lock (enforced by `tsc` build; tsx strips it at runtime):
// the hand-written `interface ChatMessage` must equal the schema's inferred type.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const _chatMessageParity: Equal<z.infer<typeof ChatMessage>, ChatMessage> = true;
void _chatMessageParity;

type Expect<T extends true> = T;
type SlimContractGuards = [
  Expect<Equal<Extract<IntentName, RemovedIntentName>, never>>,
  Expect<Equal<Extract<keyof typeof Protocol, typeof removedExports[number]>, never>>,
  Expect<Equal<Extract<keyof SessionMeta, RemovedMetaField>, never>>,
  Expect<Equal<Extract<keyof SessionBrief, RemovedMetaField>, never>>,
  Expect<Equal<Extract<keyof Extract<Protocol.ServerEvent, { type: 'session/patch' }>, RemovedMetaField>, never>>,
  Expect<Equal<IntentBody<'session/new'>, { cwd: string; roles?: Array<{ moduleId: string; roleId: string }> }>>,
  Expect<Equal<IntentBody<'session/delete'>, { sessionId: string }>>,
  Expect<Equal<IntentBody<'session/chat'>, Protocol.NativeChatRead>>,
  Expect<Equal<IntentBody<'skills/global'>, { cwd?: string }>>,
  Expect<Equal<IntentBody<'prompt'>, { sessionId: string; text: string; mode?: 'enqueue' | 'immediate';
    attachments?: Protocol.NativeAttachment[] }>>,
  Expect<Equal<IntentResult<'session/chat'>, Protocol.NativeChatPage>>,
  Expect<Equal<IntentResult<'runtime/snapshot'>, Protocol.Snapshot>>,
  Expect<Equal<Extract<Protocol.ServerEvent, { type: 'snapshot' }>, Protocol.Snapshot>>,
  Expect<Equal<Extract<Protocol.ServerEventType, 'session/history-page'>, never>>,
  Expect<Equal<Protocol.Snapshot['permissionPolicy'], 'allow-all'>>,
  Expect<Equal<Pick<SessionMeta, 'loading' | 'closing' | 'cancelling'>, { loading?: boolean; closing?: boolean; cancelling?: boolean }>>,
  Expect<Equal<IntentResult<'session/list'>, { sessions: SessionBrief[] }>>,
  Expect<Equal<IntentResult<'session/get'>, { meta: SessionMeta | null }>>,
  Expect<Equal<keyof SessionPanels, 'skills' | 'mcpServers' | 'tasks' | 'instructionSources' | 'schedules'>>,
];
