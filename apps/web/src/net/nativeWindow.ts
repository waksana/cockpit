import { foldEvent, newFoldState, resetTurn, type FoldState } from '@cockpit/protocol/chat';
import { CHAT_EVENT_TYPES, summarizeMessage, type ChatMessage, type NativeChatEvent, type NativeChatPage, type NativeChatRead } from '@cockpit/protocol';
import { displayEvent, type DisplayEvent } from './displayEvent';

export const NATIVE_PAGE = 32;
const displayTypes = new Set(CHAT_EVENT_TYPES);
export type ChatPosition = Pick<NativeChatRead, 'source' | 'cursor' | 'agentScope' | 'agentIds' | 'types'>;

const finalizedId = (event: NativeChatEvent) => event.type === 'assistant.message'
  ? typeof event.data.messageId === 'string' ? event.data.messageId : event.id : undefined;
const streamId = (event: NativeChatEvent) =>
  typeof event.data.messageId === 'string' ? event.data.messageId : undefined;
const ownersOf = (event: NativeChatEvent) => [
  event.agentId, event.parentToolCallId, event.data.agentId, event.data.parentToolCallId,
].filter((owner): owner is string => typeof owner === 'string');

function states(root: FoldState): FoldState[] {
  return [root, ...[...root.subFolds.values()].flatMap(states)];
}

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
  private durable: DisplayEvent[] = [];
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
  unresolved = false;
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
  }

  disconnect() {
    for (const id of this.streaming) this.blocked.add(id);
    this.partial ||= this.blocked.size > 0;
    this.streaming.clear();
    this.recentEphemeral.clear();
    this.catchingUp = true;
    for (const state of states(this.state)) resetTurn(state);
  }

  invalidate() { this.disconnect(); this.invalid = true; }

  private project(event: DisplayEvent): string[] {
    if (this.agentIds) {
      if (event.type.startsWith('subagent.') && typeof event.data.toolCallId === 'string'
        && this.agentIds.includes(event.data.toolCallId)) return [];
      const { agentId: _agent, parentToolCallId: _parent, ...data } = event.data;
      event = { ...event, agentId: undefined, parentToolCallId: undefined, data };
    }
    if (!this.includeChildren && event.type.startsWith('subagent.') && event.type !== 'subagent.started') return [];
    if (event.type.startsWith('tool.') && typeof event.data.toolCallId === 'string'
      && this.state.pendingTask.has(event.data.toolCallId)) return [];
    const messageId = streamId(event);
    const id = messageId ? this.eventKey(event, messageId) : undefined;
    if (event.ephemeral) {
      if (this.catchingUp || this.recentEphemeral.has(event.id)) return [];
      this.recentEphemeral.add(event.id);
      if (this.recentEphemeral.size > 256) this.recentEphemeral.delete(this.recentEphemeral.values().next().value!);
      if (event.type === 'assistant.message_start' && id && !this.complete.has(id) && !this.blocked.has(id)) {
        this.streaming.add(id);
      }
      if (event.type === 'assistant.message_delta' && id
        && (!this.streaming.has(id) || this.complete.has(id) || this.blocked.has(id))) {
        if (!this.complete.has(id)) { this.blocked.add(id); this.partial = true; }
        return [];
      }
    }
    const finalId = finalizedId(event);
    const final = finalId ? this.eventKey(event, finalId) : undefined;
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
        this.unresolved = true;
      }
    }
    const result = foldEvent(this.state, event, {
      ...event.display, toolArgs: event.display?.toolArgs ? new Map(event.display.toolArgs) : undefined,
      scope: { details: this.includeChildren ? 'full' : 'summary' }, strictOwnership: true,
    });
    if (result.missingOwner) {
      this.unresolved = true;
    }
    if (event.type === 'subagent.started') this.resolveStreamOwners();
    return [...result.changed, ...result.nestedChanged ?? []];
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
    const retained = page.events.filter(event => displayTypes.has(event.type)).map(displayEvent);
    const incoming = retained.filter(event => !event.ephemeral && !this.ids.has(event.id));
    const changed = new Set<string>();
    if (request.direction === 'backward') {
      const adoptingLive = request.bootstrap && this.materialized;
      if (adoptingLive && this.durable.length && page.events.length && !page.events.some(event => this.ids.has(event.id))) {
        this.invalidate();
        throw new Error('恢复后的原生页面与已加载历史没有重叠；请重新同步，不会自动扫描旧历史。');
      }
      if (!adoptingLive) {
        this.older = position;
        this.hasMore = page.hasMore;
      }
      const transient = states(this.state).map((state, index) => ({
        root: index === 0, agentIds: [...state.agentIds],
        partials: state.messages.filter(message => this.streaming.has(this.key(state, message.id)) || this.blocked.has(this.key(state, message.id))),
        scratch: {
          streamingId: state.streamingId, pendingReasoning: state.pendingReasoning,
          reasoningId: state.reasoningId, reasoningBase: state.reasoningBase,
        },
      }));
      if (adoptingLive) {
        const lastOverlap = page.events.findLastIndex(event => this.ids.has(event.id));
        this.durable.push(...retained.slice(lastOverlap + 1).filter(event => !event.ephemeral && !this.ids.has(event.id)));
      } else this.durable = [...incoming, ...this.durable];
      this.state = newFoldState();
      this.complete.clear();
      this.unresolved = false;
      for (const event of this.durable) {
        this.ids.add(event.id);
        for (const id of this.project(event)) changed.add(id);
      }
      this.resolveStreamOwners();
      const rebuilt = states(this.state);
      for (const saved of transient) {
        const target = saved.root ? this.state : rebuilt.find(state => saved.agentIds.some(id => state.agentIds.has(id)));
        if (!target) continue;
        for (const message of saved.partials) {
          if (this.complete.has(this.key(target, message.id))) continue;
          const index = target.byId.get(message.id);
          if (index === undefined) {
            target.byId.set(message.id, target.messages.length);
            target.messages.push(message);
          } else target.messages[index] = message;
          changed.add(message.id);
        }
        const { scratch } = saved;
        if (scratch.pendingReasoning || (scratch.streamingId && !this.complete.has(this.key(target, scratch.streamingId)))) {
          Object.assign(target, scratch);
        }
      }
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
      for (const event of events) {
        if (!event.ephemeral) {
          if (this.ids.has(event.id)) continue;
          this.ids.add(event.id);
          this.durable.push(event);
        }
        for (const id of this.project(event)) changed.add(id);
      }
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

  get retainedEventCount() { return this.durable.length + this.recentEphemeral.size; }
  get projection(): FoldState { return this.state; }
}
