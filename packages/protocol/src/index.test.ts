// Fixture tests for the shared wire contract. Lock the four invariants this
// module owns (clearable-null fields, exactly-one-of intent bodies, safe
// basenames, https endpoints) so a future edit can't silently re-loosen them.
// Run: pnpm --filter @cockpit/protocol test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  SessionMeta,
  ServerEvent,
  Intents,
  PushSubscriptionJson,
  Flow,
  ChatMessage,
  McpToggleResult,
} from './index.ts';

// A minimal, valid SessionMeta: only the keys with no default and no optional.
// `error` and `ask` are nullable-but-required, so they must be present as null.
const minimalMeta = {
  sessionId: 's1',
  title: 'T',
  cwd: '/tmp/x',
  lastActivity: 1,
  status: 'idle',
  error: null,
  loaded: true,
  queue: [],
  ask: null,
} as const;

// A fully-populated SessionMeta (snapshot shape): every optional field set to a
// real value, exercising the whole object.
const fullMeta = {
  ...minimalMeta,
  createdAt: 0,
  currentModelId: 'gpt-x',
  currentReasoningEffort: 'high',
  currentContextTier: 'long_context',
  currentMode: 'interactive',
  availableModels: [{ modelId: 'gpt-x', name: 'GPT-X' }],
  queue: [{ id: 'q1', text: 'queued' }],
  ask: { requestId: 'r1', question: 'q?' },
  planRequest: { requestId: 'p1', summary: 's' },
  elicitation: { requestId: 'e1', message: 'm' },
  todo: { done: 1, total: 2, intent: 'doing' },
  intent: 'Investigating',
  attention: 'ready',
  attnId: 3,
  seenId: 2,
  pinned: true,
  scheduleCount: 1,
  hookCount: 0,
  spawnedBy: 'welcome-flow',
  activeSubagents: 0,
  compacting: false,
};

// session/patch is derived exactly as the ServerEvent member is.
const SessionPatch = SessionMeta.partial().required({ sessionId: true });

// ───────────────────────────────────────────────────────────────────────────
// A. SessionMeta round-trip & null discipline
// ───────────────────────────────────────────────────────────────────────────

test('A1: a fully-populated SessionMeta parses', () => {
  assert.ok(SessionMeta.safeParse(fullMeta).success);
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
    attention: null,
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

test('C11–C13: schedule/add enforces exactly one of interval/cron/at', () => {
  const base = { sessionId: 's1', prompt: 'p' };
  const body = Intents['schedule/add'].body;
  // none
  assert.equal(body.safeParse(base).success, false);
  // two
  assert.equal(body.safeParse({ ...base, interval: '5m', at: 123 }).success, false);
  // exactly one (each kind)
  assert.ok(body.safeParse({ ...base, interval: '5m' }).success);
  assert.ok(body.safeParse({ ...base, cron: '0 * * * *' }).success);
  assert.ok(body.safeParse({ ...base, at: 123 }).success);
});

test('C14: hook/add enforces exactly one of flowId/promptTemplate', () => {
  const base = { ownerSession: 's1', event: 'session.first-turn-complete' };
  const body = Intents['hook/add'].body;
  // neither
  assert.equal(body.safeParse(base).success, false);
  // both
  assert.equal(body.safeParse({ ...base, flowId: 'f', promptTemplate: 't' }).success, false);
  // exactly one (each)
  assert.ok(body.safeParse({ ...base, flowId: 'f' }).success);
  assert.ok(body.safeParse({ ...base, promptTemplate: 't' }).success);
});

test('C15: flow-schedule/add enforces one action AND one timing', () => {
  const body = Intents['flow-schedule/add'].body;
  const target = { kind: 'prompt-existing', sessionId: 's1', prompt: 'p' };
  // valid action, no timing
  assert.equal(body.safeParse({ flowId: 'f' }).success, false);
  // valid timing, no action
  assert.equal(body.safeParse({ interval: '5m' }).success, false);
  // both actions set
  assert.equal(body.safeParse({ flowId: 'f', target, interval: '5m' }).success, false);
  // both timings set
  assert.equal(body.safeParse({ flowId: 'f', interval: '5m', at: 1 }).success, false);
  // one action + one timing (flowId form and target form)
  assert.ok(body.safeParse({ flowId: 'f', interval: '5m' }).success);
  assert.ok(body.safeParse({ target, cron: '0 * * * *' }).success);
});

// ───────────────────────────────────────────────────────────────────────────
// D. Basename / url constraints
// ───────────────────────────────────────────────────────────────────────────

const validFlow = {
  id: 'welcome-flow',
  action: { kind: 'prompt-existing', sessionId: 's1', prompt: 'hi' },
};

test('D16: flow/add rejects unsafe ids and accepts a safe basename', () => {
  const body = Intents['flow/add'].body;
  for (const id of ['../evil', 'a/b', '.hidden', '', 'a..b']) {
    assert.equal(body.safeParse({ ...validFlow, id }).success, false, `id ${JSON.stringify(id)} must be rejected`);
  }
  assert.ok(body.safeParse(validFlow).success);
  // flow/remove shares the same SafeBasename.
  assert.equal(Intents['flow/remove'].body.safeParse({ id: '../evil' }).success, false);
  assert.ok(Intents['flow/remove'].body.safeParse({ id: 'welcome-flow' }).success);
});

test('D17: flow/write-gate rejects unsafe name / empty script, accepts a safe basename', () => {
  const body = Intents['flow/write-gate'].body;
  assert.equal(body.safeParse({ name: '../x', script: '#!/bin/sh\nexit 0' }).success, false);
  assert.equal(body.safeParse({ name: 'gate.sh', script: '' }).success, false, 'empty gate script is meaningless');
  assert.ok(body.safeParse({ name: 'gate.sh', script: '#!/bin/sh\nexit 0' }).success);
});

test('D18: push/subscribe endpoint must be a valid https url', () => {
  for (const endpoint of ['not-a-url', 'file:///etc/passwd', 'http://push.example/x']) {
    assert.equal(PushSubscriptionJson.safeParse({ endpoint }).success, false, `${endpoint} must be rejected`);
  }
  assert.ok(PushSubscriptionJson.safeParse({ endpoint: 'https://push.example/x' }).success);
  // The body schema (as the live server parses it) tightens too.
  const body = Intents['push/subscribe'].body;
  assert.equal(body.safeParse({ subscription: { endpoint: 'file:///etc/passwd' } }).success, false);
  assert.ok(body.safeParse({ subscription: { endpoint: 'https://push.example/x' } }).success);
});

// ───────────────────────────────────────────────────────────────────────────
// E. Union & parity (cheap regression guards)
// ───────────────────────────────────────────────────────────────────────────

test('E19: every ServerEvent variant parses a representative sample', () => {
  const chatMsg = { id: 'm1', role: 'user', content: 'hi', timestamp: 1 };
  const page = { sessionId: 's1', messages: [chatMsg], hasMore: false };
  const samples: Record<string, unknown> = {
    snapshot: { type: 'snapshot', agentStatus: 'up', models: [{ modelId: 'm', name: 'M' }], sessions: [minimalMeta] },
    'agent/status': { type: 'agent/status', status: 'up' },
    'session/added': { type: 'session/added', session: minimalMeta },
    'session/patch': { type: 'session/patch', sessionId: 's1', currentReasoningEffort: null },
    'session/removed': { type: 'session/removed', sessionId: 's1' },
    'session/history-page': { type: 'session/history-page', page },
    'session/reset': { type: 'session/reset', page },
    'msg/upsert': { type: 'msg/upsert', sessionId: 's1', message: chatMsg },
    'session/notify': { type: 'session/notify', sessionId: 's1', title: 't', attention: 'ready', body: 'b' },
  };
  for (const [type, sample] of Object.entries(samples)) {
    const res = ServerEvent.safeParse(sample);
    assert.ok(res.success, `ServerEvent ${type} should parse: ${res.success ? '' : JSON.stringify(res.error.issues)}`);
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

test('E20: representative Intents bodies + results parse', () => {
  const cases: Array<{ name: keyof typeof Intents; body: unknown; result: unknown }> = [
    { name: 'session/get', body: { sessionId: 's1' }, result: { meta: minimalMeta } },
    { name: 'session/new', body: { cwd: '/tmp', spawnedBy: 'review-master' }, result: { sessionId: 's1' } },
    { name: 'session/set-spawned-by', body: { sessionId: 's1', spawnedBy: 'review-master' }, result: { ok: true, spawnedBy: 'review-master' } },
    { name: 'push/subscribe', body: { subscription: { endpoint: 'https://push.example/x' } }, result: { ok: true } },
    { name: 'schedule/add', body: { sessionId: 's1', prompt: 'p', interval: '5m' }, result: { ok: true } },
    { name: 'hook/add', body: { ownerSession: 's1', event: 'session.first-turn-complete', promptTemplate: 't' }, result: { ok: true } },
    { name: 'flow/add', body: validFlow, result: { ok: true } },
    { name: 'flow-schedule/add', body: { flowId: 'welcome-flow', interval: '5m' }, result: { ok: true } },
  ];
  for (const c of cases) {
    const spec = Intents[c.name];
    assert.ok(spec.body.safeParse(c.body).success, `${String(c.name)} body should parse`);
    assert.ok(spec.result.safeParse(c.result).success, `${String(c.name)} result should parse`);
  }
});

test('E21: ChatMessage schema parses a deeply-nested (sub-agent) sample', () => {
  const nested = {
    id: 'm1',
    role: 'assistant',
    content: 'top',
    timestamp: 1,
    subtype: 'subagent',
    subagent: { name: 'explore', displayName: 'Explore', status: 'completed' },
    subMessages: [
      { id: 'm2', role: 'assistant', content: 'inner', timestamp: 2, toolCalls: [{ toolCallId: 't1', title: 'ran' }] },
    ],
  };
  assert.ok(ChatMessage.safeParse(nested).success);
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

// Compile-time parity lock (enforced by `tsc` build; tsx strips it at runtime):
// the hand-written `interface ChatMessage` must equal the schema's inferred type.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const _chatMessageParity: Equal<z.infer<typeof ChatMessage>, ChatMessage> = true;
void _chatMessageParity;
