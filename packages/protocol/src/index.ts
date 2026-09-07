// @cockpit/protocol — the SINGLE shared truth for the wire.
// zod schemas + inferred types for: the domain model, the server→client SSE
// event union, and the client→server POST intents. Both ends import these and
// validate against them, so the frontend and backend can never drift.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared schema helpers (boundary invariants encoded ONCE, in the contract)
// ---------------------------------------------------------------------------

// "Exactly one of these keys is set." Used by .superRefine() on the intent
// bodies that document a mutual-exclusion invariant (schedule/hook/flow-schedule),
// so the shared gate — not hand-written engine dispatch — rejects none/several.
const exactlyOne = (obj: Record<string, unknown>, keys: string[]): boolean =>
  keys.filter((k) => obj[k] !== undefined).length === 1;

// A safe filesystem basename (mirrors engine-side flows.ts isSafeBasename):
// must start alphanumeric, contain only [A-Za-z0-9._-], and never include a
// ".." traversal token (the regex alone accepts "a..b", so the refine is
// essential). Defense-in-depth for ids/names that become paths under ~/.copilot.
const SafeBasename = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a safe basename (no separators/leading dot)')
  .refine((s) => !s.includes('..'), 'must not contain ".."');

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export const SessionStatus = z.enum(['unloaded', 'idle', 'running', 'error']);
export type SessionStatus = z.infer<typeof SessionStatus>;
export const SessionLaunchState = z.enum(['launching', 'launch_failed']);
export type SessionLaunchState = z.infer<typeof SessionLaunchState>;

// Process/engine readiness (in-process SDK: 'up' once auth is loaded).
export const AgentStatus = z.enum(['starting', 'up', 'restarting']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ContextTier = z.enum(['default', 'long_context']);
export type ContextTier = z.infer<typeof ContextTier>;

export const ModelOption = z.object({
  modelId: z.string(),
  name: z.string(),
  // Reasoning-effort metadata (when the model supports it). Empty/absent =
  // the model has no selectable effort and the UI hides the effort control.
  supportedReasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
  // True when the model exposes a long_context price tier (CONTEXT_TIER_LEVELS).
  // Absent/false = the model has only the default context; UI hides the control.
  supportsLongContext: z.boolean().optional(),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const ToolCall = z.object({
  toolCallId: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
  // CLI-style uniform display: `title` is the agent's intent; `name` is the raw
  // tool (bash/edit/view…) shown as a small badge; `args` + `output` are the
  // collapsible detail (formatted + capped). Detail is shown only when present.
  name: z.string().optional(),
  args: z.string().optional(),
  output: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ChatRole = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof ChatRole>;

// A sub-agent (spawned via the `task` tool) surfaced as one collapsible card.
// Its full internal work (tools + reasoning + messages) lives in the owning
// message's `subMessages`, folded by the SAME fold on a nested state.
export const SubagentInfo = z.object({
  name: z.string(),          // internal agent_type (general-purpose/explore/…)
  displayName: z.string(),   // human-readable
  description: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed']),
  toolCount: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string().optional(), // what the sub-agent was asked to do
});
export type SubagentInfo = z.infer<typeof SubagentInfo>;

// A user-uploaded file/image attached to a message. The file lives in the fixed
// upload folder; `url` serves it to the browser, the agent gets the absolute path
// in the message's guidance text.
export const Attachment = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string(),
  url: z.string(),
  size: z.number().optional(),
  mime: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

// ChatMessage is recursive: a sub-agent card holds its inner conversation in
// `subMessages` (each itself a ChatMessage, possibly with its own sub-agents).
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thought?: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  // 'ask-reply' = the user's answer to an ask_user tool; 'subagent' = a sub-agent
  // card; 'skill' = a compact skill-activation pill.
  subtype?: 'ask-reply' | 'subagent' | 'skill';
  // Severity for system messages (runtime errors/warnings folded into the thread).
  level?: 'info' | 'warning' | 'error';
  subagent?: SubagentInfo;
  subMessages?: ChatMessage[];
  attachment?: Attachment;
}
export const ChatMessage: z.ZodType<ChatMessage> = z.lazy(() => z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  thought: z.string().optional(),
  timestamp: z.number(),
  toolCalls: z.array(ToolCall).optional(),
  subtype: z.enum(['ask-reply', 'subagent', 'skill']).optional(),
  level: z.enum(['info', 'warning', 'error']).optional(),
  subagent: SubagentInfo.optional(),
  subMessages: z.array(ChatMessage).optional(),
  attachment: Attachment.optional(),
}));

// A message the user queued while a turn was running (CLI-style queue).
export const QueuedItem = z.object({
  id: z.string(),
  text: z.string(),
});
export type QueuedItem = z.infer<typeof QueuedItem>;

// A single agent TODO (from session.plan.readSqlTodos — the full per-item list).
export const TodoItem = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
});
export type TodoItem = z.infer<typeof TodoItem>;

// A repo file the agent created/edited this session (from edit/create tool calls).
export const ChangedFile = z.object({
  path: z.string(),
  operation: z.enum(['create', 'edit']),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

// Full session plan payload (on-demand, for the info panel): the plan.md
// markdown narrative + the complete TODO checklist + changed files.
export const SessionPlan = z.object({
  planMarkdown: z.string().nullable(),
  todos: z.array(TodoItem),
  changedFiles: z.array(ChangedFile).optional(),
});
export type SessionPlan = z.infer<typeof SessionPlan>;

// Read-mostly info-panel sections (mcp/skills/tasks/instructions/schedule). The
// SDK returns differently-shaped lists; the engine normalizes each item to this
// uniform row so the frontend renders them identically and robustly.
export const PanelItem = z.object({
  label: z.string(),
  sublabel: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type PanelItem = z.infer<typeof PanelItem>;

export const SessionPanels = z.object({
  skills: z.array(PanelItem),
  mcpServers: z.array(PanelItem),
  tasks: z.array(PanelItem),
  instructionSources: z.array(PanelItem),
  schedules: z.array(PanelItem),
});
export type SessionPanels = z.infer<typeof SessionPanels>;

// ── Scheduled prompts (the SDK's `/every` recurring + `/after` one-shot) ──────
// Exactly one of intervalMs / cron / at is set, mirroring the SDK's ScheduleEntry.
export const ScheduleEntry = z.object({
  id: z.number(),                    // sequential within the session, stable across resume
  prompt: z.string(),                // the text enqueued on every tick
  recurring: z.boolean(),            // true = re-arms (/every); false = one-shot (/after)
  nextRunAt: z.number(),             // epoch ms of the next fire
  intervalMs: z.number().optional(), // set for relative-interval schedules
  cron: z.string().optional(),       // set for calendar (cron) schedules
  tz: z.string().optional(),         // IANA tz the cron is evaluated in
  at: z.number().optional(),         // set for one-shot absolute-time schedules
  displayPrompt: z.string().optional(), // user-facing label when prompt is a slash-command expansion
});
export type ScheduleEntry = z.infer<typeof ScheduleEntry>;

// ── Event hooks (Butler / Flow trigger layer) ────────────────────────────────
// A hook is schedule's sibling: schedule fires on TIME, a hook fires on an
// ECOSYSTEM EVENT. It says "when event E happens (possibly in another session),
// deliver a prompt into the owner (butler) session, carrying the event's
// context". The registry is engine-global (cross-session) — one session reacts
// to the whole fleet. Two events exist:
//   - session.first-turn-complete — a REAL session finished its first turn (the
//     welcome trigger). Source-keyed: the ctx carries the source session.
//   - session.error — a REAL session's turn ended in error (the triage trigger:
//     autopilot crashed, a tool chain failed). Source-keyed; the ctx's `summary`
//     carries the error message. R1 holds (a spawned worker's error never fires —
//     a bad worker would otherwise trigger triage endlessly), and the engine rate-
//     limits per source so a flapping session can't storm the bus.
//   - session.trashed — a session was moved to the trash bin (soft-delete,
//     REVERSIBLE — NOT purge). Source-keyed: the ctx carries the trashed session.
//     UNLIKE the R1-guarded first-turn/error events, this fires for EVERY trashed
//     session including spawned workers — a finished worker's transcript is itself a
//     prime salvage target, and the consumer (the harvest pipeline) collapses a
//     burst via its gate's single-flight + candidate dedup, so no R1 suppression is
//     needed here. It lets harvest salvage a corpse the instant it's trashed instead
//     of waiting for the cold-scan cron.
//   - engine.boot-complete — the engine finished starting (a fresh boot or a
//     restart). GLOBAL (source-less): the ctx's sessionId/cwd/title are empty.
//     It lets a session re-drive itself precisely when the server comes back —
//     e.g. a daemon verifying its own deploy restart — without polling.
export const SessionEventType = z.enum(['session.first-turn-complete', 'session.error', 'session.trashed', 'engine.boot-complete']);
export type SessionEventType = z.infer<typeof SessionEventType>;

// The context delivered with an event (and interpolated into a prompt template).
// For a global event (engine.boot-complete) the source fields are empty strings.
export const SessionEventCtx = z.object({
  event: SessionEventType,
  sessionId: z.string(),   // the SOURCE session the event happened on ('' for global events)
  cwd: z.string(),
  title: z.string(),
  // Event-specific detail. For session.error this is the error message/summary;
  // empty/absent for events that carry no detail (first-turn-complete, boot).
  summary: z.string().optional(),
});
export type SessionEventCtx = z.infer<typeof SessionEventCtx>;

// Optional narrowing of which source events a hook reacts to.
export const HookFilter = z.object({
  cwdPrefix: z.string().optional(),   // source cwd must start with this
  sessionId: z.string().optional(),   // only this exact source session
  excludeSelf: z.boolean().optional(),// ignore events whose source IS the owner
});
export type HookFilter = z.infer<typeof HookFilter>;

export const HookEntry = z.object({
  id: z.string(),                      // stable id (used to stop)
  ownerSession: z.string().min(1),     // session that RECEIVES the delivery (the butler); never '' (a '' owner would self-drop a boot hook)
  event: SessionEventType,             // which event it subscribes to
  filter: HookFilter.optional(),
  // Action (revised per design §2.10): a hook points at a Flow (Phase B). Until
  // the Flow layer lands, Phase A supports a minimal `promptTemplate` action:
  // interpolate the event context and enqueue it into ownerSession.
  flowId: z.string().optional(),
  promptTemplate: z.string().optional(),
  // `once` is only operative for the GLOBAL event (engine.boot-complete): fire on
  // the next boot then auto-remove. For the source-keyed session.first-turn-complete
  // dedup is the persisted welcomed-bit (markWelcomed/isWelcomed), so `once` is
  // effectively a no-op there (the bit, not this flag, enforces once-per-source).
  once: z.boolean().optional(),
  createdAt: z.number(),
});
export type HookEntry = z.infer<typeof HookEntry>;

// ── Flows (TRIGGER → FLOW → ACTION, design §2.10) ────────────────────────────
// A Flow is the reusable middle layer between a trigger (hook/schedule) and its
// effect: an optional cheap gate script (deterministic, no LLM — the cost gate)
// plus an action. The same Flow can be driven by a hook OR a schedule. Flow
// definitions live in ~/.copilot/flows/*.json (git-trackable, owner-authored).
// mode is inlined here (== AgentMode, declared later) to avoid a TDZ forward-ref.
export const GateSpec = z.object({
  // Path to a LOCAL, owner-authored script run as a subprocess BEFORE the action.
  // Contract: receives the event context (env COCKPIT_EVENT + stdin JSON); exit 0
  // = go, non-zero = skip; stdout JSON (optional) = params merged into downstream
  // interpolation. Security: owner-local scripts only, never third-party/downloaded.
  script: z.string(),
  timeoutMs: z.number().optional(),   // gate kill deadline (default 30s); a hang = skip (fail-safe)
});
export type GateSpec = z.infer<typeof GateSpec>;

// The blueprint for a born-configured spawned session. String fields may contain
// {event.*} / gate-param tokens, interpolated at spawn time.
export const SessionTemplate = z.object({
  cwd: z.string(),
  prompt: z.string(),
  // The worker session's display title. Supports {event.*} / {gate.*} tokens.
  // Set on the SDK so it sticks (user-named — not re-derived from the prompt);
  // omitted → falls back to the cwd basename.
  title: z.string().optional(),
  skills: z.array(z.string()).optional(),  // the ONLY skills kept enabled (all others disabled — tight match)
  mcps: z.array(z.string()).optional(),    // the MCP servers enabled at birth
  model: z.string().optional(),
  mode: z.enum(['interactive', 'plan', 'autopilot']).optional(),
});
export type SessionTemplate = z.infer<typeof SessionTemplate>;

export const FlowAction = z.discriminatedUnion('kind', [
  // Spawn a fresh, born-configured session (a worker). It is marked spawnedBy=flowId
  // (R1 non-trigger-source + UI folding). Per decision F7 the worker is KEPT (not
  // auto-deleted) — folded in the UI, not trashed.
  z.object({ kind: z.literal('spawn-session'), template: SessionTemplate }),
  // Deliver a prompt into an existing session (the pre-Flow behavior).
  z.object({ kind: z.literal('prompt-existing'), sessionId: z.string(), prompt: z.string() }),
]);
export type FlowAction = z.infer<typeof FlowAction>;

export const Flow = z.object({
  id: SafeBasename,
  name: z.string().optional(),
  gate: GateSpec.optional(),
  action: FlowAction,
});
export type Flow = z.infer<typeof Flow>;

// An inline action a flow-schedule can fire WITHOUT a flow definition file: deliver
// a prompt into an existing session on each tick. This is how the old per-session
// schedule's high-frequency usage ("fire this prompt into this session on a timer")
// is expressed in the unified system — no flow JSON, no keep-loaded pin (the engine
// ensureLoads the target session on fire, waking it if unloaded).
export const InlineScheduleTarget = z.object({
  kind: z.literal('prompt-existing'),
  sessionId: z.string(),
  prompt: z.string(),
  displayPrompt: z.string().optional(), // user-facing label when prompt is a slash-command expansion
});
export type InlineScheduleTarget = z.infer<typeof InlineScheduleTarget>;

// A server-level scheduled trigger. It runs in the always-on cockpit-server and
// fires even with zero sessions loaded. Timing kinds: interval | cron | at. On
// each tick it either runs a FLOW (flowId) or delivers an inline prompt-existing
// target — exactly one of `flowId` / `target` is set.
export const FlowScheduleEntry = z.object({
  id: z.number(),                    // sequential, stable across restart
  flowId: z.string().optional(),     // the flow to run on each tick (one-of with target)
  target: InlineScheduleTarget.optional(), // inline prompt-existing action (one-of with flowId)
  recurring: z.boolean(),            // true = re-arms (interval/cron); false = one-shot (at)
  nextRunAt: z.number(),             // epoch ms of the next fire
  intervalMs: z.number().optional(), // relative-interval schedules
  cron: z.string().optional(),       // 5-field cron schedules
  tz: z.string().optional(),         // IANA tz the cron is evaluated in
  at: z.number().optional(),         // one-shot absolute-time schedules
  label: z.string().optional(),      // optional human label
});
export type FlowScheduleEntry = z.infer<typeof FlowScheduleEntry>;

// ── Directory listing (the new-session folder picker) ────────────────────────
export const DirEntry = z.object({
  name: z.string(),
  isDir: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntry>;

export const DirListing = z.object({
  path: z.string(),                 // the absolute, normalized directory listed
  parent: z.string().nullable(),    // its parent (null at filesystem root)
  entries: z.array(DirEntry),       // sorted: dirs first, then files, name asc
});
export type DirListing = z.infer<typeof DirListing>;

// ── Trash (soft-deleted sessions) ────────────────────────────────────────────
// A trashed session retains its data on disk + is hidden from the main list, but
// can be restored. Permanent purge is a separate, non-UI step (cockpit MCP).
export const TrashEntry = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  at: z.string(),               // ISO8601 — when it was trashed
  reason: z.string().optional(),
});
export type TrashEntry = z.infer<typeof TrashEntry>;

// ── MCP + Skills management (dedicated pages, not the info panel) ─────────────
// Global MCP server (from ~/.copilot/mcp-config.json) + its default-on flag for
// new sessions.
export const McpServerGlobal = z.object({
  name: z.string(),
  detail: z.string(),       // command / url summary
  defaultOn: z.boolean(),
  // Full (redacted) config for the detail pane — env/header VALUES are masked to
  // their keys so secrets never reach the client.
  config: z.record(z.unknown()).optional(),
});
export type McpServerGlobal = z.infer<typeof McpServerGlobal>;

// One session's view of an MCP server. `unloaded` means the owning session has no
// live SDK handle, so the read intentionally returned persisted enablement without
// materializing it merely to discover connection state.
export const McpServerStatus = z.enum([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
  'not_configured',
  'unloaded',
]);
export type McpServerStatus = z.infer<typeof McpServerStatus>;

export const McpToggleOperationState = z.enum([
  'running',
  'cancelling',
  'settling',
  'succeeded',
  'failed',
]);
export type McpToggleOperationState = z.infer<typeof McpToggleOperationState>;

export const McpToggleOperation = z.object({
  id: z.string(),
  desiredEnabled: z.boolean(),
  state: McpToggleOperationState,
  startedAt: z.number(),
  completedAt: z.number().optional(),
  status: McpServerStatus,
  error: z.string().optional(),
});
export type McpToggleOperation = z.infer<typeof McpToggleOperation>;

export const McpServerSession = z.object({
  name: z.string(),
  detail: z.string(),
  status: McpServerStatus,
  enabled: z.boolean(),
  error: z.string().optional(),
  operation: McpToggleOperation.optional(),
});
export type McpServerSession = z.infer<typeof McpServerSession>;

export const McpToggleResult = z.object({
  ok: z.boolean(),
  applied: z.boolean(),
  sessionId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  status: McpServerStatus,
  error: z.string().optional(),
  operation: McpToggleOperation,
});
export type McpToggleResult = z.infer<typeof McpToggleResult>;

export const SkillGlobal = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
  userInvocable: z.boolean().optional(),
});
export type SkillGlobal = z.infer<typeof SkillGlobal>;

export const SkillSession = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
  enabled: z.boolean(),
});
export type SkillSession = z.infer<typeof SkillSession>;



// A pending ask_user request surfaced by the model (structured questionnaire).
export const AskRequest = z.object({
  requestId: z.string(),
  question: z.string(),
  choices: z.array(z.string()).optional(),
  allowFreeform: z.boolean().optional(),
});
export type AskRequest = z.infer<typeof AskRequest>;

// Agent wants to exit plan mode and proceed (exit_plan_mode.requested). The user
// picks how to continue. Part of the unified pending-card above the composer.
// `actions` are the choices the SDK actually offered (a subset/order of the four
// below, incl. `autopilot_fleet`); the card renders one button per offered action
// rather than hardcoding a fixed set. `recommendedAction` is preselected/emphasized.
export const ExitPlanModeAction = z.enum(['exit_only', 'interactive', 'autopilot', 'autopilot_fleet']);
export type ExitPlanModeAction = z.infer<typeof ExitPlanModeAction>;
export const PlanRequest = z.object({
  requestId: z.string(),
  summary: z.string(),
  planContent: z.string().optional(),
  actions: z.array(ExitPlanModeAction).optional(),
  recommendedAction: ExitPlanModeAction.optional(),
});
export type PlanRequest = z.infer<typeof PlanRequest>;

// MCP/agent elicitation (elicitation.requested) — a request for input. v1 surfaces
// the message + accept/decline (no dynamic form rendering yet).
export const ElicitationRequest = z.object({
  requestId: z.string(),
  message: z.string(),
});
export type ElicitationRequest = z.infer<typeof ElicitationRequest>;

// Agent TODO progress (from the session DB: counts + current-intent title).
// SDK exposes only aggregates, not a per-item list. `null` = no todos.
export const TodoProgress = z.object({
  done: z.number(),
  total: z.number(),
  intent: z.string().nullable(),
});
export type TodoProgress = z.infer<typeof TodoProgress>;

// Agent interaction mode (CLI shift+tab cycles these).
export const AgentMode = z.enum(['interactive', 'plan', 'autopilot']);
export type AgentMode = z.infer<typeof AgentMode>;

// List-level metadata for a session (no message bodies).
// What user attention a session authoritatively needs RIGHT NOW — the single
// source of truth both notification channels (client Notification + server Web
// Push) and the sidebar badge consume. Derived by the Engine from session state,
// never by the client. The two kinds clear by DIFFERENT actions (this asymmetry
// is the heart of the design — an agent always has the last word, so "awaiting
// your reply" can't be a persistent todo):
//   'choice' — blocked mid-turn on a required decision (ask_user / plan confirm /
//              elicitation). The agent cannot proceed. SEEING it only demotes the
//              alert; it stays raised (and counted) until the user ANSWERS.
//   'ready'  — the agent finished its turn (idle) and the result is waiting. This
//              is an unread RESULT, not a debt: SEEING it (opening the session)
//              IS its completion, so it clears to null on sight.
//   null     — nothing needed (running, freshly prompted, seen-ready, or handled).
// 'choice' outranks 'ready' (a pending decision is the stronger signal). So the
// app-icon badge = count(attention != null) = (unseen readies) + (unanswered
// choices), and it can't degrade into "every session you ever talked to".
export const Attention = z.enum(['ready', 'choice']);
export type Attention = z.infer<typeof Attention>;

export const SessionMeta = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number().optional(),
  lastActivity: z.number(),
  status: SessionStatus,
  error: z.string().nullable(),
  // Spawn-only lifecycle: a flow worker exists before its first user turn is durably
  // accepted/persisted, or that first-turn launch failed. Distinguishes a real
  // launch problem from a completed idle worker without fabricating transcript text.
  launchState: SessionLaunchState.nullable().optional(),
  currentModelId: z.string().optional(),
  // Clearable: a non-reasoning model has no effort, so a patch must be able to
  // carry an explicit `null` to clear a stale value (engine emits null, not omit).
  currentReasoningEffort: z.string().nullable().optional(),
  // Clearable: a model without a long_context tier; patch carries null to clear.
  currentContextTier: ContextTier.nullable().optional(),
  // Clearable (edge): also nullable so the engine's blanket undefined→null
  // normalizer can never produce a null the schema rejects.
  currentMode: AgentMode.nullable().optional(),
  availableModels: z.array(ModelOption).optional(),
  loaded: z.boolean(),
  queue: z.array(QueuedItem),
  ask: AskRequest.nullable(),
  planRequest: PlanRequest.nullable().optional(),
  elicitation: ElicitationRequest.nullable().optional(),
  todo: TodoProgress.nullable().optional(),
  // The agent's current self-reported intent (the `report_intent` tool's `intent`
  // arg) — a short gerund line like "Investigating report_intent flow". Shown as
  // the live status line while a turn runs (instead of a generic "回复中…").
  // Ephemeral: set on each report_intent during the turn, cleared when the turn
  // ends (session.idle / cancel). Null when none has been reported this turn.
  intent: z.string().nullable().optional(),
  attention: Attention.nullable().optional(),
  // Monotonic id of the CURRENTLY-raised attention (server-assigned, increments on
  // each fresh raise; 0/absent = nothing raised). Pairs with `seenId` to drive the
  // cross-device "seen" state without any per-device client truth.
  attnId: z.number().optional(),
  // Highest `attnId` the user has SEEN (monotonic, per-user — synced across every
  // device via session/patch, never per-device). `seenId >= attnId` ⇒ the current
  // attention has been looked at: a 'ready' is then cleared to null by the Engine,
  // a 'choice' is rendered demoted (muted) but stays counted until answered. Being
  // server truth, it reconciles correctly on cold start / reconnect (no stale dot).
  seenId: z.number().optional(),
  // A pure UI mark: pin a session to sort it to the top of the list, synced across
  // devices. NOTE: pin no longer means keep-loaded — keep-loaded is now driven by
  // whether the session has an active per-session schedule (scheduleCount > 0).
  pinned: z.boolean().optional(),
  // Number of active scheduled prompts on this session (drives the list timer
  // badge). Re-derived from the SDK ScheduleRegistry on load + on
  // schedule_created/cancelled events; full details come from `schedule/list`.
  scheduleCount: z.number().optional(),
  // Number of event hooks owned BY this session (this session is the receiver of
  // their deliveries — the butler). Sibling of scheduleCount; drives the sidebar
  // hook badge + info-panel HookSection. Full details come from `hook/list`.
  hookCount: z.number().optional(),
  // R1 (anti-fork-bomb): set to the flowId when this session was SPAWNED by a
  // Flow (a worker). A spawnedBy session is a NON-TRIGGER-SOURCE — none of its
  // lifecycle events fire any hook/flow — so a welcome-worker can never trigger
  // another welcome. One mark, two uses: this guard + (Phase C) UI folding.
  // Persisted in cockpit-prefs.json so it survives reload/restart.
  spawnedBy: z.string().optional(),
  // Count of in-flight `task` sub-agent invocations (foreground OR background).
  // A background sub-agent outlives the turn that spawned it (status returns to
  // idle while it runs), so this is what lets the graceful-restart gate avoid
  // killing one. Tracked from the task tool's execution_start/complete events;
  // cleared on abort/unload. 0 (or absent) means none in flight.
  activeSubagents: z.number().optional(),
  // True while the SDK is compacting this session's history (CLI /compact OR
  // automatic mid-turn compaction). Distinct from the turn `status`: auto
  // compaction runs WHILE status is 'running'; manual compaction is not a turn
  // (status stays 'idle'). Drives the "正在压缩上下文…" indicator and gates the
  // restart so we don't kill a session mid-compaction. Set on
  // compaction_start, cleared on compaction_complete (and compact()'s finally).
  compacting: z.boolean().optional(),
  // A mutating per-session MCP operation is in flight. This blocks unload/reload
  // and graceful restart until the SDK work either settles or is explicitly
  // represented as a still-settling operation.
  activeMcpOperations: z.number().int().nonnegative().optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

// A compact, authoritative projection of a live (non-trashed) session, returned
// synchronously by the `session/list` intent. Used by the cockpit MCP so an agent
// can discover sessions (and pick one to rename / toggle MCP-skills on) without
// subscribing to the SSE snapshot stream.
export const SessionBrief = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  launchState: SessionLaunchState.nullable().optional(),
  loaded: z.boolean(),
  lastActivity: z.number(),
  currentModelId: z.string().optional(),
});
export type SessionBrief = z.infer<typeof SessionBrief>;

// ---------------------------------------------------------------------------
// Server → client events (delivered over a single SSE stream)
// ---------------------------------------------------------------------------

export const HistoryPage = z.object({
  sessionId: z.string(),
  messages: z.array(ChatMessage),
  hasMore: z.boolean(),
  latest: z.boolean().optional(),
  // Reconnect resume: these messages are a TAIL to upsert-merge into the client's
  // existing window (from the client's last-known message id onward), not a window
  // to replace. Preserves the paginated scrollback + scroll position across a
  // reconnect (the cursor is the durable message id, so it survives a server restart).
  append: z.boolean().optional(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

export const ServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    agentStatus: AgentStatus,
    models: z.array(ModelOption),
    vapidPublicKey: z.string().nullable().optional(),
    sessions: z.array(SessionMeta),
  }),
  z.object({ type: z.literal('agent/status'), status: AgentStatus }),
  z.object({ type: z.literal('session/added'), session: SessionMeta }),
  // A partial SessionMeta patch: every field optional (carry only what changed),
  // `sessionId` required as the key. Derived from SessionMeta so adding a field
  // there automatically makes it patchable — no parallel field list to maintain.
  SessionMeta.partial().required({ sessionId: true }).extend({ type: z.literal('session/patch') }),
  z.object({ type: z.literal('session/removed'), sessionId: z.string() }),
  z.object({ type: z.literal('session/history-page'), page: HistoryPage }),
  z.object({ type: z.literal('session/reset'), page: HistoryPage }),
  z.object({ type: z.literal('msg/upsert'), sessionId: z.string(), message: ChatMessage }),
  // Transient "fire a notification now" signal, emitted by the Engine (the single
  // authority) when a session's authoritative `attention` is newly raised. Both
  // notification channels — the client Notification and the server Web Push —
  // consume THIS one event; neither does its own edge detection. Not projection
  // state (the persistent state is the `attention` field on SessionMeta); this is
  // the one-shot trigger, carrying the prompt text to show.
  z.object({
    type: z.literal('session/notify'),
    sessionId: z.string(),
    title: z.string(),
    attention: Attention,
    body: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent['type'];

// ---------------------------------------------------------------------------
// Client → server intents (each is a POST; some return a typed result)
// ---------------------------------------------------------------------------

export const PushSubscriptionJson = z.object({
  endpoint: z.string().url().refine((u) => u.startsWith('https://'), 'endpoint must be https'),
  expirationTime: z.number().nullable().optional(),
  keys: z.record(z.string()).optional(),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJson>;

export const Intents = {
  'session/new': {
    // spawnedBy (optional): born-as-worker. A daemon/orchestrator spawning a child
    // it drives passes its own flow/worker label here so the child gets the SAME R1
    // mark a flow worker does — a non-trigger-source (its lifecycle fires no hook/flow)
    // AND folded into the sidebar worker group. Omitted ⇒ a normal top-level session.
    body: z.object({ cwd: z.string(), spawnedBy: z.string().optional() }),
    result: z.object({ sessionId: z.string() }),
  },
  'session/history': {
    body: z.object({ sessionId: z.string(), beforeMsgId: z.string().optional(), afterMsgId: z.string().optional(), limit: z.number().optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  // Read-only, paginated preview of a session — a TRASHED (unlisted) one OR a live
  // one (e.g. a flow worker on the 自动会话 page). A loaded session is read from its
  // in-memory fold; an unloaded/trashed one is folded from disk into a transient
  // cache that is NOT in the live session map — so it never leaks into the sidebar
  // and cannot be interacted with. Same slicing as session/history.
  'session/peek': {
    body: z.object({ sessionId: z.string(), beforeMsgId: z.string().optional(), limit: z.number().optional() }),
    result: z.object({
      sessionId: z.string(),
      title: z.string(),
      cwd: z.string(),
      messages: z.array(ChatMessage),
      hasMore: z.boolean(),
    }),
  },
  prompt: {
    body: z.object({ sessionId: z.string(), text: z.string(), mode: z.enum(['enqueue', 'immediate']).optional() }),
    result: z.object({ ok: z.boolean(), queued: z.boolean().optional() }),
  },
  cancel: {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  setModel: {
    body: z.object({
      sessionId: z.string(),
      modelId: z.string(),
      reasoningEffort: z.string().optional(),
      contextTier: ContextTier.optional(),
    }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/rename': {
    body: z.object({ sessionId: z.string(), name: z.string() }),
    result: z.object({ ok: z.boolean(), title: z.string().optional() }),
  },
  'session/compact': {
    body: z.object({ sessionId: z.string(), customInstructions: z.string().optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/rewind': {
    body: z.object({ sessionId: z.string(), toMsgId: z.string(), rollbackFiles: z.boolean().optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  setMode: {
    body: z.object({ sessionId: z.string(), mode: AgentMode }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/delete': {
    body: z.object({ sessionId: z.string(), reason: z.string().optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/unload': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/reload': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  // Pin a session (pinned=true) as a pure UI mark — sort it to the top of the list,
  // synced across devices — or release it. NOTE: pin no longer keeps the session
  // loaded; keep-loaded is driven by having an active per-session schedule.
  'session/pin': {
    body: z.object({ sessionId: z.string(), pinned: z.boolean() }),
    result: z.object({ ok: z.boolean(), pinned: z.boolean() }),
  },
  // Reclassify an EXISTING session as a worker (or change its worker label) by
  // setting its spawnedBy mark through the engine. This is the durable, atomic
  // backfill path: NEVER hand-edit cockpit-prefs.json while the engine is running —
  // the engine's in-memory snapshot clobbers the edit on its next save (a real
  // lost-write the review flagged). The mark folds the session into the sidebar
  // worker group and makes it an R1 non-trigger-source.
  'session/set-spawned-by': {
    body: z.object({ sessionId: z.string(), spawnedBy: z.string().min(1) }),
    result: z.object({ ok: z.boolean(), spawnedBy: z.string() }),
  },
  'session/plan': {
    body: z.object({ sessionId: z.string() }),
    result: SessionPlan,
  },
  'session/panels': {
    body: z.object({ sessionId: z.string() }),
    result: SessionPanels,
  },
  respondAsk: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), answer: z.string(), wasFreeform: z.boolean() }),
    result: z.object({ ok: z.boolean() }),
  },
  respondPlan: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), action: ExitPlanModeAction }),
    result: z.object({ ok: z.boolean() }),
  },
  // The user typed a message while a plan was pending — their chosen behavior is
  // that this is a NEW instruction: dismiss the plan, leave plan mode, run it.
  planSupersede: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), message: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  respondElicitation: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), action: z.enum(['accept', 'decline', 'cancel']) }),
    result: z.object({ ok: z.boolean() }),
  },
  'queue/remove': {
    body: z.object({ sessionId: z.string(), itemId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/refresh': {
    body: z.object({}),
    result: z.object({ ok: z.boolean() }),
  },
  // Synchronous authoritative list of live (non-trashed) sessions. Unlike
  // session/refresh (which only nudges the SSE snapshot), this returns the data
  // in the result so the cockpit MCP can read it over plain HTTP.
  'session/list': {
    body: z.object({}),
    result: z.object({ sessions: z.array(SessionBrief) }),
  },
  // The full authoritative SessionMeta for ONE live session — the same object the
  // SSE snapshot projects. Returns the operational ids a maintainer/agent needs to
  // act (queue itemId, ask/plan/elicitation requestId), the live model/mode/status,
  // todo + attention, etc. Returns meta:null if the id isn't a known live session.
  'session/get': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ meta: SessionMeta.nullable() }),
  },
  'push/subscribe': {
    body: z.object({ subscription: PushSubscriptionJson }),
    result: z.object({ ok: z.boolean() }),
  },
  // "I'm looking at this session now" — advances the per-user `seenId` to the
  // session's current `attnId` (monotonic). The Engine clears a 'ready' on sight
  // (seeing a finished result IS its completion) and demotes a 'choice' (which
  // stays raised until answered). Fired by the client on open / on the tab
  // regaining focus / when attention is raised on the already-active visible
  // session. Idempotent: re-firing with nothing new to see is a no-op.
  'inbox/seen': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  // Mint a short-lived (10-min) Azure Speech authorization token so the browser
  // can run continuous speech-to-text WITHOUT ever seeing the subscription key
  // (the key stays server-side). `enabled:false` means no Azure resource is
  // configured — the client then falls back to the Web Speech API where it works.
  'speech/token': {
    body: z.object({}),
    result: z.object({ enabled: z.boolean(), token: z.string().optional(), region: z.string().optional() }),
  },
  'mcp/global': {
    body: z.object({}),
    result: z.object({ servers: z.array(McpServerGlobal) }),
  },
  'mcp/global-default': {
    body: z.object({ name: z.string(), on: z.boolean() }),
    result: z.object({ ok: z.boolean() }),
  },
  'mcp/refresh': {
    body: z.object({}),
    result: z.object({ ok: z.boolean() }),
  },
  // Reconnect ONE session's MCP servers — for a stdio server this re-spawns its
  // process, so it's how an MCP server whose CODE changed gets reloaded without
  // restarting the whole backend (mcp/refresh does the same for every session).
  'mcp/reload-session': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean(), reconnected: z.number() }),
  },
  'mcp/session': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({
      loaded: z.boolean(),
      servers: z.array(McpServerSession),
    }),
  },
  'mcp/session-toggle': {
    body: z.object({ sessionId: z.string(), name: z.string(), on: z.boolean() }),
    result: McpToggleResult,
  },
  'skills/global': {
    body: z.object({}),
    result: z.object({ skills: z.array(SkillGlobal) }),
  },
  // Read one skill's full detail incl. the SKILL.md body (lazy — only when its
  // detail pane opens), so the list payload stays lean.
  'skills/read': {
    body: z.object({ name: z.string() }),
    result: z.object({
      name: z.string(),
      description: z.string().optional(),
      source: z.string().optional(),
      userInvocable: z.boolean().optional(),
      body: z.string().optional(),
    }),
  },
  'skills/session': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ skills: z.array(SkillSession) }),
  },
  'skills/session-toggle': {
    body: z.object({ sessionId: z.string(), name: z.string(), enabled: z.boolean() }),
    result: z.object({ ok: z.boolean() }),
  },
  // Re-scan the on-disk skills directory. The SDK caches the skill list at process
  // start in a module-level memo keyed only on directory PATHS (not contents), with
  // no public API to invalidate it — so a skill added/removed/edited on disk after
  // boot is invisible until the process restarts. This arms a graceful self-restart
  // (exits when all sessions are idle; systemd brings it back with a fresh scan).
  // willRestartWhenIdle is false only when nothing is running (it restarts at once).
  'skills/refresh': {
    body: z.object({}),
    result: z.object({ ok: z.boolean(), willRestartWhenIdle: z.boolean() }),
  },
  'fs/listDir': {
    body: z.object({ path: z.string().optional() }),
    result: DirListing,
  },
  // session/delete is a SOFT delete (move to trash). Keeps SDK data; hides from
  // the main list; restorable. The body gains an optional reason.
  'session/restore': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/trash-list': {
    body: z.object({}),
    result: z.object({ entries: z.array(TrashEntry) }),
  },
  // Permanent purge: real SDK delete. NOT exposed in the UI — only the cockpit MCP
  // (used by the maintainer session, after salvaging) calls this.
  'session/purge': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  // ── Scheduled prompts (the SDK's per-session ScheduleRegistry) ───────────────
  // Register a scheduled prompt on a session. Exactly one timing kind:
  //   - interval: a relative interval string ("30s", "5m", "1h", "1d") — /every-style
  //   - cron:     a 5-field cron expression, evaluated in `tz` (IANA, optional) — /every-style
  //   - at:       an absolute epoch-ms fire time — /after-style one-shot
  // `recurring` defaults to true for interval/cron and false for `at`. The prompt
  // fires into the session as a queued user message on each tick.
  'schedule/add': {
    body: z.object({
      sessionId: z.string(),
      prompt: z.string().min(1),
      interval: z.string().optional(),
      cron: z.string().optional(),
      at: z.number().optional(),
      recurring: z.boolean().optional(),
      tz: z.string().optional(),
      displayPrompt: z.string().optional(),
    }).superRefine((v, ctx) => {
      if (!exactlyOne(v, ['interval', 'cron', 'at']))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide exactly one of interval, cron, or at' });
    }),
    result: z.object({ ok: z.boolean(), entry: ScheduleEntry.optional(), error: z.string().optional() }),
  },
  'schedule/stop': {
    body: z.object({ sessionId: z.string(), id: z.number() }),
    result: z.object({ ok: z.boolean() }),
  },
  'schedule/list': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ entries: z.array(ScheduleEntry) }),
  },
  // ── Event hooks (Butler/Flow trigger layer — engine-global, cross-session) ───
  // A hook subscribes the owner (butler) session to a fleet-wide event. v1 event
  // = session.first-turn-complete. Phase A action = promptTemplate (interpolated
  // event context, enqueued into ownerSession); flowId is the Phase B target.
  'hook/add': {
    body: z.object({
      ownerSession: z.string().min(1),
      event: SessionEventType,
      filter: HookFilter.optional(),
      flowId: z.string().optional(),
      promptTemplate: z.string().optional(),
      once: z.boolean().optional(),
    }).superRefine((v, ctx) => {
      if (!exactlyOne(v, ['flowId', 'promptTemplate']))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a hook needs exactly one of flowId or promptTemplate' });
    }),
    result: z.object({ ok: z.boolean(), entry: HookEntry.optional(), error: z.string().optional() }),
  },
  'hook/stop': {
    body: z.object({ id: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  // List all hooks (engine-global), optionally narrowed to one owner session.
  'hook/list': {
    body: z.object({ ownerSession: z.string().optional() }),
    result: z.object({ entries: z.array(HookEntry) }),
  },
  // ── Flows (TRIGGER → FLOW → ACTION) ──────────────────────────────────────────
  // Flow definitions are loaded from ~/.copilot/flows/*.json. flow/run manually
  // triggers a flow (run its gate, then its action) — useful for the human to
  // summon/debug a flow; ctx is the optional event context for interpolation.
  'flow/list': {
    body: z.object({}),
    result: z.object({ flows: z.array(Flow) }),
  },
  // Author a flow definition (write ~/.copilot/flows/<id>.json). The maintainer
  // MCP uses this so an agent can compose flows, not just trigger pre-written
  // ones. The id must be a safe basename (no path traversal). A gate.script is
  // taken as-is (owner accepted authoring gate scripts via the maintainer MCP);
  // write the script itself with flow/write-gate.
  'flow/add': {
    body: Flow,
    result: z.object({ ok: z.boolean(), flow: Flow.optional(), error: z.string().optional() }),
  },
  'flow/remove': {
    body: z.object({ id: SafeBasename }),
    result: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  // Write a gate script into ~/.copilot/flows/<name> (chmod +x) and return its
  // absolute path, to reference as a flow's gate.script. `name` must be a safe
  // basename. Confined to the flows dir (path-traversal rejected).
  'flow/write-gate': {
    body: z.object({ name: SafeBasename, script: z.string().min(1) }),
    result: z.object({ ok: z.boolean(), path: z.string().optional(), error: z.string().optional() }),
  },
  'flow/run': {
    body: z.object({ flowId: z.string(), ctx: SessionEventCtx.optional() }),
    result: z.object({
      ok: z.boolean(),
      skipped: z.boolean().optional(),   // gate said skip
      sessionId: z.string().optional(),  // a spawn-session action's new worker id
      error: z.string().optional(),
    }),
  },
  // ── Server-level flow schedules (time triggers; fire even with 0 sessions) ───
  // The unified, engine-global timer — exactly one timing kind (interval | cron |
  // at). On each tick it runs a FLOW (flowId) OR delivers an inline prompt-existing
  // target — provide exactly one of flowId / target.
  'flow-schedule/add': {
    body: z.object({
      flowId: z.string().optional(),
      target: InlineScheduleTarget.optional(),
      interval: z.string().optional(),
      cron: z.string().optional(),
      at: z.number().optional(),
      recurring: z.boolean().optional(),
      tz: z.string().optional(),
      label: z.string().optional(),
    }).superRefine((v, ctx) => {
      if (!exactlyOne(v, ['flowId', 'target']))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide exactly one of flowId or target' });
      if (!exactlyOne(v, ['interval', 'cron', 'at']))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide exactly one of interval, cron, or at' });
    }),
    result: z.object({ ok: z.boolean(), entry: FlowScheduleEntry.optional(), error: z.string().optional() }),
  },
  'flow-schedule/stop': {
    body: z.object({ id: z.number() }),
    result: z.object({ ok: z.boolean() }),
  },
  'flow-schedule/list': {
    body: z.object({}),
    result: z.object({ entries: z.array(FlowScheduleEntry) }),
  },
} as const;

export type IntentName = keyof typeof Intents;
export type IntentBody<K extends IntentName> = z.infer<(typeof Intents)[K]['body']>;
export type IntentResult<K extends IntentName> = z.infer<(typeof Intents)[K]['result']>;
