// Unit tests for Prefs — the per-session MCP/skill enable-state store. Uses a
// temp file (injected) so the real ~/.copilot/cockpit-prefs.json is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Prefs } from './prefs.ts';
import { firstTurnEligible } from './hooks.ts';

function freshFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-prefs-'));
  return join(dir, 'prefs.json');
}

test('new session inherits the global default-on set', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setMcpDefault('chrome', true);
  p.setMcpDefault('fs', true);
  // A session the user has never touched gets the defaults.
  assert.deepEqual(new Set(p.enabledMcpFor('s1')), new Set(['chrome', 'fs']));
  rmSync(f, { force: true });
});

test('per-session MCP toggle overrides the default and is independent', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setMcpDefault('chrome', true);
  // s1 explicitly disables chrome; s2 stays on the default.
  p.setSessionMcp('s1', 'chrome', false);
  assert.deepEqual(p.enabledMcpFor('s1'), []);
  assert.deepEqual(p.enabledMcpFor('s2'), ['chrome']);
  // s1 can also enable a non-default server.
  p.setSessionMcp('s1', 'extra', true);
  assert.deepEqual(new Set(p.enabledMcpFor('s1')), new Set(['extra']));
  rmSync(f, { force: true });
});

test('setMcpDefault off removes from the default set', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setMcpDefault('a', true);
  p.setMcpDefault('b', true);
  p.setMcpDefault('a', false);
  assert.deepEqual(p.mcpDefaultOn, ['b']);
  rmSync(f, { force: true });
});

test('skill disable is per-session; enabled by default', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.deepEqual(p.disabledSkillsFor('s1'), []);
  p.setSessionSkill('s1', 'pdf', false);
  assert.deepEqual(p.disabledSkillsFor('s1'), ['pdf']);
  assert.deepEqual(p.disabledSkillsFor('s2'), []); // independent
  p.setSessionSkill('s1', 'pdf', true); // re-enable
  assert.deepEqual(p.disabledSkillsFor('s1'), []);
  rmSync(f, { force: true });
});

test('strict skill allowlist denies future skills and stays coherent with toggles', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setSkillAllowlist('worker', ['A', 'B']);
  assert.deepEqual(p.skillAllowlistFor('worker'), ['A', 'B']);
  assert.equal(p.skillAllowlistFor('ordinary'), null);

  p.setSessionSkill('worker', 'C', true);
  assert.deepEqual(new Set(p.skillAllowlistFor('worker')), new Set(['A', 'B', 'C']));
  p.setSessionSkill('worker', 'A', false);
  assert.deepEqual(new Set(p.skillAllowlistFor('worker')), new Set(['B', 'C']));
  assert.deepEqual(p.disabledSkillsFor('worker'), []);
  rmSync(f, { force: true });
});

test('skill allowlist persists across reload and is cleared by forgetSession', () => {
  const f = freshFile();
  const a = new Prefs(f);
  a.setSkillAllowlist('worker', ['A', 'B']);

  const b = new Prefs(f);
  assert.deepEqual(b.skillAllowlistFor('worker'), ['A', 'B']);
  b.forgetSession('worker');
  assert.equal(b.skillAllowlistFor('worker'), null);
  rmSync(f, { force: true });
});

test('choices persist across a reload (new Prefs over the same file)', () => {
  const f = freshFile();
  const a = new Prefs(f);
  a.setMcpDefault('chrome', true);
  a.setSessionMcp('s1', 'chrome', false);
  a.setSessionSkill('s1', 'pdf', false);
  // Re-open: a fresh instance must read back the same state.
  const b = new Prefs(f);
  assert.deepEqual(b.mcpDefaultOn, ['chrome']);
  assert.deepEqual(b.enabledMcpFor('s1'), []);
  assert.deepEqual(b.disabledSkillsFor('s1'), ['pdf']);
  rmSync(f, { force: true });
});

test('forgetSession clears that session, leaves others + defaults', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setMcpDefault('chrome', true);
  p.setSessionMcp('s1', 'chrome', false);
  p.setSessionSkill('s1', 'pdf', false);
  p.setSessionMcp('s2', 'chrome', false);
  p.forgetSession('s1');
  // s1 reverts to inheriting the default; its skill-disable is gone.
  assert.deepEqual(p.enabledMcpFor('s1'), ['chrome']);
  assert.deepEqual(p.disabledSkillsFor('s1'), []);
  // s2 untouched; global default intact.
  assert.deepEqual(p.enabledMcpFor('s2'), []);
  assert.deepEqual(p.mcpDefaultOn, ['chrome']);
  rmSync(f, { force: true });
});

test('malformed/missing prefs file loads as empty (no throw)', () => {
  const f = freshFile();
  // never written → load() hits ENOENT → empty
  const p = new Prefs(f);
  assert.deepEqual(p.mcpDefaultOn, []);
  assert.deepEqual(p.enabledMcpFor('s1'), []);
  // writing then re-reading creates the file
  p.setMcpDefault('x', true);
  assert.ok(existsSync(f));
  assert.match(readFileSync(f, 'utf-8'), /mcpDefaultOn/);
  rmSync(f, { force: true });
});

// ── Trash (soft delete) ───────────────────────────────────────────────────────

test('trashSession marks; trashedIds + isTrashed reflect it', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.equal(p.isTrashed('s1'), false);
  p.trashSession('s1', 'cleanup');
  assert.equal(p.isTrashed('s1'), true);
  assert.deepEqual([...p.trashedIds()], ['s1']);
  const e = p.trashedEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].sessionId, 's1');
  assert.equal(e[0].reason, 'cleanup');
  assert.match(e[0].at, /^\d{4}-\d\d-\d\dT/); // ISO timestamp
  rmSync(f, { force: true });
});

test('restoreSession clears the mark', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.trashSession('s1');
  p.restoreSession('s1');
  assert.equal(p.isTrashed('s1'), false);
  assert.deepEqual([...p.trashedIds()], []);
  rmSync(f, { force: true });
});

test('trash persists across reload', () => {
  const f = freshFile();
  new Prefs(f).trashSession('s1', 'r');
  const b = new Prefs(f);
  assert.equal(b.isTrashed('s1'), true);
  assert.equal(b.trashedEntries()[0].reason, 'r');
  rmSync(f, { force: true });
});

test('forgetSession (purge) also clears the trash mark', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.trashSession('s1');
  p.setSessionMcp('s1', 'chrome', true);
  p.forgetSession('s1');
  assert.equal(p.isTrashed('s1'), false);
  assert.deepEqual(p.enabledMcpFor('s1'), []);
  rmSync(f, { force: true });
});

test('trash is independent per session', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.trashSession('s1');
  assert.equal(p.isTrashed('s1'), true);
  assert.equal(p.isTrashed('s2'), false);
  rmSync(f, { force: true });
});

// ── Pinned (keep-loaded) ────────────────────────────────────────────────────────

test('setPinned marks; isPinned + pinnedIds reflect it', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.equal(p.isPinned('s1'), false);
  p.setPinned('s1', true);
  assert.equal(p.isPinned('s1'), true);
  assert.deepEqual([...p.pinnedIds()], ['s1']);
  p.setPinned('s1', false);
  assert.equal(p.isPinned('s1'), false);
  assert.deepEqual([...p.pinnedIds()], []);
  rmSync(f, { force: true });
});

test('pinned persists across reload', () => {
  const f = freshFile();
  new Prefs(f).setPinned('s1', true);
  const p2 = new Prefs(f);
  assert.equal(p2.isPinned('s1'), true);
  rmSync(f, { force: true });
});

test('forgetSession (purge) also clears the pin', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setPinned('s1', true);
  p.forgetSession('s1');
  assert.equal(p.isPinned('s1'), false);
  rmSync(f, { force: true });
});

test('pin is independent per session + idempotent', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setPinned('s1', true);
  p.setPinned('s1', true); // idempotent — no duplicate
  assert.deepEqual([...p.pinnedIds()], ['s1']);
  assert.equal(p.isPinned('s2'), false);
  rmSync(f, { force: true });
});

// ── Butler/Flow trigger layer: hooks / welcomed / spawnedBy persistence ──────
// These survive a process restart (the trigger layer re-arms from prefs), so the
// round-trip through a fresh Prefs on the same file is the real invariant.
test('hooks round-trip across reload', () => {
  const f = freshFile();
  const p = new Prefs(f);
  const hooks = [{
    id: 'hook-1', ownerSession: 'butler', event: 'session.first-turn-complete',
    promptTemplate: 'welcome {event.sessionId}', createdAt: 1,
  }];
  p.setHooks(hooks);
  const p2 = new Prefs(f); // simulate restart
  assert.deepEqual(p2.hooks, hooks);
  rmSync(f, { force: true });
});

test('welcomed once-bit persists and is idempotent', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.equal(p.isWelcomed('s1'), false);
  p.markWelcomed('s1');
  p.markWelcomed('s1'); // idempotent — no duplicate
  const p2 = new Prefs(f);
  assert.equal(p2.isWelcomed('s1'), true);
  assert.equal(p2.isWelcomed('s2'), false);
  rmSync(f, { force: true });
});

test('spawnedBy (R1 mark) persists across reload', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.equal(p.spawnedByOf('w1'), undefined);
  p.setSpawnedBy('w1', 'welcome-flow');
  const p2 = new Prefs(f);
  assert.equal(p2.spawnedByOf('w1'), 'welcome-flow');
  rmSync(f, { force: true });
});

test('forgetSession clears hooks owned, welcomed bit, and spawnedBy', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setHooks([{ id: 'hook-1', ownerSession: 's1', event: 'session.first-turn-complete', promptTemplate: 'x', createdAt: 1 }]);
  p.markWelcomed('s1');
  p.setSpawnedBy('s1', 'f1');
  p.forgetSession('s1');
  assert.deepEqual(p.hooks, []);
  assert.equal(p.isWelcomed('s1'), false);
  assert.equal(p.spawnedByOf('s1'), undefined);
  rmSync(f, { force: true });
});

// ── scheduledSessions index (keep-loaded driver; replaces pin for lifecycle) ──
test('setScheduleCount records >0 and clears at 0; scheduledSessionIds reflects it', () => {
  const f = freshFile();
  const p = new Prefs(f);
  assert.deepEqual(p.scheduledSessionIds(), []);
  p.setScheduleCount('s1', 2);
  p.setScheduleCount('s2', 1);
  assert.deepEqual(p.scheduledSessionIds().sort(), ['s1', 's2']);
  // dropping to 0 removes it
  p.setScheduleCount('s1', 0);
  assert.deepEqual(p.scheduledSessionIds(), ['s2']);
  rmSync(f, { force: true });
});

test('scheduledSessions persists across reload (startup reload source)', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setScheduleCount('daemon', 3);
  const p2 = new Prefs(f); // simulate restart
  assert.deepEqual(p2.scheduledSessionIds(), ['daemon']);
  rmSync(f, { force: true });
});

test('forgetSession clears the scheduled-sessions entry', () => {
  const f = freshFile();
  const p = new Prefs(f);
  p.setScheduleCount('s1', 1);
  p.forgetSession('s1');
  assert.deepEqual(p.scheduledSessionIds(), []);
  rmSync(f, { force: true });
});

test('tolerates an old prefs file with no scheduledSessions field', () => {
  const f = freshFile();
  // write a prefs file shaped like the pre-feature version (has pinnedSessions, no scheduledSessions)
  writeFileSync(f, JSON.stringify({ pinnedSessions: ['old'], mcpDefaultOn: [] }));
  const p = new Prefs(f);
  assert.deepEqual(p.scheduledSessionIds(), []);
  assert.equal(p.isPinned('old'), true); // pin still read (kept)
  rmSync(f, { force: true });
});

// ── Durability: atomic write + corrupt-load preservation (R1 fork-bomb guard) ──
// These lock the fix for docs/review/04-orchestration.md [High] #2: a non-atomic
// write + silent reset-to-empty could wipe the persisted R1 safety state
// (spawnedBySession/welcomedSessions) on a truncated/corrupt prefs file, re-opening
// the welcome-worker-spawns-a-worker fork bomb. All use a temp file — the real
// ~/.copilot/cockpit-prefs.json is never touched.

test('interrupted write leaves the prior prefs file intact (tmp+rename semantics)', () => {
  const f = freshFile();
  const p = new Prefs(f);
  // Persist the R1 safety state. A successful save() must rename the .tmp over the
  // live file, leaving NO stray .tmp behind.
  p.setSpawnedBy('worker-A', 'welcome-flow');
  p.markWelcomed('real-1');
  assert.equal(existsSync(`${f}.tmp`), false, 'a completed save must consume its .tmp via rename');
  const goodBytes = readFileSync(f, 'utf-8');

  // Simulate a crash mid-save: a partial .tmp was written but the process died
  // before renameSync ran. With tmp+rename the live file is NEVER the write target,
  // so it must be byte-for-byte unchanged (the old non-atomic write would have
  // truncated it here).
  writeFileSync(`${f}.tmp`, '{ "spawnedBySession": { "worker-A": "welc');
  assert.equal(readFileSync(f, 'utf-8'), goodBytes, 'the live file must be untouched by a stray partial .tmp');

  // A fresh process (restart) reads back the intact safety state — not empty().
  const p2 = new Prefs(f);
  assert.equal(p2.spawnedByOf('worker-A'), 'welcome-flow');
  assert.equal(p2.isWelcomed('real-1'), true);
  rmSync(dirname(f), { recursive: true, force: true });
});

test('corrupt prefs with safety state is preserved as .corrupt-* and not clobbered by next save', () => {
  const f = freshFile();
  // Invalid JSON (missing closing brace) that STILL textually contains the R1
  // safety state — i.e. recoverable by hand.
  const corruptText =
    '{\n  "spawnedBySession": { "worker-A": "welcome-flow" },\n  "welcomedSessions": ["real-1"]\n';
  writeFileSync(f, corruptText);

  const logs: string[] = [];
  const p = new Prefs(f, (m) => logs.push(m));

  // It warned loudly (did not fail silently).
  assert.ok(logs.some((m) => /corrupt/i.test(m)), 'a corrupt load must log loudly');
  // It started from empty — it did NOT silently inherit the unparseable state.
  assert.equal(p.spawnedByOf('worker-A'), undefined);
  assert.equal(p.isWelcomed('real-1'), false);

  // The corrupt bytes were preserved verbatim under a .corrupt-* sibling.
  const dir = dirname(f);
  const baks = readdirSync(dir).filter((n) => n.startsWith('prefs.json.corrupt-'));
  assert.equal(baks.length, 1, 'exactly one .corrupt-* backup must be created');
  const bakPath = join(dir, baks[0]);
  assert.equal(readFileSync(bakPath, 'utf-8'), corruptText, 'the recoverable bytes must be preserved verbatim');
  // The original path was renamed away, so it no longer exists until save() recreates it.
  assert.equal(existsSync(f), false);

  // The next mutation save()s a fresh file at the original path — it must NOT
  // overwrite the preserved backup; recovery stays possible.
  p.setSpawnedBy('worker-B', 'welcome-flow');
  assert.equal(existsSync(f), true, 'next save recreates the live prefs file');
  assert.equal(readFileSync(bakPath, 'utf-8'), corruptText, 'the .corrupt-* backup must NOT be clobbered by save()');
  rmSync(dir, { recursive: true, force: true });
});

test('R1 guard stays closed for a known worker across a crash-mid-write then reload', () => {
  const f = freshFile();
  const p = new Prefs(f);
  // worker-A is a Flow-spawned worker (R1 mark); real-1 is a welcomed source.
  p.setSpawnedBy('worker-A', 'welcome-flow');
  p.markWelcomed('real-1');

  // Sanity: before any durability event, R1 already suppresses the worker.
  assert.equal(
    firstTurnEligible({
      spawnedBy: p.spawnedByOf('worker-A'),
      alreadyWelcomed: p.isWelcomed('worker-A'),
      cancelled: false,
      userPrompts: 1,
      assistantMessages: 1,
    }),
    false,
  );

  // Simulate a crash during a later save(): a partial .tmp is left behind, the
  // rename never happened. The atomic write means the live file is untouched.
  writeFileSync(`${f}.tmp`, '{ "spawnedBySession": { "worker-A":');

  // Restart: a fresh Prefs reads the intact original, so the worker's spawnedBy
  // survives and firstTurnEligible STAYS false — the fork-bomb guard is NOT
  // re-opened by the durability event (the bug this fix closes).
  const reloaded = new Prefs(f);
  assert.equal(reloaded.spawnedByOf('worker-A'), 'welcome-flow');
  assert.equal(
    firstTurnEligible({
      spawnedBy: reloaded.spawnedByOf('worker-A'),
      alreadyWelcomed: reloaded.isWelcomed('worker-A'),
      cancelled: false,
      userPrompts: 1, // a worker that finished exactly its one born-ready turn
      assistantMessages: 1,
    }),
    false,
    'R1 must keep suppressing the worker after a crash-mid-write + reload',
  );
  rmSync(dirname(f), { recursive: true, force: true });
});
