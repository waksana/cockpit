// Engine — the authoritative in-process domain server. Owns all session state,
// sourced solely from the SDK event stream; emits ServerEvent for the transport
// to fan out. Thin transports project this; they hold no domain logic.
//
// Pitfall lessons applied:
//  A5  per-session load mutex (loadPromise) — concurrent materialize never wipes.
//  A10 every SDK call wrapped; failures surface as session error, never crash.
//  B1  single source of truth; B2 no optimistic echo (the SDK's user.message
//      event is the one truth, folded like any other).
//  F3  YOLO — auto-approve every permission request.

import { EventEmitter } from 'node:events';
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  AgentStatus, AskRequest, ChatMessage, ModelOption, QueuedItem,
  ServerEvent, SessionMeta, SessionPlan, TodoItem, SessionPanels, PanelItem, DirListing,
  ScheduleEntry, Attention, ExitPlanModeAction, HookEntry, SessionEventCtx, Flow, SessionTemplate,
  FlowScheduleEntry, InlineScheduleTarget, McpServerSession, McpServerStatus,
  McpToggleOperation, McpToggleResult,
} from '@cockpit/protocol';
import { bootstrap } from './bootstrap.ts';
import { foldEvent, newFoldState, resetTurn, cleanSessionTitle, type FoldState } from './fold.ts';
import type { SdkSession, SdkSessionManager, SdkSessionMeta, SdkEvent } from './sdk-types.ts';
import {
  imageBytesOf, pickEvictionVictims, readHeap, HEAP_HIGH_FRAC, HEAP_LOW_FRAC, HEAP_HARD_FRAC,
} from './memory.ts';
import { nextAttention, applySeen } from './attention.ts';
import {
  sessionMetaBusy, engineSessionBusy, makeQueueId, parseQueueId, queueTextTag,
} from './lifecycle.ts';
// Re-export the shared busy predicates so the transport (which only holds a
// SessionMeta snapshot) can consume the SAME definition the Engine uses for
// eviction/unload/reload, instead of maintaining its own drifting copy.
export { sessionMetaBusy, engineSessionBusy } from './lifecycle.ts';
import { HookRegistry, firstTurnEligible, sessionErrorEligible, matchHooks, countTurnSignals, isGlobalEvent, bootFilterRejection } from './hooks.ts';
import { FlowRegistry, runGate, interpolateFlow } from './flows.ts';
import { FlowScheduleRegistry } from './flow-schedule.ts';
import { Prefs } from './prefs.ts';
import { copilotPath, sessionStorePath } from './paths.ts';
import { purgeSessionRows } from './session-store-cleanup.ts';
import { repairNegativeCompactionTokens } from './session-event-repair.ts';
import { readGlobalMcpServers, describeMcpServer, normalizeMcpServersForSdk, type McpServersRecord } from './mcp-config.ts';

const HISTORY_PAGE = 30;
// Bound in-memory materialized windows: keep at most this many sessions loaded
// (with their full fold history + live tap). When exceeded, evict the
// least-recently-active IDLE session; it transparently reloads when reopened.
const MAX_MATERIALIZED = 16;
// Heap-pressure watchdog (memory.ts). Re-sent base64 images dominate the heap;
// several image-heavy sessions at once hit V8's ceiling and abort the process
// (the OOM that caused the 11th restart). The watchdog proactively unloads the
// heaviest IDLE sessions before the wall. Tunables (tuned aggressive 2026-06-19
// after repeated OOMs: allocation was outrunning eviction near the ceiling):
const MEMORY_WATCHDOG_MS = 8_000;    // baseline sampling cadence when heap is calm
const MEMORY_WATCHDOG_FAST_MS = 2_000; // sampling cadence while heap is above the high-water mark
const GC_GRACE_MS = 8_000;           // wait after evicting (heapUsed only drops post-GC; we force a GC each grace tick so a shorter grace stays accurate)
const MAX_EVICT_PER_TICK = 5;        // cap damage from a single over-eager pass
// Throttle for forwarding `lastActivity` to clients. The session's lastActivity is
// recomputed on every streamed message; emitting a session/patch per token would
// double SSE volume. Forwarding at most once/sec keeps the sidebar ordering server-
// authoritative (so the web can drop its client-side Date.now() synthesis) at a
// granularity far finer than the relative-time UI needs.
const LASTACTIVITY_EMIT_MS = 1_000;
// Per-source rate-limit window for the session.error triage event: at most one
// fire per source session per this interval, so a session stuck in an error loop
// can't storm the trigger bus. The triage gate adds its own dedup on top.
const SESSION_ERROR_WINDOW_MS = 60_000;
// SessionMeta fields that are `.nullable()` AND the engine genuinely clears. A
// patch that sets one of these to `undefined` would be dropped by JSON.stringify
// and never clear on the client; patch() normalizes undefined→null for exactly
// these. currentModelId/availableModels stay pure-optional (schema rejects null).
const CLEARABLE_META_FIELDS = ['currentReasoningEffort', 'currentContextTier', 'currentMode', 'launchState'] as const;
const FLOW_LAUNCH_MARKER = 'cockpit-launch.json';
const DEFAULT_FLOW_FIRST_TURN_TIMEOUT_MS = 15_000;
const DEFAULT_FLOW_FIRST_TURN_POLL_MS = 50;
const DEFAULT_FLOW_FIRST_TURN_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_MCP_TOGGLE_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_TOGGLE_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_MCP_TOGGLE_POLL_MS = 50;
const DEFAULT_MCP_RELOAD_RETRY_BASE_MS = 1_000;
const MAX_MCP_RELOAD_ATTEMPTS = 3;
// Default cwd for sessions / flow-spawned workers that don't specify one. Use the
// OS home dir (cross-platform: USERPROFILE on Windows, $HOME on POSIX) rather than
// a hardcoded literal, and prefer homedir() over $HOME since Windows leaves $HOME unset.
const HOME = homedir();

interface SessionState {
  meta: SessionMeta;
  fold: FoldState;
  sdk: SdkSession | null;
  loadPromise: Promise<void> | null;
  materialized: boolean;
  unsub: (() => void) | null;
  cwd: string;
  // Estimated resident image weight (sum of base64 image-payload lengths across
  // this session's events). Drives heaviest-first eviction under heap pressure.
  imageBytes: number;
  // toolCallIds of in-flight `task` sub-agent invocations. A background sub-agent
  // outlives its spawning turn, so this set — not `status` — is what tells the
  // graceful-restart gate a session is still doing work. Added on the task tool's
  // execution_start, removed on its execution_complete, and CLEARED on abort
  // (where the SDK may not emit a completion) and on unload.
  inflightTasks: Set<string>;
  // Set by planSupersede: the user typed a new instruction during a pending plan,
  // so we temporarily left plan mode to run it. When that turn finishes (idle),
  // restore plan mode — they were deliberately planning; the override was one-off.
  restorePlanOnIdle?: boolean;
  // Set by cancel(): the just-running turn was user-aborted, so the next
  // session.idle is NOT a natural completion and must not raise a butler event
  // (firstTurnEligible reads this). Cleared at the next assistant.turn_start.
  turnCancelled?: boolean;
  // Last wall-clock at which `lastActivity` was forwarded to clients (throttle
  // state for LASTACTIVITY_EMIT_MS). Absent until the first forward.
  lastActivityEmit?: number;
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? '';
}

interface FlowLaunchMarker {
  version: 1;
  flowId: string;
  state: 'launching' | 'launch_failed';
  updatedAt: number;
  error?: string;
}

interface SpawnedFirstTurnSnapshot {
  hasUserMessage: boolean;
  lastWarning: string | null;
  lastError: string | null;
}

interface PromptHookFailure {
  message: string;
  source?: string;
  stack?: string;
}

interface McpToggleRuntime {
  sessionId: string;
  name: string;
  desiredEnabled: boolean;
  operation: McpToggleOperation;
  ok: boolean;
  applied: boolean;
}

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flowFirstTurnSubmissionTimeoutMs(): number {
  return readEnvMs(
    'COCKPIT_FLOW_FIRST_TURN_SUBMISSION_TIMEOUT_MS',
    readEnvMs('COCKPIT_FLOW_FIRST_TURN_ACCEPT_TIMEOUT_MS', DEFAULT_FLOW_FIRST_TURN_TIMEOUT_MS),
  );
}

function flowFirstTurnDurableTimeoutMs(): number {
  return readEnvMs(
    'COCKPIT_FLOW_FIRST_TURN_DURABLE_TIMEOUT_MS',
    readEnvMs('COCKPIT_FLOW_FIRST_TURN_ACCEPT_TIMEOUT_MS', DEFAULT_FLOW_FIRST_TURN_TIMEOUT_MS),
  );
}

function flowFirstTurnPollMs(): number {
  return Math.max(10, readEnvMs('COCKPIT_FLOW_FIRST_TURN_POLL_MS', DEFAULT_FLOW_FIRST_TURN_POLL_MS));
}

function flowFirstTurnCleanupTimeoutMs(): number {
  return readEnvMs(
    'COCKPIT_FLOW_FIRST_TURN_CLEANUP_TIMEOUT_MS',
    DEFAULT_FLOW_FIRST_TURN_CLEANUP_TIMEOUT_MS,
  );
}

function eventText(ev: SdkEvent): string | null {
  const msg = ev.data?.message;
  if (typeof msg === 'string' && msg.trim().length > 0) return msg.trim();
  const content = ev.data?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content.trim() : null;
}

function promptHookFailureFromEvent(ev: SdkEvent): PromptHookFailure | null {
  if (ev.type !== 'hook.end' || ev.data?.hookType !== 'userPromptSubmitted' || ev.data?.success !== false) {
    return null;
  }
  const error = ev.data?.error;
  if (!error || typeof error !== 'object') return null;
  const raw = error as { message?: unknown; source?: unknown; stack?: unknown };
  if (typeof raw.message !== 'string' || !raw.message.trim()) return null;
  return {
    message: raw.message.trim(),
    ...(typeof raw.source === 'string' && raw.source.trim() ? { source: raw.source.trim() } : {}),
    ...(typeof raw.stack === 'string' && raw.stack.trim() ? { stack: raw.stack.trim() } : {}),
  };
}

function safeHookLabel(value: string, max = 200): string {
  return value.replace(/[\u0000-\u001f\u007f"\\`]/g, '_').slice(0, max);
}

function describePolicyHookFailure(detail: PromptHookFailure): string {
  const source = detail.source ? ` from "${safeHookLabel(detail.source)}"` : '';
  const timeout = /Hook command timed out after ([0-9.]+) seconds/i.exec(detail.message);
  if (timeout) return `Policy hook failed (userPromptSubmitted${source}: command timed out after ${timeout[1]} seconds)`;
  const exit = /Hook command failed with code (\d+)/i.exec(detail.message);
  if (exit) return `Policy hook failed (userPromptSubmitted${source}: command exited with code ${exit[1]})`;
  if (/\b(?:AbortError|aborted|operation was aborted)\b/i.test(detail.message)) {
    return `Policy hook failed (userPromptSubmitted${source}: command was aborted)`;
  }
  if (/\bENOENT\b/i.test(detail.message)) {
    return `Policy hook failed (userPromptSubmitted${source}: command could not start (ENOENT))`;
  }
  return `Policy hook failed (userPromptSubmitted${source}: callback failed; see server log for the preserved cause)`;
}

function readSpawnedFirstTurnSnapshot(
  sdk: SdkSession,
  baselineEventCount: number,
  prompt: string,
): SpawnedFirstTurnSnapshot {
  const events = sdk.getEvents().slice(baselineEventCount);
  let hasUserMessage = false;
  let lastWarning: string | null = null;
  let lastError: string | null = null;
  for (const ev of events) {
    if (typeof (ev as { agentId?: unknown }).agentId === 'string') continue;
    if (ev.type === 'user.message' && ev.data?.content === prompt) hasUserMessage = true;
    else if (ev.type === 'session.warning') lastWarning = eventText(ev) ?? lastWarning;
    else if (ev.type === 'session.error') lastError = eventText(ev) ?? lastError ?? '首轮启动失败';
  }
  return {
    hasUserMessage,
    lastWarning,
    lastError,
  };
}

function flowLaunchMarkerPath(sessionId: string): string {
  return copilotPath('session-state', sessionId, FLOW_LAUNCH_MARKER);
}

function writeFlowLaunchMarker(sessionId: string, marker: FlowLaunchMarker): void {
  const path = flowLaunchMarkerPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

function clearFlowLaunchMarker(sessionId: string): void {
  try { unlinkSync(flowLaunchMarkerPath(sessionId)); } catch { /* absent/stale is fine */ }
}

function readFlowLaunchMarker(sessionId: string): FlowLaunchMarker | null {
  const path = flowLaunchMarkerPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FlowLaunchMarker>;
    if (raw?.version !== 1) return null;
    if (raw.state !== 'launching' && raw.state !== 'launch_failed') return null;
    if (typeof raw.flowId !== 'string' || raw.flowId.trim().length === 0) return null;
    return {
      version: 1,
      flowId: raw.flowId,
      state: raw.state,
      updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
      ...(typeof raw.error === 'string' && raw.error.trim().length > 0 ? { error: raw.error } : {}),
    };
  } catch {
    return null;
  }
}

// A session with >=1 active per-session schedule is KEEP-LOADED: evicting it would
// stop its in-memory SDK ScheduleRegistry from firing. This is the has-schedule
// signal that replaced pin as the keep-loaded trigger (pin is now a pure UI mark).
function hasSchedule(st: SessionState): boolean {
  return (st.meta.scheduleCount ?? 0) > 0;
}

// Stat a path as a directory (follows symlinks). Throws on unreadable → caller skips.
function statIsDir(p: string): boolean {
  return statSync(p).isDirectory();
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked']);
function normalizeTodoStatus(s: string | undefined): TodoItem['status'] {
  return s && TODO_STATUSES.has(s) ? (s as TodoItem['status']) : 'pending';
}

// A redacted copy of an MCP server config for the detail pane: env/header VALUES
// are replaced with a masked placeholder (their KEYS are kept) so secrets never
// reach the client, while command/args/url/type/tools pass through unchanged.
function redactMcpConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if ((k === 'env' || k === 'headers') && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.keys(v as Record<string, unknown>).map((key) => [key, '••••••']));
    } else {
      out[k] = v;
    }
  }
  return out;
}

// cockpit runs 100% yolo (the operator is the sole user). Without a permission
// handler the SDK's default gate auto-DENIES every tool call (bash/edit/create…)
// — and the `permission.requested` event never fires, so an event-based approver
// is a no-op. Passing this handler at session creation makes every tool
// auto-approve (runtime-verified: bash then executes).
const APPROVE_ALL_PERMISSIONS = async (): Promise<{ kind: 'approved' }> => ({ kind: 'approved' });

function metaFromSdk(m: SdkSessionMeta): SessionState {
  const cwd = m.context?.cwd ?? HOME;
  const mtime = m.modifiedTime ? new Date(m.modifiedTime as string).getTime() : Date.now();
  return {
    meta: {
      sessionId: m.sessionId,
      title: cleanSessionTitle(m.summary).slice(0, 60) || cleanSessionTitle(m.name).slice(0, 60) || basename(cwd) || 'session',
      cwd,
      createdAt: m.startTime ? new Date(m.startTime as string).getTime() : undefined,
      lastActivity: mtime,
      status: 'unloaded',
      error: null,
      loaded: false,
      queue: [],
      ask: null,
    },
    fold: newFoldState(),
    sdk: null,
    loadPromise: null,
    materialized: false,
    unsub: null,
    cwd,
    imageBytes: 0,
    inflightTasks: new Set(),
  };
}

function applyPersistedFlowLaunchMeta(st: SessionState): void {
  const marker = readFlowLaunchMarker(st.meta.sessionId);
  if (!marker) return;
  st.meta.launchState = 'launch_failed';
  st.meta.status = 'error';
  st.meta.error = marker.state === 'launch_failed'
    ? (marker.error ?? 'flow worker first turn failed before it was durably accepted')
    : (marker.error ?? 'flow worker launch was interrupted before its first turn was durably accepted');
}

export class Engine {
  private readonly bus = new EventEmitter();
  private manager!: SdkSessionManager;
  private authInfo!: unknown;
  private ffs!: unknown;
  private readonly sessions = new Map<string, SessionState>();
  // Read-only, paginated previews of TRASHED sessions, folded from disk on demand.
  // Kept SEPARATE from `sessions` so a preview can never leak into the live list
  // (listLive iterates `sessions` with no trashed filter) nor be interacted with.
  // Small LRU — capped + dropped wholesale; no live taps, so no cleanup beyond delete.
  private readonly previews = new Map<string, { fold: FoldState; title: string; cwd: string }>();
  private agentStatus: AgentStatus = 'starting';
  private models: ModelOption[] = [];
  // Cockpit-side preferences. `prefs`, `hookReg`, and `flowSchedReg` are assigned
  // in the constructor (not as field initializers) so a test can inject an isolated
  // prefs file and never read/write the real ~/.copilot. `new Prefs()` is the only
  // real-filesystem touch at construction; the two registries hang off it.
  private readonly prefs: Prefs;
  // Test-only config injection keeps MCP-state tests independent of the operator's
  // real ~/.copilot/mcp-config.json. Production always reads the live file.
  private readonly mcpServersOverride?: McpServersRecord;
  // Butler/Flow trigger layer: engine-global, cross-session hook registry. Loaded
  // from prefs at construction (so hooks survive restart and are armed as soon as
  // the engine is up) and persisted back on every change. The SDK has no analog —
  // this is cockpit-native because hooks are cross-session (one butler reacts to
  // the whole fleet); it coexists additively with the SDK's per-session
  // ScheduleRegistry (self-reflexive timers), never replacing it.
  private readonly hookReg: HookRegistry;
  // Flow layer: definitions loaded from ~/.copilot/flows/*.json. The FlowRunner
  // (runFlow/spawnSession below) orchestrates gate → action using existing intents.
  private readonly flowReg = new FlowRegistry(undefined, (m, d) => this.log(m, d));
  // Server-level flow schedules (time triggers that fire a flow). Engine-global,
  // armed at start(), so they fire even with ZERO sessions loaded — the sibling of
  // the SDK's per-session ScheduleRegistry (which only fires while its session is
  // loaded). Persisted in prefs; re-armed across restart.
  private readonly flowSchedReg: FlowScheduleRegistry;
  // Per-source rate-limit for session.error: the last time the triage event fired
  // for a given source session, so a flapping session emits at most one event per
  // SESSION_ERROR_WINDOW_MS (prevents an error storm from spamming triage). Cleared
  // in forgetSession. In-memory only — a restart resets the window, which is fine
  // (a session that errors right after a restart genuinely deserves a fresh event).
  private readonly sessionErrorFiredAt = new Map<string, number>();
  // One observable operation per session/server. SDK MCP enable has no AbortSignal
  // and can outlive an HTTP caller while doing auth/network discovery, so a timed
  // out request must remain deduplicated and readable instead of becoming an
  // invisible mutation that callers may retry.
  private readonly mcpToggleOperations = new Map<string, McpToggleRuntime>();
  private readonly mcpReloadingSessions = new Set<string>();
  private readonly mcpReloadPendingSessions = new Set<string>();
  private readonly mcpReloadRetryAttempts = new Map<string, number>();
  private readonly mcpReloadRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private mcpToggleSequence = 0;
  private readonly mcpToggleTimeoutMs: number;
  private readonly mcpToggleCleanupTimeoutMs: number;
  private readonly mcpTogglePollMs: number;
  private readonly mcpReloadRetryBaseMs: number;
  // A: MCP-birth serialization gate. Every SDK "birth" call that cold-starts a
  // session's stdio MCP subprocess(es) — createSession / a resuming getSession — is
  // chained through this promise so at most ONE cold-start's initialize handshake is
  // in flight at a time. Concurrent births (a boot catch-up firing several due crons
  // in one tick, a hook/schedule burst) otherwise spawn N `node` MCP children that
  // fight for CPU during initialize, blowing the SDK's (uncontrollable) initialize
  // timeout → every attach fails -32001 and the MCP is marked `failed`. Serializing
  // the births removes that contention at the root. Never rejects (see mcpBirth).
  private mcpBirthGate: Promise<void> = Promise.resolve();
  // A timed-out MCP first send that ignored abort must never overlap the next MCP
  // birth. Later births fail loudly until that exact SDK send eventually settles.
  private mcpBirthQuarantine: { sessionId: string } | null = null;

  // opts.prefsFile lets tests point prefs at an isolated temp file (defaults to the
  // real ~/.copilot/cockpit-prefs.json). Behavior-preserving for `new Engine()`.
  constructor(opts: {
    prefsFile?: string;
    mcpServers?: McpServersRecord;
    mcpToggleTimeoutMs?: number;
    mcpToggleCleanupTimeoutMs?: number;
    mcpTogglePollMs?: number;
    mcpReloadRetryBaseMs?: number;
  } = {}) {
    this.prefs = new Prefs(opts.prefsFile);
    this.mcpServersOverride = opts.mcpServers;
    this.mcpToggleTimeoutMs = Math.max(1, Math.min(
      opts.mcpToggleTimeoutMs
        ?? readEnvMs('COCKPIT_MCP_TOGGLE_TIMEOUT_MS', DEFAULT_MCP_TOGGLE_TIMEOUT_MS),
      DEFAULT_MCP_TOGGLE_TIMEOUT_MS,
    ));
    this.mcpToggleCleanupTimeoutMs = Math.max(1, Math.min(
      opts.mcpToggleCleanupTimeoutMs
        ?? readEnvMs('COCKPIT_MCP_TOGGLE_CLEANUP_TIMEOUT_MS', DEFAULT_MCP_TOGGLE_CLEANUP_TIMEOUT_MS),
      DEFAULT_MCP_TOGGLE_CLEANUP_TIMEOUT_MS,
    ));
    this.mcpTogglePollMs = Math.max(5, Math.min(
      opts.mcpTogglePollMs ?? DEFAULT_MCP_TOGGLE_POLL_MS,
      DEFAULT_MCP_TOGGLE_POLL_MS,
    ));
    this.mcpReloadRetryBaseMs = Math.max(10, opts.mcpReloadRetryBaseMs ?? DEFAULT_MCP_RELOAD_RETRY_BASE_MS);
    this.hookReg = new HookRegistry(this.prefs.hooks, (h) => this.prefs.setHooks(h));
    this.flowSchedReg = new FlowScheduleRegistry(
      this.prefs.flowSchedules,
      (e) => this.prefs.setFlowSchedules(e),
      (entry) => {
        // The unified timer fires either an inline prompt-existing target (deliver a
        // prompt into a session — engine.prompt ensureLoads it, waking an unloaded
        // session) or a flow (gate → action). Exactly one is set.
        if (entry.target) {
          const t = entry.target;
          this.log('flow schedule fired (inline target)', { id: entry.id, session: t.sessionId });
          void this.prompt(t.sessionId, t.prompt, 'enqueue')
            .catch((err) => this.log('scheduled prompt delivery failed', { id: entry.id, session: t.sessionId, err: String(err) }));
        } else if (entry.flowId) {
          this.log('flow schedule fired', { id: entry.id, flow: entry.flowId });
          void this.runFlow(entry.flowId, null)
            .then((result) => {
              if (!result.ok) this.log('scheduled flow run failed', { id: entry.id, flow: entry.flowId, err: result.error ?? 'unknown flow failure' });
            })
            .catch((err) => this.log('scheduled flow run failed', { id: entry.id, flow: entry.flowId, err: String(err) }));
        }
      },
      (m, d) => this.log(m, d),
    );
  }

  login = 'unknown';
  vapidPublicKey: string | null = null;
  // Monotonic sequence for attention ids (`SessionMeta.attnId`). Increments on
  // each fresh raise so the per-user `seenId` water-line can resolve exactly which
  // raise has been seen — the cross-device "seen" mechanism with no client truth.
  private attnSeq = 0;
  // Injectable observability hook (the Engine is otherwise console-free). The
  // server wires this to its pino logger; defaults to a no-op so tests/embeds
  // need not set it. Used by the heap watchdog to report evictions + reasons.
  log: (msg: string, data?: Record<string, unknown>) => void = () => {};
  private memoryWatchdog: ReturnType<typeof setTimeout> | null = null;
  private lastEvictAt = 0;

  onEvent(handler: (ev: ServerEvent) => void): () => void {
    this.bus.on('event', handler);
    return () => this.bus.off('event', handler);
  }
  private emit(ev: ServerEvent): void { this.bus.emit('event', ev); }

  async start(): Promise<void> {
    const boot = await bootstrap();
    this.manager = boot.manager;
    this.authInfo = boot.authInfo;
    this.ffs = boot.featureFlagService;
    this.login = boot.login;
    this.models = boot.models;
    await this.refreshList();
    this.agentStatus = 'up';
    this.emit({ type: 'agent/status', status: 'up' });
    // Periodic reconcile: sessions created externally (a terminal copilot CLI,
    // another tool) aren't pushed to us, so poll and fan out session/added for
    // newcomers. Makes the list self-updating without a manual refresh.
    setInterval(() => { void this.refreshList(); }, 8000);
    this.startMemoryWatchdog();
    // Keep-loaded self-heal: load every session that has a per-session schedule now
    // so its in-memory SDK ScheduleRegistry re-arms across a restart without anyone
    // opening it (the has-schedule signal that replaced pin). Non-blocking.
    void this.loadScheduledSessions();
    // Butler/Flow: the hook registry is loaded from prefs at construction, so the
    // trigger layer is armed the moment the engine is up — no session need be
    // loaded. Project hookCount onto any owner sessions already in the list.
    const hookOwners = this.hookReg.owners();
    if (hookOwners.size) this.log('butler hooks armed', { count: this.hookReg.list().length, owners: hookOwners.size });
    for (const id of hookOwners) {
      const st = this.sessions.get(id);
      if (st) st.meta.hookCount = this.hookReg.countFor(id);
    }
    // Arm the server-level flow schedules (time triggers). They fire flows even
    // with no sessions loaded; this is the always-on cockpit-server's job.
    this.flowSchedReg.arm();
    const schedCount = this.flowSchedReg.list().length;
    if (schedCount) this.log('flow schedules armed', { count: schedCount });
    // Butler/Flow boot trigger: announce the engine is up (a fresh boot or a
    // restart) so any session that armed an engine.boot-complete hook is re-driven
    // NOW — the event-precise alternative to polling. Its canonical use is a daemon
    // verifying its OWN deploy restart: the event IS the post-restart signal, so a
    // one-shot boot hook fires the instant the engine is up and so survives the
    // restart window (this is about the restart window, not durability of the single
    // delivery — see fireEvent). Delivery doesn't depend on preload ordering: the
    // awaited refreshList() above already seeded every session's meta into the map,
    // and each delivery's prompt → ensureLoaded loads its owner on demand. The
    // void-ed loadScheduledSessions() preload is incidental, not relied upon here.
    // Source-less (empty source fields); a no-op when no boot hook exists.
    this.fireEvent({ event: 'engine.boot-complete', sessionId: '', cwd: '', title: '' });
  }

  snapshot(): Extract<ServerEvent, { type: 'snapshot' }> {
    return {
      type: 'snapshot',
      agentStatus: this.agentStatus,
      models: this.models,
      vapidPublicKey: this.vapidPublicKey,
      sessions: [...this.sessions.values()].map((s) => s.meta),
    };
  }

  // The app-icon badge count: how many sessions currently need the user (their
  // authoritative attention is raised). Same source of truth the sidebar badge
  // consumes; rides on screen-off pushes so the phone icon stays in sync.
  attentionCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.meta.attention != null) n++;
    return n;
  }

  // The user looked at a session (opened it / focused the tab on it). Advance its
  // per-user `seenId` to the current `attnId` and resolve the raised attention by
  // kind: a 'ready' clears (sight is completion → badge drops), a 'choice' stays
  // raised but becomes "seen" (the UI demotes it; it's cleared only by answering).
  // Emits a RAW session/patch (NOT via patch(), which would re-derive 'ready' from
  // status and undo the clear). Server truth, so every connected device reconciles;
  // idempotent — re-seeing with nothing new is a silent no-op.
  markSeen(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    const cur = {
      attention: st.meta.attention ?? null,
      attnId: st.meta.attnId ?? 0,
      seenId: st.meta.seenId ?? 0,
    };
    if (cur.attnId === 0) return; // nothing was ever raised on this session
    const res = applySeen(cur);
    const out: Partial<SessionMeta> = {};
    if (res.seenId !== cur.seenId) { st.meta.seenId = res.seenId; out.seenId = res.seenId; }
    if (res.attention !== cur.attention) { st.meta.attention = res.attention; out.attention = res.attention; }
    if (Object.keys(out).length === 0) return;
    this.emit({ type: 'session/patch', ...out, sessionId });
  }

  // Bidirectional reconcile against the SDK's authoritative session list. ADD:
  // seed sessions created outside cockpit (a terminal copilot CLI, another tool)
  // that were never pushed to us. PRUNE: drop shadow entries this same poll once
  // discovered but whose backing session-store.db row has since vanished — left in
  // the map they become sidebar "ghosts" that throw `session not found` on open
  // (the mirror of the store-orphan bug purgeSessionRows cleans on the other side).
  async refreshList(): Promise<void> {
    let list: SdkSessionMeta[];
    try { list = await this.manager.listSessions(); }
    catch { return; }
    const trashed = this.prefs.trashedIds();
    for (const m of list) {
      if (this.sessions.has(m.sessionId)) continue;
      if (trashed.has(m.sessionId)) continue;   // trashed sessions stay hidden
      const st = metaFromSdk(m);
      if (this.prefs.isPinned(m.sessionId)) st.meta.pinned = true;
      applyPersistedFlowLaunchMeta(st);
      this.projectButlerMeta(st);
      this.sessions.set(m.sessionId, st);
      if (this.agentStatus === 'up') this.emit({ type: 'session/added', session: st.meta });
    }
    // PRUNE branch: reclaim ghosts. Only a PURE SHADOW is ever evicted — an entry
    // metaFromSdk built (not materialized, no sdk handle, not loading) that has now
    // disappeared from listSessions. Guards, ALL of which must hold to prune:
    //   1. absent from listSessions      → its store row is gone (present set below).
    //      This alone spares every UNLOADED real session: unloadState() also clears
    //      materialized/sdk/loadPromise, but the row keeps it in listSessions.
    //   2. !materialized && !sdk && !loadPromise → not cockpit-created/loading/loaded.
    //      newSession sets materialized:true synchronously before inserting into the
    //      map, so a birth-vs-poll race (row not yet visible to listSessions) can't
    //      misfire; a failed lazy-load resets these to shadow, correctly re-eligible.
    //   3. not trashed                    → the trash lifecycle owns those ids.
    // Emit the same session/removed the delete/purge paths fan out so every client's
    // sidebar drops it.
    const present = new Set(list.map((m) => m.sessionId));
    for (const [id, st] of this.sessions) {
      if (present.has(id)) continue;                              // guard 1
      if (st.materialized || st.sdk || st.loadPromise) continue;  // guard 2
      if (trashed.has(id)) continue;                              // guard 3
      this.sessions.delete(id);
      this.emit({ type: 'session/removed', sessionId: id });
    }
  }

  // --- intents --------------------------------------------------------------

  // A: run one MCP-attaching SDK birth phase under the serialization gate. Chains fn
  // after the previous phase SETTLES (resolve or reject), so MCP subprocesses cold-
  // start one at a time. The gate itself never rejects (errors are swallowed onto it)
  // so one failed birth doesn't poison the chain; fn's own result/rejection is passed
  // straight back to the caller. Normal births gate create/get only. MCP-enabled flow
  // workers extend the phase through prompt persistence because the SDK lazily repeats
  // MCP/tool preflight on that first prompt; releasing earlier recreates the same stdio
  // initialize storm after createSession has serialized successfully.
  private mcpBirth<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mcpBirthGate.then(() => {
      if (this.mcpBirthQuarantine) {
        throw new Error(
          `MCP birth blocked: prior flow worker ${this.mcpBirthQuarantine.sessionId} `
          + 'still has active SDK launch processing after bounded cleanup',
        );
      }
      return fn();
    });
    this.mcpBirthGate = run.then(() => {}, () => {});
    return run;
  }

  private quarantineMcpBirthUntilSettled(sessionId: string, sendPromise: Promise<unknown>): void {
    const fence = { sessionId };
    this.mcpBirthQuarantine = fence;
    void sendPromise.then(
      () => { if (this.mcpBirthQuarantine === fence) this.mcpBirthQuarantine = null; },
      () => { if (this.mcpBirthQuarantine === fence) this.mcpBirthQuarantine = null; },
    );
  }

  private globalMcpServers(): McpServersRecord {
    return this.mcpServersOverride ?? readGlobalMcpServers();
  }

  // Per-session MCP options for getSession/createSession. The session is told
  // about ALL globally-configured servers, but only the enabled subset connects;
  // the rest go in `disabledMcpServers` (lazy — not spawned until enabled). This
  // is what makes per-session enable/disable + lazy-connect work, and avoids
  // spawning every server's subprocess in every session.
  private mcpOptionsFor(sessionId?: string): { mcpServers: McpServersRecord; disabledMcpServers: string[] } {
    const all = normalizeMcpServersForSdk(this.globalMcpServers());
    const names = Object.keys(all);
    const enabled = new Set(sessionId ? this.prefs.enabledMcpFor(sessionId) : this.prefs.mcpDefaultOn);
    const disabledMcpServers = names.filter((n) => !enabled.has(n));
    return { mcpServers: all, disabledMcpServers };
  }

  async newSession(cwd: string, spawnedBy?: string): Promise<string> {
    const mcp = this.mcpOptionsFor();
    const sdkSession = await this.mcpBirth(() => this.manager.createSession({
      workingDirectory: cwd, authInfo: this.authInfo, featureFlagService: this.ffs,
      enableStreaming: true,
      permissionRequestHandler: APPROVE_ALL_PERMISSIONS,
      mcpServers: mcp.mcpServers, disabledMcpServers: mcp.disabledMcpServers,
    }));
    // Born-as-worker: a daemon can spawn a child carrying the same R1 mark a flow
    // worker gets (non-trigger-source + UI folding). Mark it in prefs BEFORE the meta
    // so the session/added meta carries spawnedBy from birth and it survives reload.
    if (spawnedBy) this.prefs.setSpawnedBy(sdkSession.sessionId, spawnedBy);
    const st: SessionState = {
      meta: {
        sessionId: sdkSession.sessionId, title: basename(cwd) || 'session', cwd,
        createdAt: Date.now(), lastActivity: Date.now(), status: 'idle', error: null,
        loaded: true, queue: [], ask: null,
        ...(spawnedBy ? { spawnedBy } : {}),
      },
      fold: newFoldState(), sdk: sdkSession, loadPromise: Promise.resolve(),
      materialized: true, unsub: null, cwd, imageBytes: 0, inflightTasks: new Set(),
    };
    this.sessions.set(sdkSession.sessionId, st);
    this.attach(st);
    this.emit({ type: 'session/added', session: st.meta });
    this.evictIfNeeded(sdkSession.sessionId); // M6: bound resident materialized windows
    return sdkSession.sessionId;
  }

  // Lazy-load a session into the SDK + replay history. A5: per-session mutex.
  private ensureLoaded(st: SessionState): Promise<void> {
    if (st.loadPromise) return st.loadPromise;
    st.loadPromise = this.loadSession(st).catch((e) => {
      st.loadPromise = null; // allow retry (e.g. a transient torn line on an actively-written file)
      const msg = (e as Error).message ?? String(e);
      const friendly = /corrupt/i.test(msg)
        ? '会话文件有损坏行(可能正在被写入),稍后重试' : `加载失败: ${msg}`;
      this.patch(st, { status: 'error', error: friendly });
      throw e;
    });
    return st.loadPromise;
  }

  private async loadSession(st: SessionState): Promise<void> {
    const repair = repairNegativeCompactionTokens(
      copilotPath('session-state', st.meta.sessionId, 'events.jsonl'),
    );
    if (repair.repairedLines.length > 0) {
      this.log('repaired invalid negative compaction metrics', {
        sessionId: st.meta.sessionId,
        lines: repair.repairedLines,
        backupPath: repair.backupPath,
      });
    }
    const mcp = this.mcpOptionsFor(st.meta.sessionId);
    const sdkSession = await this.mcpBirth(() => this.manager.getSession(
      { sessionId: st.meta.sessionId, workingDirectory: st.cwd, authInfo: this.authInfo, featureFlagService: this.ffs, enableStreaming: true, permissionRequestHandler: APPROVE_ALL_PERMISSIONS, mcpServers: mcp.mcpServers, disabledMcpServers: mcp.disabledMcpServers },
      true,
    ));
    if (!sdkSession) throw new Error('session not found');
    st.sdk = sdkSession;
    // Replay full history through the SAME fold path as live events, accumulating
    // resident image weight in the same single pass (no extra scan).
    let imageBytes = 0;
    for (const ev of sdkSession.getEvents()) {
      const e = ev as unknown as SdkEvent;
      foldEvent(st.fold, e);
      imageBytes += imageBytesOf(e);
    }
    st.imageBytes = imageBytes;
    st.meta.loaded = true;
    st.meta.status = 'idle';
    st.meta.error = null;
    if (st.fold.currentModelId) st.meta.currentModelId = st.fold.currentModelId;
    // Authoritative current model from the session (covers sessions with no
    // model_change event in their history), plus reasoning effort + context tier.
    try {
      const cur = await sdkSession.model?.getCurrent();
      if (cur?.modelId) st.meta.currentModelId = cur.modelId;
      if (cur?.reasoningEffort) st.meta.currentReasoningEffort = cur.reasoningEffort;
      if (cur?.contextTier) st.meta.currentContextTier = cur.contextTier;
    } catch { /* keep folded value */ }
    try {
      const mode = await sdkSession.mode?.get();
      if (mode) st.meta.currentMode = mode;
    } catch { /* default interactive */ }
    // Re-apply this session's persisted skill policy on load. A strict allowlist
    // is evaluated against the CURRENT catalog so skills installed after worker
    // birth remain denied; ordinary sessions keep the legacy explicit-off model.
    const skillAllowlist = this.prefs.skillAllowlistFor(st.meta.sessionId);
    if (skillAllowlist !== null) {
      await this.rescanSkills(sdkSession);
      try {
        const rows = (await sdkSession.skills?.list())?.skills ?? [];
        await this.disableSkillsOutsideAllowlist(sdkSession, new Set(skillAllowlist), rows);
      } catch { /* best-effort */ }
    } else {
      for (const name of this.prefs.disabledSkillsFor(st.meta.sessionId)) {
        try { await sdkSession.disableSkill?.(name); } catch { /* best-effort */ }
      }
    }
    st.meta.scheduleCount = this.scheduleCountOf(st);
    // Keep the persistent has-schedule index in sync on load too (a session that
    // loads with existing per-session schedules must be reload-eligible next boot).
    this.prefs.setScheduleCount(st.meta.sessionId, st.meta.scheduleCount);
    this.projectButlerMeta(st);
    // A launch marker outranks the generic successful-load idle reset. Zero-turn
    // flow failures have no SDK error event to replay, so this sidecar is their only
    // durable diagnosis and must survive open/reload.
    applyPersistedFlowLaunchMeta(st);
    st.materialized = true;
    this.attach(st);
    // Broadcast the resolved state so a previously-set load error is cleared on
    // every client (a successful retry must not leave a stale error showing).
    this.patch(st, {
      status: st.meta.launchState === 'launch_failed' ? 'error' : 'idle',
      error: st.meta.launchState === 'launch_failed' ? st.meta.error : null,
      launchState: st.meta.launchState ?? null,
      loaded: true,
      currentModelId: st.meta.currentModelId,
      currentReasoningEffort: st.meta.currentReasoningEffort ?? null,
      currentContextTier: st.meta.currentContextTier ?? null,
      currentMode: st.meta.currentMode ?? null,
      scheduleCount: st.meta.scheduleCount,
    });
    void this.refreshTodo(st);
    // B: self-heal net — a reload under a birth storm (esp. boot loadScheduledSessions
    // replaying several scheduled sessions at once) can leave an enabled MCP `failed`;
    // reconnect any such with bounded backoff (async — never blocks the load).
    const wantedMcp = new Set(this.prefs.enabledMcpFor(st.meta.sessionId));
    if (wantedMcp.size) void this.healFailedMcp(st, wantedMcp);
    this.evictIfNeeded(st.meta.sessionId);
  }

  // Drop a session's in-memory materialized state (sdk handle, live taps, folded
  // history). The session stays in the list as 'unloaded' and transparently
  // reloads from disk on next open. Shared by manual unload + LRU eviction.
  private unloadState(st: SessionState): void {
    try { st.unsub?.(); } catch { /* ignore */ }
    st.unsub = null;
    st.sdk = null;
    st.loadPromise = null;
    st.materialized = false;
    st.fold = newFoldState();
    st.imageBytes = 0;
    st.inflightTasks.clear();
    st.meta.loaded = false;
    st.meta.status = 'unloaded';
    st.meta.ask = null;
    st.meta.planRequest = null;
    st.meta.elicitation = null;
    st.meta.attention = null;
    st.meta.activeSubagents = 0;
    st.meta.compacting = false;
    st.meta.queue = [];
  }

  // The single "is this session busy?" gate consumed by every eviction / unload /
  // reload site (and, transitively, the graceful-restart gate the transport keys
  // off the projected meta). ORs the live in-flight `task` set on top of the pure
  // predicate so an add that has not yet been projected still counts. See
  // lifecycle.ts for the definition of "busy".
  private isBusy(st: SessionState): boolean {
    return engineSessionBusy(st.meta, st.inflightTasks.size);
  }

  // Whether the SDK still has a genuinely-running `task` agent for this session.
  // Mirrors the SDK's private hasRunningAgents() via the PUBLIC taskRegistry. Used
  // by the ghost-subagent reaper to distinguish a real in-flight sub-agent from a
  // leaked count. Returns `null` when the registry cannot be queried (so the reaper
  // can stay conservative and NOT clear a count it cannot verify).
  private sdkHasRunningAgents(st: SessionState): boolean | null {
    const reg = (st.sdk as unknown as { taskRegistry?: { list?: (o?: unknown) => unknown[] } } | null)?.taskRegistry;
    if (!reg || typeof reg.list !== 'function') return null;
    try {
      const tasks = reg.list({ includeCompleted: false }) as Array<{ type?: string; status?: string }>;
      if (!Array.isArray(tasks)) return null;
      return tasks.some((t) => t?.type === 'agent' && t?.status === 'running');
    } catch { return null; }
  }

  // Leak reaper for ghost `task` sub-agents. A `task` whose tool.execution_complete
  // never arrives (sub-agent process killed, tool hung) leaves its toolCallId in
  // `inflightTasks` forever — pinning activeSubagents ≥ 1 and holding the graceful-
  // restart gate (and now the busy predicate) open indefinitely (observed 1/124 in
  // real logs). The SDK DEFERS session.idle while any background agent runs, so a
  // session that is genuinely-idle with inflightTasks>0 has NO live agent — it is a
  // ghost. We confirm against the public taskRegistry before clearing so we never
  // break the SDK's legitimate defer-idle (if the SDK still reports a running agent,
  // or we cannot verify, we leave the count alone).
  private reapGhostSubagents(st: SessionState): void {
    if (st.meta.status !== 'idle') return;       // only a truly-idle session can be a ghost
    if (st.inflightTasks.size === 0) return;      // nothing to reap
    const running = this.sdkHasRunningAgents(st);
    if (running !== false) return;                // still running, or unverifiable → don't touch
    st.inflightTasks.clear();
    this.log('reaped ghost sub-agent count (task start without completion)', {
      sessionId: st.meta.sessionId,
    });
    this.patch(st, { activeSubagents: 0 });
  }

  // B6: cap resident materialized windows. Evict least-recently-active sessions
  // that are NOT busy (never the one just loaded, never a running/compacting/
  // choice-blocked/sub-agent-working one, never one with an active per-session
  // schedule — keeping it loaded keeps its in-memory SDK ScheduleRegistry firing).
  // An evicted session drops its sdk handle + folded history and reloads on next open.
  private evictIfNeeded(keepId: string): void {
    const loaded = [...this.sessions.values()].filter((s) => s.materialized && s.sdk);
    if (loaded.length <= MAX_MATERIALIZED) return;
    // Reap any ghost sub-agent counts first so a leaked count cannot wrongly keep a
    // genuinely-idle session pinned as "busy" (and thus un-evictable) forever.
    for (const s of loaded) this.reapGhostSubagents(s);
    const victims = loaded
      .filter((s) => s.meta.sessionId !== keepId && !this.isBusy(s) && !hasSchedule(s))
      .sort((a, b) => a.meta.lastActivity - b.meta.lastActivity);
    let over = loaded.length - MAX_MATERIALIZED;
    for (const v of victims) {
      if (over <= 0) break;
      this.evict(v);
      over--;
    }
  }

  // Unload one session and notify clients (the projection shows it 'unloaded';
  // it re-materializes on next open). Shared by the count cap + the heap watchdog.
  private evict(st: SessionState): void {
    this.unloadState(st);
    // Echo activeSubagents:0 so the client field-merge clears any sub-agent badge
    // (the projection is a partial merge — an omitted field keeps its stale value).
    this.emit({ type: 'session/patch', sessionId: st.meta.sessionId, loaded: false, status: 'unloaded', attention: null, activeSubagents: 0 });
  }

  // Heap-pressure watchdog. The real OOM preventer: re-sent base64 images live in
  // the in-process SDK conversations and dominate the V8 heap. When heapUsed
  // crosses the high-water mark, unload the heaviest IDLE sessions (most memory
  // freed per eviction) down toward the low-water mark — before the process hits
  // its ceiling and aborts. Ground truth is the real heapUsed; per-session
  // imageBytes only ranks victims.
  //
  // Sampling is ADAPTIVE (self-rescheduling setTimeout, not a fixed interval): a
  // burst can climb from "high" to OOM in seconds, which a fixed 15s interval can
  // sleep straight through (the 21:03 OOM did exactly this — heap went 1935MB→OOM
  // in <7s between samples). So while heap is above the high-water mark we resample
  // every ~2s; when calm we fall back to 15s.
  private startMemoryWatchdog(): void {
    if (this.memoryWatchdog) return;
    this.scheduleWatchdog(MEMORY_WATCHDOG_MS);
  }

  private scheduleWatchdog(delayMs: number): void {
    this.memoryWatchdog = setTimeout(() => {
      // Reap ghost sub-agent counts every tick (cheap — only sessions that actually
      // carry tracked tasks query the registry) so a leaked count self-heals instead
      // of pinning the restart/busy gate forever (F2). Runs regardless of pressure.
      try {
        for (const s of this.sessions.values()) this.reapGhostSubagents(s);
      } catch { /* never let the watchdog die */ }
      let pressured = false;
      try { pressured = this.checkHeapPressure(); } catch { /* never let the watchdog die */ }
      this.scheduleWatchdog(pressured ? MEMORY_WATCHDOG_FAST_MS : MEMORY_WATCHDOG_MS);
    }, delayMs);
    this.memoryWatchdog.unref?.();
  }

  // Force a synchronous full GC if the runtime was started with --expose-gc. heapUsed
  // only falls after a GC, so under pressure this both reclaims non-session garbage
  // (event-parse temporaries, dropped folds) AND makes the next sample read true.
  private forceGc(): void {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === 'function') { try { gc(); } catch { /* best effort */ } }
  }

  // Returns true if the heap is currently under pressure (caller resamples fast).
  private checkHeapPressure(): boolean {
    const { used, limit } = readHeap();
    if (used <= HEAP_HIGH_FRAC * limit) return false;
    // heapUsed only falls after a GC, so re-evicting on the very next tick would
    // over-unload sessions that are already garbage but not yet reclaimed. During
    // the grace we still force a GC — it may reclaim enough on its own to avert OOM.
    if (Date.now() - this.lastEvictAt < GC_GRACE_MS) { this.forceGc(); return true; }
    const target = used - HEAP_LOW_FRAC * limit;
    const idle = [...this.sessions.values()].filter((s) => s.materialized && s.sdk && !this.isBusy(s));
    // Normal path: never evict a session with an active per-session schedule (its
    // in-memory ScheduleRegistry would stop firing). pin no longer matters here.
    const evictable = idle.filter((s) => !hasSchedule(s))
      .map((s) => ({ sessionId: s.meta.sessionId, lastActivity: s.meta.lastActivity, imageBytes: s.imageBytes }));
    let victimIds = pickEvictionVictims(evictable, target, MAX_EVICT_PER_TICK);
    let lastResort = false;
    // Last resort: only when NO schedule-free candidate remains AND we're above the
    // hard ceiling, evict scheduled sessions too — a stalled schedule is recoverable
    // (it reloads + re-arms); an OOM abort is not. Loudly logged so it's never silent.
    if (victimIds.length === 0 && used > HEAP_HARD_FRAC * limit) {
      const scheduled = idle.filter((s) => hasSchedule(s))
        .map((s) => ({ sessionId: s.meta.sessionId, lastActivity: s.meta.lastActivity, imageBytes: s.imageBytes }));
      victimIds = pickEvictionVictims(scheduled, target, MAX_EVICT_PER_TICK);
      lastResort = victimIds.length > 0;
    }
    if (victimIds.length === 0) {
      // Nothing evictable (all sessions running) — this is exactly the branch that
      // climbed 1798→1935MB→OOM on 2026-06-18 without ever GC'ing. Force a GC: it
      // can reclaim non-session garbage and buy time until a session goes idle.
      this.forceGc();
      this.log('heap high but no evictable idle session', {
        heapUsedMb: Math.round(used / 1048576), heapLimitMb: Math.round(limit / 1048576),
      });
      return true;
    }
    for (const id of victimIds) {
      const st = this.sessions.get(id);
      if (st) this.evict(st);
    }
    this.lastEvictAt = Date.now();
    this.log(lastResort
      ? 'heap CRITICAL — evicted SCHEDULED idle session(s) as last resort (no schedule-free candidate)'
      : 'heap pressure — evicted idle session(s)', {
      heapUsedMb: Math.round(used / 1048576), heapLimitMb: Math.round(limit / 1048576),
      evicted: victimIds, lastResort,
    });
    this.forceGc();
    return true;
  }

  // Manual unload: free the session's memory now (reloads on next open). Refused
  // while the session is BUSY — running, compacting (status stays 'idle' during a
  // manual /compact, so the old status-only guard missed it and could exit(0) mid-
  // compaction), blocked on a choice, or running a background sub-agent.
  unload(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    // Clear any leaked sub-agent count first so a ghost can't falsely refuse unload.
    this.reapGhostSubagents(st);
    if (this.isBusy(st)) throw new Error('忙碌中,无法卸载');
    this.unloadState(st);
    this.emit({ type: 'session/patch', sessionId, loaded: false, status: 'unloaded', error: null, attention: null, activeSubagents: 0 });
  }

  // Reload: drop the in-memory state and re-read from disk, replaying history
  // fresh. Useful to recover from a transient load error or pick up external
  // changes. Pushes a session/reset so materialized clients swap their window.
  // Refused while BUSY (same definition as unload — notably compaction).
  async reload(sessionId: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    this.reapGhostSubagents(st);
    if (this.isBusy(st)) throw new Error('忙碌中,无法重载');
    this.unloadState(st);
    await this.ensureLoaded(st);
    this.emit({
      type: 'session/reset',
      page: { sessionId, messages: this.windowOf(st), hasMore: st.fold.messages.length > HISTORY_PAGE, latest: true },
    });
  }

  // Pin (keep-loaded) or unpin a session. Pinning exempts it from LRU + heap-watchdog
  // eviction so its in-memory ScheduleRegistry never silently stalls, and loads it
  // now so timers arm immediately. Persisted to prefs (survives restart; P1 reloads
  // pinned sessions on startup). Returns the applied flag.
  // Pin is now a pure UI mark (top-of-list, cross-device). It no longer keeps a
  // session loaded — keep-loaded is driven by having a per-session schedule. So
  // this just persists the flag and projects it; it does NOT load the session.
  async pin(sessionId: string, pinned: boolean): Promise<boolean> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    this.prefs.setPinned(sessionId, pinned);
    this.patch(st, { pinned });
    return pinned;
  }

  // Reclassify an existing session as a worker (R1 mark + sidebar folding) by setting
  // its spawnedBy through the engine, so prefs is updated atomically AND the live meta
  // is patched (the UI folds it immediately). This is the durable backfill path: a
  // daemon that created sub-workers via the plain session/new path (no spawnedBy) can
  // tag them after the fact. Hand-editing cockpit-prefs.json while the engine runs is
  // NOT a substitute — the in-memory snapshot clobbers the edit on the next save.
  async setSpawnedBy(sessionId: string, spawnedBy: string): Promise<string> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    this.prefs.setSpawnedBy(sessionId, spawnedBy);
    this.patch(st, { spawnedBy });
    return spawnedBy;
  }

  // Load every session that has a per-session schedule (keep-loaded self-heal).
  // Called once after the initial list refresh so a scheduled session re-arms its
  // in-memory SDK ScheduleRegistry across a restart without anyone opening it. The
  // list of which sessions have schedules comes from the persistent prefs index
  // (the SDK registry is only readable AFTER load — the chicken-and-egg). Best-
  // effort + sequential to avoid a thundering herd.
  private async loadScheduledSessions(): Promise<void> {
    for (const id of this.prefs.scheduledSessionIds()) {
      const st = this.sessions.get(id);
      if (!st || st.materialized) continue;
      try { await this.ensureLoaded(st); this.log(`scheduled session loaded on startup`, { sessionId: id }); }
      catch (e) { this.log(`scheduled session failed to load on startup`, { sessionId: id, err: String(e) }); }
    }
  }

  private windowOf(st: SessionState): typeof st.fold.messages {
    const all = st.fold.messages;
    return all.slice(Math.max(0, all.length - HISTORY_PAGE));
  }

  // Wire the live event taps once the SDK session exists. The SDK gates certain
  // tools/capabilities on whether a listener exists for that SPECIFIC event type
  // — a wildcard '*' listener does NOT count. So we register an explicit
  // listener for `user_input.requested` (enables the ask_user tool), plus a '*'
  // tap for folding everything else. Tool permissions are handled by the
  // `permissionRequestHandler` set at session creation (YOLO auto-approve) — an
  // event-based approver is a no-op here because `permission.requested` never
  // fires without that handler.
  private attach(st: SessionState): void {
    if (!st.sdk || st.unsub) return;
    const offStar = st.sdk.on('*', (ev: SdkEvent) => this.onLive(st, ev));
    const offAsk = st.sdk.on('user_input.requested', (ev: SdkEvent) => this.onAsk(st, ev));
    // Dedicated listeners also enable the capability (the SDK gates on a listener
    // for the specific event type). Unifies into the pending-card above the composer.
    const offPlan = st.sdk.on('exit_plan_mode.requested', (ev: SdkEvent) => this.onPlanRequest(st, ev));
    const offElicit = st.sdk.on('elicitation.requested', (ev: SdkEvent) => this.onElicitation(st, ev));
    st.unsub = () => { offStar(); offAsk(); offPlan(); offElicit(); };
  }

  private onAsk(st: SessionState, ev: SdkEvent): void {
    const ask: AskRequest = {
      requestId: String(ev.data?.requestId ?? ''),
      question: String(ev.data?.question ?? ''),
      choices: Array.isArray(ev.data?.choices) ? (ev.data.choices as string[]) : undefined,
      allowFreeform: ev.data?.allowFreeform as boolean | undefined,
    };
    this.patch(st, { ask });
  }

  private onPlanRequest(st: SessionState, ev: SdkEvent): void {
    const rawActions = Array.isArray(ev.data?.actions) ? ev.data.actions : [];
    const actions = rawActions.filter(
      (a): a is ExitPlanModeAction =>
        a === 'exit_only' || a === 'interactive' || a === 'autopilot' || a === 'autopilot_fleet',
    );
    const rec = ev.data?.recommendedAction;
    const recommendedAction =
      rec === 'exit_only' || rec === 'interactive' || rec === 'autopilot' || rec === 'autopilot_fleet'
        ? rec : undefined;
    this.patch(st, { planRequest: {
      requestId: String(ev.data?.requestId ?? ''),
      summary: String(ev.data?.summary ?? '计划已就绪'),
      planContent: typeof ev.data?.planContent === 'string' ? ev.data.planContent : undefined,
      ...(actions.length ? { actions } : {}),
      ...(recommendedAction ? { recommendedAction } : {}),
    } });
  }

  private onElicitation(st: SessionState, ev: SdkEvent): void {
    this.patch(st, { elicitation: {
      requestId: String(ev.data?.requestId ?? ''),
      message: String(ev.data?.message ?? '需要你的输入'),
    } });
  }

  private onLive(st: SessionState, ev: SdkEvent): void {
    // Account resident image weight for every live event (cheap shape-walk),
    // before the type-specific early returns below — image payloads ride on tool
    // results and user messages, not only on events that reach the fold.
    st.imageBytes += imageBytesOf(ev);
    // Track in-flight `task` sub-agents (foreground + background). The task tool's
    // execution_start carries toolName==='task'; its execution_complete carries only
    // the toolCallId (no name), so we key the set on toolCallId and remove by id. An
    // `abort` may leave a task without a completion (the SDK warns a cancelled stream
    // may not emit one), so abort clears the whole set. This must run BEFORE the
    // early-returns below so no tracked event is skipped.
    this.trackSubagents(st, ev);
    // The agent's `report_intent` tool announces, in one short line, what it's
    // about to do. Surface its `intent` arg as the session's live status line
    // (Thread shows it instead of the generic "回复中…"). Ephemeral: cleared when
    // the turn ends (session.idle / cancel below). Falls through to the fold so
    // the tool still records as a normal row in the transcript.
    if (ev.type === 'tool.execution_start' && ev.data?.toolName === 'report_intent') {
      const args = ev.data?.arguments;
      const raw = args && typeof args === 'object' ? (args as { intent?: unknown }).intent : undefined;
      const intent = typeof raw === 'string' ? raw.trim() : '';
      if (intent && st.meta.intent !== intent) this.patch(st, { intent });
    }
    // permission.requested + user_input.requested are handled by their dedicated
    // listeners (which also enable the capability); skip them here.
    if (ev.type === 'permission.requested' || ev.type === 'user_input.requested') return;
    if (ev.type === 'exit_plan_mode.requested' || ev.type === 'elicitation.requested') return;
    if (ev.type === 'exit_plan_mode.completed') { this.patch(st, { planRequest: null }); return; }
    if (ev.type === 'elicitation.completed') { this.patch(st, { elicitation: null }); return; }
    if (ev.type === 'pending_messages.modified') { this.syncQueue(st); return; }
    if (ev.type === 'assistant.turn_start') {
      if (st.meta.status !== 'running') this.patch(st, { status: 'running', error: null });
      // A fresh turn begins → this is not a cancelled turn (clear the abort flag so
      // a normal completion after a prior cancel is correctly seen as a real turn).
      st.turnCancelled = false;
      // Fall through to the fold so its turn-boundary reset (endTurn) runs on LIVE
      // too — NOT returning here. Otherwise a turn cancelled mid-stream leaks its
      // streaming state and the next turn merges into the cancelled bubble (live
      // would then diverge from replay, where turn_start IS folded). H1.
    }
    if (ev.type === 'session.idle') {
      // SDK 1.0.63 can emit a startup/preflight idle while a prompt is still in
      // either its immediate steering queue or its ordinary FIFO queue. That idle
      // is not a completed turn. Keep the engine running and wait for the queued
      // prompt to drain; assistant.turn_start / the exact user.message will advance
      // authoritative state. This also prevents a stale idle fold from firing hooks.
      this.syncQueue(st);
      let sdkProcessing = false;
      try { sdkProcessing = st.sdk?.isProcessingMessages?.() === true; } catch { /* queue check still applies */ }
      if (st.meta.launchState === 'launching' || (st.meta.queue?.length ?? 0) > 0 || sdkProcessing) {
        this.log('ignored transient SDK idle before pending work became durable', {
          sessionId: st.meta.sessionId,
          launchState: st.meta.launchState ?? null,
          pending: st.meta.queue?.length ?? 0,
          sdkProcessing,
        });
        return;
      }
      // A turn that FAILED already set status:'error' (via the session.error branch
      // below, emitted by the SDK just before session.idle). Don't mask it back to
      // 'idle' — the failed turn must read 'error' until the next turn starts (which
      // clears it at assistant.turn_start). Still clear the live intent line either way.
      const errored = st.meta.status === 'error';
      this.patch(st, errored ? { intent: null } : { status: 'idle', intent: null });
      // A session that became idle with a still-tracked sub-agent is a ghost (the
      // SDK defers session.idle while agents run), so reconcile the leaked count now.
      this.reapGhostSubagents(st);
      // Butler/Flow trigger: a real session finishing its first turn with content
      // is the v1 event. Guarded by firstTurnEligible (R1 + once + non-cancel).
      this.maybeFirstTurnComplete(st);
      // A one-off plan override just finished — return the session to plan mode it
      // was deliberately in (set by planSupersede). Fire-and-forget; idempotent.
      if (st.restorePlanOnIdle) {
        st.restorePlanOnIdle = false;
        void this.setMode(st.meta.sessionId, 'plan').catch(() => {});
      }
      return;
    }
    if (ev.type === 'session.error') {
      // The SDK swallows an agentic-loop failure into a session.error EVENT (it does
      // not reject send()), then emits session.idle. Without this branch a failed
      // turn projects as a normal idle completion ('ready'), never surfacing as an
      // error at the meta level. Set status:'error' + the message; the session.idle
      // that follows preserves it (above). Fall through to the fold so the error also
      // renders as the usual system-error bubble in the transcript.
      const data = ev.data as { message?: unknown } | undefined;
      const msg = typeof data?.message === 'string' && data.message ? data.message : '回合失败';
      if (st.meta.launchState === 'launch_failed') {
        // A late SDK error from an aborted first send is cleanup evidence, not a
        // replacement for the stage-specific durable launch diagnosis.
        this.log('ignored late SDK error after flow launch failure', {
          sessionId: st.meta.sessionId,
          error: msg,
        });
      } else {
        this.patch(st, { status: 'error', error: msg });
        // Butler/Flow triage trigger: a real session's turn ended in error (R1 +
        // rate-limit inside). This is the v1 health event the triage flow subscribes to.
        this.maybeSessionError(st, msg);
      }
      // no early return — let foldEvent render the error bubble too.
    }
    if (ev.type === 'session.todos_changed') { void this.refreshTodo(st); return; }
    if (ev.type === 'session.title_changed') {
      const raw = typeof ev.data?.title === 'string' ? ev.data.title : undefined;
      const title = cleanSessionTitle(raw).slice(0, 60);
      if (title) this.patch(st, { title });
      return;
    }
    if (ev.type === 'session.mode_changed') {
      const m = ev.data?.newMode;
      if (m === 'interactive' || m === 'plan' || m === 'autopilot') this.patch(st, { currentMode: m });
      return;
    }
    if (ev.type === 'session.schedule_created' || ev.type === 'session.schedule_cancelled') {
      this.refreshScheduleCount(st);
      return;
    }
    if (ev.type === 'session.compaction_start') { this.patch(st, { compacting: true }); return; }
    if (ev.type === 'session.compaction_complete') {
      // Clear the compacting flag, but do NOT touch `status`: if this ran inside a
      // turn (auto compaction) that turn is still running and will settle status on
      // session.idle; if it was a manual /compact, status was never 'running'.
      this.patch(st, { compacting: false });
      // No projection refresh: the SDK event log is APPEND-ONLY — getEvents() retains
      // every pre-compaction event (compaction only rewrites the model-facing message
      // array, never the log), so our incremental fold already equals a fresh fold.
      // Do NOT reload: reload()'s getSession "ALWAYS loads from disk", spawning a 2nd
      // live session for this id (the "twin") that finishes the in-flight turn
      // invisibly against the shared workspace. This mirrors the Copilot CLI, which
      // never reloads on compaction — it keeps consuming the same append-only stream.
      return;
    }

    const res = foldEvent(st.fold, ev);
    let activity = false;
    for (const id of res.changed) {
      const idx = st.fold.byId.get(id);
      if (idx === undefined) continue;
      const message = st.fold.messages[idx];
      if (message) { activity = true; this.emit({ type: 'msg/upsert', sessionId: st.meta.sessionId, message }); }
    }
    if (activity) {
      const now = Date.now();
      st.meta.lastActivity = now;
      // Forward lastActivity to clients (throttled) so the sidebar ordering is
      // server-authoritative and the web can drop its client-side Date.now()
      // synthesis. A bare session/patch (not via patch()) because lastActivity never
      // affects attention; throttled so a streaming turn doesn't emit one per token.
      if (now - (st.lastActivityEmit ?? 0) >= LASTACTIVITY_EMIT_MS) {
        st.lastActivityEmit = now;
        this.emit({ type: 'session/patch', sessionId: st.meta.sessionId, lastActivity: now });
      }
    }
    if (res.metaChanged && st.fold.currentModelId) this.patch(st, { currentModelId: st.fold.currentModelId });
  }

  // Pull agent TODO progress (counts + current-intent title) from the session
  // DB via the SDK's public accessors. SDK gives aggregates only, no per-item
  // list. Patches `todo` = {done,total,intent} or null when there are no todos.
  private async refreshTodo(st: SessionState): Promise<void> {
    const db = st.sdk?.sessionFs?.sessionDatabase;
    if (!db) return;
    try {
      const status = await db.getTodoStatus();
      if (!status || status.total === 0) {
        if (st.meta.todo) this.patch(st, { todo: null });
        return;
      }
      const intent = await db.getCurrentIntent().catch(() => null);
      const next = { done: status.done, total: status.total, intent: intent ?? null };
      const cur = st.meta.todo;
      if (!cur || cur.done !== next.done || cur.total !== next.total || cur.intent !== next.intent) {
        this.patch(st, { todo: next });
      }
    } catch { /* todos optional */ }
  }

  // Maintain st.inflightTasks from the `task` tool's lifecycle events and project
  // the count onto SessionMeta.activeSubagents so the graceful-restart gate (and the
  // UI) can see in-flight sub-agents — including BACKGROUND ones that outlive the
  // turn that spawned them. The task tool's execution_complete carries no toolName
  // (only toolCallId), so we add on execution_start{toolName:'task'} and remove by
  // id on ANY execution_complete; an abort clears the set wholesale because a
  // cancelled task may never emit a completion.
  private trackSubagents(st: SessionState, ev: SdkEvent): void {
    const before = st.inflightTasks.size;
    if (ev.type === 'tool.execution_start' && ev.data?.toolName === 'task') {
      const id = typeof ev.data?.toolCallId === 'string' ? ev.data.toolCallId : '';
      if (id) st.inflightTasks.add(id);
    } else if (ev.type === 'tool.execution_complete') {
      const id = typeof ev.data?.toolCallId === 'string' ? ev.data.toolCallId : '';
      if (id) st.inflightTasks.delete(id);
    } else if (ev.type === 'abort') {
      st.inflightTasks.clear();
    } else {
      return;
    }
    if (st.inflightTasks.size !== before) {
      this.patch(st, { activeSubagents: st.inflightTasks.size });
    }
  }

  // ── SDK queue access (feature-detected) ─────────────────────────────────────
  // The SDK's queue surface evolved: the public, non-deprecated readers/mutators
  // (getPendingQueuedItems / enqueueItem / clearPendingItems) are NOT in our
  // sdk-types shim, so we reach them via `as any` and feature-detect at runtime,
  // falling back to the older (deprecated/private) methods the shim does declare.
  // This isolates ALL direct SDK-queue coupling to three helpers.

  // Read both SDK queues as {kind, text}. SDK 1.0.63 keeps immediate steering
  // messages outside getPendingQueuedItems(); omitting that sibling made startup
  // idle bounces look like a drained queue. The `text` is the SDK display text,
  // used uniformly for projected ids, removal revalidation, and first-prompt
  // correlation.
  private readQueueItems(st: SessionState): Array<{ kind: string; text: string }> {
    const sdk = st.sdk as unknown as {
      getPendingSteeringMessagesDisplayPrompt?(): ReadonlyArray<string>;
      getPendingQueuedItems?(): ReadonlyArray<{ kind?: string; displayText?: string }>;
      getPendingQueuedMessages?(): unknown[];
    } | null;
    let steering: Array<{ kind: string; text: string }> = [];
    try {
      steering = [...(sdk?.getPendingSteeringMessagesDisplayPrompt?.() ?? [])]
        .map((text) => ({ kind: 'message', text: String(text) }));
    } catch { /* best-effort; the ordinary queue is still authoritative */ }
    try {
      if (typeof sdk?.getPendingQueuedItems === 'function') {
        const raw = sdk.getPendingQueuedItems() ?? [];
        return [
          ...steering,
          ...[...raw].map((r) => ({ kind: String(r?.kind ?? 'message'), text: String(r?.displayText ?? '') })),
        ];
      }
    } catch { /* fall through to the legacy reader */ }
    try {
      const raw = sdk?.getPendingQueuedMessages?.() ?? [];
      return [...steering, ...[...raw].map((r) => ({ kind: 'message', text: String(r) }))];
    } catch { /* best-effort */ }
    return steering;
  }

  // Clear the entire pending queue. Prefers the public clearPendingItems; falls back
  // to the deprecated alias. Returns false if neither primitive exists (→ caller must
  // fail closed rather than partially mutate).
  private clearQueue(st: SessionState): boolean {
    const sdk = st.sdk as unknown as { clearPendingItems?(): void; clearPendingMessages?(): void } | null;
    if (typeof sdk?.clearPendingItems === 'function') { sdk.clearPendingItems(); return true; }
    if (typeof sdk?.clearPendingMessages === 'function') { sdk.clearPendingMessages(); return true; }
    return false;
  }

  // Re-enqueue a message prompt. Prefers the public enqueueItem; falls back to the
  // (private, shim-declared) enqueueUserMessage. Returns false if neither exists.
  private enqueueMessage(st: SessionState, text: string): boolean {
    const sdk = st.sdk as unknown as {
      enqueueItem?(item: { kind: 'message'; options: { prompt: string; mode: 'enqueue' } }): void;
      enqueueUserMessage?(opts: { prompt: string }): void;
    } | null;
    if (typeof sdk?.enqueueItem === 'function') { sdk.enqueueItem({ kind: 'message', options: { prompt: text, mode: 'enqueue' } }); return true; }
    if (typeof sdk?.enqueueUserMessage === 'function') { sdk.enqueueUserMessage({ prompt: text }); return true; }
    return false;
  }

  private syncQueue(st: SessionState): void {
    const items: QueuedItem[] = this.readQueueItems(st).map((it, i) => ({
      // Stable, content-tagged id (lifecycle.makeQueueId). The bare positional id
      // raced: the SDK re-indexes the array on every drain/removal, so a stale q-<i>
      // could target the wrong survivor. Embedding a content tag lets removeQueued
      // re-validate (and relocate) the target before mutating — see removeQueued.
      id: makeQueueId(i, it.text),
      text: it.text,
    }));
    this.patch(st, { queue: items });
  }

  async prompt(sessionId: string, text: string, mode?: 'enqueue' | 'immediate'): Promise<{ ok: boolean; queued?: boolean }> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    if (!st.sdk) throw new Error('session not loaded');
    const queued = st.meta.status === 'running';
    // While running, default to enqueue (CLI-style queue); else fresh turn.
    if (st.meta.status !== 'running') this.patch(st, { status: 'running', error: null });
    // Fire the turn but DON'T await it. `sdk.send()` resolves only when the WHOLE
    // turn completes, which routinely exceeds the reverse proxy's request timeout —
    // so awaiting it made the POST /intent/prompt hang until nginx returned 504
    // (even though the prompt was accepted and the turn was streaming fine over SSE).
    // The turn is fully observable via SSE (status running→idle + streamed events),
    // so the POST only needs to confirm acceptance. Turn errors surface through the
    // event stream; this .catch is the backstop for a send() that rejects outright.
    void st.sdk.send({ prompt: text, mode: mode ?? 'enqueue' }).catch((e) => {
      const msg = (e as Error).message;
      this.patch(st, { status: 'error', error: msg });
      // Backstop triage trigger: send() rejected outright (the SDK didn't even emit
      // a session.error event). Same health signal — guarded + rate-limited inside.
      this.maybeSessionError(st, msg);
    });
    return { ok: true, queued };
  }

  cancel(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st?.sdk) return;
    try { st.sdk.abort?.(); } catch { /* ignore */ }
    // Drain the SDK's pending queue too. abort() stops the in-flight turn but does
    // NOT clear items queued BEHIND it, so without this a message the user queued
    // then cancelled would silently start running as the next turn. clearQueue is
    // feature-detected + best-effort; we reflect queue:[] in the patch below.
    let hadQueue = false;
    try { hadQueue = this.readQueueItems(st).length > 0; } catch { /* ignore */ }
    if (hadQueue) { try { this.clearQueue(st); } catch { /* best-effort */ } }
    // Mark the turn as user-aborted: if the SDK emits a session.idle after the
    // abort, the butler-event guard (firstTurnEligible) must treat it as a
    // non-completion. Cleared at the next turn_start.
    st.turnCancelled = true;
    // Abort emits no final assistant.message, so clear the fold's streaming scratch
    // state now — otherwise the next turn would merge into the cancelled bubble (H1).
    resetTurn(st.fold);
    // Aborting cancels any in-flight task sub-agents too, and the SDK may not emit a
    // completion for them — clear the set so they don't pin the restart gate forever.
    const hadTasks = st.inflightTasks.size > 0;
    st.inflightTasks.clear();
    // silent: a user-initiated idle. The user cancelled and is right here, so this
    // running→idle must NOT raise 'ready' / fire a notification (attention.ts).
    this.patch(st, {
      status: 'idle', intent: null,
      ...(hadTasks ? { activeSubagents: 0 } : {}),
      ...(hadQueue ? { queue: [] } : {}),
    }, { silent: true });
  }

  async setModel(sessionId: string, modelId: string, reasoningEffort?: string, contextTier?: 'default' | 'long_context'): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const prev = {
      currentModelId: st.meta.currentModelId,
      currentReasoningEffort: st.meta.currentReasoningEffort ?? null,
      currentContextTier: st.meta.currentContextTier ?? null,
    };
    this.patch(st, {
      currentModelId: modelId,
      // emit null (not omit) so switching to a model WITHOUT a chosen effort/tier
      // CLEARS the previous selection on clients instead of leaving it stale.
      currentReasoningEffort: reasoningEffort ?? null,
      currentContextTier: contextTier ?? null,
    });
    try {
      await st.sdk?.model?.switchTo({
        modelId,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextTier !== undefined ? { contextTier } : {}),
      });
      // Confirm with the authoritative current selection (the SDK may clamp an
      // unsupported effort to the model's default). emit null on absence: a non-
      // reasoning model returns reasoningEffort=undefined, which JSON.stringify drops
      // from a {...spread} patch — leaving the prior model's effort badge stuck on.
      const cur = await st.sdk?.model?.getCurrent();
      if (cur) {
        this.patch(st, {
          currentModelId: cur.modelId ?? modelId,
          currentReasoningEffort: cur.reasoningEffort ?? null,
          currentContextTier: cur.contextTier ?? null,
        });
      }
    } catch (e) {
      this.patch(st, { ...prev, error: `切换模型失败: ${(e as Error).message}` });
    }
  }

  // Rename the session (CLI /rename). Optimistic title patch, then authoritative
  // read-back. Returns the applied title.
  async rename(sessionId: string, name: string): Promise<string> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const trimmed = name.trim();
    if (!trimmed) return st.meta.title;
    const prev = st.meta.title;
    this.patch(st, { title: trimmed });
    try {
      await st.sdk?.name?.set({ name: trimmed });
      const cur = await st.sdk?.name?.get();
      const title = cur?.name ?? trimmed;
      this.patch(st, { title });
      return title;
    } catch (e) {
      this.patch(st, { title: prev, error: `重命名失败: ${(e as Error).message}` });
      return prev;
    }
  }

  // Compact the conversation history (CLI /compact). The SDK emits
  // session.compaction_start/complete; we mark meta.compacting for the duration.
  // Manual compaction is NOT a turn (status stays 'idle' — the SDK never emits
  // session.idle for it), so the compacting flag is what the UI and restart gate
  // key off. We set it eagerly (instant indicator) and clear it in finally as a
  // safety net in case compaction_complete doesn't arrive (e.g. an error path).
  async compact(sessionId: string, customInstructions?: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    this.patch(st, { compacting: true });
    try {
      await st.sdk?.history?.compact(customInstructions ? { customInstructions } : undefined);
    } catch (e) {
      this.patch(st, { error: `压缩失败: ${(e as Error).message}` });
    } finally {
      this.patch(st, { compacting: false });
    }
  }

  // Rewind/undo (CLI /rewind /undo): truncate history to a message's event. User
  // message ids ARE their event ids (fold sets id = ev.id), so `toMsgId` is the
  // truncation target. `rollbackFiles` also reverts the workspace checkpoint.
  async rewind(sessionId: string, toMsgId: string, rollbackFiles?: boolean): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    try {
      await st.sdk?.history?.truncate({ eventId: toMsgId, ...(rollbackFiles ? { truncateWorkspaceCheckpoint: true } : {}) });
      // History changed underneath us — re-read from disk and re-broadcast.
      await this.reload(sessionId);
    } catch (e) {
      this.patch(st, { error: `回退失败: ${(e as Error).message}` });
    }
  }

  // Switch the agent interaction mode (CLI shift+tab). Optimistic patch + SDK set;
  // session.mode_changed confirms.
  async setMode(sessionId: string, mode: 'interactive' | 'plan' | 'autopilot'): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const prev = st.meta.currentMode;
    this.patch(st, { currentMode: mode });
    try {
      await st.sdk?.mode?.set({ mode });
    } catch (e) {
      // emit null (not omit) on rollback so a failed switch from an unset mode
      // correctly CLEARS the optimistic value rather than leaving it stuck.
      this.patch(st, { currentMode: prev ?? null, error: `切换模式失败: ${(e as Error).message}` });
    }
  }

  // On-demand full plan payload for the info panel: plan.md markdown + the
  // complete TODO checklist (session.plan.read / readSqlTodos — runtime-
  // verified). Loads the session if needed.
  async getPlan(sessionId: string): Promise<SessionPlan> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const plan = st.sdk?.plan;
    let planMarkdown: string | null = null;
    let todos: TodoItem[] = [];
    if (plan) {
      try { planMarkdown = (await plan.read())?.content ?? null; } catch { /* optional */ }
      try {
        const { rows } = await plan.readSqlTodos();
        todos = (rows ?? [])
          .filter((r) => r.id && r.title)
          .map((r) => ({
            id: String(r.id),
            title: String(r.title),
            ...(r.description ? { description: String(r.description) } : {}),
            status: normalizeTodoStatus(r.status),
          }));
      } catch { /* optional */ }
    }
    const changedFiles = [...st.fold.changedFiles.entries()].map(([path, operation]) => ({ path, operation }));
    return { planMarkdown, todos, changedFiles };
  }

  // On-demand read-mostly panels (skills / mcp / tasks / instructions / schedule).
  // Each SDK list call is best-effort and normalized to a uniform PanelItem row so
  // the frontend stays simple and robust to shape differences. (memory has no
  // per-session API, so it's omitted.)
  async getPanels(sessionId: string): Promise<SessionPanels> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const sdk = st.sdk;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
    const rowsOf = async <T,>(fn: (() => Promise<T>) | undefined, pick: (r: T) => Array<Record<string, unknown>> | undefined): Promise<Array<Record<string, unknown>>> => {
      if (!fn) return [];
      try { return pick(await fn()) ?? []; } catch { return []; }
    };
    const [skillsRaw, mcpRaw, tasksRaw, instrRaw, schedRaw] = await Promise.all([
      rowsOf(sdk?.skills?.list.bind(sdk?.skills), (r) => r.skills),
      rowsOf(sdk?.mcp?.list.bind(sdk?.mcp), (r) => r.servers),
      rowsOf(sdk?.tasks?.list.bind(sdk?.tasks), (r) => r.tasks),
      rowsOf(sdk?.instructions?.getSources.bind(sdk?.instructions), (r) => r.sources),
      rowsOf(sdk?.schedule?.list.bind(sdk?.schedule), (r) => r.entries),
    ]);
    const skills: PanelItem[] = skillsRaw
      .filter((s) => str(s.name))
      .map((s) => ({ label: str(s.name) as string, sublabel: str(s.source), enabled: bool(s.enabled) }));
    const mcpServers: PanelItem[] = mcpRaw
      .map((s) => ({ label: str(s.name) ?? str(s.serverName) ?? 'server', sublabel: str(s.status), enabled: bool(s.enabled) }));
    const tasks: PanelItem[] = tasksRaw
      .map((t) => ({ label: str(t.title) ?? str(t.id) ?? 'task', sublabel: str(t.status) ?? str(t.type), enabled: undefined }));
    const instructionSources: PanelItem[] = instrRaw
      .map((s) => ({ label: str(s.path) ?? str(s.label) ?? str(s.name) ?? 'instruction', sublabel: str(s.scope) ?? str(s.type) }));
    const schedules: PanelItem[] = schedRaw
      .map((s) => ({ label: str(s.label) ?? str(s.prompt) ?? str(s.id) ?? 'schedule', sublabel: str(s.cron) ?? str(s.interval) }));
    return { skills, mcpServers, tasks, instructionSources, schedules };
  }

  // ── MCP + Skills management ──────────────────────────────────────────────────
  // Global MCP servers (from ~/.copilot/mcp-config.json) with their default-on flag
  // for new sessions. Pure config read — no session needed.
  listGlobalMcp(): Array<{ name: string; detail: string; defaultOn: boolean; config: Record<string, unknown> }> {
    const all = this.globalMcpServers();
    const defaults = new Set(this.prefs.mcpDefaultOn);
    return Object.entries(all).map(([name, cfg]) => ({
      name, detail: describeMcpServer(cfg), defaultOn: defaults.has(name), config: redactMcpConfig(cfg),
    }));
  }

  setMcpDefault(name: string, on: boolean): void {
    this.prefs.setMcpDefault(name, on);
  }

  // A loaded session's sdk to query directory-scanned skills (same globally). Uses
  // any already-materialized session; else lazily loads the most-recent one.
  private async referenceSdk(): Promise<SdkSession | null> {
    for (const st of this.sessions.values()) if (st.materialized && st.sdk) return st.sdk;
    const first = [...this.sessions.values()].sort((a, b) => b.meta.lastActivity - a.meta.lastActivity)[0];
    if (!first) return null;
    await this.ensureLoaded(first);
    return first.sdk ?? null;
  }

  // Ensure this session's skills are loaded so `skills.list()` returns the full set
  // even before the first message. NOTE: this canNOT pick up skills added/removed on
  // disk after the process started — the SDK memoizes the directory scan in a
  // module-level cache keyed only on paths, with no public invalidation API. Picking
  // up on-disk changes requires a process restart (see the `skills/refresh` intent).
  private async rescanSkills(sdk: SdkSession | null | undefined): Promise<void> {
    if (!sdk) return;
    try { await sdk.ensureSkillsLoaded?.(); } catch { /* best-effort */ }
  }

  private async disableSkillsOutsideAllowlist(
    sdk: SdkSession,
    allowlist: Set<string>,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    for (const skill of rows) {
      if (typeof skill.name !== 'string' || allowlist.has(skill.name)) continue;
      try { await sdk.disableSkill?.(skill.name); } catch { /* best-effort */ }
    }
  }

  // Global skills list (directory-scanned: builtin + ~/.copilot/skills + project).
  // The skill set is the same across sessions, so query any loaded session.
  async listGlobalSkills(): Promise<Array<{ name: string; description?: string; source?: string; userInvocable?: boolean }>> {
    const sdk = await this.referenceSdk();
    if (!sdk?.skills) return [];
    await this.rescanSkills(sdk);
    try {
      const rows = (await sdk.skills.list()).skills ?? [];
      return rows
        .filter((s) => typeof s.name === 'string')
        .map((s) => ({
          name: s.name as string,
          description: typeof s.description === 'string' ? s.description : undefined,
          source: typeof s.source === 'string' ? s.source : undefined,
          userInvocable: typeof s.userInvocable === 'boolean' ? s.userInvocable : undefined,
        }));
    } catch { return []; }
  }

  // Read one skill's full detail incl. its SKILL.md body. The skill rows from the
  // SDK carry a `path` (file or dir); we read the markdown from disk best-effort so
  // an unreadable/missing body just omits the field rather than failing.
  async readSkillBody(name: string): Promise<{ name: string; description?: string; source?: string; userInvocable?: boolean; body?: string }> {
    const sdk = await this.referenceSdk();
    let row: Record<string, unknown> | undefined;
    if (sdk?.skills) {
      await this.rescanSkills(sdk);
      try { row = ((await sdk.skills.list()).skills ?? []).find((s) => s.name === name); } catch { /* none */ }
    }
    const out: { name: string; description?: string; source?: string; userInvocable?: boolean; body?: string } = { name };
    if (row) {
      if (typeof row.description === 'string') out.description = row.description;
      if (typeof row.source === 'string') out.source = row.source;
      if (typeof row.userInvocable === 'boolean') out.userInvocable = row.userInvocable;
      const raw = typeof row.path === 'string' ? row.path : undefined;
      if (raw) {
        try {
          const file = raw.toLowerCase().endsWith('.md') ? raw : join(raw, 'SKILL.md');
          if (existsSync(file)) out.body = readFileSync(file, 'utf8');
        } catch { /* unreadable — omit body */ }
      }
    }
    return out;
  }
  async listSessionMcp(sessionId: string): Promise<{ loaded: boolean; servers: McpServerSession[] }> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    const all = this.globalMcpServers();
    const enabled = new Set(this.prefs.enabledMcpFor(sessionId));
    const unloadedServers = (): McpServerSession[] => Object.entries(all).map(([name, cfg]) => {
      const operation = this.mcpToggleOperations.get(this.mcpToggleKey(sessionId, name))?.operation;
      return {
        name,
        detail: describeMcpServer(cfg),
        status: enabled.has(name) ? 'unloaded' : 'disabled',
        enabled: enabled.has(name),
        ...(operation ? { operation: { ...operation } } : {}),
      };
    });
    const sdk = st.materialized ? st.sdk : null;

    // This is a read, not an implicit "open session" command. Loading here used
    // manager.getSession(resume=true), which starts stdio MCPs under the global
    // mcpBirth gate. A concurrent stewardship batch therefore queued N cold loads
    // behind one another while every HTTP caller's independent deadline kept
    // ticking. Return persisted enablement immediately when there is no live SDK
    // handle; callers can explicitly reload/open when they actually need one.
    if (!sdk) return { loaded: false, servers: unloadedServers() };

    // Summaries are a synchronous snapshot of the already-loaded session's live
    // McpHost. Do not call ensureMcpLoaded here: that can start/await stdio
    // handshakes and turn a status read into another load-aware operation.
    let summaries: ReturnType<NonNullable<SdkSession['getMcpServerSummaries']>> = [];
    try { summaries = sdk.getMcpServerSummaries?.() ?? []; } catch { /* none */ }
    const byName = new Map(summaries.map((s) => [s.name, s]));
    return {
      loaded: true,
      servers: Object.entries(all).map(([name, cfg]) => {
        const s = byName.get(name);
        const operation = this.mcpToggleOperations.get(this.mcpToggleKey(sessionId, name))?.operation;
        return {
          name,
          detail: describeMcpServer(cfg),
          status: enabled.has(name) ? (s?.status ?? 'pending') : 'disabled',
          enabled: enabled.has(name),
          error: s?.error,
          ...(operation ? { operation: { ...operation } } : {}),
        };
      }),
    };
  }

  private mcpToggleKey(sessionId: string, name: string): string {
    return `${sessionId}\0${name}`;
  }

  private mcpToggleActive(operation: McpToggleOperation): boolean {
    return operation.state === 'running'
      || operation.state === 'cancelling'
      || operation.state === 'settling';
  }

  private liveMcpStatus(st: SessionState, name: string): { status: McpServerStatus; error?: string } {
    if (!st.materialized || !st.sdk) return { status: 'unloaded' };
    try {
      const summary = st.sdk.getMcpServerSummaries?.().find((server) => server.name === name);
      return summary
        ? { status: summary.status, ...(summary.error ? { error: summary.error } : {}) }
        : { status: 'pending' };
    } catch (error) {
      return { status: 'failed', error: `MCP status read failed: ${(error as Error).message}` };
    }
  }

  private mcpToggleResult(runtime: McpToggleRuntime, error?: string): McpToggleResult {
    const enabled = this.prefs.enabledMcpFor(runtime.sessionId).includes(runtime.name);
    const effectiveError = error ?? runtime.operation.error;
    return {
      ok: runtime.ok,
      applied: runtime.applied,
      sessionId: runtime.sessionId,
      name: runtime.name,
      enabled,
      status: runtime.operation.status,
      ...(effectiveError ? { error: effectiveError } : {}),
      operation: { ...runtime.operation },
    };
  }

  private updateMcpOperationCount(st: SessionState): void {
    let count = this.mcpReloadingSessions.has(st.meta.sessionId) ? 1 : 0;
    for (const runtime of this.mcpToggleOperations.values()) {
      if (runtime.sessionId === st.meta.sessionId && this.mcpToggleActive(runtime.operation)) count++;
    }
    if ((st.meta.activeMcpOperations ?? 0) === count) return;
    st.meta.activeMcpOperations = count;
    if (this.sessions.get(st.meta.sessionId) !== st) return;
    this.patch(st, { activeMcpOperations: count });
  }

  private hasActiveMcpToggle(sessionId: string): boolean {
    for (const runtime of this.mcpToggleOperations.values()) {
      if (runtime.sessionId === sessionId && this.mcpToggleActive(runtime.operation)) return true;
    }
    return false;
  }

  private forgetMcpOperations(sessionId: string): void {
    for (const [key, runtime] of this.mcpToggleOperations) {
      if (runtime.sessionId === sessionId) this.mcpToggleOperations.delete(key);
    }
    const retry = this.mcpReloadRetryTimers.get(sessionId);
    if (retry) clearTimeout(retry);
    this.mcpReloadRetryTimers.delete(sessionId);
    this.mcpReloadRetryAttempts.delete(sessionId);
  }

  private finishMcpToggle(
    st: SessionState,
    runtime: McpToggleRuntime,
    state: 'succeeded' | 'failed',
    status: McpServerStatus,
    applied: boolean,
    error?: string,
  ): McpToggleResult {
    const { error: _previousError, completedAt: _previousCompletedAt, ...operation } = runtime.operation;
    runtime.ok = state === 'succeeded';
    runtime.applied = applied;
    runtime.operation = {
      ...operation,
      state,
      status,
      completedAt: Date.now(),
      ...(error ? { error } : {}),
    };
    this.updateMcpOperationCount(st);
    this.resumePendingMcpReload(st);
    return this.mcpToggleResult(runtime);
  }

  private markMcpToggleSettling(
    st: SessionState,
    runtime: McpToggleRuntime,
    status: McpServerStatus,
    error: string,
  ): McpToggleResult {
    runtime.operation = { ...runtime.operation, state: 'settling', status, error };
    this.updateMcpOperationCount(st);
    return this.mcpToggleResult(runtime);
  }

  private async promiseSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitForMcpWork(
    st: SessionState,
    name: string,
    desiredEnabled: boolean,
    workState: { started: boolean; settled: boolean; error?: Error },
  ): Promise<{ timedOut: boolean; observed?: { status: McpServerStatus; error?: string } }> {
    const deadline = Date.now() + this.mcpToggleTimeoutMs;
    while (!workState.settled) {
      const observed = this.liveMcpStatus(st, name);
      if (workState.started && desiredEnabled && (
        observed.status === 'connected'
        || observed.status === 'failed'
        || observed.status === 'needs-auth'
      )) {
        return { timedOut: false, observed };
      }
      if (workState.started && !desiredEnabled && observed.status === 'disabled') {
        return { timedOut: false, observed };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { timedOut: true, observed };
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.mcpTogglePollMs, remaining)));
    }
    return { timedOut: false };
  }

  private cancelMcpEnable(
    st: SessionState,
    name: string,
    trackedWork: Promise<void>,
  ): Promise<void> {
    const stopAndDisable = async (): Promise<void> => {
      const sdk = st.sdk;
      const host = sdk?.getMcpHost?.();
      await Promise.allSettled([
        Promise.resolve().then(() => host?.stopServer?.(name)),
        Promise.resolve().then(() => sdk?.disableMcpServer?.(name)),
      ]);
    };
    return (async () => {
      await stopAndDisable();
      await trackedWork;
      // A cold load can publish the SDK handle only after cancellation began, and
      // a late start can register its transport after the first stop. Fence both
      // races by disabling/stopping after the original work settles. The SDK stop
      // methods may swallow or reject close failures, so do not declare cleanup
      // complete until the live status itself confirms disabled (or the whole
      // session stayed unloaded). An uncooperative SDK remains visibly `settling`.
      for (;;) {
        await stopAndDisable();
        const status = this.liveMcpStatus(st, name).status;
        if (status === 'disabled' || status === 'unloaded') return;
        await new Promise((resolve) => setTimeout(resolve, Math.max(25, this.mcpTogglePollMs)));
      }
    })();
  }

  private async settleFailedMcpEnable(
    st: SessionState,
    runtime: McpToggleRuntime,
    trackedWork: Promise<void>,
    status: McpServerStatus,
    error: string,
  ): Promise<McpToggleResult> {
    runtime.operation = { ...runtime.operation, state: 'cancelling', status, error };
    const cleanup = this.cancelMcpEnable(st, runtime.name, trackedWork);
    if (await this.promiseSettledWithin(cleanup, this.mcpToggleCleanupTimeoutMs)) {
      return this.finishMcpToggle(st, runtime, 'failed', status, false, error);
    }

    const pending = this.markMcpToggleSettling(
      st,
      runtime,
      status,
      `${error} Cancellation is still settling; operation ${runtime.operation.id} remains authoritative and retries are deduplicated.`,
    );
    void cleanup.then(
      () => { this.finishMcpToggle(st, runtime, 'failed', status, false, error); },
      (cleanupError) => {
        this.finishMcpToggle(
          st,
          runtime,
          'failed',
          'failed',
          false,
          `${error} Cleanup failed: ${(cleanupError as Error).message}`,
        );
      },
    );
    return pending;
  }

  private async executeMcpToggle(
    st: SessionState,
    runtime: McpToggleRuntime,
  ): Promise<McpToggleResult> {
    const { sessionId, name, desiredEnabled: on } = runtime;
    const enabledBefore = this.prefs.enabledMcpFor(sessionId).includes(name);
    const current = this.liveMcpStatus(st, name);

    // Idempotent calls never reconnect a failed/pending target. The current
    // durable and live state is the authoritative result, so a caller can read it
    // and decide whether a later explicit retry is warranted.
    if (enabledBefore === on) {
      if (!on) return this.finishMcpToggle(st, runtime, 'succeeded', 'disabled', true);
      if (current.status === 'connected') {
        return this.finishMcpToggle(st, runtime, 'succeeded', 'connected', true);
      }
      const error = current.error
        ?? `MCP "${name}" is already enabled but its live status is ${current.status}; no duplicate enable was started.`;
      return this.finishMcpToggle(st, runtime, 'failed', current.status, true, error);
    }

    // Disabling an unloaded session (or a loaded session whose host was never
    // initialized) has no live process to stop. Persisting off is the complete
    // operation and deliberately avoids materializing the session.
    if (!on && (!st.materialized || !st.sdk || current.status === 'pending'
      && (st.sdk.getMcpServerSummaries?.().length ?? 0) === 0)) {
      this.prefs.setSessionMcp(sessionId, name, false);
      return this.finishMcpToggle(st, runtime, 'succeeded', 'disabled', true);
    }

    const workState: { started: boolean; settled: boolean; error?: Error } = {
      started: false,
      settled: false,
    };
    const work = (async () => {
      if (!st.materialized || !st.sdk) await this.ensureLoaded(st);
      const sdk = st.sdk;
      if (!sdk) throw new Error('SDK session did not materialize');
      if (on) {
        if (!sdk.ensureMcpLoaded || !sdk.enableMcpServer) {
          throw new Error('SDK does not expose MCP enable lifecycle APIs');
        }
        await sdk.ensureMcpLoaded();
        workState.started = true;
        await sdk.enableMcpServer(name);
      } else {
        if (!sdk.disableMcpServer) throw new Error('SDK does not expose MCP disable lifecycle API');
        workState.started = true;
        await sdk.disableMcpServer(name);
      }
    })();
    const trackedWork = work.then(
      () => { workState.settled = true; },
      (error) => {
        workState.settled = true;
        workState.error = error instanceof Error ? error : new Error(String(error));
      },
    );

    const wait = await this.waitForMcpWork(st, name, on, workState);
    if (wait.timedOut) {
      const error = `MCP ${on ? 'enable' : 'disable'} for "${name}" exceeded the `
        + `${this.mcpToggleTimeoutMs}ms server-side bound; `
        + `${on ? 'the live connection is being cancelled and the preference was not changed' : 'the preference was not changed'}.`;
      if (on) return this.settleFailedMcpEnable(st, runtime, trackedWork, 'failed', error);
      const hostStop = Promise.resolve().then(() => st.sdk?.getMcpHost?.()?.stopServer?.(name));
      const cleanup = Promise.allSettled([trackedWork, hostStop]).then(() => {});
      if (await this.promiseSettledWithin(cleanup, this.mcpToggleCleanupTimeoutMs)) {
        return this.finishMcpToggle(st, runtime, 'failed', 'failed', false, error);
      }
      const pending = this.markMcpToggleSettling(st, runtime, 'failed', error);
      void cleanup.then(() => { this.finishMcpToggle(st, runtime, 'failed', 'failed', false, error); });
      return pending;
    }

    if (wait.observed?.status === 'failed' || wait.observed?.status === 'needs-auth') {
      const error = wait.observed.error
        ?? `MCP "${name}" reached target status ${wait.observed.status}.`;
      return this.settleFailedMcpEnable(st, runtime, trackedWork, wait.observed.status, error);
    }

    // A terminal live status can precede the SDK promise's trailing
    // logging/telemetry. Give that bookkeeping a bounded drain before returning
    // success; if it does not settle, keep the operation observable and defer
    // persistence. This applies to disable as well as enable.
    const desiredStatus: McpServerStatus = on ? 'connected' : 'disabled';
    if (wait.observed?.status === desiredStatus && !workState.settled) {
      if (!await this.promiseSettledWithin(trackedWork, this.mcpToggleCleanupTimeoutMs)) {
        const error = `MCP "${name}" reached ${desiredStatus} but SDK completion is still settling; preference is unchanged.`;
        const pending = this.markMcpToggleSettling(st, runtime, desiredStatus, error);
        void trackedWork.then(() => {
          if (workState.error) {
            this.finishMcpToggle(st, runtime, 'failed', 'failed', false, workState.error.message);
            return;
          }
          if (this.sessions.get(sessionId) !== st) {
            this.finishMcpToggle(st, runtime, 'failed', 'failed', false, 'Session disappeared while MCP completion was settling.');
            return;
          }
          const final = this.liveMcpStatus(st, name);
          if (final.status === desiredStatus) {
            this.prefs.setSessionMcp(sessionId, name, on);
            this.finishMcpToggle(st, runtime, 'succeeded', desiredStatus, true);
          } else {
            this.finishMcpToggle(
              st,
              runtime,
              'failed',
              final.status,
              false,
              final.error ?? `MCP "${name}" did not remain connected.`,
            );
          }
        });
        return pending;
      }
    } else {
      await trackedWork;
    }

    if (workState.error) {
      const error = `MCP ${on ? 'enable' : 'disable'} failed for "${name}": ${workState.error.message}`;
      if (on) return this.settleFailedMcpEnable(st, runtime, trackedWork, 'failed', error);
      return this.finishMcpToggle(st, runtime, 'failed', 'failed', false, error);
    }

    const final = this.liveMcpStatus(st, name);
    if (on) {
      if (final.status !== 'connected') {
        const error = final.error ?? `MCP "${name}" completed enable with target status ${final.status}.`;
        return this.settleFailedMcpEnable(st, runtime, trackedWork, final.status, error);
      }
      this.prefs.setSessionMcp(sessionId, name, true);
      return this.finishMcpToggle(st, runtime, 'succeeded', 'connected', true);
    }

    if (final.status !== 'disabled') {
      const error = final.error ?? `MCP "${name}" completed disable with target status ${final.status}.`;
      return this.finishMcpToggle(st, runtime, 'failed', final.status, false, error);
    }
    this.prefs.setSessionMcp(sessionId, name, false);
    return this.finishMcpToggle(st, runtime, 'succeeded', 'disabled', true);
  }

  // Enable/disable one MCP server under a bounded, deduplicated operation. The SDK
  // exposes no AbortSignal for host initialization/enable; on deadline we stop the
  // target transport through its public host and retain a visible `settling`
  // operation if SDK work still cannot be cancelled. Preferences change only after
  // the requested live terminal state is observed.
  async toggleSessionMcp(sessionId: string, name: string, on: boolean): Promise<McpToggleResult> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    if (!Object.hasOwn(this.globalMcpServers(), name)) throw new Error(`unknown MCP server: ${name}`);
    if (this.mcpReloadingSessions.has(sessionId)) {
      throw new Error(`MCP reload is already in progress for session ${sessionId}; no toggle was started`);
    }

    const key = this.mcpToggleKey(sessionId, name);
    const existing = this.mcpToggleOperations.get(key);
    if (existing && this.mcpToggleActive(existing.operation)) {
      return this.mcpToggleResult(
        existing,
        `MCP toggle operation ${existing.operation.id} is already ${existing.operation.state}; `
          + 'no duplicate mutation was started.',
      );
    }

    const runtime: McpToggleRuntime = {
      sessionId,
      name,
      desiredEnabled: on,
      ok: false,
      applied: false,
      operation: {
        id: `mcp-toggle-${Date.now().toString(36)}-${++this.mcpToggleSequence}`,
        desiredEnabled: on,
        state: 'running',
        startedAt: Date.now(),
        status: on ? 'pending' : this.liveMcpStatus(st, name).status,
      },
    };
    this.mcpToggleOperations.set(key, runtime);
    this.updateMcpOperationCount(st);
    return this.executeMcpToggle(st, runtime);
  }

  // Per-session skills: list with this session's enabled flag.
  async listSessionSkills(sessionId: string): Promise<Array<{ name: string; description?: string; source?: string; enabled: boolean }>> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    await this.rescanSkills(st.sdk);
    const allowlistNames = this.prefs.skillAllowlistFor(sessionId);
    const allowlist = allowlistNames === null ? null : new Set(allowlistNames);
    const off = new Set(this.prefs.disabledSkillsFor(sessionId));
    try {
      const rows = (await st.sdk?.skills?.list())?.skills ?? [];
      if (allowlist !== null && st.sdk) {
        await this.disableSkillsOutsideAllowlist(st.sdk, allowlist, rows);
      }
      return rows
        .filter((s) => typeof s.name === 'string')
        .map((s) => {
          const nm = s.name as string;
          const enabled = allowlist !== null
            ? allowlist.has(nm)
            : (typeof s.enabled === 'boolean' ? s.enabled && !off.has(nm) : !off.has(nm));
          return {
            name: nm,
            description: typeof s.description === 'string' ? s.description : undefined,
            source: typeof s.source === 'string' ? s.source : undefined,
            enabled,
          };
        });
    } catch { return []; }
  }

  async toggleSessionSkill(sessionId: string, name: string, enabled: boolean): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    this.prefs.setSessionSkill(sessionId, name, enabled);
    try {
      if (enabled) await st.sdk?.enableSkill?.(name);
      else await st.sdk?.disableSkill?.(name);
    } catch (e) {
      throw new Error(`Skill ${enabled ? '启用' : '禁用'}失败: ${(e as Error).message}`);
    }
  }

  // Re-read the global mcp-config.json and hot-apply to every loaded session so a
  // change made by a "skill/mcp distilling" session takes effect immediately.
  async refreshMcp(): Promise<void> {
    const all = normalizeMcpServersForSdk(this.globalMcpServers());
    await Promise.all([...this.sessions.values()].filter((s) => s.materialized && s.sdk).map(async (st) => {
      try { await this.reloadMcpFor(st, all); } catch { /* best-effort per session */ }
    }));
  }

  // Reconnect one materialized session's MCP servers from current config + per-session
  // enablement. For a stdio server this re-spawns its process, so it's how an updated
  // MCP server picks up NEW CODE without restarting the whole backend. Shared by
  // refreshMcp (all sessions) and reloadSessionMcp (one session).
  private async reloadMcpFor(
    st: SessionState,
    all?: Record<string, Record<string, unknown>>,
    resumePending = true,
  ): Promise<void> {
    const sessionId = st.meta.sessionId;
    if (this.hasActiveMcpToggle(sessionId)) {
      this.mcpReloadPendingSessions.add(sessionId);
      throw new Error(`MCP toggle is in progress for session ${sessionId}; reload was not started`);
    }
    if (this.mcpReloadingSessions.has(sessionId)) {
      this.mcpReloadPendingSessions.add(sessionId);
      throw new Error(`MCP reload is already in progress for session ${sessionId}`);
    }
    this.mcpReloadPendingSessions.delete(sessionId);
    const pendingRetry = this.mcpReloadRetryTimers.get(sessionId);
    if (pendingRetry) clearTimeout(pendingRetry);
    this.mcpReloadRetryTimers.delete(sessionId);
    this.mcpReloadingSessions.add(sessionId);
    this.updateMcpOperationCount(st);
    const cfg = all ?? normalizeMcpServersForSdk(this.globalMcpServers());
    try {
      const enabled = new Set(this.prefs.enabledMcpFor(sessionId));
      const disabledServers = Object.keys(cfg).filter((n) => !enabled.has(n));
      await st.sdk?.reloadMcpServers?.({ mcpServers: cfg, disabledServers });
      this.mcpReloadRetryAttempts.delete(sessionId);
    } finally {
      this.mcpReloadingSessions.delete(sessionId);
      this.updateMcpOperationCount(st);
      if (resumePending) this.resumePendingMcpReload(st);
    }
  }

  private resumePendingMcpReload(st: SessionState): void {
    const sessionId = st.meta.sessionId;
    if (!this.mcpReloadPendingSessions.has(sessionId)
      || this.sessions.get(sessionId) !== st
      || this.hasActiveMcpToggle(sessionId)
      || this.mcpReloadingSessions.has(sessionId)
      || this.mcpReloadRetryTimers.has(sessionId)) return;
    this.mcpReloadPendingSessions.delete(sessionId);
    void this.reloadMcpFor(st, undefined, false).then(() => {
      this.resumePendingMcpReload(st);
    }).catch((error) => {
      this.log('deferred MCP reload failed', { sessionId, err: String(error) });
      if (this.sessions.get(sessionId) !== st) return;
      this.mcpReloadPendingSessions.add(sessionId);
      const attempts = (this.mcpReloadRetryAttempts.get(sessionId) ?? 0) + 1;
      this.mcpReloadRetryAttempts.set(sessionId, attempts);
      if (attempts >= MAX_MCP_RELOAD_ATTEMPTS) {
        this.log('deferred MCP reload remains pending after bounded retries', { sessionId, attempts });
        return;
      }
      const previousRetry = this.mcpReloadRetryTimers.get(sessionId);
      if (previousRetry) clearTimeout(previousRetry);
      const retry = setTimeout(() => {
        this.mcpReloadRetryTimers.delete(sessionId);
        this.resumePendingMcpReload(st);
      }, this.mcpReloadRetryBaseMs * (2 ** (attempts - 1)));
      this.mcpReloadRetryTimers.set(sessionId, retry);
      retry.unref?.();
    });
  }

  // B: self-heal net paired with the MCP-birth mutex. Even with births serialized, a
  // wanted MCP can still surface `failed` if its initialize timed out under transient
  // load — and a timeout is transient: a plain reconnect (which re-spawns the stdio
  // child) succeeds once the storm passes (verified live — reloadMcpServers flips a
  // -32001 `failed` cockpit MCP to `connected`). So after a birth/reload we watch the
  // `wanted` set and, for any that FAILED, retry reloadMcpFor with bounded backoff.
  // Only `failed` (the -32001/timeout class) is retried; `needs-auth` and other non-
  // timeout states are left alone (a reconnect can't fix them). Fully async — the
  // caller voids it, so it never blocks a worker's first turn. Re-fetches the session
  // each pass so an unload/evict/purge during the wait cleanly aborts the heal.
  private async healFailedMcp(
    st: SessionState,
    wanted: Set<string>,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<void> {
    if (wanted.size === 0) return;
    const attempts = opts.attempts ?? 2;
    const delayMs = opts.delayMs ?? 3_000;
    const sessionId = st.meta.sessionId;
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const cur = this.sessions.get(sessionId);
      if (!cur || !cur.materialized || !cur.sdk) return; // unloaded/evicted/gone — stop
      if (this.hasActiveMcpToggle(sessionId)) {
        this.mcpReloadPendingSessions.add(sessionId);
        return;
      }
      let summaries: ReturnType<NonNullable<SdkSession['getMcpServerSummaries']>> = [];
      try { summaries = cur.sdk.getMcpServerSummaries?.() ?? []; } catch { return; }
      const byName = new Map(summaries.map((s) => [s.name, s]));
      const failed = [...wanted].filter((n) => byName.get(n)?.status === 'failed');
      if (failed.length === 0) return; // every wanted MCP recovered (or was never failed)
      this.log('healing failed MCP attach (birth-storm timeout)', { sessionId, failed, attempt: i + 1 });
      try { await this.reloadMcpFor(cur); } catch (e) { this.log('MCP heal reconnect failed', { sessionId, err: String(e) }); }
    }
  }

  // Reconnect ONE session's MCP servers (re-spawning stdio processes so new server
  // code is picked up). Loads the session first if needed. Returns the count of
  // currently-enabled servers it reconnected.
  async reloadSessionMcp(sessionId: string): Promise<{ reconnected: number }> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    await this.reloadMcpFor(st);
    return { reconnected: this.prefs.enabledMcpFor(sessionId).length };
  }

  // ── Filesystem (new-session folder picker) ───────────────────────────────────
  // List the subdirectories of `path` (default: home). Directories only — the
  // picker chooses a working directory. Best-effort: unreadable entries are
  // skipped; an unreadable/missing path falls back to home. Single-operator, so no
  // sandbox beyond normalization (the agent already has full fs access anyway).
  listDir(path?: string): DirListing {
    const home = homedir();
    let target = path && path.trim() ? path.trim() : home;
    if (target === '~' || target.startsWith('~/')) target = join(home, target.slice(1));
    target = resolve(target);
    let names: string[];
    try { names = readdirSync(target); }
    catch { target = home; try { names = readdirSync(target); } catch { names = []; } }
    const entries = names
      .filter((n) => !n.startsWith('.'))   // hide dotfiles/dirs by default
      .map((name) => {
        try { return { name, isDir: statIsDir(join(target, name)) }; }
        catch { return null; }
      })
      .filter((e): e is { name: string; isDir: boolean } => e !== null)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const parent = target === dirname(target) ? null : dirname(target);
    return { path: target, parent, entries };
  }

  // Soft delete: move the session to the trash. Its SDK data is KEPT on disk; it's
  // just hidden from the main list (refreshList + snapshot exclude trashed ids) and
  // restorable. Permanent destruction is `purgeSession` (cockpit MCP only).
  async deleteSession(sessionId: string, reason?: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (this.hasActiveMcpToggle(sessionId) || this.mcpReloadingSessions.has(sessionId)) {
      throw new Error('MCP operation is still in progress; wait for it to settle before trashing this session');
    }
    // Capture the source fields BEFORE we drop it from the map (the event needs the
    // trashed session's cwd/title). Empty fallback if it was already gone.
    const cwd = st?.meta.cwd ?? '';
    const title = st?.meta.title ?? '';
    try { st?.unsub?.(); } catch { /* ignore */ }
    this.prefs.trashSession(sessionId, reason);
    this.sessions.delete(sessionId);
    this.forgetMcpOperations(sessionId);
    this.mcpReloadPendingSessions.delete(sessionId);
    this.emit({ type: 'session/removed', sessionId });
    // Soft-delete (trash) only — NOT purge (purgeSession does NOT fire this). The
    // harvest pipeline subscribes via a session.trashed hook to salvage the corpse
    // for skill candidates the instant it's binned, instead of waiting for the 3h
    // cold-scan. Source-keyed (carries cwd ⇒ a cwd_prefix hook can filter). Fired
    // for ALL trashed sessions, spawnedBy workers included — no R1 guard: a finished
    // worker's transcript is a prime salvage target and the harvest gate's single-
    // flight collapses any burst (contrast first-turn/error, where firing for a
    // worker would amplify into a welcome/triage worker = fork bomb).
    this.fireEvent({ event: 'session.trashed', sessionId, cwd, title });
  }

  // Restore a trashed session: clear the mark; refreshList re-materializes it (and
  // re-emits session/added). Returns false if it wasn't trashed.
  async restoreSession(sessionId: string): Promise<boolean> {
    if (!this.prefs.isTrashed(sessionId)) return false;
    this.prefs.restoreSession(sessionId);
    this.previews.delete(sessionId);   // a restored session is live now — drop its read-only preview
    await this.refreshList();   // re-adds it to the map + emits session/added
    return true;
  }

  // Synchronous authoritative list of live (non-trashed) sessions, projected to a
  // compact brief. The in-memory map holds every non-trashed session (refreshList
  // seeds unloaded placeholders), so this mirrors exactly what the UI shows.
  listLive(): Array<{ sessionId: string; title: string; cwd: string; status: string; launchState?: 'launching' | 'launch_failed' | null; loaded: boolean; lastActivity: number; currentModelId?: string }> {
    return [...this.sessions.values()]
      .map((s) => ({
        sessionId: s.meta.sessionId,
        title: s.meta.title,
        cwd: s.meta.cwd,
        status: s.meta.status,
        ...(s.meta.launchState !== undefined ? { launchState: s.meta.launchState } : {}),
        loaded: s.meta.loaded,
        lastActivity: s.meta.lastActivity,
        ...(s.meta.currentModelId ? { currentModelId: s.meta.currentModelId } : {}),
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // The full authoritative SessionMeta for one session — the same object the SSE
  // snapshot projects (queue/ask/plan/elicitation/todo/model/mode/pin/…). Returned
  // synchronously so the cockpit MCP can read the ids (queue itemId, ask requestId)
  // that mutation intents need, without subscribing to the SSE stream.
  getMeta(sessionId: string): SessionMeta | null {
    const st = this.sessions.get(sessionId);
    return st ? st.meta : null;
  }

  // ── Scheduled prompts (the SDK's per-session ScheduleRegistry) ───────────────
  // Normalize a raw SDK ScheduleEntry into the wire shape. The registry returns
  // numeric epoch-ms fields; we keep only the keys present (exactly one timing kind).
  private toScheduleEntry(raw: Record<string, unknown>): ScheduleEntry | null {
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const id = num(raw.id);
    const prompt = str(raw.prompt);
    if (id == null || prompt == null) return null;
    return {
      id,
      prompt,
      recurring: typeof raw.recurring === 'boolean' ? raw.recurring : true,
      nextRunAt: num(raw.nextRunAt) ?? Date.now(),
      ...(num(raw.intervalMs) != null ? { intervalMs: num(raw.intervalMs) } : {}),
      ...(str(raw.cron) ? { cron: str(raw.cron) } : {}),
      ...(str(raw.tz) ? { tz: str(raw.tz) } : {}),
      ...(num(raw.at) != null ? { at: num(raw.at) } : {}),
      ...(str(raw.displayPrompt) ? { displayPrompt: str(raw.displayPrompt) } : {}),
    };
  }

  // Register a scheduled prompt. Exactly one timing kind (interval | cron | at);
  // `recurring` defaults to true for interval/cron and false for the one-shot `at`.
  async addSchedule(
    sessionId: string,
    opts: { prompt: string; interval?: string; cron?: string; at?: number; recurring?: boolean; tz?: string; displayPrompt?: string },
  ): Promise<{ entry?: ScheduleEntry; error?: string }> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const reg = st.sdk?.scheduleRegistry;
    if (!reg) return { error: 'scheduling is not available on this session' };
    const { prompt } = opts;
    const options: Record<string, unknown> = {};
    if (opts.recurring !== undefined) options.recurring = opts.recurring;
    if (opts.tz) options.tz = opts.tz;
    if (opts.displayPrompt) options.displayPrompt = opts.displayPrompt;
    let res: { entry?: Record<string, unknown>; error?: string };
    try {
      if (opts.cron != null) res = reg.addCron(opts.cron, prompt, options);
      else if (opts.at != null) res = reg.addAt(opts.at, prompt, { recurring: false, ...options });
      else if (opts.interval != null) res = reg.add(opts.interval, prompt, options);
      else return { error: 'one of interval, cron, or at is required' };
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (res?.error) return { error: res.error };
    const entry = res?.entry ? this.toScheduleEntry(res.entry) : null;
    this.refreshScheduleCount(st);
    return entry ? { entry } : { error: 'schedule was created but could not be read back' };
  }

  async stopSchedule(sessionId: string, id: number): Promise<boolean> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const reg = st.sdk?.scheduleRegistry;
    if (!reg) return false;
    try { const ok = reg.stop(id) != null; this.refreshScheduleCount(st); return ok; } catch { return false; }
  }

  async listSchedules(sessionId: string): Promise<ScheduleEntry[]> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const reg = st.sdk?.scheduleRegistry;
    if (!reg) return [];
    try {
      return reg.list()
        .map((r) => this.toScheduleEntry(r))
        .filter((e): e is ScheduleEntry => e != null);
    } catch { return []; }
  }

  // Count of active schedules on a loaded session (cheap synchronous registry read).
  // Drives the list timer badge; 0 when scheduling isn't available or none exist.
  private scheduleCountOf(st: SessionState): number {
    const reg = st.sdk?.scheduleRegistry;
    if (!reg) return 0;
    try { return reg.list().length; } catch { return 0; }
  }

  // Recompute scheduleCount after a schedule_created/cancelled event and patch if
  // it changed, so the list badge stays in sync (backend truth → SSE projection).
  // Also maintains the persistent scheduledSessions index — the has-schedule signal
  // that drives keep-loaded (eviction exemption + startup reload), replacing pin.
  private refreshScheduleCount(st: SessionState): void {
    const next = this.scheduleCountOf(st);
    this.prefs.setScheduleCount(st.meta.sessionId, next);
    if (next !== (st.meta.scheduleCount ?? 0)) this.patch(st, { scheduleCount: next });
  }

  // ── Butler/Flow event hooks (engine-global trigger layer) ────────────────────
  // Project the persisted butler fields (spawnedBy for R1, hookCount for the
  // owner badge) onto a session's meta. Called wherever a SessionState is built
  // (refreshList / loadSession), alongside the pinned/scheduleCount projections.
  private projectButlerMeta(st: SessionState): void {
    const spawnedBy = this.prefs.spawnedByOf(st.meta.sessionId);
    if (spawnedBy) st.meta.spawnedBy = spawnedBy;
    const n = this.hookReg.countFor(st.meta.sessionId);
    if (n > 0) st.meta.hookCount = n;
  }

  // The v1 trigger check: a REAL session finishing its first turn with content.
  // firstTurnEligible enforces R1 (spawnedBy worker = non-trigger-source), the
  // once-per-source bit, non-cancel, and a ≥1 real user+assistant exchange.
  private maybeFirstTurnComplete(st: SessionState): void {
    // Count from the FOLDED history (which includes the full replayed event log on
    // a loaded session, plus live events) so eligibility reflects the PERSISTED
    // turn count — not just "this process has seen one idle".
    const { userPrompts, assistantMessages } = countTurnSignals(st.fold.messages);
    const eligible = firstTurnEligible({
      spawnedBy: st.meta.spawnedBy,
      alreadyWelcomed: this.prefs.isWelcomed(st.meta.sessionId),
      cancelled: st.turnCancelled === true,
      userPrompts,
      assistantMessages,
    });
    if (!eligible) return;
    this.prefs.markWelcomed(st.meta.sessionId);
    this.fireEvent({
      event: 'session.first-turn-complete',
      sessionId: st.meta.sessionId,
      cwd: st.meta.cwd,
      title: st.meta.title,
    });
  }

  // The triage trigger: a REAL session's turn ended in error. Guarded by
  // sessionErrorEligible — R1 (a spawnedBy worker's error never fires; a bad worker
  // is reviewed by flow-review, not triaged, else it would error-storm triage) and
  // a per-source rate-limit (a flapping session emits at most one event per
  // SESSION_ERROR_WINDOW_MS). The `summary` carries the error message for the hook.
  private maybeSessionError(st: SessionState, message: string): void {
    const now = Date.now();
    const eligible = sessionErrorEligible({
      spawnedBy: st.meta.spawnedBy,
      lastFiredAt: this.sessionErrorFiredAt.get(st.meta.sessionId),
      now,
      windowMs: SESSION_ERROR_WINDOW_MS,
    });
    if (!eligible) return;
    this.sessionErrorFiredAt.set(st.meta.sessionId, now);
    this.fireEvent({
      event: 'session.error',
      sessionId: st.meta.sessionId,
      cwd: st.meta.cwd,
      title: st.meta.title,
      summary: message,
    });
  }
  // session. Mechanical + cheap; the intelligence is all in the agent it lands on.
  private fireEvent(ctx: SessionEventCtx): void {
    const deliveries = matchHooks(this.hookReg.list(), ctx);
    if (deliveries.length === 0) return;
    this.log('butler event fired hooks', { event: ctx.event, source: ctx.sessionId, count: deliveries.length });
    for (const d of deliveries) {
      if (d.flowId) {
        // Canonical path: the hook drives a Flow (gate → action).
        void this.runFlow(d.flowId, ctx)
          .catch((e) => this.log('hook flow run failed', { hook: d.hook.id, flowId: d.flowId, err: String(e) }));
      } else if (d.text) {
        // Fallback: deliver an interpolated prompt straight into the owner session.
        void this.prompt(d.ownerSession, d.text, 'enqueue')
          .catch((e) => this.log('hook delivery failed', { hook: d.hook.id, err: String(e) }));
      }
    }
    // On a GLOBAL (source-less) event, `once` means "fire then auto-remove" — there
    // is no per-source bit to dedupe on, so a one-shot boot hook self-cleans after
    // its single firing. NOTE the removal runs right after the fire-and-forget
    // dispatch above, so it does NOT guarantee durability of the delivery itself: if
    // prompt() rejects (owner gone) or the engine restarts again before the enqueued
    // turn runs, the hook is already persisted-removed and won't re-fire. What it
    // robustly covers is the restart window (the hook fires the instant the engine is
    // up) and the owner's *follow-up* turn failing — not the single delivery's
    // persistence. For session.first-turn-complete `once` is a no-op (dedup is the
    // persisted welcomed-bit), so it is left alone here.
    if (isGlobalEvent(ctx.event)) {
      for (const d of deliveries) {
        if (d.hook.once && this.hookReg.stop(d.hook.id)) {
          this.refreshHookCount(d.hook.ownerSession);
        }
      }
    }
  }

  // ── Flow layer (TRIGGER → FLOW → ACTION, design §2.10) ───────────────────────
  listFlows(): Flow[] { return this.flowReg.list(); }

  // Author a flow definition (maintainer MCP). Returns the written flow on success.
  addFlow(flow: Flow): { ok: boolean; flow?: Flow; error?: string } {
    const res = this.flowReg.write(flow);
    return res.ok ? { ok: true, flow } : { ok: false, error: res.error };
  }

  // Delete a flow definition. Also stops any server-level schedules pointing at it
  // (a schedule firing a now-missing flow would be a silent no-op); hooks are left
  // (a hook pointing at a missing flow is inert and visible in the UI).
  removeFlow(id: string): { ok: boolean; error?: string } {
    const res = this.flowReg.remove(id);
    if (res.ok) {
      for (const s of this.flowSchedReg.list()) if (s.flowId === id) this.flowSchedReg.stop(s.id);
    }
    return res;
  }

  // Write a gate script into the flows dir; returns its absolute path.
  writeGate(name: string, script: string): { ok: boolean; path?: string; error?: string } {
    return this.flowReg.writeGate(name, script);
  }

  // ── Server-level flow schedules (time triggers; fire with 0 sessions loaded) ─
  addFlowSchedule(input: {
    flowId?: string; target?: InlineScheduleTarget; interval?: string; cron?: string; at?: number; recurring?: boolean; tz?: string; label?: string;
  }): { ok: boolean; entry?: FlowScheduleEntry; error?: string } {
    // Guard a flowId action: the flow must exist (a schedule pointing at nothing is
    // a silent no-op). An inline target needs no such check — it carries its own
    // sessionId + prompt, and engine.prompt ensureLoads the session on fire.
    if (input.flowId && !this.flowReg.get(input.flowId)) return { ok: false, error: `no such flow: ${input.flowId}` };
    const res = this.flowSchedReg.add(input);
    return res.entry ? { ok: true, entry: res.entry } : { ok: false, error: res.error };
  }

  listFlowSchedules(): FlowScheduleEntry[] { return this.flowSchedReg.list(); }

  stopFlowSchedule(id: number): boolean { return this.flowSchedReg.stop(id); }

  // Run a flow: its optional gate (cheap, no-LLM cost gate), then — if the gate
  // says go — its action. ctx is the triggering event context (null for a manual
  // run with no event). Returns the spawned worker id (spawn-session) or skip.
  async runFlow(flowId: string, ctx: SessionEventCtx | null): Promise<{ ok: boolean; skipped?: boolean; sessionId?: string; error?: string }> {
    const flow = this.flowReg.get(flowId);
    if (!flow) return { ok: false, error: `no such flow: ${flowId}` };
    // Gate: a cheap deterministic script decides whether to spend an agent at all.
    let params: Record<string, string> = {};
    if (flow.gate) {
      const res = await runGate(flow.gate.script, ctx, flow.gate.timeoutMs);
      if (res.error) {
        const error = `flow gate failed: ${res.error}`;
        this.log('flow gate failed', { flow: flowId, error });
        return { ok: false, error };
      }
      if (!res.go) {
        this.log('flow gate skipped', { flow: flowId, reason: res.reason });
        return { ok: true, skipped: true };
      }
      params = res.params;
    }
    // Action.
    const action = flow.action;
    if (action.kind === 'prompt-existing') {
      let text: string;
      try {
        text = interpolateFlow(action.prompt, ctx, params);
      } catch (e) {
        const error = `flow interpolation failed: ${(e as Error).message}`;
        this.log('flow interpolation failed', { flow: flowId, field: 'prompt', error });
        return { ok: false, error };
      }
      await this.prompt(action.sessionId, text, 'enqueue');
      this.log('flow prompt-existing delivered', { flow: flowId, target: action.sessionId });
      return { ok: true, sessionId: action.sessionId };
    }
    // Render every side-effecting field before creating the session. This makes a
    // missing gate key fail closed: no half-born worker can receive a literal token.
    let template: SessionTemplate;
    try {
      template = {
        ...action.template,
        cwd: interpolateFlow(action.template.cwd, ctx, params),
        prompt: interpolateFlow(action.template.prompt, ctx, params),
        ...(action.template.title !== undefined
          ? { title: interpolateFlow(action.template.title, ctx, params) }
          : {}),
      };
    } catch (e) {
      const error = `flow interpolation failed: ${(e as Error).message}`;
      this.log('flow interpolation failed', { flow: flowId, field: 'spawn-session template', error });
      return { ok: false, error };
    }
    // spawn-session: a fresh, born-configured worker. The template is already
    // rendered and validated, so the creation path cannot leak a gate token.
    try {
      const sessionId = await this.spawnSession(template, flowId, null, {});
      return { ok: true, sessionId };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // Spawn a fresh, born-configured worker session and start its first turn. The
  // config (tight skill set, MCP set, model, mode) is applied BEFORE the prompt,
  // so the worker is "born ready". It is marked spawnedBy=flowId (R1: a
  // non-trigger-source — its own lifecycle never fires a hook; one mark also drives
  // UI folding in Phase C). Per decision F7 the worker is KEPT, not auto-deleted.
  private async spawnSession(
    template: SessionTemplate,
    flowId: string,
    ctx: SessionEventCtx | null,
    params: Record<string, string>,
  ): Promise<string> {
    const cwd = interpolateFlow(template.cwd, ctx, params) || HOME;
    // MCP at birth: connect only the template's set (the rest disabled/lazy).
    const allMcp = normalizeMcpServersForSdk(this.globalMcpServers());
    const wanted = new Set(template.mcps ?? []);
    const disabledMcpServers = Object.keys(allMcp).filter((n) => !wanted.has(n));
    const createSdkSession = () => this.manager.createSession({
      workingDirectory: cwd, authInfo: this.authInfo, featureFlagService: this.ffs,
      enableStreaming: true, permissionRequestHandler: APPROVE_ALL_PERMISSIONS,
      mcpServers: allMcp, disabledMcpServers,
    });
    const finishLaunch = async (sdkSession: SdkSession): Promise<string> => {
      const sessionId = sdkSession.sessionId;
      // Mark spawnedBy FIRST so the meta carries it from birth (R1 + folding) and so
      // a first-turn-complete on this worker is suppressed (it is a non-trigger-source).
      this.prefs.setSpawnedBy(sessionId, flowId);
      // Persist the per-session MCP set so it survives reload.
      for (const name of Object.keys(allMcp)) this.prefs.setSessionMcp(sessionId, name, wanted.has(name));
      // The worker's display title: the flow's configured title (interpolated) if set,
      // else the cwd basename. A configured title is set on the SDK BELOW so it sticks
      // (user-named) and isn't re-derived from the first prompt.
      const configuredTitle = template.title ? interpolateFlow(template.title, ctx, params).trim().slice(0, 60) : '';
      const st: SessionState = {
        meta: {
          sessionId, title: configuredTitle || basename(cwd) || 'worker', cwd, spawnedBy: flowId,
          createdAt: Date.now(), lastActivity: Date.now(), status: 'running', error: null, launchState: 'launching',
          loaded: true, queue: [], ask: null,
        },
        fold: newFoldState(), sdk: sdkSession, loadPromise: Promise.resolve(),
        materialized: true, unsub: null, cwd, imageBytes: 0, inflightTasks: new Set(),
      };
      this.sessions.set(sessionId, st);
      this.attach(st);
      writeFlowLaunchMarker(sessionId, { version: 1, flowId, state: 'launching', updatedAt: Date.now() });
      this.emit({ type: 'session/added', session: st.meta });
      try {
        // Pin the configured title on the SDK BEFORE the first prompt, so the runtime
        // marks the session user-named and never overwrites it with a prompt-derived
        // summary (which is why un-named workers showed their raw prompt as the title).
        if (configuredTitle && sdkSession.name?.set) {
          await sdkSession.name.set({ name: configuredTitle });
        }
        // Tight skill match: disable every global skill NOT in the template's set.
        if (template.skills) {
          const keep = new Set(template.skills);
          this.prefs.setSkillAllowlist(sessionId, template.skills);
          await this.rescanSkills(sdkSession);
          const rows = (await sdkSession.skills?.list())?.skills ?? [];
          await this.disableSkillsOutsideAllowlist(sdkSession, keep, rows);
        }
        // Model + mode before the first turn.
        if (template.model) await this.setModel(sessionId, template.model);
        if (template.mode) await this.setMode(sessionId, template.mode);
        // The SDK does its real stdio MCP/tool startup lazily in processQueuedItems,
        // after send() has enqueued the prompt. Do that documented preflight here,
        // while this MCP-enabled birth still owns mcpBirthGate and before the
        // dispatch budget starts. Otherwise a 15s observer timeout can release the
        // gate while the SDK send keeps initializing in the background, allowing
        // the next scheduled birth to overlap the still-live preflight.
        if (wanted.size > 0) {
          if (typeof sdkSession.initializeAndValidateTools !== 'function') {
            throw new Error('SDK does not expose initializeAndValidateTools for MCP-enabled flow birth');
          }
          await sdkSession.initializeAndValidateTools();
          // initializeAndValidateTools can return while a system notification it
          // started is still inside processQueuedItems. Sending "immediate" in that
          // interval would put the worker prompt in the steering queue. Keep the
          // birth gate through the actual SDK critical region and dispatch only
          // after that prior work has authoritatively gone idle.
          await this.waitForSpawnedPreflightQuiescence(sdkSession);
        }
        this.evictIfNeeded(sessionId); // M6: bound resident windows (never evicts this one — it's just-loaded)
        // Now born-ready → start the first turn, but only report success once the
        // worker's first user.message has been durably accepted into history.
        const prompt = interpolateFlow(template.prompt, ctx, params);
        await this.startSpawnedFirstTurn(st, prompt, flowId, wanted.size > 0);
        clearFlowLaunchMarker(sessionId);
        this.patch(st, { launchState: null });
        // B: self-heal net — if a wanted MCP lost its initialize race under a birth storm,
        // reconnect it with bounded backoff (async; the first turn is already running).
        if (wanted.size) void this.healFailedMcp(st, wanted);
        this.log('flow spawned worker', { flow: flowId, sessionId, cwd, skills: template.skills?.length ?? 'all', mcps: [...wanted] });
        return sessionId;
      } catch (e) {
        const reason = (e as Error).message ?? String(e);
        writeFlowLaunchMarker(sessionId, { version: 1, flowId, state: 'launch_failed', updatedAt: Date.now(), error: reason });
        this.patch(st, { status: 'error', error: reason, launchState: 'launch_failed' });
        this.log('flow spawn failed', { flow: flowId, sessionId, err: reason });
        throw new Error(reason);
      }
    };
    if (wanted.size > 0) {
      return this.mcpBirth(async () => finishLaunch(await createSdkSession()));
    }
    // Every configured server is disabled here, so no stdio child can initialize.
    // Keep MCP-free probe/worker births genuinely concurrent.
    return finishLaunch(await createSdkSession());
  }

  private async waitForSpawnedPreflightQuiescence(sdk: SdkSession): Promise<void> {
    if (typeof sdk.isProcessingMessages !== 'function') return;
    const isProcessing = (): boolean => {
      try { return sdk.isProcessingMessages?.() === true; } catch { return false; }
    };
    if (!isProcessing()) return;
    const timeoutMs = flowFirstTurnSubmissionTimeoutMs();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        if (error) reject(error);
        else resolve();
      };
      unsubscribe = sdk.on('*', (ev: SdkEvent) => {
        if (typeof (ev as { agentId?: unknown }).agentId === 'string') return;
        if (ev.type === 'session.error') {
          finish(new Error(`MCP preflight processing failed before first prompt dispatch: ${eventText(ev) ?? 'unknown SDK error'}`));
          return;
        }
        if (ev.type === 'session.idle' && !isProcessing()) finish();
      });
      if (settled) unsubscribe();
      if (!settled) {
        timer = setTimeout(() => {
          if (!isProcessing()) {
            finish();
            return;
          }
          const quiescence = new Promise<void>((resolve) => {
            let done = false;
            let release: (() => void) | null = null;
            const resolveOnce = (): void => {
              if (done) return;
              done = true;
              release?.();
              resolve();
            };
            release = sdk.on('*', (ev: SdkEvent) => {
              if (
                typeof (ev as { agentId?: unknown }).agentId !== 'string'
                && ev.type === 'session.idle'
                && !isProcessing()
              ) resolveOnce();
            });
            if (done) release();
            if (!isProcessing()) resolveOnce();
          });
          this.quarantineMcpBirthUntilSettled(sdk.sessionId, quiescence);
          finish(new Error(`MCP preflight processing remained active before first prompt dispatch for ${timeoutMs}ms`));
        }, timeoutMs);
      }
      // Close subscribe/check: the idle may have fired immediately before `on`.
      if (!isProcessing()) finish();
    });
  }

  private async startSpawnedFirstTurn(
    st: SessionState,
    prompt: string,
    flowId: string,
    mcpEnabled: boolean,
  ): Promise<void> {
    if (!st.sdk) throw new Error('session not loaded');
    const submissionTimeoutMs = flowFirstTurnSubmissionTimeoutMs();
    const durableTimeoutMs = flowFirstTurnDurableTimeoutMs();
    const pollMs = flowFirstTurnPollMs();
    const cleanupTimeoutMs = flowFirstTurnCleanupTimeoutMs();
    let baselineEventCount = st.sdk.getEvents().length;
    let dispatchStartedAt: number | null = null;
    let settled = false;
    let launchFailure: string | null = null;
    let submissionAcceptedAt: number | null = null;
    let queuedAt: number | null = null;
    let queueDrainedAt: number | null = null;
    let promptQueueState: 'unseen' | 'queued' | 'dequeued' = 'unseen';
    let signalSequence = 0;
    let dequeueSequence: number | null = null;
    let lastIdleSequence: number | null = null;
    let sendSettled = false;
    let lastWarning: string | null = null;
    let lastError: string | null = null;
    let promptHookFailure: PromptHookFailure | null = null;
    let resolveReady!: () => void;
    let rejectReady!: (reason?: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const finishOk = (): void => {
      if (settled) return;
      settled = true;
      resolveReady();
    };
    const finishErr = (reason: string): void => {
      if (settled) return;
      settled = true;
      launchFailure = reason;
      rejectReady(new Error(reason));
    };
    const evaluate = (): void => {
      if (settled || !st.sdk) return;
      const snapshot = readSpawnedFirstTurnSnapshot(st.sdk, baselineEventCount, prompt);
      if (snapshot.lastWarning) lastWarning = snapshot.lastWarning;
      if (snapshot.lastError) lastError = snapshot.lastError;
      if (snapshot.hasUserMessage) {
        finishOk();
        return;
      }
      if (lastError) {
        finishErr(`flow worker first turn failed before persistence: ${lastError}`);
        return;
      }
      const now = Date.now();
      const pendingPrompt = this.readQueueItems(st)
        .some((item) => item.kind === 'message' && item.text === prompt);
      if (pendingPrompt) {
        submissionAcceptedAt ??= now;
        queuedAt ??= now;
        if (promptQueueState === 'unseen') promptQueueState = 'queued';
        this.syncQueue(st);
        if (now - queuedAt >= submissionTimeoutMs) {
          finishErr(lastWarning
            ? `flow worker first prompt remained queued before processing: ${lastWarning}`
            : `flow worker first prompt was accepted but remained queued before processing `
              + `for ${submissionTimeoutMs}ms`);
        }
        return;
      }
      if (promptQueueState === 'queued') {
        promptQueueState = 'dequeued';
        queueDrainedAt ??= now;
        dequeueSequence ??= signalSequence;
      }
      let sdkProcessing: boolean | null = null;
      try {
        if (typeof st.sdk.isProcessingMessages === 'function') {
          sdkProcessing = st.sdk.isProcessingMessages();
        }
      } catch { /* terminal inference falls back to ordered idle */ }
      const idleAtOrAfterDequeue = lastIdleSequence !== null
        && (dequeueSequence === null || lastIdleSequence >= dequeueSequence);
      // SDK 1.0.63 shifts FIFO and steering entries before it emits the matching
      // user.message. A queue-modified callback therefore observes a real
      // dequeue->append atomicity gap. send() can also already be settled for an
      // immediate steering send. Only a quiescent SDK (or, on older surfaces, an
      // ordered idle) is terminal; instantaneous absence plus a stale idle is not.
      const sdkTerminal = sendSettled && (
        sdkProcessing === false
        || (sdkProcessing === null && idleAtOrAfterDequeue)
      );
      if (lastWarning && sdkTerminal) {
        const warning = lastWarning === 'Policy hook failed' && promptHookFailure
          ? describePolicyHookFailure(promptHookFailure)
          : lastWarning;
        finishErr(`flow worker first turn was blocked before persistence: ${warning}`);
        return;
      }
      if (
        dispatchStartedAt !== null
        && submissionAcceptedAt === null
        && now - dispatchStartedAt >= submissionTimeoutMs
      ) {
        if (lastWarning) {
          const warning = lastWarning === 'Policy hook failed' && promptHookFailure
            ? describePolicyHookFailure(promptHookFailure)
            : lastWarning;
          finishErr(`flow worker first prompt dispatch remained pending before submission: ${warning}`);
          return;
        }
        finishErr(
          `flow worker first prompt dispatch remained pending with no prompt-correlated `
          + `user.message within ${submissionTimeoutMs}ms`,
        );
        return;
      }
      const durableStartedAt = queueDrainedAt ?? submissionAcceptedAt;
      if (durableStartedAt !== null && now - durableStartedAt >= durableTimeoutMs) {
        if (promptQueueState === 'dequeued' && sdkTerminal) {
          finishErr(
            `flow worker first prompt was dequeued and SDK processing became terminal `
            + `without a durable user.message within ${durableTimeoutMs}ms`,
          );
          return;
        }
        if (sdkProcessing === true) {
          finishErr(
            `flow worker first prompt was accepted but SDK processing remained active `
            + `without a durable user.message for ${durableTimeoutMs}ms`,
          );
          return;
        }
        if (sdkTerminal) {
          finishErr(`flow worker first prompt was accepted but no durable user.message appeared within ${durableTimeoutMs}ms`);
        }
      }
    };
    const off = st.sdk.on('*', (ev: SdkEvent) => {
      if (typeof (ev as { agentId?: unknown }).agentId === 'string') return;
      if (dispatchStartedAt === null) return;
      signalSequence++;
      const hookFailure = promptHookFailureFromEvent(ev);
      if (hookFailure) {
        promptHookFailure = hookFailure;
        this.log('flow first prompt hook callback failed', {
          flow: flowId,
          sessionId: st.meta.sessionId,
          hookType: 'userPromptSubmitted',
          source: hookFailure.source ?? 'unknown',
          error: hookFailure.message,
          ...(hookFailure.stack ? { stack: hookFailure.stack } : {}),
        });
      }
      if (ev.type === 'session.warning') lastWarning = eventText(ev) ?? lastWarning;
      if (ev.type === 'session.error') lastError = eventText(ev) ?? lastError ?? '首轮启动失败';
      if (ev.type === 'session.idle') {
        lastIdleSequence = signalSequence;
      }
      evaluate();
    });
    // Arm the live observer first, then establish the authoritative pre-dispatch
    // boundary. Events emitted during subscription setup are initialization, not
    // evidence that this prompt was submitted.
    baselineEventCount = st.sdk.getEvents().length;
    const poll = setInterval(evaluate, pollMs);
    let sendPromise: Promise<unknown> | null = null;
    try {
      try {
        dispatchStartedAt = Date.now();
        sendPromise = st.sdk.send({ prompt, mode: 'immediate' });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        this.patch(st, { status: 'error', error: msg });
        this.maybeSessionError(st, msg);
        finishErr(`flow worker first prompt rejected: ${msg}`);
        await ready;
        return;
      }
      void sendPromise.then(() => {
        sendSettled = true;
        submissionAcceptedAt = Date.now();
        evaluate();
      }).catch((e) => {
        sendSettled = true;
        const msg = (e as Error).message ?? String(e);
        if (launchFailure === null) {
          this.patch(st, { status: 'error', error: msg });
          this.maybeSessionError(st, msg);
        }
        finishErr(`flow worker first prompt rejected: ${msg}`);
      });
      evaluate();
      await ready;
    } finally {
      clearInterval(poll);
      off();
      const snapshot = st.sdk ? readSpawnedFirstTurnSnapshot(st.sdk, baselineEventCount, prompt) : null;
      if (!snapshot?.hasUserMessage) {
        // Do not release mcpBirthGate while an SDK processQueue/preflight spawned
        // by this birth is still alive. Abort exactly this one send, drain its
        // pending queues, and wait for it to unwind. No retry and no duplicate send.
        try { await st.sdk?.abort?.(); } catch { /* launch failure below remains authoritative */ }
        try { this.clearQueue(st); } catch { /* best-effort after abort */ }
        if (sendPromise && !sendSettled) {
          let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
          const cleanupTimedOut = await Promise.race([
            sendPromise.then(() => false, () => false),
            new Promise<true>((resolve) => {
              cleanupTimer = setTimeout(() => resolve(true), cleanupTimeoutMs);
            }),
          ]);
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (cleanupTimedOut) {
            if (mcpEnabled) this.quarantineMcpBirthUntilSettled(st.meta.sessionId, sendPromise);
            this.log('spawn first prompt SDK send did not unwind after abort', {
              flow: flowId,
              sessionId: st.meta.sessionId,
              cleanupTimeoutMs,
              mcpBirthQuarantined: mcpEnabled,
            });
          }
        }
        this.log('spawn first prompt failed', {
          flow: flowId,
          sessionId: st.meta.sessionId,
          err: st.meta.error ?? lastError ?? lastWarning ?? 'no durable first turn',
        });
      }
    }
  }

  // Register an event hook. A hook needs either a promptTemplate (deliver an
  // interpolated prompt to the owner) or a flowId (drive a Flow: gate → action).
  addHook(input: {
    ownerSession: string;
    event: HookEntry['event'];
    filter?: HookEntry['filter'];
    flowId?: string;
    promptTemplate?: string;
    once?: boolean;
  }): { ok: boolean; entry?: HookEntry; error?: string } {
    if (!input.promptTemplate && !input.flowId) {
      return { ok: false, error: 'a hook needs either a promptTemplate or a flowId' };
    }
    // Fail loud (Finding 1): the global engine.boot-complete event carries empty
    // source fields, so a cwd_prefix/source_session filter can NEVER match — the
    // hook would be silently dead. Reject at the boundary rather than create a
    // footgun. (excludeSelf is harmless on a '' source, so it's allowed.)
    const bootReject = bootFilterRejection(input.event, input.filter);
    if (bootReject) return { ok: false, error: bootReject };
    const entry = this.hookReg.add({
      ownerSession: input.ownerSession,
      event: input.event,
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.flowId ? { flowId: input.flowId } : {}),
      ...(input.promptTemplate ? { promptTemplate: input.promptTemplate } : {}),
      ...(input.once !== undefined ? { once: input.once } : {}),
    });
    this.refreshHookCount(entry.ownerSession);
    return { ok: true, entry };
  }

  listHooks(ownerSession?: string): HookEntry[] {
    return this.hookReg.list(ownerSession);
  }

  stopHook(id: string): boolean {
    const hook = this.hookReg.list().find((h) => h.id === id);
    const ok = this.hookReg.stop(id);
    if (ok && hook) this.refreshHookCount(hook.ownerSession);
    return ok;
  }

  // Patch a session's hookCount badge when its owned-hook set changes (backend
  // truth → SSE projection). No-op for an owner session not currently in the map
  // (its count is projected by projectButlerMeta when it next appears).
  private refreshHookCount(ownerSession: string): void {
    const st = this.sessions.get(ownerSession);
    if (!st) return;
    const next = this.hookReg.countFor(ownerSession);
    if (next !== (st.meta.hookCount ?? 0)) this.patch(st, { hookCount: next });
  }

  // Enumerate the trash with title/cwd joined from the SDK's listSessions (the
  // trashed sessions aren't in the in-memory map, so read their meta from disk).
  async listTrash(): Promise<Array<{ sessionId: string; title: string; cwd: string; at: string; reason?: string }>> {
    const marks = this.prefs.trashedEntries();
    if (marks.length === 0) return [];
    let metas: SdkSessionMeta[] = [];
    try { metas = await this.manager.listSessions(); } catch { /* fall back to ids */ }
    const byId = new Map(metas.map((m) => [m.sessionId, m]));
    return marks.map((t) => {
      const m = byId.get(t.sessionId);
      const meta = m ? metaFromSdk(m).meta : null;
      return {
        sessionId: t.sessionId,
        title: meta?.title ?? t.sessionId.slice(0, 8),
        cwd: meta?.cwd ?? '',
        at: t.at,
        ...(t.reason ? { reason: t.reason } : {}),
      };
    }).sort((a, b) => b.at.localeCompare(a.at));
  }

  // Permanent purge: the real, irreversible delete. Calls the SDK manager's
  // deleteSession (removes the session's on-disk directory), then cascade-cleans the
  // session's rows from the global session-store.db ourselves — the SDK's
  // deleteSession does NOT touch that store (SessionStore has no delete), so without
  // this its `sessions`/`turns`/`search_index` rows would survive forever and the
  // harvest scanner would keep resurrecting the orphan as a "ghost". Then clears all
  // prefs incl. the trash mark, drops from the map, emits removal. NOT wired to any
  // UI button — only the cockpit MCP (maintainer session) reaches this.
  async purgeSession(sessionId: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (this.hasActiveMcpToggle(sessionId) || this.mcpReloadingSessions.has(sessionId)) {
      throw new Error('MCP operation is still in progress; wait for it to settle before purging this session');
    }
    try { st?.unsub?.(); } catch { /* ignore */ }
    try { await this.manager.deleteSession(sessionId); } catch { /* may already be gone */ }
    // Cascade-clean the SDK-owned session-store.db now that the SDK has released the
    // session (its rows are pure orphans). Best-effort: a store-cleanup failure must
    // not abort the purge or the prefs/map teardown below.
    try {
      const res = purgeSessionRows(sessionStorePath(), sessionId);
      if (res.total > 0) this.log('purged session-store rows', { sessionId, ...res.deleted });
    } catch (err) {
      this.log('purgeSessionRows failed', { sessionId, err: String(err) });
    }
    this.sessions.delete(sessionId);
    this.previews.delete(sessionId);
    this.sessionErrorFiredAt.delete(sessionId);
    this.forgetMcpOperations(sessionId);
    this.mcpReloadPendingSessions.delete(sessionId);
    this.prefs.forgetSession(sessionId);
    this.emit({ type: 'session/removed', sessionId });
  }

  respondAsk(sessionId: string, requestId: string, answer: string, wasFreeform: boolean): void {
    const st = this.sessions.get(sessionId);
    if (!st?.sdk) return;
    try { st.sdk.respondToUserInput(requestId, { answer, wasFreeform }); } catch { /* ignore */ }
    if (st.meta.ask?.requestId === requestId) this.patch(st, { ask: null });
  }

  respondPlan(sessionId: string, requestId: string, action: ExitPlanModeAction): void {
    const st = this.sessions.get(sessionId);
    if (!st?.sdk) return;
    // All offered actions approve exiting plan mode; `selectedAction` decides what
    // happens next: exit_only just exits, interactive/autopilot continue in that
    // mode, autopilot_fleet additionally spins up parallel sub-agents (SDK-side).
    try { st.sdk.respondToExitPlanMode?.(requestId, { approved: true, selectedAction: action }); } catch { /* ignore */ }
    if (st.meta.planRequest?.requestId === requestId) this.patch(st, { planRequest: null });
  }

  // The user typed a message while a plan was pending: their choice is that this
  // is a NEW instruction, not plan feedback. Dismiss the proposed plan without
  // executing it (exit_only), leave plan mode, then run the message as a fresh
  // direct instruction so the agent just does it instead of re-planning.
  async planSupersede(sessionId: string, requestId: string, message: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st?.sdk) return;
    try { st.sdk.respondToExitPlanMode?.(requestId, { approved: true, selectedAction: 'exit_only' }); } catch { /* ignore */ }
    if (st.meta.planRequest?.requestId === requestId) this.patch(st, { planRequest: null });
    // Leave plan mode so the message is executed, not planned again.
    const wasPlan = st.meta.currentMode === 'plan';
    if (wasPlan) {
      try { await this.setMode(sessionId, 'interactive'); } catch { /* ignore */ }
    }
    // Run the message (enqueue so it follows the dismissed turn's wind-down). Mark
    // the session to restore plan mode once this one-off instruction's turn ends.
    try { await this.prompt(sessionId, message); } catch { /* ignore */ }
    if (wasPlan) st.restorePlanOnIdle = true;
  }

  respondElicitation(sessionId: string, requestId: string, action: 'accept' | 'decline' | 'cancel'): void {
    const st = this.sessions.get(sessionId);
    if (!st?.sdk) return;
    try { st.sdk.respondToElicitation?.(requestId, { action }); } catch { /* ignore */ }
    if (st.meta.elicitation?.requestId === requestId) this.patch(st, { elicitation: null });
  }

  // Remove a queued (not-yet-processed) message by its position id ("q-<n>").
  // The SDK queue holds plain strings with no stable ids, so we rebuild it:
  // read survivors, clear, re-enqueue in order. Best-effort.
  // Remove ONE queued item, identified by a content-tagged id (lifecycle.makeQueueId).
  // Fail-closed: if the target can't be confidently located, or the surviving queue
  // can't be faithfully rebuilt, this is a no-op rather than a wrong-item deletion.
  //
  // The SDK exposes no public middle-removal primitive (only LIFO
  // removeMostRecentPendingItem + clear-all), so an interior removal must clear the
  // whole queue and re-enqueue the survivors. We can only faithfully rebuild MESSAGE
  // items (enqueueItem with a prompt) — a surviving command/model-change item would
  // be lost — so we refuse when a non-message survivor exists (documented limited item).
  removeQueued(sessionId: string, itemId: string): void {
    const st = this.sessions.get(sessionId);
    if (!st?.sdk) return;
    const parsed = parseQueueId(itemId);
    if (!parsed) return;                                  // unrecognized id → fail closed
    const items = this.readQueueItems(st);
    if (items.length === 0) return;
    // Locate the target. Fast-path the embedded index when its content tag still
    // matches (no re-index since the id was minted); otherwise relocate by tag.
    let target = -1;
    const at = items[parsed.index];
    if (at && parsed.index >= 0 && parsed.index < items.length
      && (parsed.tag === '' || queueTextTag(at.text) === parsed.tag)) {
      target = parsed.index;
    } else if (parsed.tag !== '') {
      target = items.findIndex((it) => queueTextTag(it.text) === parsed.tag);
    }
    if (target < 0) return;                               // can't confidently identify → fail closed
    const survivors = items.filter((_, i) => i !== target);
    if (survivors.some((it) => it.kind !== 'message')) return; // can't faithfully rebuild → fail closed
    // Prefer the faithful raw prompt strings (deprecated reader) over the display
    // text when they line up 1:1 with the items; fall back to display text otherwise.
    let texts = survivors.map((it) => it.text);
    try {
      const raw = (st.sdk as unknown as { getPendingQueuedMessages?(): unknown[] }).getPendingQueuedMessages?.();
      if (Array.isArray(raw) && raw.length === items.length) {
        texts = raw.filter((_, i) => i !== target).map((x) => String(x));
      }
    } catch { /* keep display-text fallback */ }
    // Mutate: confirm BOTH primitives exist before clearing (so we never clear
    // without being able to re-enqueue), then clear + rebuild survivors in order.
    const canEnqueue = typeof (st.sdk as unknown as { enqueueItem?: unknown; enqueueUserMessage?: unknown }).enqueueItem === 'function'
      || typeof (st.sdk as unknown as { enqueueUserMessage?: unknown }).enqueueUserMessage === 'function';
    if (!canEnqueue) return;                              // no rebuild primitive → fail closed
    if (!this.clearQueue(st)) return;                     // no clear primitive → fail closed (queue untouched)
    for (const text of texts) this.enqueueMessage(st, text);
    this.syncQueue(st);
  }

  // Open / paginate a session's message window. Lazy-loads, then slices our
  // in-memory full history and emits a history-page.
  async history(sessionId: string, beforeMsgId?: string, limit = HISTORY_PAGE, afterMsgId?: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) throw new Error('unknown session');
    await this.ensureLoaded(st);
    const all = st.fold.messages;
    // Reconnect resume: the client already has a contiguous window ending at
    // `afterMsgId` (its newest message) and wants only what arrived during the
    // disconnect. The cursor is a DURABLE message id (re-folding the same
    // events.jsonl is deterministic), so this works even across a server restart.
    if (afterMsgId) {
      const i = all.findIndex((m) => m.id === afterMsgId);
      // Reset (replace the client's whole window with the latest page) when either:
      //  (a) the anchor is GONE — history changed structurally while disconnected
      //      (compact/rewind/truncate), so the client's scrollback is stale; or
      //  (b) the client fell TOO FAR behind — the catch-up tail is larger than a
      //      full window. Shipping the whole gap as an append would push an
      //      unbounded burst (hundreds of messages after a long disconnect) and
      //      bloat the DOM, while the far-back scrollback it holds is stale anyway.
      //      A reset costs the same as a cold open and the user paginates back on
      //      demand. Threshold = one window (HISTORY_PAGE): beyond a page behind,
      //      the latest window is already cheaper to send than the gap.
      if (i < 0 || all.length - 1 - i > HISTORY_PAGE) {
        this.emit({ type: 'session/reset', page: { sessionId, messages: this.windowOf(st), hasMore: all.length > HISTORY_PAGE, latest: true } });
        return;
      }
      // Small gap: from the anchor INCLUSIVE — re-send the anchor too in case it was
      // a streaming message that grew mid-turn; the client upsert-merges by id. This
      // preserves the paginated scrollback + scroll position across a brief blip.
      this.emit({ type: 'session/history-page', page: { sessionId, messages: all.slice(i), hasMore: false, append: true } });
      return;
    }
    let endIdx = all.length;
    if (beforeMsgId) {
      const i = all.findIndex((m) => m.id === beforeMsgId);
      if (i >= 0) endIdx = i;
    }
    const startIdx = Math.max(0, endIdx - limit);
    const page = all.slice(startIdx, endIdx);
    this.emit({
      type: 'session/history-page',
      page: { sessionId, messages: page, hasMore: startIdx > 0, latest: !beforeMsgId },
    });
  }

  // Read-only, paginated preview of a session — TRASHED or LIVE alike (a flow
  // worker shown on the 自动会话 page uses this too). For a session already loaded
  // in memory we read straight from its live fold (no second SDK handle); otherwise
  // we fold the on-disk events into a transient `previews` entry (NOT the live
  // `sessions` map) so it can be browsed without being made active, never appears in
  // the sidebar, and supports the SAME lazy pagination as `history()`. Capped LRU.
  private static readonly PREVIEW_CAP = 3;
  async peekSession(sessionId: string, beforeMsgId?: string, limit = HISTORY_PAGE): Promise<{ sessionId: string; title: string; cwd: string; messages: ChatMessage[]; hasMore: boolean }> {
    // Fast path: a loaded session is already folded in memory — read it directly so
    // we never open a competing SDK handle for a live session.
    const live = this.sessions.get(sessionId);
    if (live?.materialized) {
      const all = live.fold.messages;
      let endIdx = all.length;
      if (beforeMsgId) { const i = all.findIndex((m) => m.id === beforeMsgId); if (i >= 0) endIdx = i; }
      const startIdx = Math.max(0, endIdx - limit);
      return { sessionId, title: live.meta.title, cwd: live.meta.cwd, messages: all.slice(startIdx, endIdx), hasMore: startIdx > 0 };
    }
    let p = this.previews.get(sessionId);
    if (!p) {
      let cwd = HOME;
      let title = sessionId.slice(0, 8);
      try {
        const metas = await this.manager.listSessions();
        const m = metas.find((x) => x.sessionId === sessionId);
        if (m) { const meta = metaFromSdk(m).meta; cwd = meta.cwd || cwd; title = meta.title || title; }
      } catch { /* fall back to ids */ }
      // Resume from disk with streaming off and NO mcp servers — a pure read. We
      // never call attach(), so there are no live taps to clean up.
      const sdkSession = await this.manager.getSession(
        { sessionId, workingDirectory: cwd, authInfo: this.authInfo, featureFlagService: this.ffs, enableStreaming: false, permissionRequestHandler: APPROVE_ALL_PERMISSIONS, mcpServers: {}, disabledMcpServers: [] },
        true,
      );
      if (!sdkSession) throw new Error('session not found');
      const fold = newFoldState();
      for (const ev of sdkSession.getEvents()) foldEvent(fold, ev as unknown as SdkEvent);
      p = { fold, title, cwd };
      this.previews.set(sessionId, p);
      while (this.previews.size > Engine.PREVIEW_CAP) {
        const oldest = this.previews.keys().next().value;
        if (oldest === undefined || oldest === sessionId) break;
        this.previews.delete(oldest);
      }
    }
    const all = p.fold.messages;
    let endIdx = all.length;
    if (beforeMsgId) { const i = all.findIndex((m) => m.id === beforeMsgId); if (i >= 0) endIdx = i; }
    const startIdx = Math.max(0, endIdx - limit);
    return { sessionId, title: p.title, cwd: p.cwd, messages: all.slice(startIdx, endIdx), hasMore: startIdx > 0 };
  }

  // --- internal -------------------------------------------------------------

  private patch(st: SessionState, fields: Partial<SessionMeta>, opts: { silent?: boolean } = {}): void {
    // Capture the pre-patch inputs to derive the authoritative `attention` state
    // (the single source of truth both notification channels + the sidebar badge
    // consume — never re-derived on the client).
    const prevStatus = st.meta.status;
    const prevChoice = hasPendingChoice(st.meta);
    const prevAttention = st.meta.attention ?? null;
    Object.assign(st.meta, fields);
    // Workers (flow-spawned, R1 spawnedBy) are fire-and-forget background automation
    // — they live outside the main list and must NEVER demand the user's attention:
    // no 'ready'/'choice' badge, no Notification, no Web Push. Treat every worker
    // transition as silent so all three attention consumers stay quiet for them.
    const isWorker = st.meta.spawnedBy != null;
    const att = nextAttention(
      { status: prevStatus, choicePending: prevChoice, attention: prevAttention },
      { status: st.meta.status, choicePending: hasPendingChoice(st.meta), silent: opts.silent || isWorker },
    );
    // Forward exactly the changed fields. Spreading `fields` (a Partial<SessionMeta>)
    // preserves the key invariant: only what was explicitly set is sent — e.g.
    // `lastActivity` is forwarded ONLY when a patch sets it, so operational patches
    // (status/load/unload/reload) never reorder the list. `sessionId` last so it
    // can't be overridden. No per-field list to keep in sync (was a known bug source).
    const out: Partial<SessionMeta> = { ...fields };
    // Belt-and-suspenders for the emit-null discipline (item D): for the nullable
    // clearable fields, an explicit `undefined` in a patch would be dropped by
    // JSON.stringify and never CLEAR on the client (leaving a stale effort/mode
    // badge). Normalize undefined→null for exactly these fields when the caller
    // included the key. currentModelId/availableModels are NOT here — they are
    // pure-optional and the snapshot schema rejects an explicit null for them.
    for (const k of CLEARABLE_META_FIELDS) {
      if (k in out && out[k] === undefined) (out as Record<string, unknown>)[k] = null;
    }
    if (att !== prevAttention) {
      st.meta.attention = att;
      out.attention = att; // include the change so the projection (badge) stays in sync
      // A fresh raise (null/other → ready|choice) gets a new monotonic id and is
      // unseen by definition (we do NOT advance seenId here). This id is what the
      // per-user `seenId` later catches up to. Escalation ready→choice also counts
      // as a fresh raise, so it re-alerts even if the ready had been seen.
      if (att !== null) {
        st.meta.attnId = ++this.attnSeq;
        out.attnId = st.meta.attnId;
      }
    }
    this.emit({ type: 'session/patch', ...out, sessionId: st.meta.sessionId });
    // Newly raised attention → emit the one-shot notify signal (both channels
    // consume it; neither does edge detection). Re-arming the same kind doesn't
    // re-fire; a reconnect/snapshot carries the state field but no notify event.
    if (att !== prevAttention && att !== null) {
      this.emit({
        type: 'session/notify',
        sessionId: st.meta.sessionId,
        title: st.meta.title,
        attention: att,
        body: attentionBody(st.meta, att),
      });
    }
  }
}

// Whether a session is blocked on a user decision (drives `attention: 'choice'`).
function hasPendingChoice(meta: SessionMeta): boolean {
  return !!(meta.ask || meta.planRequest || meta.elicitation);
}

// The notification body for a newly-raised attention: the actual prompt text for a
// choice (so the alert is actionable), a fixed line for ready.
function attentionBody(meta: SessionMeta, att: Attention): string {
  if (att === 'choice') {
    return meta.ask?.question || meta.planRequest?.summary || meta.elicitation?.message || '需要你的选择';
  }
  return '已回复，等待你的输入';
}
