// @cockpit/protocol — the SINGLE shared truth for the wire.
// zod schemas + inferred types for: the domain model, the server→client SSE
// event union, and the client→server POST intents. Both ends import these and
// validate against them, so the frontend and backend can never drift.

import { z } from 'zod';
export { ErrorCodes, errorCode, isErrorCode } from './errors.ts';
export type { ErrorCode } from './errors.ts';
import { snapshotModuleEventPayload } from './module-event.ts';
export { MAX_MODULE_EVENT_BYTES, snapshotModuleEventPayload } from './module-event.ts';
export type { ModuleEventPayload } from './module-event.ts';
export { MCP_INVOCATION_META_KEY } from './mcp-invocation.ts';
export type { McpInvocationMeta } from './mcp-invocation.ts';
import type { ChatMessage } from './validation.ts';
import type { ErrorCode } from './errors.ts';
export type { ChatMessage, ChatRole, SubagentInfo, ToolCall } from './validation.ts';

export { CHAT_EVENT_TYPES, NativeChatEvent, NativeChatRead, NativeChatPage, NativeChatStreamRequest, NativeChatStreamEvent } from './native-chat.ts';
import { NativeChatRead, NativeChatPage } from './native-chat.ts';
export {
  NativeModelSwitchResult, NativeModeSetResult, NativeCompactResult, NativeRewindResult,
  classifyNativeModelSwitchResult, classifyNativeModeSetResult, classifyNativeCompactResult, classifyNativeRewindResult,
} from './native-operations.ts';
export type { NativeOperationClassification } from './native-operations.ts';
import { NativeModelSwitchResult, NativeModeSetResult, NativeCompactResult, NativeRewindResult } from './native-operations.ts';

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

export const ServiceIdentity = z.object({
  instanceId: z.string().uuid(),
  version: z.string().min(1),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
});
export type ServiceIdentity = z.infer<typeof ServiceIdentity>;

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

export const INITIAL_SESSION_MODEL = 'gpt-6-astra';
export const NewSessionDefaults = z.object({
  modelId: z.string().trim().min(1).max(200),
}).strict();
export type NewSessionDefaults = z.infer<typeof NewSessionDefaults>;
export const NewSessionDefaultsView = NewSessionDefaults.extend({
  models: z.array(ModelOption).nullable(),
  modelError: z.string().nullable(),
});
export type NewSessionDefaultsView = z.infer<typeof NewSessionDefaultsView>;

export function cleanSessionTitle(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed.split('\n')[0]?.trim() ?? '';
}

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

// History can omit blob bytes; this does not relax native send input.
export const NativeAttachmentDescriptor = z.discriminatedUnion('type', [
  NativeAttachment.options[0],
  NativeAttachment.options[1],
  NativeAttachment.options[2],
  NativeAttachment.options[3].extend({
    data: z.string().optional(),
    omittedReason: z.string().min(1).optional(),
  }),
]);
export type NativeAttachmentDescriptor = z.infer<typeof NativeAttachmentDescriptor>;

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
  canSteer: z.boolean().optional().describe('Native queue item can be individually steered; absence is not permission.'),
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

// Full session plan payload (on-demand): the plan.md
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
export const ModuleSource = z.object({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.object({ id: z.string(), name: z.string() })).optional()
    .describe('Actual contributing roles, deduplicated and sorted by role ID. Omitted when unproven; never inferred from selected session roles or a global resource matching a role declaration. Provenance is not authorization, enablement or readiness.'),
});
export type ModuleSource = z.infer<typeof ModuleSource>;

export const ModuleSkillSource = ModuleSource.extend({
  resourceId: z.string().optional()
    .describe('Opaque version-bound role Skill identity. Present only when the verified native path is a current role resource; omitted for other packaged Skills.'),
});
export type ModuleSkillSource = z.infer<typeof ModuleSkillSource>;

export const McpConnection = z.object({
  method: z.enum(['http', 'sse', 'stdio', 'unknown']),
  target: z.string().optional().describe('HTTP/SSE hostname or local executable basename only; never URL credentials, path, query, fragment or command arguments.'),
});
export type McpConnection = z.infer<typeof McpConnection>;

// Native Copilot MCP configuration and its default for future sessions.
export const McpServerGlobal = z.object({
  name: z.string(),
  modules: z.array(ModuleSource).optional().describe('Modules verified against the native global configuration endpoint and currently loaded digest-pinned module declarations. Does not identify contributing roles or prove connectivity. Omitted when attribution is unproven.'),
  detail: z.string(),       // command / url summary
  connection: McpConnection.optional().describe('Connection method and short target from native global configuration. Custom or unrecognized configurations remain unknown.'),
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
  module: ModuleSource.optional().describe('Module and known contributing roles that declared this MCP name in this session handle role configuration. Not proof of the live connection identity; same-name native replacements cannot be verified.'),
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
  modules: z.array(ModuleSkillSource).optional().describe('Modules verified against the native discovered skill path and installed file digest of currently loaded modules. An exact role resource identity is included only when that path is currently declared. Contributing roles remain unknown. Omitted when attribution is unproven.'),
  description: z.string().optional(),
  source: z.string().optional(),
  userInvocable: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type SkillGlobal = z.infer<typeof SkillGlobal>;

export const SkillSession = z.object({
  name: z.string(),
  module: ModuleSource.optional().describe('Module and known contributing roles verified against the native skill name and file path for this session handle.'),
  description: z.string().optional(),
  source: z.string().optional(),
  enabled: z.boolean(),
});
export type SkillSession = z.infer<typeof SkillSession>;

const ResourceName = z.string().min(1).max(200).refine(value => value.trim().length > 0, 'Name must not be blank');
const ResourceNames = z.array(ResourceName).max(64).refine(values => new Set(values).size === values.length, 'Names must be unique');
const PreparationToolNames = z.array(ResourceName.refine(value => value !== '*', 'Wildcard tools are not supported'))
  .max(256).refine(values => new Set(values).size === values.length, 'Tools must be unique');
export const SessionResourcesPrepare = z.object({
  sessionId: ResourceName,
  skills: ResourceNames.optional(),
  mcpServers: z.array(z.object({ name: ResourceName, tools: PreparationToolNames.optional() }).strict())
    .max(64).refine(values => new Set(values.map(value => value.name)).size === values.length, 'Servers must be unique').optional(),
}).strict();
export type SessionResourcesPrepare = z.infer<typeof SessionResourcesPrepare>;
const ResourcePreparationEffect = z.enum(['not_attempted', 'unchanged', 'enabled', 'unconfirmed']);
export const RESOURCE_PREPARATION_ERROR_LIMIT = 2000;
// skills/read error code for a name absent from the discovered skill catalog.
export const SKILL_NOT_FOUND = 'SKILL_NOT_FOUND' satisfies ErrorCode;
// roles/skill-read error code for an inactive, replaced or unknown module Skill identity.
export const MODULE_SKILL_NOT_FOUND = 'MODULE_SKILL_NOT_FOUND' satisfies ErrorCode;
export const ResourcePreparationResult = z.object({
  sessionId: ResourceName,
  ok: z.boolean(),
  skills: z.array(z.object({
    name: ResourceName, effect: ResourcePreparationEffect, enabled: z.boolean().nullable(),
  }).strict()).max(64),
  mcpServers: z.array(z.object({
    name: ResourceName, effect: ResourcePreparationEffect, enabled: z.boolean().nullable(),
    status: McpServerStatus.nullable(), tools: z.array(ResourceName).max(256).nullable(),
  }).strict()).max(64),
  tools: z.enum(['not_attempted', 'unchanged', 'initialized', 'unconfirmed']),
  error: z.string().max(RESOURCE_PREPARATION_ERROR_LIMIT).optional(),
}).strict();
export type ResourcePreparationResult = z.infer<typeof ResourcePreparationResult>;



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
  source: z.string().optional().describe('Native elicitation source, such as an MCP server name, when reported.'),
  actions: z.array(z.enum(['accept', 'decline', 'cancel'])).optional(),
});
export type ElicitationRequest = z.infer<typeof ElicitationRequest>;

// Every pending decision in native arrival order. The singular ask/planRequest/
// elicitation fields keep exposing the first pending request of each kind.
export const PendingDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), request: AskRequest }),
  z.object({ kind: z.literal('plan'), request: PlanRequest }),
  z.object({ kind: z.literal('elicitation'), request: ElicitationRequest }),
]);
export type PendingDecision = z.infer<typeof PendingDecision>;

// Agent TODO progress derived from native readSqlTodos rows. `null` = no todos.
export const TodoProgress = z.object({
  done: z.number(),
  total: z.number(),
  intent: z.string().nullable(),
});
export type TodoProgress = z.infer<typeof TodoProgress>;

// Agent interaction mode (CLI shift+tab cycles these).
export const AgentMode = z.enum(['interactive', 'plan', 'autopilot']);
export type AgentMode = z.infer<typeof AgentMode>;

export const RoleSelection = z.object({ moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), roleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict();
export type RoleSelection = z.infer<typeof RoleSelection>;
export const SessionRole = RoleSelection.extend({ name: z.string(), moduleName: z.string() });
export type SessionRole = z.infer<typeof SessionRole>;

const RoleIds = z.array(z.string()).min(1)
  .describe('IDs of this module\'s roles that declare the resource, sorted and deduplicated.');
// Resources a loaded module's roles assemble into sessions selecting them. Not native global configuration.
export const ModuleRoleResources = z.object({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.object({ id: z.string(), name: z.string() })).describe('Every role this module declares, sorted by ID.'),
  skills: z.array(z.object({
    id: z.string().min(1).max(200)
      .describe('Opaque identity bound to this loaded module version and packaged SKILL.md; not a filesystem path.'),
    name: z.string(), description: z.string().optional(), roles: RoleIds,
  })),
  mcpServers: z.array(z.object({
    name: z.string(),
    tools: z.array(z.string()).describe('Union of declared tool subsets; ["*"] means all tools the module server offers.'),
    roles: RoleIds,
  })),
});
export type ModuleRoleResources = z.infer<typeof ModuleRoleResources>;
export const ModuleRoleSkill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  body: z.string(),
  module: ModuleSource,
});
export type ModuleRoleSkill = z.infer<typeof ModuleRoleSkill>;
export const RoleReadiness = z.object({
  sessionId: z.string(), loaded: z.boolean(), ready: z.boolean(),
  roles: z.array(SessionRole), reasons: z.array(z.string()),
  appliedRoles: z.array(SessionRole).optional(),
  rolesNeedReload: z.boolean().optional(),
});
export type RoleReadiness = z.infer<typeof RoleReadiness>;
export const RoleAdditionResult = z.object({
  sessionId: z.string(),
  status: z.enum(['saved', 'unchanged', 'uncertain']),
  roles: z.array(SessionRole),
  appliedRoles: z.array(SessionRole),
  loaded: z.boolean(),
  rolesNeedReload: z.boolean(),
  error: z.string().optional(),
  recovery: z.string().optional(),
});
export type RoleAdditionResult = z.infer<typeof RoleAdditionResult>;

export const SessionActivity = z.object({
  sampledAt: z.number().int().nonnegative().describe('Read completion time in epoch milliseconds; native reads are not atomic.'),
  processing: z.boolean().describe('Native isProcessing: a turn or background continuation, not necessarily model generation.'),
  hasActiveWork: z.boolean().describe('Broad native activity flag; may be true without a more specific explanation.'),
  abortable: z.boolean().describe('Sampled native capability, not authorization or a guarantee that a later abort succeeds.'),
  tasks: z.object({
    activeAgents: z.number().int().nonnegative(),
    activeShells: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative().describe('Unrecognized task types or statuses, not known active agents or shells.'),
  }),
  queue: z.object({
    pendingCount: z.number().int().nonnegative(),
    steeringCount: z.number().int().nonnegative(),
    inFlightSteeringCount: z.number().int().nonnegative().describe('Subset of steeringCount already folded into the running turn; never add the two counts.'),
  }),
  mcp: z.object({ pendingConnectionCount: z.number().int().nonnegative() }),
});
export type SessionActivity = z.infer<typeof SessionActivity>;

export const SessionControls = z.object({
  token: z.string().min(1).describe('Identity of the loaded native handle; not a permission or a revision.'),
  sampledAt: z.number().int().nonnegative(),
  main: z.boolean(),
  compaction: z.enum(['manual', 'auto', 'unknown']).nullable(),
  tasks: z.array(z.object({
    id: z.string().min(1), kind: z.enum(['agent', 'shell']), title: z.string(),
    status: z.enum(['running', 'idle', 'completed', 'failed', 'cancelled']),
  })),
  steering: z.array(z.object({
    id: z.string().describe('Display-only key, never a native action target.'),
    text: z.string(),
  })).describe('Only steering messages not yet folded into the current turn.'),
});
export type SessionControls = z.infer<typeof SessionControls>;
export const SessionControlAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stop-all') }).strict(),
  z.object({ type: z.literal('stop-task'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('clear-tasks'), kind: z.enum(['agent', 'shell']),
    ids: z.array(z.string().min(1)).min(1).refine(ids => new Set(ids).size === ids.length, 'Duplicate task IDs') }).strict(),
  z.object({ type: z.literal('clear-queue') }).strict(),
  z.object({ type: z.literal('remove'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('steer'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('cancel-decision'), kind: z.enum(['ask', 'plan', 'elicitation']),
    requestId: z.string().min(1) }).strict(),
]);
export type SessionControlAction = z.infer<typeof SessionControlAction>;
export const SessionControlResult = z.object({
  ok: z.boolean(),
  outcomes: z.array(z.object({
    operation: z.string(),
    targetId: z.string().optional(),
    state: z.enum(['accepted', 'unchanged', 'failed', 'unconfirmed']),
    result: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  })),
});
export type SessionControlResult = z.infer<typeof SessionControlResult>;

export const SessionMeta = z.object({
  roles: z.array(SessionRole).optional(),
  appliedRoles: z.array(SessionRole).optional(),
  rolesNeedReload: z.boolean().optional(),
  sessionId: z.string(),
  title: z.string(),
  nativeName: z.string().nullable().optional().describe('Loaded full session/get only: native friendly name (user-set or auto-applied); null means none is set and title comes from the native summary or ID fallback. Omitted when not read, including while unloaded; omission is unknown, not absence.'),
  nativeNameUserSet: z.boolean().optional().describe('Loaded full session/get only: native workspace user_named provenance for nativeName: true after an explicit name set (including session/rename), false for no name or an auto-applied summary. Omitted when unavailable; omission is unknown, not auto.'),
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
  decisions: z.array(PendingDecision).optional().describe('All pending decisions in arrival order; omitted by older hosts. Empty means none pending while loaded.'),
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
  // Legacy conservative count across all task types and unknown statuses.
  // Display typed activity.tasks counts instead; preserve this safety contract.
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
  nativeProcessing: z.boolean().optional().describe('Legacy aggregate busy flag, not the raw native isProcessing result. Use activity.processing for the native flag.'),
  activity: SessionActivity.nullable().optional().describe('Control summary. Null means unavailable or invalidated, not idle; omission means not requested.'),
  controls: SessionControls.nullable().optional().describe('Active task/steering details requested through the controls resource only.'),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

// Resource names describe read dependencies, not cached native state. Omission
// in a projection means "not requested", never an empty/default value.
export const MetaResource = z.enum(['identity', 'control', 'controls', 'queue', 'model', 'models', 'mode', 'todo', 'schedule']);
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
  activity: SessionActivity.nullable().optional(),
  roles: z.array(SessionRole).optional(),
  appliedRoles: z.array(SessionRole).optional(),
  rolesNeedReload: z.boolean().optional(),
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

export type HistoryDetails = 'full' | 'summary';

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
  z.object({ type: z.literal('module/invalidated'), moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }),
  z.object({
    type: z.literal('module/event'),
    moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    payload: z.unknown().transform((value, context) => {
      try { return snapshotModuleEventPayload(value); }
      catch (error) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid module event payload' });
        return z.NEVER;
      }
    }),
  }).strict(),
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
    body: z.object({}).strict(),
    result: Snapshot,
  },
  'session/new': {
    description: 'Create one native session using the Cockpit default new-session model, with optional module roles, combined instructions, skills and HTTP MCP tool subsets. The default is captured once; an unavailable model fails without substitution. No startup message or Copilot global/project config writes. Role selection is not live readiness. Never recreate on an uncertain result.',
    body: z.object({ cwd: z.string().min(1), roles: z.array(RoleSelection).max(64).optional() }).strict(),
    result: z.object({ sessionId: z.string() }),
  },
  'settings/session-defaults': {
    description: 'Read the persistent Cockpit default model for new sessions (initially gpt-6-astra) and the current native model catalog. The saved modelId is retained when unavailable; modelError explains catalog failures or unavailable models. Does not read or modify existing sessions.',
    body: z.object({}).strict(),
    result: NewSessionDefaultsView,
  },
  'settings/session-defaults-set': {
    description: 'Persist the Cockpit default model for future new sessions only. Requires a currently available native model. No existing session, resume, reload, fork, reasoning effort, context tier, mode or Copilot user configuration is changed. A failed/uncertain persistence acknowledgement must be inspected, never automatically retried.',
    body: NewSessionDefaults,
    result: NewSessionDefaults.extend({}),
  },
  'roles/list': {
    body: z.object({}).strict(),
    result: z.object({ roles: z.array(SessionRole.extend({ description: z.string().optional() })) }),
  },
  'roles/resources': {
    description: 'Read the Skills and MCP servers that currently loaded modules\' roles assemble into sessions selecting those roles, by module and contributing role. Read-only: not native global configuration, enablement, connection or readiness, and it cannot be toggled globally. Omits endpoints, digests and file paths.',
    body: z.object({}).strict(),
    result: z.object({ modules: z.array(ModuleRoleResources) }),
  },
  'roles/skill-read': {
    description: 'Read one packaged SKILL.md by its opaque version-bound identity from a currently loaded module. This never accepts a filesystem path, follows stale identities, or reads related files.',
    body: z.object({
      moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      resourceId: z.string().min(1).max(200),
    }).strict(),
    result: ModuleRoleSkill,
  },
  'roles/add': {
    description: 'Save additional module roles for the same session, including while native work is busy. Does not load, reload, interrupt or send a prompt. Saved roles take effect on an explicit idle reload or the next cold load; ordinary native/global resource defaults apply. rolesNeedReload compares saved roles with the current handle. Saving does not establish capability readiness; inspect uncertain persistence before retrying.',
    body: z.object({ sessionId: z.string().min(1), roles: z.array(RoleSelection).min(1).max(64) }).strict(),
    result: RoleAdditionResult,
  },
  'roles/readiness': {
    description: 'Explicitly check current role assembly, native skills, MCP connections and tool visibility without loading or repairing a session. Capability readiness is independent of busy turns, pending messages and subagents. Selected-role labels are not readiness evidence.',
    body: z.object({ sessionId: z.string().min(1), roles: z.array(RoleSelection).max(64).optional() }).strict(),
    result: RoleReadiness,
  },
  'session/tools-initialize': {
    description: 'Explicitly resolve, build and validate the native tool table on a loaded idle session after configuration invalidation. Preserves the current handle, model, temporary skill/MCP choices and native tool filtering. Does not load, reload, enable resources, apply saved roles, write global config or send a prompt. Rejects protected work and concurrent operations. ok confirms initialized metadata, not role readiness; call roles/readiness separately. Failures may leave initialization effects; no automatic retry.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  'session/resources-prepare': {
    description: 'Prepare only explicitly selected native skills and MCP servers on an already loaded idle session, preserving unrelated temporary choices. Prevalidates all selections under one lifecycle guard, enables only disabled selections, and initializes tools once after a confirmed enable or when metadata is null. Unchanged non-null missing tools do not trigger a rebuild; native filtering remains effective. Tools are exact raw mcpToolName identities; wildcards are rejected; omitted or empty tools require at least one actual offered tool. No prompt, reload, global changes, authentication or connector retries. Returns per-request partial/unconfirmed receipts; enabled does not mean skill body loaded. ok requires enabled skills, connected unfiltered MCP with actual offered tools and initialized metadata, not role readiness, Task binding or authorization.',
    body: SessionResourcesPrepare,
    result: ResourcePreparationResult,
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
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'session/interrupt': {
    description: 'Interrupt the current main turn and continue the native queue in order, without clearing or replaying it. Background work survives and may delay the queue. The result acknowledges the request, not idle or completed execution; interrupted:false means no main turn was interrupted. Requires a loaded session; never automatically retry an uncertain result.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.literal(true), interrupted: z.boolean() }),
  },
  'session/control': {
    description: 'Apply one explicit operation to an already-loaded native handle. The controls resource supplies the handle token and native task/queue IDs. Supports scoped task cancellation/group clearing, queue removal/clearing/steering, request-bound decision cancellation and global Stop. Outcomes preserve native acceptance, no-ops, partial failures and uncertainty; acceptance is not proof that all work ended. Does not load a session, delete chat history, kill arbitrary processes or retry.',
    body: z.object({ sessionId: z.string().min(1), token: z.string().min(1), action: SessionControlAction }).strict(),
    result: SessionControlResult,
  },
  setModel: {
    description: 'Submit a complete native model selection. Omitted effort/context options retain their native meaning; the backend never backfills previous or queued settings. Genuine user changes join the native FIFO. ok acknowledges a returned native result, not application: inspect result status, deferred, confirmation, persistenceError and warnings; missing or unknown status is not proof of application. No automatic retry or follow-up is sent.',
    body: z.object({
      sessionId: z.string(),
      modelId: z.string(),
      reasoningEffort: z.string().optional(),
      contextTier: ContextTier.optional(),
    }).strict(),
    result: z.object({ ok: z.literal(true), result: NativeModelSwitchResult }),
  },
  'session/rename': {
    body: z.object({ sessionId: z.string(), name: z.string() }).strict(),
    result: z.object({ ok: z.boolean(), title: z.string().optional() }),
  },
  'session/compact': {
    description: 'Compact native model context. ok acknowledges the returned native result, not successful compaction; inspect result.success and removal counts. No automatic retry is sent.',
    body: z.object({ sessionId: z.string(), customInstructions: z.string().optional() }).strict(),
    result: z.object({ ok: z.literal(true), result: NativeCompactResult }),
  },
  'session/rewind': {
    description: 'Rewind to before a selected user message. rollbackFiles:true requests native file rollback. ok acknowledges the returned native result, not successful rewind; inspect result.outcome, eventsRemoved, restoredFiles, skippedFiles and error for partial effects. Native busy/support safeguards remain in force. Never automatically retry an uncertain or partially applied result.',
    body: z.object({ sessionId: z.string(), toMsgId: z.string(), rollbackFiles: z.boolean().optional() }).strict(),
    result: z.object({ ok: z.literal(true), result: NativeRewindResult }),
  },
  setMode: {
    description: 'Set interaction mode: interactive, plan, or autopilot. Permissions remain always auto-approved (allow-all) in every mode. ok acknowledges the returned native result, not application; inspect result.status, confirmation, deferImplementation and armInteractiveContinuation. Required native follow-up is reported, never automatically sent.',
    body: z.object({ sessionId: z.string(), mode: AgentMode }).strict(),
    result: z.object({ ok: z.literal(true), result: NativeModeSetResult }),
  },
  'session/delete': {
    description: 'IRREVERSIBLE native session deletion with native busy and existence safeguards. Cockpit does not delete workspace or unrelated files. Never automatically retry an uncertain result.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'session/unload': {
    description: 'Unload an idle native session without deleting persisted history. Empty never-messaged sessions may disappear; session/get reports actual presence. Never creates a replacement or cancels busy work.',
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'session/load': {
    description: 'Ensure the original native session is loaded using native configuration discovery. Never creates a replacement, closes an already-loaded handle, or sends a prompt. Concurrent loads coalesce. Native errors and lifecycle conflicts remain explicit; this does not resynchronize history cursors.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: z.object({ ok: z.literal(true), sessionId: z.string().min(1) }).strict(),
  },
  'session/reload': {
    description: 'Explicitly resume an unloaded session, or close and resume an existing idle loaded session using native configuration discovery. Never creates another ID or sends a message. An empty never-messaged session may disappear on close and then fail to resume; no automatic replacement. Native relative schedule delays restart on resume.',
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'session/usage': {
    description: 'Read native context attribution and accumulated usage on an already-loaded session. Never resumes, infers, compacts or scans history. Context is native tokenization of current system/messages/tool definitions; promptTokenLimit is from that same native snapshot. Last-call input/output are the latest main-agent call, not current context. Model totals are the native available aggregate; persistence and auxiliary-call coverage are not guaranteed by this adapter. Null context means uninitialized, not zero.',
    body: z.object({ sessionId: z.string().min(1) }).strict(),
    result: SessionUsage,
  },
  'session/plan': {
    body: z.object({ sessionId: z.string() }).strict(),
    result: SessionPlan,
  },
  'session/panels': {
    body: z.object({ sessionId: z.string() }).strict(),
    result: SessionPanels,
  },
  'session/panel': {
    description: 'Read one native panel section on an already-loaded session. Other sections are not read. Use session/panels to read all five sections.',
    body: z.object({ sessionId: z.string(), section: PanelSection }).strict(),
    result: z.object({ items: z.array(PanelItem) }),
  },
  respondAsk: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), answer: z.string(), wasFreeform: z.boolean() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  respondPlan: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), action: ExitPlanModeAction }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  planSupersede: {
    description: 'Return approved:false and feedback:message to the native pending plan callback. Cockpit sends no separate prompt or mode change; subsequent behavior is controlled by the native runtime.',
    body: z.object({ sessionId: z.string(), requestId: z.string(), message: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  respondElicitation: {
    body: z.object({ sessionId: z.string(), requestId: z.string(), action: z.enum(['accept', 'decline', 'cancel']) }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'queue/remove': {
    body: z.object({ sessionId: z.string(), itemId: z.string() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'session/refresh': {
    body: z.object({}).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  // Synchronous authoritative list of existing sessions. Unlike
  // session/refresh (which only nudges the SSE snapshot), this returns the data
  // in the result so the cockpit MCP can read it over plain HTTP.
  'session/list': {
    body: z.object({}).strict(),
    result: z.object({ sessions: z.array(SessionBrief) }),
  },
  // Full authoritative metadata for ONE session, unlike the narrowed SSE
  // summary. Returns the operational ids a maintainer/agent needs to
  // act (queue itemId, ask/plan/elicitation requestId), the live model/mode/status,
  // todo + attention, etc. Returns meta:null if the id isn't a known live session.
  'session/get': {
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ meta: SessionMeta.nullable() }),
  },
  'session/resources': {
    description: 'Read only requested metadata resources, without loading a session. Control includes sampled native activity flags and typed task/queue/MCP counts, not task descriptions or queue text. The separate controls resource adds active native task IDs/titles, unconsumed steering and the loaded-handle token for session/control; queue provides addressable queued items and canSteer. Null activity/controls is unavailable or invalidated, not idle; omission means not requested. loaded:false invalidates previous native fields; meta:null means unknown session. Display and tokens are not permission to delete, unload or restart; mutations independently confirm fresh safety.',
    body: z.object({ sessionId: z.string(), resources: z.array(MetaResource).min(1).max(MetaResource.options.length) }).strict(),
    result: z.object({ meta: SessionProjection.nullable() }),
  },
  'mcp/global': {
    description: 'Read Copilot native user MCP configuration and defaults without activating a session.',
    body: z.object({}).strict(),
    result: z.object({ servers: z.array(McpServerGlobal) }),
  },
  'mcp/global-default': {
    description: 'Enable or disable a server in Copilot native user configuration for future sessions. Active session connections are unchanged.',
    body: z.object({ name: z.string(), on: z.boolean() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'mcp/refresh': {
    description: 'Invalidate the native MCP configuration cache. Does not restart sessions or replay Cockpit preferences.',
    body: z.object({}).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  // Native reload updates one loaded session and re-applies global defaults.
  'mcp/reload-session': {
    description: 'Reload MCP connections on an idle loaded session through native MCP reload. Temporary session choices may revert to native global defaults. Does not load, close or replace the session.',
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ ok: z.boolean(), reconnected: z.number() }),
  },
  'mcp/session': {
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({
      loaded: z.boolean(),
      servers: z.array(McpServerSession),
    }),
  },
  'mcp/session-toggle': {
    body: z.object({ sessionId: z.string(), name: z.string(), on: z.boolean() }).strict(),
    result: McpToggleResult,
  },
  'skills/global': {
    description: 'List global skills using optional cwd; omitted cwd uses the server home directory, never an arbitrary session.',
    body: z.object({ cwd: z.string().min(1).optional() }).strict(),
    result: z.object({ skills: z.array(SkillGlobal) }),
  },
  // Read one skill's full detail incl. the raw SKILL.md file (lazy — only when its
  // detail pane opens), so the list payload stays lean. A name absent from the
  // discovered catalog fails with HTTP 404 and code SKILL_NOT_FOUND.
  'skills/read': {
    body: z.object({ name: z.string(), cwd: z.string().min(1).optional() }).strict(),
    result: SkillGlobal.extend({
      body: z.string().optional(),
    }),
  },
  'skills/session': {
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ skills: z.array(SkillSession) }),
  },
  'skills/session-toggle': {
    body: z.object({ sessionId: z.string(), name: z.string(), enabled: z.boolean() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'skills/global-toggle': {
    description: 'Enable or disable a skill in Copilot native global configuration. Optional cwd selects discovery context for project skills; persistence remains global. Does not create sessions or store a Cockpit override.',
    body: z.object({ name: z.string().min(1), enabled: z.boolean(), cwd: z.string().min(1).optional() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'skills/refresh': {
    description: 'Reload native skill definitions without restarting Cockpit.',
    body: z.object({}).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'fs/listDir': {
    description: 'List a backend directory, directories first, with its resolved path and parent. Omit path for home. Explicit empty, missing, non-directory or inaccessible paths fail without falling back to home; errors retain their code and message (400 for empty/non-directory, 404 for missing, 403 for denied access).',
    body: z.object({ path: z.string().optional() }).strict(),
    result: DirListing,
  },
  // Native after/every supports relative delays and one-shot absolute times.
  'schedule/add': {
    description: 'Schedule a native after/every prompt. The current runtime supports exactly one of interval or at, from 1 second to 24 hours. Interval uses s, m, h, or d and defaults to recurring; at is one-shot. Prompt must be single-line plain text, without command flags or a leading slash; surrounding whitespace is trimmed only after validating the original text. A returned entry establishes creation even alongside an error. possiblyCreated:true means acknowledgement/readback was inconclusive: do not automatically retry. No self-paced creation or rearming is exposed. Ticks require a loaded session; schedules pause on native idle unload and relative delays restart on resume. Schedules do not keep it loaded. This is not an always-on scheduler.',
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
    result: z.object({ ok: z.boolean(), entry: ScheduleEntry.optional(), error: z.string().optional(), possiblyCreated: z.boolean().optional() }),
  },
  'schedule/stop': {
    description: 'Stop one native schedule by its id, including self-paced entries. ok reflects whether the native stop result contained the stopped entry; false means none was returned. No list read is used to infer success and errors propagate. This does not rearm or replace the schedule.',
    body: z.object({ sessionId: z.string(), id: z.number() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
  'schedule/list': {
    description: 'Read native recurring, one-shot and self-paced schedules on an already-loaded session. selfPaced:true means the model controls each next run, with no fixed cadence; optional timing fields describe returned native entries, not additional creation options. No self-paced creation or rearming is exposed. Unloaded reads require explicit resume. Schedules do not keep sessions loaded or provide an always-on scheduler.',
    body: z.object({ sessionId: z.string() }).strict(),
    result: z.object({ entries: z.array(ScheduleEntry) }),
  },
} as const;

export type IntentName = keyof typeof Intents;
export type IntentBody<K extends IntentName> = z.infer<(typeof Intents)[K]['body']>;
export type IntentResult<K extends IntentName> = z.infer<(typeof Intents)[K]['result']>;
