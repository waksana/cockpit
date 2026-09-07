import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.ts';
import { newFoldState } from './fold.ts';
import { makeQueueId } from './lifecycle.ts';
import { FlowRegistry } from './flows.ts';
import type { Flow, SessionEventCtx } from '@cockpit/protocol';

// Every Engine in these tests points prefs at an isolated temp file so NOTHING
// ever reads or writes the real ~/.copilot. The Engine is never start()ed (no SDK
// manager), so we exercise the pure lifecycle/correctness paths against injected
// fake SessionStates + fake SDK sessions.
function makeEngine(opts: {
  mcpServers?: Record<string, Record<string, unknown>>;
  mcpToggleTimeoutMs?: number;
  mcpToggleCleanupTimeoutMs?: number;
  mcpTogglePollMs?: number;
  mcpReloadRetryBaseMs?: number;
} = {}): { engine: any; events: any[] } {
  const prefsFile = join(mkdtempSync(join(tmpdir(), 'cockpit-engine-')), 'prefs.json');
  const engine: any = new Engine({ prefsFile, ...opts });
  const events: any[] = [];
  engine.onEvent((e: any) => events.push(e));
  return { engine, events };
}

function makeState(over: any = {}): any {
  const meta = {
    sessionId: 's1', title: 's1', cwd: '/tmp', createdAt: Date.now(),
    lastActivity: Date.now(), status: 'idle', error: null, loaded: true,
    queue: [], ask: null, ...(over.meta ?? {}),
  };
  const st: any = {
    meta, fold: newFoldState(), sdk: over.sdk ?? null, loadPromise: Promise.resolve(),
    materialized: true, unsub: null, cwd: '/tmp', imageBytes: 0,
    inflightTasks: over.inflightTasks ?? new Set<string>(),
  };
  return st;
}

function inject(engine: any, st: any): void {
  engine.sessions.set(st.meta.sessionId, st);
}

const patches = (events: any[]) => events.filter((e) => e.type === 'session/patch');

// A stateful fake of the SDK pending queue. Mirrors the real surface we use:
// getPendingQueuedItems (kind+displayText), the deprecated messages-only reader,
// clearPendingItems, and enqueueItem.
function fakeQueueSdk(initial: Array<{ kind: string; text: string }>, extra: any = {}): any {
  let items = initial.map((i) => ({ ...i }));
  return {
    getPendingQueuedItems: () => items.map((i) => ({ kind: i.kind, displayText: i.text })),
    getPendingQueuedMessages: () => items.filter((i) => i.kind === 'message').map((i) => i.text),
    clearPendingItems: () => { items = []; },
    enqueueItem: (it: any) => { items.push({ kind: it.kind, text: it.options?.prompt ?? '' }); },
    _items: () => items,
    ...extra,
  };
}

// ── newSession: optional born-as-worker (spawnedBy) ─────────────────────────

// A minimal fake SDK session: newSession only needs createSession→{sessionId,on}.
function fakeSdkSession(sessionId: string): any {
  return { sessionId, on: () => () => {} };
}

function installFlowRegistry(engine: any): { dir: string; registry: FlowRegistry } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-engine-flows-'));
  const registry = new FlowRegistry(dir);
  engine.flowReg = registry;
  return { dir, registry };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeFlowSdk(
  sessionId: string,
  prompts: string[],
  opts: {
    rejectMessage?: string;
    idleBeforeAccept?: boolean;
    autoAccept?: boolean;
    onSend?: (ctx: {
      prompt: string;
      emit: (ev: any) => void;
      pushEvent: (ev: any, live?: boolean) => void;
      events: () => any[];
      setQueueState: (state: 'queued' | 'steering' | 'drained') => void;
      setProcessing: (value: boolean) => void;
    }) => Promise<void> | void;
    initialQueueState?: 'queued' | 'steering';
    onPreflight?: () => Promise<void> | void;
  } = {},
): any {
  const all = new Set<(ev: any) => void>();
  const typed = new Map<string, Set<(ev: any) => void>>();
  const events: any[] = [];
  let queued: string[] = [];
  let steering: string[] = [];
  let processing = false;
  let abortCount = 0;
  let abortSend!: () => void;
  const aborted = new Promise<void>((resolve) => { abortSend = resolve; });
  const add = (type: string, fn: (ev: any) => void) => {
    const set = typed.get(type) ?? new Set<(ev: any) => void>();
    set.add(fn);
    typed.set(type, set);
    return () => set.delete(fn);
  };
  const emit = (ev: any) => {
    for (const fn of all) fn(ev);
    for (const fn of typed.get(ev.type) ?? []) fn(ev);
  };
  const pushEvent = (ev: any, live = true) => {
    events.push(ev);
    if (ev.type === 'user.message' && typeof ev.data?.content === 'string') {
      queued = queued.filter((text) => text !== ev.data.content);
      steering = steering.filter((text) => text !== ev.data.content);
    }
    if (live) emit(ev);
  };
  const setQueueState = (state: 'queued' | 'steering' | 'drained') => {
    const prompt = prompts.at(-1) ?? '';
    queued = state === 'queued' ? [prompt] : [];
    steering = state === 'steering' ? [prompt] : [];
    emit({ type: 'pending_messages.modified', data: {} });
  };
  return {
    sessionId,
    on: (type: string, fn: (ev: any) => void) => (type === '*' ? (all.add(fn), () => all.delete(fn)) : add(type, fn)),
    getEvents: () => [...events],
    getPendingSteeringMessagesDisplayPrompt: () => [...steering],
    getPendingQueuedItems: () => queued.map((displayText) => ({ kind: 'message', displayText })),
    clearPendingItems: () => { queued = []; steering = []; },
    isProcessingMessages: () => processing,
    _emit: emit,
    _setProcessing: (value: boolean) => { processing = value; },
    _abortCount: () => abortCount,
    abort: async () => { abortCount++; processing = false; abortSend(); },
    initializeAndValidateTools: async () => { await opts.onPreflight?.(); },
    send: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      if (opts.initialQueueState) setQueueState(opts.initialQueueState);
      if (opts.rejectMessage) throw new Error(opts.rejectMessage);
      if (opts.onSend) {
        await Promise.race([
          opts.onSend({
            prompt,
            emit,
            pushEvent,
            events: () => [...events],
            setQueueState,
            setProcessing: (value) => { processing = value; },
          }),
          aborted,
        ]);
        return;
      }
      if (opts.idleBeforeAccept) {
        emit({ type: 'session.idle', data: {} });
        return;
      }
      if (opts.autoAccept !== false) {
        pushEvent({ type: 'user.message', data: { content: prompt, source: null }, timestamp: '2026-08-21T00:00:00.000Z' });
      }
    },
  };
}

function fakeSkillsSdk(initial: string[]): any {
  let catalog = [...initial];
  const disabled = new Set<string>();
  let ensureSkillsLoadedCalls = 0;
  return {
    ensureSkillsLoaded: async () => { ensureSkillsLoadedCalls += 1; },
    skills: {
      list: async () => ({
        skills: catalog.map((name) => ({ name, enabled: !disabled.has(name) })),
      }),
    },
    enableSkill: async (name: string) => { disabled.delete(name); },
    disableSkill: async (name: string) => { disabled.add(name); },
    setCatalog: (names: string[]) => { catalog = [...names]; },
    isDisabled: (name: string) => disabled.has(name),
    ensureSkillsLoadedCalls: () => ensureSkillsLoadedCalls,
  };
}

test('flow birth persists strict allowlist and disables excluded skills before first turn', async () => {
  const { engine } = makeEngine();
  const prompts: string[] = [];
  const sdk = Object.assign(fakeSkillsSdk(['A', 'B', 'C']), fakeFlowSdk('worker-1', prompts));
  engine.manager = { createSession: async () => sdk };

  const sessionId = await engine.spawnSession(
    { cwd: 'C:\\tmp', prompt: 'work', skills: ['A', 'B'], mcps: [] },
    'flow-1',
    null,
    {},
  );

  assert.equal(sessionId, 'worker-1');
  assert.deepEqual(prompts, ['work']);
  assert.deepEqual(engine.prefs.skillAllowlistFor(sessionId), ['A', 'B']);
  assert.equal(sdk.ensureSkillsLoadedCalls(), 1);
  assert.equal(sdk.isDisabled('C'), true);
  assert.equal(sdk.isDisabled('A'), false);
  assert.equal(sdk.isDisabled('B'), false);
});

test('session load reapplies strict allowlist against the current catalog', async () => {
  const { engine } = makeEngine();
  const sdk = Object.assign(fakeSkillsSdk(['A', 'B', 'C', 'D']), {
    getEvents: () => [],
    on: () => () => {},
  });
  const st = makeState({ sdk: null, meta: { loaded: false, status: 'unloaded' } });
  st.materialized = false;
  st.loadPromise = null;
  inject(engine, st);
  engine.prefs.setSkillAllowlist('s1', ['A', 'B']);
  engine.manager = { getSession: async () => sdk };

  await engine.ensureLoaded(st);

  assert.equal(sdk.isDisabled('C'), true);
  assert.equal(sdk.isDisabled('D'), true);
  assert.equal(sdk.isDisabled('A'), false);
  assert.equal(sdk.isDisabled('B'), false);
});

test('strict skill allowlist denies skills added after worker birth', async () => {
  const { engine } = makeEngine();
  const sdk = fakeSkillsSdk(['A', 'B', 'C']);
  inject(engine, makeState({ sdk }));
  engine.prefs.setSkillAllowlist('s1', ['A', 'B']);

  const initial = await engine.listSessionSkills('s1');
  assert.deepEqual(
    Object.fromEntries(initial.map((skill: any) => [skill.name, skill.enabled])),
    { A: true, B: true, C: false },
  );
  assert.equal(sdk.isDisabled('C'), true);

  sdk.setCatalog(['A', 'B', 'C', 'D']);
  const refreshed = await engine.listSessionSkills('s1');
  assert.deepEqual(
    Object.fromEntries(refreshed.map((skill: any) => [skill.name, skill.enabled])),
    { A: true, B: true, C: false, D: false },
  );
  assert.equal(sdk.isDisabled('D'), true);
});

test('ordinary session keeps newly added skills enabled without an allowlist', async () => {
  const { engine } = makeEngine();
  const sdk = fakeSkillsSdk(['A', 'B', 'C']);
  inject(engine, makeState({ sdk }));

  const initial = await engine.listSessionSkills('s1');
  assert.equal(initial.find((skill: any) => skill.name === 'C')?.enabled, true);

  sdk.setCatalog(['A', 'B', 'C', 'D']);
  const refreshed = await engine.listSessionSkills('s1');
  assert.equal(refreshed.find((skill: any) => skill.name === 'D')?.enabled, true);
  assert.equal(sdk.isDisabled('D'), false);
});

test('newSession with spawnedBy marks the child a worker (R1 mark + folded meta)', async () => {
  const { engine, events } = makeEngine();
  engine.manager = { createSession: async () => fakeSdkSession('child-1') };
  const id = await engine.newSession('/tmp/x', 'review-master');
  assert.equal(id, 'child-1');
  // Persisted R1 mark (non-trigger-source + UI folding) is set in prefs.
  assert.equal(engine.prefs.spawnedByOf('child-1'), 'review-master');
  // The session/added meta carries spawnedBy from birth (so the UI folds it immediately).
  const added = events.find((e) => e.type === 'session/added' && e.session.sessionId === 'child-1');
  assert.equal(added.session.spawnedBy, 'review-master');
});

test('newSession without spawnedBy creates a normal top-level session', async () => {
  const { engine, events } = makeEngine();
  engine.manager = { createSession: async () => fakeSdkSession('plain-1') };
  await engine.newSession('/tmp/y');
  assert.equal(engine.prefs.spawnedByOf('plain-1'), undefined);
  const added = events.find((e) => e.type === 'session/added' && e.session.sessionId === 'plain-1');
  assert.equal(added.session.spawnedBy, undefined);
});

test('setSpawnedBy reclassifies an existing session (prefs + live patch)', async () => {
  const { engine, events } = makeEngine();
  inject(engine, makeState({ sdk: {}, meta: { sessionId: 's1', spawnedBy: undefined } }));
  const label = await engine.setSpawnedBy('s1', 'review-master');
  assert.equal(label, 'review-master');
  assert.equal(engine.prefs.spawnedByOf('s1'), 'review-master');
  const patched = patches(events).find((e) => e.sessionId === 's1' && e.spawnedBy === 'review-master');
  assert.ok(patched, 'a session/patch carrying spawnedBy should be emitted');
});

test('setSpawnedBy throws on an unknown session', async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.setSpawnedBy('nope', 'review-master'), /unknown session/);
});

// ── C: unload/reload busy guard (incl. compaction) ──────────────────────────

test('unload refuses a running session', () => {
  const { engine } = makeEngine();
  inject(engine, makeState({ sdk: {}, meta: { status: 'running' } }));
  assert.throws(() => engine.unload('s1'), /忙碌/);
});

test('unload refuses a MANUAL compaction (status stays idle)', () => {
  const { engine } = makeEngine();
  inject(engine, makeState({ sdk: {}, meta: { status: 'idle', compacting: true } }));
  assert.throws(() => engine.unload('s1'), /忙碌/);
});

test('unload refuses while a pending choice is open', () => {
  const { engine } = makeEngine();
  inject(engine, makeState({ sdk: {}, meta: { ask: { requestId: 'r', prompt: 'p' } } }));
  assert.throws(() => engine.unload('s1'), /忙碌/);
});

test('unload refuses while a sub-agent is in flight (unverifiable registry → conservative)', () => {
  const { engine } = makeEngine();
  // No taskRegistry → sdkHasRunningAgents() returns null → reaper does NOT clear it.
  inject(engine, makeState({ sdk: {}, inflightTasks: new Set(['t1']) }));
  assert.throws(() => engine.unload('s1'), /忙碌/);
});

test('unload of an idle session succeeds and echoes activeSubagents:0', () => {
  const { engine, events } = makeEngine();
  inject(engine, makeState({ sdk: {} }));
  engine.unload('s1');
  const p = patches(events).at(-1);
  assert.equal(p.status, 'unloaded');
  assert.equal(p.loaded, false);
  assert.equal(p.activeSubagents, 0);
});

test('reload refuses a busy session before touching the (absent) SDK manager', async () => {
  const { engine } = makeEngine();
  inject(engine, makeState({ sdk: {}, meta: { status: 'running' } }));
  await assert.rejects(() => engine.reload('s1'), /忙碌/);
});

// ── B: ghost sub-agent reaper ────────────────────────────────────────────────

test('reaper clears a ghost count when idle and the registry reports no running agent', () => {
  const { engine, events } = makeEngine();
  const sdk = { taskRegistry: { list: () => [] } };
  const st = makeState({ sdk, inflightTasks: new Set(['t1']) });
  inject(engine, st);
  engine.reapGhostSubagents(st);
  assert.equal(st.inflightTasks.size, 0);
  assert.equal(patches(events).at(-1).activeSubagents, 0);
});

test('reaper does NOT clear when the registry still reports a running agent (defer-idle)', () => {
  const { engine } = makeEngine();
  const sdk = { taskRegistry: { list: () => [{ type: 'agent', status: 'running' }] } };
  const st = makeState({ sdk, inflightTasks: new Set(['t1']) });
  inject(engine, st);
  engine.reapGhostSubagents(st);
  assert.equal(st.inflightTasks.size, 1);
});

test('reaper does NOT clear when the registry is unverifiable', () => {
  const { engine } = makeEngine();
  const st = makeState({ sdk: {}, inflightTasks: new Set(['t1']) });
  inject(engine, st);
  engine.reapGhostSubagents(st);
  assert.equal(st.inflightTasks.size, 1);
});

test('reaper does NOT touch a still-running session (only a truly-idle one can be a ghost)', () => {
  const { engine } = makeEngine();
  const sdk = { taskRegistry: { list: () => [] } };
  const st = makeState({ sdk, inflightTasks: new Set(['t1']), meta: { status: 'running' } });
  inject(engine, st);
  engine.reapGhostSubagents(st);
  assert.equal(st.inflightTasks.size, 1);
});

// ── G: session.error → status:'error' (preserved across the trailing idle) ───

test('session.error sets status:error and the trailing session.idle preserves it', () => {
  const { engine, events } = makeEngine();
  const st = makeState({ sdk: {} });
  inject(engine, st);
  engine.onLive(st, { type: 'session.error', data: { message: 'boom' } });
  assert.equal(st.meta.status, 'error');
  assert.equal(st.meta.error, 'boom');
  // The SDK emits session.idle right after; it must NOT mask the error back to idle.
  engine.onLive(st, { type: 'session.idle', data: {} });
  assert.equal(st.meta.status, 'error');
  assert.equal(st.meta.intent ?? null, null); // intent still cleared
  assert.ok(patches(events).some((p) => p.status === 'error' && p.error === 'boom'));
});

// ── D: emit-null discipline ──────────────────────────────────────────────────

test('setModel success path emits null (not omit) for a non-reasoning model', async () => {
  const { engine, events } = makeEngine();
  const sdk = {
    model: { switchTo: async () => {}, getCurrent: async () => ({ modelId: 'm2' }) },
  };
  inject(engine, makeState({ sdk, meta: { currentReasoningEffort: 'high', currentContextTier: 'long_context' } }));
  await engine.setModel('s1', 'm2');
  const withEffort = patches(events).filter((p) => 'currentReasoningEffort' in p);
  const last = withEffort.at(-1);
  assert.equal(last.currentReasoningEffort, null);
  assert.equal(last.currentContextTier, null);
});

test('setMode rollback emits currentMode:null when the prior mode was unset', async () => {
  const { engine, events } = makeEngine();
  const sdk = { mode: { set: async () => { throw new Error('nope'); } } };
  inject(engine, makeState({ sdk })); // currentMode undefined
  await engine.setMode('s1', 'plan');
  const rollback = patches(events).filter((p) => 'currentMode' in p).at(-1);
  assert.equal(rollback.currentMode, null);
});

test('patch() normalizes undefined→null for the clearable model fields', () => {
  const { engine, events } = makeEngine();
  const st = makeState();
  inject(engine, st);
  engine.patch(st, { currentReasoningEffort: undefined, currentContextTier: undefined, currentMode: undefined });
  const p = patches(events).at(-1);
  assert.ok('currentReasoningEffort' in p && p.currentReasoningEffort === null);
  assert.ok('currentContextTier' in p && p.currentContextTier === null);
  assert.ok('currentMode' in p && p.currentMode === null);
});

// ── E: queue hardening ───────────────────────────────────────────────────────

test('removeQueued removes exactly the targeted item (precise)', () => {
  const { engine } = makeEngine();
  const sdk = fakeQueueSdk([
    { kind: 'message', text: 'a' }, { kind: 'message', text: 'b' }, { kind: 'message', text: 'c' },
  ]);
  inject(engine, makeState({ sdk }));
  engine.removeQueued('s1', makeQueueId(1, 'b'));
  assert.deepEqual(sdk._items().map((i: any) => i.text), ['a', 'c']);
});

test('removeQueued relocates by content tag when the index shifted (race)', () => {
  const { engine } = makeEngine();
  const sdk = fakeQueueSdk([
    { kind: 'message', text: 'a' }, { kind: 'message', text: 'b' }, { kind: 'message', text: 'c' },
  ]);
  inject(engine, makeState({ sdk }));
  // A stale id: index 2 (now 'c') but the content tag is still 'b'. The tag wins.
  engine.removeQueued('s1', makeQueueId(2, 'b'));
  assert.deepEqual(sdk._items().map((i: any) => i.text), ['a', 'c']);
});

test('removeQueued is a fail-closed no-op when the tag matches nothing (stale id)', () => {
  const { engine } = makeEngine();
  const sdk = fakeQueueSdk([
    { kind: 'message', text: 'a' }, { kind: 'message', text: 'b' },
  ]);
  inject(engine, makeState({ sdk }));
  engine.removeQueued('s1', makeQueueId(0, 'gone'));
  assert.deepEqual(sdk._items().map((i: any) => i.text), ['a', 'b']);
});

test('removeQueued refuses (no-op) when a non-message survivor would be lost', () => {
  const { engine } = makeEngine();
  const sdk = fakeQueueSdk([
    { kind: 'message', text: 'a' }, { kind: 'command', text: '/compact' },
  ]);
  inject(engine, makeState({ sdk }));
  // Target the message; the surviving command can't be faithfully rebuilt → no-op.
  engine.removeQueued('s1', makeQueueId(0, 'a'));
  assert.deepEqual(sdk._items().map((i: any) => i.text), ['a', '/compact']);
});

test('cancel drains the SDK queue and reflects queue:[] in its silent patch', () => {
  const { engine, events } = makeEngine();
  let aborted = false;
  const sdk = fakeQueueSdk([{ kind: 'message', text: 'queued-behind' }], { abort: () => { aborted = true; } });
  inject(engine, makeState({ sdk, meta: { status: 'running' } }));
  engine.cancel('s1');
  assert.equal(aborted, true);
  assert.equal(sdk._items().length, 0);
  const p = patches(events).at(-1);
  assert.deepEqual(p.queue, []);
  assert.equal(p.status, 'idle');
});

// ── F: lastActivity forwarding (throttled) ───────────────────────────────────

test('a folded message forwards lastActivity, throttled to one patch per window', () => {
  const { engine, events } = makeEngine();
  const st = makeState({ sdk: {} });
  inject(engine, st);
  engine.onLive(st, { type: 'user.message', data: { content: 'hello', source: null }, id: 'u1' });
  engine.onLive(st, { type: 'user.message', data: { content: 'world', source: null }, id: 'u2' });
  const laPatches = patches(events).filter((p) => 'lastActivity' in p);
  assert.equal(laPatches.length, 1); // second is within the throttle window → suppressed
  assert.equal(typeof laPatches[0].lastActivity, 'number');
  // both messages still upserted
  assert.equal(events.filter((e) => e.type === 'msg/upsert').length, 2);
});

// ── Reconnect catch-up: append a small tail, but RESET when too far behind ────

function withMessages(n: number): any {
  const st = makeState();
  st.fold.messages = Array.from({ length: n }, (_, k) => ({ id: 'm' + k }));
  return st;
}

test('history(afterMsgId) appends the tail for a small gap (<= one window)', async () => {
  const { engine, events } = makeEngine();
  const st = withMessages(50);
  inject(engine, st);
  // anchor near the end: 4 messages arrived after it (50 - 1 - 45) → within a window
  await engine.history('s1', undefined, undefined, 'm45');
  const ev = events.filter((e) => e.type === 'session/history-page').at(-1);
  assert.ok(ev, 'expected a history-page');
  assert.equal(ev.page.append, true);
  assert.equal(ev.page.messages.length, 5); // anchor inclusive: m45..m49
  assert.equal(ev.page.messages[0].id, 'm45');
  assert.equal(events.some((e) => e.type === 'session/reset'), false);
});

test('history(afterMsgId) resets to the latest window when the client fell too far behind', async () => {
  const { engine, events } = makeEngine();
  const st = withMessages(50);
  inject(engine, st);
  // anchor far back: 44 messages arrived after it (50 - 1 - 5) → more than one window
  await engine.history('s1', undefined, undefined, 'm5');
  const ev = events.filter((e) => e.type === 'session/reset').at(-1);
  assert.ok(ev, 'expected a session/reset');
  assert.equal(ev.page.latest, true);
  assert.equal(ev.page.messages.length, 30); // HISTORY_PAGE window
  assert.equal(ev.page.messages.at(-1).id, 'm49'); // newest
  assert.equal(ev.page.hasMore, true);
  assert.equal(events.some((e) => e.type === 'session/history-page'), false);
});

test('history(afterMsgId) resets when the anchor is gone (compact/rewind while away)', async () => {
  const { engine, events } = makeEngine();
  const st = withMessages(50);
  inject(engine, st);
  await engine.history('s1', undefined, undefined, 'does-not-exist');
  const ev = events.filter((e) => e.type === 'session/reset').at(-1);
  assert.ok(ev, 'expected a session/reset');
  assert.equal(ev.page.latest, true);
  assert.equal(ev.page.messages.length, 30);
});

// ── refreshList bidirectional reconcile: prune vanished shadow "ghosts" ──────
// refreshList must both ADD externally-created sessions and PRUNE the shadow
// entries it once discovered whose backing store row later disappears — otherwise
// they linger in the sidebar and throw `session not found` on open. The prune must
// NEVER touch a session cockpit created / is loading / has loaded.

test('refreshList discovers an externally-created session and adds it to the map (a)', async () => {
  const { engine, events } = makeEngine();
  engine.agentStatus = 'up'; // like the live 8s poll: fan out session/added
  engine.manager = { listSessions: async () => [{ sessionId: 'ext-1' }] };

  await engine.refreshList();
  const st = engine.sessions.get('ext-1');
  assert.ok(st, 'externally-created session present in listSessions is discovered');
  assert.equal(st.materialized, false); // pure shadow — not cockpit-owned
  assert.equal(st.sdk, null);
  assert.ok(events.some((e) => e.type === 'session/added' && e.session.sessionId === 'ext-1'));
});

test('refreshList prunes a discovered shadow once it vanishes from listSessions and emits session/removed (b)', async () => {
  const { engine, events } = makeEngine();
  engine.agentStatus = 'up';
  let listed: any[] = [{ sessionId: 'ext-1' }];
  engine.manager = { listSessions: async () => listed };

  // First poll discovers it as a shadow…
  await engine.refreshList();
  assert.ok(engine.sessions.has('ext-1'));

  // …then its backing store row disappears → next poll prunes the ghost.
  listed = [];
  await engine.refreshList();
  assert.equal(engine.sessions.has('ext-1'), false, 'the ghost is pruned from the map');
  assert.ok(
    events.some((e) => e.type === 'session/removed' && e.sessionId === 'ext-1'),
    'a session/removed is emitted so every sidebar drops the ghost',
  );
});

test('refreshList never prunes a materialized/loaded session even when listSessions omits it (c, guard)', async () => {
  const { engine, events } = makeEngine();
  engine.agentStatus = 'up';
  engine.manager = { listSessions: async () => [] }; // worst-case: listSessions never mentions it (jitter/birth race)

  // A cockpit-owned session: materialized + holding an sdk handle (what newSession/loadSession set).
  const own = makeState({ sdk: {}, meta: { sessionId: 'own-1' } });
  inject(engine, own);

  await engine.refreshList();
  assert.ok(engine.sessions.has('own-1'), 'guard 2 keeps a cockpit-owned session absent from listSessions');
  assert.equal(
    events.some((e) => e.type === 'session/removed' && e.sessionId === 'own-1'),
    false,
    'no session/removed is emitted for a materialized/loaded session',
  );
});

// ── O45: read-only per-session MCP state ─────────────────────────────────────

test('a batch of mcp/session reads returns unloaded state without queueing cold loads', async () => {
  const { engine } = makeEngine({
    mcpServers: {
      alpha: { command: 'alpha' },
      beta: { command: 'beta' },
    },
  });
  let getSessionCalls = 0;
  engine.manager = {
    getSession: async () => {
      getSessionCalls++;
      return await new Promise<any>(() => {});
    },
  };

  const states: any[] = [];
  for (let i = 0; i < 9; i++) {
    const sessionId = `cold-${i}`;
    const st = makeState({
      meta: { sessionId, title: sessionId, loaded: false, status: 'unloaded' },
    });
    st.sdk = null;
    st.loadPromise = null;
    st.materialized = false;
    states.push(st);
    inject(engine, st);
    engine.prefs.setSessionMcp(sessionId, 'alpha', true);
  }

  const deadline = Symbol('deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reads = Promise.all(states.map((st) => engine.listSessionMcp(st.meta.sessionId)));
  const outcome = await Promise.race([
    reads,
    new Promise<typeof deadline>((resolve) => { timer = setTimeout(() => resolve(deadline), 250); }),
  ]);
  if (timer) clearTimeout(timer);

  assert.notEqual(outcome, deadline, 'read-only MCP state must not wait behind the birth mutex');
  assert.equal(getSessionCalls, 0, 'mcp/session must not call manager.getSession for an unloaded session');
  for (const result of outcome as Awaited<typeof reads>) {
    assert.equal(result.loaded, false);
    assert.deepEqual(
      result.servers.map((server: any) => [server.name, server.enabled, server.status]),
      [
        ['alpha', true, 'unloaded'],
        ['beta', false, 'disabled'],
      ],
    );
  }
  for (const st of states) {
    assert.equal(st.materialized, false);
    assert.equal(st.sdk, null);
    assert.equal(st.meta.loaded, false);
  }
});

test('mcp/session preserves live status for an already-loaded session', async () => {
  const { engine } = makeEngine({
    mcpServers: {
      alpha: { command: 'alpha' },
      beta: { command: 'beta' },
    },
  });
  let ensureMcpLoadedCalls = 0;
  const sdk = {
    ensureMcpLoaded: async () => {
      ensureMcpLoadedCalls++;
      return await new Promise<void>(() => {});
    },
    getMcpServerSummaries: () => [
      { name: 'alpha', status: 'connected' },
      { name: 'beta', status: 'failed', error: 'initialize timed out' },
    ],
  };
  inject(engine, makeState({ sdk }));
  engine.prefs.setSessionMcp('s1', 'alpha', true);
  engine.prefs.setSessionMcp('s1', 'beta', true);

  const result = await engine.listSessionMcp('s1');

  assert.equal(result.loaded, true);
  assert.equal(ensureMcpLoadedCalls, 0, 'a status read must not start or await MCP handshakes');
  assert.deepEqual(
    result.servers.map((server: any) => [server.name, server.status, server.error]),
    [
      ['alpha', 'connected', undefined],
      ['beta', 'failed', 'initialize timed out'],
    ],
  );
  await assert.rejects(() => engine.listSessionMcp('missing'), /unknown session/);
});

test('MCP toggle initializes a cold-loaded host and persists only after connected', async () => {
  const { engine } = makeEngine({
    mcpServers: {
      alpha: { command: 'alpha' },
      beta: { command: 'beta' },
    },
  });
  const steps: string[] = [];
  let initialized = false;
  let status: 'disabled' | 'connected' = 'disabled';
  const sdk = {
    sessionId: 'cold-toggle',
    on: () => () => {},
    getEvents: () => [],
    ensureMcpLoaded: async () => {
      steps.push('initialize');
      initialized = true;
    },
    enableMcpServer: async (name: string) => {
      steps.push(`enable:${name}`);
      if (!initialized) throw new Error('No MCP host initialized');
      status = 'connected';
    },
    getMcpServerSummaries: () => [{ name: 'alpha', status }],
  };
  engine.manager = {
    getSession: async () => {
      steps.push('load');
      return sdk;
    },
  };
  const st = makeState({
    meta: { sessionId: 'cold-toggle', title: 'cold-toggle', loaded: false, status: 'unloaded' },
  });
  st.sdk = null;
  st.loadPromise = null;
  st.materialized = false;
  inject(engine, st);

  const result = await engine.toggleSessionMcp('cold-toggle', 'alpha', true);
  assert.deepEqual(steps, ['load', 'initialize', 'enable:alpha']);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'connected');
  assert.deepEqual(engine.prefs.enabledMcpFor('cold-toggle'), ['alpha']);
});

test('MCP disable succeeds live before persisting the preference', async () => {
  const { engine } = makeEngine({ mcpServers: { alpha: { command: 'alpha' } } });
  let status: 'connected' | 'disabled' = 'connected';
  const steps: string[] = [];
  const sdk = {
    getMcpServerSummaries: () => [{ name: 'alpha', status }],
    disableMcpServer: async (name: string) => {
      steps.push(`disable:${name}`);
      status = 'disabled';
    },
  };
  inject(engine, makeState({ sdk }));
  engine.prefs.setSessionMcp('s1', 'alpha', true);

  const result = await engine.toggleSessionMcp('s1', 'alpha', false);

  assert.deepEqual(steps, ['disable:alpha']);
  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'disabled');
  assert.deepEqual(engine.prefs.enabledMcpFor('s1'), []);
});

test('MCP disable stays observable when live status changes before SDK work settles', async () => {
  const { engine } = makeEngine({
    mcpServers: { alpha: { command: 'alpha' } },
    mcpToggleTimeoutMs: 50,
    mcpToggleCleanupTimeoutMs: 5,
    mcpTogglePollMs: 5,
  });
  let status: 'connected' | 'disabled' = 'connected';
  let finishDisable: (() => void) | undefined;
  const sdk = {
    getMcpServerSummaries: () => [{ name: 'alpha', status }],
    disableMcpServer: async () => {
      status = 'disabled';
      await new Promise<void>((resolve) => { finishDisable = resolve; });
    },
  };
  const st = makeState({ sdk });
  inject(engine, st);
  engine.prefs.setSessionMcp('s1', 'alpha', true);

  const result = await engine.toggleSessionMcp('s1', 'alpha', false);
  assert.equal(result.operation.state, 'settling');
  assert.equal(result.enabled, true, 'preference must wait for SDK completion');
  assert.equal(st.meta.activeMcpOperations, 1);

  finishDisable?.();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const readback = await engine.listSessionMcp('s1');
  assert.equal(readback.servers[0].operation?.state, 'succeeded');
  assert.equal(readback.servers[0].enabled, false);
  assert.equal(st.meta.activeMcpOperations, 0);
});

test('MCP enable returns target failure, cleans up live state, and does not persist', async () => {
  const { engine } = makeEngine({
    mcpServers: { alpha: { command: 'alpha' } },
    mcpToggleTimeoutMs: 100,
    mcpToggleCleanupTimeoutMs: 100,
    mcpTogglePollMs: 5,
  });
  let status: 'disabled' | 'failed' = 'disabled';
  let stopped = 0;
  const sdk = {
    ensureMcpLoaded: async () => {},
    enableMcpServer: async () => { status = 'failed'; },
    disableMcpServer: async () => { status = 'disabled'; },
    getMcpServerSummaries: () => [{
      name: 'alpha',
      status,
      ...(status === 'failed' ? { error: 'authentication metadata unavailable' } : {}),
    }],
    getMcpHost: () => ({ stopServer: async () => { stopped++; } }),
  };
  inject(engine, makeState({ sdk }));

  const result = await engine.toggleSessionMcp('s1', 'alpha', true);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /authentication metadata unavailable/);
  assert.equal(result.operation.state, 'failed');
  assert.equal(stopped, 2);
  assert.deepEqual(engine.prefs.enabledMcpFor('s1'), []);
});

test('MCP hung enable is cancelled inside the server bound with no work left after response', async () => {
  const { engine } = makeEngine({
    mcpServers: { alpha: { command: 'alpha' } },
    mcpToggleTimeoutMs: 20,
    mcpToggleCleanupTimeoutMs: 100,
    mcpTogglePollMs: 5,
    mcpReloadRetryBaseMs: 10,
  });
  let status: 'disabled' | 'pending' = 'disabled';
  let active = false;
  let reloads = 0;
  let rejectEnable: ((error: Error) => void) | undefined;
  const sdk = {
    ensureMcpLoaded: async () => {},
    enableMcpServer: async () => {
      status = 'pending';
      active = true;
      await new Promise<void>((_resolve, reject) => { rejectEnable = reject; });
    },
    disableMcpServer: async () => { status = 'disabled'; },
    getMcpServerSummaries: () => [{ name: 'alpha', status }],
    getMcpHost: () => ({
      stopServer: async () => {
        active = false;
        rejectEnable?.(new Error('connection aborted'));
      },
    }),
    reloadMcpServers: async () => {
      reloads++;
      if (reloads === 1) throw new Error('transient reload failure');
    },
  };
  const st = makeState({ sdk });
  inject(engine, st);
  const started = Date.now();

  const toggling = engine.toggleSessionMcp('s1', 'alpha', true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await engine.refreshMcp();
  const result = await toggling;
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(Date.now() - started < 500, 'server-side timeout must beat the transport timeout');
  assert.equal(result.ok, false);
  assert.equal(result.operation.state, 'failed');
  assert.match(result.error, /20ms server-side bound/);
  assert.equal(active, false, 'no target connection work may remain after the terminal response');
  assert.equal(st.meta.activeMcpOperations, 0);
  assert.equal(reloads, 2, 'a deferred refresh must retry after a transient replay failure');
  assert.deepEqual(engine.prefs.enabledMcpFor('s1'), []);
});

test('deferred MCP reload failures stop after a bounded attempt count', async () => {
  const { engine } = makeEngine({
    mcpServers: { alpha: { command: 'alpha' } },
    mcpReloadRetryBaseMs: 10,
  });
  let reloads = 0;
  let rejectFirst: ((error: Error) => void) | undefined;
  const sdk = {
    reloadMcpServers: async () => {
      reloads++;
      if (reloads === 1) {
        await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      }
      throw new Error('persistent reload failure');
    },
  };
  const st = makeState({ sdk });
  inject(engine, st);
  engine.mcpReloadPendingSessions.add('s1');

  engine.resumePendingMcpReload(st);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    () => engine.reloadMcpFor(st),
    /already in progress/,
    'an overlapping request is deferred behind the owned replay',
  );
  rejectFirst?.(new Error('first replay failed'));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(reloads, 3);
  assert.equal(engine.mcpReloadPendingSessions.has('s1'), true, 'failed deferred work remains observable');
  assert.equal(engine.mcpReloadRetryTimers.has('s1'), false, 'no unbounded retry timer remains');
  assert.equal(st.meta.activeMcpOperations, 0, 'bounded retry exhaustion must not block graceful restart');
});

test('MCP unabortable SDK work remains explicit and deduplicated instead of ambiguous', async () => {
  const { engine } = makeEngine({
    mcpServers: { alpha: { command: 'alpha' } },
    mcpToggleTimeoutMs: 15,
    mcpToggleCleanupTimeoutMs: 15,
    mcpTogglePollMs: 5,
  });
  let enableCalls = 0;
  let status: 'disabled' | 'pending' = 'disabled';
  const sdk = {
    ensureMcpLoaded: async () => {},
    enableMcpServer: async () => {
      enableCalls++;
      status = 'pending';
      await new Promise<void>(() => {});
    },
    disableMcpServer: async () => { status = 'disabled'; },
    getMcpServerSummaries: () => [{ name: 'alpha', status }],
    getMcpHost: () => ({ stopServer: async () => {} }),
  };
  const st = makeState({ sdk });
  inject(engine, st);

  const first = engine.toggleSessionMcp('s1', 'alpha', true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const duplicate = await engine.toggleSessionMcp('s1', 'alpha', true);
  const result = await first;
  const readback = await engine.listSessionMcp('s1');

  assert.equal(enableCalls, 1, 'same-target retries must not start duplicate SDK work');
  assert.equal(result.operation.state, 'settling');
  assert.equal(duplicate.operation.id, result.operation.id);
  assert.match(duplicate.error, /no duplicate mutation was started/);
  assert.equal(readback.servers[0].operation?.id, result.operation.id);
  assert.equal(readback.servers[0].operation?.state, 'settling');
  assert.equal(st.meta.activeMcpOperations, 1, 'graceful restart must remain blocked while SDK work settles');
  assert.deepEqual(engine.prefs.enabledMcpFor('s1'), []);
  await assert.rejects(
    () => engine.reloadSessionMcp('s1'),
    /MCP toggle is in progress/,
    'reload must not race and overwrite a settling toggle',
  );
  await assert.rejects(
    () => engine.deleteSession('s1'),
    /MCP operation is still in progress/,
    'trash must not let a late toggle recreate session preferences',
  );
});

test('MCP cleanup failure stays settling until live status confirms disabled', async () => {
  const { engine } = makeEngine({
    mcpServers: { alpha: { command: 'alpha' } },
    mcpToggleTimeoutMs: 50,
    mcpToggleCleanupTimeoutMs: 5,
    mcpTogglePollMs: 5,
  });
  let status: 'disabled' | 'failed' = 'disabled';
  let disableCalls = 0;
  const sdk = {
    ensureMcpLoaded: async () => {},
    enableMcpServer: async () => { status = 'failed'; },
    disableMcpServer: async () => {
      disableCalls++;
      if (disableCalls < 4) throw new Error('temporary stop failure');
      status = 'disabled';
    },
    getMcpServerSummaries: () => [{ name: 'alpha', status, error: status === 'failed' ? 'target failed' : undefined }],
    getMcpHost: () => ({ stopServer: async () => { throw new Error('close failed'); } }),
  };
  const st = makeState({ sdk });
  inject(engine, st);

  const result = await engine.toggleSessionMcp('s1', 'alpha', true);
  assert.equal(result.operation.state, 'settling');
  assert.equal(st.meta.activeMcpOperations, 1);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const readback = await engine.listSessionMcp('s1');
  assert.equal(readback.servers[0].operation?.state, 'failed');
  assert.equal(st.meta.activeMcpOperations, 0);
  assert.equal(disableCalls, 4);
});

// ── A: MCP-birth serialization (concurrent cold-starts must not overlap) ─────
// The root-cause fix: when several sessions are born in the same tick (a boot
// catch-up replaying due crons, a hook/schedule burst), each SDK createSession/
// getSession cold-starts a stdio MCP child. Un-serialized, N children fight for CPU
// during initialize and the SDK's timeout blows → every attach fails -32001. The
// mcpBirth gate must let only ONE such birth run at a time.
test('MCP-attaching births are serialized — cold-starts never overlap', async () => {
  const { engine } = makeEngine();
  let active = 0;
  let maxConcurrent = 0;
  let n = 0;
  engine.manager = {
    createSession: async () => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 15)); // simulate the initialize handshake
      active--;
      return fakeSdkSession('birth-' + (++n));
    },
  };
  // Fire several births concurrently (the boot-catch-up / hook-burst shape).
  await Promise.all([
    engine.newSession('/tmp/a'),
    engine.newSession('/tmp/b'),
    engine.newSession('/tmp/c'),
    engine.newSession('/tmp/d'),
  ]);
  assert.equal(maxConcurrent, 1, 'the gate must let only one MCP cold-start run at a time');
});

test('MCP-enabled flow births stay serialized through first-prompt persistence', async () => {
  const { engine } = makeEngine();
  let births = 0;
  let activeBirthPreflight = 0;
  let maxConcurrentBirthPreflight = 0;
  let activePreflight = 0;
  let maxConcurrentPreflight = 0;
  const prompts: string[] = [];
  engine.manager = {
    createSession: async () => fakeFlowSdk(`mcp-flow-${++births}`, prompts, {
      onPreflight: async () => {
        activeBirthPreflight++;
        maxConcurrentBirthPreflight = Math.max(maxConcurrentBirthPreflight, activeBirthPreflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeBirthPreflight--;
      },
      onSend: async ({ prompt, pushEvent }) => {
        activePreflight++;
        maxConcurrentPreflight = Math.max(maxConcurrentPreflight, activePreflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
        activePreflight--;
      },
    }),
  };

  const results = await Promise.all([
    engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'mcp-one', mcps: ['test-mcp'] }, 'mcp-flow-one', null, {}),
    engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'mcp-two', mcps: ['test-mcp'] }, 'mcp-flow-two', null, {}),
    engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'mcp-three', mcps: ['test-mcp'] }, 'mcp-flow-three', null, {}),
  ]);

  assert.deepEqual(results, ['mcp-flow-1', 'mcp-flow-2', 'mcp-flow-3']);
  assert.equal(maxConcurrentBirthPreflight, 1);
  assert.equal(maxConcurrentPreflight, 1);
  assert.deepEqual(prompts, ['mcp-one', 'mcp-two', 'mcp-three']);
});

test('three concurrent MCP-enabled scheduled births serialize eager preflight and each persist one prompt', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  let births = 0;
  let activePreflight = 0;
  let maxConcurrentPreflight = 0;
  engine.manager = {
    createSession: async () => fakeFlowSdk(`scheduled-mcp-${++births}`, prompts, {
      onPreflight: async () => {
        activePreflight++;
        maxConcurrentPreflight = Math.max(maxConcurrentPreflight, activePreflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activePreflight--;
      },
    }),
  };
  registry.write({
    id: 'scheduled-mcp-flow',
    action: {
      kind: 'spawn-session',
      template: { cwd: 'C:\\tmp', prompt: 'scheduled-mcp-prompt', mcps: ['test-mcp'] },
    },
  });

  try {
    const at = Date.now() + 80;
    assert.equal(engine.addFlowSchedule({ flowId: 'scheduled-mcp-flow', at }).ok, true);
    assert.equal(engine.addFlowSchedule({ flowId: 'scheduled-mcp-flow', at }).ok, true);
    assert.equal(engine.addFlowSchedule({ flowId: 'scheduled-mcp-flow', at }).ok, true);
    engine.flowSchedReg.arm();
    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(births, 3);
    assert.equal(maxConcurrentPreflight, 1);
    assert.deepEqual(prompts, [
      'scheduled-mcp-prompt',
      'scheduled-mcp-prompt',
      'scheduled-mcp-prompt',
    ]);
    for (let i = 1; i <= 3; i++) {
      const st = engine.sessions.get(`scheduled-mcp-${i}`);
      assert.equal(st?.meta.launchState, null);
      assert.equal(
        st?.sdk?.getEvents().filter((ev: any) =>
          ev.type === 'user.message' && ev.data?.content === 'scheduled-mcp-prompt').length,
        1,
      );
    }
  } finally {
    engine.flowSchedReg.disarm();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual MCP-enabled flow run uses the same eager preflight boundary', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  let preflights = 0;
  engine.manager = {
    createSession: async () => fakeFlowSdk('manual-mcp-1', prompts, {
      onPreflight: () => { preflights++; },
    }),
  };
  registry.write({
    id: 'manual-mcp-flow',
    action: {
      kind: 'spawn-session',
      template: { cwd: 'C:\\tmp', prompt: 'manual-mcp-prompt', mcps: ['test-mcp'] },
    },
  });

  try {
    const result = await engine.runFlow('manual-mcp-flow', null);
    assert.deepEqual(result, { ok: true, sessionId: 'manual-mcp-1' });
    assert.equal(preflights, 1);
    assert.deepEqual(prompts, ['manual-mcp-prompt']);
    assert.equal(engine.sessions.get('manual-mcp-1')?.meta.launchState, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP birth waits for eager-preflight processQueue work to become quiescent before dispatch', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '40',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    const sdk = fakeFlowSdk('mcp-preflight-quiescent-1', prompts);
    let sentWhileProcessing = false;
    sdk.initializeAndValidateTools = async () => {
      sdk._setProcessing(true);
      setTimeout(() => {
        sdk._setProcessing(false);
        sdk._emit({ type: 'session.idle', data: {} });
      }, 5);
    };
    const baseSend = sdk.send.bind(sdk);
    sdk.send = async (options: any) => {
      sentWhileProcessing = sdk.isProcessingMessages();
      return baseSend(options);
    };
    engine.manager = { createSession: async () => sdk };

    const sessionId = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'after-real-preflight-region', mcps: ['test-mcp'] },
      'mcp-preflight-quiescent-flow',
      null,
      {},
    );

    assert.equal(sessionId, 'mcp-preflight-quiescent-1');
    assert.equal(sentWhileProcessing, false);
    assert.deepEqual(prompts, ['after-real-preflight-region']);
  });
});

test('timed-out MCP preflight quarantines later births until its processQueue becomes idle', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    let births = 0;
    const stuck = fakeFlowSdk('mcp-preflight-stuck-1', prompts);
    stuck.initializeAndValidateTools = async () => { stuck._setProcessing(true); };
    engine.manager = {
      createSession: async () => {
        births++;
        return births === 1 ? stuck : fakeFlowSdk(`mcp-preflight-recovered-${births}`, prompts);
      },
    };

    const first = engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'must-not-dispatch-one', mcps: ['test-mcp'] },
      'mcp-preflight-stuck-flow',
      null,
      {},
    );
    const second = engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'must-not-dispatch-two', mcps: ['test-mcp'] },
      'mcp-preflight-blocked-flow',
      null,
      {},
    );
    const failed = await Promise.allSettled([first, second]);

    assert.equal(failed[0]?.status, 'rejected');
    assert.match(String((failed[0] as PromiseRejectedResult).reason), /preflight processing remained active/);
    assert.equal(failed[1]?.status, 'rejected');
    assert.match(String((failed[1] as PromiseRejectedResult).reason), /MCP birth blocked: prior flow worker/);
    assert.equal(births, 1, 'the quarantined successor must not overlap createSession');
    assert.deepEqual(prompts, []);

    stuck._setProcessing(false);
    stuck._emit({ type: 'session.idle', data: {} });
    await Promise.resolve();
    const recovered = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'dispatch-after-quiescence', mcps: ['test-mcp'] },
      'mcp-preflight-recovered-flow',
      null,
      {},
    );
    assert.equal(recovered, 'mcp-preflight-recovered-2');
    assert.deepEqual(prompts, ['dispatch-after-quiescence']);
  });
});

// ── B: healFailedMcp self-heal net (bounded backoff reconnect) ──────────────
// Even with births serialized, a wanted MCP can still surface `failed` under a
// transient timeout. A timeout is recoverable — a plain reconnect (reloadMcpServers,
// which re-spawns the stdio child) flips it to connected once the storm passes.

test('healFailedMcp reconnects a failed (timeout) MCP and stops once connected', async () => {
  const { engine } = makeEngine();
  let reloads = 0;
  let status = 'failed';
  const sdk = {
    on: () => () => {},
    getMcpServerSummaries: () => [{ name: 'cockpit', status }],
    reloadMcpServers: async () => { reloads++; status = 'connected'; },
  };
  const st = makeState({ sdk });
  inject(engine, st);
  await engine.healFailedMcp(st, new Set(['cockpit']), { attempts: 3, delayMs: 1 });
  assert.equal(reloads, 1, 'one reconnect flips it to connected; no further retries');
  assert.equal(status, 'connected');
});

test('healFailedMcp leaves a needs-auth (non-timeout) MCP alone', async () => {
  const { engine } = makeEngine();
  let reloads = 0;
  const sdk = {
    on: () => () => {},
    getMcpServerSummaries: () => [{ name: 'cockpit', status: 'needs-auth' }],
    reloadMcpServers: async () => { reloads++; },
  };
  const st = makeState({ sdk });
  inject(engine, st);
  await engine.healFailedMcp(st, new Set(['cockpit']), { attempts: 3, delayMs: 1 });
  assert.equal(reloads, 0, 'needs-auth is not a timeout — a reconnect cannot fix it, so never retried');
});

test('healFailedMcp gives up after a bounded number of retries (never infinite)', async () => {
  const { engine } = makeEngine();
  let reloads = 0;
  const sdk = {
    on: () => () => {},
    getMcpServerSummaries: () => [{ name: 'cockpit', status: 'failed' }], // never recovers
    reloadMcpServers: async () => { reloads++; },
  };
  const st = makeState({ sdk });
  inject(engine, st);
  await engine.healFailedMcp(st, new Set(['cockpit']), { attempts: 2, delayMs: 1 });
  assert.equal(reloads, 2, 'exactly `attempts` reconnects, then it stops — bounded');
});

// ── Flow gate interpolation: manual + scheduled execution ───────────────────

test('scheduled flow runs its gate and interpolates params before spawning', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  let births = 0;
  engine.manager = { createSession: async () => fakeFlowSdk(`scheduled-${++births}`, prompts) };
  const gate = registry.writeGate('scheduled-gate.js', 'process.stdout.write(JSON.stringify({ finished_workers: 4 }));\n');
  assert.equal(gate.ok, true);
  assert.equal(registry.write({
    id: 'scheduled-flow',
    gate: { script: gate.path! },
    action: {
      kind: 'spawn-session',
      template: { cwd: 'C:\\tmp', prompt: 'finished={gate.finished_workers}', title: 'worker {gate.finished_workers}', mcps: [] },
    },
  }).ok, true);

  try {
    const scheduled = engine.addFlowSchedule({ flowId: 'scheduled-flow', at: Date.now() + 80 });
    assert.equal(scheduled.ok, true);
    engine.flowSchedReg.arm();
    await new Promise((resolve) => setTimeout(resolve, 220));

    assert.equal(births, 1);
    assert.deepEqual(prompts, ['finished=4']);
    assert.equal(engine.sessions.get('scheduled-1')?.meta.title, 'worker 4');
  } finally {
    engine.flowSchedReg.disarm();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduled flow hot overwrite uses the latest definition and latest gate result', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  let births = 0;
  engine.manager = { createSession: async () => fakeFlowSdk(`hot-${++births}`, prompts) };
  const oldGate = registry.writeGate('old-gate.js', 'process.stdout.write(JSON.stringify({ value: "old" }));\n');
  const newGate = registry.writeGate('new-gate.js', 'process.stdout.write(JSON.stringify({ value: "new" }));\n');
  assert.equal(oldGate.ok && newGate.ok, true);
  const flow = (gatePath: string, version: string): Flow => ({
    id: 'hot-flow',
    gate: { script: gatePath },
    action: { kind: 'spawn-session', template: { cwd: 'C:\\tmp', prompt: `${version}:{gate.value}`, mcps: [] } },
  });
  assert.equal(registry.write(flow(oldGate.path!, 'old')).ok, true);

  try {
    const scheduled = engine.addFlowSchedule({ flowId: 'hot-flow', at: Date.now() + 100 });
    assert.equal(scheduled.ok, true);
    engine.flowSchedReg.arm();
    assert.equal(registry.write(flow(newGate.path!, 'new')).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(births, 1);
    assert.deepEqual(prompts, ['new:new']);
  } finally {
    engine.flowSchedReg.disarm();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing gate key fails explicitly before spawn', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  let births = 0;
  engine.log = (msg: string, data?: Record<string, unknown>) => logs.push({ msg, data });
  engine.manager = { createSession: async () => { births++; return fakeFlowSdk('must-not-spawn', []); } };
  const gate = registry.writeGate('missing-key.js', 'process.stdout.write(JSON.stringify({ other: 1 }));\n');
  registry.write({
    id: 'missing-key-flow',
    gate: { script: gate.path! },
    action: { kind: 'spawn-session', template: { cwd: 'C:\\tmp', prompt: 'need={gate.required}', mcps: [] } },
  });

  try {
    const result = await engine.runFlow('missing-key-flow', null);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /unresolved gate parameter\(s\): required/);
    assert.equal(births, 0);
    assert.equal(logs.some((row) => row.msg === 'flow interpolation failed'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid JSON and non-object gate stdout fail explicitly before spawn', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  let births = 0;
  engine.manager = { createSession: async () => { births++; return fakeFlowSdk('must-not-spawn', []); } };
  const cases = [
    { id: 'invalid-json-flow', file: 'invalid-json.js', source: 'process.stdout.write("bad-json");\n', error: /invalid JSON/ },
    { id: 'non-object-flow', file: 'non-object.js', source: 'process.stdout.write("42");\n', error: /must be a JSON object/ },
  ] as const;

  try {
    for (const item of cases) {
      const gate = registry.writeGate(item.file, item.source);
      registry.write({
        id: item.id,
        gate: { script: gate.path! },
        action: { kind: 'spawn-session', template: { cwd: 'C:\\tmp', prompt: 'need={gate.value}', mcps: [] } },
      });
      const result = await engine.runFlow(item.id, null);
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', item.error);
    }
    assert.equal(births, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual flow_run still interpolates gate params', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  engine.manager = { createSession: async () => fakeFlowSdk('manual-1', prompts) };
  const gate = registry.writeGate('manual-gate.js', 'process.stdout.write(JSON.stringify({ value: "manual" }));\n');
  registry.write({
    id: 'manual-flow',
    gate: { script: gate.path! },
    action: { kind: 'spawn-session', template: { cwd: 'C:\\tmp', prompt: 'value={gate.value}', mcps: [] } },
  });

  try {
    const result = await engine.runFlow('manual-flow', null);
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'manual-1');
    assert.deepEqual(prompts, ['value=manual']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual flow_run fails explicitly when the first prompt is rejected', async () => {
  const { engine, events } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  engine.manager = { createSession: async () => fakeFlowSdk('reject-1', prompts, { rejectMessage: 'boom' }) };
  registry.write({
    id: 'reject-flow',
    action: {
      kind: 'spawn-session',
      template: { cwd: 'C:\\tmp', prompt: 'value=reject', title: 'reject worker', mcps: [] },
    },
  });

  try {
    const result = await engine.runFlow('reject-flow', null);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /first prompt rejected: boom/);
    assert.deepEqual(prompts, ['value=reject']);
    const st = engine.sessions.get('reject-1');
    assert.equal(st?.meta.status, 'error');
    assert.equal(st?.meta.launchState, 'launch_failed');
    assert.match(st?.meta.error ?? '', /boom/);
    assert.ok(patches(events).some((p) => p.sessionId === 'reject-1' && p.status === 'error' && p.launchState === 'launch_failed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnSession accepts a first turn already present in SDK history without a live user.message event', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    engine.manager = {
      createSession: async () => fakeFlowSdk('history-only-1', prompts, {
        onSend: async ({ prompt, pushEvent }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          pushEvent({ type: 'user.message', data: { content: prompt, source: null } }, false);
        },
      }),
    };

    const sessionId = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'history-only', mcps: [] },
      'flow-history',
      null,
      {},
    );

    assert.equal(sessionId, 'history-only-1');
    assert.deepEqual(prompts, ['history-only']);
    assert.equal(engine.sessions.get('history-only-1')?.meta.launchState, null);
  });
});

test('spawnSession fails at submission when dispatch stays pending without prompt-correlated evidence', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    engine.manager = {
      createSession: async () => fakeFlowSdk('stuck-1', [], {
        onSend: () => new Promise<void>(() => {}),
      }),
    };

    await assert.rejects(
      () => engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'stuck', mcps: [] }, 'flow-stuck', null, {}),
      /dispatch remained pending with no prompt-correlated user\.message within 15ms/,
    );
    const st = engine.sessions.get('stuck-1');
    assert.equal(st?.meta.status, 'error');
    assert.equal(st?.meta.launchState, 'launch_failed');
  });
});

test('submission failure remains bounded when abort does not settle the SDK send', async () => {
    await withEnv({
      COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
      COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '15',
      COCKPIT_FLOW_FIRST_TURN_CLEANUP_TIMEOUT_MS: '15',
      COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
    }, async () => {
      const { engine } = makeEngine();
      const sdk = fakeFlowSdk('stuck-cleanup-1', [], {
        onSend: () => new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('late-abort')), 60);
        }),
      });
      sdk.abort = async () => {};
      engine.manager = { createSession: async () => sdk };
      const startedAt = Date.now();

      await assert.rejects(
        () => engine.spawnSession(
          { cwd: 'C:\\tmp', prompt: 'stuck-cleanup', mcps: [] },
          'flow-stuck-cleanup',
          null,
          {},
        ),
        /dispatch remained pending with no prompt-correlated user\.message within 15ms/,
      );
      assert.ok(Date.now() - startedAt < 200, 'cleanup timeout must not strand the launch path');
      const st = engine.sessions.get('stuck-cleanup-1');
      assert.equal(st?.meta.launchState, 'launch_failed');
      const stageError = st?.meta.error;
      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.equal(st?.meta.error, stageError, 'late send rejection must not replace the stage diagnosis');
      sdk._emit({ type: 'session.error', data: { message: 'late-sdk-session-error' } });
      assert.equal(st?.meta.error, stageError, 'late SDK error event must not replace the stage diagnosis');
    });
  });

test('an MCP send that ignores abort quarantines later births instead of overlapping', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_CLEANUP_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    let births = 0;
    engine.manager = {
      createSession: async () => {
        births++;
        const sdk = fakeFlowSdk(`quarantine-${births}`, prompts, births === 1
          ? { onSend: () => new Promise<void>(() => {}) }
          : {});
        if (births === 1) sdk.abort = async () => {};
        return sdk;
      },
    };

    const first = engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'quarantine-first', mcps: ['test-mcp'] },
      'flow-quarantine-first',
      null,
      {},
    );
    const second = engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'quarantine-second', mcps: ['test-mcp'] },
      'flow-quarantine-second',
      null,
      {},
    );
    const results = await Promise.allSettled([first, second]);

    assert.equal(results[0]?.status, 'rejected');
    assert.match(String((results[0] as PromiseRejectedResult).reason), /dispatch remained pending/);
    assert.equal(results[1]?.status, 'rejected');
    assert.match(String((results[1] as PromiseRejectedResult).reason), /MCP birth blocked: prior flow worker/);
    assert.equal(births, 1, 'the quarantined successor never starts createSession/preflight');
    assert.deepEqual(prompts, ['quarantine-first']);
  });
});

test('transient session.idle while the exact steering prompt is pending is not terminal', async () => {
    await withEnv({
      COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '50',
      COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '30',
      COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
    }, async () => {
      const { engine } = makeEngine();
      const prompts: string[] = [];
      engine.manager = {
        createSession: async () => fakeFlowSdk('steering-idle-1', prompts, {
          initialQueueState: 'steering',
          onSend: ({ prompt, emit, pushEvent }) => {
            emit({ type: 'session.idle', data: {} });
            setTimeout(() => {
              pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
            }, 15);
          },
        }),
      };

      const sessionId = await engine.spawnSession(
        { cwd: 'C:\\tmp', prompt: 'steering-after-idle', mcps: [] },
        'flow-steering-idle',
        null,
        {},
      );

      assert.equal(sessionId, 'steering-idle-1');
      assert.deepEqual(prompts, ['steering-after-idle']);
      const st = engine.sessions.get(sessionId);
      assert.equal(st?.meta.launchState, null);
      assert.equal(st?.meta.status, 'running', 'the startup idle never overwrites the pending first turn');
      assert.equal(st?.sdk?.getEvents().filter((ev: any) =>
        ev.type === 'user.message' && ev.data?.content === 'steering-after-idle').length, 1);
    });
  });

  test('dequeued prompt fails stage-specifically only after SDK processing is terminal', async () => {
    await withEnv({
      COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '15',
      COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
    }, async () => {
      const { engine } = makeEngine();
      const prompts: string[] = [];
      engine.manager = {
        createSession: async () => fakeFlowSdk('drained-idle-1', prompts, {
          initialQueueState: 'queued',
          onSend: ({ emit, setQueueState, setProcessing }) => {
            setProcessing(false);
            setQueueState('drained');
            emit({ type: 'session.idle', data: {} });
          },
        }),
      };

      await assert.rejects(
        () => engine.spawnSession(
          { cwd: 'C:\\tmp', prompt: 'drained-without-history', mcps: [] },
          'flow-drained-idle',
          null,
          {},
        ),
        /first prompt was dequeued and SDK processing became terminal without a durable user\.message within 15ms/,
      );
      assert.deepEqual(prompts, ['drained-without-history']);
      assert.equal(engine.sessions.get('drained-idle-1')?.meta.launchState, 'launch_failed');
    });
  });

  test('queued then dequeued prompt survives transient idle until exact user.message append', async () => {
    await withEnv({
      COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '30',
      COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
    }, async () => {
      const { engine } = makeEngine();
      const prompts: string[] = [];
      let statusDuringGap: string | undefined;
      const sdk = fakeFlowSdk('dequeue-gap-1', prompts, {
        initialQueueState: 'queued',
        onSend: ({ prompt, emit, pushEvent, setQueueState, setProcessing }) => {
          setProcessing(false);
          setQueueState('drained');
          emit({ type: 'session.idle', data: {} });
          statusDuringGap = engine.sessions.get('dequeue-gap-1')?.meta.status;
          setTimeout(() => {
            setProcessing(false);
            pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
          }, 5);
        },
      });
      engine.manager = { createSession: async () => sdk };

      const sessionId = await engine.spawnSession(
        { cwd: 'C:\\tmp', prompt: 'dequeue-gap-success', mcps: [] },
        'flow-dequeue-gap',
        null,
        {},
      );

      assert.equal(sessionId, 'dequeue-gap-1');
      assert.equal(statusDuringGap, 'running', 'dequeue-gap idle must not leak into live session state');
      assert.deepEqual(prompts, ['dequeue-gap-success']);
      assert.equal(sdk._abortCount(), 0, 'cleanup must not erase a valid dequeue-to-append transition');
      assert.equal(
        sdk.getEvents().filter((ev: any) => ev.type === 'user.message' && ev.data?.content === 'dequeue-gap-success').length,
        1,
      );
    });
  });

  test('missed short queue interval still succeeds from later exact authoritative user.message', async () => {
    await withEnv({
      COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '30',
      COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
    }, async () => {
      const { engine } = makeEngine();
      const prompts: string[] = [];
      const sdk = fakeFlowSdk('missed-queue-1', prompts, {
        onSend: ({ prompt, pushEvent, setProcessing }) => {
          setProcessing(true);
          setTimeout(() => {
            setProcessing(false);
            pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
          }, 5);
        },
      });
      engine.manager = { createSession: async () => sdk };

      const sessionId = await engine.spawnSession(
        { cwd: 'C:\\tmp', prompt: 'missed-queue-success', mcps: [] },
        'flow-missed-queue',
        null,
        {},
      );

      assert.equal(sessionId, 'missed-queue-1');
      assert.equal(sdk._abortCount(), 0);
      assert.equal(sdk.getPendingQueuedItems().length, 0);
      assert.equal(sdk.getEvents().filter((ev: any) => ev.type === 'user.message').length, 1);
    });
  });

  test('display-prompt normalization keeps exact submitted identity prompt-correlated', async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    const sdk = fakeFlowSdk('normalized-prompt-1', prompts, {
      initialQueueState: 'queued',
      onSend: ({ prompt, pushEvent }) => {
        pushEvent({
          type: 'user.message',
          data: {
            content: prompt,
            transformedContent: `[[PLAN]] ${prompt}`,
            source: null,
          },
        });
      },
    });
    engine.manager = { createSession: async () => sdk };

    const sessionId = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'normalized-display-prompt', mcps: [] },
      'flow-normalized-prompt',
      null,
      {},
    );

    assert.equal(sessionId, 'normalized-prompt-1');
    assert.deepEqual(prompts, ['normalized-display-prompt']);
    assert.equal(
      sdk.getEvents().filter((ev: any) =>
        ev.type === 'user.message' && ev.data?.content === 'normalized-display-prompt').length,
      1,
    );
  });

  test('pending send with an exact queued prompt waits for the later durable user.message', async () => {
    await withEnv({
      COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '50',
      COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '30',
      COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
    }, async () => {
      const { engine } = makeEngine();
      const prompts: string[] = [];
      engine.manager = {
        createSession: async () => fakeFlowSdk('queued-send-1', prompts, {
          initialQueueState: 'queued',
          onSend: async ({ prompt, pushEvent }) => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
          },
        }),
      };

      const sessionId = await engine.spawnSession(
        { cwd: 'C:\\tmp', prompt: 'queued-then-persisted', mcps: [] },
        'flow-queued-send',
        null,
        {},
      );
      assert.equal(sessionId, 'queued-send-1');
      assert.deepEqual(prompts, ['queued-then-persisted']);
      assert.equal(engine.sessions.get(sessionId)?.meta.launchState, null);
    });
  });

test('unrelated pre-user SDK events do not advance a pending dispatch to the durable phase', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '80',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    engine.manager = {
      createSession: async () => fakeFlowSdk('unrelated-1', [], {
        onSend: ({ emit, pushEvent }) => {
          emit({ type: 'pending_messages.modified', data: {} });
          emit({ type: 'telemetry.model_call', data: { status: 'starting' } });
          pushEvent({ type: 'session.mode_changed', data: { newMode: 'autopilot' } });
          pushEvent({ type: 'hook.start', data: { hookInvocationId: 'init' } });
          pushEvent({ type: 'user.message', data: { content: 'different prompt', source: null } });
          return new Promise<void>(() => {});
        },
      }),
    };

    await assert.rejects(
      () => engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'not-submitted', mcps: [] }, 'flow-unrelated', null, {}),
      /dispatch remained pending with no prompt-correlated user\.message within 20ms/,
    );
    assert.doesNotMatch(
      engine.sessions.get('unrelated-1')?.meta.error ?? '',
      /made progress|accepted but no durable/,
    );
  });
});

test('three concurrent siblings with only initialization events fail in the submission stage', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '25',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '100',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    let births = 0;
    let activeBirths = 0;
    let maxConcurrentBirths = 0;
    engine.manager = {
      createSession: async () => {
        const id = `init-only-${++births}`;
        activeBirths++;
        maxConcurrentBirths = Math.max(maxConcurrentBirths, activeBirths);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeBirths--;
        return fakeFlowSdk(id, [], {
          onSend: ({ emit, pushEvent }) => {
            emit({ type: 'pending_messages.modified', data: {} });
            pushEvent({ type: 'session.model_change', data: { newModel: 'test' } });
            return new Promise<void>(() => {});
          },
        });
      },
    };

    const results = await Promise.allSettled([
      engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'sibling-one', mcps: [] }, 'flow-one', null, {}),
      engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'sibling-two', mcps: [] }, 'flow-two', null, {}),
      engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'sibling-three', mcps: [] }, 'flow-three', null, {}),
    ]);

    assert.equal(results.every((result) => result.status === 'rejected'), true);
    assert.equal(maxConcurrentBirths, 3);
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      assert.match(String(result.reason), /dispatch remained pending with no prompt-correlated user\.message/);
      assert.doesNotMatch(String(result.reason), /made progress|accepted but no durable/);
    }
  });
});

test('a synchronous user.message during send closes the subscribe-check boundary', async () => {
  const { engine } = makeEngine();
  const prompts: string[] = [];
  engine.manager = {
    createSession: async () => fakeFlowSdk('sync-boundary-1', prompts, {
      onSend: ({ prompt, pushEvent }) => {
        pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
      },
    }),
  };

  const sessionId = await engine.spawnSession(
    { cwd: 'C:\\tmp', prompt: 'sync-boundary', mcps: [] },
    'flow-sync-boundary',
    null,
    {},
  );
  assert.equal(sessionId, 'sync-boundary-1');
  assert.deepEqual(prompts, ['sync-boundary']);
});

test('events emitted while the observer subscribes are excluded from the dispatch boundary', async () => {
  const { engine } = makeEngine();
  const prompts: string[] = [];
  const sdk = fakeFlowSdk('subscribe-boundary-1', prompts, {
    onSend: ({ prompt, pushEvent }) => {
      pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
    },
  });
  const baseOn = sdk.on.bind(sdk);
  let wildcardSubscriptions = 0;
  sdk.on = (type: string, handler: (event: any) => void) => {
    wildcardSubscriptions += type === '*' ? 1 : 0;
    if (type === '*' && wildcardSubscriptions === 2) {
      handler({ type: 'session.error', data: { message: 'pre-dispatch initialization error' } });
    }
    return baseOn(type, handler);
  };
  engine.manager = { createSession: async () => sdk };

  const sessionId = await engine.spawnSession(
    { cwd: 'C:\\tmp', prompt: 'subscribe-boundary', mcps: [] },
    'flow-subscribe-boundary',
    null,
    {},
  );
  assert.equal(sessionId, 'subscribe-boundary-1');
  assert.deepEqual(prompts, ['subscribe-boundary']);
});

test('send acceptance starts a bounded durable wait and delayed authoritative history succeeds', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '40',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    engine.manager = {
      createSession: async () => fakeFlowSdk('accepted-delayed-1', prompts, {
        onSend: ({ prompt, pushEvent }) => {
          setTimeout(() => {
            pushEvent({ type: 'user.message', data: { content: prompt, source: null } }, false);
          }, 15);
        },
      }),
    };

    const sessionId = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'accepted-delayed', mcps: [] },
      'flow-accepted-delayed',
      null,
      {},
    );
    assert.equal(sessionId, 'accepted-delayed-1');
    assert.deepEqual(prompts, ['accepted-delayed']);
  });
});

test('send acceptance without a durable prompt record fails in the durable stage', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    engine.manager = {
      createSession: async () => fakeFlowSdk('accepted-absent-1', [], {
        onSend: () => {},
      }),
    };

    await assert.rejects(
      () => engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'accepted-absent', mcps: [] }, 'flow-accepted-absent', null, {}),
      /first prompt was accepted but no durable user\.message appeared within 20ms/,
    );
  });
});

test('spawnSession surfaces warning-specific launch failure after the prompt was accepted', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    engine.manager = {
      createSession: async () => fakeFlowSdk('warn-1', [], {
        onSend: ({ pushEvent }) => {
          pushEvent({ type: 'session.warning', data: { message: 'Policy hook failed' } });
        },
      }),
    };

    await assert.rejects(
      () => engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'warn', mcps: [] }, 'flow-warn', null, {}),
      /blocked before persistence: Policy hook failed/,
    );
    const st = engine.sessions.get('warn-1');
    assert.equal(st?.meta.status, 'error');
    assert.equal(st?.meta.launchState, 'launch_failed');
    assert.match(st?.meta.error ?? '', /Policy hook failed/);
  });
});

test('policy hook timeout preserves hook type, source, and cause without a fake turn', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];
    engine.log = (message: string, data?: Record<string, unknown>) => logs.push({ message, data });
    const sdk = fakeFlowSdk('policy-detail-1', [], {
      onSend: ({ emit }) => {
        emit({
          type: 'hook.end',
          data: {
            hookType: 'userPromptSubmitted',
            success: false,
            error: {
              message: 'Hook command timed out after 12 seconds',
              source: 'HKLM\\SOFTWARE\\Policies\\GitHub\\Copilot\\Defender',
              stack: 'preserved-stack',
            },
          },
        });
        emit({ type: 'session.warning', data: { message: 'Policy hook failed' } });
      },
    });
    engine.manager = { createSession: async () => sdk };

    await assert.rejects(
      () => engine.spawnSession(
        { cwd: 'C:\\tmp', prompt: 'policy-timeout', mcps: [] },
        'flow-policy-detail',
        null,
        {},
      ),
      /Policy hook failed \(userPromptSubmitted from "HKLM_SOFTWARE_Policies_GitHub_Copilot_Defender": command timed out after 12 seconds\)/,
    );
    assert.equal(sdk.getEvents().filter((event: any) => event.type === 'user.message').length, 0);
    assert.equal(engine.sessions.get('policy-detail-1')?.meta.launchState, 'launch_failed');
    assert.ok(logs.some((entry) =>
      entry.message === 'flow first prompt hook callback failed'
      && entry.data?.error === 'Hook command timed out after 12 seconds'
      && entry.data?.stack === 'preserved-stack'));
  });
});

test('successful prompt hook delay within the launch bound persists exactly one user message', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '40',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '40',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    const sdk = fakeFlowSdk('policy-delay-success-1', prompts, {
      onSend: async ({ prompt, emit, pushEvent }) => {
        emit({ type: 'hook.start', data: { hookType: 'userPromptSubmitted' } });
        await new Promise((resolve) => setTimeout(resolve, 12));
        emit({ type: 'hook.end', data: { hookType: 'userPromptSubmitted', success: true } });
        pushEvent({ type: 'user.message', data: { content: prompt, source: null } });
      },
    });
    engine.manager = { createSession: async () => sdk };

    const sessionId = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'policy-delay-success', mcps: [] },
      'flow-policy-delay',
      null,
      {},
    );
    assert.equal(sessionId, 'policy-delay-success-1');
    assert.equal(sdk.getEvents().filter((event: any) =>
      event.type === 'user.message' && event.data?.content === 'policy-delay-success').length, 1);
  });
});

test('a failed hook callback cannot leave stale state that poisons a fresh managed birth', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    let births = 0;
    engine.manager = {
      createSession: async () => {
        births++;
        return fakeFlowSdk(`policy-isolation-${births}`, prompts, births === 1 ? {
          onSend: ({ emit }) => {
            emit({
              type: 'hook.end',
              data: {
                hookType: 'userPromptSubmitted',
                success: false,
                error: { message: 'This operation was aborted', source: 'Defender policy' },
              },
            });
            emit({ type: 'session.warning', data: { message: 'Policy hook failed' } });
          },
        } : {});
      },
    };

    await assert.rejects(
      () => engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'first', mcps: [] }, 'flow-first', null, {}),
      /command was aborted/,
    );
    const second = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'second', mcps: [] },
      'flow-second',
      null,
      {},
    );
    assert.equal(second, 'policy-isolation-2');
    assert.equal(engine.sessions.get(second)?.meta.launchState, null);
    assert.equal(engine.sessions.get(second)?.sdk?.getEvents().filter((event: any) =>
      event.type === 'user.message' && event.data?.content === 'second').length, 1);
  });
});

test('concurrent spawnSession calls keep their first-turn waiters isolated', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '20',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    let births = 0;
    engine.manager = {
      createSession: async () => fakeFlowSdk(`parallel-${++births}`, prompts, {
        onSend: async ({ prompt, pushEvent }) => {
          await new Promise((resolve) => setTimeout(resolve, prompt.includes('one') ? 5 : 8));
          pushEvent({ type: 'user.message', data: { content: prompt, source: null } }, false);
        },
      }),
    };

    const [left, right] = await Promise.all([
      engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'worker-one', mcps: [] }, 'flow-a', null, {}),
      engine.spawnSession({ cwd: 'C:\\tmp', prompt: 'worker-two', mcps: [] }, 'flow-b', null, {}),
    ]);

    assert.deepEqual([left, right], ['parallel-1', 'parallel-2']);
    assert.deepEqual(prompts.sort(), ['worker-one', 'worker-two']);
    assert.equal(engine.sessions.get('parallel-1')?.meta.launchState, null);
    assert.equal(engine.sessions.get('parallel-2')?.meta.launchState, null);
  });
});

test('born-config delay does not consume the first-turn submission budget', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const prompts: string[] = [];
    const sdk = Object.assign(fakeFlowSdk('delayed-born-config-1', prompts), {
      mode: {
        get: async () => 'interactive',
        set: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); },
      },
    });
    engine.manager = { createSession: async () => sdk };

    const sessionId = await engine.spawnSession(
      { cwd: 'C:\\tmp', prompt: 'after-mode', mcps: [], mode: 'autopilot' },
      'flow-mode-delay',
      null,
      {},
    );

    assert.equal(sessionId, 'delayed-born-config-1');
    assert.deepEqual(prompts, ['after-mode']);
  });
});

test('scheduled flow shares the explicit launch-failure path', async () => {
  await withEnv({
    COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS: '15',
    COCKPIT_FLOW_FIRST_TURN_POLL_MS: '10',
  }, async () => {
    const { engine } = makeEngine();
    const { dir, registry } = installFlowRegistry(engine);
    const prompts: string[] = [];
    engine.manager = { createSession: async () => fakeFlowSdk('scheduled-fail-1', prompts, { idleBeforeAccept: true }) };
    registry.write({
      id: 'scheduled-fail-flow',
      action: {
        kind: 'spawn-session',
        template: { cwd: 'C:\\tmp', prompt: 'value=scheduled-fail', title: 'scheduled fail worker', mcps: [] },
      },
    });

    try {
      const scheduled = engine.addFlowSchedule({ flowId: 'scheduled-fail-flow', at: Date.now() + 80 });
      assert.equal(scheduled.ok, true);
      engine.flowSchedReg.arm();
      await new Promise((resolve) => setTimeout(resolve, 220));
      assert.deepEqual(prompts, ['value=scheduled-fail']);
      const st = engine.sessions.get('scheduled-fail-1');
      assert.equal(st?.meta.status, 'error');
      assert.equal(st?.meta.launchState, 'launch_failed');
      assert.match(st?.meta.error ?? '', /accepted but no durable user\.message/);
    } finally {
      engine.flowSchedReg.disarm();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('event interpolation and a no-gate flow keep working', async () => {
  const { engine } = makeEngine();
  const { dir, registry } = installFlowRegistry(engine);
  const prompts: string[] = [];
  engine.manager = { createSession: async () => fakeFlowSdk('event-1', prompts) };
  registry.write({
    id: 'event-flow',
    action: {
      kind: 'spawn-session',
      template: { cwd: '{event.cwd}', prompt: 'source={event.sessionId}', title: '{event.title}', mcps: [] },
    },
  });
  const ctx: SessionEventCtx = {
    event: 'session.first-turn-complete',
    sessionId: 'source-1',
    cwd: 'C:\\event-cwd',
    title: 'event title',
  };

  try {
    const result = await engine.runFlow('event-flow', ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(prompts, ['source=source-1']);
    assert.equal(engine.sessions.get('event-1')?.meta.cwd, 'C:\\event-cwd');
    assert.equal(engine.sessions.get('event-1')?.meta.title, 'event title');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshList projects a persisted interrupted launch as a non-idle error after restart', async () => {
  const oldHome = process.env.COCKPIT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cockpit-launch-home-'));
  process.env.COCKPIT_HOME = home;
  try {
    const sessionId = 'persisted-launch-1';
    const dir = join(home, 'session-state', sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'cockpit-launch.json'),
      JSON.stringify({ version: 1, flowId: 'flow-review', state: 'launching', updatedAt: Date.now() }),
      'utf8',
    );
    const { engine } = makeEngine();
    engine.manager = {
      listSessions: async () => [{
        sessionId,
        summary: 'Cockpit · flow-review worker',
        name: 'Cockpit · flow-review worker',
        context: { cwd: 'C:\\tmp' },
        startTime: '2026-08-21T00:00:00.000Z',
        modifiedTime: '2026-08-21T00:00:01.000Z',
      }],
      getSession: async () => ({
        sessionId,
        getEvents: () => [],
        on: () => () => {},
      }),
    };

    await engine.refreshList();
    let meta = engine.getMeta(sessionId);
    assert.equal(meta?.status, 'error');
    assert.equal(meta?.launchState, 'launch_failed');
    assert.match(meta?.error ?? '', /interrupted before its first turn was durably accepted/);

    await engine.ensureLoaded(engine.sessions.get(sessionId));
    meta = engine.getMeta(sessionId);
    assert.equal(meta?.status, 'error');
    assert.equal(meta?.launchState, 'launch_failed');
    assert.match(meta?.error ?? '', /interrupted before its first turn was durably accepted/);
  } finally {
    if (oldHome === undefined) delete process.env.COCKPIT_HOME;
    else process.env.COCKPIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
