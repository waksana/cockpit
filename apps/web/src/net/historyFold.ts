import type { ChatMessage, NativeChatEvent } from '@cockpit/protocol';
import type { FoldState } from '@cockpit/protocol/chat';
import type { DisplayEvent } from './displayEvent';

export const ownersOf = (event: NativeChatEvent) => [
  event.agentId, event.parentToolCallId, event.data.agentId, event.data.parentToolCallId,
].filter((owner): owner is string => typeof owner === 'string' && !!owner);

export function states(root: FoldState): FoldState[] {
  return [root, ...[...root.subFolds.values()].flatMap(states)];
}

export interface OrderedEvent { event: DisplayEvent; order: number }
const messageId = (event: DisplayEvent) => typeof event.data.messageId === 'string'
  ? event.data.messageId : event.id;
const ownerOf = (event: DisplayEvent) => event.agentId
  ?? (typeof event.data.agentId === 'string' ? event.data.agentId : undefined)
  ?? (typeof event.data.parentToolCallId === 'string' ? event.data.parentToolCallId : undefined)
  ?? event.parentToolCallId ?? '';

function resetsScratch(event: DisplayEvent): boolean {
  return ['assistant.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.idle',
    'session.idle', 'abort', 'subagent.completed', 'subagent.failed'].includes(event.type)
    || (event.type === 'user.message' && !!event.data.content
      && !(typeof event.data.source === 'string' && event.data.source.startsWith('skill-')));
}

function scratchOwner(event: DisplayEvent): string | undefined {
  if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
    return typeof event.data.toolCallId === 'string' ? event.data.toolCallId : ownerOf(event);
  }
  return event.type === 'assistant.reasoning' || resetsScratch(event) ? ownerOf(event) : undefined;
}

/** Indexes references into this view's retained display events, not another history copy. */
export class HistoryFoldIndex {
  private count = 0;
  private dependents = new Map<string, Set<OrderedEvent>>();
  private heads = new Map<string, OrderedEvent[]>();
  private aliases = new Map<string, Set<string>>();
  private first = 0;
  private last = 0;

  get size() { return this.count; }

  order(events: DisplayEvent[], prepend: boolean): OrderedEvent[] {
    if (prepend) {
      this.first -= events.length;
      return events.map((event, index) => ({ event, order: this.first + index }));
    }
    return events.map(event => ({ event, order: this.last++ }));
  }

  private addDependency(key: string, item: OrderedEvent) {
    let values = this.dependents.get(key);
    if (!values) this.dependents.set(key, values = new Set());
    values.add(item);
  }

  learnAliases(events: DisplayEvent[]) {
    for (const event of events) {
      if (event.type.startsWith('subagent.')) continue;
      const owners = ownersOf(event);
      for (const owner of owners) {
        let aliases = this.aliases.get(owner);
        if (!aliases) this.aliases.set(owner, aliases = new Set());
        for (const alias of owners) aliases.add(alias);
      }
    }
  }

  add(items: OrderedEvent[], prepend: boolean) {
    this.learnAliases(items.map(item => item.event));
    const heads = new Map<string, OrderedEvent[]>();
    for (const item of items) {
      const { event } = item;
      this.count++;
      if (event.type === 'assistant.message') {
        const owners = ownersOf(event);
        for (const owner of owners.length ? owners : ['']) this.addDependency(`message:${owner}\0${messageId(event)}`, item);
      }
      if (typeof event.data.toolCallId === 'string') this.addDependency(`tool:${event.data.toolCallId}`, item);
      for (const owner of ownersOf(event)) this.addDependency(`owner:${owner}`, item);
      const owner = scratchOwner(event);
      if (owner !== undefined) {
        let head = heads.get(owner);
        if (!head) heads.set(owner, head = []);
        if (!head.length || !resetsScratch(head.at(-1)!.event)) head.push(item);
      }
    }
    for (const [owner, incoming] of heads) {
      const previous = this.heads.get(owner) ?? [];
      const [first, second] = prepend ? [incoming, previous] : [previous, incoming];
      this.heads.set(owner, first.length && resetsScratch(first.at(-1)!.event) ? first : [...first, ...second]);
    }
  }

  private ownerAliases(owners: Iterable<string>): Set<string> {
    const result = new Set(owners);
    for (const owner of result) for (const alias of this.aliases.get(owner) ?? []) result.add(alias);
    return result;
  }

  head(state: FoldState): OrderedEvent[] {
    const owners = this.ownerAliases(state.agentIds.size ? state.agentIds : ['']);
    const items = [...owners].flatMap(owner => this.heads.get(owner) ?? []).sort((a, b) => a.order - b.order);
    const end = items.findIndex(item => resetsScratch(item.event));
    return end < 0 ? items : items.slice(0, end + 1);
  }

  hasScratchBoundary(state: FoldState): boolean {
    return this.head(state).some(item => resetsScratch(item.event));
  }

  /** Follow only message/tool writes and newly supplied owners, not every known child's history. */
  dependencies(event: DisplayEvent, knownOwners: Set<string>): OrderedEvent[] {
    const keys: string[] = [];
    if (event.type === 'assistant.message') {
      const owners = ownersOf(event);
      for (const owner of this.ownerAliases(owners.length ? owners : [''])) keys.push(`message:${owner}\0${messageId(event)}`);
      if (Array.isArray(event.data.toolRequests)) {
        for (const request of event.data.toolRequests) {
          if (request && typeof request === 'object' && typeof request.toolCallId === 'string') {
            keys.push(`tool:${request.toolCallId}`);
          }
        }
      }
    }
    if (event.type === 'subagent.started') {
      const owners = [event.data.toolCallId, event.data.agentId, event.agentId]
        .filter((owner): owner is string => typeof owner === 'string' && !knownOwners.has(owner));
      for (const owner of this.ownerAliases(owners)) if (!knownOwners.has(owner)) keys.push(`owner:${owner}`);
      if (typeof event.data.toolCallId === 'string') keys.push(`tool:${event.data.toolCallId}`);
    }
    return keys.flatMap(key => [...this.dependents.get(key) ?? []]);
  }
}

export type MessageOrders = WeakMap<FoldState, Map<string, number>>;

/** Merge only projected dependencies; untouched messages keep their object identity. */
export function mergeHistoryFold(
  prefix: FoldState, suffix: FoldState, orders: MessageOrders, index: HistoryFoldIndex, changed: Set<string>,
): FoldState {
  const prefixOrders = orders.get(prefix) ?? new Map<string, number>();
  const suffixOrders = orders.get(suffix) ?? new Map<string, number>();
  for (const [id, order] of prefixOrders) suffixOrders.set(id, Math.min(order, suffixOrders.get(id) ?? Infinity));
  orders.set(suffix, suffixOrders);
  const replacements = new Map(prefix.messages.map(message => [message.id, message]));
  for (const [tool, sub] of prefix.subFolds) {
    const existing = suffix.subFolds.get(tool);
    const merged = existing ? mergeHistoryFold(sub, existing, orders, index, changed) : sub;
    suffix.subFolds.set(tool, merged);
    const cardId = prefix.subCard.get(tool)!;
    const card = replacements.get(cardId);
    if (card?.subMessages) card.subMessages = merged.messages;
  }
  // A repaired child can change an existing ancestor even when that card wasn't replayed.
  for (const [tool, sub] of suffix.subFolds) {
    const cardId = suffix.subCard.get(tool) ?? prefix.subCard.get(tool);
    if (!cardId) continue;
    const card = replacements.get(cardId) ?? suffix.messages[suffix.byId.get(cardId) ?? -1];
    if (card?.subMessages && card.subMessages !== sub.messages) {
      card.subMessages = sub.messages;
      changed.add(cardId);
    }
  }
  if (replacements.size) {
    const incoming = [...prefix.messages].sort((a, b) => suffixOrders.get(a.id)! - suffixOrders.get(b.id)!);
    const messages: ChatMessage[] = [];
    let position = 0;
    for (const message of suffix.messages) {
      if (replacements.has(message.id)) continue;
      while (position < incoming.length && suffixOrders.get(incoming[position].id)! < suffixOrders.get(message.id)!) {
        messages.push(incoming[position++]);
      }
      messages.push(message);
    }
    messages.push(...incoming.slice(position));
    suffix.messages = messages;
    suffix.byId = new Map(messages.map((message, position) => [message.id, position]));
  }
  for (const [id, owner] of prefix.toolMsg) if (!suffix.toolMsg.has(id)) suffix.toolMsg.set(id, owner);
  for (const [id, task] of prefix.pendingTask) if (!suffix.pendingTask.has(id)) suffix.pendingTask.set(id, task);
  for (const id of prefix.askToolIds) suffix.askToolIds.add(id);
  for (const id of prefix.agentIds) suffix.agentIds.add(id);
  for (const [id, card] of prefix.subCard) suffix.subCard.set(id, card);
  if ((prefix.pendingReasoning || prefix.streamingId) && !index.hasScratchBoundary(suffix)) {
    suffix.streamingId = prefix.streamingId;
    suffix.pendingReasoning = prefix.pendingReasoning;
    suffix.reasoningId = prefix.reasoningId;
    suffix.reasoningBase = prefix.reasoningBase;
  }
  suffix.currentModelId ??= prefix.currentModelId;
  return suffix;
}
