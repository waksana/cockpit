import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SessionConfig, SessionMetadata } from '@github/copilot-sdk';
import type { ModelOption } from '@cockpit/protocol';
import { Engine, type EngineRuntime } from './engine.ts';
import type { RoleProvider } from './roles.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Rpc,
  activeState,
  assertSameControlFacts,
  chat,
  deferred,
  event,
  finishReply,
  harness,
  nativeCalls,
  promptly,
  protectedWork,
  queued,
  serverChatEvents,
  timestamp,
  visibleError,
} from '../test-support/engine-harness.ts';

test('native creation returns the actual ID without product roles or a hidden first message', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const config = h.configs.get(id)!;
  assert.equal(config.sessionId, id);
  assert.equal(config.workingDirectory, h.cwd);
  assert.equal(config.enableConfigDiscovery, true);
  for (const key of ['systemMessage', 'skillDirectories', 'mcpServers']) assert.equal(Object.hasOwn(config, key), false);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
  await h.engine.prompt(id, 'The actual first user message');
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 1);
});

test('Cockpit session instructions are composed once per create/resume and never change a loaded handle', async t => {
  const h = harness(t);
  let text = 'default v1';
  const calls: Array<{ id: string; roles?: string }> = [];
  const provider: RoleProvider = {
    list: () => [], read: () => [], save: () => {},
    assemble: async () => { throw new Error('no roles selected'); },
    sessionInstructions: async (id, assembly) => {
      calls.push({ id, roles: assembly?.config.systemMessage && 'content' in assembly.config.systemMessage ? assembly.config.systemMessage.content : undefined });
      return text ? { content: `## Module fixture (Fixture)\n${text}`, sources: [{ label: 'Module fixture (Fixture)', sublabel: '/fixture/instructions.md' }] } : undefined;
    },
  };
  h.engine.setRoleProvider(provider);
  const id = await h.engine.newSession(h.cwd);
  assert.deepEqual(h.configs.get(id)!.systemMessage, { mode: 'append', content: '## Module fixture (Fixture)\ndefault v1' });
  assert.deepEqual(calls, [{ id, roles: undefined }], 'no role selection is required');
  assert.deepEqual(await h.engine.getPanel(id, 'instructionSources'), [{ label: 'Module fixture (Fixture)', sublabel: '/fixture/instructions.md' }]);
  text = 'default v2';
  await h.engine.getPanels(id);
  await h.engine.getMeta(id);
  assert.equal(calls.length, 1, 'reads never recompose instructions');
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0, 'no reload hint or startup message');
  await h.engine.unload(id);
  await h.engine.load(id);
  assert.deepEqual(h.configs.get(id)!.systemMessage, { mode: 'append', content: '## Module fixture (Fixture)\ndefault v2' });
  assert.equal(calls.length, 2);
  text = '';
  await h.engine.reload(id);
  assert.equal(Object.hasOwn(h.configs.get(id)!, 'systemMessage'), false, 'removed instructions are omitted on the next load');
  assert.deepEqual(await h.engine.getPanel(id, 'instructionSources'), []);
});

test('creation readback failure retains only the actual acknowledged native ID and never sends', async t => {
  const h = harness(t), create = h.runtime.createSession;
  t.mock.method(h.runtime, 'createSession', async (config: Parameters<EngineRuntime['createSession']>[0]) => {
    const sdk = await create(config);
    h.natives.get(sdk.sessionId)!.rpc.metadata.snapshot.mock.mockImplementationOnce(async () => {
      throw new Error('Synthetic native metadata failure');
    });
    return sdk;
  });
  let createdId = '';
  await assert.rejects(h.engine.newSession(h.cwd), error => {
    assert.ok(error instanceof Error && 'sessionId' in error && typeof error.sessionId === 'string');
    createdId = error.sessionId;
    assert.match(error.message, /was created.*metadata failure/);
    return true;
  });
  assert.ok(h.natives.has(createdId));
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.natives.get(createdId)!.sdk.send.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(createdId))?.sessionId, createdId);
});

test('session/load preserves empty loaded sessions and busy native work without closing or sending', async t => {
  const h = harness(t), id = await h.engine.newSession(h.cwd);
  await h.engine.load(id);
  const native = h.natives.get(id)!;
  native.state.processing = true;
  native.state.queue.items = [queued('already-pending', 'Keep existing native work')];
  await h.engine.load(id);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(native.sdk.send.mock.callCount(), 0);
  assert.equal(native.state.processing, true);
  assert.equal(native.state.queue.items[0]?.id, 'already-pending');
});

test('session/load coalesces native cold loading and protects its in-flight work', async t => {
  const h = harness(t), session = await h.seed();
  const ready = deferred<void>(), entered = deferred<void>();
  const resume = h.runtime.resumeSession;
  t.mock.method(h.runtime, 'resumeSession', async (...args: Parameters<typeof resume>) => {
    entered.resolve();
    await ready.promise;
    return resume(...args);
  });
  const first = h.engine.load(session.id), second = h.engine.load(session.id);
  await entered.promise;
  assert.ok(await h.engine.busyCount() > 0);
  await assert.rejects(h.engine.unload(session.id), errorWithCode('SESSION_BUSY'));
  await assert.rejects(h.engine.stop(), protectedWork);
  ready.resolve();
  await Promise.all([first, second]);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(session.sdk.send.mock.callCount(), 0);
});

test('separate prompt rejects empty content and a missing native acceptance without recreating', async t => {
  const h = harness(t), id = await h.engine.newSession(h.cwd);
  await assert.rejects(h.engine.prompt(id, ' '), errorWithCode('INVALID_REQUEST'));
  h.natives.get(id)!.sdk.send.mock.mockImplementation(async () => '');
  await assert.rejects(h.engine.prompt(id, 'Only once'), /receipt is missing/);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 1);
});

test('session/load rejects unknown targets and mismatched native resume identities without substituting another session', async t => {
  const h = harness(t);
  await assert.rejects(h.engine.load('unknown-original'), errorWithCode('SESSION_NOT_FOUND'));
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  const target = await h.seed(), other = await h.seed();
  const wrong = await h.runtime.resumeSession(other.id, {});
  t.mock.method(h.runtime, 'resumeSession', async () => wrong);
  await assert.rejects(h.engine.load(target.id), /Native resume returned a different session ID/);
  assert.equal(target.sdk.send.mock.callCount(), 0);
  assert.equal(other.sdk.send.mock.callCount(), 0);
  assert.equal(h.attached.has(target.id), false);
  assert.equal(h.attached.has(other.id), true);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

test('startup never polls native catalogs and models and login are fresh on every request', async t => {
  const h = harness(t);
  await h.engine.start();
  assert.equal(h.runtime.listSessions.mock.callCount(), 0);
  assert.equal(h.runtime.models.mock.callCount(), 0);
  assert.equal(h.runtime.getAuthStatus.mock.callCount(), 0);
  let label = 'first';
  h.runtime.models.mock.mockImplementation(async () => [{ modelId: label, name: label }]);
  h.runtime.getAuthStatus.mock.mockImplementation(async () => ({ isAuthenticated: true, login: label }));
  assert.equal((await h.engine.snapshot()).models[0]?.modelId, 'first');
  assert.equal(await h.engine.login(), 'first');
  label = 'second';
  assert.equal((await h.engine.snapshot()).models[0]?.modelId, 'second');
  assert.equal(await h.engine.login(), 'second');
  assert.equal(h.runtime.models.mock.callCount(), 2);
  assert.equal(h.runtime.getAuthStatus.mock.callCount(), 2);
  const lists = h.runtime.listSessions.mock.callCount();
  t.mock.timers.tick(24_000);
  await nextTurn();
  assert.equal(h.runtime.listSessions.mock.callCount(), lists);
  assert.equal(h.runtime.models.mock.callCount(), 2);
  await h.engine.stop();
});

test('session organization does not resolve or expose project metadata', async t => {
  const h = harness(t);
  const s = await h.seed();
  const original = (await h.engine.getMeta(s.id))!;
  assert.equal('project' in original, false);
  assert.equal('project' in (await h.engine.snapshot()).sessions.find(row => row.sessionId === s.id)!, false);
  assert.equal('project' in (await h.engine.listLive()).find(row => row.sessionId === s.id)!, false);
  assert.equal(h.events.some(event => event.type === 'session/patch' && 'project' in event), false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd);

  await h.engine.reload(s.id);
  s.state.processing = true;
  h.rows[0]!.context = { workingDirectory: '/' };
  await h.engine.refreshList();
  assert.equal('project' in (await h.engine.getMeta(s.id))!, false);
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd, 'list refresh never rewrites runtime cwd');
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);

  h.rows.push({
    sessionId: 'unknown-project', summary: 'legacy', isRemote: false,
    startTime: new Date(timestamp), modifiedTime: new Date(timestamp),
  });
  await h.engine.refreshList();
  assert.equal('project' in (await h.engine.getMeta('unknown-project'))!, false);
  await h.engine.deleteSession('unknown-project');
  assert.equal(await h.engine.getMeta('unknown-project'), null);
});

test('list refresh publishes changed indexed rows so activity order updates without reconnecting', async t => {
  const h = harness(t);
  const s = await h.seed();
  await h.engine.start();
  h.rows[0]!.summary = 'updated elsewhere';
  h.rows[0]!.modifiedTime = new Date('2026-09-09T12:00:00Z');
  h.events.length = 0;
  await h.engine.refreshList();
  assert.ok(h.events.some(event => event.type === 'snapshot' && event.sessions.some(row => row.sessionId === s.id
    && row.title === 'updated elsewhere' && row.lastActivity === Date.parse('2026-09-09T12:00:00Z'))));
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});
test('new session stays private until native creation succeeds, including concurrent list refresh', async t => {
  const h = harness(t);
  const allocation = deferred();
  const create = h.runtime.createSession;
  let id!: string;
  t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
    id = config.sessionId!;
    h.rows.push({ sessionId: id, startTime: new Date(timestamp), modifiedTime: new Date(timestamp), isRemote: false });
    await allocation.promise;
    return create(config);
  });
  const creating = h.engine.newSession(h.cwd);
  await nextTurn();
  assert.ok(id);
  await assert.rejects(h.engine.getMeta(id), errorWithCode('SESSION_TRANSITION'));
  assert.deepEqual((await h.engine.snapshot()).sessions, []);
  assert.ok(!h.events.some(value => value.type.startsWith('session/')));
  await h.engine.refreshList();
  await assert.rejects(h.engine.getMeta(id), errorWithCode('SESSION_TRANSITION'));
  await assert.rejects(h.engine.stop(), protectedWork);
  allocation.resolve();
  assert.equal(await creating, id);
  assert.equal((await h.engine.getMeta(id))?.loaded, true);
  assert.equal(h.events.filter(value => value.type === 'session/added').length, 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
});

test('native absence leaves no unloaded state while preserving files and product preferences', async t => {

  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const draftFile = join(h.cwd, 'composer-draft.txt');
  writeFileSync(draftFile, 'unsent user text');
  const prefs = readFileSync(h.prefsFile, 'utf8');
  h.rows.length = 0;
  await h.engine.refreshList();
  assert.ok(await h.engine.getMeta(id), 'an actual live handle can read native metadata without an index row');
  h.runtime.expire(id, true);
  await h.engine.refreshList();
  assert.equal(await h.engine.getMeta(id), null);
  assert.deepEqual((await h.engine.snapshot()).sessions, []);
  assert.equal(activeState(h, id), undefined, 'unloaded projections are not retained');
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(readFileSync(draftFile, 'utf8'), 'unsent user text');
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
});

test('absence lookup cannot remove a session resumed while metadata was in flight', async t => {

  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.expire(id, true);
  const metadata = deferred<SessionMetadata | undefined>();
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(() => metadata.promise);
  const reading = h.engine.getMeta(id);
  await nextTurn();
  await h.engine.reload(id);
  metadata.resolve(undefined);
  assert.equal(await reading, null, 'a passive caller owns its native lookup response');
  assert.equal((await h.engine.getMeta(id))?.loaded, true);
  assert.ok(!h.events.some(value => value.type === 'session/removed'));
});

test('native mode changes still read back a changed model without draft settings', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  native.rpc.mode.set.mock.mockImplementationOnce(async ({ mode }) => {
    native.state.mode = mode;
    native.state.model.modelId = 'mode-selected-model';
    return { status: 'applied', modelChanged: true };
  });
  await h.engine.setMode(id, 'plan');
  assert.equal((await h.engine.getMeta(id))?.currentMode, 'plan');
  assert.equal((await h.engine.getMeta(id))?.currentModelId, 'mode-selected-model');
  assert.equal(native.sdk.send.mock.callCount(), 0);
});

test('model changes return the native acknowledgement without current-state or unused inventory readback', async t => {
  const h = harness(t);
  const s = await h.load();
  const lists = s.rpc.model.list.mock.callCount();
  const currents = s.rpc.model.getCurrent.mock.callCount();
  s.rpc.model.list.mock.mockImplementation(async () => { throw new Error('unrelated inventory unavailable'); });
  await h.engine.setModel(s.id, 'new-model');
  assert.equal(s.state.model.modelId, 'new-model');
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
  assert.equal(s.rpc.model.getCurrent.mock.callCount() - currents, 0, 'native result must not depend on stale or failed readback');
  assert.equal(s.rpc.model.list.mock.callCount(), lists, 'successful mutation has no unused inventory dependency');
});

test('model option validation reads its inventory once before switching, never again after success', async t => {
  const h = harness(t);
  const s = await h.load();
  let lists = 0;
  s.rpc.model.list.mock.mockImplementation(async () => {
    if (++lists > 1) throw new Error('inventory must not be reread after mutation');
    return { list: [{ id: 'validated-model', supportedReasoningEfforts: ['high'] }] };
  });
  await h.engine.setModel(s.id, 'validated-model', 'high');
  assert.equal(lists, 1);
  assert.equal(s.state.model.reasoningEffort, 'high');
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
});

for (const failCurrent of [false, true]) {
  test(`mode-selected model returns native outcome without readback (unavailable=${failCurrent})`, async t => {
    const h = harness(t);
    const s = await h.load();
    const lists = s.rpc.model.list.mock.callCount();
    const currents = s.rpc.model.getCurrent.mock.callCount();
    s.rpc.mode.set.mock.mockImplementationOnce(async ({ mode }) => {
      s.state.mode = mode;
      s.state.model.modelId = 'mode-selected';
      return { status: 'applied', modelChanged: true };
    });
    s.rpc.model.list.mock.mockImplementation(async () => { throw new Error('unrelated inventory unavailable'); });
    if (failCurrent) s.rpc.model.getCurrent.mock.mockImplementation(async () => { throw new Error('required current read failed'); });
    s.rpc.mode.get.mock.mockImplementation(async () => { throw new Error('mode read unavailable'); });
    assert.deepEqual(await h.engine.setMode(s.id, 'plan'), { status: 'applied', modelChanged: true });
    assert.equal(s.rpc.model.getCurrent.mock.callCount() - currents, 0);
    assert.equal(s.rpc.model.list.mock.callCount(), lists);
    assert.equal(s.rpc.mode.set.mock.callCount(), 1, 'never replay an applied change after read failure');
  });
}

test('expired empty session rejects native absence without recreating or sending', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const original = h.natives.get(id)!;
  h.runtime.expire(id, true);
  h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('native session missing'); });
  await assert.rejects(h.engine.prompt(id, 'first explicit prompt'), /native session missing/);
  assert.ok(h.runtime.getSessionMetadata.mock.callCount() > 0, 'metadata comes from the public native lookup');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(original.sdk.send.mock.callCount(), 0);
  visibleError(h, id, /native session missing/);
  assert.equal((await h.engine.getMeta(id))?.error, undefined);
});

test('metadata lookup failure propagates without speculative recreation or remembered errors', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.expire(id, true);
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(async () => { throw new Error('metadata unavailable'); });
  await assert.rejects(h.engine.getMeta(id), /metadata unavailable/);
  assert.ok((await h.engine.getMeta(id)));
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
});

test('persisted local draft is resumed, never recreated', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(async () => ({
    sessionId: id, startTime: new Date(timestamp), modifiedTime: new Date(timestamp), isRemote: false,
  }));
  h.runtime.expire(id);
  await h.engine.prompt(id, 'first explicit prompt');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('any attempted mutation permanently prevents empty-draft recreation, even with no acceptance event', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const original = h.natives.get(id)!;
  original.sdk.send.mock.mockImplementationOnce(async () => { throw new Error('delivery unknown'); });
  await assert.rejects(h.engine.prompt(id, 'uncertain send'), /delivery unknown/);
  h.runtime.expire(id);
  h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('native session missing'); });
  await assert.rejects(h.engine.prompt(id, 'new explicit prompt'), /native session missing/);
  assert.ok(h.runtime.getSessionMetadata.mock.callCount() > 0, 'metadata comes from the public native lookup');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(original.sdk.send.mock.callCount(), 1);
});

test('unavailable prompt preflight rejects without speculatively resuming or sending', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  h.runtime.isSessionLive.mock.mockImplementationOnce(async () => { throw new Error('native attach unavailable'); });
  await assert.rejects(h.engine.prompt(s.id, 'do not guess delivery'), /native attach unavailable/);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

for (const accepted of [false, true]) {
  test(`send rejection after ${accepted ? 'native acceptance' : 'uncertain delivery'} never retries; the next prompt may resume`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.sdk.send.mock.mockImplementationOnce(async () => {
      if (accepted) s.emit(event('user.message', { content: 'first prompt', messageId: 'native-accepted' }));
      h.runtime.expire(s.id);
      throw new Error('session closed after send; delivery uncertain');
    });
    await assert.rejects(h.engine.prompt(s.id, 'first prompt'), /delivery uncertain/);
    await nextTurn();
    assert.equal(s.sdk.send.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(serverChatEvents(h).length, 0);
    h.journals.set(s.id, structuredClone(s.state.events));
    assert.equal((await chat(h, s.id)).events.filter(event => event.type === 'user.message').length, accepted ? 1 : 0);
    await h.engine.prompt(s.id, 'second explicit prompt');
    assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
    assert.equal(s.sdk.send.mock.callCount(), 2);
    assert.equal(s.sdk.send.mock.calls[1]!.arguments[0]!.prompt, 'second explicit prompt');
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  });
}

for (const accepted of [false, true]) {
  test(`fatal runtime failure abandons ${accepted ? 'accepted' : 'hung'} sends and choices without dead metadata or close RPCs`, async t => {
    const h = harness(t);
    const sending = await h.load();
    const deciding = await h.load();
    const unread = await h.load();
    await h.engine.start();
    await finishReply(unread, 'keep the unread reply', 'fatal-history');
    h.journals.set(unread.id, structuredClone(unread.state.events));
    const savedPreferences = readFileSync(h.prefsFile, 'utf8');
    const reports: Error[] = [];
    const off = h.engine.onFatal((error: Error) => reports.push(error));
    const removed = t.mock.fn();
    const removeHandler = h.engine.onFatal(removed);
    removeHandler();
    t.after(off);
    assert.equal(h.engine.failure, undefined);
    const deadSend = deferred<string>();
    if (!accepted) sending.sdk.send.mock.mockImplementation(() => deadSend.promise);
    const prompt = h.engine.prompt(sending.id, 'accepted or hung native work');
    const rejected: Promise<unknown>[] = [];
    if (accepted) await prompt;
    else rejected.push(assert.rejects(prompt, /fatal native disconnect/));
    const config = h.configs.get(deciding.id)!;
    const choices = [
      config.onUserInputRequest!({ question: 'pending ask' }, { sessionId: deciding.id }),
      config.onExitPlanModeRequest!({ summary: 'pending plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: deciding.id }),
      config.onElicitationRequest!({ sessionId: deciding.id, message: 'pending elicitation' }),
    ];
    rejected.push(...choices.map(choice => assert.rejects(Promise.resolve(choice), /fatal native disconnect/)));
    const rejections = Promise.all(rejected);
    void rejections.catch(() => {});
    await nextTurn();
    assert.equal(sending.sdk.send.mock.callCount(), 1);
    const sessions = [sending, deciding, unread];
    const before = sessions.map(nativeCalls);
    const probes = h.runtime.isSessionLive.mock.callCount();
    const lists = h.runtime.listSessions.mock.callCount();
    const fatal = new Error('fatal native disconnect');
    h.runtime.emitFatal(fatal);
    await promptly(rejections);
    assert.equal(h.engine.failure, fatal);
    assert.deepEqual(reports, [fatal]);
    assert.equal(removed.mock.callCount(), 0);
    await assert.rejects(h.engine.snapshot(), /fatal native disconnect/);
    for (const s of sessions) {
      await assert.rejects(h.engine.getMeta(s.id), /fatal native disconnect/);
      assert.equal(s.listeners.size, 0);
    }
    assert.ok(h.events.some(event => event.type === 'agent/status' && event.status === 'failed'));
    assert.equal(readFileSync(h.prefsFile, 'utf8'), savedPreferences);
    t.mock.timers.tick(24_000);
    await nextTurn();
    assert.equal(h.runtime.listSessions.mock.callCount(), lists);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    for (const operation of [
      () => h.engine.start(), () => h.engine.newSession(h.cwd),
      () => h.engine.prompt(sending.id, 'must never send'), () => h.engine.reload(sending.id),
      () => h.engine.setModel(sending.id, 'must not mutate'), () => h.engine.cancel(sending.id),
      () => h.engine.getPlan(sending.id), () => h.engine.getPanels(sending.id),
      () => h.engine.listSchedules(sending.id), () => h.engine.listSessionSkills(sending.id),
      () => h.engine.listGlobalSkills(h.cwd), () => h.engine.refreshSkills(),
    ]) await assert.rejects(async () => operation(), /fatal native disconnect/);
    await promptly(h.engine.stop());
    assert.equal(h.runtime.stop.mock.callCount(), 1);
    assert.equal(h.runtime.start.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.equal(h.attached.size, 0, 'fatal stop cleans up outstanding wrappers without close');
    assert.deepEqual(sessions.map(nativeCalls), before);
    assert.equal(h.engine.failure, fatal);
    await assert.rejects(h.engine.start(), /fatal native disconnect/);
    deadSend.resolve('late-native-acceptance');
    await nextTurn();
    await assert.rejects(h.engine.snapshot(), /fatal native disconnect/);
    await assert.rejects(h.engine.getMeta(sending.id), /fatal native disconnect/);
    assert.deepEqual(sessions.map(nativeCalls), before, 'late native completion cannot restart synchronization');
  });
}

test('a new Engine cannot reuse a runtime whose failure is already terminal', async t => {
  const h = harness(t);
  const fatal = new Error('fatal before replacement engine');
  h.runtime.emitFatal(fatal);
  const replacement = new Engine({ runtime: h.runtime as unknown as EngineRuntime });
  await assert.rejects(replacement.start(), /fatal before replacement engine/);
  await assert.rejects(replacement.newSession(h.cwd), /fatal before replacement engine/);
  assert.equal(replacement.failure, fatal);
  assert.equal(h.runtime.start.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  await promptly(replacement.stop());
});

test('fatal runtime failure rejects a hung native model switch and permits stop before it settles', async t => {

  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const readback = deferred<Awaited<ReturnType<Rpc['model']['switchTo']>>>();
  s.rpc.model.switchTo.mock.mockImplementation(() => readback.promise);
  const changing = assert.rejects(h.engine.setModel(s.id, 'pending-model'), /fatal during model readback/);
  await nextTurn();
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
  const before = nativeCalls(s);
  h.runtime.emitFatal(new Error('fatal during model readback'));
  await promptly(changing);
  await promptly(h.engine.stop());
  await assert.rejects(h.engine.getMeta(s.id), /fatal during model readback/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.stop.mock.callCount(), 1);
  assert.deepEqual(nativeCalls(s), before);
  readback.resolve(structuredClone(s.state.model));
  await nextTurn();
  await assert.rejects(h.engine.snapshot(), /fatal during model readback/);
  assert.deepEqual(nativeCalls(s), before);
});

test('fatal while startup is hung rejects start and permits cleanup without waiting or restarting', async t => {
  const h = harness(t);
  const startup = deferred<void>();
  h.runtime.start.mock.mockImplementation(() => startup.promise);
  const starting = assert.rejects(h.engine.start(), /fatal startup while pending/);
  void starting.catch(() => {});
  await nextTurn();
  const fatal = new Error('fatal startup while pending');
  h.runtime.emitFatal(fatal);
  await promptly(starting);
  await promptly(h.engine.stop());
  assert.equal(h.engine.failure, fatal);
  await assert.rejects(h.engine.snapshot(), /fatal startup/);
  await assert.rejects(h.engine.start(), /fatal startup while pending/);
  assert.equal(h.runtime.start.mock.callCount(), 1);
  startup.resolve();
  await nextTurn();
  t.mock.timers.tick(8000);
  await nextTurn();
  assert.equal(h.runtime.listSessions.mock.callCount(), 0);
  assert.ok(!h.events.some(event => event.type === 'agent/status' && event.status === 'up'));
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('snapshots read fresh native models and sessions and return independent mutable copies', async t => {
  const h = harness(t);
  const s = await h.load();
  const models: ModelOption[] = [{
    modelId: 'available-model', name: 'Available model', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low', supportsLongContext: true,
  }];
  h.runtime.models.mock.mockImplementation(async () => structuredClone(models));
  try {
    await h.engine.start();
    const snapshot = (await h.engine.snapshot());
    assert.equal(snapshot instanceof Promise, false);
    assert.equal(snapshot.agentStatus, 'up');
    assert.deepEqual(snapshot.models, models);
    const before = structuredClone(snapshot);
    snapshot.models[0]!.name = 'caller mutation';
    snapshot.models[0]!.supportedReasoningEfforts!.push('invented');
    snapshot.models.length = 0;
    snapshot.sessions[0]!.title = 'caller title';
    assert.equal(snapshot.sessions[0]!.queue, undefined, 'snapshot omits unselected queue bodies');
    snapshot.sessions.length = 0;
    assertSameControlFacts((await h.engine.snapshot()), before);
    const meta = (await h.engine.getMeta(s.id))!;
    const beforeMeta = structuredClone(meta);
    meta.queue!.push({ id: 'caller-meta-queue', text: 'not native either' });
    assertSameControlFacts((await h.engine.getMeta(s.id)), beforeMeta);
    assert.equal(h.runtime.models.mock.callCount(), 3, 'seed refresh plus two explicit snapshots fetch native models');
    models[0]!.name = 'Updated native catalog';
    assert.equal((await h.engine.snapshot()).models[0]!.name, 'Updated native catalog');
  } finally {
    await h.engine.stop();
  }
});
