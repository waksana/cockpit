import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Intents } from '@cockpit/protocol';
import { Engine } from './engine.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Rpc,
  deferred,
  harness,
  nativeCalls,
  promptly,
  protectedWork,
  schedule,
  timestamp,
} from '../test-support/engine-harness.ts';

const invalidSchedules = [
  { interval: '1m', cron: '* * * * *' }, { interval: '1m', tz: 'UTC' },
  { interval: '1m', displayPrompt: 'label' }, { at: Date.parse(timestamp), recurring: true },
  { cron: '* * * * *' }, { interval: '1m', tz: '' }, { interval: '1m', displayPrompt: '' },
  {}, { interval: '0s' }, { interval: '-1s' }, { interval: '0.5s' },
  { interval: '86401s' }, { interval: '1441m' }, { interval: '25h' },
  { at: Date.parse(timestamp) - 1 }, { at: Date.parse(timestamp) },
  { at: Date.parse(timestamp) + 86_400_001 }, { at: Number.NaN }, { at: Number.POSITIVE_INFINITY },
  { interval: '1m', at: Date.parse(timestamp) }, { interval: 'tomorrow' },
  { interval: '1m', prompt: 'hello --model other' }, { interval: '1m', prompt: '/dangerous-command' },
  { interval: '1m', prompt: 'line one\nline two' }, { interval: '1m', prompt: '  ' },
  { interval: '1m', prompt: '\ncheck build\n' }, { interval: '1m', prompt: 'check build\r' },
  { interval: '1m', unknown: 'value' },
  { interval: '1m', cron: undefined }, { interval: '1m', tz: undefined }, { interval: '1m', displayPrompt: undefined },
] satisfies Array<Partial<Parameters<Engine['addSchedule']>[1]> & Record<string, unknown>>;
for (const options of invalidSchedules) {
  test(`invalid schedule is rejected before resume or command invocation: ${JSON.stringify(options)}`, async t => {
    const h = harness(t);
    const s = await h.seed();
    t.mock.method(Date, 'now', () => Date.parse(timestamp));
    const before = readFileSync(h.prefsFile, 'utf8');
    await assert.rejects(h.engine.addSchedule(s.id, { prompt: 'check build', ...options }), errorWithCode('INVALID_REQUEST', 'UNSUPPORTED'));
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
    assert.equal(s.rpc.schedule.list.mock.callCount(), 0);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.send.mock.callCount(), 0);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    assert.equal(h.prefs().scheduledSessions?.[s.id], undefined);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
  });
}

for (const seconds of [1, 86_400]) {
  for (const kind of ['interval', 'absolute'] as const) {
    test(`${kind} schedule accepts the inclusive ${seconds}-second bound only with native confirmation`, async t => {
      const h = harness(t);
      const s = await h.load();
      t.mock.method(Date, 'now', () => Date.parse(timestamp));
      s.rpc.commands.invoke.mock.mockImplementation(async () => {
        s.state.schedules = [{ ...schedule(93, false), intervalMs: seconds * 1000 }];
        return { kind: 'completed' };
      });
      const result = await h.engine.addSchedule(s.id, {
        prompt: 'check build', recurring: false,
        ...(kind === 'interval' ? { interval: `${seconds}s` } : { at: Date.parse(timestamp) + seconds * 1000 }),
      });
      assert.equal(result.error, undefined);
      assert.equal(result.entry?.id, 93);
      assert.equal(result.entry?.intervalMs, seconds * 1000);
      assert.deepEqual(s.rpc.commands.invoke.mock.calls[0]!.arguments, [{ name: 'after', input: `${seconds}s check build` }]);
      assert.equal(s.sdk.send.mock.callCount(), 0);
      assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
      assert.equal(h.prefs().scheduledSessions, undefined);
    });
  }
}

for (const recurring of [false, true]) {
  test(`native ${recurring ? 'every' : 'after'} schedule is confirmed by list read-back, using its native ID and time`, async t => {
    const h = harness(t);
    const s = await h.load();
    const timeouts = t.mock.method(globalThis, 'setTimeout');
    const intervals = t.mock.method(globalThis, 'setInterval');
    s.rpc.commands.invoke.mock.mockImplementation(async () => {
      s.state.schedules = [schedule(91, recurring)];
      return { kind: 'completed' };
    });
    const result = await h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m', recurring });
    assert.equal(result.error, undefined);
    assert.deepEqual(s.rpc.commands.invoke.mock.calls[0]!.arguments, [{ name: recurring ? 'every' : 'after', input: '60s check build' }]);
    assert.equal(result.entry?.id, 91);
    assert.equal(result.entry?.nextRunAt, Date.parse('2026-09-07T12:01:00.000Z'));
    assert.equal(result.entry?.recurring, recurring);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
    assert.equal(h.prefs().scheduledSessions, undefined);
    assert.equal(s.sdk.send.mock.callCount(), 0);
    const before = nativeCalls(s);
    t.mock.timers.tick(86_400_000);
    await nextTurn();
    assert.deepEqual(nativeCalls(s), before, 'Cockpit must not run schedules or add a schedule heartbeat');
    assert.equal(await h.engine.stopSchedule(s.id, 91), true);
    assert.deepEqual(s.rpc.schedule.stop.mock.calls[0]!.arguments, [{ id: 91 }]);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 0);
    assert.equal(h.prefs().scheduledSessions?.[s.id], undefined);
    assert.equal(await h.engine.stopSchedule(s.id, 91), false);
    assert.equal(timeouts.mock.callCount(), 0, 'only the native runtime owns schedule timers');
    assert.equal(intervals.mock.callCount(), 0, 'schedule mutations must not install a local scheduler');
    await h.engine.unload(s.id);
  });
}

test('schedule command acknowledgement without a matching new entry is not success or a model fallback', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule(11)];
  const result = await h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' });
  assert.equal(result.entry, undefined);
  assert.match(result.error!, /not confirmed/);
  assert.equal(result.possiblyCreated, true);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
});

for (const recurring of [false, true]) {
  test(`schedule ${recurring ? 'every' : 'after'} normalizes surrounding whitespace once and preserves a created ID with a warning`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.commands.invoke.mock.mockImplementation(async ({ input }) => {
      assert.equal(input, '60s check build');
      s.state.schedules = [schedule(92, recurring)];
      return { kind: 'agent-prompt', prompt: 'must not be sent', displayPrompt: 'must not be sent' };
    });
    const result = await h.engine.addSchedule(s.id, { prompt: '  check build  ', interval: '1m', recurring });
    assert.equal(result.entry?.id, 92);
    assert.equal(result.entry?.prompt, 'check build');
    assert.match(result.error!, /created.*unexpected command outcome/);
    assert.equal(result.possiblyCreated, undefined, 'a matching native entry establishes creation');
    assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

for (const failure of ['acknowledgement', 'readback'] as const) {
  test(`schedule ${failure} failure reports possible creation without replay`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.commands.invoke.mock.mockImplementation(async () => {
      s.state.schedules = [schedule(93)];
      if (failure === 'acknowledgement') throw new Error('response lost');
      s.rpc.schedule.list.mock.mockImplementation(async () => { throw new Error('readback lost'); });
      return { kind: 'completed' };
    });
    const result = await h.engine.addSchedule(s.id, { prompt: ' check build ', interval: '1m' });
    assert.equal(result.possiblyCreated, true);
    assert.match(result.error!, /may have been created/);
    assert.match(result.error!, /Do not retry automatically/);
    assert.equal(s.state.schedules[0]?.id, 93, 'a response failure must not imply that native creation failed');
    assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('fatal after schedule dispatch reports possible creation without late readback or retry', async t => {
  const h = harness(t);
  const s = await h.load();
  const command = deferred<Awaited<ReturnType<Rpc['commands']['invoke']>>>();
  s.rpc.commands.invoke.mock.mockImplementation(() => command.promise);
  const creating = h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' });
  await nextTurn();
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
  const reads = s.rpc.schedule.list.mock.callCount();
  h.runtime.emitFatal(new Error('native connection lost after dispatch'));
  const result = await promptly(creating);
  assert.equal(result.possiblyCreated, true);
  assert.match(result.error!, /may have been created.*native connection lost after dispatch/);
  command.resolve({ kind: 'completed' });
  await nextTurn();
  assert.equal(s.rpc.schedule.list.mock.callCount(), reads);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  await h.engine.stop();
});

test('absolute schedules use a bounded native after delay and require a real returned entry', async t => {
  const h = harness(t);
  const s = await h.load();
  t.mock.method(Date, 'now', () => Date.parse(timestamp));
  s.rpc.commands.invoke.mock.mockImplementation(async () => {
    s.state.schedules = [schedule(92, false)];
    return { kind: 'completed' };
  });
  const result = await h.engine.addSchedule(s.id, { prompt: 'check build', at: Date.parse(timestamp) + 60_000 });
  assert.deepEqual(s.rpc.commands.invoke.mock.calls[0]!.arguments, [{ name: 'after', input: '60s check build' }]);
  assert.equal(result.entry?.id, 92);
  assert.equal(result.entry?.recurring, false);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('schedule list and panel projections preserve self-paced meaning and ordinary timing metadata', async t => {
  const h = harness(t);
  const s = await h.load();
  const nextRunAt = '2026-09-07T12:01:00.000Z';
  s.state.schedules = [
    { id: 1, prompt: 'choose the next run', displayPrompt: '/review', recurring: true, selfPaced: true, nextRunAt },
    { ...schedule(2), selfPaced: false },
    schedule(3, false),
    { id: 4, prompt: 'calendar', recurring: true, cron: '0 9 * * *', tz: 'Asia/Shanghai', nextRunAt },
    { id: 5, prompt: 'once', recurring: false, at: Date.parse(nextRunAt), nextRunAt },
  ];
  const before = s.rpc.schedule.list.mock.callCount();
  const entries = await h.engine.listSchedules(s.id);
  assert.deepEqual(Intents['schedule/list'].result.parse(JSON.parse(JSON.stringify({ entries }))), {
    entries: s.state.schedules.map(entry => ({ ...entry, nextRunAt: Date.parse(entry.nextRunAt) })),
  });
  assert.equal(entries[0]!.intervalMs, undefined);
  assert.equal(entries[0]!.at, undefined);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 1);
  const panels = Intents['session/panels'].result.parse(await h.engine.getPanels(s.id));
  assert.deepEqual(panels.schedules, s.state.schedules.map(entry => ({
    label: entry.displayPrompt || entry.prompt,
    sublabel: entry.selfPaced ? `Self-paced (model-controlled) · next ${nextRunAt}` : nextRunAt,
  })));
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 2);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
});

for (const found of [true, false]) {
  test(`native schedule stop ${found ? 'success' : 'not-found'} needs no list, even when listing is broken`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.schedules = found ? [schedule()] : [];
    const before = s.rpc.schedule.list.mock.callCount();
    const listFailure = new Error('schedule list unavailable');
    s.rpc.schedule.list.mock.mockImplementation(async () => { throw listFailure; });
    assert.equal(await h.engine.stopSchedule(s.id, 7), found);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
    assert.deepEqual(s.rpc.schedule.stop.mock.calls[0]!.arguments, [{ id: 7 }]);
    assert.equal(s.rpc.schedule.list.mock.callCount(), before);
    assert.deepEqual(s.state.schedules, []);
    await assert.rejects(h.engine.listSchedules(s.id), error => error === listFailure);
    assert.equal(s.rpc.schedule.list.mock.callCount(), before + 1);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 1, 'a subsequent list failure must not retry stop');
  });
}

test('schedule stop stays serialized behind creation and protects lifecycle until the native mutation settles', async t => {
  const h = harness(t);
  const s = await h.load();
  const command = deferred();
  s.rpc.commands.invoke.mock.mockImplementation(async () => {
    await command.promise;
    s.state.schedules = [schedule()];
    return { kind: 'completed' };
  });
  const before = s.rpc.schedule.list.mock.callCount();
  const adding = h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' });
  await nextTurn();
  const stopping = h.engine.stopSchedule(s.id, 7);
  await nextTurn();
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 1);
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  command.resolve();
  assert.equal((await adding).entry?.id, 7);
  assert.equal(await stopping, true);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 2, 'only creation needs before/after identity reads');
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
  assert.deepEqual(s.state.schedules, []);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  await h.engine.unload(s.id);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`pending schedule stop ${outcome} protects lifecycle and releases the next serialized mutation`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.schedules = [schedule()];
    const stopped = deferred<Awaited<ReturnType<typeof s.rpc.schedule.stop>>>();
    s.rpc.schedule.stop.mock.mockImplementationOnce(() => stopped.promise);
    const first = h.engine.stopSchedule(s.id, 7);
    const firstResult = outcome === 'failure' ? assert.rejects(first, /stop refused/) : first;
    await nextTurn();
    const second = h.engine.stopSchedule(s.id, 7);
    await nextTurn();
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
    for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
      await assert.rejects(operation(), protectedWork);
    }
    if (outcome === 'failure') stopped.reject(new Error('stop refused'));
    else {
      s.state.schedules = [];
      stopped.resolve({ entry: schedule() });
    }
    assert.equal(await firstResult, outcome === 'success' ? true : undefined);
    assert.equal(await second, outcome === 'failure');
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 2);
    assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
    await h.engine.unload(s.id);
  });
}

test('fatal runtime failure rejects pending and queued schedule stops without retry or late list read', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const stopped = deferred<Awaited<ReturnType<typeof s.rpc.schedule.stop>>>();
  s.rpc.schedule.stop.mock.mockImplementationOnce(() => stopped.promise);
  const first = assert.rejects(h.engine.stopSchedule(s.id, 7), /fatal during schedule stop/);
  await nextTurn();
  const second = assert.rejects(h.engine.stopSchedule(s.id, 8), /fatal during schedule stop/);
  await nextTurn();
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
  const before = nativeCalls(s);
  h.runtime.emitFatal(new Error('fatal during schedule stop'));
  await promptly(Promise.all([first, second]));
  await promptly(h.engine.stop());
  stopped.resolve({ entry: schedule() });
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('native schedule stop rejection preserves the schedule without persisting local policy and permits unload', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule()];
  await h.engine.listSchedules(s.id);
  const before = s.rpc.schedule.list.mock.callCount();
  const failure = new Error('schedule stop refused');
  s.rpc.schedule.stop.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(h.engine.stopSchedule(s.id, 7), error => error === failure);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
  assert.equal(h.prefs().scheduledSessions, undefined);
  await h.engine.unload(s.id);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  assert.deepEqual(s.state.schedules, [schedule()]);
  assert.equal(h.prefs().scheduledSessions, undefined);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
});
test('concurrent identical schedule prompts retain distinct native timing and IDs', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.commands.invoke.mock.mockImplementation(async ({ input }) => {
    await nextTurn();
    const seconds = Number(input!.split('s ')[0]);
    s.state.schedules.push({ ...schedule(s.state.schedules.length + 1), intervalMs: seconds * 1000 });
    return { kind: 'completed' };
  });

  const results = await Promise.all([
    h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' }),
    h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1h' }),
  ]);
  assert.deepEqual(results.map(result => [result.entry?.id, result.entry?.intervalMs]), [[1, 60_000], [2, 3_600_000]]);
});
