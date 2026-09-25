/** Module-owned JSON data, never a host event envelope or a live resource. */
export type ModuleEventPayload =
  | null | boolean | number | string
  | readonly ModuleEventPayload[]
  | { readonly [key: string]: ModuleEventPayload };

/** Maximum UTF-8 byte length of a serialized module event payload. */
export const MAX_MODULE_EVENT_BYTES = 64 * 1024;

/** Request `_meta` key the host sets on every module HTTP MCP tool call. */
export const MCP_INVOCATION_META_KEY = 'cockpit/invocation';

export interface McpInvocationMeta {
  readonly sessionId: string;
  readonly runtimeSessionId: string;
  readonly subagent: boolean;
  readonly agentName?: string;
}

export type NativeAttachment =
  | { type: 'file'; path: string; displayName?: string }
  | { type: 'directory'; path: string; displayName?: string }
  | {
      type: 'selection';
      filePath: string;
      displayName: string;
      selection?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      text?: string;
    }
  | { type: 'blob'; data: string; mimeType: string; displayName?: string };

export type NativeAttachmentDescriptor =
  | Exclude<NativeAttachment, { type: 'blob' }>
  | { type: 'blob'; data?: string; mimeType: string; displayName?: string; omittedReason?: string };

export interface NativeChatEvent {
  id: string;
  type: string;
  timestamp?: string | number;
  parentId?: string | null;
  agentId?: string;
  parentToolCallId?: string;
  ephemeral?: boolean;
  data: Record<string, unknown>;
}

export type SessionStatus = 'unloaded' | 'idle' | 'running' | 'error';
export type AgentStatus = 'starting' | 'up' | 'stopping' | 'failed';
export type ContextTier = 'default' | 'long_context';
export type AgentMode = 'interactive' | 'plan' | 'autopilot';

export interface ModelOption {
  modelId: string;
  name: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsLongContext?: boolean;
}

export interface QueuedItem {
  id: string;
  text: string;
  canSteer?: boolean;
}

export interface AskRequest {
  requestId: string;
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

export type ExitPlanModeAction = 'exit_only' | 'interactive' | 'autopilot' | 'autopilot_fleet';

export interface PlanRequest {
  requestId: string;
  summary: string;
  planContent?: string;
  actions?: ExitPlanModeAction[];
  recommendedAction?: ExitPlanModeAction;
}

export interface ElicitationRequest {
  requestId: string;
  message: string;
  source?: string;
  actions?: Array<'accept' | 'decline' | 'cancel'>;
}

export type PendingDecision =
  | { kind: 'ask'; request: AskRequest }
  | { kind: 'plan'; request: PlanRequest }
  | { kind: 'elicitation'; request: ElicitationRequest };

export interface TodoProgress {
  done: number;
  total: number;
  intent: string | null;
}

export interface SessionActivity {
  sampledAt: number;
  processing: boolean;
  hasActiveWork: boolean;
  abortable: boolean;
  tasks: { activeAgents: number; activeShells: number; unknown: number };
  queue: { pendingCount: number; steeringCount: number; inFlightSteeringCount: number };
  mcp: { pendingConnectionCount: number };
}

export interface SessionControls {
  token: string;
  sampledAt: number;
  main: boolean;
  compaction: 'manual' | 'auto' | 'unknown' | null;
  tasks: Array<{
    id: string;
    kind: 'agent' | 'shell';
    title: string;
    status: 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';
  }>;
  steering: Array<{ id: string; text: string }>;
}

export interface RoleSelection {
  moduleId: string;
  roleId: string;
}

export interface SessionRole extends RoleSelection {
  name: string;
  moduleName: string;
}

export interface SessionMeta {
  roles?: SessionRole[];
  appliedRoles?: SessionRole[];
  rolesNeedReload?: boolean;
  sessionId: string;
  title: string;
  nativeName?: string | null;
  nativeNameUserSet?: boolean;
  cwd: string;
  createdAt?: number;
  lastActivity: number;
  lastActivitySource?: 'native-persisted' | 'native-construction' | 'host-event-receipt';
  status: SessionStatus;
  error?: string | null;
  currentModelId?: string;
  currentReasoningEffort?: string | null;
  currentContextTier?: ContextTier | null;
  currentMode?: AgentMode | null;
  availableModels?: ModelOption[];
  loaded: boolean;
  loading?: boolean;
  closing?: boolean;
  cancelling?: boolean;
  queue?: QueuedItem[];
  ask: AskRequest | null;
  planRequest?: PlanRequest | null;
  elicitation?: ElicitationRequest | null;
  decisions?: PendingDecision[];
  todo?: TodoProgress | null;
  intent?: string | null;
  scheduleCount?: number;
  activeSubagents?: number;
  compacting?: boolean;
  activeMcpOperations?: number;
  activeOperations?: number;
  nativeProcessing?: boolean;
  activity?: SessionActivity | null;
  controls?: SessionControls | null;
}

export type PublicSessionMeta = SessionMeta;
export type SessionResource =
  | 'identity' | 'control' | 'controls' | 'queue' | 'model' | 'models' | 'mode'
  | 'todo' | 'schedule' | 'plan' | 'skills' | 'mcp' | 'tasks' | 'instructions' | 'usage';

export interface Snapshot {
  type: 'snapshot';
  agentStatus: AgentStatus;
  models: ModelOption[];
  sessions: SessionMeta[];
  permissionPolicy: 'allow-all';
}

export type ServerEvent =
  | Snapshot
  | { type: 'module/invalidated'; moduleId: string }
  | { type: 'module/event'; moduleId: string; payload: ModuleEventPayload }
  | { type: 'agent/status'; status: AgentStatus }
  | { type: 'session/added'; session: SessionMeta }
  | { type: 'session/invalidated'; sessionId: string; resources?: SessionResource[] }
  | ({ type: 'session/patch'; sessionId: string } & Partial<SessionMeta>)
  | { type: 'session/removed'; sessionId: string }
  | { type: 'chat/invalidated'; sessionId: string; reason: 'rewind' | 'compaction' };

export interface SessionResourcesPrepare {
  sessionId: string;
  skills?: string[];
  mcpServers?: Array<{ name: string; tools?: string[] }>;
}

export type ResourcePreparationEffect = 'not_attempted' | 'unchanged' | 'enabled' | 'unconfirmed';

export interface ResourcePreparationResult {
  sessionId: string;
  ok: boolean;
  skills: Array<{ name: string; effect: ResourcePreparationEffect; enabled: boolean | null }>;
  mcpServers: Array<{
    name: string;
    effect: ResourcePreparationEffect;
    enabled: boolean | null;
    status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'stopped' | 'not_configured' | null;
    tools: string[] | null;
  }>;
  tools: 'not_attempted' | 'unchanged' | 'initialized' | 'unconfirmed';
  error?: string;
}

export interface ModuleHostIntentMap {
  'session/new': {
    body: { cwd: string; roles?: RoleSelection[] };
    result: { sessionId: string };
  };
  'session/get': {
    body: { sessionId: string };
    result: { meta: SessionMeta | null };
  };
  'session/rename': {
    body: { sessionId: string; name: string };
    result: { ok: boolean; title?: string };
  };
  'roles/readiness': {
    body: { sessionId: string; roles?: RoleSelection[] };
    result: {
      sessionId: string;
      loaded: boolean;
      ready: boolean;
      roles: SessionRole[];
      reasons: string[];
      appliedRoles?: SessionRole[];
      rolesNeedReload?: boolean;
    };
  };
  'session/resources-prepare': {
    body: SessionResourcesPrepare;
    result: ResourcePreparationResult;
  };
  prompt: {
    body: {
      sessionId: string;
      text: string;
      mode?: 'enqueue' | 'immediate';
      attachments?: NativeAttachment[];
    };
    result: { ok: boolean; queued?: boolean };
  };
}

export type ModuleHostIntent = keyof ModuleHostIntentMap;
export type ModuleHostIntentBody<Name extends ModuleHostIntent> = ModuleHostIntentMap[Name]['body'];
export type ModuleHostIntentResult<Name extends ModuleHostIntent> = ModuleHostIntentMap[Name]['result'];
