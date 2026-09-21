import type { ChatMessage, ChatSession } from '../net/types';
import type { createCockpitStore } from '../net/store';
import { IntentHttpError } from '../net/client';
import { getDraftSession, observeDraftDecisions, retireDraftSession } from '../lib/draftSelection';
import { fixtureSession, type Scenario } from './chat-fixtures';
import { installResourceFixture } from './resource-fixtures';
import { orderedFixture } from './ordered-fixtures';

type Store = ReturnType<typeof createCockpitStore>;
export type FixtureOutcome = 'success' | 'fail' | 'uncertain';
export type OrderedAction = keyof ReturnType<typeof orderedFixture>;
export const nextSessionId = 'fixture-next-workspace-0';

export function fixtureOperations() {
  let held = false;
  let outcome: FixtureOutcome = 'success';
  let sequence = 0;
  const pending = new Map<number, { label: string; resolve(value: FixtureOutcome): void }>();
  const receipts: { id: number; label: string; outcome: FixtureOutcome }[] = [];
  return {
    hold(value = true) { held = value; },
    outcome(value: FixtureOutcome) { outcome = value; },
    pending: () => [...pending].map(([id, { label }]) => ({ id, label })),
    receipts: () => [...receipts],
    release(value: FixtureOutcome = outcome, id?: number) {
      if (id !== undefined && !pending.has(id)) throw new Error('Unknown synthetic pending operation');
      for (const [key, operation] of pending) {
        if (id !== undefined && key !== id) continue;
        pending.delete(key);
        operation.resolve(value);
      }
    },
    async run<T>(label: string, apply: () => T | Promise<T>): Promise<T> {
      const id = ++sequence;
      const result = held ? await new Promise<FixtureOutcome>(resolve => pending.set(id, { label, resolve })) : outcome;
      receipts.push({ id, label, outcome: result });
      if (result !== 'success') throw new Error(result === 'fail'
        ? `Synthetic ${label} failure; no mutation applied.`
        : `Synthetic ${label} outcome unknown; no automatic retry.`);
      return apply();
    },
  };
}

function messagesFor(messages: ChatMessage[], sessionId: string): ChatMessage[] {
  return messages.map(message => ({
    ...message, id: `fixture-next-${message.id}`,
    ...(message.origin ? { origin: { ...message.origin, sessionId, messageId: `fixture-next-${message.origin.messageId}` } } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(tool => ({ ...tool, toolCallId: `fixture-next-${tool.toolCallId}` })) } : {}),
    ...(message.subagent ? { subagent: { ...message.subagent, toolCallId: `fixture-next-${message.subagent.toolCallId}`,
      ...(message.subagent.agentId ? { agentId: `fixture-next-${message.subagent.agentId}` } : {}) } } : {}),
    ...(message.subMessages ? { subMessages: messagesFor(message.subMessages, sessionId) } : {}),
  }));
}

export function nextConversationFixture(scene: Scenario, sessionId = `fixture-next-${scene}`): ChatSession {
  const source = fixtureSession(scene);
  return {
    ...source, sessionId, title: `Synthetic conversation: ${scene}`, cwd: '/workspace/fixture-review',
    messages: messagesFor(source.messages, sessionId),
    queue: source.queue?.map(item => ({ ...item, id: `fixture-next-${item.id}` })),
    ask: source.ask ? { ...source.ask, requestId: `fixture-next-${source.ask.requestId}` } : null,
    planRequest: source.planRequest ? { ...source.planRequest, requestId: `fixture-next-${source.planRequest.requestId}` } : null,
    elicitation: source.elicitation ? { ...source.elicitation, requestId: `fixture-next-${source.elicitation.requestId}` } : null,
  };
}

export function installNextLabFixture(store: Store) {
  const operations = fixtureOperations();
  installResourceFixture(store, true);
  const resources = store.getState();
  const draftRequests: Parameters<typeof resources.sendDraft>[0][] = [];
  const roleCatalog = resources.listRoles();
  let serial = 0;
  let createUncertain = false;
  let mcpPending = false;
  const historyPages = new Map<string, number>();
  const ordered = new Map<string, ReturnType<typeof orderedFixture>>();
  const versions = new Map<string, number>();
  const scenes = new Map<string, Scenario>();
  const find = (id: string) => {
    const session = store.getState().sessions.find(item => item.sessionId === id);
    if (!session || !id.startsWith('fixture-next-')) throw new Error(`Unknown synthetic session: ${id}`);
    return session;
  };
  const update = (id: string, change: (session: ChatSession) => ChatSession) => {
    find(id);
    store.setState(state => ({ sessions: state.sessions.map(session => session.sessionId === id ? change(session) : session) }));
    observeDraftDecisions(store.getState().sessions, true);
  };
  const sessionOperation = <T>(id: string, label: string, apply: () => T | Promise<T>) => {
    find(id);
    const version = versions.get(id);
    return operations.run(label, () => {
      if (versions.get(id) !== version) throw new Error(`Synthetic ${label} target was replaced; result discarded.`);
      find(id);
      return apply();
    });
  };
  const append = (id: string, content: string, role: ChatMessage['role'] = 'assistant',
    attachments?: ChatMessage['attachments']) =>
    update(id, session => ({ ...session, messages: [...session.messages, {
      id: `fixture-next-message-${++serial}`, role, content, timestamp: Date.now(), attachments,
    }] }));
  const decision = async (id: string, field: 'ask' | 'planRequest' | 'elicitation', requestId: string, answer: string) => {
    const version = versions.get(id);
    if (find(id)[field]?.requestId !== requestId) return false;
    return operations.run(field, () => {
      if (versions.get(id) !== version || find(id)[field]?.requestId !== requestId) return false;
      update(id, session => ({ ...session, [field]: null }));
      append(id, answer, 'user');
      return true;
    });
  };
  const loadMore = async (id: string) => {
    const session = find(id);
    if (session.loadingHistory || !session.hasMore) return;
    const version = versions.get(id);
    update(id, value => ({ ...value, loadingHistory: true }));
    try {
      await operations.run('history', () => {
        if (versions.get(id) !== version) return;
        const page = (historyPages.get(id) ?? 0) + 1;
        historyPages.set(id, page);
        update(id, value => ({ ...value, loadingHistory: false, materialized: true, hasMore: page < 3,
          messages: [...messagesFor(fixtureSession('user-time').messages, id).map(message => ({
            ...message, id: `fixture-next-page-${page}-${message.id}`,
          })), ...value.messages] }));
      });
    } catch (error) {
      if (versions.get(id) === version) update(id, value => ({ ...value, loadingHistory: false,
        historyError: error instanceof Error ? error.message : String(error) }));
    }
  };
  store.setState({
    sessions: resources.sessions.map((session, index) => ({
      ...session, sessionId: `fixture-next-workspace-${index}`, title: `Synthetic ${index + 1}: ${session.title}`,
      messages: messagesFor(session.messages, `fixture-next-workspace-${index}`),
    })),
    activeId: nextSessionId,
    init: () => () => {},
    listRoles: () => operations.run('roles.list', resources.listRoles),
    listDir: path => operations.run('directory', () => resources.listDir(path)),
    getResources: (id, fields, signal) => sessionOperation(id, 'resources.read', () => resources.getResources(id, fields, signal)),
    setModel: (id, model, settings) => sessionOperation(id, 'model', () => resources.setModel(id, model, settings)),
    refreshRoles: (id, signal) => sessionOperation(id, 'roles.read', () => resources.refreshRoles(id, signal)),
    addRoles: (id, roles) => sessionOperation(id, 'roles.add', () => resources.addRoles(id, roles)),
    roleReadiness: id => sessionOperation(id, 'roles.readiness', () => resources.roleReadiness(id)),
    mcpGlobal: () => operations.run('mcp.global', resources.mcpGlobal),
    mcpRefresh: () => operations.run('mcp.refresh', resources.mcpRefresh),
    mcpSetDefault: (name, on) => operations.run('mcp.default', () => resources.mcpSetDefault(name, on)),
    mcpSession: id => sessionOperation(id, 'mcp.list', async () => {
      const rows = await resources.mcpSession(id);
      return mcpPending ? rows.map((row, index) => index === 0 ? { ...row, status: 'pending' as const } : row) : rows;
    }),
    mcpToggleSession: (id, name, on) => sessionOperation(id, 'mcp.toggle', () => resources.mcpToggleSession(id, name, on)),
    skillsGlobal: cwd => operations.run('skills.global', () => resources.skillsGlobal(cwd)),
    skillsRead: (name, cwd) => operations.run('skills.read', () => resources.skillsRead(name, cwd)),
    skillsSetGlobal: (name, on, cwd) => operations.run('skills.default', () => resources.skillsSetGlobal(name, on, cwd)),
    skillsSession: id => sessionOperation(id, 'skills.list', () => resources.skillsSession(id)),
    skillsToggleSession: (id, name, on) => sessionOperation(id, 'skills.toggle', () => resources.skillsToggleSession(id, name, on)),
    canSendDraft: draft => {
      const state = store.getState();
      const session = state.sessions.find(value => value.sessionId === draft.sessionId);
      if (state.connState !== 'open' || !state.snapshotReady || !session || session.loading || session.closing
        || (session.compacting && session.status !== 'running')) return 'unavailable';
      if (draft.getSnapshot().retired) return 'retired';
      if (draft.purpose.kind === 'prompt') return;
      if (!session.loaded) return 'unavailable';
      if (draft.purpose.kind === 'elicitation') return 'unsupported';
      if (draft.purpose.kind === 'ask') {
        if (session.ask?.requestId !== draft.purpose.requestId) return 'decision-changed';
        if (session.ask.allowFreeform === false) return 'unsupported';
      } else if (session.planRequest?.requestId !== draft.purpose.requestId) return 'decision-changed';
    },
    newSession: (cwd, roles = []) => operations.run('create', async () => {
      if (!['/workspace', '/workspace/cockpit'].includes(cwd)) throw new Error('Unknown synthetic directory');
      const catalog = await roleCatalog;
      const selected = roles.map(selection => {
        const role = catalog.find(value => value.moduleId === selection.moduleId && value.roleId === selection.roleId);
        if (!role) throw new Error('Unknown synthetic role');
        return role;
      });
      const sessionId = `fixture-next-created-${++serial}`;
      const session: ChatSession = { ...nextConversationFixture('empty', sessionId), cwd,
        title: 'Synthetic newly created session', roles: selected, appliedRoles: selected, rolesNeedReload: false,
        availableModels: store.getState().globalModels, currentModelId: store.getState().globalModels[0]?.modelId };
      store.setState(state => ({ sessions: [session, ...state.sessions] }));
      if (createUncertain) throw new IntentHttpError('Synthetic creation persisted; acknowledgement incomplete', 503, undefined, sessionId);
      return sessionId;
    }),
    deleteSession: id => sessionOperation(id, 'delete', () => {
        versions.set(id, (versions.get(id) ?? 0) + 1);
        store.setState(state => ({ sessions: state.sessions.filter(session => session.sessionId !== id),
          activeId: state.activeId === id ? null : state.activeId }));
        retireDraftSession(id);
      }),
    loadSession: id => sessionOperation(id, 'load', () => update(id, session => ({ ...session, loaded: true, status: 'idle' }))),
    reloadSession: id => sessionOperation(id, 'reload', () => update(id, session => ({
      ...session, loaded: true, appliedRoles: session.roles, rolesNeedReload: false,
    }))),
    refreshList: () => operations.run('refreshList', () => {}),
    sendDraft: request => {
      const { sessionId } = request.body;
      find(sessionId);
      draftRequests.push(structuredClone(request));
      if (request.intent === 'respondAsk') return decision(sessionId, 'ask', request.body.requestId, request.body.answer);
      if (request.intent === 'planSupersede') return decision(sessionId, 'planRequest', request.body.requestId, request.body.message);
      const version = versions.get(sessionId);
      return operations.run('prompt', () => {
        if (versions.get(sessionId) !== version) return false;
        const session = find(sessionId);
        if (session.status === 'running') update(sessionId, value => ({ ...value, queue: [...value.queue ?? [],
          { id: `fixture-next-queue-${++serial}`, text: request.body.text }] }));
        else append(sessionId, request.body.text, 'user', request.body.attachments);
        return true;
      });
    },
    respondAsk: (id, requestId, answer) => decision(id, 'ask', requestId, answer),
    respondPlan: (id, requestId, action) => decision(id, 'planRequest', requestId, action),
    planSupersede: (id, requestId, message) => decision(id, 'planRequest', requestId, message),
    respondElicitation: (id, requestId, action) => decision(id, 'elicitation', requestId, action),
    removeQueued: (id, itemId) => sessionOperation(id, 'queue.remove', () => {
      if (!find(id).queue?.some(item => item.id === itemId)) throw new Error('Unknown synthetic queue item');
      update(id, session => ({ ...session, queue: session.queue?.filter(item => item.id !== itemId) }));
    }),
    cancel: id => sessionOperation(id, 'cancel', () => update(id, session => ({
      ...session, status: 'idle', nativeProcessing: false, cancelling: false, intent: null,
      queue: [], ask: null, planRequest: null, elicitation: null,
    }))),
    interrupt: id => sessionOperation(id, 'interrupt', () => {
      const interrupted = find(id).status === 'running';
      update(id, session => ({ ...session, status: 'idle', nativeProcessing: false, intent: null,
        ask: null, planRequest: null, elicitation: null }));
      return { ok: true as const, interrupted };
    }),
    loadMore,
    retryHistory: id => {
      update(id, session => ({ ...session, error: null, historyError: undefined, historyStale: false,
        partialHistory: false, incompleteBoundary: false, loadingHistory: false, hasMore: true }));
      return loadMore(id);
    },
  });
  return {
    operations,
    draftRequests: () => structuredClone(draftRequests),
    session: find,
    generation: (id: string) => versions.get(id) ?? 0,
    createUncertain(value = true) { createUncertain = value; },
    mcpPending(value = true) { mcpPending = value; },
    scene(scene: Scenario, id = `fixture-next-${scene}`) {
      versions.set(id, (versions.get(id) ?? 0) + 1);
      scenes.set(id, scene);
      const session = { ...nextConversationFixture(scene, id), availableModels: store.getState().globalModels };
      historyPages.delete(id);
      ordered.delete(id);
      store.setState(state => ({ sessions: [session, ...state.sessions.filter(value => value.sessionId !== id)] }));
      observeDraftDecisions(store.getState().sessions, true);
      return id;
    },
    draft(id: string, text: string) { getDraftSession(id).current(find(id)).edit(text); },
    replaceRequest(id: string, scene: 'ask' | 'plan' | 'elicitation' = 'ask') {
      const source = nextConversationFixture(scene, id);
      update(id, session => ({ ...session, ask: source.ask ? { ...source.ask, requestId: `fixture-next-ask-${++serial}` } : null,
        planRequest: source.planRequest ? { ...source.planRequest, requestId: `fixture-next-plan-${++serial}` } : null,
        elicitation: source.elicitation ? { ...source.elicitation, requestId: `fixture-next-elicitation-${++serial}` } : null,
        status: 'running', nativeProcessing: true }));
    },
    append,
    stream(id: string, text = ' Synthetic streaming increment.') {
      update(id, session => ({ ...session, messages: session.messages.map((message, index) =>
        index === session.messages.length - 1 ? { ...message, content: message.content + text, streaming: true } : message) }));
    },
    initialHistory(id: string, short = false, generation = versions.get(id) ?? 0) {
      if (generation !== (versions.get(id) ?? 0)) return false;
      update(id, session => ({ ...session, materialized: true, loadingHistory: false, hasMore: scenes.get(id) === 'history-progressive',
        messages: messagesFor(fixtureSession(short ? 'user-time' : 'reading').messages, id) }));
      return true;
    },
    prepend(id: string) {
      if (!find(id).loadingHistory) update(id, session => ({ ...session, hasMore: true }));
      return loadMore(id);
    },
    ordered(id: string, action: OrderedAction) {
      find(id);
      const source = ordered.get(id) ?? orderedFixture();
      ordered.set(id, source);
      const snapshot = source[action]();
      update(id, session => ({ ...session, ...snapshot, messages: messagesFor(snapshot.messages, id) }));
    },
    connected(value: boolean) { store.setState({ connState: value ? 'open' : 'connecting' }); },
  };
}

export type NextLabFixture = ReturnType<typeof installNextLabFixture>;
