// Unit tests for hooks.ts — the Butler/Flow event-hook decision logic.
// Pure functions + the in-memory registry; no Engine/SDK. R1 (the anti-fork-bomb
// invariant) is the headline case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstTurnEligible,
  sessionErrorEligible,
  countTurnSignals,
  hookMatchesEvent,
  interpolate,
  matchHooks,
  isGlobalEvent,
  bootFilterRejection,
  HookRegistry,
} from './hooks.ts';
import type { HookEntry, SessionEventCtx } from '@cockpit/protocol';

const ev: SessionEventCtx = {
  event: 'session.first-turn-complete',
  sessionId: 'src-1',
  cwd: '/home/honglai/projectX',
  title: 'projectX',
};

const baseTurn = { alreadyWelcomed: false, cancelled: false, userPrompts: 1, assistantMessages: 1 };

// ── firstTurnEligible / R1 ───────────────────────────────────────────────────
test('the TRUE first turn (exactly one prompt + a reply) is eligible', () => {
  assert.equal(firstTurnEligible(baseTurn), true);
});

test('an OLD session (multiple turns) never fires — the welcome-bug guard', () => {
  // The regression: an established session completing some later turn must NOT be
  // mistaken for a first turn just because it has >=1 prompt and >=1 reply.
  assert.equal(firstTurnEligible({ ...baseTurn, userPrompts: 2, assistantMessages: 2 }), false);
  assert.equal(firstTurnEligible({ ...baseTurn, userPrompts: 50, assistantMessages: 80 }), false);
});

test('R1: a spawnedBy worker is NEVER a trigger source', () => {
  assert.equal(firstTurnEligible({ ...baseTurn, spawnedBy: 'welcome-flow' }), false);
  // Even with a perfectly real exchange, the worker mark wins.
  assert.equal(
    firstTurnEligible({ spawnedBy: 'f1', alreadyWelcomed: false, cancelled: false, userPrompts: 1, assistantMessages: 1 }),
    false,
  );
});

test('already-welcomed sources do not re-fire (once per source)', () => {
  assert.equal(firstTurnEligible({ ...baseTurn, alreadyWelcomed: true }), false);
});

test('a cancelled turn is not a natural completion', () => {
  assert.equal(firstTurnEligible({ ...baseTurn, cancelled: true }), false);
});

test('an empty / cold turn (no real exchange) is not eligible', () => {
  assert.equal(firstTurnEligible({ ...baseTurn, userPrompts: 1, assistantMessages: 0 }), false);
  assert.equal(firstTurnEligible({ ...baseTurn, userPrompts: 0, assistantMessages: 1 }), false);
});

// ── countTurnSignals (ask-reply exclusion = turn count) ──────────────────────
test('countTurnSignals: a single first turn = 1 prompt + a reply', () => {
  const r = countTurnSignals([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepEqual(r, { userPrompts: 1, assistantMessages: 1 });
});

test('countTurnSignals: an ask-reply within the first turn does NOT count as a second prompt', () => {
  // A first turn that involved an ask_user: prompt → (agent asks) → user answers
  // → reply. Still ONE turn, so it stays eligible (userPrompts === 1).
  const r = countTurnSignals([
    { role: 'user', content: 'do the thing' },
    { role: 'user', subtype: 'ask-reply', content: 'yes option A' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.deepEqual(r, { userPrompts: 1, assistantMessages: 1 });
  assert.equal(firstTurnEligible({ ...baseTurn, ...r }), true);
});

test('countTurnSignals: an OLD session has userPrompts >= 2 → not eligible (the bug)', () => {
  const r = countTurnSignals([
    { role: 'user', content: 'turn 1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'turn 2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'turn 3' }, { role: 'assistant', content: 'a3' },
  ]);
  assert.equal(r.userPrompts, 3);
  assert.equal(firstTurnEligible({ ...baseTurn, ...r }), false);
});

test('countTurnSignals: sub-agent cards and empty assistant messages are not counted', () => {
  const r = countTurnSignals([
    { role: 'user', content: 'go' },
    { role: 'assistant', subtype: 'subagent', content: 'worker did stuff' },
    { role: 'assistant', content: '   ' },           // empty → not counted
    { role: 'assistant', content: 'real reply' },
  ]);
  assert.deepEqual(r, { userPrompts: 1, assistantMessages: 1 });
});

// ── hookMatchesEvent / filters ───────────────────────────────────────────────
const hook = (over: Partial<HookEntry>): HookEntry => ({
  id: 'hook-1',
  ownerSession: 'butler',
  event: 'session.first-turn-complete',
  createdAt: 0,
  ...over,
});

test('a matching event with no filter fires', () => {
  assert.equal(hookMatchesEvent(hook({}), ev), true);
});

test('a hook never reacts to events on its own session', () => {
  assert.equal(hookMatchesEvent(hook({ ownerSession: 'src-1' }), ev), false);
});

test('cwdPrefix filter narrows the source', () => {
  assert.equal(hookMatchesEvent(hook({ filter: { cwdPrefix: '/home/honglai/projectX' } }), ev), true);
  assert.equal(hookMatchesEvent(hook({ filter: { cwdPrefix: '/srv/other' } }), ev), false);
});

test('sessionId filter pins to one exact source', () => {
  assert.equal(hookMatchesEvent(hook({ filter: { sessionId: 'src-1' } }), ev), true);
  assert.equal(hookMatchesEvent(hook({ filter: { sessionId: 'src-2' } }), ev), false);
});

// ── interpolate ──────────────────────────────────────────────────────────────
test('interpolate fills event context and leaves unknown tokens intact', () => {
  assert.equal(
    interpolate('welcome {event.sessionId} at {cwd} (unknown {foo})', ev),
    'welcome src-1 at /home/honglai/projectX (unknown {foo})',
  );
});

// ── matchHooks ───────────────────────────────────────────────────────────────
test('matchHooks returns interpolated deliveries for matching hooks only', () => {
  const hooks: HookEntry[] = [
    hook({ id: 'hook-1', promptTemplate: 'greet {title}' }),
    hook({ id: 'hook-2', ownerSession: 'src-1' }), // owner==source → skipped
    hook({ id: 'hook-3', filter: { cwdPrefix: '/nope' } }), // filtered out
    hook({ id: 'hook-4', flowId: 'welcome-flow' }), // flow delivery (no text)
  ];
  const deliveries = matchHooks(hooks, ev);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].text, 'greet projectX');
  assert.equal(deliveries[1].flowId, 'welcome-flow');
  assert.equal(deliveries[1].text, undefined);
});

// ── sessionErrorEligible / R1 + rate-limit (the triage trigger guard) ─────────
const errBase = { now: 1_000_000, windowMs: 60_000 };

test('a real session erroring the first time is eligible (triage fires)', () => {
  assert.equal(sessionErrorEligible({ ...errBase, lastFiredAt: undefined }), true);
});

test('R1: a spawnedBy worker error NEVER fires triage (no worker error storm)', () => {
  assert.equal(sessionErrorEligible({ ...errBase, spawnedBy: 'flow-review', lastFiredAt: undefined }), false);
  // even outside any window, a worker is never a trigger source
  assert.equal(sessionErrorEligible({ ...errBase, spawnedBy: 'f1', lastFiredAt: 0 }), false);
});

test('rate-limit: a second error within the window is suppressed; after it, fires again', () => {
  // fired 10s ago, window 60s → suppressed
  assert.equal(sessionErrorEligible({ ...errBase, lastFiredAt: errBase.now - 10_000 }), false);
  // fired 61s ago → window elapsed → eligible
  assert.equal(sessionErrorEligible({ ...errBase, lastFiredAt: errBase.now - 61_000 }), true);
  // exactly at the boundary is still within (< window is the suppress rule)
  assert.equal(sessionErrorEligible({ ...errBase, lastFiredAt: errBase.now - 60_000 }), true);
});

// ── session.error event matching + summary interpolation ─────────────────────
const errEv: SessionEventCtx = {
  event: 'session.error',
  sessionId: 'src-9',
  cwd: '/home/honglai/sick',
  title: 'sick-session',
  summary: 'tool chain failed: ECONNRESET',
};

test('interpolate fills {event.summary} for a session.error event', () => {
  assert.equal(
    interpolate('triage {event.sessionId}: {summary}', errEv),
    'triage src-9: tool chain failed: ECONNRESET',
  );
});

test('a session.error hook matches a session.error event, not a first-turn one', () => {
  assert.equal(hookMatchesEvent(hook({ event: 'session.error' }), errEv), true);
  assert.equal(hookMatchesEvent(hook({ event: 'session.error' }), ev), false);
  assert.equal(hookMatchesEvent(hook({ event: 'session.first-turn-complete' }), errEv), false);
});

test('matchHooks on a session.error event delivers only session.error hooks, with summary', () => {
  const hooks: HookEntry[] = [
    hook({ id: 'hook-1', event: 'session.error', promptTemplate: 'diagnose {sessionId}: {summary}' }),
    hook({ id: 'hook-2', event: 'session.first-turn-complete', promptTemplate: 'welcome' }), // wrong event
    hook({ id: 'hook-3', event: 'session.error', flowId: 'triage-flow' }),
  ];
  const deliveries = matchHooks(hooks, errEv);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].text, 'diagnose src-9: tool chain failed: ECONNRESET');
  assert.equal(deliveries[1].flowId, 'triage-flow');
});

test('session.error is source-keyed, not global', () => {
  assert.equal(isGlobalEvent('session.error'), false);
});

// ── session.trashed event matching (source-keyed, cwd_prefix-filterable) ──────
const trashEv: SessionEventCtx = {
  event: 'session.trashed',
  sessionId: 'src-7',
  cwd: '/home/honglai/.copilot/skill-inbox',
  title: 'Cockpit · spent worker',
};

test('a session.trashed hook matches a session.trashed event, not the others', () => {
  assert.equal(hookMatchesEvent(hook({ event: 'session.trashed' }), trashEv), true);
  assert.equal(hookMatchesEvent(hook({ event: 'session.trashed' }), ev), false);
  assert.equal(hookMatchesEvent(hook({ event: 'session.trashed' }), errEv), false);
  assert.equal(hookMatchesEvent(hook({ event: 'session.first-turn-complete' }), trashEv), false);
});

test('session.trashed is source-keyed (not global) and supports a cwdPrefix filter', () => {
  assert.equal(isGlobalEvent('session.trashed'), false);
  // harvest narrows to the skill-inbox tree, say:
  assert.equal(hookMatchesEvent(hook({ event: 'session.trashed', filter: { cwdPrefix: '/home/honglai/.copilot' } }), trashEv), true);
  assert.equal(hookMatchesEvent(hook({ event: 'session.trashed', filter: { cwdPrefix: '/srv/other' } }), trashEv), false);
  // source filters are fine on this source-keyed event (unlike the global boot event):
  assert.equal(bootFilterRejection('session.trashed', { cwdPrefix: '/home/honglai/.copilot' }), null);
});

test('matchHooks on a session.trashed event delivers only session.trashed hooks', () => {
  const hooks: HookEntry[] = [
    hook({ id: 'hook-1', event: 'session.trashed', flowId: 'harvest-flow' }),
    hook({ id: 'hook-2', event: 'session.error', flowId: 'triage-flow' }), // wrong event
    hook({ id: 'hook-3', event: 'session.trashed', promptTemplate: 'salvage {sessionId} at {cwd}' }),
  ];
  const deliveries = matchHooks(hooks, trashEv);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].flowId, 'harvest-flow');
  assert.equal(deliveries[1].text, 'salvage src-7 at /home/honglai/.copilot/skill-inbox');
});

// ── isGlobalEvent / engine.boot-complete (source-less) ───────────────────────
test('isGlobalEvent: boot is global, first-turn is source-keyed', () => {
  assert.equal(isGlobalEvent('engine.boot-complete'), true);
  assert.equal(isGlobalEvent('session.first-turn-complete'), false);
});

const bootEv: SessionEventCtx = { event: 'engine.boot-complete', sessionId: '', cwd: '', title: '' };

test('a boot hook matches the source-less boot event regardless of owner', () => {
  // The default owner==source drop must NOT fire (source is '' for a global event),
  // so a session can hook engine.boot-complete to re-drive ITSELF after a restart.
  assert.equal(hookMatchesEvent(hook({ ownerSession: 'daemon-1', event: 'engine.boot-complete' }), bootEv), true);
});

test('a boot hook never matches a first-turn event (and vice-versa)', () => {
  assert.equal(hookMatchesEvent(hook({ event: 'engine.boot-complete' }), ev), false);
  assert.equal(hookMatchesEvent(hook({ event: 'session.first-turn-complete' }), bootEv), false);
});

test('matchHooks on a boot event delivers only boot hooks', () => {
  const hooks: HookEntry[] = [
    hook({ id: 'hook-1', event: 'engine.boot-complete', ownerSession: 'daemon-1', promptTemplate: 'verify your deploy', once: true }),
    hook({ id: 'hook-2', event: 'session.first-turn-complete', promptTemplate: 'welcome' }), // wrong event
  ];
  const deliveries = matchHooks(hooks, bootEv);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].ownerSession, 'daemon-1');
  assert.equal(deliveries[0].text, 'verify your deploy');
});

// ── Finding 1: fail-loud on a source filter for the source-less boot event ────
test('bootFilterRejection: a cwd_prefix/source_session filter on a boot hook is rejected', () => {
  // Either filter can never match the source-less boot event, so creation must fail
  // loud rather than yield a silently-dead hook.
  assert.match(bootFilterRejection('engine.boot-complete', { cwdPrefix: '/srv/x' })!, /don't apply to the global engine\.boot-complete/);
  assert.match(bootFilterRejection('engine.boot-complete', { sessionId: 'src-1' })!, /don't apply to the global engine\.boot-complete/);
  assert.match(bootFilterRejection('engine.boot-complete', { cwdPrefix: '/a', sessionId: 'b' })!, /no source/);
});

test('bootFilterRejection: a boot hook with no source filter (or excludeSelf) is allowed', () => {
  assert.equal(bootFilterRejection('engine.boot-complete', undefined), null);
  assert.equal(bootFilterRejection('engine.boot-complete', {}), null);
  // excludeSelf-only is harmless on a '' source — not a "source filter", so allowed.
  assert.equal(bootFilterRejection('engine.boot-complete', { cwdPrefix: '', sessionId: '' }), null);
});

test('bootFilterRejection: source filters are fine on the source-keyed first-turn event', () => {
  assert.equal(bootFilterRejection('session.first-turn-complete', { cwdPrefix: '/srv/x' }), null);
  assert.equal(bootFilterRejection('session.first-turn-complete', { sessionId: 'src-1' }), null);
});

// ── Finding 5: an empty ownerSession must NOT self-drop a boot hook ('' === '') ─
test('a boot hook with an empty ownerSession does not self-drop on the source-less boot event', () => {
  // Defense-in-depth: the protocol now enforces ownerSession.min(1), but if a
  // malformed loopback intent ever created one, the owner==source drop must not
  // fire just because both the source and the owner are '' on a global event.
  assert.equal(hookMatchesEvent(hook({ ownerSession: '', event: 'engine.boot-complete' }), bootEv), true);
  // And on a source-keyed event with a real source, a real owner==source still drops.
  assert.equal(hookMatchesEvent(hook({ ownerSession: 'src-1' }), ev), false);
});

// ── HookRegistry ─────────────────────────────────────────────────────────────
test('HookRegistry add/list/stop persists and assigns ids', () => {
  let saved: HookEntry[] = [];
  const reg = new HookRegistry([], (h) => { saved = h; });
  const a = reg.add({ ownerSession: 'butler', event: 'session.first-turn-complete', promptTemplate: 'x' });
  assert.match(a.id, /^hook-\d+$/);
  assert.equal(reg.list().length, 1);
  assert.equal(saved.length, 1);
  assert.equal(reg.countFor('butler'), 1);
  assert.equal(reg.stop(a.id), true);
  assert.equal(reg.stop(a.id), false); // idempotent
  assert.equal(reg.list().length, 0);
});

test('HookRegistry seeds its id sequence past restored ids (no collision)', () => {
  const reg = new HookRegistry(
    [{ id: 'hook-7', ownerSession: 'b', event: 'session.first-turn-complete', createdAt: 0 }],
    () => {},
  );
  const next = reg.add({ ownerSession: 'b', event: 'session.first-turn-complete' });
  assert.equal(next.id, 'hook-8');
});
