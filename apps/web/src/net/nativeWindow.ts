import { foldEvent, newFoldState, resetTurn, type FoldState } from '@cockpit/protocol/chat';
import { CHAT_EVENT_TYPES, summarizeMessage, type ChatMessage, type NativeChatEvent, type NativeChatPage, type NativeChatRead } from '@cockpit/protocol';
import { displayEvent, type DisplayEvent } from './displayEvent';
import { HistoryFoldIndex, mergeHistoryFold, ownersOf, states, type MessageOrders, type OrderedEvent } from './historyFold';

export const NATIVE_PAGE = 32;
const displayTypes = new Set(CHAT_EVENT_TYPES);
export type ChatPosition = Pick<NativeChatRead, 'source' | 'cursor' | 'agentScope' | 'agentIds' | 'types'>;

const reasoningId = (event: NativeChatEvent) =>
  `reasoning-${typeof event.data.reasoningId === 'string' && event.data.reasoningId ? event.data.reasoningId : event.id}`;
const finalizedId = (event: NativeChatEvent) => event.type === 'assistant.message'
  ? typeof event.data.messageId === 'string' && event.data.messageId ? event.data.messageId : event.id
  : event.type === 'assistant.reasoning' ? reasoningId(event) : undefined;
const streamId = (event: NativeChatEvent) =>
  event.type === 'assistant.reasoning_delta' ? reasoningId(event)
    : typeof event.data.messageId === 'string' ? event.data.messageId : undefined;
function projectMessages(messages: ChatMessage[], previous: ChatMessage[], changed: Set<string>): ChatMessage[] {
  const byId = new Map(previous.map(message => [message.id, message]));
  const projected = messages.map(message => {
    const old = byId.get(message.id);
    if (old && !changed.has(message.id)) return old;
    const { subMessages, ...body } = message;
    return {
      ...structuredClone(body),
      ...(subMessages ? { subMessages: projectMessages(subMessages, old?.subMessages ?? [], changed) } : {}),
    };
  });
  return projected.length === previous.length && projected.every((message, index) => message === previous[index])
    ? previous : projected;
}

/** One browser view's history and incremental projection; never used by the server. */
export class NativeWindow {
  private state = newFoldState();
  private history = new HistoryFoldIndex();
  private orders: MessageOrders = new WeakMap();
  private missing = new Set<string>();
  private missingEphemeral = new Map<string, { owners: string[]; tool?: string }>();
  private ephemeralReasoning = new WeakSet<ChatMessage>();
  private ids = new Set<string>();
  private recentEphemeral = new Set<string>();
  private complete = new Set<string>();
  private streaming = new Set<string>();
  private blocked = new Set<string>();
  private view: ChatMessage[] = [];
  private pendingForward: DisplayEvent[] = [];
  private bootstrapOverlap = false;
  older?: ChatPosition;
  live?: ChatPosition;
  hasMore = false;
  materialized = false;
  invalid = false;
  catchingUp = true;
  partial = false;
  get unresolved() { return this.missing.size > 0 || this.missingEphemeral.size > 0; }
  boundaryPending = false;

  private readonly agentIds?: readonly string[];
  private readonly includeChildren: boolean;
  constructor(agentIds?: readonly string[], includeChildren = false) {
    this.agentIds = agentIds;
    this.includeChildren = includeChildren;
  }

  private key(state: FoldState, id: string): string {
    return `${state.agentIds.values().next().value ?? ''}\0${id}`;
  }

  private eventKey(event: DisplayEvent, id: string): string {
    const owners = ownersOf(event);
    const state = owners.length ? states(this.state).find(state => owners.some(owner => state.agentIds.has(owner))) : this.state;
    return state ? this.key(state, id) : `${owners[0]}\0${id}`;
  }

  private resolveStreamOwners() {
    const known = states(this.state);
    for (const keys of [this.streaming, this.blocked, this.complete]) {
      for (const key of [...keys]) {
        const separator = key.indexOf('\0');
        const owner = key.slice(0, separator);
        const state = known.find(state => state.agentIds.has(owner));
        if (!state) continue;
        keys.delete(key);
        keys.add(this.key(state, key.slice(separator + 1)));
      }
    }
    for (const key of this.complete) { this.blocked.delete(key); this.streaming.delete(key); }
    if (!this.blocked.size) this.partial = false;
    this.resolveMissingEphemeral(known);
  }

  private resolveMissingEphemeral(known: FoldState[]) {
    for (const [key, missing] of this.missingEphemeral) {
      if (known.some(state => missing.tool ? state.toolMsg.has(missing.tool)
        : missing.owners.some(owner => state.agentIds.has(owner)))) this.missingEphemeral.delete(key);
    }
  }

  private noteMissing(event: DisplayEvent, tool = false) {
    if (!event.ephemeral) { this.missing.add(event.id); return; }
    const owners = [...new Set(ownersOf(event))].sort();
    const toolId = tool && typeof event.data.toolCallId === 'string' ? event.data.toolCallId : undefined;
    this.missingEphemeral.set(toolId ? `tool:${toolId}` : `owners:${owners.join('\0')}`, { owners, tool: toolId });
  }

  disconnect() {
    for (const id of this.streaming) this.blocked.add(id);
    this.partial ||= this.blocked.size > 0;
    this.streaming.clear();
    this.recentEphemeral.clear();
    this.catchingUp = true;
    for (const state of states(this.state)) {
      const reasoningIds = state.reasoningIds;
      resetTurn(state);
      // Retain only identity links for final reconciliation, never an accumulator
      // that could append a post-gap suffix to an incomplete reasoning prefix.
      state.reasoningIds = reasoningIds;
    }
  }

  invalidate() { this.disconnect(); this.invalid = true; }

  private display(event: NativeChatEvent): DisplayEvent | undefined {
    if (this.agentIds) {
      if (event.type.startsWith('subagent.') && typeof event.data.toolCallId === 'string'
        && this.agentIds.includes(event.data.toolCallId)) return undefined;
      const { agentId: _agent, parentToolCallId: _parent, ...data } = event.data;
      event = { ...event, agentId: undefined, parentToolCallId: undefined, data };
    }
    return displayEvent(event);
  }

  private project(event: DisplayEvent, order: number): string[] {
    this.missing.delete(event.id);
    if (!this.includeChildren && event.type.startsWith('subagent.') && event.type !== 'subagent.started') return [];
    if (event.type.startsWith('tool.') && typeof event.data.toolCallId === 'string'
      && this.state.pendingTask.has(event.data.toolCallId)) return [];
    const messageId = streamId(event);
    const id = messageId ? this.eventKey(event, messageId) : undefined;
    if (event.ephemeral) {
      if (this.catchingUp || this.recentEphemeral.has(event.id)) return [];
      this.recentEphemeral.add(event.id);
      if (this.recentEphemeral.size > 256) {
        const oldest = this.recentEphemeral.values().next().value!;
        this.recentEphemeral.delete(oldest);
      }
      if (event.type === 'assistant.message_start' && id && !this.complete.has(id) && !this.blocked.has(id)) {
        this.streaming.add(id);
      }
      if (event.type === 'assistant.message_delta' && id
        && (!this.streaming.has(id) || this.complete.has(id) || this.blocked.has(id))) {
        if (!this.complete.has(id)) { this.blocked.add(id); this.partial = true; }
        return [];
      }
      if (event.type === 'assistant.reasoning_delta' && id) {
        if (this.complete.has(id) || this.blocked.has(id)) return [];
      }
    }
    const finalId = finalizedId(event);
    const final = finalId ? this.eventKey(event, finalId) : undefined;
    const finalizingTransient = !event.ephemeral && !!final && (this.streaming.has(final) || this.blocked.has(final));
    if (final && !event.ephemeral) {
      this.complete.add(final);
      this.streaming.delete(final);
      this.blocked.delete(final);
      if (!this.blocked.size) this.partial = false;
    }
    if (this.includeChildren) {
      const owners = ownersOf(event);
      if (owners.length && !event.type.startsWith('subagent.')
        && !states(this.state).some(state => owners.some(owner => state.agentIds.has(owner)))) {
        this.noteMissing(event);
      }
    }
    const eventOwners = ownersOf(event);
    const reasoningOwner = eventOwners.length
      ? states(this.state).find(state => eventOwners.some(owner => state.agentIds.has(owner))) : this.state;
    const reconciled = event.type === 'assistant.message' && typeof event.data.reasoningText === 'string'
      ? [...reasoningOwner?.reasoningIds ?? []] : [];
    const result = foldEvent(this.state, event, {
      eventOrder: order,
      ...event.display, toolArgs: event.display?.toolArgs ? new Map(event.display.toolArgs) : undefined,
      scope: { details: this.includeChildren ? 'full' : 'summary' }, strictOwnership: true,
    });
    if (result.missingOwner) {
      this.noteMissing(event, true);
    }
    if (event.type === 'subagent.started') this.resolveStreamOwners();
    if (reasoningOwner) for (const reasoningId of reconciled) {
      const key = this.key(reasoningOwner, reasoningId);
      this.complete.add(key);
      this.streaming.delete(key);
      this.blocked.delete(key);
    }
    if (!this.blocked.size) this.partial = false;
    const changed = [...result.changed, ...result.nestedChanged ?? [], ...result.removed ?? []];
    if (event.ephemeral && event.type === 'assistant.reasoning_delta' && id && result.changed.length) {
      this.streaming.add(id);
    }
    const known = states(this.state);
    if (this.missingEphemeral.size) this.resolveMissingEphemeral(known);
    for (const state of known) {
      let orders = this.orders.get(state);
      if (!orders) this.orders.set(state, orders = new Map());
      for (const id of changed) if (state.byId.has(id) && !orders.has(id)) orders.set(id, order);
      if (finalizingTransient && finalId && final === this.key(state, finalId) && state.byId.has(finalId)) {
        // Temporary deltas are not a durable ordering anchor. The first complete
        // record fixes its position so cold pages and live catch-up converge.
        const requested = event.type === 'assistant.message' && Array.isArray(event.data.toolRequests)
          ? event.data.toolRequests.flatMap(request => request && typeof request === 'object' && typeof request.toolCallId === 'string'
            && orders.get(`tool-${request.toolCallId}`) === order ? [`tool-${request.toolCallId}`] : []) : [];
        const ids = event.type === 'assistant.message' ? [`reasoning-message-${finalId}`, finalId, ...requested] : [finalId];
        const finalized = ids.flatMap(id => {
          const index = state.byId.get(id);
          return index === undefined ? [] : [state.messages[index]];
        });
        for (let index = state.messages.length - 1; index >= 0; index--) {
          if (ids.includes(state.messages[index].id)) state.messages.splice(index, 1);
        }
        state.messages.push(...finalized);
        state.byId = new Map(state.messages.map((message, index) => [message.id, index]));
        for (const item of finalized) orders.set(item.id, order);
      }
      if (event.type === 'assistant.message' && messageId && state.byId.has(messageId)) {
        const fallback = `reasoning-message-${messageId}`;
        if (state.byId.has(fallback)) orders.set(fallback, Math.min(orders.get(fallback) ?? order, orders.get(messageId) ?? order));
      }
      if (event.ephemeral && event.type === 'assistant.reasoning_delta' && state.pendingReasoning
        && (eventOwners.length ? eventOwners.some(owner => state.agentIds.has(owner)) : state === this.state)) {
        this.ephemeralReasoning.add(state.pendingReasoning);
      }
    }
    return changed;
  }

  private prepend(events: DisplayEvent[], changed: Set<string>) {
    if (!events.length) return;
    const suffix = this.state;
    const known = states(suffix);
    const knownOwners = new Set(known.flatMap(state => [...state.agentIds]));
    const partialIds = [...new Set([...this.streaming, ...this.blocked])].map(key => key.slice(key.indexOf('\0') + 1));
    const transient = known.map((state, index) => ({
      root: index === 0, agentIds: [...state.agentIds],
      partials: partialIds.filter(id => this.streaming.has(this.key(state, id)) || this.blocked.has(this.key(state, id)))
        .flatMap(id => state.byId.has(id) ? [state.messages[state.byId.get(id)!]] : []),
      scratch: {
        streamingId: state.streamingId, pendingReasoning: state.pendingReasoning,
        reasoningId: state.reasoningId, reasoningIds: state.reasoningIds,
      },
    }));
    const incoming = this.history.order(events, true);
    this.history.learnAliases(events);
    this.state = newFoldState();
    const replay = new Map<string, OrderedEvent>();
    const enqueue = (item: OrderedEvent) => {
      if (replay.has(item.event.id)) return;
      replay.set(item.event.id, item);
    };
    for (const item of incoming) {
      this.ids.add(item.event.id);
      for (const id of this.project(item.event, item.order)) changed.add(id);
      for (const dependent of this.history.dependencies(item.event, knownOwners, known)) enqueue(dependent);
    }
    for (const state of states(this.state)) {
      if (state.reasoningIds.length || state.streamingId) {
        for (const item of this.history.head(state)) enqueue(item);
      }
    }
    for (const item of replay.values()) {
      for (const dependent of this.history.dependencies(item.event, knownOwners, known)) enqueue(dependent);
    }
    for (const item of [...replay.values()].sort((a, b) => a.order - b.order)) {
      for (const id of this.project(item.event, item.order)) changed.add(id);
    }
    this.state = mergeHistoryFold(this.state, suffix, this.orders, this.history, changed);
    this.history.add(incoming, true);
    this.resolveStreamOwners();
    const merged = states(this.state);
    for (const saved of transient) {
      const target = saved.root ? this.state : merged.find(state => saved.agentIds.some(id => state.agentIds.has(id)));
      if (!target) continue;
      for (const message of saved.partials) {
        if (this.complete.has(this.key(target, message.id))) continue;
        const index = target.byId.get(message.id);
        if (index === undefined) {
          target.byId.set(message.id, target.messages.length);
          target.messages.push(message);
        } else target.messages[index] = message;
      }
      const { scratch } = saved;
      if ((scratch.streamingId && !this.complete.has(this.key(target, scratch.streamingId)))
        || (scratch.pendingReasoning && this.ephemeralReasoning.has(scratch.pendingReasoning)
          && !this.complete.has(this.key(target, scratch.pendingReasoning.id)))) Object.assign(target, scratch);
    }
  }

  private append(events: DisplayEvent[], changed: Set<string>) {
    for (const event of events) {
      if (!event.ephemeral && this.ids.has(event.id)) continue;
      const [item] = this.history.order([event], false);
      if (!event.ephemeral) {
        this.ids.add(event.id);
        this.history.add([item], false);
      }
      for (const id of this.project(event, item.order)) changed.add(id);
    }
  }

  accept(page: NativeChatPage, request: NativeChatRead): ChatMessage[] {
    if (page.sessionId !== request.sessionId || page.source !== request.source || page.direction !== request.direction) {
      throw new Error('原生历史响应与当前请求不匹配。');
    }
    if (page.cursorStatus === 'expired') {
      this.invalidate();
      throw new Error('原生历史定位已失效。已保留当前内容，请明确重新同步。');
    }
    const position: ChatPosition = {
      source: request.source, cursor: page.cursor || undefined,
      ...(request.agentScope ? { agentScope: request.agentScope } : {}),
      ...(request.agentIds ? { agentIds: request.agentIds } : {}),
      ...(request.types ? { types: request.types } : {}),
    };
    const displayed = new Map<string, DisplayEvent | undefined>();
    const retained = page.events.filter(event => displayTypes.has(event.type)).map(event => {
      if (this.ids.has(event.id)) return event;
      if (!displayed.has(event.id)) displayed.set(event.id, this.display(event));
      return displayed.get(event.id);
    }).filter((event): event is DisplayEvent => event !== undefined);
    const seen = new Set<string>();
    const incoming = retained.filter(event => {
      if (event.ephemeral || this.ids.has(event.id) || seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
    const changed = new Set<string>();
    if (request.direction === 'backward') {
      const adoptingLive = request.bootstrap && this.materialized;
      if (adoptingLive && this.history.size && page.events.length && !page.events.some(event => this.ids.has(event.id))) {
        this.invalidate();
        throw new Error('恢复后的原生页面与已加载历史没有重叠；请重新同步，不会自动扫描旧历史。');
      }
      if (!adoptingLive) {
        this.older = position;
        this.hasMore = page.hasMore;
      }
      if (adoptingLive) {
        const lastOverlap = page.events.findLastIndex(event => this.ids.has(event.id));
        const newIds = new Set(page.events.slice(lastOverlap + 1).map(event => event.id));
        this.append(incoming.filter(event => newIds.has(event.id)), changed);
      } else this.prepend(incoming, changed);
      if (page.liveCursor !== undefined) {
        this.live = { ...position, cursor: page.liveCursor || undefined };
        this.bootstrapOverlap = true;
      }
    } else {
      let events = retained;
      if (this.catchingUp && this.bootstrapOverlap) {
        // The bootstrap's backward page may already include events after tail().
        // Discard the overlap in native append order, not UUID or timestamp order.
        for (const event of events) {
          if (this.ids.has(event.id)) this.pendingForward = [];
          else if (!event.ephemeral) this.pendingForward.push(event);
        }
        events = page.hasMore ? [] : this.pendingForward;
        if (!page.hasMore) this.pendingForward = [];
      }
      this.append(events, changed);
      this.live = position;
      if (!page.hasMore) {
        this.catchingUp = false;
        this.bootstrapOverlap = false;
      }
    }
    if (changed.size || this.state.messages.length !== this.view.length) {
      if (this.includeChildren) this.view = projectMessages(this.state.messages, this.view, changed);
      else {
        const previous = new Map(this.view.map(message => [message.id, message]));
        this.view = this.state.messages.map(message => changed.has(message.id) || !previous.has(message.id)
          ? structuredClone(summarizeMessage(message)) : previous.get(message.id)!);
      }
    }
    this.materialized = true;
    return this.view;
  }

  snapshot() {
    return {
      messages: this.view, materialized: this.materialized, historyStale: this.invalid,
      hasMore: this.hasMore, loadingHistory: false, partialHistory: this.partial,
      incompleteBoundary: this.unresolved || this.boundaryPending,
    };
  }

  get retainedEventCount() { return this.history.size + this.recentEphemeral.size; }
  get projection(): FoldState { return this.state; }
}
