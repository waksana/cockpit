// Event folding: turn the SDK's raw event stream into our ChatMessage model.
// One browser-local fold serves persisted pages and live events. No backend
// history or control state depends on this projection.

import type { ChatMessage, ToolCall, HistoryDetails } from './index.ts';

export interface SdkEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string | number;
  parentId?: string | null;
  agentId?: string;
  parentToolCallId?: string;
  ephemeral?: boolean;
}

export interface FoldState {
  messages: ChatMessage[];
  byId: Map<string, number>; // messageId -> index in messages
  toolMsg: Map<string, string>; // observed start -> tool row ID, or '' for dedicated UI
  askToolIds: Set<string>; // toolCallIds that are ask_user prompts
  // Retained metadata and explicit legacy ownership, scoped to this fold's invocation IDs.
  toolMetadata: Map<string, { title?: string; executionTitle?: string; question?: string; legacyOwner?: true }>;
  // Child folds/cards are keyed by spawning toolCallId. Each child also remembers
  // task-registry/envelope aliases, which need not equal that toolCallId.
  subFolds: Map<string, FoldState>;
  subCard: Map<string, string>;
  agentIds: Set<string>;
  pendingTask: Map<string, { prompt?: string; description?: string; agentType?: string }>;
  // Browser-local order of child activity/terminal evidence; duplicate starts cannot supersede it.
  executionOrder?: number;
  // Native references only; content lives once in messages.
  activeResponse?: { parentId?: string; id?: string };
  responseOrder?: number;
  responses: Map<string, string | null>; // native reference -> response; null means ambiguous
  reasoning: Map<string, string>;
  completed: Set<string>;
  currentModelId?: string;
}

export function newFoldState(): FoldState {
  return {
    messages: [], byId: new Map(), toolMsg: new Map(),
    askToolIds: new Set(), toolMetadata: new Map(),
    subFolds: new Map(), subCard: new Map(), agentIds: new Set(), pendingTask: new Map(),
    responses: new Map(), reasoning: new Map(), completed: new Set(),
  };
}

export interface FoldResult {
  changed: string[]; // message ids upserted
  removed?: string[]; // pre-message thought identities replaced by their native message ID
  nestedChanged?: string[];
  metaChanged: boolean;
  missingOwner?: boolean;
  // Identity retirement is scoped; a child can reuse the root's native IDs.
  reconciled?: { fold: FoldState; ids: string[] }[];
}

export interface FoldProjection {
  eventOrder?: number;
  toolOutput?: string;
  toolArgs?: string;
  askAnswer?: string;
  askQuestion?: string;
  scope?: FoldHistoryScope;
  strictOwnership?: boolean;
}

export interface FoldHistoryScope {
  details: HistoryDetails;
}

function tsOf(ev: { timestamp?: string | number }): number {
  if (typeof ev.timestamp === 'number') return ev.timestamp;
  if (typeof ev.timestamp === 'string') {
    const t = Date.parse(ev.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function upsert(state: FoldState, msg: ChatMessage): void {
  const idx = state.byId.get(msg.id);
  if (idx === undefined) {
    state.byId.set(msg.id, state.messages.length);
    state.messages.push(msg);
  } else {
    state.messages[idx] = msg;
  }
}

interface FoldRoute { fold: FoldState; cards: ChatMessage[] }

function findRoute(state: FoldState, owns: (fold: FoldState) => boolean): FoldRoute | undefined {
  if (owns(state)) return { fold: state, cards: [] };
  for (const [tcId, sub] of state.subFolds) {
    const route = findRoute(sub, owns);
    const card = subCardMsg(state, tcId);
    if (route && card) return { fold: route.fold, cards: [card, ...route.cards] };
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function ensureStreaming(state: FoldState, id: string, ts: number): ChatMessage {
  const idx = state.byId.get(id);
  if (idx !== undefined) {
    const existing = state.messages[idx];
    if (existing) {
      return existing;
    }
  }
  const msg: ChatMessage = {
    id, role: 'assistant', content: '', timestamp: ts,
  };
  upsert(state, msg);
  return msg;
}

// End the active response lifecycle, retaining content and exact native links.
export function resetTurn(state: FoldState): void {
  state.activeResponse = undefined;
}

const endTurn = resetTurn;

function responseFor(state: FoldState, ev: SdkEvent): string | undefined {
  const parent = stringOf(ev.parentId);
  if (!parent) return undefined;
  const key = `${ev.type === 'assistant.reasoning' ? 'event' : 'turn'}:${parent}`;
  if (state.responses.has(key)) return state.responses.get(key) ?? undefined;
  const active = state.activeResponse;
  return active && parent === active.parentId ? active.id : undefined;
}

function bindResponse(state: FoldState, ev: SdkEvent, id: string): string[] {
  const previous = responseFor(state, ev);
  const removed: string[] = [];
  if (previous && previous !== id && !state.completed.has(previous)
    && previous.startsWith('reasoning-') && !state.byId.has(id)) {
    const index = state.byId.get(previous);
    if (index !== undefined && !state.messages[index]!.content) {
      state.messages[index]!.id = id;
      delete state.messages[index]!.incomplete;
      state.byId.delete(previous);
      state.byId.set(id, index);
      removed.push(previous);
      for (const [key, value] of state.reasoning) if (value === previous) state.reasoning.set(key, id);
      for (const [key, value] of state.responses) if (value === previous) state.responses.set(key, id);
    }
  }
  const parentId = stringOf(ev.parentId);
  state.activeResponse = { parentId, id };
  if (parentId) {
    const key = `turn:${parentId}`;
    const existing = state.responses.get(key);
    state.responses.set(key, existing === undefined || existing === id ? id : null);
  }
  return removed;
}

// Get the sub-agent card message (by toolCallId) from this fold, if it exists.
function subCardMsg(state: FoldState, toolCallId: string): ChatMessage | undefined {
  const cardId = state.subCard.get(toolCallId);
  if (cardId === undefined) return undefined;
  const idx = state.byId.get(cardId);
  return idx === undefined ? undefined : state.messages[idx];
}

interface ToolRequest {
  toolCallId?: string; name?: string; arguments?: unknown;
  intentionSummary?: unknown; description?: unknown; toolTitle?: unknown;
}

export function nativeToolTitle(data: Record<string, unknown>): string | undefined {
  return stringOf(data.intentionSummary) ?? stringOf(data.description) ?? stringOf(data.toolTitle);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

// Only affirmative persisted ask results become user bubbles. Native choice
// answers use "User selected:", freeform/old journals use "User responded:".
export function askAnswerOf(data: Record<string, unknown>): string {
  const result = data.result;
  const outcome = recordOf(recordOf(data.toolTelemetry).properties).outcome;
  if (data.success === false || data.error != null || data.dismissed === true
    || (typeof outcome === 'string' && outcome !== 'answered')) return '';
  if (!result || typeof result !== 'object') return '';
  const r = recordOf(result);
  if (r.dismissed === true || r.error != null || r.isError === true || r.success === false) return '';
  for (const raw of [r.content, r.detailedContent]) {
    if (typeof raw !== 'string') continue;
    const answer = /^User (?:responded|selected):\s*([\s\S]*)$/.exec(raw.trim());
    if (answer) return (answer[1] ?? '').trim();
  }
  return '';
}

const TOOL_DETAIL_CAP = 3000;

function cap(s: string): string {
  return s.length <= TOOL_DETAIL_CAP ? s : `${s.slice(0, TOOL_DETAIL_CAP)}\n…（已截断，共 ${s.length} 字符）`;
}

// Generic tool result → output text, capped. Used for the collapsible detail of
// any tool that produces output (bash/view/grep/glob/web_fetch/…).
export function toolOutputOf(result: unknown, error?: unknown): string {
  const r = recordOf(result);
  const raw = (typeof r.content === 'string' && r.content)
    || (typeof r.detailedContent === 'string' && r.detailedContent) || '';
  const failure = stringOf(recordOf(error).message);
  return raw ? cap(raw) : failure ? cap(failure) : '';
}

// Ordinary inputs share one serialization; native decisions keep their dedicated UI.
export function toolArgsOf(name: string | undefined, args: unknown): string {
  if (args == null || name === 'ask_user') return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  return text && text !== '{}' ? cap(text) : '';
}

function rememberToolMetadata(
  state: FoldState, toolCallId: string, data: Record<string, unknown>, question?: string, execution = false,
): string[] {
  const previous = state.toolMetadata.get(toolCallId) ?? {};
  const title = nativeToolTitle(data);
  if (!title && !question) return [];
  const metadata = { ...previous, ...(title ? execution ? { executionTitle: title } : { title } : {}),
    ...(question ? { question } : {}) };
  state.toolMetadata.set(toolCallId, metadata);
  const changed: string[] = [];
  const toolMessage = state.messages[state.byId.get(`tool-${toolCallId}`) ?? -1];
  const tool = toolMessage?.toolCalls?.[0];
  const resolvedTitle = metadata.executionTitle ?? metadata.title;
  if (tool && resolvedTitle && tool.title !== resolvedTitle) {
    tool.title = resolvedTitle;
    changed.push(toolMessage.id);
  }
  const reply = state.messages[state.byId.get(`reply-${toolCallId}`) ?? -1];
  if (reply && metadata.question && reply.replyQuestion !== metadata.question) {
    reply.replyQuestion = metadata.question;
    changed.push(reply.id);
  }
  return changed;
}

function routeEvent(state: FoldState, ev: SdkEvent): FoldRoute | undefined {
  const d = ev.data ?? {};
  const lifecycle = ev.type === 'subagent.started' || ev.type === 'subagent.completed'
    || ev.type === 'subagent.failed' || ev.type === 'subagent.configured';
  const tcId = stringOf(d.toolCallId);
  const eventAgent = ev.agentId ?? stringOf(d.agentId);
  // parentAgentTaskId also appears on ordinary root user turns; it is not
  // subagent routing metadata. Only explicit event/tool ownership is reliable.
  const legacyOwner = stringOf(d.parentToolCallId) ?? ev.parentToolCallId;
  const agentRoute = (id: string | undefined) => id
    ? findRoute(state, (s) => s.agentIds.has(id)) : undefined;
  let route: FoldRoute | undefined;
  if (lifecycle) {
    // Lifecycle events describe the child, but must be folded by its parent.
    route = tcId ? findRoute(state, (s) => s.pendingTask.has(tcId) || s.subCard.has(tcId)) : undefined;
    if (!route && ev.type === 'subagent.started') {
      const parent = stringOf(d.parentId) ?? legacyOwner;
      route = parent ? agentRoute(parent) : agentRoute(eventAgent) ?? { fold: state, cards: [] };
    } else if (!route) {
      route = findRoute(state, (s) => [...s.subFolds.values()]
        .some((sub) => !!eventAgent && sub.agentIds.has(eventAgent)));
    }
  } else {
    route = agentRoute(eventAgent) ?? agentRoute(legacyOwner);
    if (!route && !eventAgent && !legacyOwner) {
      // Only legacy starts establish an ownerless completion relationship.
      // Modern agent-scoped starts must never lend their questions to root work.
      if (ev.type === 'tool.execution_complete' && tcId && !state.toolMsg.has(tcId)
        && !state.toolMetadata.has(tcId) && !state.askToolIds.has(tcId)) {
        const legacy = findRoute(state, fold => fold.toolMetadata.get(tcId)?.legacyOwner === true);
        if (legacy && !findRoute(state, fold => fold !== legacy.fold
          && fold.toolMetadata.get(tcId)?.legacyOwner === true)) route = legacy;
      }
      route ??= { fold: state, cards: [] };
    }
    // Legacy ownership can establish the native registry ID before it is seen
    // on a lifecycle event. Never infer ownership from the journal parentId.
    if (route && eventAgent && legacyOwner && !agentRoute(eventAgent)) {
      route.fold.agentIds.add(eventAgent);
    }
  }
  return route;
}

function visibleRoute(route: FoldRoute, scope: FoldHistoryScope): boolean {
  return scope.details === 'full' || route.cards.length === 0;
}

function rememberTask(state: FoldState, request: ToolRequest, scope?: FoldHistoryScope): void {
  if (request.name !== 'task' || typeof request.toolCallId !== 'string') return;
  const a = recordOf(request.arguments);
  state.pendingTask.set(request.toolCallId, {
    ...(typeof a.prompt === 'string' && (!scope || scope.details === 'full')
      ? { prompt: a.prompt } : {}),
    ...(typeof a.description === 'string' ? { description: a.description } : {}),
    ...(typeof a.agent_type === 'string' ? { agentType: a.agent_type } : {}),
  });
}

function isExecutionActivity(ev: SdkEvent): boolean {
  if (ev.ephemeral) return false;
  if (ev.type === 'user.message') return !!ev.data.content
    && !(typeof ev.data.source === 'string' && ev.data.source.startsWith('skill-'));
  return ['assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'assistant.reasoning',
    'tool.execution_start', 'tool.execution_complete'].includes(ev.type);
}

export function foldEvent(state: FoldState, ev: SdkEvent, projection?: FoldProjection): FoldResult {
  const route = routeEvent(state, ev);
  if (projection?.strictOwnership && typeof ev.data.toolCallId === 'string') {
    if (ev.type === 'subagent.started' && (!route
      || !findRoute(state, s => s.pendingTask.has(String(ev.data.toolCallId)) || s.subCard.has(String(ev.data.toolCallId))))) {
      return { changed: [], metaChanged: false, missingOwner: true };
    }
  }
  // Bounded history can omit a spawning task. Unknown agent work is not main work.
  if (!route) return { changed: [], metaChanged: false };
  if (ev.type === 'tool.execution_start' && typeof ev.data.toolCallId === 'string'
    && (stringOf(ev.data.parentToolCallId) || stringOf(ev.parentToolCallId))) {
    const id = ev.data.toolCallId;
    route.fold.toolMetadata.set(id, { ...route.fold.toolMetadata.get(id), legacyOwner: true });
  }
  if (projection?.scope && !visibleRoute(route, projection.scope) && !ev.type.startsWith('subagent.')) {
    if (ev.type === 'assistant.message' && Array.isArray(ev.data.toolRequests)) {
      for (const request of ev.data.toolRequests as ToolRequest[]) {
        rememberTask(route.fold, request, projection.scope);
      }
    }
    if (ev.type === 'tool.execution_start' && typeof ev.data.toolCallId === 'string') {
      route.fold.toolMsg.set(ev.data.toolCallId, '');
      rememberTask(route.fold, { toolCallId: ev.data.toolCallId,
        name: stringOf(ev.data.toolName), arguments: ev.data.arguments }, projection.scope);
    }
    return { changed: [], metaChanged: false };
  }
  const child = route.cards.at(-1)?.subagent;
  let executionChanged = false;
  if (child && isExecutionActivity(ev)) {
    route.fold.executionOrder = projection?.eventOrder;
    if (child.status !== 'running' && child.status !== 'activity') {
      child.status = 'activity';
      delete child.error;
      executionChanged = true;
    }
  }
  const result = foldLocalEvent(route.fold, ev, projection);
  if ((result.changed.length || result.removed?.length || executionChanged) && route.cards[0]) {
    return { changed: [route.cards[0].id], metaChanged: result.metaChanged,
      nestedChanged: [...route.cards.map(card => card.id), ...result.changed, ...result.nestedChanged ?? []],
      ...(result.removed?.length ? { removed: result.removed } : {}),
      ...(result.reconciled ? { reconciled: result.reconciled } : {}) };
  }
  return result;
}

function foldLocalEvent(state: FoldState, ev: SdkEvent, projection?: FoldProjection): FoldResult {
  const empty: FoldResult = { changed: [], metaChanged: false };
  const d = ev.data ?? {};
  if (['assistant.turn_start', 'assistant.turn_end', 'assistant.idle', 'session.idle',
    'abort', 'user.message', 'assistant.message_start', 'assistant.message'].includes(ev.type)) {
    state.responseOrder = projection?.eventOrder;
  }

  if (ev.type === 'subagent.started') {
    const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : (ev.agentId ?? '');
    if (!toolCallId) return empty;
    const cardId = `subagent-${toolCallId}`;
    const task = state.pendingTask.get(toolCallId);
    const sub = state.subFolds.get(toolCallId) ?? newFoldState();
    sub.agentIds.add(toolCallId);
    if (ev.agentId && !state.agentIds.has(ev.agentId)) sub.agentIds.add(ev.agentId);
    if (typeof d.agentId === 'string' && !state.agentIds.has(d.agentId)) sub.agentIds.add(d.agentId);
    const previous = subCardMsg(state, toolCallId);
    const card: ChatMessage = {
      id: cardId, role: 'assistant', subtype: 'subagent', content: '', timestamp: previous?.timestamp ?? tsOf(ev),
      subagent: {
        ...previous?.subagent,
        toolCallId,
        agentId: typeof d.agentId === 'string' && !state.agentIds.has(d.agentId) ? d.agentId
          : ev.agentId && !state.agentIds.has(ev.agentId) ? ev.agentId : toolCallId,
        name: typeof d.agentName === 'string' ? d.agentName : (task?.agentType ?? 'agent'),
        displayName: typeof d.agentDisplayName === 'string' ? d.agentDisplayName : '子代理',
        ...(typeof d.agentDescription === 'string' ? { description: d.agentDescription } : (task?.description ? { description: task.description } : {})),
        ...(typeof d.model === 'string' ? { model: d.model } : {}),
        status: previous?.subagent?.status ?? 'running',
        ...(task?.prompt ? { prompt: task.prompt } : {}),
      },
      ...(projection?.scope?.details === 'summary' ? {} : { subMessages: sub.messages }),
    };
    state.subFolds.set(toolCallId, sub);
    state.subCard.set(toolCallId, cardId);
    upsert(state, card);
    return { changed: [cardId], metaChanged: false };
  }
  if (ev.type === 'subagent.completed' || ev.type === 'subagent.failed' || ev.type === 'subagent.configured') {
    const toolCallId = stringOf(d.toolCallId)
      ?? [...state.subFolds].find(([, sub]) => !!ev.agentId && sub.agentIds.has(ev.agentId))?.[0] ?? '';
    const card = subCardMsg(state, toolCallId);
    if (!card?.subagent) return empty;
    if (ev.type !== 'subagent.configured') {
      card.subagent.status = ev.type === 'subagent.failed' ? 'failed'
        : d.cancelled === true ? 'cancelled' : 'completed';
      delete card.subagent.error;
      const sub = state.subFolds.get(toolCallId);
      if (sub) {
        sub.executionOrder = projection?.eventOrder;
        endTurn(sub);
      }
    }
    if (typeof d.model === 'string') card.subagent.model = d.model;
    if (typeof d.totalToolCalls === 'number') card.subagent.toolCount = d.totalToolCalls;
    if (typeof d.error === 'string') card.subagent.error = d.error;
    return { changed: [card.id], metaChanged: false };
  }
  // subagent.selected/deselected carry agent metadata but no per-event work to fold.
  if (ev.type === 'subagent.selected' || ev.type === 'subagent.deselected') return empty;

  switch (ev.type) {
    case 'assistant.turn_end':
    case 'assistant.idle':
    case 'session.idle':
    case 'abort': {
      endTurn(state);
      return empty;
    }
    case 'assistant.turn_start': {
      endTurn(state);
      state.activeResponse = { parentId: ev.id };
      return empty;
    }

    case 'user.message': {
      const content = typeof d.content === 'string' ? d.content : '';
      if (!content) return empty;
      // Skill-context injections arrive as a `user.message` whose `source` is
      // `skill-<name>` and whose body is the entire SKILL.md wrapped in
      // <skill-context>. That's machinery, not a user turn — rendering it as a
      // user bubble dumps a wall of text. The activation is surfaced compactly by
      // the `skill.invoked` event instead (CLI-style skill pill), so drop this.
      const source = typeof d.source === 'string' ? d.source : '';
      if (source.startsWith('skill-')) return empty;
      endTurn(state);
      const id = ev.id ?? `u-${state.messages.length}`;
      upsert(state, { id, role: 'user', content, timestamp: tsOf(ev) });
      return { changed: [id], metaChanged: false };
    }

    case 'skill.invoked': {
      // A skill was activated (agent- or user-invoked). Surface it as a compact
      // CLI-style pill — name only — not the injected content (suppressed above)
      // nor the redundant `skill` tool row (filtered below). Stable id by name +
      // path keeps the upsert idempotent across replays.
      const name = typeof d.name === 'string' ? d.name : '';
      if (!name) return empty;
      const id = ev.id ?? `skill-${name}-${state.messages.length}`;
      upsert(state, { id, role: 'system', subtype: 'skill', content: name, timestamp: tsOf(ev) });
      return { changed: [id], metaChanged: false };
    }

    case 'assistant.reasoning_delta':
    case 'assistant.reasoning': {
      const rid = stringOf(d.reasoningId) ?? ev.id ?? `segment-${state.messages.length}`;
      const full = ev.type === 'assistant.reasoning';
      const content = typeof (full ? d.content : d.deltaContent) === 'string'
        ? (full ? d.content : d.deltaContent) as string : '';
      if (!content) return empty;
      const previous = state.reasoning.get(rid);
      const referenced = responseFor(state, ev);
      const orphan = previous ? state.messages[state.byId.get(previous) ?? -1] : undefined;
      const linked = (full && orphan?.incomplete ? referenced : undefined) ?? previous ?? referenced;
      const removed: string[] = [];
      if (full && referenced && orphan?.incomplete && previous !== referenced) {
        state.messages.splice(state.byId.get(previous!)!, 1);
        state.byId = new Map(state.messages.map((message, index) => [message.id, index]));
        state.completed.delete(previous!);
        removed.push(previous!);
      }
      if (!full && linked && state.completed.has(linked)) return empty;
      const id = linked ?? `reasoning-${rid}`;
      const m = ensureStreaming(state, id, tsOf(ev));
      state.reasoning.set(rid, id);
      const parentId = stringOf(ev.parentId);
      if (!linked && !full && parentId && !state.responses.has(`turn:${parentId}`)) {
        state.responses.set(`turn:${parentId}`, id);
        if (state.activeResponse?.parentId === parentId) state.activeResponse.id = id;
        else m.incomplete = '缺少可关联的原生响应记录';
      } else if (!linked) {
        m.incomplete = '缺少可关联的原生响应记录';
      }
      if (!full && parentId && state.responses.get(`turn:${parentId}`) === id) m.thoughtKey ??= parentId;
      m.thought = full ? content : (m.thought ?? '') + content;
      if (full && m.incomplete) m.timestamp = tsOf(ev);
      if (full) state.completed.add(id);
      return { changed: [id], removed, metaChanged: false,
        ...(full ? { reconciled: [{ fold: state, ids: [`reasoning-${rid}`] }] } : {}) };
    }

    case 'assistant.message_start': {
      const mid = (typeof d.messageId === 'string' && d.messageId) || ev.id || `a-${state.messages.length}`;
      if (state.completed.has(mid)) return empty;
      const removed = bindResponse(state, ev, mid);
      return { changed: removed.length ? [mid] : [], removed, metaChanged: false };
    }

    case 'assistant.message_delta': {
      const mid = typeof d.messageId === 'string' ? d.messageId : '';
      const delta = typeof d.deltaContent === 'string' ? d.deltaContent : '';
      if (!mid || !delta || state.completed.has(mid)) return empty;
      const removed = bindResponse(state, ev, mid);
      const m = ensureStreaming(state, mid, tsOf(ev));
      m.content += delta;
      return { changed: [m.id], removed, metaChanged: false };
    }

    case 'assistant.message': {
      const mid = (typeof d.messageId === 'string' && d.messageId) || ev.id || `a-${state.messages.length}`;
      const id = mid;
      const content = typeof d.content === 'string' ? d.content : '';
      const reqs = Array.isArray(d.toolRequests) ? (d.toolRequests as ToolRequest[]) : [];
      const changed: string[] = [];
      const removed = bindResponse(state, ev, id);
      const previous = state.messages[state.byId.get(id) ?? -1];
      const thought = typeof d.reasoningText === 'string' ? d.reasoningText : previous?.thought;
      const parentId = stringOf(ev.parentId);
      const thoughtKey = previous?.thoughtKey
        ?? (thought !== undefined && parentId && state.responses.get(`turn:${parentId}`) === id ? parentId : undefined);
      if (content || thought) {
        upsert(state, { id, role: 'assistant', content, ...(thought !== undefined ? { thought } : {}),
          ...(thoughtKey ? { thoughtKey } : {}), timestamp: tsOf(ev) });
        changed.push(id);
      } else if (previous) {
        state.messages.splice(state.byId.get(id)!, 1);
        state.byId = new Map(state.messages.map((message, index) => [message.id, index]));
        removed.push(id);
      }
      if (ev.id) state.responses.set(`event:${ev.id}`, id);
      state.completed.add(id);
      const reconciled = [...state.reasoning].filter(([, response]) => response === id)
        .map(([rid]) => `reasoning-${rid}`);
      for (const r of reqs) {
        if (!r || typeof r.toolCallId !== 'string') continue;
        rememberTask(state, r, projection?.scope);
        if (r.name === 'ask_user') state.askToolIds.add(r.toolCallId);
        changed.push(...rememberToolMetadata(state, r.toolCallId, { ...r },
          r.name === 'ask_user' ? stringOf(recordOf(r.arguments).question) : undefined));
      }
      endTurn(state);
      return { changed, ...(removed.length ? { removed } : {}),
        reconciled: [{ fold: state, ids: reconciled }],
        metaChanged: false };
    }

    // The callback/request lifecycle belongs to Engine. Only the durable tool
    // result is an answer; user_input.completed is ephemeral and may be empty.
    case 'user_input.requested': {
      const toolCallId = stringOf(d.toolCallId);
      if (!toolCallId) return empty;
      state.askToolIds.add(toolCallId);
      return { changed: rememberToolMetadata(state, toolCallId, {}, stringOf(d.question)), metaChanged: false };
    }

    case 'tool.execution_start':
    case 'tool.execution_complete': {
      const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : '';
      if (!toolCallId) return empty;
      const start = ev.type === 'tool.execution_start';
      const name = start ? stringOf(d.toolName) : undefined;
      if (name === 'ask_user') state.askToolIds.add(toolCallId);
      const changed = start ? rememberToolMetadata(state, toolCallId, d,
        name === 'ask_user' ? projection?.askQuestion ?? stringOf(recordOf(d.arguments).question) : undefined, true) : [];
      const msgId = `tool-${toolCallId}`;
      const previous = state.messages[state.byId.get(msgId) ?? -1];
      const oldTool = previous?.toolCalls?.[0];
      if (start) {
        rememberTask(state, { toolCallId, name, arguments: d.arguments }, projection?.scope);
        state.toolMsg.set(toolCallId, msgId);
      }
      const hidden = start && ['task', 'skill', 'exit_plan_mode'].includes(name ?? '')
        || state.pendingTask.has(toolCallId)
        || (!start && state.toolMsg.has(toolCallId) && !previous);
      if (hidden) {
        state.toolMsg.set(toolCallId, '');
        return empty;
      }
      const args = start ? projection?.toolArgs ?? toolArgsOf(name, d.arguments) : undefined;
      const metadata = state.toolMetadata.get(toolCallId);
      const tc: ToolCall = start ? {
        toolCallId, title: metadata?.executionTitle ?? metadata?.title ?? name ?? '缺少工具名称',
        ...(name ? { name } : {}),
        ...(args ? { args } : {}),
        status: oldTool?.status === 'completed' || oldTool?.status === 'failed' ? oldTool.status : 'in_progress',
        ...(oldTool?.output ? { output: oldTool.output } : {}),
      } : {
        ...(oldTool ?? { toolCallId, title: metadata?.executionTitle ?? metadata?.title ?? '缺少工具开始记录' }),
        status: d.success === false || d.error != null ? 'failed' : d.success === true ? 'completed' : undefined,
      };
      upsert(state, { id: msgId, role: 'assistant', content: '', timestamp: previous?.timestamp ?? tsOf(ev), toolCalls: [tc] });
      changed.push(msgId);
      // Attach the (capped) tool output to the collapsible detail for ALL tools
      // (except ask_user, whose answer becomes its own reply bubble below).
      if (tc && ev.type === 'tool.execution_complete' && !state.askToolIds.has(toolCallId)) {
        const out = projection?.toolOutput ?? toolOutputOf(d.result, d.error);
        if (out) tc.output = out;
      }
      // ask_user completion: surface the user's answer as a visible "my reply"
      // bubble. The result content is persisted (survives reload via getEvents),
      // so this is authoritative and identical for live + replay. Stable id keeps
      // the upsert idempotent across replays.
      if (ev.type === 'tool.execution_complete' && state.askToolIds.has(toolCallId)) {
        const answer = projection?.askAnswer ?? askAnswerOf(d);
        if (answer) {
          const replyId = `reply-${toolCallId}`;
          upsert(state, { id: replyId, role: 'user', subtype: 'ask-reply', content: answer, timestamp: tsOf(ev),
            ...(metadata?.question ? { replyQuestion: metadata.question } : {}) });
          changed.push(replyId);
        }
      }
      return { changed, metaChanged: false };
    }

    case 'session.model_change': {
      const m = typeof d.newModel === 'string' ? d.newModel : undefined;
      if (m && m !== state.currentModelId) { state.currentModelId = m; return { changed: [], metaChanged: true }; }
      return empty;
    }

    case 'session.error':
    case 'session.warning': {
      // Surface runtime errors/warnings as system-message bubbles in the thread
      // (these are persisted in the event log, so they replay on reload). Stable
      // id keeps the upsert idempotent.
      const message = typeof d.message === 'string' ? d.message : '';
      if (!message) return empty;
      const level = ev.type === 'session.error' ? 'error' : 'warning';
      const id = ev.id ?? `${level}-${state.messages.length}`;
      upsert(state, { id, role: 'system', level, content: message, timestamp: tsOf(ev) });
      return { changed: [id], metaChanged: false };
    }

    default:
      return empty;
  }
}
