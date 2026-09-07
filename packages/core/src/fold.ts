// Event folding: turn the SDK's raw event stream into our ChatMessage model.
// ONE fold function serves both history replay (session.getEvents()) and live
// updates (session.on('*')), so the two can never diverge. Pure given a state
// object it mutates; returns which message ids changed + whether session meta
// changed, so the engine knows what to emit.

import type { ChatMessage, ToolCall, Attachment } from '@cockpit/protocol';

export interface FoldState {
  messages: ChatMessage[];
  byId: Map<string, number>; // messageId -> index in messages
  toolMsg: Map<string, string>; // toolCallId -> messageId that owns it
  askToolIds: Set<string>; // toolCallIds that are ask_user prompts
  changedFiles: Map<string, 'create' | 'edit'>; // repo path -> latest operation
  // Sub-agents (spawned via the `task` tool). Events carrying a top-level
  // `agentId` (= the parent task's toolCallId) belong to that sub-agent, NOT the
  // main thread — they're routed into a nested FoldState and surfaced inside one
  // "sub-agent card" message. `subFolds` holds each sub-agent's own fold; `subCard`
  // maps its toolCallId → the card message id in THIS (parent) fold; `pendingTask`
  // captures the task tool's prompt/agent_type at request time (the subagent.started
  // event doesn't carry the prompt).
  subFolds: Map<string, FoldState>;
  subCard: Map<string, string>;
  pendingTask: Map<string, { prompt?: string; description?: string; agentType?: string }>;
  // Streaming/reasoning: reasoning (reasoningId) precedes the message (messageId)
  // in a turn with no cross-reference, so we pair them by order. `streamingId` is
  // the messages[] id of the current turn's assistant message (a reasoning-derived
  // placeholder if reasoning came first); `msgAlias` maps the real messageId onto
  // it so later message deltas/finals resolve to the same message.
  streamingId?: string;
  msgAlias: Map<string, string>;
  // Active reasoning segment within the current turn. A turn can emit several
  // reasoning blocks (distinct reasoningId); `reasoningId` is the one currently
  // accumulating and `reasoningBase` is the thought text committed before it, so a
  // new block appends instead of overwriting prior ones (M2).
  reasoningId?: string;
  reasoningBase?: string;
  currentModelId?: string;
}

export function newFoldState(): FoldState {
  return {
    messages: [], byId: new Map(), toolMsg: new Map(),
    askToolIds: new Set(), changedFiles: new Map(),
    subFolds: new Map(), subCard: new Map(), pendingTask: new Map(),
    msgAlias: new Map(),
  };
}

export interface FoldResult {
  changed: string[]; // message ids upserted
  metaChanged: boolean;
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

// The current turn's streaming assistant message, if one exists.
function streamingMsg(state: FoldState): ChatMessage | undefined {
  if (state.streamingId === undefined) return undefined;
  const idx = state.byId.get(state.streamingId);
  return idx === undefined ? undefined : state.messages[idx];
}

// Does `state` or any descendant sub-fold own the task `tcId` (in its pendingTask)?
function ownsTask(state: FoldState, tcId: string): boolean {
  if (state.pendingTask.has(tcId)) return true;
  for (const sub of state.subFolds.values()) if (ownsTask(sub, tcId)) return true;
  return false;
}

// Does `state` or any descendant sub-fold own the sub-agent `agentId` (a sub-fold)?
function ownsAgent(state: FoldState, agentId: string): boolean {
  if (state.subFolds.has(agentId)) return true;
  for (const sub of state.subFolds.values()) if (ownsAgent(sub, agentId)) return true;
  return false;
}

// Get-or-create the current turn's assistant message under `id`, marking it as
// the streaming message. Used by reasoning (placeholder id) and message events.
function ensureStreaming(state: FoldState, id: string, ts: number): ChatMessage {
  state.streamingId = id;
  const idx = state.byId.get(id);
  if (idx !== undefined) {
    const existing = state.messages[idx];
    if (existing) return existing;
  }
  const msg: ChatMessage = { id, role: 'assistant', content: '', timestamp: ts };
  upsert(state, msg);
  return msg;
}

// Resolve a real messageId to the streaming message's id (placeholder adoption).
function resolveMsgId(state: FoldState, messageId: string): string {
  return state.msgAlias.get(messageId) ?? messageId;
}

// Reset the streaming/turn scratch state. Exported so the engine can clear it on
// an out-of-band turn end (e.g. cancel/abort, which emits no final message).
export function resetTurn(state: FoldState): void {
  state.streamingId = undefined;
  state.msgAlias.clear();
  state.reasoningId = undefined;
  state.reasoningBase = undefined;
}

const endTurn = resetTurn;

// Begin a reasoning segment on `m` for `rid`: if it differs from the active one,
// commit the prior thought as the base (with a separator) so the new segment
// appends rather than overwrites. Returns the base for this segment.
function beginReasoningSegment(state: FoldState, m: ChatMessage, rid: string): string {
  if (state.reasoningId !== rid) {
    state.reasoningBase = m.thought ? `${m.thought}\n\n` : '';
    state.reasoningId = rid;
  }
  return state.reasoningBase ?? '';
}

// Get the sub-agent card message (by toolCallId) from this fold, if it exists.
function subCardMsg(state: FoldState, toolCallId: string): ChatMessage | undefined {
  const cardId = state.subCard.get(toolCallId);
  if (cardId === undefined) return undefined;
  const idx = state.byId.get(cardId);
  return idx === undefined ? undefined : state.messages[idx];
}

interface RawEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  agentId?: string; // set on sub-agent events (= the parent task's toolCallId)
  timestamp?: string | number;
}

interface ToolRequest { toolCallId?: string; name?: string; arguments?: unknown; description?: string; intentionSummary?: string; toolTitle?: string }

// Extract the user's answer from an ask_user tool result. The SDK stores it as
// `{ content, detailedContent }`, both prefixed with "User responded: ". Strip
// the prefix so it reads as the user's own message.
function askAnswerOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as { content?: unknown; detailedContent?: unknown };
  const raw = (typeof r.content === 'string' && r.content)
    || (typeof r.detailedContent === 'string' && r.detailedContent) || '';
  if (!raw) return '';
  return raw.replace(/^User responded:\s*/, '').trim();
}

const TOOL_DETAIL_CAP = 3000;

function cap(s: string): string {
  return s.length <= TOOL_DETAIL_CAP ? s : `${s.slice(0, TOOL_DETAIL_CAP)}\n…（已截断，共 ${s.length} 字符）`;
}

// Generic tool result → output text, capped. Used for the collapsible detail of
// any tool that produces output (bash/view/grep/glob/web_fetch/…).
function toolOutputOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as { content?: unknown; detailedContent?: unknown };
  const raw = (typeof r.content === 'string' && r.content)
    || (typeof r.detailedContent === 'string' && r.detailedContent) || '';
  return raw ? cap(raw) : '';
}

// Parse the attributes of a <cockpit-attachment .../> marker into an Attachment.
// Attribute values are percent-encoded so they survive arbitrary filenames. The
// url MUST be a cockpit /uploads/ path (same-origin, path-traversal-guarded when
// served) — we reject anything else so a marker (user- or agent-authored) can't
// point the browser at an arbitrary/cross-origin URL.
function attachmentFromAttrs(attrs: string): Attachment | null {
  const get = (k: string): string | undefined => {
    const mm = new RegExp(`${k}="([^"]*)"`).exec(attrs);
    if (!mm || mm[1] === undefined) return undefined;
    try { return decodeURIComponent(mm[1]); } catch { return mm[1]; }
  };
  const url = get('url');
  if (!url || !url.startsWith('/uploads/')) return null;
  const kind = get('kind') === 'image' ? 'image' : 'file';
  const name = get('name') ?? 'file';
  const sizeNum = Number(get('size'));
  const mime = get('mime');
  return {
    kind, name, url,
    ...(Number.isFinite(sizeNum) && sizeNum > 0 ? { size: sizeNum } : {}),
    ...(mime ? { mime } : {}),
  };
}

// User uploads: the body LEADS with a <cockpit-attachment .../> marker (emitted by
// the composer), followed by agent guidance. Returns the structured attachment +
// the remaining text (guidance, hidden from display) with the marker stripped, or
// null if the message doesn't start with a valid marker.
const ATTACHMENT_RE = /^\s*<cockpit-attachment\b([^>]*?)\/?>(?:<\/cockpit-attachment>)?\s*/;
function parseAttachment(content: string): { attachment: Attachment; caption: string } | null {
  const m = ATTACHMENT_RE.exec(content);
  if (!m) return null;
  const attachment = attachmentFromAttrs(m[1] ?? '');
  if (!attachment) return null;
  // The guidance after the marker is machinery for the agent — don't show it.
  return { attachment, caption: '' };
}

// Agent attachments: the marker may appear ANYWHERE in an assistant reply, and the
// surrounding prose is a real caption that stays visible. Returns the FIRST valid
// attachment + the text with ALL markers removed (a stray second marker must never
// show as raw XML), or null if there's no valid marker.
const ANY_ATTACHMENT_RE = /<cockpit-attachment\b([^>]*?)\/?>(?:<\/cockpit-attachment>)?/;
function extractAttachment(content: string): { attachment: Attachment; text: string } | null {
  const m = ANY_ATTACHMENT_RE.exec(content);
  if (!m) return null;
  const attachment = attachmentFromAttrs(m[1] ?? '');
  if (!attachment) return null;
  const text = content.replace(new RegExp(ANY_ATTACHMENT_RE.source, 'g'), '').trim();
  return { attachment, text };
}

// A session's auto-derived name/summary (when the user hasn't named it) is its
// first user message. When that message is an upload, it LEADS with a raw
// <cockpit-attachment .../> marker (machinery, percent-encoded attrs) — which must
// never surface as the visible session title (the bug: a title literally reading
// `<cockpit-attachment kind="image" …`). Strip a leading marker and substitute a
// human label: the attachment's filename, else a kind label. Non-marker titles
// pass through unchanged (first line only — titles are single-line). Returns ''
// for empty input so callers can fall back (cwd basename, etc.).
export function cleanSessionTitle(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const m = ATTACHMENT_RE.exec(trimmed);
  if (m) {
    const att = attachmentFromAttrs(m[1] ?? '');
    if (att) {
      if (att.name && att.name !== 'file') return att.name;
      return att.kind === 'image' ? '图片消息' : '文件消息';
    }
    // Marker present but unparseable → drop it and use whatever text follows.
    const rest = trimmed.replace(ATTACHMENT_RE, '').trim();
    return rest.split('\n')[0]?.trim() ?? '';
  }
  return trimmed.split('\n')[0]?.trim() ?? '';
}

// Format a tool's arguments into a readable, capped one-or-few-line detail (the
// "what" behind the intent): `$ cmd` for bash, the path/range for view, a mini
// diff for edit, the pattern for grep/glob, etc. Empty ⇒ no args detail.
function toolArgsOf(name: string | undefined, args: unknown): string {
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

export function foldEvent(state: FoldState, ev: RawEvent): FoldResult {
  const empty: FoldResult = { changed: [], metaChanged: false };
  const d = ev.data ?? {};

  // --- Nested sub-agent routing (depth ≥ 2) -----------------------------------
  // Sub-agent events are tagged with the sub-agent's OWN id (started/internal work
  // carry agentId = that sub-agent's toolCallId). When the event belongs to a
  // DESCENDANT sub-agent (its task lives in a child sub-fold's pendingTask, or its
  // sub-fold lives inside a child), route it into that direct child and re-mirror
  // the child's card so the nesting bubbles up. M3.
  {
    const startTc = ev.type === 'subagent.started'
      ? (typeof d.toolCallId === 'string' ? d.toolCallId : ev.agentId) : undefined;
    const isStartedForDescendant = startTc != null && !state.pendingTask.has(startTc) && !state.subCard.has(startTc);
    const isAgentEventForDescendant = ev.agentId != null && !state.subFolds.has(ev.agentId);
    if (isStartedForDescendant || isAgentEventForDescendant) {
      for (const [childTc, sub] of state.subFolds) {
        const owns = startTc != null ? ownsTask(sub, startTc) : ownsAgent(sub, ev.agentId!);
        if (!owns) continue;
        const r = foldEvent(sub, ev);
        const card = subCardMsg(state, childTc);
        if (card) { card.subMessages = sub.messages; return { changed: [card.id], metaChanged: r.metaChanged }; }
        return empty;
      }
    }
  }

  // --- Sub-agent handling (must run BEFORE the agentId routing below) ---------
  if (ev.type === 'subagent.started') {
    const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : (ev.agentId ?? '');
    if (!toolCallId) return empty;
    const cardId = `subagent-${toolCallId}`;
    const task = state.pendingTask.get(toolCallId);
    const card: ChatMessage = {
      id: cardId, role: 'assistant', subtype: 'subagent', content: '', timestamp: tsOf(ev),
      subagent: {
        name: typeof d.agentName === 'string' ? d.agentName : (task?.agentType ?? 'agent'),
        displayName: typeof d.agentDisplayName === 'string' ? d.agentDisplayName : '子代理',
        ...(typeof d.agentDescription === 'string' ? { description: d.agentDescription } : (task?.description ? { description: task.description } : {})),
        ...(typeof d.model === 'string' ? { model: d.model } : {}),
        status: 'running',
        ...(task?.prompt ? { prompt: task.prompt } : {}),
      },
      subMessages: [],
    };
    state.subFolds.set(toolCallId, newFoldState());
    state.subCard.set(toolCallId, cardId);
    upsert(state, card);
    return { changed: [cardId], metaChanged: false };
  }
  if (ev.type === 'subagent.completed' || ev.type === 'subagent.failed') {
    const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : (ev.agentId ?? '');
    const card = subCardMsg(state, toolCallId);
    if (!card?.subagent) return empty;
    card.subagent.status = ev.type === 'subagent.failed' ? 'failed' : 'completed';
    if (typeof d.totalToolCalls === 'number') card.subagent.toolCount = d.totalToolCalls;
    if (typeof d.error === 'string') card.subagent.error = d.error;
    return { changed: [card.id], metaChanged: false };
  }
  // subagent.selected/deselected carry agent metadata but no per-event work to fold.
  if (ev.type === 'subagent.selected' || ev.type === 'subagent.deselected') return empty;

  // Route any event carrying a sub-agent's `agentId` into that sub-agent's own
  // nested fold, then mirror its messages onto the card. The SAME foldEvent folds
  // the sub-agent's inner conversation (tools + reasoning + messages).
  if (ev.agentId && state.subFolds.has(ev.agentId)) {
    const sub = state.subFolds.get(ev.agentId)!;
    const r = foldEvent(sub, ev);
    const card = subCardMsg(state, ev.agentId);
    if (card) {
      card.subMessages = sub.messages;
      return { changed: [card.id], metaChanged: r.metaChanged };
    }
    return empty;
  }

  switch (ev.type) {
    case 'assistant.turn_start': {
      // Turn boundary — clear any leaked streaming state from a prior turn. (On
      // live this is intercepted by the engine before fold; reached on replay.)
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
      const id = ev.id ?? `u-${state.messages.length}`;
      // An uploaded file/image is sent as a `user.message` whose body leads with a
      // <cockpit-attachment .../> marker (carrying display metadata) followed by the
      // agent guidance (with the absolute path). Render the attachment as a card;
      // the guidance is machinery, hidden from display (the agent still has it).
      const att = parseAttachment(content);
      if (att) {
        upsert(state, { id, role: 'user', content: att.caption, timestamp: tsOf(ev), attachment: att.attachment });
        return { changed: [id], metaChanged: false };
      }
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
      // Live streaming thinking (ephemeral). Stream into the current turn's
      // assistant message, creating a reasoning-derived placeholder if the message
      // hasn't started yet — so the user watches it think before the answer.
      const rid = typeof d.reasoningId === 'string' ? d.reasoningId : '';
      const delta = typeof d.deltaContent === 'string' ? d.deltaContent : '';
      if (!delta) return empty;
      const m = streamingMsg(state) ?? ensureStreaming(state, `stream-${rid || state.messages.length}`, tsOf(ev));
      // A new reasoning block commits the prior thought as a base, so multiple
      // blocks in one turn accumulate instead of overwriting (M2).
      beginReasoningSegment(state, m, rid || `seg-${state.messages.length}`);
      m.thought = (m.thought ?? '') + delta;
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.reasoning': {
      // Final, complete thinking text (persisted → replays on reload). Replaces the
      // CURRENT segment's streamed partial (from its base), preserving earlier
      // segments. Pairs with the upcoming assistant.message by order.
      const rid = typeof d.reasoningId === 'string' ? d.reasoningId : '';
      const content = typeof d.content === 'string' ? d.content : '';
      if (!content) return empty;
      const m = streamingMsg(state) ?? ensureStreaming(state, `stream-${rid || state.messages.length}`, tsOf(ev));
      const base = beginReasoningSegment(state, m, rid || `seg-${state.messages.length}`);
      m.thought = base + content;
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.message_start': {
      const mid = (typeof d.messageId === 'string' && d.messageId) || ev.id || `a-${state.messages.length}`;
      const cur = streamingMsg(state);
      // A reasoning placeholder already opened this turn's message — adopt the
      // real id onto it instead of creating a second message.
      if (cur) { state.msgAlias.set(mid, cur.id); return { changed: [cur.id], metaChanged: false }; }
      const m = ensureStreaming(state, mid, tsOf(ev));
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.message_delta': {
      const mid = typeof d.messageId === 'string' ? d.messageId : '';
      const delta = typeof d.deltaContent === 'string' ? d.deltaContent : '';
      if (!mid || !delta) return empty;
      const id = resolveMsgId(state, mid);
      const m = streamingMsg(state)?.id === id ? streamingMsg(state)! : ensureStreaming(state, id, tsOf(ev));
      m.content += delta;
      return { changed: [m.id], metaChanged: false };
    }

    case 'assistant.message': {
      const mid = (typeof d.messageId === 'string' && d.messageId) || ev.id || `a-${state.messages.length}`;
      // Adopt the streaming/placeholder id so reasoning + content land on ONE
      // message, consistent across live and reload.
      const id = state.msgAlias.get(mid) ?? state.streamingId ?? mid;
      const rawContent = typeof d.content === 'string' ? d.content : '';
      // An agent can attach an image/file by emitting a <cockpit-attachment .../>
      // marker anywhere in its reply (after publishing the file via /upload). Pull
      // it out into message.attachment; the surrounding prose stays as the caption.
      const extracted = extractAttachment(rawContent);
      const content = extracted ? extracted.text : rawContent;
      const attachment = extracted?.attachment;
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
          const args = toolArgsOf(r.name, r.arguments);
          if (args) tc.args = args;
          return tc;
        });
      for (const tc of toolCalls) state.toolMsg.set(tc.toolCallId, id);
      // Remember which tool calls are ask_user prompts so their completion event
      // can surface the user's answer as a visible "my reply" message.
      for (const r of reqs) {
        if (typeof r.toolCallId !== 'string') continue;
        if (r.name === 'ask_user') state.askToolIds.add(r.toolCallId);
        // `task` → capture the sub-agent's prompt/agent_type now; the
        // subagent.started event (which builds the card) doesn't carry the prompt.
        if (r.name === 'task') {
          const a = (r.arguments ?? {}) as Record<string, unknown>;
          state.pendingTask.set(r.toolCallId, {
            ...(typeof a.prompt === 'string' ? { prompt: a.prompt } : {}),
            ...(typeof a.description === 'string' ? { description: a.description } : {}),
            ...(typeof a.agent_type === 'string' ? { agentType: a.agent_type } : {}),
          });
        }
        // Track repo files the agent creates/edits for the info-panel diff section.
        if (r.name === 'create' || r.name === 'edit') {
          const p = (r.arguments as { path?: unknown } | undefined)?.path;
          if (typeof p === 'string' && p) {
            // 'create' wins only if not already created/edited (first op is the truer label).
            if (!state.changedFiles.has(p)) state.changedFiles.set(p, r.name === 'create' ? 'create' : 'edit');
          }
        }
      }
      // Preserve any thought (reasoning) already attached to this message.
      const prevIdx = state.byId.get(id);
      const prevThought = prevIdx !== undefined ? state.messages[prevIdx]?.thought : undefined;
      // Live, reasoning streams onto a placeholder so `prevThought` carries it. On
      // replay, getEvents() holds no assistant.reasoning* events — but the final
      // reasoning text is persisted on THIS message as `data.reasoningText`. Fall
      // back to it so replay reconstructs the thinking the user saw live (the
      // live==replay invariant). `d.reasoningText` is untyped (Record<string,
      // unknown>), so narrow it the same way as `content`.
      const persistedThought = typeof d.reasoningText === 'string' && d.reasoningText.trim()
        ? d.reasoningText : undefined;
      const thought = prevThought ?? persistedThought;
      // A message whose only tool was `task` (now a sub-agent card) and that has no
      // text/thought/attachment would render as an empty byline — skip it. Still end the turn.
      if (!content && toolCalls.length === 0 && !thought && prevIdx === undefined && !attachment) {
        endTurn(state);
        return empty;
      }
      const msg: ChatMessage = {
        id, role: 'assistant', content, timestamp: tsOf(ev),
        ...(thought ? { thought } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(attachment ? { attachment } : {}),
      };
      upsert(state, msg);
      endTurn(state); // the turn's assistant message is finalized
      return { changed: [id], metaChanged: false };
    }

    case 'tool.execution_start':
    case 'tool.execution_complete': {
      const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : '';
      if (!toolCallId) return empty;
      const msgId = state.toolMsg.get(toolCallId);
      if (!msgId) return empty;
      const idx = state.byId.get(msgId);
      if (idx === undefined) return empty;
      const msg = state.messages[idx];
      if (!msg?.toolCalls) return empty;
      const tc = msg.toolCalls.find((t) => t.toolCallId === toolCallId);
      if (!tc) return empty;
      if (ev.type === 'tool.execution_start') tc.status = 'in_progress';
      else tc.status = d.success === false ? 'failed' : 'completed';
      const changed = [msgId];
      // Attach the (capped) tool output to the collapsible detail for ALL tools
      // (except ask_user, whose answer becomes its own reply bubble below).
      if (ev.type === 'tool.execution_complete' && !state.askToolIds.has(toolCallId)) {
        const out = toolOutputOf(d.result);
        if (out) tc.output = out;
      }
      // ask_user completion: surface the user's answer as a visible "my reply"
      // bubble. The result content is persisted (survives reload via getEvents),
      // so this is authoritative and identical for live + replay. Stable id keeps
      // the upsert idempotent across replays.
      if (ev.type === 'tool.execution_complete' && state.askToolIds.has(toolCallId)) {
        const answer = askAnswerOf(d.result);
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
