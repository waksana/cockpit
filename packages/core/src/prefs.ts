// Cockpit-side preferences for MCP + skills. The SDK's per-session enable/disable
// is runtime-only (lost on reload), and the global mcp-config.json has no notion
// of "default on/off" or "which session uses which server". We persist that
// intent ourselves in a small JSON file so the user's choices survive restarts.
//
// Shape:
//   mcpDefaultOn:            server names enabled by default for NEW sessions.
//   mcpBySession[sessionId]: explicit enabled-server set for a session (overrides
//                            the default once the user has touched that session).
//   skillsDisabledBySession[sessionId]: skills the user turned OFF for a session.
//   skillsAllowlistBySession[sessionId]: strict enabled-skill set; everything else,
//                                        including future skills, stays disabled.
//   trashed[sessionId]: a soft-deleted session — kept on disk, hidden from the
//                       main list, restorable. Permanent purge is a separate step.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HookEntry, FlowScheduleEntry } from '@cockpit/protocol';
import { copilotPath } from './paths.ts';

// A loud-failure sink for prefs durability problems. Prefs is the home of the R1
// anti-fork-bomb safety state (spawnedBySession/welcomedSessions), so a swallowed
// save failure or a corrupt-load reset is a SAFETY event, not a cosmetic one — it
// must be observable. Defaults to console.error; injectable for tests.
export type PrefsLogger = (msg: string) => void;

export interface TrashedMark { at: string; reason?: string }

export interface CockpitPrefs {
  mcpDefaultOn: string[];
  mcpBySession: Record<string, string[]>;
  skillsDisabledBySession: Record<string, string[]>;
  skillsAllowlistBySession: Record<string, string[]>;
  trashed: Record<string, TrashedMark>;
  // Sessions the user PINNED — a pure UI mark (sorted to the top of the list,
  // synced across devices). NOTE: pin no longer means keep-loaded; keep-loaded is
  // driven by the scheduledSessions index below (has-schedule). Kept for the UI.
  pinnedSessions: string[];
  // ── Butler/Flow trigger layer ──────────────────────────────────────────────
  // Event hooks (engine-global, cross-session). Persisted so they survive a
  // reload/restart and are re-armed on engine.start (the trigger layer is
  // server-process-level, not bound to any session being loaded).
  hooks: HookEntry[];
  // The per-source "already welcomed" once-bits: source sessions for which
  // session.first-turn-complete has already fired. Persisted so a restart does
  // not re-welcome an established session.
  welcomedSessions: string[];
  // R1: sessionId → flowId for sessions SPAWNED by a Flow (workers). A spawnedBy
  // session is a non-trigger-source; persisted so the R1 guard + (Phase C) UI
  // folding survive reload/restart.
  spawnedBySession: Record<string, string>;
  // Server-level flow schedules (time triggers that fire a flow). Engine-global,
  // not bound to any session; persisted so they re-arm on cockpit-server restart.
  flowSchedules: FlowScheduleEntry[];
  // sessionId → number of active per-session schedules on it. The persistent index
  // that drives KEEP-LOADED: a session with >=1 per-session schedule must stay
  // resident (its in-memory SDK ScheduleRegistry stops if evicted) and be reloaded
  // on startup. Maintained as schedules are added/removed; survives restart so the
  // engine knows WHICH sessions to reload before any session is loaded (the SDK
  // registry is only readable once a session is loaded — the chicken-and-egg).
  scheduledSessions: Record<string, number>;
}

const PREFS_FILE = copilotPath('cockpit-prefs.json');

function empty(): CockpitPrefs {
  return {
    mcpDefaultOn: [], mcpBySession: {}, skillsDisabledBySession: {}, skillsAllowlistBySession: {}, trashed: {},
    pinnedSessions: [], hooks: [], welcomedSessions: [], spawnedBySession: {}, flowSchedules: [],
    scheduledSessions: {},
  };
}

export class Prefs {
  private data: CockpitPrefs;
  private readonly file: string;
  private readonly log: PrefsLogger;

  // `file` is injectable for tests; defaults to ~/.copilot/cockpit-prefs.json.
  // `log` surfaces durability failures (corrupt load / failed save); defaults to
  // console.error so a swallowed safety-state loss can never go silent.
  constructor(file: string = PREFS_FILE, log: PrefsLogger = (m) => console.error(m)) {
    this.file = file;
    this.log = log;
    this.data = this.load();
  }

  private load(): CockpitPrefs {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch {
      // The file does not exist yet (ENOENT) or is unreadable — a legitimate
      // first run. Start from empty WITHOUT touching disk: there is nothing to
      // preserve and nothing was lost.
      return empty();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CockpitPrefs>;
      return {
        mcpDefaultOn: Array.isArray(parsed.mcpDefaultOn) ? parsed.mcpDefaultOn : [],
        mcpBySession: parsed.mcpBySession ?? {},
        skillsDisabledBySession: parsed.skillsDisabledBySession ?? {},
        skillsAllowlistBySession: parsed.skillsAllowlistBySession ?? {},
        trashed: parsed.trashed ?? {},
        pinnedSessions: Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions : [],
        hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
        welcomedSessions: Array.isArray(parsed.welcomedSessions) ? parsed.welcomedSessions : [],
        spawnedBySession: parsed.spawnedBySession ?? {},
        flowSchedules: Array.isArray(parsed.flowSchedules) ? parsed.flowSchedules : [],
        scheduledSessions: parsed.scheduledSessions ?? {},
      };
    } catch (e) {
      // The file exists but does not parse. It very likely still contains the R1
      // safety state (spawnedBySession/welcomedSessions) in recoverable form, so
      // we must NOT silently start from empty and then clobber it. Rename the
      // corrupt bytes aside (.corrupt-<ts>) and warn loudly. Because the original
      // path is now free, the next save() writes a fresh file and CANNOT overwrite
      // the preserved evidence — it stays on disk for manual recovery. We return
      // empty() (rather than throwing) so a corrupt prefs file does not crash boot.
      const bak = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, bak);
        this.log(
          `cockpit-prefs.json is CORRUPT — preserved the recoverable bytes at ${bak} and started ` +
          `from EMPTY. Butler/R1 safety state (spawnedBy/welcomed) was reset in memory; restore by ` +
          `hand from the backup. Parse error: ${(e as Error).message}`,
        );
      } catch (renameErr) {
        this.log(
          `cockpit-prefs.json is CORRUPT and could not be preserved (${(renameErr as Error).message}); ` +
          `started from EMPTY. Parse error: ${(e as Error).message}`,
        );
      }
      return empty();
    }
  }

  private save(): void {
    // Atomic write: serialize to a sibling .tmp, then rename it over the live
    // file. rename(2) is atomic on the same filesystem, so a crash / power loss /
    // ENOSPC mid-write can never truncate the live prefs — a reader either sees
    // the whole old file or the whole new one, never a partial document. This is
    // what stops a corruption-on-write from wiping the R1 safety state.
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      // Do NOT swallow: a failed persist (disk full, EACCES) means in-memory
      // state has diverged from disk and a restart will silently revert it.
      // Surface it so the loss is observable.
      this.log(`cockpit-prefs.json save FAILED — in-memory changes were not persisted: ${(e as Error).message}`);
    }
  }

  // ── MCP ────────────────────────────────────────────────────────────────────
  get mcpDefaultOn(): string[] { return [...this.data.mcpDefaultOn]; }

  setMcpDefault(server: string, on: boolean): void {
    const set = new Set(this.data.mcpDefaultOn);
    if (on) set.add(server); else set.delete(server);
    this.data.mcpDefaultOn = [...set];
    this.save();
  }

  // The enabled-server set for a session: its explicit set if the user has touched
  // it, otherwise the global default-on set (so new sessions inherit defaults).
  enabledMcpFor(sessionId: string): string[] {
    const explicit = this.data.mcpBySession[sessionId];
    return explicit ? [...explicit] : [...this.data.mcpDefaultOn];
  }

  setSessionMcp(sessionId: string, server: string, on: boolean): void {
    const cur = new Set(this.enabledMcpFor(sessionId));
    if (on) cur.add(server); else cur.delete(server);
    this.data.mcpBySession[sessionId] = [...cur];
    this.save();
  }

  // ── Skills ───────────────────────────────────────────────────────────────────
  disabledSkillsFor(sessionId: string): string[] {
    return [...(this.data.skillsDisabledBySession[sessionId] ?? [])];
  }

  skillAllowlistFor(sessionId: string): string[] | null {
    const allowlist = this.data.skillsAllowlistBySession[sessionId];
    return allowlist ? [...allowlist] : null;
  }

  setSkillAllowlist(sessionId: string, names: string[]): void {
    this.data.skillsAllowlistBySession[sessionId] = [...new Set(names)];
    delete this.data.skillsDisabledBySession[sessionId];
    this.save();
  }

  setSessionSkill(sessionId: string, skill: string, enabled: boolean): void {
    const allowlist = this.skillAllowlistFor(sessionId);
    if (allowlist !== null) {
      const enabledSkills = new Set(allowlist);
      if (enabled) enabledSkills.add(skill); else enabledSkills.delete(skill);
      this.data.skillsAllowlistBySession[sessionId] = [...enabledSkills];
      this.save();
      return;
    }
    const off = new Set(this.disabledSkillsFor(sessionId));
    if (enabled) off.delete(skill); else off.add(skill);
    this.data.skillsDisabledBySession[sessionId] = [...off];
    this.save();
  }

  // ── Trash (soft delete) ──────────────────────────────────────────────────────
  trashSession(sessionId: string, reason?: string): void {
    this.data.trashed[sessionId] = { at: new Date().toISOString(), ...(reason ? { reason } : {}) };
    this.save();
  }

  restoreSession(sessionId: string): void {
    delete this.data.trashed[sessionId];
    this.save();
  }

  isTrashed(sessionId: string): boolean {
    return sessionId in this.data.trashed;
  }

  // The set of trashed session ids (for filtering the main list).
  trashedIds(): Set<string> {
    return new Set(Object.keys(this.data.trashed));
  }

  // Full trash entries: id + mark. Title/cwd are joined in by the engine.
  trashedEntries(): Array<{ sessionId: string } & TrashedMark> {
    return Object.entries(this.data.trashed).map(([sessionId, mark]) => ({ sessionId, ...mark }));
  }

  // ── Pinned (keep-loaded) ─────────────────────────────────────────────────────
  isPinned(sessionId: string): boolean {
    return this.data.pinnedSessions.includes(sessionId);
  }

  pinnedIds(): Set<string> {
    return new Set(this.data.pinnedSessions);
  }

  setPinned(sessionId: string, pinned: boolean): void {
    const set = new Set(this.data.pinnedSessions);
    if (pinned) set.add(sessionId); else set.delete(sessionId);
    this.data.pinnedSessions = [...set];
    this.save();
  }

  // ── Hooks (Butler/Flow trigger layer; engine-global) ─────────────────────────
  get hooks(): HookEntry[] { return [...this.data.hooks]; }

  setHooks(hooks: HookEntry[]): void {
    this.data.hooks = [...hooks];
    this.save();
  }

  // ── First-turn-complete once-bits (per source session) ───────────────────────
  isWelcomed(sessionId: string): boolean {
    return this.data.welcomedSessions.includes(sessionId);
  }

  markWelcomed(sessionId: string): void {
    if (this.data.welcomedSessions.includes(sessionId)) return;
    this.data.welcomedSessions.push(sessionId);
    this.save();
  }

  // ── spawnedBy (R1: worker = non-trigger-source) ──────────────────────────────
  spawnedByOf(sessionId: string): string | undefined {
    return this.data.spawnedBySession[sessionId];
  }

  setSpawnedBy(sessionId: string, flowId: string): void {
    this.data.spawnedBySession[sessionId] = flowId;
    this.save();
  }

  // ── Flow schedules (server-level time triggers) ──────────────────────────────
  get flowSchedules(): FlowScheduleEntry[] { return [...this.data.flowSchedules]; }

  setFlowSchedules(entries: FlowScheduleEntry[]): void {
    this.data.flowSchedules = [...entries];
    this.save();
  }

  // ── Scheduled-sessions index (drives keep-loaded; the has-schedule signal) ───
  // Record how many per-session schedules a session has. count<=0 removes it. This
  // is the persistent index the engine reads at startup to know which sessions to
  // reload (so their in-memory schedules re-arm) — independent of pin.
  setScheduleCount(sessionId: string, count: number): void {
    const cur = this.data.scheduledSessions[sessionId] ?? 0;
    if (count > 0) {
      if (cur === count) return;
      this.data.scheduledSessions[sessionId] = count;
    } else {
      if (!(sessionId in this.data.scheduledSessions)) return;
      delete this.data.scheduledSessions[sessionId];
    }
    this.save();
  }

  // The session ids that currently have >=1 per-session schedule.
  scheduledSessionIds(): string[] {
    return Object.keys(this.data.scheduledSessions);
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────
  forgetSession(sessionId: string): void {
    delete this.data.mcpBySession[sessionId];
    delete this.data.skillsDisabledBySession[sessionId];
    delete this.data.skillsAllowlistBySession[sessionId];
    delete this.data.trashed[sessionId];
    this.data.pinnedSessions = this.data.pinnedSessions.filter((id) => id !== sessionId);
    this.data.welcomedSessions = this.data.welcomedSessions.filter((id) => id !== sessionId);
    delete this.data.spawnedBySession[sessionId];
    delete this.data.scheduledSessions[sessionId];
    // Drop any hooks this session owned (its deliveries had nowhere to go anyway).
    this.data.hooks = this.data.hooks.filter((h) => h.ownerSession !== sessionId);
    this.save();
  }
}
