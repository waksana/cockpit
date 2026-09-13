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
  toolMsg: Map<string, string>; // toolCallId -> messageId that owns it
  askToolIds: Set<string>; // toolCallIds that are ask_user prompts
  // Child folds/cards are keyed by spawning toolCallId. Each child also remembers
  // task-registry/envelope aliases, which need not equal that toolCallId.
  subFolds: Map<string, FoldState>;
  subCard: Map<string, string>;
  agentIds: Set<string>;
  pendingTask: Map<string, { prompt?: string; description?: string; agentType?: string }>;
  // Browser-local order of child activity/terminal evidence; duplicate starts cannot supersede it.
  executionOrder?: number;
  // Stream scratch is separate from the independently anchored display records.
  streamingId?: string;
  // Reference to the latest reasoning row, not a second copy of its content.
  pendingReasoning?: ChatMessage;
  reasoningId?: string;
  reasoningIds: string[];
  finalReasoning: Set<string>;
  messageReasoning: Map<string, string[]>;
  currentModelId?: string;
}

export function newFoldState(): FoldState {
  return {
    messages: [], byId: new Map(), toolMsg: new Map(),
    askToolIds: new Set(),
    subFolds: new Map(), subCard: new Map(), agentIds: new Set(), pendingTask: new Map(),
    reasoningIds: [], finalReasoning: new Set(), messageReasoning: new Map(),
  };
}

export interface FoldResult {
  changed: string[]; // message ids upserted
  removed?: string[]; // transient/fallback rows superseded by durable records
  nestedChanged?: string[];
  metaChanged: boolean;
  missingOwner?: boolean;
}

export interface FoldProjection {
  eventOrder?: number;
  toolOutput?: string;
  toolArgs?: Map<string, string>;
  askAnswer?: string;
  scope?: FoldHistoryScope;
  strictOwnership?: boolean;
}

export interface FoldHistoryScope {
  details: HistoryDetails;
  toolCallId?: string;
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

// Body updates never adopt reasoning or tool rows.
function ensureStreaming(state: FoldState, id: string, ts: number): ChatMessage {
  state.streamingId = id;
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

function reasoningMsg(state: FoldState, rid: string, ts: number): ChatMessage {
  const id = `reasoning-${rid}`;
  const index = state.byId.get(id);
  const message = index === undefined
    ? { id, role: 'assistant' as const, content: '', timestamp: ts }
    : state.messages[index]!;
  upsert(state, message);
  state.pendingReasoning = message;
  state.reasoningId = rid;
  if (!state.reasoningIds.includes(id)) state.reasoningIds.push(id);
  return message;
}

function removeMessages(state: FoldState, ids: Set<string>): void {
  if (!ids.size) return;
  for (let index = state.messages.length - 1; index >= 0; index--) {
    if (ids.has(state.messages[index]!.id)) state.messages.splice(index, 1);
  }
  state.byId = new Map(state.messages.map((message, index) => [message.id, index]));
}

// Reset active accumulators without discarding the readable partial records.
export function resetTurn(state: FoldState): void {
  state.streamingId = undefined;
  state.pendingReasoning = undefined;
  state.reasoningId = undefined;
  state.reasoningIds = [];
}

const endTurn = resetTurn;

// Get the sub-agent card message (by toolCallId) from this fold, if it exists.
function subCardMsg(state: FoldState, toolCallId: string): ChatMessage | undefined {
  const cardId = state.subCard.get(toolCallId);
  if (cardId === undefined) return undefined;
  const idx = state.byId.get(cardId);
  return idx === undefined ? undefined : state.messages[idx];
}

interface ToolRequest { toolCallId?: string; name?: string; arguments?: unknown; description?: string; intentionSummary?: string; toolTitle?: string }

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

export function cleanSessionTitle(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed.split('\n')[0]?.trim() ?? '';
}

// Format a tool's arguments into a readable, capped one-or-few-line detail (the
// "what" behind the intent): `$ cmd` for bash, the path/range for view, a mini
// diff for edit, the pattern for grep/glob, etc. Empty ⇒ no args detail.
export function toolArgsOf(name: string | undefined, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  // ask_user has its own pending-card + reply bubble; don't duplicate its
  // question/choices as a redundant tool detail.
  if (name === 'ask_user') return '';
  const a = args as Record<string, unknown>;
  const s = (k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  let out = '';
  switch (name) {
    case 'bash': out = s('command') ? `$ ${s('command')}` : ''; break;
    case 'view': {
      const p = s('path'); const r = Array.isArray(a.view_range) ? (a.view_range as unknown[]) : null;
      out = p ? (r && r.length === 2 ? `${p} [${r[0]}-${r[1]}]` : p) : '';
      break;
    }
    case 'grep': out = s('pattern') ? `grep: ${s('pattern')}${s('paths') ? `  @ ${s('paths')}` : ''}` : ''; break;
    case 'glob': out = s('pattern') ? `glob: ${s('pattern')}` : ''; break;
    case 'web_fetch': out = s('url') ?? ''; break;
    case 'edit': {
      const parts: string[] = [];
      if (s('path')) parts.push(s('path') as string);
      if (s('old_str') !== undefined) parts.push(`- ${s('old_str')}`);
      if (s('new_str') !== undefined) parts.push(`+ ${s('new_str')}`);
      out = parts.join('\n');
      break;
    }
    case 'create': out = [s('path'), s('file_text')].filter(Boolean).join('\n'); break;
    default: {
      try { const j = JSON.stringify(a); out = j && j !== '{}' ? j : ''; } catch { out = ''; }
    }
  }
  return out ? cap(out) : '';
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
      route = tcId && ev.type.startsWith('tool.')
        ? findRoute(state, (s) => s.toolMsg.has(tcId)) : undefined;
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
  if (!scope.toolCallId) return scope.details === 'full' || route.cards.length === 0;
  return route.fold.agentIds.has(scope.toolCallId)
    || (scope.details === 'full' && route.cards.some(card => card.id === `subagent-${scope.toolCallId}`));
}

/** Scope content before retaining a passive event; routing remains the canonical fold's. */
export function isFoldContentVisible(state: FoldState, ev: SdkEvent, scope: FoldHistoryScope): boolean {
  const route = routeEvent(state, ev);
  return !!route && visibleRoute(route, scope);
}

function rememberTask(state: FoldState, request: ToolRequest, scope?: FoldHistoryScope): void {
  if (request.name !== 'task' || typeof request.toolCallId !== 'string') return;
  const a = recordOf(request.arguments);
  state.pendingTask.set(request.toolCallId, {
    ...(typeof a.prompt === 'string' && (!scope || scope.details === 'full' || scope.toolCallId === request.toolCallId)
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
    const id = ev.data.toolCallId;
    if (ev.type === 'subagent.started' && !findRoute(state, s => s.pendingTask.has(id) || s.subCard.has(id))) {
      return { changed: [], metaChanged: false, missingOwner: true };
    }
    const explicitlyRouted = !!(ev.agentId || ev.parentToolCallId
      || stringOf(ev.data.agentId) || stringOf(ev.data.parentToolCallId));
    const visible = !!route && (!projection.scope || visibleRoute(route, projection.scope));
    if (ev.type.startsWith('tool.') && !findRoute(state, s => s.toolMsg.has(id))
      && (!explicitlyRouted || visible)) {
      return { changed: [], metaChanged: false, missingOwner: true };
    }
  }
  // Bounded history can omit a spawning task. Unknown agent work is not main work.
  if (!route) return { changed: [], metaChanged: false };
  if (projection?.scope && !visibleRoute(route, projection.scope) && !ev.type.startsWith('subagent.')) {
    if (ev.type === 'assistant.message' && Array.isArray(ev.data.toolRequests)) {
      for (const request of ev.data.toolRequests as ToolRequest[]) {
        rememberTask(route.fold, request, projection.scope);
        if (typeof request.toolCallId === 'string') route.fold.toolMsg.set(request.toolCallId, '');
      }
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
      ...(result.removed?.length ? { removed: result.removed } : {}) };
  }
  return result;
}

function foldLocalEvent(state: FoldState, ev: SdkEvent, projection?: FoldProjection): FoldResult {
  const empty: FoldResult = { changed: [], metaChanged: false };
  const d = ev.data ?? {};

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
    case 'abort':
    case 'assistant.turn_start': {
      endTurn(state);
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

    case 'assistant.reasoning_delta': {
      const rid = stringOf(d.reasoningId) ?? ev.id ?? `segment-${state.messages.length}`;
      const delta = typeof d.deltaContent === 'string' ? d.deltaContent : '';
      if (!delta || state.finalReasoning.has(`reasoning-${rid}`)) return empty;
      const m = reasoningMsg(state, rid, tsOf(ev));
      m.thought = (m.thought ?? '') + delta;
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.reasoning': {
      const rid = stringOf(d.reasoningId) ?? ev.id ?? `segment-${state.messages.length}`;
      const content = typeof d.content === 'string' ? d.content : '';
      if (!content) return empty;
      const m = reasoningMsg(state, rid, tsOf(ev));
      m.thought = content;
      m.timestamp = tsOf(ev);
      state.finalReasoning.add(m.id);
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.message_start': {
      const mid = (typeof d.messageId === 'string' && d.messageId) || ev.id || `a-${state.messages.length}`;
      const m = ensureStreaming(state, mid, tsOf(ev));
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.message_delta': {
      const mid = typeof d.messageId === 'string' ? d.messageId : '';
      const delta = typeof d.deltaContent === 'string' ? d.deltaContent : '';
      if (!mid || !delta) return empty;
      const m = ensureStreaming(state, mid, tsOf(ev));
      m.content += delta;
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.message': {
      const mid = (typeof d.messageId === 'string' && d.messageId) || ev.id || `a-${state.messages.length}`;
      const id = mid;
      const content = typeof d.content === 'string' ? d.content : '';
      const reqs = Array.isArray(d.toolRequests) ? (d.toolRequests as ToolRequest[]) : [];
      const toolCalls: ToolCall[] = reqs
        .filter((r) => typeof r.toolCallId === 'string')
        // `task` tool calls become a sub-agent card (created on subagent.started),
        // so don't render them as a plain tool row here. `skill` tool calls are the
        // skill-activation machinery surfaced compactly by `skill.invoked` (a pill),
        // so suppress the redundant tool row + its JSON args + "loaded" output.
        // `exit_plan_mode` is presented by the dedicated pending-plan card (rich
        // summary + actions); rendering it as a tool row would leak the internal
        // tool name and dump the whole plan summary as raw args — suppress it.
        .filter((r) => r.name !== 'task' && r.name !== 'skill' && r.name !== 'exit_plan_mode')
        .map((r) => {
          // CLI-style: the visible line is the agent's INTENT (intentionSummary),
          // not the raw command/args. Details (args + output) fold below.
          const title = (r.intentionSummary && String(r.intentionSummary))
            || (r.description && String(r.description))
            || (r.toolTitle && String(r.toolTitle))
            || (r.name && String(r.name)) || 'tool';
          const tc: ToolCall = {
            toolCallId: r.toolCallId as string,
            title,
            status: 'pending' as const,
            ...(r.name ? { name: String(r.name) } : {}),
          };
          const args = projection?.toolArgs?.get(r.toolCallId as string) ?? toolArgsOf(r.name, r.arguments);
          if (args) tc.args = args;
          return tc;
        });
      // An atomic native event has no internal chronology. Its local convention
      // is reasoningText, body, then tool requests in their array order. Separate
      // reasoning/stream events keep their original positions instead.
      const changed: string[] = [];
      const removed: string[] = [];
      const persistedThought = typeof d.reasoningText === 'string' && d.reasoningText.trim() ? d.reasoningText : undefined;
      const previousReasoning = state.messageReasoning.get(id);
      const reasoning = previousReasoning && !persistedThought ? previousReasoning
        : [...new Set([...(previousReasoning ?? []), ...state.reasoningIds])];
      const fallbackId = `reasoning-message-${id}`;
      const explicit = reasoning.filter(reasoningId => state.finalReasoning.has(reasoningId));
      const explicitText = explicit.map(reasoningId => state.messages[state.byId.get(reasoningId)!]?.thought ?? '').join('\n\n');
      // Omit only a complete duplicate of the preceding explicit records.
      // Differing snapshots remain intact; no prefix slicing or later text-matching ownership.
      const fallbackThought = persistedThought !== explicitText ? persistedThought : undefined;
      if (persistedThought) {
        const transient = new Set(reasoning.filter(reasoningId => reasoningId !== fallbackId && !state.finalReasoning.has(reasoningId)));
        removeMessages(state, transient);
        removed.push(...transient);
      }
      if (fallbackThought) {
        // A message-only persisted record has no native reasoning identity.
        // Replace transient-only segments with its durable message-based anchor.
        const thought: ChatMessage = {
          id: fallbackId, role: 'assistant', content: '', thought: fallbackThought, timestamp: tsOf(ev),
        };
        upsert(state, thought);
        // A body may already exist from message_start. Keep the bundled fallback
        // immediately before that body rather than appending it after the stream.
        const bodyIndex = state.byId.get(id);
        const thoughtIndex = state.byId.get(fallbackId)!;
        if (bodyIndex !== undefined && thoughtIndex > bodyIndex) {
          state.messages.splice(thoughtIndex, 1);
          state.messages.splice(bodyIndex, 0, thought);
          state.byId = new Map(state.messages.map((message, index) => [message.id, index]));
        }
        state.messageReasoning.set(id, [...explicit, fallbackId]);
        changed.push(fallbackId);
      } else {
        state.messageReasoning.set(id, [...(persistedThought ? explicit : reasoning)]);
        if (persistedThought && explicit.length && state.byId.has(fallbackId)) {
          removeMessages(state, new Set([fallbackId]));
          removed.push(fallbackId);
        }
      }
      const prevIdx = state.byId.get(id);
      if (content || prevIdx !== undefined) {
        upsert(state, { id, role: 'assistant', content, timestamp: tsOf(ev) });
        changed.push(id);
      }
      for (const tool of toolCalls) {
        const toolId = `tool-${tool.toolCallId}`;
        const oldIndex = state.byId.get(toolId);
        const old = oldIndex === undefined ? undefined : state.messages[oldIndex];
        const previous = old?.toolCalls?.[0];
        upsert(state, {
          id: toolId, role: 'assistant', content: '', timestamp: old?.timestamp ?? tsOf(ev),
          toolCalls: [{ ...tool, ...(previous ? {
            status: previous.status, ...(previous.output ? { output: previous.output } : {}),
          } : {}) }],
        });
        changed.push(toolId);
      }
      // Remember which tool calls are ask_user prompts so their completion event
      // can surface the user's answer as a visible "my reply" message.
      for (const r of reqs) {
        if (typeof r.toolCallId !== 'string') continue;
        // Ownership exists even when a dedicated UI replaces the ordinary tool row.
        state.toolMsg.set(r.toolCallId, toolCalls.some(tool => tool.toolCallId === r.toolCallId)
          ? `tool-${r.toolCallId}` : id);
        if (r.name === 'ask_user') state.askToolIds.add(r.toolCallId);
        // `task` → capture the sub-agent's prompt/agent_type now; the
        // subagent.started event (which builds the card) doesn't carry the prompt.
        rememberTask(state, r, projection?.scope);
      }
      endTurn(state); // the turn's assistant message is finalized
      return { changed, ...(removed.length ? { removed } : {}), metaChanged: false };
    }

    // The callback/request lifecycle belongs to Engine. Only the durable tool
    // result is an answer; user_input.completed is ephemeral and may be empty.
    case 'user_input.requested': {
      const toolCallId = stringOf(d.toolCallId);
      if (toolCallId) state.askToolIds.add(toolCallId);
      return empty;
    }

    case 'tool.execution_start':
    case 'tool.execution_complete': {
      const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : '';
      if (!toolCallId) return empty;
      if (ev.type === 'tool.execution_start' && d.toolName === 'ask_user') state.askToolIds.add(toolCallId);
      const msgId = state.toolMsg.get(toolCallId);
      const idx = msgId ? state.byId.get(msgId) : undefined;
      const tc = idx !== undefined ? state.messages[idx]?.toolCalls?.find((t) => t.toolCallId === toolCallId) : undefined;
      const changed: string[] = [];
      if (tc && msgId) {
        tc.status = ev.type === 'tool.execution_start' ? 'in_progress'
          : d.success === false || d.error != null ? 'failed' : 'completed';
        changed.push(msgId);
      }
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
          upsert(state, { id: replyId, role: 'user', subtype: 'ask-reply', content: answer, timestamp: tsOf(ev) });
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
