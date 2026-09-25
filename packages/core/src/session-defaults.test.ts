import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_SESSION_MODEL, NewSessionDefaults } from '@cockpit/protocol';
import { deferred, harness, user } from '../test-support/engine-harness.ts';
import { memorySessionDefaults } from '../test-support/session-defaults.ts';
import { sessionModelOptions } from './runtime.ts';

test('initial Astra is explicit in creation; only model is preset', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const config = h.configs.get(id)!;
  assert.equal(config.model, INITIAL_SESSION_MODEL);
  for (const key of ['reasoningEffort', 'contextTier', 'mode']) assert.equal(Object.hasOwn(config, key), false);
  assert.equal((await h.engine.getMeta(id))?.currentModelId, INITIAL_SESSION_MODEL);
  assert.equal(h.natives.get(id)!.rpc.model.switchTo.mock.callCount(), 0);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
});

test('defaults are validated and saved without touching sessions; resume/reload/fork do not inject a model', async t => {
  const store = memorySessionDefaults();
  const h = harness(t, { sessionDefaults: store });
  h.runtime.models.mock.mockImplementation(async () => [
    { modelId: INITIAL_SESSION_MODEL, name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' },
  ]);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  native.state.events.push(user('root', 'fixture'));
  const trace = [...h.trace];
  assert.deepEqual(await h.engine.setSessionDefaults('second'), { modelId: 'second' });
  assert.deepEqual(h.trace, trace);
  assert.equal(native.rpc.model.switchTo.mock.callCount(), 0);
  assert.equal(native.sdk.send.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(id))?.currentModelId, INITIAL_SESSION_MODEL);
  const next = await h.engine.newSession(h.cwd);
  assert.equal(h.configs.get(next)?.model, 'second');
  await h.engine.reload(id);
  assert.equal(Object.hasOwn(h.configs.get(id)!, 'model'), false);
  await h.engine.unload(id);
  await h.engine.load(id);
  assert.equal(Object.hasOwn(h.configs.get(id)!, 'model'), false);
  const beforeFork = h.runtime.createSession.mock.callCount();
  await h.engine.forkSession(id);
  assert.equal(h.runtime.createSession.mock.callCount(), beforeFork);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  await h.engine.setModel(id, 'second');
  assert.equal(native.rpc.model.switchTo.mock.callCount(), 1);
});

test('a creation keeps its captured default across a concurrent save', async t => {
  const store = memorySessionDefaults();
  const h = harness(t, { sessionDefaults: store });
  const catalog = deferred<Array<{ modelId: string; name: string }>>();
  const entered = deferred<void>();
  h.runtime.models.mock.mockImplementation(async () => [
    { modelId: INITIAL_SESSION_MODEL, name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' },
  ]);
  h.runtime.models.mock.mockImplementationOnce(async () => { entered.resolve(); return catalog.promise; });
  const first = h.engine.newSession(h.cwd);
  await entered.promise;
  assert.equal(await h.engine.busyCount(), 1);
  await h.engine.setSessionDefaults('second');
  catalog.resolve([{ modelId: INITIAL_SESSION_MODEL, name: 'GPT-6 Astra' }]);
  assert.equal(h.configs.get(await first)?.model, INITIAL_SESSION_MODEL);
  h.runtime.models.mock.mockImplementation(async () => [{ modelId: 'second', name: 'Second' }]);
  assert.equal(h.configs.get(await h.engine.newSession(h.cwd))?.model, 'second');
});

test('catalog and unavailable-model errors retain the saved ID and prevent saves/creation', async t => {
  const store = memorySessionDefaults('retired');
  const h = harness(t, { sessionDefaults: store });
  const saved = await h.engine.getSessionDefaults();
  assert.equal(saved.modelId, 'retired');
  assert.match(saved.modelError!, /retired.*unavailable/);
  await assert.rejects(h.engine.newSession(h.cwd), /retired.*unavailable/);
  await assert.rejects(h.engine.setSessionDefaults('retired'), /retired.*unavailable/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  h.runtime.models.mock.mockImplementation(async () => { throw new Error('catalog offline'); });
  assert.deepEqual(await h.engine.getSessionDefaults(), {
    modelId: 'retired', models: null, modelError: 'Could not read the native model catalog: catalog offline',
  });
  await assert.rejects(h.engine.newSession(h.cwd), /catalog offline/);
  await assert.rejects(h.engine.setSessionDefaults(INITIAL_SESSION_MODEL), /catalog offline/);
  assert.deepEqual(await store.read(), { modelId: 'retired' });
});

test('storage errors are not hidden', async t => {
  const store = memorySessionDefaults();
  const h = harness(t, { sessionDefaults: store });
  t.mock.method(store, 'write', async () => { throw new Error('disk full'); });
  await assert.rejects(h.engine.setSessionDefaults(INITIAL_SESSION_MODEL), /disk full/);
  t.mock.method(store, 'read', async () => { throw new Error('corrupt settings'); });
  await assert.rejects(h.engine.getSessionDefaults(), /corrupt settings/);
  await assert.rejects(h.engine.newSession(h.cwd), /corrupt settings/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

test('a saved model disabled by native policy is not selectable and cannot create a session', async t => {
  const h = harness(t, { sessionDefaults: memorySessionDefaults() });
  h.runtime.models.mock.mockImplementation(async () => sessionModelOptions([
    { id: INITIAL_SESSION_MODEL, name: 'GPT-6 Astra', policy: { state: 'disabled' } },
    { id: 'second', name: 'Second' },
  ]));
  const view = await h.engine.getSessionDefaults();
  assert.equal(view.modelId, INITIAL_SESSION_MODEL);
  assert.deepEqual(view.models?.map(model => model.modelId), ['second']);
  assert.match(view.modelError!, /disabled/);
  await assert.rejects(h.engine.newSession(h.cwd), /disabled/);
  await assert.rejects(h.engine.setSessionDefaults(INITIAL_SESSION_MODEL), /disabled/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

test('native model substitution retains the actual created identity as an incomplete result', async t => {
  const h = harness(t);
  const create = h.runtime.createSession;
  t.mock.method(h.runtime, 'createSession', async (config: Parameters<typeof create>[0]) => {
    const sdk = await create(config);
    h.natives.get(sdk.sessionId)!.state.model.modelId = 'substitute';
    return sdk;
  });
  await assert.rejects(h.engine.newSession(h.cwd), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && 'sessionId' in error);
    assert.equal(error.code, 'SESSION_CREATION_INCOMPLETE');
    assert.match(error.message, /substitute/);
    assert.ok(h.natives.has(String(error.sessionId)));
    return true;
  });
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
});

test('settings schema accepts only a nonempty model ID, not session parameter presets', () => {
  for (const input of [{ modelId: '' }, { modelId: '   ' }, { modelId: 'x', contextTier: 'long_context' },
    { modelId: 'x', reasoningEffort: 'high' }, { modelId: 'x', mode: 'autopilot' }]) {
    assert.equal(NewSessionDefaults.safeParse(input).success, false);
  }
});
