import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotSession, SessionConfig } from '@github/copilot-sdk';
import { Intents } from '@cockpit/protocol';
import { Engine, boundedMap } from './engine.ts';
import { OfficialRuntime, type RuntimeClient } from './runtime.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Harness,
  type McpState,
  type NativeTask,
  type Rpc,
  activeState,
  deferred,
  event,
  fakeSession,
  finishReply,
  harness,
  nativeCalls,
  promptly,
  protectedWork,
  queued,
  schedule,
  serverChatEvents,
  task,
  visibleError,
} from '../test-support/engine-harness.ts';

const nativeBusyCases = [
  ['metadata.isProcessing', (s: ReturnType<typeof fakeSession>) => { s.state.processing = true; }],
  ['metadata.activity', (s: ReturnType<typeof fakeSession>) => { s.state.activeWork = true; }],
  ['background task', (s: ReturnType<typeof fakeSession>) => { s.state.tasks = [task()]; }],
  ['idle agent with native active work', (s: ReturnType<typeof fakeSession>) => {
    s.state.tasks = [task('idle')];
    s.state.activeWork = true;
  }],
  ['queued message', (s: ReturnType<typeof fakeSession>) => {
    s.state.queue.items = [queued('pending', 'native pending')];
  }],
  ['steering message', (s: ReturnType<typeof fakeSession>) => { s.state.queue.steeringMessages = ['native steer']; }],
] as const;
for (const [name, makeBusy] of nativeBusyCases) {
  test(`${name} protects an apparently idle session from native teardown`, async t => {
    const h = harness(t);
    const s = await h.load();
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
    makeBusy(s);
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.ok(s.rpc.metadata.isProcessing.mock.callCount() >= 2);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
  });
}

for (const action of ['unload', 'stop'] as const) {
  test(`native MCP pending connections prevent ${action} without a Cockpit mutation`, async t => {
    const h = harness(t);
    const s = await h.load();
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
    s.state.mcp.host!.pendingConnections = ['native-connector'];
    const teardown = () => action === 'unload' ? h.engine.unload(s.id) : h.engine[action]();
    await assert.rejects(teardown(), protectedWork);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal(s.listeners.size, 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
    s.state.mcp.host!.pendingConnections = [];
    await teardown();
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    if (action === 'stop') await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
    else {
      assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, undefined);
      assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    }
  });

  test(`${action} cannot use delayed native validation to overwrite a newer live turn`, async t => {
    const h = harness(t);
    const s = await h.load();
    const validating = deferred();
    const readback = deferred<McpState>();
    const staleIdleMcp = structuredClone(s.state.mcp);
    s.rpc.mcp.list.mock.mockImplementationOnce(() => {
      validating.resolve();
      return readback.promise;
    });
    const teardown = () => action === 'unload' ? h.engine.unload(s.id) : h.engine[action]();
    const rejected = assert.rejects(teardown(), protectedWork);
    await validating.promise;
    await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    s.state.processing = true;
    s.emit(event('assistant.turn_start', { turnId: 'new-live-turn' }));
    await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
    h.events.length = 0;
    readback.resolve(staleIdleMcp);
    await rejected;
    assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal(s.listeners.size, 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.status === 'idle'));
    assert.ok(!h.events.some(event => String(event.type) === 'session/notify'));
    s.state.processing = false;
    s.emit(event('session.idle', {}));
    await nextTurn();
    await teardown();
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  });
}

for (const action of ['stop'] as const) {
  for (const failure of ['busy', 'rpc-error'] as const) {
    test(`${action} validates the entire cohort before closing anything (${failure})`, async t => {
      const h = harness(t);
      const first = await h.load();
      const second = await h.load();
      if (failure === 'busy') second.state.processing = true;
      else second.rpc.metadata.isProcessing.mock.mockImplementation(async () => { throw new Error('processing unavailable'); });
      await assert.rejects(h.engine[action](), /protected|processing unavailable/);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      assert.equal(h.runtime.stop.mock.callCount(), 0);
      assert.equal(h.runtime.start.mock.callCount(), 0);
      if (failure === 'rpc-error') {
        await assert.rejects(h.engine.getMeta(second.id), /processing unavailable/);
        second.rpc.metadata.isProcessing.mock.mockImplementation(async () => ({ processing: false }));
      }
      for (const s of [first, second]) {
        assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
        assert.equal((await h.engine.getMeta(s.id))?.closing, false);
        assert.equal(s.listeners.size, 1);
      }
    });
  }
}

test('native validation failure waits for sibling RPCs before releasing the lifecycle gate', async t => {
  const h = harness(t);
  const s = await h.load();
  const pendingTasks = deferred<{ tasks: NativeTask[] }>();
  s.rpc.tasks.list.mock.mockImplementation(() => pendingTasks.promise);
  s.rpc.metadata.isProcessing.mock.mockImplementation(async () => { throw new Error('processing lookup failed'); });
  const stopped = assert.rejects(h.engine.stop(), /processing lookup failed/);
  await nextTurn();
  await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
  await assert.rejects(h.engine.prompt(s.id, 'must not cross validation'), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  pendingTasks.resolve({ tasks: [] });
  await stopped;
  s.rpc.metadata.isProcessing.mock.mockImplementation(async () => ({ processing: false }));
  assert.equal((await h.engine.getMeta(s.id))?.closing, false);
});

test('explicit stop/start closes handles and rereads native indexed metadata without a fallback cache', async t => {

  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  await h.engine.rename(id, 'confirmed local title');
  native.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'confirmed-model', name: 'Fixture', supportedReasoningEfforts: ['high'], supportedContextTiers: ['default', 'long_context'],
  }] }));
  await h.engine.setModel(id, 'confirmed-model', 'high', 'long_context');
  h.trace.length = 0;
  await h.engine.stop();
  await h.engine.start();
  assert.deepEqual(h.trace, [`close:${id}`, 'stop', 'start']);
  h.rows[0]!.summary = 'current indexed title';
  await h.engine.refreshList();
  const unloaded = (await h.engine.getMeta(id))!;
  assert.equal(unloaded.title, 'current indexed title');
  assert.equal('pinned' in unloaded, false);
  assert.equal(unloaded.currentModelId, undefined);
  assert.equal(unloaded.loaded, false);
  assert.equal(activeState(h, id), undefined);
  assert.equal(native.listeners.size, 0);
  await h.engine.reload(id);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(id))?.title, 'confirmed local title');
  assert.equal((await h.engine.getMeta(id))?.currentModelId, 'confirmed-model');
});

for (const stage of ['start', 'models'] as const) {
  test(`fatal startup during ${stage} stays restarting and cannot restart the same engine`, async t => {
    const h = harness(t);
    const fatal = new Error(`fatal startup ${stage}`);
    const reported: Error[] = [];
    const off = h.engine.onFatal((error: Error) => reported.push(error));
    t.after(off);
    h.runtime[stage].mock.mockImplementationOnce(async () => {
      h.runtime.emitFatal(fatal);
      throw fatal;
    });
    if (stage === 'start') await assert.rejects(h.engine.start(), /fatal startup/);
    else {
      await h.engine.start();
      await assert.rejects(h.engine.snapshot(), /fatal startup/);
    }
    assert.equal(h.engine.failure, fatal);
    assert.deepEqual(reported, [fatal]);
    await assert.rejects(h.engine.snapshot(), /fatal startup/);
    assert.equal(h.events.filter(event => event.type === 'agent/status').at(-1)?.status, 'failed');
    await assert.rejects(h.engine.start(), /fatal startup/);
    await assert.rejects(h.engine.newSession(h.cwd), /fatal startup/);
    assert.equal(h.runtime.start.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    await h.engine.stop();
    await assert.rejects(h.engine.start(), /fatal startup/);
    const listsAfterStop = h.runtime.listSessions.mock.callCount();
    t.mock.timers.tick(8000);
    await nextTurn();
    assert.equal(h.runtime.listSessions.mock.callCount(), listsAfterStop);
    assert.equal(h.runtime.start.mock.callCount(), 1, 'fatal recovery requires a new runtime and engine');
  });
}

test('idle and completed background tasks do not prevent a clean stop', async t => {
  const h = harness(t);
  const a = await h.load();
  const b = await h.load();
  a.state.tasks = [task('completed'), { ...task('failed'), id: 'failed-id' },
    { ...task('cancelled'), id: 'cancelled-id' }, { ...task('idle'), id: 'idle-id' }];
  a.rpc.metadata.activity.mock.mockImplementation(async () => ({ hasActiveWork: false, abortable: true }));
  await h.engine.stop();
  assert.equal(h.runtime.closeSession.mock.callCount(), 2);
  assert.equal(h.runtime.stop.mock.callCount(), 1);
  await assert.rejects(h.engine.getMeta(a.id), errorWithCode('SESSION_TRANSITION'));
  await assert.rejects(h.engine.getMeta(b.id), errorWithCode('SESSION_TRANSITION'));
});

for (const action of ['create', 'resume'] as const) {
  for (const protectedCohort of [false, true]) {
  test(`capacity-like ${action} failure does not retry or touch ${protectedCohort ? 'busy' : 'idle'} peers`, async t => {
    const h = harness(t);
    const a = await h.load();
    const b = await h.load();
    b.state.processing = protectedCohort;
    const incoming = await h.seed();
    const resumes = h.runtime.resumeSession.mock.callCount();
    const peerCounters = [nativeCalls(a), nativeCalls(b)];
    const error = new Error('Runtime session capacity reached; safely recycle idle sessions first');
    h.runtime[action === 'create' ? 'createSession' : 'resumeSession'].mock.mockImplementationOnce(async () => { throw error; });
    h.trace.length = 0;
    await assert.rejects(action === 'create' ? h.engine.newSession(h.cwd) : h.engine.reload(incoming.id), /capacity/);
    assert.equal(h.runtime.createSession.mock.callCount(), action === 'create' ? 1 : 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes + (action === 'resume' ? 1 : 0));
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.deepEqual(h.trace, []);
    assert.deepEqual([nativeCalls(a), nativeCalls(b)], peerCounters);
    assert.equal((await h.engine.getMeta(a.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(b.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(incoming.id))?.loaded, false);
    assert.equal(h.runtime.liveCount, 2);
  });
  }
}

test('unload forgets live metadata and later resume reads native settings again', async t => {

  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, 'new native title');
  await h.engine.setModel(s.id, 'new native model');
  await h.engine.unload(s.id);
  h.rows[0]!.summary = 'indexed title changed elsewhere';
  await h.engine.refreshList();
  const after = (await h.engine.getMeta(s.id))!;
  assert.equal(after.title, 'indexed title changed elsewhere');
  assert.equal(after.currentModelId, undefined);
  assert.equal(after.cwd, h.cwd);
  assert.equal(activeState(h, s.id), undefined);
  await h.engine.reload(s.id);
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'new native model');
});

for (const action of ['stop'] as const) {
  test(`${action} never stops the runtime after a close failure and retains its handles`, async t => {
    const h = harness(t);
    const a = await h.load();
    const b = await h.load();
    h.runtime.closeSession.mock.mockImplementation(async () => { throw new Error('close not acknowledged'); });
    await assert.rejects(h.engine[action](), /close not acknowledged/);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.equal(h.attached.size, 2);
    for (const s of [a, b]) {
      assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
      assert.equal((await h.engine.getMeta(s.id))?.closing, false);
      assert.equal(s.listeners.size, 1);
    }
  });
}

test('explicit reload blocks unload, cancel, and stop until resume completes', async t => {
  const h = harness(t);
  const s = await h.seed();
  const opened = deferred<CopilotSession>();
  h.runtime.resumeSession.mock.mockImplementation(async (id, config) => {
    if (config.onEvent) s.sdk.on(config.onEvent);
    const sdk = await opened.promise;
    h.configs.set(id, config);
    h.attached.add(id);
    return sdk;
  });
  const loading = h.engine.reload(s.id);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loading, true);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
    await assert.rejects(async () => operation(), protectedWork);
  }
  opened.resolve(s.sdk as unknown as CopilotSession);
  await loading;
  assert.equal((await h.engine.getMeta(s.id))?.loading, false);
  assert.equal(s.sdk.on.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('in-flight model operations protect otherwise idle sessions until native switch acknowledgement settles', async t => {

  const h = harness(t);
  const s = await h.load();
  const readback = deferred<Awaited<ReturnType<Rpc['model']['switchTo']>>>();
  s.rpc.model.switchTo.mock.mockImplementation(() => readback.promise);
  const changing = h.engine.setModel(s.id, 'next-model');
  await nextTurn();
  assert.ok((await h.engine.getMeta(s.id))!.activeOperations! > 0);
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  s.state.model.modelId = 'confirmed-next-model';
  readback.resolve(structuredClone(s.state.model));
  await changing;
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'confirmed-next-model');
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  await h.engine.unload(s.id);
});

test('manual compaction protects the session until the RPC settles and clears its progress flag on rejection', async t => {
  const h = harness(t);
  const s = await h.load();
  const compact = deferred<Awaited<ReturnType<Rpc['history']['compact']>>>();
  s.rpc.history.compact.mock.mockImplementation(() => compact.promise);
  const outcome = assert.rejects(h.engine.compact(s.id, 'retain decisions'), /compaction refused/);
  await nextTurn();
  assert.ok((await h.engine.getMeta(s.id))!.activeOperations! > 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await assert.rejects(h.engine.stop(), protectedWork);
  compact.reject(new Error('compaction refused'));
  await outcome;
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.deepEqual(s.rpc.history.compact.mock.calls[0]!.arguments, [{ customInstructions: 'retain decisions' }]);
  visibleError(h, s.id, /compaction refused/);
  await h.engine.unload(s.id);
});

test('structured unsuccessful compaction retains its result without fabricating a history reset or retaining progress', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.compact.mock.mockImplementation(async () => ({ success: false, tokensRemoved: 0, messagesRemoved: 0 }));
  h.events.length = 0;
  assert.deepEqual(await h.engine.compact(s.id, 'retain decisions'), { success: false, tokensRemoved: 0, messagesRemoved: 0 });
  assert.deepEqual(s.rpc.history.compact.mock.calls[0]!.arguments, [{ customInstructions: 'retain decisions' }]);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(serverChatEvents(h).length, 0);
  assert.ok(!h.events.some(event => event.type === 'chat/invalidated'));
  assert.equal(s.sdk.send.mock.callCount(), 0);
  await h.engine.unload(s.id);
});

test('closing blocks new operations and competing transitions until close is acknowledged', async t => {
  const h = harness(t);
  const s = await h.load();
  const close = deferred();
  h.runtime.closeSession.mock.mockImplementation(async sdk => { await close.promise; h.attached.delete(sdk.sessionId); });
  const unloading = h.engine.unload(s.id);
  await nextTurn();
  await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
  for (const operation of [
    () => h.engine.prompt(s.id, 'not sent'), () => h.engine.reload(s.id), () => h.engine.deleteSession(s.id),
    () => h.engine.cancel(s.id), () => h.engine.stop(),
  ]) await assert.rejects(async () => operation(), protectedWork);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
  close.resolve();
  await unloading;
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(s.id))?.closing, undefined);
});
test('stopped engines reject new session work until an explicit start', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.stop();
  await assert.rejects(h.engine.prompt(s.id, 'must not be accepted'), errorWithCode('ENGINE_STOPPED'));
  await assert.rejects(h.engine.newSession(h.cwd), errorWithCode('ENGINE_STOPPED'));
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  await h.engine.start();
  await h.engine.reload(s.id);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
  await h.engine.stop();
});

test('passive metadata follows native index removal and return without retaining unloaded rows', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, 'just renamed');
  const metadata = h.rows[0]!;
  await h.engine.unload(s.id);
  h.rows.length = 0;
  await h.engine.refreshList();
  assert.equal((await h.engine.getMeta(s.id)), null);
  assert.equal(activeState(h, s.id), undefined);
  metadata.summary = 'native index returned';
  h.rows.push(metadata);
  assert.equal((await h.engine.getMeta(s.id))?.title, 'native index returned');
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('legacy preferences remain untouched and cannot hide or decorate native sessions', async t => {
  const h = harness(t, { prefs: {
    trashed: { legacy: { at: '2026-09-01', reason: 'old soft deletion' } },
    trashedMeta: { legacy: { title: 'obsolete' } },
    pinnedSessions: ['legacy'],
    inbox: { revision: 1, counter: 1, sessions: {
      legacy: { attention: 'ready', attnId: 1, seenId: 0, eventId: 'legacy-reply' },
    } },
    workerMetadata: { legacy: { opaque: true } },
  } });
  const original = readFileSync(h.prefsFile, 'utf8');
  await h.seed('legacy');
  const meta = (await h.engine.getMeta('legacy'))!;
  assert.equal(meta.loaded, false);
  assert.equal(meta.title, 'indexed title');
  assert.equal('pinned' in meta, false);
  assert.equal('attention' in meta, false);
  assert.equal((await h.engine.listLive()).some(row => row.sessionId === 'legacy'), true);
  assert.equal(activeState(h, 'legacy'), undefined);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), original);
  assert.deepEqual(h.prefs().workerMetadata, { legacy: { opaque: true } });
  for (const retired of ['listTrash', 'restoreSession', 'purgeSession']) assert.equal(retired in h.engine, false);
});

test('unloaded metadata comes from native persistence rather than the previous live title', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, 'just renamed');
  const metadata = h.rows[0]!;
  h.runtime.getSessionMetadata.mock.mockImplementation(async () => metadata);
  h.rows.length = 0;
  await h.engine.unload(s.id);
  assert.equal((await h.engine.getMeta(s.id))?.title, metadata.summary);
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('native todo changes update progress without opening the plan panel', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [
    { id: 'one', title: 'Completed work', status: 'done' },
    { id: 'two', title: 'Native current work', status: 'in_progress' },
  ] }));
  s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id))?.todo, { done: 1, total: 2, intent: 'Native current work' });
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [] }));
  s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.todo, null);
});

test('a completely rolled-back file rewind does not claim a lasting mutation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.rewind.mock.mockImplementation(async () => ({
    outcome: 'files-rolled-back', restoredFiles: ['restored-then-reverted.txt'],
    skippedFiles: [], error: 'Restore failed; workspace restored to pre-rewind state',
  }));
  assert.equal((await h.engine.rewind(s.id, 'boundary', true)).outcome, 'files-rolled-back');
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal(h.events.filter(event => event.type === 'chat/invalidated').length, 0);
});

test('session creation and resume delegate discovery and selection entirely to Copilot', async t => {
  const legacy = { mcpDefaultOn: [], mcpBySession: { existing: ['other'] },
    skillsDisabledBySession: { existing: ['fixture'] }, skillsAllowlistBySession: { existing: [] } };
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', tools: ['*'] } }, prefs: legacy });
  h.userSettings.settings.disabledSkills!.value = ['native-disabled'];
  const s = await h.load();
  const created = await h.engine.newSession(h.cwd);
  for (const id of [s.id, created]) {
    const config = h.configs.get(id)!;
    assert.equal(config.enableConfigDiscovery, true);
    for (const key of ['mcpServers', 'disabledMcpServers']) assert.equal(Object.hasOwn(config, key), false);
    assert.deepEqual(config.disabledSkills, ['native-disabled']);
  }
  assert.deepEqual(h.prefs(), legacy, 'retired choices remain inert rather than being rewritten or replayed');
  assert.equal(s.rpc.skills.disable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.disable.mock.callCount(), 0);
  h.userSettings.settings.disabledSkills!.value = ['changed-natively'];
  await h.engine.unload(s.id);
  await h.engine.reload(s.id);
  assert.deepEqual(h.configs.get(s.id)!.disabledSkills, ['changed-natively'], 'cold resume reads current native global choices');
  assert.deepEqual(h.prefs(), legacy);
});

test('session allocation refuses unreadable native skill defaults rather than enabling everything', async t => {
  const h = harness(t);
  const s = await h.seed();
  h.runtime.rpc.user.settings.get.mock.mockImplementation(async () => { throw new Error('native skill settings unavailable'); });
  await assert.rejects(h.engine.reload(s.id), /native skill settings unavailable/);
  await assert.rejects(h.engine.newSession(h.cwd), /native skill settings unavailable/);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

for (const loaded of [false, true]) {
  test(`confirmed native deletion ignores retired schedule counts and ${loaded ? 'checks and closes live work' : 'does not load paused schedules'}`, async t => {
    const h = harness(t, { prefs: { scheduledSessions: { 'legacy-scheduled': 999 } } });
    const s = await h.seed('legacy-scheduled');
    s.state.schedules = [schedule(78)];
    if (loaded) await h.engine.reload(s.id);
    const reads = s.rpc.schedule.list.mock.callCount();
    const resumes = h.runtime.resumeSession.mock.callCount();
    if (loaded) {
      s.state.activeWork = true;
      await assert.rejects(h.engine.deleteSession(s.id), protectedWork);
      assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
      s.state.activeWork = false;
    }
    await h.engine.deleteSession(s.id);
    assert.equal((await h.engine.getMeta(s.id)), null);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), loaded ? 1 : 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(s.rpc.schedule.list.mock.callCount(), reads, 'teardown checks work, not future timers');
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.deepEqual(h.prefs().scheduledSessions, { 'legacy-scheduled': 999 });
  });
}

test('native deletion retains idle guards without an extra confirmation or modifying external preferences', async t => {
  const h = harness(t, { prefs: { preserved: 'external capability data' } });
  const original = readFileSync(h.prefsFile, 'utf8');
  const s = await h.load();
  await finishReply(s, '可删除的测试回复', 'delete');
  assert.equal(Intents['session/delete'].body.safeParse({ sessionId: s.id }).success, true);
  s.state.processing = true;
  await assert.rejects(h.engine.deleteSession(s.id), protectedWork);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  await finishReply(s, '工作完成，可以删除', 'delete-after-work');
  h.runtime.closeSession.mock.mockImplementationOnce(async () => { throw new Error('close failed'); });
  await assert.rejects(h.engine.deleteSession(s.id), /close failed/);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  h.runtime.deleteSession.mock.mockImplementationOnce(async () => { throw new Error('native delete failed'); });
  await assert.rejects(h.engine.deleteSession(s.id), /native delete failed/);
  await h.engine.deleteSession(s.id);
  assert.equal((await h.engine.getMeta(s.id)), null);
  assert.equal(activeState(h, s.id), undefined);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), original);
  assert.ok(h.trace.indexOf(`close:${s.id}`) < h.trace.indexOf(`delete:${s.id}`));
  const removed = h.events.findLast(event => event.type === 'session/removed');
  assert.deepEqual(removed, { type: 'session/removed', sessionId: s.id });
  const deleting = await h.load();
  await h.engine.unload(deleting.id);
  const deletion = deferred();
  h.runtime.deleteSession.mock.mockImplementationOnce(() => deletion.promise);
  const removing = h.engine.deleteSession(deleting.id);
  await nextTurn();
  await assert.rejects(h.engine.stop(), protectedWork);
  deletion.resolve();
  await removing;
});
/** Engine over the real OfficialRuntime gates, delegating native calls to the harness fakes. */
function gatedEngine(h: Harness) {
  const fake = h.runtime;
  const runtime = new OfficialRuntime({
    clientFactory: () => ({
      start: async () => {},
      stop: async () => [],
      getStatus: async () => ({ version: '1.0.83', protocolVersion: 3 }),
      getAuthStatus: () => fake.getAuthStatus(),
      listSessions: () => fake.listSessions(),
      getSessionMetadata: (id: string) => fake.getSessionMetadata(id),
      createSession: (config: SessionConfig) => fake.createSession(config),
      resumeSession: (id: string, config: SessionConfig) => fake.resumeSession(id, config),
      deleteSession: (id: string) => fake.deleteSession(id),
      rpc: { ...fake.rpc, models: { list: async () => ({ models: [] }) }, sessions: {
        ...fake.rpc.sessions,
        open: async ({ sessionId }: { sessionId: string }) => ({ status: h.attached.has(sessionId) ? 'resumed' : 'not_found' }),
      } },
    }) as unknown as RuntimeClient,
  });
  return new Engine({ runtime });
}

test('a slow native resume does not block snapshot, list, status or login through the runtime gates', async t => {
  const h = harness(t);
  const engine = gatedEngine(h);
  await engine.start();
  const loaded = await engine.newSession(h.cwd);
  const slow = await h.seed();
  const held = deferred();
  h.runtime.resumeSession.mock.mockImplementationOnce(async (id: string, config: SessionConfig) => {
    await held.promise;
    h.attached.add(id);
    if (config.onEvent) h.natives.get(id)!.sdk.on(config.onEvent);
    return h.natives.get(id)!.sdk as unknown as CopilotSession;
  });
  const reloading = engine.reload(slow.id);
  await nextTurn();
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'the resume is in flight');
  const [snapshot, list, status, login] = await promptly(Promise.all([
    engine.snapshot(), engine.listLive(), engine.status(), engine.login(),
  ]));
  assert.equal(login, '');
  for (const rows of [snapshot.sessions, list, status]) {
    assert.deepEqual(rows.map(row => row.sessionId).sort(), [loaded, slow.id].sort());
    assert.equal(rows.find(row => row.sessionId === loaded)?.loaded, true);
  }
  assert.equal(status.find(row => row.sessionId === slow.id)?.loading, true);
  held.resolve();
  await reloading;
  assert.equal((await engine.getMeta(slow.id))?.loaded, true);
});

test('session reads run with bounded concurrency, keep index order and fail as one aggregate', async t => {
  const h = harness(t);
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) ids.push((await h.load(randomUUID())).id);
  let inFlight = 0;
  let maxInFlight = 0;
  const started: string[] = [];
  const failing = new Set<string>();
  h.runtime.isSessionLive.mock.mockImplementation(async (sdk: CopilotSession) => {
    started.push(sdk.sessionId);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    // Later sessions finish first, so ordering cannot come from completion order.
    for (let i = ids.length - ids.indexOf(sdk.sessionId); i > 0; i--) await nextTurn();
    inFlight--;
    if (failing.has(sdk.sessionId)) throw new Error(`native read failed: ${sdk.sessionId}`);
    return true;
  });
  const rows = await h.engine.status();
  assert.deepEqual(rows.map(row => row.sessionId), ids);
  assert.equal(maxInFlight, 4);
  assert.deepEqual(started, ids);
  started.length = 0;
  maxInFlight = 0;
  failing.add(ids[1]!);
  await assert.rejects(h.engine.listLive(), new RegExp(`native read failed: ${ids[1]}`));
  assert.equal(inFlight, 0, 'started sibling reads settle before the aggregate failure');
  assert.ok(started.length < ids.length, 'no new reads start after a failure');
  assert.ok(maxInFlight <= 4);
});

test('bounded map preserves input order and reports the first failure in input order', async () => {
  const order: number[] = [];
  assert.deepEqual(await boundedMap([3, 1, 2], 2, async n => { for (let i = 0; i < n; i++) await nextTurn(); order.push(n); return n * 10; }), [30, 10, 20]);
  assert.deepEqual(order, [1, 3, 2]);
  assert.deepEqual(await boundedMap([], 4, async () => 1), []);
  await assert.rejects(boundedMap([2, 1], 2, async n => {
    for (let i = 0; i < n; i++) await nextTurn();
    throw new Error(`failed ${n}`);
  }), /failed 2/);
});
