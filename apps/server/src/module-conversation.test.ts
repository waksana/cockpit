import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { ModuleHostApi } from '@cockpit/module-api/backend';
import { Intents } from '@cockpit/protocol';
import { harness, user, assistant } from '../../../packages/core/test-support/engine-harness.ts';
import { ModuleHost } from './module-host.ts';
import { installLocalModule } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

test('module conversation bridge preserves canonical native decisions and bounded event reads', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('conversation', `
    let host;
    export function getHost() { return host; }
    export function activate(context) {
      if (context.host?.askResponseVersion !== 1 || context.host?.chatReadVersion !== 1) {
        throw new Error('Native conversation capabilities required before opening module data');
      }
      host = context.host;
      try { host.call('session/chat', { sessionId: 'activation' }); }
      catch (error) { return { routes: [], publicConfig: { activationError: error.message } }; }
      throw new Error('Host calls must not run during activation');
    }
  `)), { trustLocalCode: true, enable: true });
  const server = await import('./index.ts');
  const app = Fastify();
  t.after(async () => { await app.close(); await server.app.close(); });
  const moduleHost = new ModuleHost({ observer: f.observer, host: { call: server.callModuleIntent } });
  await moduleHost.register(app);
  const fixture = await import(pathToFileURL(join(installed.root, 'backend.mjs')).href) as {
    getHost(): ModuleHostApi;
    activate(context: { host: Partial<ModuleHostApi> }): unknown;
  };
  const host = fixture.getHost();
  assert.equal(host.askResponseVersion, 1);
  assert.equal(host.chatReadVersion, 1);
  assert.ok(Object.isFrozen(host));
  for (const oldHost of [{}, { askResponseVersion: 1 as const }, { chatReadVersion: 1 as const }]) {
    assert.throws(() => fixture.activate({ host: oldHost }), /capabilities required before opening module data/);
  }

  await t.test('answers only the original pending ask and retains native choice/freeform checks', async t => {
    const h = harness(t);
    server.setTestDependencies({ engine: h.engine });
    const s = await h.load();
    const other = await h.load();
    const request = h.configs.get(s.id)!.onUserInputRequest!;
    const pending = request({ question: 'Choose', choices: ['yes'], allowFreeform: false }, { sessionId: s.id });
    const { meta } = await host.call('session/get', { sessionId: s.id });
    const requestId = meta!.ask!.requestId;
    const body = { sessionId: s.id, requestId, answer: 'yes', wasFreeform: false };
    for (const invalid of [{ ...body, requestId: 'stale' }, { ...body, sessionId: other.id }]) {
      await assert.rejects(host.call('respondAsk', invalid), { code: 'REQUEST_NOT_PENDING' });
    }
    await assert.rejects(host.call('respondAsk', { ...body, answer: 'not offered' }), /offered choice/);
    await assert.rejects(host.call('respondAsk', { ...body, wasFreeform: true }), /Freeform/);
    const invalid = { ...body };
    Reflect.deleteProperty(invalid, 'requestId');
    await assert.rejects(host.call('respondAsk', invalid), { code: 'INVALID_INTENT_BODY' });
    await host.call('prompt', { sessionId: s.id, text: 'not an ask response' });
    assert.equal((await host.call('session/get', { sessionId: s.id })).meta?.ask?.requestId, requestId);
    const sends = s.sdk.send.mock.callCount();
    assert.deepEqual(await host.call('respondAsk', body), { ok: true });
    assert.deepEqual(await pending, { answer: 'yes', wasFreeform: false });
    assert.equal(s.sdk.send.mock.callCount(), sends, 'answers never send another prompt');
    await assert.rejects(host.call('respondAsk', body), { code: 'REQUEST_NOT_PENDING' });
    const freeform = request({ question: 'Explain', allowFreeform: true }, { sessionId: s.id });
    const nextId = (await host.call('session/get', { sessionId: s.id })).meta!.ask!.requestId;
    assert.notEqual(nextId, requestId);
    await assert.rejects(host.call('respondAsk', body), { code: 'REQUEST_NOT_PENDING' });
    assert.deepEqual(await host.call('respondAsk', {
      sessionId: s.id, requestId: nextId, answer: '  exact answer\n', wasFreeform: true,
    }), { ok: true });
    assert.deepEqual(await freeform, { answer: '  exact answer\n', wasFreeform: true });
  });

  await t.test('passive pages, expired cursors and unknown sessions never load or cache', async t => {
    const h = harness(t);
    server.setTestDependencies({ engine: h.engine });
    const s = await h.seed();
    const journal = [user('first'), assistant('answer', 'message', 'text'), user('last')];
    h.journals.set(s.id, journal);
    const query = Intents['session/chat'].body.parse({ sessionId: s.id, max: 1 });
    const first = await host.call('session/chat', query);
    assert.deepEqual(first.events, journal.slice(-1));
    assert.deepEqual(first.read, { rpc: 1, events: 1 });
    assert.equal(first.hasMore, true);
    const next = await host.call('session/chat', { ...query, cursor: first.cursor });
    assert.deepEqual(next.events, journal.slice(1, 2));
    assert.deepEqual(h.runtime.rpc.sessions.readPersistedEvents.mock.calls[1]!.arguments, [{
      sessionId: s.id, direction: 'backward', max: 1, cursor: first.cursor,
    }]);
    h.journals.set(s.id, [user('rewritten')]);
    const expired = await host.call('session/chat', { ...query, cursor: first.cursor });
    assert.equal(expired.cursorStatus, 'expired');
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 3, 'no automatic resync');
    const failure = new Error('native read outcome unknown');
    h.runtime.rpc.sessions.readPersistedEvents.mock.mockImplementationOnce(async () => { throw failure; });
    await assert.rejects(host.call('session/chat', query), error => error === failure);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 4, 'no cached fallback or retry');
    await assert.rejects(host.call('session/chat', { ...query, sessionId: 'unknown' }), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(host.call('session/chat', { ...query, source: 'live' }), { code: 'SESSION_UNLOADED' });
    const passiveBootstrap = await host.call('session/chat', { ...query, bootstrap: true });
    assert.equal(passiveBootstrap.liveCursor, undefined, 'persisted bootstrap stays a passive read');
    assert.deepEqual(passiveBootstrap.read, { rpc: 1, events: 1 });
    for (const invalid of [
      { max: 257 }, { max: 0 }, { source: 'persisted', types: ['assistant.message'] },
      { source: 'persisted', agentIds: ['child'] }, { direction: 'backward', waitMs: 1 },
      { includeEphemeral: true }, { bootstrap: true, cursor: first.cursor },
      { bootstrap: true, direction: 'forward' }, { beforeMsgId: 'legacy' },
    ]) {
      await assert.rejects(host.call('session/chat', Object.assign({}, query, invalid)), { code: 'INVALID_INTENT_BODY' });
    }
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 5);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal(h.runtime.liveCount, 0);
  });

  await t.test('live bootstrap and continuation preserve filters, expiry and result validation', async t => {
    const h = harness(t);
    server.setTestDependencies({ engine: h.engine });
    const s = await h.load();
    s.state.events = [user('before')];
    const query = Intents['session/chat'].body.parse({
      sessionId: s.id, source: 'live', max: 1, bootstrap: true,
      agentScope: 'all', agentIds: ['child'], types: ['assistant.message'],
    });
    const page = await host.call('session/chat', query);
    assert.ok(page.liveCursor);
    assert.deepEqual(page.read, { rpc: 2, events: 0 });
    s.emit({ ...assistant('after', 'answer', 'child reply'), agentId: 'child' });
    const continuation = { ...query, bootstrap: false, direction: 'forward' as const,
      cursor: page.liveCursor, waitMs: 10, includeEphemeral: true };
    const next = await host.call('session/chat', continuation);
    assert.equal(next.events[0]?.id, 'after');
    assert.deepEqual(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments, [{
      cursor: page.liveCursor, max: 1, direction: 'forward', waitMs: 10, includeEphemeral: true,
      agentScope: 'all', agentIds: ['child'], types: ['assistant.message'],
    }]);
    s.rpc.eventLog.read.mock.mockImplementationOnce(async () => ({
      events: [], cursor: 'expired', hasMore: false, cursorStatus: 'expired',
    }));
    assert.equal((await host.call('session/chat', continuation)).cursorStatus, 'expired');
    const invalid = { ...next };
    Reflect.set(invalid, 'cursorStatus', 'unknown');
    t.mock.method(h.engine, 'chat', async () => invalid);
    await assert.rejects(host.call('session/chat', continuation), { code: 'INVALID_INTENT_RESULT' });
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
  });

  moduleHost.close();
  assert.throws(() => host.call('respondAsk', {
    sessionId: 's', requestId: 'r', answer: 'yes', wasFreeform: false,
  }), /Module is stopped/);
  assert.throws(() => host.call('session/chat', Intents['session/chat'].body.parse({ sessionId: 's' })), /Module is stopped/);
});
