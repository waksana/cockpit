import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Rpc,
  assertSameControlFacts,
  assistant,
  chat,
  deferred,
  event,
  harness,
  serverChatEvents,
  user,
  visibleError,
} from '../test-support/engine-harness.ts';

test('model, mode, and name success publish authoritative native read-back rather than requested values', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.getCurrent.mock.mockImplementation(async () => ({ modelId: 'normalized-model', reasoningEffort: 'low', contextTier: 'default' }));
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'alias', supportedReasoningEfforts: ['high'], billing: { token_prices: { long_context: {} } },
  }] }));
  assert.deepEqual(await h.engine.setModel(s.id, 'alias', 'high', 'long_context'), { modelId: 'alias' });
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[0]!.arguments, [{ modelId: 'alias', deferIfModelChangeQueued: true, reasoningEffort: 'high', contextTier: 'long_context' }]);
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'normalized-model');
  assert.equal((await h.engine.getMeta(s.id))?.currentReasoningEffort, 'low');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'default');
  s.rpc.mode.get.mock.mockImplementation(async () => 'interactive');
  s.rpc.mode.set.mock.mockImplementation(async () => {
    s.state.mode = 'interactive';
    return { status: 'applied', modelChanged: false };
  });
  await h.engine.setMode(s.id, 'plan');
  assert.equal((await h.engine.getMeta(s.id))?.currentMode, 'interactive');
  s.rpc.name.get.mock.mockImplementation(async () => ({ name: 'normalized title' }));
  assert.equal(await h.engine.rename(s.id, '  requested title  '), 'normalized title');
  assert.deepEqual(s.rpc.name.set.mock.calls[0]!.arguments, [{ name: 'requested title' }]);
  assert.equal((await h.engine.getMeta(s.id))?.title, 'normalized title');
});

test('identity exposes native name and user-named provenance without guessing', async t => {
  const h = harness(t);
  const s = await h.load();
  const identity = async () => {
    const meta = await h.engine.getMeta(s.id);
    return { title: meta?.title, nativeName: meta?.nativeName, nativeNameUserSet: meta?.nativeNameUserSet };
  };
  s.state.name = null;
  s.state.userNamed = false;
  assert.deepEqual(await identity(), { title: 'indexed title', nativeName: null, nativeNameUserSet: false });
  await s.rpc.name.setAuto({ summary: 'auto summary' });
  assert.deepEqual(await identity(), { title: 'auto summary', nativeName: 'auto summary', nativeNameUserSet: false });
  await h.engine.rename(s.id, 'explicit title');
  assert.deepEqual(await identity(), { title: 'explicit title', nativeName: 'explicit title', nativeNameUserSet: true });
  s.rpc.workspaces.getWorkspace.mock.mockImplementation(async () => ({ workspace: { id: s.id, name: 'raced title', user_named: false } }));
  assert.deepEqual(await identity(), { title: 'explicit title', nativeName: 'explicit title', nativeNameUserSet: undefined });
  s.rpc.workspaces.getWorkspace.mock.mockImplementation(async () => ({ workspace: { id: s.id, name: 'explicit title' } }));
  assert.equal((await identity()).nativeNameUserSet, undefined);
  s.rpc.workspaces.getWorkspace.mock.mockImplementation(async () => ({ workspace: null }));
  assert.equal((await identity()).nativeNameUserSet, undefined);
  s.rpc.workspaces.getWorkspace.mock.mockImplementation(async () => { throw new Error('workspace unavailable'); });
  assert.deepEqual(await identity(), { title: 'explicit title', nativeName: 'explicit title', nativeNameUserSet: undefined });
});

for (const cleared of [false, true]) {
  test(`native model-change events ${cleared ? 'clear nullable' : 'refresh selected'} effort and context tier`, async t => {
    const h = harness(t);
    const s = await h.load();
    const reasoningEffort = cleared ? null : 'high';
    const contextTier = cleared ? null : 'long_context';
    s.state.model = {
      modelId: 'event-selected-model',
      reasoningEffort: reasoningEffort ?? undefined, contextTier: contextTier ?? undefined,
    };
    h.events.length = 0;
    s.emit(event('session.model_change', {
      previousModel: 'native-model', newModel: 'event-selected-model', reasoningEffort, contextTier,
    }));
    await nextTurn();
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.currentModelId, 'event-selected-model');
    assert.equal(meta.currentReasoningEffort, reasoningEffort);
    assert.equal(meta.currentContextTier, contextTier);
    const summary = (await h.engine.snapshot()).sessions.find(session => session.sessionId === s.id)!;
    const { queue: _queue, availableModels: _models, todo: _todo, controls: _controls,
      nativeName: _name, nativeNameUserSet: _userSet, ...summaryMeta } = meta;
    assertSameControlFacts(summary, summaryMeta);
    assert.equal('nativeName' in summary, false, 'name provenance is read by full session/get only');
    assert.ok(h.events.some(event => event.type === 'session/invalidated' && event.sessionId === s.id));
    assert.equal(s.rpc.model.switchTo.mock.callCount(), 0);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('native mode-change events publish the public scalar mode without a local mode mutation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mode = 'plan';
  s.emit(event('session.mode_changed', { previousMode: 'interactive', newMode: 'plan' }));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.currentMode, 'plan');
  assert.equal((await h.engine.snapshot()).sessions.find(session => session.sessionId === s.id)?.currentMode, 'plan');
  assert.equal(s.rpc.mode.set.mock.callCount(), 0);
});

for (const mutated of [false, true]) {
  test(`structured rewind failure ${mutated ? 'invalidates a real partial mutation' : 'does not invent an invalidation'}`, async t => {
    const h = harness(t);
    const s = await h.seed();
    s.state.events = [user('keep'), assistant('drop-event', 'drop-message')];
    await h.engine.reload(s.id);
    s.rpc.history.rewind.mock.mockImplementation(async () => {
      if (mutated) s.state.events = [user('keep')];
      return {
        outcome: mutated ? 'checkpoint-cleanup-failed' : 'truncation-failed',
        restoredFiles: [], skippedFiles: [], ...(mutated ? { eventsRemoved: 1 } : {}),
        error: mutated ? 'checkpoint cleanup failed' : 'unknown event',
      };
    });
    const reads = s.rpc.eventLog.read.mock.callCount();
    assert.deepEqual(await h.engine.rewind(s.id, 'keep', true), {
      outcome: mutated ? 'checkpoint-cleanup-failed' : 'truncation-failed',
      restoredFiles: [], skippedFiles: [], ...(mutated ? { eventsRemoved: 1 } : {}),
      error: mutated ? 'checkpoint cleanup failed' : 'unknown event',
    });
    assert.deepEqual(s.rpc.history.rewind.mock.calls[0]!.arguments, [{ eventId: 'keep', mode: 'conversation-and-files' }]);
    const invalidations = h.events.filter(event => event.type === 'chat/invalidated');
    assert.deepEqual(invalidations, mutated ? [{ type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' }] : []);
    assert.equal(serverChatEvents(h).length, 0);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), reads, 'mutation never replays chat on the server');
    if (mutated) {
      assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['keep']);
    }
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  });
}

test('rewind with zero removed events and no restored files emits no chat invalidation', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rewind(s.id, 'already-at-target');
  assert.equal(h.events.filter(event => event.type === 'chat/invalidated').length, 0);
  assert.equal(serverChatEvents(h).length, 0);
  assert.deepEqual(s.rpc.history.rewind.mock.calls[0]!.arguments, [{ eventId: 'already-at-target', mode: 'conversation' }]);
});

test('incomplete file rollback is reported as a real partial mutation without inventing conversation truncation', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.events = [user('unchanged-conversation')];
  await h.engine.reload(s.id);
  s.rpc.history.rewind.mock.mockImplementation(async () => ({
    outcome: 'rollback-incomplete', restoredFiles: [join(h.cwd, 'native-restored-file')],
    skippedFiles: [], error: 'rollback could not restore one file',
  }));
  const reads = s.rpc.eventLog.read.mock.callCount();
  assert.deepEqual(await h.engine.rewind(s.id, 'unchanged-conversation', true), {
    outcome: 'rollback-incomplete', restoredFiles: [join(h.cwd, 'native-restored-file')],
    skippedFiles: [], error: 'rollback could not restore one file',
  });
  assert.deepEqual(h.events.filter(event => event.type === 'chat/invalidated'), [
    { type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' },
  ]);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), reads);
  assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['unchanged-conversation']);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
});

test('rewind RPC rejection leaves the native session attached and emits no chat invalidation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.rewind.mock.mockImplementation(async () => { throw new Error('rewind transport failed'); });
  await assert.rejects(h.engine.rewind(s.id, 'target'), /rewind transport failed/);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(h.events.filter(event => event.type === 'chat/invalidated').length, 0);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  visibleError(h, s.id, /rewind transport failed/);
});

test('successful rewind invalidates chat without replay; subsequent native reads see the truncation', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.events = [user('keep-user'), assistant('removed-event', 'removed-answer')];
  h.journals.set(s.id, [...s.state.events]);
  await h.engine.reload(s.id);
  const previous = await chat(h, s.id);
  assert.deepEqual(previous.events.map(event => event.id), ['keep-user', 'removed-event']);
  s.rpc.history.rewind.mock.mockImplementation(async () => {
    s.state.events = [user('keep-user')];
    h.journals.set(s.id, [...s.state.events]);
    return { outcome: 'success', eventsRemoved: 1, restoredFiles: [], skippedFiles: [] };
  });
  const reads = s.rpc.eventLog.read.mock.callCount();
  const persistedReads = h.runtime.rpc.sessions.readPersistedEvents.mock.callCount();
  await h.engine.rewind(s.id, 'removed-event');
  assert.deepEqual(h.events.filter(event => event.type === 'chat/invalidated'), [
    { type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' },
  ]);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), reads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), persistedReads);
  assert.equal((await chat(h, s.id, { cursor: previous.cursor })).cursorStatus, 'expired');
  assert.deepEqual((await chat(h, s.id)).events.map(event => event.id), ['keep-user']);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});
test('loaded sessions publish their native provider-qualified model inventory', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'local/native-model', name: 'Local model', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', billing: { token_prices: { long_context: {} } },
  }] }));
  await h.engine.reload(s.id);
  assert.deepEqual((await h.engine.getMeta(s.id))?.availableModels, [{
    modelId: 'local/native-model', name: 'Local model', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', supportsLongContext: true,
  }]);
});

test('thin native session models expose fresh capabilities and complete selections do not backfill omitted options', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{ id: 'native-model', name: 'Native' }] }));
  h.runtime.models.mock.mockImplementation(async () => [{
    modelId: 'native-model', name: 'Global', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low', supportsLongContext: true,
  }, { modelId: 'not-allowed', name: 'Not allowed' }]);
  s.state.model = { modelId: 'native-model' };
  const before = (await h.engine.getMeta(s.id))!;
  assert.equal(before.currentReasoningEffort, null);
  assert.equal(before.currentContextTier, null);
  assert.deepEqual(before.availableModels, [{
    modelId: 'native-model', name: 'Native', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low', supportsLongContext: true,
  }]);
  const catalogReads = h.runtime.models.mock.callCount();
  const snapshot = await h.engine.snapshot();
  assert.equal(h.runtime.models.mock.callCount() - catalogReads, 1, 'One catalog belongs to this snapshot request, not a retained cache');
  assert.equal(snapshot.sessions.find(row => row.sessionId === s.id)?.availableModels, undefined,
    'Summary snapshots do not request model option lists');
  const listReads = s.rpc.model.list.mock.callCount();
  const catalogsBeforeNarrowRead = h.runtime.models.mock.callCount();
  await h.engine.getResources(s.id, ['control']);
  assert.equal(s.rpc.model.list.mock.callCount(), listReads);
  assert.equal(h.runtime.models.mock.callCount(), catalogsBeforeNarrowRead);
  assert.deepEqual((await h.engine.getResources(s.id, ['models']))?.availableModels, before.availableModels);
  await h.engine.setModel(s.id, 'native-model', 'high', 'long_context');
  const after = (await h.engine.getMeta(s.id))!;
  assert.equal(after.currentReasoningEffort, 'high');
  assert.equal(after.currentContextTier, 'long_context');
  await h.engine.setModel(s.id, 'native-model', 'low');
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[1]!.arguments, [{
    modelId: 'native-model', deferIfModelChangeQueued: true, reasoningEffort: 'low',
  }]);
  await h.engine.setModel(s.id, 'native-model', undefined, 'default');
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[2]!.arguments, [{
    modelId: 'native-model', deferIfModelChangeQueued: true, contextTier: 'default',
  }]);
  s.state.model.contextTier = 'long_context';
  await assert.rejects(h.engine.setModel(s.id, 'native-model', 'invented'), errorWithCode('INVALID_REQUEST'));
  await assert.rejects(h.engine.setModel(s.id, 'not-allowed', undefined, 'long_context'), errorWithCode('INVALID_REQUEST'));
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 3);
  h.runtime.models.mock.mockImplementation(async () => [{
    modelId: 'native-model', name: 'Global', supportedReasoningEfforts: [], supportsLongContext: false,
  }]);
  const changed = (await h.engine.getMeta(s.id))!;
  assert.deepEqual(changed.availableModels?.[0]?.supportedReasoningEfforts, []);
  assert.equal(changed.availableModels?.[0]?.supportsLongContext, false);
  assert.equal(changed.currentContextTier, 'long_context', 'readback is not rewritten from capability changes');
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('a deferred model change leaves current options native-owned without a false readback failure', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'native-model', supportedReasoningEfforts: ['high'], supportsLongContext: true,
  }] }));
  s.rpc.model.switchTo.mock.mockImplementation(async () => ({ modelId: 'native-model', status: 'deferred', deferred: true }));
  await h.engine.setModel(s.id, 'native-model', 'high', 'long_context');
  const current = (await h.engine.getMeta(s.id))!;
  assert.equal(current.currentReasoningEffort, 'medium');
  assert.equal(current.currentContextTier, 'default');
});

test('provider context tiers without pricing drive both metadata and model-setting validation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'provider/model', supportedContextTiers: ['default', 'long_context'],
  }, { id: 'provider/basic', supportedContextTiers: ['default'] }] }));
  const meta = (await h.engine.getMeta(s.id))!;
  assert.equal(meta.availableModels?.find(row => row.modelId === 'provider/model')?.supportsLongContext, true);
  assert.equal(meta.availableModels?.find(row => row.modelId === 'provider/basic')?.supportsLongContext, false);
  await h.engine.setModel(s.id, 'provider/model', undefined, 'long_context');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'long_context');
  await assert.rejects(h.engine.setModel(s.id, 'provider/basic', undefined, 'long_context'), errorWithCode('INVALID_REQUEST'));
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('user model choices join the native FIFO even when the turn ended before queued changes drain', async t => {
  for (const status of ['queued', 'deferred'] as const) {
    await t.test(status, async t => {
      const h = harness(t);
      const s = await h.load();
      type Switch = Parameters<Rpc['model']['switchTo']>[0];
      const queue: Switch[] = [{ modelId: 'older-A' }];
      const apply = (options: Switch) => {
        s.state.model = { modelId: options.modelId, reasoningEffort: options.reasoningEffort, contextTier: options.contextTier };
      };
      // Public switchTo contract: without the opt-in an idle switch applies
      // immediately, allowing the already queued A to overwrite the newer B.
      s.rpc.model.switchTo.mock.mockImplementation(async options => {
        if (options.deferIfModelChangeQueued && queue.length) {
          queue.push(options);
          return { modelId: options.modelId, status, deferred: status === 'deferred' };
        }
        apply(options);
        return { modelId: options.modelId, status: 'applied' };
      });
      await h.engine.setModel(s.id, 'newer-B');
      assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-model', 'Accepted is not applied');
      assert.deepEqual(queue.map(item => item.modelId), ['older-A', 'newer-B']);
      apply(queue.shift()!);
      assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'older-A');
      apply(queue.shift()!);
      assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'newer-B');
      assert.equal(s.rpc.model.switchTo.mock.callCount(), 1, 'The host does not replay or drain native choices');
      assert.equal(s.sdk.send.mock.callCount(), 0);
    });
  }
});

test('concurrent complete model selections serialize acknowledgements without backfilling current options', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<void>();
  const started = deferred<void>();
  s.rpc.model.list.mock.mockImplementation(async () => {
    started.resolve();
    await held.promise;
    return { list: [{
      id: 'native-model', supportedReasoningEfforts: ['low', 'high'], supportsLongContext: true,
    }] };
  });
  const effort = h.engine.setModel(s.id, 'native-model', 'high', 'default');
  await started.promise;
  const tier = h.engine.setModel(s.id, 'native-model', 'high', 'long_context');
  await nextTurn();
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 0);
  held.resolve();
  await Promise.all([effort, tier]);
  const current = (await h.engine.getMeta(s.id))!;
  assert.equal(current.currentReasoningEffort, 'high');
  assert.equal(current.currentContextTier, 'long_context');
});

test('queued native full configs never copy stale current settings and omitted fields remain omitted', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.model = { modelId: 'native-model', reasoningEffort: 'low', contextTier: 'default' };
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'native-model', supportedReasoningEfforts: ['low', 'high'], supportsLongContext: true,
  }] }));
  const queue: Parameters<Rpc['model']['switchTo']>[0][] = [];
  s.rpc.model.switchTo.mock.mockImplementation(async options => {
    queue.push(options);
    return { deferred: true };
  });
  const currents = s.rpc.model.getCurrent.mock.callCount();
  for (const result of await Promise.all([
    h.engine.setModel(s.id, 'native-model', 'high', 'default'),
    h.engine.setModel(s.id, 'native-model', 'high', 'long_context'),
  ])) assert.deepEqual(result, { deferred: true });
  assert.deepEqual(queue, [
    { modelId: 'native-model', reasoningEffort: 'high', contextTier: 'default', deferIfModelChangeQueued: true },
    { modelId: 'native-model', reasoningEffort: 'high', contextTier: 'long_context', deferIfModelChangeQueued: true },
  ]);
  assert.equal(s.rpc.model.getCurrent.mock.callCount(), currents);
  for (const options of queue) s.state.model = {
    modelId: options.modelId, reasoningEffort: options.reasoningEffort, contextTier: options.contextTier,
  };
  assert.equal((await h.engine.getMeta(s.id))?.currentReasoningEffort, 'high');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'long_context');
  await h.engine.setModel(s.id, 'native-model', undefined, 'default');
  await h.engine.setModel(s.id, 'native-model');
  assert.deepEqual(queue.slice(2), [
    { modelId: 'native-model', contextTier: 'default', deferIfModelChangeQueued: true },
    { modelId: 'native-model', deferIfModelChangeQueued: true },
  ]);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});
test('structured native model and mode refusals retain their full outcomes without host continuation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.switchTo.mock.mockImplementation(async () => ({
    modelId: 'native-model', status: 'rejected', message: 'model is unavailable',
  }));
  assert.deepEqual(await h.engine.setModel(s.id, 'unavailable'), {
    modelId: 'native-model', status: 'rejected', message: 'model is unavailable',
  });

  test('all native model outcomes survive failed readbacks without fabricated application or retry', async t => {
    const h = harness(t);
    const s = await h.load();
    const outcomes: Awaited<ReturnType<Rpc['model']['switchTo']>>[] = [
      {}, { modelId: 'native-model' }, { status: 'future-outcome' },
      { status: 'applied', modelId: 'native-model', modelState: {
        modelId: 'native-model', reasoningEffort: 'high', contextTier: 'long_context',
      }, persistenceError: 'setting could not be written', warning: 'native warning',
      message: 'Applied in memory only', deprecationWarnings: ['native deprecation'] },
      { status: 'unchanged' }, { status: 'queued' }, { status: 'deferred', deferred: true },
      { status: 'confirmation_required', confirmation: {
        targetModelDisplayName: 'Small native model', currentTokens: 200, targetLimit: 100,
      } },
    ];
    const reads = s.rpc.model.getCurrent.mock.callCount();
    s.rpc.model.getCurrent.mock.mockImplementation(async () => { throw new Error('readback unavailable'); });
    for (const outcome of outcomes) {
      s.rpc.model.switchTo.mock.mockImplementationOnce(async () => outcome);
      assert.deepEqual(await h.engine.setModel(s.id, 'native-model'), outcome);
    }
    assert.equal(s.rpc.model.getCurrent.mock.callCount(), reads);
    assert.equal(s.rpc.model.switchTo.mock.callCount(), outcomes.length);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });

  test('mode follow-up flags, confirmation and warnings survive without readback or automatic host actions', async t => {
    const h = harness(t);
    const s = await h.load();
    const outcome: Awaited<ReturnType<Rpc['mode']['set']>> = {
      status: 'applied', modelChanged: true, deferImplementation: true, armInteractiveContinuation: true,
      confirmation: { targetModelDisplayName: 'Native plan model', currentTokens: 200, targetLimit: 100 },
      message: 'Native host action required', warning: 'Native warning', deprecationWarnings: ['native deprecation'],
    };
    s.rpc.mode.set.mock.mockImplementationOnce(async () => outcome);
    s.rpc.mode.get.mock.mockImplementation(async () => { throw new Error('mode readback unavailable'); });
    s.rpc.model.getCurrent.mock.mockImplementation(async () => { throw new Error('model readback unavailable'); });
    assert.deepEqual(await h.engine.setMode(s.id, 'plan'), outcome);
    assert.equal(s.rpc.mode.set.mock.callCount(), 1);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });

  test('native deletion never loads missing sessions', async t => {
    const h = harness(t);
    const s = await h.seed();
    await h.engine.deleteSession(s.id);
    assert.deepEqual(h.runtime.deleteSession.mock.calls[0]!.arguments, [s.id]);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    await assert.rejects(h.engine.deleteSession('missing-owned-fixture'), errorWithCode('SESSION_NOT_FOUND'));
    assert.equal(h.runtime.deleteSession.mock.callCount(), 1);
  });
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-model');
  s.rpc.mode.set.mock.mockImplementation(async () => ({
    status: 'cancelled', modelChanged: false, deferImplementation: true,
  }));
  assert.deepEqual(await h.engine.setMode(s.id, 'plan'), {
    status: 'cancelled', modelChanged: false, deferImplementation: true,
  });
  assert.equal(s.sdk.send.mock.callCount(), 0);
});
