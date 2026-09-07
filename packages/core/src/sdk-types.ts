// SDK type shims. The published @github/copilot/sdk runtime does NOT export the
// session-driving classes (query/Session/LocalSessionManager/AuthManager are
// declared in .d.ts but absent at runtime — PoC finding). The real surface is
// `sdk.internal.LocalSessionManager` + a few helpers, none usefully typed. We
// declare the minimal shapes WE rely on; this is the single place that knows the
// SDK is loosely typed, so the rest of core stays strict.

// A raw SDK session event: { type, data, id, timestamp, parentId }.
export interface SdkEvent {
  type: string;
  data: Record<string, unknown> & { content?: string };
  id?: string;
  timestamp?: string | number;
  parentId?: string | null;
  // Present on sub-agent events (= the spawning `task` tool's toolCallId). Absent
  // on main-agent events. Used by the fold to route sub-agent work into its card.
  agentId?: string;
}

export interface SdkSession {
  readonly sessionId: string;
  on(type: '*', handler: (ev: SdkEvent) => void): () => void;
  on(type: string, handler: (ev: SdkEvent) => void): () => void;
  getEvents(): readonly SdkEvent[];
  send(opts: { prompt: string; mode?: 'enqueue' | 'immediate' }): Promise<void>;
  respondToUserInput(requestId: string, response: { answer: string; wasFreeform: boolean }): void;
  respondToExitPlanMode?(requestId: string, response: { approved?: boolean; selectedAction?: string; feedback?: string }): void;
  respondToElicitation?(requestId: string, response: { action: 'accept' | 'decline' | 'cancel' }): void;
  getPendingQueuedMessages?(): unknown[];
  getPendingSteeringMessagesDisplayPrompt?(): ReadonlyArray<string>;
  getPendingQueuedItems?(): ReadonlyArray<{ kind: 'message' | 'command'; displayText: string }>;
  clearPendingItems?(): void;
  clearPendingMessages?(): void;
  isProcessingMessages?(): boolean;
  initializeAndValidateTools?(): Promise<void>;
  enqueueUserMessage?(opts: { prompt: string }): void;
  abort?(): Promise<void> | void;
  readonly model?: {
    switchTo(p: { modelId: string; reasoningEffort?: string; contextTier?: 'default' | 'long_context' }): Promise<unknown>;
    getCurrent(): Promise<{ modelId?: string; reasoningEffort?: string; contextTier?: 'default' | 'long_context' }>;
  };
  readonly name?: {
    get(): Promise<{ name: string | null }>;
    set(p: { name: string }): Promise<unknown>;
    setAuto(p: { summary: string }): Promise<unknown>;
  };
  readonly history?: {
    compact(p?: { customInstructions?: string }): Promise<unknown>;
    truncate(p: { eventId: string; truncateWorkspaceCheckpoint?: boolean }): Promise<unknown>;
  };
  readonly mode?: {
    get(): Promise<'interactive' | 'plan' | 'autopilot'>;
    set(p: { mode: 'interactive' | 'plan' | 'autopilot' }): Promise<unknown>;
  };
  readonly sessionFs?: {
    sessionDatabase?: {
      getTodoStatus(): Promise<{ pending: number; in_progress: number; done: number; blocked: number; total: number } | null>;
      getCurrentIntent(): Promise<string | null>;
    };
  };
  readonly plan?: {
    read(): Promise<{ content: string | null }>;
    readSqlTodos(): Promise<{ rows: { id?: string; title?: string; description?: string; status?: string }[] }>;
  };
  readonly skills?: { list(): Promise<{ skills?: Array<Record<string, unknown>> }> };
  readonly mcp?: { list(): Promise<{ servers?: Array<Record<string, unknown>> }> };
  readonly tasks?: { list(): Promise<{ tasks?: Array<Record<string, unknown>> }> };
  readonly instructions?: { getSources(): Promise<{ sources?: Array<Record<string, unknown>> }> };
  readonly schedule?: { list(): Promise<{ entries?: Array<Record<string, unknown>> }> };
  // Scheduled prompts (the SDK's `/every` + `/after`). The in-process registry owns
  // the timers and persists schedule_created/cancelled events; it rehydrates on
  // resume. The facade `schedule` (above) only lists; the registry has the full
  // add/stop surface, so cockpit drives writes through `scheduleRegistry`.
  readonly scheduleRegistry?: {
    list(): Array<Record<string, unknown>>;
    add(interval: string, prompt: string, options?: Record<string, unknown>): { entry?: Record<string, unknown>; error?: string };
    addCron(cron: string, prompt: string, options?: Record<string, unknown>): { entry?: Record<string, unknown>; error?: string };
    addAt(at: number, prompt: string, options?: Record<string, unknown>): { entry?: Record<string, unknown>; error?: string };
    stop(id: number): Record<string, unknown> | undefined;
  };
  // MCP lifecycle (verified at runtime). Connections are per-session: each session
  // owns its McpHost and spawns its own server subprocesses lazily on first use.
  ensureMcpLoaded?(): Promise<void>;
  getMcpServerSummaries?(): Array<{
    name: string;
    status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'not_configured';
    source?: string;
    error?: string;
    transport?: string;
  }>;
  enableMcpServer?(name: string): Promise<void>;
  disableMcpServer?(name: string): Promise<void>;
  getMcpHost?(): {
    stopServer?(name: string): Promise<void>;
  } | undefined;
  reloadMcpServers?(config: {
    mcpServers: Record<string, Record<string, unknown>>;
    disabledServers?: string[];
    enabledServers?: string[];
  }): Promise<unknown>;
  // Skills lifecycle (directory-scanned; per-session enable/disable, runtime-only).
  ensureSkillsLoaded?(): Promise<void>;
  clearLoadedSkills?(): void;
  enableSkill?(name: string): Promise<void> | void;
  disableSkill?(name: string): Promise<void> | void;
  isSkillDisabled?(name: string): boolean;
}

export interface SdkSessionMeta {
  sessionId: string;
  summary?: string;
  name?: string;
  startTime?: string | number;
  modifiedTime?: string | number | Date;
  context?: { cwd?: string };
}

export interface SdkSessionManager {
  listSessions(): Promise<SdkSessionMeta[]>;
  createSession(opts: Record<string, unknown>): Promise<SdkSession>;
  getSession(opts: Record<string, unknown>, resume?: boolean): Promise<SdkSession | undefined>;
  deleteSession(sessionId: string): Promise<void>;
  getSessionSizes?(): Promise<Map<string, number>>;
}
