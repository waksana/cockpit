import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SessionMeta, SessionProjection } from '@cockpit/protocol';
import { ChatMessage } from '@cockpit/protocol/validation';
import { createCockpitStore } from '../net/store';
import { IntentHttpError } from '../net/client';
import { getDraftSession } from '../lib/draftSelection';
import { scenarios } from './chat-fixtures';
import { installNextLabFixture, nextConversationFixture, nextSessionId } from './next-lab-fixtures';
import { fixtureStorage, isolateNextLab, isLabDocumentLink } from './next-lab-isolation';

function setup() {
  const store = createCockpitStore();
  const lab = installNextLabFixture(store);
  return { store, lab, actions: store.getState() };
}

test('every reused conversation scene has synthetic identities and valid protocol content', () => {
  for (const [scene] of scenarios) {
    const session = nextConversationFixture(scene);
    SessionMeta.parse(session);
    assert.match(session.sessionId, /^fixture-next-/);
    for (const message of session.messages) {
      ChatMessage.parse(message);
      assert.match(message.id, /^fixture-next-/);
      if (message.origin) assert.equal(message.origin.sessionId, session.sessionId);
    }
    for (const request of [session.ask, session.planRequest, session.elicitation]) {
      if (request) assert.match(request.requestId, /^fixture-next-/);
    }
  }
});

test('real App store lifecycle, create/directory/roles/delete remain entirely local', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected backend request'); });
  const { lab, store, actions } = setup();
  actions.init()();
  const directory = await actions.listDir();
  assert.equal(directory.path, '/workspace');
  assert.equal((await actions.listDir('/workspace/cockpit')).entries.length, 0);
  await assert.rejects(actions.listDir('/home/real-user'), /Unknown synthetic directory/);
  const roles = await actions.listRoles();
  lab.operations.hold();
  const creation = actions.newSession('/workspace/cockpit', [roles[2]]);
  assert.equal(store.getState().sessions.length, 6);
  assert.equal(lab.operations.pending()[0].label, 'create');
  lab.operations.release();
  const id = await creation;
  assert.match(id, /^fixture-next-created-/);
  assert.equal(lab.session(id).roles?.[0].roleId, roles[2].roleId);
  assert.equal(lab.session(id).messages.length, 0);
  actions.setActiveId(id);
  const deletion = actions.deleteSession(id);
  assert.ok(lab.session(id));
  lab.operations.release();
  await deletion;
  assert.equal(store.getState().activeId, null);
  assert.throws(() => lab.session(id), /Unknown synthetic session/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('failed and uncertain operations preserve state; incomplete create ACK carries its actual ID', async () => {
  const { lab, store, actions } = setup();
  for (const outcome of ['fail', 'uncertain'] as const) {
    lab.operations.outcome(outcome);
    await assert.rejects(actions.newSession('/workspace'), /Synthetic create/);
    await assert.rejects(actions.deleteSession(nextSessionId), /Synthetic delete/);
    assert.equal(store.getState().sessions.length, 6);
  }
  lab.operations.outcome('success');
  lab.createUncertain();
  await assert.rejects(actions.newSession('/workspace'), error => {
    assert.ok(error instanceof IntentHttpError);
    assert.ok(error.sessionId);
    assert.equal(lab.session(error.sessionId).title, 'Synthetic newly created session');
    return true;
  });
  assert.equal(store.getState().sessions.length, 7);
});

test('pending MCP fixture preserves native pending independently from a failed passive read', async () => {
  const { lab, actions } = setup();
  lab.mcpPending();
  assert.equal((await actions.mcpSession(nextSessionId))[0].status, 'pending');
  lab.operations.outcome('fail');
  await assert.rejects(actions.mcpSession(nextSessionId), /Synthetic mcp.list failure/);
  lab.operations.outcome('success');
  assert.equal((await actions.mcpSession(nextSessionId))[0].status, 'pending');
  lab.mcpPending(false);
  assert.equal((await actions.mcpSession(nextSessionId))[0].status, 'connected');
});

test('model, saved/applied roles, MCP and skills mutate the production-consumed fixture state', async () => {
  const { lab, actions } = setup();
  SessionProjection.parse(await actions.getResources(nextSessionId, ['model', 'models']));
  await actions.setModel(nextSessionId, 'gpt-5.4-mini', { reasoningEffort: 'medium' });
  assert.equal(lab.session(nextSessionId).currentModelId, 'gpt-5.4-mini');
  const roles = await actions.listRoles();
  await actions.addRoles(nextSessionId, [roles[2]]);
  assert.equal(lab.session(nextSessionId).rolesNeedReload, true);
  await actions.reloadSession(nextSessionId);
  assert.equal(lab.session(nextSessionId).rolesNeedReload, false);
  assert.equal((await actions.roleReadiness(nextSessionId)).ready, true);
  const mcp = (await actions.mcpSession(nextSessionId))[0];
  await actions.mcpToggleSession(nextSessionId, mcp.name, false);
  assert.equal((await actions.mcpSession(nextSessionId))[0].status, 'disabled');
  const skill = (await actions.skillsSession(nextSessionId))[0];
  await actions.skillsToggleSession(nextSessionId, skill.name, false);
  assert.equal((await actions.skillsSession(nextSessionId))[0].enabled, false);
  await actions.mcpSetDefault(mcp.name, false);
  assert.equal((await actions.mcpGlobal())[0].defaultOn, false);
  await actions.skillsSetGlobal(skill.name, false);
  assert.equal((await actions.skillsRead(skill.name)).enabled, false);
});

test('held decisions reject obsolete request ownership and retain failed draft text', async () => {
  const { lab, actions } = setup();
  const id = lab.scene('ask', 'fixture-next-decision-test');
  const original = lab.session(id).ask!.requestId;
  lab.operations.hold();
  const obsolete = actions.respondAsk(id, original, 'Old answer', false);
  lab.replaceRequest(id);
  const replacement = lab.session(id).ask!.requestId;
  lab.operations.release();
  assert.equal(await obsolete, false);
  assert.equal(lab.session(id).ask!.requestId, replacement);
  const draft = getDraftSession(id).current(lab.session(id));
  draft.edit('Keep synthetic answer');
  const send = draft.send(actions.sendDraft);
  assert.equal(draft.getSnapshot().pending, true);
  lab.operations.release('fail');
  await send;
  assert.equal(draft.getSnapshot().text, 'Keep synthetic answer');
  assert.equal(draft.getSnapshot().pending, false);
  assert.equal(lab.session(id).ask!.requestId, replacement);
  lab.operations.hold(false);
  assert.equal(await actions.respondAsk(id, replacement, 'New answer', false), true);
  assert.equal(lab.session(id).ask, null);
  assert.equal(lab.session(id).messages.at(-1)?.content, 'New answer');
});

test('plan, elicitation, queued prompts, interrupt and cancellation have distinct outcomes', async () => {
  const { lab, actions } = setup();
  const plan = lab.scene('plan');
  assert.equal(await actions.sendDraft({ intent: 'planSupersede', body: {
    sessionId: plan, requestId: lab.session(plan).planRequest!.requestId, message: 'Synthetic replacement instruction',
  } }), true);
  assert.equal(lab.session(plan).planRequest, null);
  const elicitation = lab.scene('elicitation');
  assert.equal(await actions.respondElicitation(elicitation, lab.session(elicitation).elicitation!.requestId, 'decline'), true);
  assert.equal(lab.session(elicitation).elicitation, null);
  const id = lab.scene('streaming');
  await actions.sendDraft({ intent: 'prompt', body: { sessionId: id, text: 'Synthetic queued prompt' } });
  assert.equal(lab.session(id).queue!.length, 3);
  await actions.removeQueued(id, lab.session(id).queue![0].id);
  assert.equal(lab.session(id).queue!.length, 2);
  assert.equal((await actions.interrupt(id)).interrupted, true);
  assert.equal(lab.session(id).queue!.length, 2);
  await actions.cancel(id);
  assert.equal(lab.session(id).queue!.length, 0);
  assert.equal(lab.session(id).status, 'idle');
});

test('pending prompt targets its original session and reset generations cannot apply stale results', async () => {
  const { lab, actions } = setup();
  const id = lab.scene('empty', 'fixture-next-owner-test');
  lab.operations.hold();
  const request = { intent: 'prompt' as const, body: { sessionId: id, text: 'Owned by first session',
    attachments: [{ type: 'file' as const, path: '/synthetic/fixture-file', displayName: 'Synthetic file' }] } };
  const send = actions.sendDraft(request);
  assert.deepEqual(lab.draftRequests(), [request]);
  const recorded = lab.draftRequests()[0];
  if (recorded.intent !== 'prompt') throw new Error('Expected a prompt fixture');
  recorded.body.attachments = [];
  assert.deepEqual(lab.draftRequests(), [request], 'callers cannot change captured request evidence');
  actions.setActiveId(nextSessionId);
  lab.operations.release();
  assert.equal(await send, true);
  assert.equal(lab.session(id).messages[0].content, 'Owned by first session');
  assert.deepEqual(lab.session(id).messages[0].attachments, request.body.attachments);
  const stale = actions.sendDraft({ intent: 'prompt', body: { sessionId: id, text: 'Obsolete generation' } });
  lab.scene('empty', id);
  lab.operations.release();
  assert.equal(await stale, false);
  assert.equal(lab.session(id).messages.length, 0);
});

test('initial history, bounded prepend, streaming and NativeWindow deduplication reuse real fixture engines', async () => {
  const { lab, actions } = setup();
  const id = lab.scene('initial-history');
  assert.equal(lab.session(id).materialized, false);
  lab.initialHistory(id);
  assert.equal(lab.session(id).materialized, true);
  const first = lab.session(id).messages[0].id;
  await lab.prepend(id);
  assert.ok(lab.session(id).messages.findIndex(message => message.id === first) > 0);
  const before = lab.session(id).messages.at(-1)!.content;
  lab.stream(id, ' delta');
  assert.equal(lab.session(id).messages.at(-1)!.content, before + ' delta');
  await actions.loadMore(id);
  await actions.loadMore(id);
  assert.equal(lab.session(id).hasMore, false);
  const ordered = lab.scene('ordered-events');
  lab.ordered(ordered, 'body');
  const ids = lab.session(ordered).messages.map(message => message.id);
  lab.ordered(ordered, 'duplicate');
  assert.deepEqual(lab.session(ordered).messages.map(message => message.id), ids);
  lab.ordered(ordered, 'older');
  assert.ok(lab.session(ordered).messages.length > ids.length);
});

test('held controls and resources cannot mutate a reset scene; late first-history delivery is discarded', async () => {
  const { lab, actions } = setup();
  const id = lab.scene('ask', 'fixture-next-reset-test');
  const generation = lab.generation(id);
  lab.operations.hold();
  const pending = [actions.cancel(id), actions.deleteSession(id), actions.reloadSession(id),
    actions.setModel(id, 'gpt-5.4-mini')];
  lab.scene('ask', id);
  lab.operations.release();
  for (const operation of pending) await assert.rejects(operation, /target was replaced/);
  assert.ok(lab.session(id).ask);
  lab.scene('empty', id);
  assert.equal(lab.initialHistory(id, false, generation), false);
  assert.equal(lab.session(id).messages.length, 0);
  assert.equal(lab.session(id).materialized, true);
});

test('pre-import isolation refuses application transports and never reads original browser storage', async () => {
  const memory = fixtureStorage();
  memory.setItem('fixture', 'value');
  assert.equal(memory.getItem('fixture'), 'value');
  assert.equal(memory.key(0), 'fixture');
  memory.clear();
  assert.equal(memory.length, 0);
  const target = {
    fetch: async () => 'live',
    XMLHttpRequest: class {},
    EventSource: class {},
    get localStorage(): Storage { throw new Error('Real local storage was read'); },
    get sessionStorage(): Storage { throw new Error('Real session storage was read'); },
  };
  isolateNextLab(target);
  await assert.rejects(target.fetch(), /transport is disabled/);
  assert.throws(() => new target.XMLHttpRequest(), /transport is disabled/);
  assert.throws(() => new target.EventSource(), /transport is disabled/);
  target.sessionStorage.setItem('fixture', 'memory-only');
  assert.equal(target.sessionStorage.getItem('fixture'), 'memory-only');
  assert.equal(target.localStorage.getItem('fixture'), null);
  const page = 'http://127.0.0.1:5173/chat-lab.html?ui=next';
  assert.equal(isLabDocumentLink('/chat-lab.html?ui=next&scene=ask', page), true);
  for (const link of ['/', '/session/real-session', '/next', 'https://example.com/chat-lab.html']) {
    assert.equal(isLabDocumentLink(link, page), false);
  }
});

test('entry selects styles before loading App; next static graph never imports classic styles or App', () => {
  const base = new URL('.', import.meta.url).pathname;
  const entry = readFileSync(resolve(base, 'chat-lab-entry.ts'), 'utf8');
  assert.ok(entry.indexOf('isolateNextLab(window)') < entry.indexOf("import('./next-lab')"));
  assert.match(entry, /else\s*\{\s*await import\('\.\/chat-lab'\)/);
  const visited = new Set<string>();
  const styles = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.endsWith('.css') || specifier.endsWith('.scss')) {
        styles.add(specifier.startsWith('.') ? resolve(dirname(path), specifier) : specifier);
      } else if (specifier.startsWith('.')) {
        const target = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map(suffix => resolve(dirname(path), specifier + suffix))
          .find(candidate => existsSync(candidate) && /\.[jt]sx?$/.test(candidate));
        if (target) visit(target);
      }
    }
  }
  visit(resolve(base, 'next-lab.tsx'));
  assert.ok(visited.has(resolve(base, '../next/App.tsx')));
  assert.ok(visited.has(resolve(base, '../next/conversation/ConversationView.tsx')));
  assert.ok(!visited.has(resolve(base, '../App.tsx')));
  assert.ok(styles.has('@cockpit/ui/styles.css'));
  for (const style of styles) {
    assert.ok(style === '@cockpit/ui/styles.css' || style.includes('/next/') || style.endsWith('/dev/next-lab.css'), style);
  }
});
