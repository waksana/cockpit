import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CopilotSession, SessionEvent, ToolInvocation } from '@github/copilot-sdk';
import { CONTEXT_RESET_TOOL, createContextReset } from './context-reset.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'context-reset-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.txt');
  await writeFile(file, 'Synthetic continuing goal. No completed side effects to replay.');
  let clears = 0;
  let denied = false;
  let current: CopilotSession | null;
  const queue = { items: [] as unknown[], steeringMessages: [] as unknown[], inFlightSteeringCount: 0 };
  const tasks = { tasks: [] as { status: string }[] };
  const schedules = { entries: [] as unknown[] };
  const metadata = { isRemote: false };
  const permissions = { items: [] as unknown[] };
  let onRead = () => {};
  let onClear = async () => {};
  const session = {
    sessionId: 'self',
    rpc: {
      queue: { pendingItems: async () => { onRead(); return queue; } },
      tasks: { list: async () => tasks },
      schedule: { list: async () => schedules },
      metadata: { snapshot: async () => metadata },
      permissions: { pendingRequests: async () => permissions },
      history: { clearContext: async () => { clears++; await onClear(); return { messagesCleared: 2 }; } },
    },
  } as unknown as CopilotSession;
  current = session;
  const reset = createContextReset({
    session: () => current,
    assertReady: () => { if (denied) throw new Error('Host has pending work'); },
  });
  const event = (value: object) => reset.observe(value as SessionEvent);
  const request = (id = 'call', extra = false, agentId?: string) => {
    event({ type: 'assistant.message', agentId, data: { toolRequests: [
      { name: CONTEXT_RESET_TOOL, toolCallId: id },
      ...(extra ? [{ name: 'view', toolCallId: 'sibling' }] : []),
    ] } });
    event({ type: 'tool.execution_start', agentId, data: { toolName: CONTEXT_RESET_TOOL, toolCallId: id } });
    event({ type: 'external_tool.requested', agentId, data: { toolName: CONTEXT_RESET_TOOL, toolCallId: id, sessionId: 'self', requestId: `request-${id}` } });
  };
  const invocation: ToolInvocation = { sessionId: 'self', toolCallId: 'call', toolName: CONTEXT_RESET_TOOL, arguments: {}, signal: new AbortController().signal };
  const args = { prompt: `Continue synthetic goal by reading ${file}. Do not replay completed actions.`, handoffFiles: [file] };
  const run = (input: unknown = args, call = invocation) => Promise.resolve(reset.tool.handler!(input, call));
  return {
    reset, event, request, invocation, args, file, dir, run, queue, tasks, schedules, metadata, permissions,
    get clears() { return clears; },
    deny() { denied = true; }, detach() { current = null; },
    onRead(fn: () => void) { onRead = fn; },
    onClear(fn: () => Promise<void>) { onClear = fn; },
  };
}

test('native terminal tool checks persisted files and binds only the main session single-tool batch', async t => {
  const f = await fixture(t);
  assert.equal(f.reset.tool.isTerminal, true);
  assert.equal(f.reset.tool.defer, 'never');
  await assert.rejects(f.run(), /only tool call/);
  f.request('call', true);
  await assert.rejects(f.run(), /only tool call/);
  f.request('child', false, 'child-agent');
  await assert.rejects(f.run(f.args, { ...f.invocation, toolCallId: 'child' }), /only tool call/);
  f.request();
  await assert.rejects(f.run(f.args, { ...f.invocation, sessionId: 'another' }), /bound main session/);
  assert.equal(f.clears, 0);
  assert.equal((await f.run() as { resultType: string }).resultType, 'success');
  assert.equal(f.clears, 1);
  assert.equal(f.reset.busy, true, 'Keep admission closed until native tool completion');
  f.event({ type: 'tool.execution_complete', data: { toolCallId: 'call' } });
  assert.equal(f.reset.busy, false);
  f.event({ type: 'user.message', data: { content: '', transformedContent: 'native seed' } });
  f.request('again');
  await assert.rejects(f.run(f.args, { ...f.invocation, toolCallId: 'again' }), /already attempted/);
  f.event({ type: 'user.message', data: { content: 'A new explicitly requested clear' } });
  assert.equal((await f.run(f.args, { ...f.invocation, toolCallId: 'again' }) as { resultType: string }).resultType, 'success');
});

test('invalid input, missing/empty files and directories never call clear', async t => {
  const f = await fixture(t);
  f.request();
  for (const input of [null, {}, { ...f.args, prompt: ' ' }, { ...f.args, sessionId: 'other' },
    { ...f.args, handoffFiles: [] }, { ...f.args, handoffFiles: ['relative'] }]) {
    await assert.rejects(f.run(input), /Provide/);
  }
  await assert.rejects(f.run({ ...f.args, handoffFiles: [join(f.dir, 'missing')] }), /ENOENT/);
  await assert.rejects(f.run({ ...f.args, handoffFiles: [f.dir] }), /regular file/);
  await writeFile(f.file, '');
  await assert.rejects(f.run(), /non-empty/);
  assert.equal(f.clears, 0);
  assert.equal(f.reset.busy, false);
});

test('pending native work, schedules, remote sessions and host decisions reject without mutation', async t => {
  for (const conflict of ['queue', 'steering', 'steering-in-flight', 'task', 'schedule', 'permission', 'remote', 'compaction', 'host']) {
    await t.test(conflict, async t => {
      const f = await fixture(t);
      f.request();
      switch (conflict) {
        case 'queue': f.queue.items.push({}); break;
        case 'steering': f.queue.steeringMessages.push({}); break;
        case 'steering-in-flight': f.queue.inFlightSteeringCount = 1; break;
        case 'task': f.tasks.tasks.push({ status: 'running' }); break;
        case 'schedule': f.schedules.entries.push({}); break;
        case 'permission': f.permissions.items.push({}); break;
        case 'remote': f.metadata.isRemote = true; break;
        case 'compaction': f.event({ type: 'session.compaction_start', data: {} }); break;
        case 'host': f.deny(); break;
      }
      await assert.rejects(f.run());
      assert.equal(f.clears, 0);
      assert.equal(f.reset.busy, false);
    });
  }
});

test('concurrent calls, detach and native activity races cannot pass the preflight', async t => {
  const f = await fixture(t);
  f.request();
  f.onRead(() => f.event({ type: 'pending_messages.modified', data: {} }));
  const running = f.run();
  await assert.rejects(f.run(), /already attempted/);
  await assert.rejects(running, /state changed/);
  assert.equal(f.clears, 0);
  f.onRead(() => f.detach());
  await assert.rejects(f.run(), /state changed/);
  assert.equal(f.clears, 0);
});

test('RPC failure is uncertain and cannot be retried even after another prompt', async t => {
  const f = await fixture(t);
  f.request();
  f.onClear(async () => { throw new Error('Transport lost after submission'); });
  await assert.rejects(f.run(), /outcome is uncertain/);
  f.event({ type: 'session.idle', data: {} });
  f.event({ type: 'user.message', data: { content: 'Try again' } });
  f.request();
  await assert.rejects(f.run(), /already attempted/);
  assert.equal(f.clears, 1);
});
