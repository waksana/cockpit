import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { mockHttp, type ReceivedRequest } from '../../test-support/mock-http.ts';

const requests: ReceivedRequest[] = [];
let reject = false;
let outcome: unknown = { ok: true };
mockHttp((response, request) => {
  requests.push(request);
  response.writeHead(reject ? 400 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reject ? { message: 'Unsupported native effort' } : outcome));
});
const { registerSettingsTools } = await import('./settings.ts');
const { registerFoundationTools } = await import('./foundation.ts');
const mcp = new McpServer({ name: 'settings-test', version: '1' });
const client = new Client({ name: 'settings-client', version: '1' });
registerSettingsTools(mcp);
registerFoundationTools(mcp);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverTransport);
await client.connect(clientTransport);
after(async () => { await client.close(); await mcp.close(); });
beforeEach(() => { requests.length = 0; reject = false; outcome = { ok: true }; });

const Reply = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
  isError: z.boolean().optional(),
});
async function json(name: string, args: Record<string, unknown>, expectedError = false) {
  const reply = Reply.parse(await client.callTool({ name, arguments: args }));
  assert.equal(reply.isError ?? false, expectedError, reply.content[0].text);
  return JSON.parse(reply.content[0].text);
}

test('model MCP preserves explicit invalid empty effort and never converts it into an omitted option', async () => {
  reject = true;
  const result = await client.callTool({ name: 'cockpit_set_model', arguments: {
    session_id: 'owned-fixture', model_id: 'native', reasoning_effort: '',
  } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(requests.at(-1)!.body.toString()).reasoningEffort, '');
});

for (const result of [
  { status: 'switched', modelId: 'native', deferred: false,
    modelState: { modelId: 'native', reasoningEffort: 'high', contextTier: 'long_context', future: 'retained' } },
  { status: 'queued', deferred: true, modelState: { modelId: 'previous' }, message: 'Queued until native work finishes' },
  { status: 'applied', deferred: true, modelState: { modelId: 'previous', reasoningEffort: 'low', contextTier: 'default' },
    message: 'Model changed to Native' },
  { status: 'confirmation_required', confirmation: { targetModelDisplayName: 'Native', currentTokens: 9000, targetLimit: 8000 } },
  { status: 'switched', modelId: 'native', persistenceError: 'Native configuration could not be saved',
    warning: 'Using session-only configuration', deprecationWarnings: ['Old option'], futureWarnings: ['Keep this too'] },
  { modelId: 'native', message: 'No application status was returned' },
  { status: 'future-native-status', modelId: 'native', message: 'Interpretation belongs to native' },
]) {
  test(`model MCP preserves ${result.status ?? 'absent status'}${result.deferred ? ' with deferred:true' : ''}${'persistenceError' in result ? ' with persistence failure' : ''} without follow-up reads`, async () => {
    outcome = { ok: true, result };
    assert.deepEqual(await json('cockpit_set_model', {
      session_id: 'owned-fixture', model_id: 'native', reasoning_effort: 'high', context_tier: 'long_context',
    }, 'persistenceError' in result), outcome);
    assert.equal(requests.length, 1, 'no preflight, verification read, retry or follow-up prompt');
    assert.equal(requests[0]!.url, '/intent/setModel');
    assert.deepEqual(JSON.parse(requests[0]!.body.toString()), {
      sessionId: 'owned-fixture', modelId: 'native', reasoningEffort: 'high', contextTier: 'long_context',
    });
  });
}

test('model MCP treats input as a full native combination without filling omitted options from cached state', async () => {
  outcome = { ok: true, result: {} };
  await json('cockpit_set_model', {
    session_id: 'owned-fixture', model_id: 'native', reasoning_effort: 'high', context_tier: 'long_context',
  });
  await json('cockpit_set_model', { session_id: 'owned-fixture', model_id: 'another' });
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1]!.body.toString()), { sessionId: 'owned-fixture', modelId: 'another' });
  const model = (await client.listTools()).tools.find(tool => tool.name === 'cockpit_set_model')!;
  assert.match(model.description!, /intended complete model configuration/);
  assert.match(model.description!, /not promised to preserve current settings/);
  assert.match(model.description!, /deferred:true takes precedence over an applied status or message/);
  for (const option of ['reasoning_effort', 'context_tier']) {
    const description = z.object({ description: z.string() }).parse(model.inputSchema.properties?.[option]).description;
    assert.match(description, /native semantics/);
    assert.doesNotMatch(description, /native defaults/);
  }
});

for (const operation of [
  { name: 'setModel', tool: 'cockpit_set_model', args: { session_id: 'owned-fixture', model_id: 'native' } },
  { name: 'setMode', tool: 'cockpit_set_mode', args: { session_id: 'owned-fixture', mode: 'plan' } },
  { name: 'session/compact', tool: 'cockpit_compact_session', args: { session_id: 'owned-fixture' } },
  { name: 'session/rewind', tool: 'cockpit_rewind_session', args: { session_id: 'owned-fixture', to_msg_id: 'message' } },
]) {
  test(`semantic and generic ${operation.name} reject an acknowledgement missing its native result`, async () => {
    outcome = { ok: true };
    const semantic = Reply.parse(await client.callTool({ name: operation.tool, arguments: operation.args }));
    assert.equal(semantic.isError, true);
    assert.match(semantic.content[0].text, /result/);
    const body = JSON.parse(requests[0]!.body.toString());
    const generic = Reply.parse(await client.callTool({
      name: 'cockpit_call_intent', arguments: { name: operation.name, body },
    }));
    assert.equal(generic.isError, true);
    assert.match(generic.content[0].text, /result/);
    assert.equal(requests.length, 2, 'one dispatch per invocation, no retry after incompatible output');
  });
}

for (const result of [
  { status: 'applied', modelChanged: true, warning: 'Native model changed', deprecationWarnings: ['Old mode option'] },
  { status: 'confirmation_required', modelChanged: false,
    confirmation: { targetModelDisplayName: 'Native', currentTokens: 9000, targetLimit: 8000 } },
  { status: 'deferred', modelChanged: false, deferImplementation: true, armInteractiveContinuation: true,
    message: 'Native follow-up decision', futureNativeField: { keep: true } },
  { status: 'future-native-status', modelChanged: false },
]) {
  test(`mode MCP preserves ${result.status} without inventing application or sending a prompt`, async () => {
    outcome = { ok: true, result };
    assert.deepEqual(await json('cockpit_set_mode', { session_id: 'owned-fixture', mode: 'plan' }), outcome);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, '/intent/setMode');
    assert.deepEqual(JSON.parse(requests[0]!.body.toString()), { sessionId: 'owned-fixture', mode: 'plan' });
  });
}

test('compact preserves native success/details with no confirmation gate or outbound compatibility field', async () => {
  const { tools } = await client.listTools();
  const compact = tools.find(tool => tool.name === 'cockpit_compact_session')!;
  assert.match(compact.description!, /model-facing context, not the retained chat event history/);
  assert.doesNotMatch(compact.description!, /rewrites history/);
  assert.ok(!compact.inputSchema.required?.includes('confirm'));
  for (const confirm of [undefined, false, true]) {
    for (const success of [true, false]) {
      outcome = { ok: true, result: {
        success, tokensRemoved: 321, messagesRemoved: 4, summaryContent: 'Preserved constraints',
        contextWindow: { tokenLimit: 10000, currentTokens: 900, messagesLength: 6 }, future: 'native detail',
      } };
      assert.deepEqual(await json(compact.name, {
        session_id: 'owned-fixture', custom_instructions: '', ...(confirm === undefined ? {} : { confirm }),
      }, !success), outcome);
    }
  }
  assert.equal(requests.length, 6);
  for (const request of requests) {
    assert.equal(request.url, '/intent/session/compact');
    assert.deepEqual(JSON.parse(request.body.toString()), { sessionId: 'owned-fixture', customInstructions: '' });
  }
});

test('rewind preserves partial native effects and errors without a confirmation gate', async () => {
  outcome = { ok: true, result: {
    outcome: 'partial', eventsRemoved: 2, restoredFiles: ['/fixture/restored'],
    skippedFiles: [{ path: '/fixture/changed', reason: 'Native conflict', future: true }],
    error: 'One file could not be restored',
  } };
  for (const confirm of [undefined, false, true]) {
    assert.deepEqual(await json('cockpit_rewind_session', {
      session_id: 'owned-fixture', to_msg_id: 'message', rollback_files: true,
      ...(confirm === undefined ? {} : { confirm }),
    }, true), outcome);
  }
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, '/intent/session/rewind');
    assert.deepEqual(JSON.parse(request.body.toString()), {
      sessionId: 'owned-fixture', toMsgId: 'message', rollbackFiles: true,
    });
  }
});

test('native mutation errors remain errors despite deprecated confirm values and are not retried', async () => {
  outcome = { ok: false, error: 'Native session is busy', code: 'SESSION_BUSY' };
  for (const confirm of [undefined, false, true]) {
    const reply = Reply.parse(await client.callTool({
      name: 'cockpit_compact_session',
      arguments: { session_id: 'owned-fixture', ...(confirm === undefined ? {} : { confirm }) },
    }));
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Native session is busy/);
    assert.match(reply.content[0].text, /SESSION_BUSY/);
  }
  assert.equal(requests.length, 3);
});

for (const operation of [
  {
    name: 'setModel', tool: 'cockpit_set_model', args: { session_id: 'owned-fixture', model_id: 'native' },
    cases: [
      { result: { status: 'rejected', message: 'Native model selection was rejected' }, isError: true },
      { result: { status: 'applied', deferred: true, modelState: { modelId: 'previous' } }, isError: false },
      { result: { status: 'rejected', deferred: true, modelState: { modelId: 'previous' } }, isError: false },
      { result: { status: 'applied', persistenceError: 'Native persistence failed after application',
        modelState: { modelId: 'native' } }, isError: true },
      { result: { status: 'confirmation_required',
        confirmation: { targetModelDisplayName: 'Native', currentTokens: 9000, targetLimit: 8000 } }, isError: false },
      { result: { status: 'future-native-status', message: 'Unknown is not success or failure' }, isError: false },
      { result: { modelId: 'native' }, isError: false },
    ],
  },
  {
    name: 'setMode', tool: 'cockpit_set_mode', args: { session_id: 'owned-fixture', mode: 'plan' },
    cases: [
      { result: { status: 'rejected', modelChanged: false }, isError: true },
      { result: { status: 'confirmation_required', modelChanged: false,
        confirmation: { targetModelDisplayName: 'Native', currentTokens: 9000, targetLimit: 8000 } }, isError: false },
      { result: { status: 'applied', modelChanged: false, deferImplementation: true,
        armInteractiveContinuation: true, message: 'Native continuation requires action' }, isError: false },
      { result: { status: 'future-native-status', modelChanged: false }, isError: false },
    ],
  },
  {
    name: 'session/compact', tool: 'cockpit_compact_session', args: { session_id: 'owned-fixture' },
    cases: [
      { result: { success: false, tokensRemoved: 0, messagesRemoved: 0, summaryContent: 'Native failure detail' }, isError: true },
      { result: { success: true, tokensRemoved: 321, messagesRemoved: 4 }, isError: false },
    ],
  },
  {
    name: 'session/rewind', tool: 'cockpit_rewind_session', args: { session_id: 'owned-fixture', to_msg_id: 'message' },
    cases: [
      { result: { outcome: 'failed', restoredFiles: [], skippedFiles: [], error: 'Native rewind failed' }, isError: true },
      { result: { outcome: 'session-busy', restoredFiles: [], skippedFiles: [] }, isError: true },
      { result: { outcome: 'truncation-failed', restoredFiles: ['/fixture/restored'], skippedFiles: [] }, isError: true },
      { result: { outcome: 'rollback-incomplete', restoredFiles: ['/fixture/restored'],
        skippedFiles: [{ path: '/fixture/changed', reason: 'Native conflict' }] }, isError: true },
      { result: { outcome: 'partial', eventsRemoved: 1, restoredFiles: ['/fixture/restored'],
        skippedFiles: [{ path: '/fixture/changed', reason: 'Native conflict' }], error: 'Partial native effect' }, isError: true },
      { result: { outcome: 'success', restoredFiles: [], skippedFiles: [] }, isError: false },
      { result: { outcome: 'future-native-outcome', restoredFiles: [], skippedFiles: [] }, isError: false },
    ],
  },
]) {
  for (const { result, isError } of operation.cases) {
    test(`semantic and generic ${operation.name} preserve native JSON with isError:${isError}: ${JSON.stringify(result)}`, async () => {
      outcome = { ok: true, result: { ...result, futureNativeField: { untouched: true } } };
      assert.deepEqual(await json(operation.tool, operation.args, isError), outcome);
      const body = JSON.parse(requests[0]!.body.toString());
      assert.deepEqual(await json('cockpit_call_intent', { name: operation.name, body }, isError), outcome);
      assert.deepEqual(requests.map(request => request.url), [`/intent/${operation.name}`, `/intent/${operation.name}`]);
      assert.equal(requests.length, 2, 'one call per tool with no extra read, retry or follow-up prompt');
      assert.deepEqual(JSON.parse(requests[1]!.body.toString()), body);
    });
  }
}
