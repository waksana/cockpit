// @cockpit/protocol — the SINGLE shared truth for the wire.
// zod schemas + inferred types for: the domain model, the server→client SSE
// event union, and the client→server POST intents. Both ends import these and
// validate against them, so the frontend and backend can never drift.

import { z } from 'zod';

export { CHAT_EVENT_TYPES, NativeChatEvent, NativeChatRead, NativeChatPage, NativeChatStreamRequest, NativeChatStreamEvent } from './native-chat.ts';
import { NativeChatRead, NativeChatPage } from './native-chat.ts';

// ---------------------------------------------------------------------------
// Shared schema helpers (boundary invariants encoded ONCE, in the contract)
// ---------------------------------------------------------------------------

// "Exactly one of these keys is set." Used by .superRefine() on the intent
// bodies that document a mutual-exclusion invariant (schedule),
// so the shared gate — not hand-written engine dispatch — rejects none/several.
const exactlyOne = (obj: Record<string, unknown>, keys: string[]): boolean =>
  keys.filter((k) => obj[k] !== undefined).length === 1;

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export const SessionStatus = z.enum(['unloaded', 'idle', 'running', 'error']);
export type SessionStatus = z.infer<typeof SessionStatus>;
export const AgentStatus = z.enum(['starting', 'up', 'stopping', 'failed']);
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
  toolCallId: z.string().optional(),
  agentId: z.string().optional(),
  name: z.string(),          // internal agent_type (general-purpose/explore/…)
  displayName: z.string(),   // human-readable
  description: z.string().optional(),
  model: z.string().optional(),
  // Last observed execution evidence, not a task-registry current-state snapshot.
  status: z.enum(['running', 'activity', 'completed', 'failed', 'cancelled', 'unknown']),
  toolCount: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string().optional(), // what the sub-agent was asked to do
});
export type SubagentInfo = z.infer<typeof SubagentInfo>;

export const NativeAttachment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string().min(1), displayName: z.string().optional() }).strict(),
  z.object({ type: z.literal('directory'), path: z.string().min(1), displayName: z.string().optional() }).strict(),
  z.object({
    type: z.literal('selection'), filePath: z.string().min(1), displayName: z.string(),
    selection: z.object({
      start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict(),
      end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }).strict(),
    }).strict().optional(),
    text: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('blob'), data: z.string(), mimeType: z.string().min(1), displayName: z.string().optional(),
  }).strict(),
]);
export type NativeAttachment = z.infer<typeof NativeAttachment>;

// ChatMessage is recursive: a sub-agent card holds its inner conversation in
// `subMessages` (each itself a ChatMessage, possibly with its own sub-agents).
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thought?: string;
  timestamp: number;
  // Ephemeral-only drafts trail confirmed records within their owning scope.
  provisional?: boolean;
  toolCalls?: ToolCall[];
  // 'ask-reply' = the user's answer to an ask_user tool; 'subagent' = a sub-agent
  // card; 'skill' = a compact skill-activation pill.
  subtype?: 'ask-reply' | 'subagent' | 'skill';
  // Severity for system messages (runtime errors/warnings folded into the thread).
  level?: 'info' | 'warning' | 'error';
  subagent?: SubagentInfo;
  subMessages?: ChatMessage[];
}
export const ChatMessage: z.ZodType<ChatMessage> = z.lazy(() => z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  thought: z.string().optional(),
  timestamp: z.number(),
  provisional: z.boolean().optional(),
  toolCalls: z.array(ToolCall).optional(),
  subtype: z.enum(['ask-reply', 'subagent', 'skill']).optional(),
  level: z.enum(['info', 'warning', 'error']).optional(),
  subagent: SubagentInfo.optional(),
  subMessages: z.array(ChatMessage).optional(),
}));

export function summarizeMessage(message: ChatMessage): ChatMessage {
  if (message.subtype !== 'subagent' || !message.subagent) return message;
  const { subMessages: _messages, subagent, ...summary } = message;
  const { prompt: _prompt, ...info } = subagent;
  const toolCallId = subagent.toolCallId
    ?? (message.id.startsWith('subagent-') ? message.id.slice('subagent-'.length) : undefined);
  return { ...summary, subagent: { ...info, ...(toolCallId ? { toolCallId } : {}) } };
}

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
// markdown narrative and the complete native TODO checklist.
export const SessionPlan = z.object({
  planMarkdown: z.string().nullable(),
  todos: z.array(TodoItem),
});
export type SessionPlan = z.infer<typeof SessionPlan>;

const TokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SessionUsage = z.object({
  sessionId: z.string(),
  sampledAt: z.number().int().nonnegative(),
  context: z.object({
    totalTokens: TokenCount,
    modelId: z.string(),
    modelSource: z.string(),
    promptTokenLimit: TokenCount,
    limit: TokenCount,
    compactionThreshold: TokenCount,
    categories: z.object({
      systemPrompt: TokenCount, customInstructions: TokenCount, systemTools: TokenCount,
      mcpTools: TokenCount, messages: TokenCount, freeSpace: TokenCount, buffer: TokenCount,
    }),
    compactions: z.object({ count: TokenCount }),
  }).nullable(),
  usage: z.object({
    sessionStartTime: z.string(),
    currentModel: z.string().optional(),
    totalUserRequests: TokenCount,
    lastCallInputTokens: TokenCount,
    lastCallOutputTokens: TokenCount,
    modelMetrics: z.record(z.object({
      usage: z.object({
        inputTokens: TokenCount, outputTokens: TokenCount,
        cacheReadTokens: TokenCount, cacheWriteTokens: TokenCount,
        reasoningTokens: TokenCount.optional(),
      }),
    }).optional()),
  }),
});
export type SessionUsage = z.infer<typeof SessionUsage>;

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

// ── Scheduled prompts (native fixed-cadence, one-shot and self-paced entries) ──
// Self-paced entries need no intervalMs / cron / at; the model controls nextRunAt.
export const ScheduleEntry = z.object({
  id: z.number(),                    // sequential within the session, stable across resume
  prompt: z.string(),                // the text enqueued on every tick
  recurring: z.boolean(),            // true = re-arms (/every); false = one-shot (/after)
  selfPaced: z.boolean().optional().describe('True means the model controls each next run, with no fixed cadence. Read/stop support does not expose self-paced creation or rearming.'),
  nextRunAt: z.number(),             // epoch ms of the next fire
  intervalMs: z.number().optional(), // set for relative-interval schedules
  cron: z.string().optional(),       // set for calendar (cron) schedules
  tz: z.string().optional(),         // IANA tz the cron is evaluated in
  at: z.number().optional(),         // set for one-shot absolute-time schedules
  displayPrompt: z.string().optional(), // user-facing label when prompt is a slash-command expansion
});
export type ScheduleEntry = z.infer<typeof ScheduleEntry>;

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

// ── MCP + Skills management (dedicated pages, not the info panel) ─────────────
// Native Copilot MCP configuration and its default for future sessions.
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
// live SDK handle. An unloaded response cannot claim per-session enabled state.
export const McpServerStatus = z.enum([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
  'stopped',
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
  enabled: z.boolean().describe('Configured and not explicitly disabled; does not imply connected or permitted to restart.'),
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
  enabled: z.boolean().optional(),
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
  actions: z.array(z.enum(['accept', 'decline', 'cancel'])).optional(),
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

export const SessionMeta = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  createdAt: z.number().optional(),
  lastActivity: z.number().describe('Native persisted-state modification time, not a live activity clock.'),
  lastActivitySource: z.enum(['native-persisted', 'native-construction', 'host-event-receipt']).optional(),
  status: SessionStatus,
  error: z.string().nullable().optional(),
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
  loading: z.boolean().optional(),
  closing: z.boolean().optional(),
  cancelling: z.boolean().optional(),
  queue: z.array(QueuedItem).optional().describe('Native pending queue; unavailable while unloaded, not an empty-queue claim.'),
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
  // Number of active scheduled prompts on this session (drives the list timer
  // badge). Read on demand; omitted when native runtime data is unavailable.
  scheduleCount: z.number().optional(),
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
  activeOperations: z.number().int().nonnegative().optional(),
  nativeProcessing: z.boolean().optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

// Resource names describe read dependencies, not cached native state. Omission
// in a projection means "not requested", never an empty/default value.
export const MetaResource = z.enum(['identity', 'control', 'queue', 'model', 'models', 'mode', 'todo', 'schedule']);
export type MetaResource = z.infer<typeof MetaResource>;
export const SessionResource = z.enum([...MetaResource.options, 'plan', 'skills', 'mcp', 'tasks', 'instructions', 'usage']);
export type SessionResource = z.infer<typeof SessionResource>;
export const SessionProjection = SessionMeta.partial().required({ sessionId: true, loaded: true });
export type SessionProjection = z.infer<typeof SessionProjection>;
export const PanelSection = SessionPanels.keyof();
export type PanelSection = z.infer<typeof PanelSection>;

// A compact, request-owned view of an existing session, read asynchronously
// by the `session/list` intent. Used by the cockpit MCP so an agent
// can discover sessions (and pick one to rename / toggle MCP-skills on) without
// subscribing to the SSE snapshot stream.
export const SessionBrief = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  loaded: z.boolean(),
  lastActivity: z.number(),
  lastActivitySource: z.enum(['native-persisted', 'native-construction', 'host-event-receipt']).optional(),
  currentModelId: z.string().optional(),
});
export type SessionBrief = z.infer<typeof SessionBrief>;

// ---------------------------------------------------------------------------
// Server → client events (delivered over a single SSE stream)
// ---------------------------------------------------------------------------

export const HistoryDetails = z.enum(['full', 'summary']);
export type HistoryDetails = z.infer<typeof HistoryDetails>;

export const Snapshot = z.object({
  type: z.literal('snapshot'),
  agentStatus: AgentStatus,
  models: z.array(ModelOption),
  sessions: z.array(SessionMeta).describe('Sidebar/control summaries, not full session/get details. Queue bodies, model inventories and todos are read on demand.'),
  permissionPolicy: z.literal('allow-all').describe(
    'Permissions are always auto-approved. Independent of interactive, plan, and autopilot interaction modes.',
  ),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const ServerEvent = z.discriminatedUnion('type', [
  Snapshot,
  z.object({ type: z.literal('agent/status'), status: AgentStatus }),
  z.object({ type: z.literal('session/added'), session: SessionMeta }),
  z.object({
    type: z.literal('session/invalidated'), sessionId: z.string(),
    // Absent on older hosts: consumers must reconcile all their dependencies.
    resources: z.array(SessionResource).min(1).optional(),
  }),
  // A partial SessionMeta patch: every field optional (carry only what changed),
  // `sessionId` required as the key. Derived from SessionMeta so adding a field
  // there automatically makes it patchable — no parallel field list to maintain.
  SessionMeta.partial().required({ sessionId: true }).extend({
    type: z.literal('session/patch'),
  }),
  z.object({
    type: z.literal('session/removed'), sessionId: z.string(),
  }),
  z.object({
    type: z.literal('chat/invalidated'), sessionId: z.string(),
    reason: z.enum(['rewind', 'compaction']),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent['type'];

export const ServiceShutdown = z.object({
  phase: z.enum(['running', 'waiting', 'closing', 'failed', 'closed']),
  requestedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type ServiceShutdown = z.infer<typeof ServiceShutdown>;

export const ServiceStatus = z.object({
  running: z.number().int().nonnegative(),
  busy: z.number().int().nonnegative(),
  inFlightRequests: z.number().int().nonnegative().describe('Mutating HTTP calls whose operation or response is still in flight; read-only display streams do not hold shutdown.'),
  shutdown: ServiceShutdown,
  sessions: z.array(z.object({
    sessionId: z.string(), title: z.string(), status: SessionStatus,
    awaitingChoice: z.boolean().optional(), activeSubagents: z.number().int().nonnegative().optional(),
  })),
});
export type ServiceStatus = z.infer<typeof ServiceStatus>;

export const Intents = {
  'system/shutdown': {
    description: 'Request graceful service shutdown with confirm:true. Returns acceptance, not completed exit. New independent work is refused while existing turns, queues, decisions and in-flight operations settle; future schedules do not keep the service alive. The service closes its own SDK and transports, without restarting itself or sending startup prompts. Never keep the initiating native turn or a background tool waiting for its own exit; read system/status from an independent caller if needed. No force, deployment or cancellation mode.',
    body: z.object({ confirm: z.literal(true) }).strict(),
    result: z.object({ ok: z.literal(true), shutdown: ServiceShutdown }),
  },
  'system/status': {
    description: 'Read current native service activity and the host-owned graceful shutdown state. No deployment, launcher, module business or cached native state is consulted. A waiting request is not completed shutdown; safety read failures remain errors.',
    body: z.object({}).strict(),
    result: ServiceStatus,
  },
  'session/chat': {
    description: 'Read one native event page without a server chat cache or projection. max counts events, not display messages or bytes. Keep source/direction with opaque cursors. Passive reads do not load sessions; live reads require an existing handle. Bootstrap captures a live cursor before a fresh backward page. An expired cursor is not a continuation. Binary tool media is omitted, never automatically retained; no file library or image lookup is provided.',
    body: NativeChatRead,
    result: NativeChatPage,
  },
  'runtime/snapshot': {
    description: 'Read global models, readiness, permission policy (always auto-approve), and session metadata in one passive query. Interaction modes do not change permissions.',
    body: z.object({}),
    result: Snapshot,
  },
  'session/new': {
    description: 'Create one native Copilot session using its working directory and native configuration discovery. Returns the real native ID without sending a message; Web and MCP then use prompt with that ID. Never recreate on an uncertain result. Empty sessions may disappear after unload. No module roles or global/project files are written.',
    body: z.object({ cwd: z.string().min(1) }).strict(),
    result: z.object({ sessionId: z.string() }),
  },
  'session/fork': {
    description: 'Native history fork from a loaded, idle session. Optional toEventId is a root user.message event ID from session history, excluded from the child; omit for full history. Rejects unfinished boundaries and any inherited schedule history. Returns a new unloaded session ID; no prompt is sent. Native fork appends an informational record to the parent. Model/mode follow native persisted history; skills/MCP use cold-resume defaults, not a complete configuration clone. cwd/files are shared, not a worktree. Non-idempotent: on an uncertain error inspect session/list and source history before any retry.',
    body: z.object({
      sessionId: z.string().min(1),
      toEventId: z.string().min(1).optional(),
      name: z.string().trim().min(1).max(120).optional(),
    }).strict(),
    result: z.object({ sessionId: z.string().min(1) }),
  },
  prompt: {
    description: 'Send text and optional SDK-native file, directory, selection or blob attachments. Paths refer to the native runtime filesystem, not this client. No upload, module file-reference resolution or file association is performed. Retired attachment/parts and managed URL shapes are rejected. Acceptance does not mean attachment content was read, and model format support is separate.',
    body: z.object({
      sessionId: z.string(), text: z.string(), mode: z.enum(['enqueue', 'immediate']).optional(),
      attachments: z.array(NativeAttachment).max(20).optional(),
    }).strict(),
    result: z.object({ ok: z.boolean(), queued: z.boolean().optional() }),
  },
  cancel: {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/interrupt': {
    description: 'Interrupt the current main turn and continue the native queue in order, without clearing or replaying it. Background work survives and may delay the queue. The result acknowledges the request, not idle or completed execution; interrupted:false means no main turn was interrupted. Requires a loaded session; never automatically retry an uncertain result.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.literal(true), interrupted: z.boolean() }),
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
    description: 'Rewind to before a selected user message. rollbackFiles:true requests native file rollback; the backend validates runtime support and reports conflicts or partial failures rather than silently ignoring it.',
    body: z.object({ sessionId: z.string(), toMsgId: z.string(), rollbackFiles: z.boolean().optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  setMode: {
    description: 'Set interaction mode: interactive, plan, or autopilot. Permissions remain always auto-approved (allow-all) in every mode.',
    body: z.object({ sessionId: z.string(), mode: AgentMode }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/delete': {
    description: 'IRREVERSIBLE native session deletion. Explicit confirm:true is required; old soft-delete requests are rejected. Managed files and workspaces are retained. Never automatically retry an uncertain result.',
    body: z.object({ sessionId: z.string().min(1), confirm: z.literal(true) }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'session/unload': {
    description: 'Unload an idle native session without deleting persisted history. Empty never-messaged sessions may disappear; session/get reports actual presence. Never creates a replacement or cancels busy work.',
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/load': {
    description: 'Ensure the original native session is loaded using native configuration discovery. Never creates a replacement, closes an already-loaded handle, or sends a prompt. Concurrent loads coalesce. Native errors and lifecycle conflicts remain explicit; this does not resynchronize history cursors.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.literal(true), sessionId: z.string().min(1) }).strict(),
  },
  'session/reload': {
    description: 'Explicitly resume an unloaded session, or close and resume an existing idle loaded session using native configuration discovery. Never creates another ID or sends a message. An empty never-messaged session may disappear on close and then fail to resume; no automatic replacement. Native relative schedule delays restart on resume.',
    body: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.boolean() }),
  },
  'session/usage': {
    description: 'Read native context attribution and accumulated usage on an already-loaded session. Never resumes, infers, compacts or scans history. Context is native tokenization of current system/messages/tool definitions; promptTokenLimit is from that same native snapshot. Last-call input/output are the latest main-agent call, not current context. Model totals are the native available aggregate; persistence and auxiliary-call coverage are not guaranteed by this adapter. Null context means uninitialized, not zero.',
    body: z.object({ sessionId: z.string().min(1) }),
    result: SessionUsage,
  },
  'session/plan': {
    body: z.object({ sessionId: z.string() }),
    result: SessionPlan,
  },
  'session/panels': {
    body: z.object({ sessionId: z.string() }),
    result: SessionPanels,
  },
  'session/panel': {
    description: 'Read one native panel section on an already-loaded session. Other sections are not read. Full five-section compatibility is available through session/panels.',
    body: z.object({ sessionId: z.string(), section: PanelSection }),
    result: z.object({ items: z.array(PanelItem) }),
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
  // Synchronous authoritative list of existing sessions. Unlike
  // session/refresh (which only nudges the SSE snapshot), this returns the data
  // in the result so the cockpit MCP can read it over plain HTTP.
  'session/list': {
    body: z.object({}),
    result: z.object({ sessions: z.array(SessionBrief) }),
  },
  // Full authoritative metadata for ONE session, unlike the narrowed SSE
  // summary. Returns the operational ids a maintainer/agent needs to
  // act (queue itemId, ask/plan/elicitation requestId), the live model/mode/status,
  // todo + attention, etc. Returns meta:null if the id isn't a known live session.
  'session/get': {
    body: z.object({ sessionId: z.string() }),
    result: z.object({ meta: SessionMeta.nullable() }),
  },
  'session/resources': {
    description: 'Read only requested metadata resources, without loading a session. Omitted fields were not requested, not cleared. loaded:false invalidates all previous native fields; meta:null means unknown session. Control display is not permission to delete, unload or restart; mutations independently confirm fresh safety.',
    body: z.object({ sessionId: z.string(), resources: z.array(MetaResource).min(1).max(MetaResource.options.length) }),
    result: z.object({ meta: SessionProjection.nullable() }),
  },
  'mcp/global': {
    description: 'Read Copilot native user MCP configuration and defaults without activating a session.',
    body: z.object({}),
    result: z.object({ servers: z.array(McpServerGlobal) }),
  },
  'mcp/global-default': {
    description: 'Enable or disable a server in Copilot native user configuration for future sessions. Active session connections are unchanged.',
    body: z.object({ name: z.string(), on: z.boolean() }),
    result: z.object({ ok: z.boolean() }),
  },
  'mcp/refresh': {
    description: 'Invalidate the native MCP configuration cache. Does not restart sessions or replay Cockpit preferences.',
    body: z.object({}),
    result: z.object({ ok: z.boolean() }),
  },
  // Native reload updates one loaded session and re-applies global defaults.
  'mcp/reload-session': {
    description: 'Reload MCP connections on an idle loaded session through native MCP reload. Temporary session choices may revert to native global defaults. Does not load, close or replace the session.',
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
    description: 'List global skills using optional cwd; omitted cwd uses the server home directory, never an arbitrary session.',
    body: z.object({ cwd: z.string().min(1).optional() }),
    result: z.object({ skills: z.array(SkillGlobal) }),
  },
  // Read one skill's full detail incl. the SKILL.md body (lazy — only when its
  // detail pane opens), so the list payload stays lean.
  'skills/read': {
    body: z.object({ name: z.string(), cwd: z.string().min(1).optional() }),
    result: z.object({
      name: z.string(),
      description: z.string().optional(),
      source: z.string().optional(),
      userInvocable: z.boolean().optional(),
      enabled: z.boolean().optional(),
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
  'skills/global-toggle': {
    description: 'Enable or disable a skill in Copilot native global configuration. Optional cwd selects discovery context for project skills; persistence remains global. Does not create sessions or store a Cockpit override.',
    body: z.object({ name: z.string().min(1), enabled: z.boolean(), cwd: z.string().min(1).optional() }),
    result: z.object({ ok: z.boolean() }),
  },
  'skills/refresh': {
    description: 'Reload native skill definitions without restarting Cockpit.',
    body: z.object({}),
    result: z.object({ ok: z.boolean() }),
  },
  'fs/listDir': {
    description: 'List a backend directory, directories first, with its resolved path and parent. Omit path for home. Explicit empty, missing, non-directory or inaccessible paths fail without falling back to home; errors retain their code and message (400 for empty/non-directory, 404 for missing, 403 for denied access).',
    body: z.object({ path: z.string().optional() }),
    result: DirListing,
  },
  // Compatibility for existing explicitly destructive clients; one implementation.
  'session/purge': {
    description: 'Compatibility alias for session/delete: irreversible native deletion, requiring explicit confirm:true. Managed files and workspaces are retained. Never automatically retry an uncertain result.',
    body: z.object({ sessionId: z.string().min(1), confirm: z.literal(true) }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  // Native after/every supports relative delays and one-shot absolute times.
  'schedule/add': {
    description: 'Schedule a native after/every prompt. The current runtime supports exactly one of interval or at, from 1 second to 24 hours. Interval uses s, m, h, or d and defaults to recurring; at is one-shot. Prompt must be single-line plain text, without command flags or a leading slash. Legacy cron, timezone, displayPrompt and recurring-at options are not supported and are rejected. No self-paced creation or rearming is exposed. Ticks require a loaded session; schedules pause on native idle unload and relative delays restart on resume. Schedules do not keep it loaded. This is not an always-on scheduler.',
    body: z.object({
      sessionId: z.string(),
      prompt: z.string().min(1).refine(
        (text) => !!text.trim() && !/[\r\n]/.test(text) && !/(^|\s)--/.test(text) && !text.trimStart().startsWith('/'),
        'use single-line plain text without command flags or a leading slash',
      ),
      interval: z.string().regex(/^[1-9]\d*[smhd]$/).refine((value) => {
        const seconds = Number(value.slice(0, -1)) * ({ s: 1, m: 60, h: 3600, d: 86400 }[value.at(-1)!] ?? 0);
        return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86400;
      }, 'interval must be between 1 second and 24 hours').optional(),
      at: z.number().optional(),
      recurring: z.boolean().optional(),
    }).strict().superRefine((v, ctx) => {
      if (!exactlyOne(v, ['interval', 'at']))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide exactly one of interval or at' });
      if (v.at !== undefined && v.recurring === true)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'absolute schedules are one-shot' });
    }),
    result: z.object({ ok: z.boolean(), entry: ScheduleEntry.optional(), error: z.string().optional() }),
  },
  'schedule/stop': {
    description: 'Stop one native schedule by its id, including self-paced entries. ok reflects whether the native stop result contained the stopped entry; false means none was returned. No list read is used to infer success and errors propagate. This does not rearm or replace the schedule.',
    body: z.object({ sessionId: z.string(), id: z.number() }),
    result: z.object({ ok: z.boolean() }),
  },
  'schedule/list': {
    description: 'Read native recurring, one-shot and self-paced schedules on an already-loaded session. selfPaced:true means the model controls each next run, with no fixed cadence; optional timing fields describe returned native entries, not additional creation options. No self-paced creation or rearming is exposed. Unloaded reads require explicit resume. Schedules do not keep sessions loaded or provide an always-on scheduler.',
    body: z.object({ sessionId: z.string() }),
    result: z.object({ entries: z.array(ScheduleEntry) }),
  },
} as const;

export type IntentName = keyof typeof Intents;
export type IntentBody<K extends IntentName> = z.infer<(typeof Intents)[K]['body']>;
export type IntentResult<K extends IntentName> = z.infer<(typeof Intents)[K]['result']>;
