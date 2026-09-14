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

/** Indexes references into this view's retained display events, not another history copy. */
export class HistoryFoldIndex {
  private count = 0;
  private dependents = new Map<string, Set<OrderedEvent>>();
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

  add(items: OrderedEvent[]) {
    this.learnAliases(items.map(item => item.event));
    for (const item of items) {
      const { event } = item;
      this.count++;
      if (event.type === 'assistant.message') {
        const owners = ownersOf(event);
        for (const owner of owners.length ? owners : ['']) this.addDependency(`message:${owner}\0${messageId(event)}`, item);
        if (Array.isArray(event.data.toolRequests)) for (const request of event.data.toolRequests) {
          if (!request || typeof request !== 'object' || typeof request.toolCallId !== 'string') continue;
          if (request.name === 'task') this.addDependency(`task:${request.toolCallId}`, item);
          for (const owner of owners.length ? owners : ['']) {
            this.addDependency(`tool:${owner}\0${request.toolCallId}`, item);
          }
        }
      }
      if (event.type === 'assistant.reasoning' && typeof event.data.reasoningId === 'string') {
        const owners = ownersOf(event);
        for (const owner of owners.length ? owners : ['']) this.addDependency(`reasoning:${owner}\0${event.data.reasoningId}`, item);
      }
      if (event.type === 'assistant.reasoning' && event.parentId) {
        this.addDependency(`reference:${ownerOf(event)}\0${event.parentId}`, item);
      }
      if (typeof event.data.toolCallId === 'string') {
        if (event.type.startsWith('subagent.')) this.addDependency(`task:${event.data.toolCallId}`, item);
        else {
          const owners = ownersOf(event);
          for (const owner of owners.length ? owners : ['']) this.addDependency(`tool:${owner}\0${event.data.toolCallId}`, item);
          if (event.type === 'tool.execution_start' && (event.parentToolCallId || event.data.parentToolCallId)) {
            this.addDependency(`legacy-tool:${event.data.toolCallId}`, item);
          }
        }
      }
      if (event.type === 'subagent.started') {
        for (const owner of [event.data.toolCallId, event.data.agentId, event.agentId]) {
          if (typeof owner === 'string') this.addDependency(`owner-definition:${owner}`, item);
        }
      }
      for (const owner of ownersOf(event)) this.addDependency(`owner:${owner}`, item);
    }
  }

  private ownerAliases(owners: Iterable<string>): Set<string> {
    const result = new Set(owners);
    for (const owner of result) for (const alias of this.aliases.get(owner) ?? []) result.add(alias);
    return result;
  }

  /** Follow only message/tool writes and newly supplied owners, not every known child's history. */
  dependencies(event: DisplayEvent, knownOwners: Set<string>): OrderedEvent[] {
    const keys: string[] = [];
    for (const owner of this.ownerAliases([ownerOf(event)])) keys.push(`reference:${owner}\0${event.id}`);
    if ((event.type === 'tool.execution_start' || event.type === 'user_input.requested')
      && typeof event.data.toolCallId === 'string') {
      const owners = ownersOf(event);
      for (const owner of this.ownerAliases(owners.length ? owners : [''])) keys.push(`tool:${owner}\0${event.data.toolCallId}`);
      if (event.type === 'tool.execution_start' && (event.parentToolCallId || event.data.parentToolCallId)) {
        keys.push(`tool:\0${event.data.toolCallId}`, `legacy-tool:${event.data.toolCallId}`);
        keys.push(`owner-definition:${event.data.parentToolCallId ?? event.parentToolCallId}`);
      }
      if (!owners.length) keys.push(`legacy-tool:${event.data.toolCallId}`);
      keys.push(`task:${event.data.toolCallId}`);
    }
    if (event.type === 'assistant.reasoning' && typeof event.data.reasoningId === 'string') {
      const owners = ownersOf(event);
      for (const owner of this.ownerAliases(owners.length ? owners : [''])) {
        keys.push(`reasoning:${owner}\0${event.data.reasoningId}`);
      }
    }
    if (event.type === 'assistant.message') {
      const owners = ownersOf(event);
      for (const owner of this.ownerAliases(owners.length ? owners : [''])) keys.push(`message:${owner}\0${messageId(event)}`);
      if (Array.isArray(event.data.toolRequests)) {
        for (const request of event.data.toolRequests) {
          if (!request || typeof request !== 'object' || typeof request.toolCallId !== 'string') continue;
          if (request.name === 'task') {
            keys.push(`task:${request.toolCallId}`);
            for (const owner of owners) keys.push(`owner-definition:${owner}`);
          }
          else for (const owner of this.ownerAliases(owners.length ? owners : [''])) {
            keys.push(`tool:${owner}\0${request.toolCallId}`);
            if (!owner) keys.push(`legacy-tool:${request.toolCallId}`);
          }
        }
      }
    }
    if (event.type === 'subagent.started') {
      for (const owner of [event.data.parentId, event.data.parentToolCallId, event.parentToolCallId, event.agentId]) {
        if (typeof owner === 'string') keys.push(`owner-definition:${owner}`);
      }
      const owners = [event.data.toolCallId, event.data.agentId, event.agentId]
        .filter((owner): owner is string => typeof owner === 'string' && !knownOwners.has(owner));
      for (const owner of this.ownerAliases(owners)) if (!knownOwners.has(owner)) keys.push(`owner:${owner}`);
      if (typeof event.data.toolCallId === 'string') keys.push(`task:${event.data.toolCallId}`);
    }
    return keys.flatMap(key => [...this.dependents.get(key) ?? []]);
  }
}

export type MessageOrders = WeakMap<FoldState, Map<string, number>>;

/** Merge only projected dependencies; untouched messages keep their object identity. */
export function mergeHistoryFold(
  prefix: FoldState, suffix: FoldState, orders: MessageOrders, changed: Set<string>,
  rootTools = new Set(prefix.messages.flatMap(message => message.toolCalls?.map(tool => tool.toolCallId) ?? [])),
): FoldState {
  const prefixOrders = orders.get(prefix) ?? new Map<string, number>();
  const suffixOrders = orders.get(suffix) ?? new Map<string, number>();
  for (const [id, order] of prefixOrders) {
    suffixOrders.set(id, Math.min(order, suffixOrders.get(id) ?? Infinity));
  }
  orders.set(suffix, suffixOrders);
  for (const [id, metadata] of prefix.toolMetadata) {
    suffix.toolMetadata.set(id, { ...metadata, ...suffix.toolMetadata.get(id) });
  }
  for (const message of prefix.messages) {
    const tool = message.toolCalls?.[0];
    if (!tool || prefix.toolMsg.has(tool.toolCallId) || !suffix.toolMsg.has(tool.toolCallId)) continue;
    const actual = suffix.messages[suffix.byId.get(message.id) ?? -1]?.toolCalls?.[0];
    const metadata = suffix.toolMetadata.get(tool.toolCallId);
    if (actual) Object.assign(tool, { title: metadata?.executionTitle ?? metadata?.title ?? actual.title,
      ...(actual.name !== undefined ? { name: actual.name } : {}),
      ...(actual.args !== undefined ? { args: actual.args } : {}) });
  }
  const replacements = new Map(prefix.messages.map(message => [message.id, message]));
  for (const toolCallId of prefix.toolMetadata.keys()) {
    const metadata = suffix.toolMetadata.get(toolCallId)!;
    const replyId = `reply-${toolCallId}`;
    const reply = replacements.get(replyId) ?? suffix.messages[suffix.byId.get(replyId) ?? -1];
    if (reply && metadata.question && reply.replyQuestion !== metadata.question) {
      reply.replyQuestion = metadata.question;
      changed.add(replyId);
    }
  }
  const removed = new Set([...prefix.toolMsg].filter(([, owner]) => !owner).map(([id]) => `tool-${id}`));
  if (prefix.agentIds.size) for (const [id, metadata] of prefix.toolMetadata) {
    if (metadata.legacyOwner && rootTools.has(id) && !prefix.byId.has(`reply-${id}`)) {
      removed.add(`reply-${id}`);
      changed.add(`reply-${id}`);
    }
  }
  if (!prefix.agentIds.size && !suffix.agentIds.size) {
    for (const child of states(prefix).slice(1)) for (const [id, metadata] of child.toolMetadata) {
      // An explicitly parented legacy start can move a result-only root row
      // into its child. Never remove an independently observed root invocation.
      const messageId = `tool-${id}`;
      if (metadata.legacyOwner && !prefix.byId.has(messageId) && !suffix.toolMsg.has(id)
        && !suffix.toolMetadata.has(id) && !suffix.askToolIds.has(id)) {
        removed.add(messageId);
      }
    }
  }
  for (const [rid, response] of prefix.reasoning) {
    const previous = suffix.reasoning.get(rid);
    if (previous && previous !== response && suffix.messages[suffix.byId.get(previous) ?? -1]?.incomplete) {
      removed.add(previous);
      suffix.completed.delete(previous);
      suffix.reasoning.set(rid, response);
    }
  }
  for (const id of removed) suffixOrders.delete(id);
  for (const [tool, sub] of prefix.subFolds) {
    const existing = suffix.subFolds.get(tool);
    const cardId = prefix.subCard.get(tool)!;
    const card = replacements.get(cardId);
    const old = suffix.messages[suffix.byId.get(cardId) ?? -1]?.subagent;
    if (card?.subagent && old && existing
      && (existing.executionOrder ?? -Infinity) >= (sub.executionOrder ?? -Infinity)) {
      const { error: _error, ...info } = card.subagent;
      // An older page can reveal the terminal boundary preceding known later activity.
      const status = old.status === 'running' && info.status !== 'running' ? 'activity' : old.status;
      card.subagent = { ...info, status, ...(old.error ? { error: old.error } : {}) };
    }
    const merged = existing ? mergeHistoryFold(sub, existing, orders, changed, rootTools) : sub;
    suffix.subFolds.set(tool, merged);
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
  if (replacements.size || removed.size) {
    const incoming = [...prefix.messages]
      .sort((a, b) => suffixOrders.get(a.id)! - suffixOrders.get(b.id)!);
    const messages: ChatMessage[] = [];
    let position = 0;
    for (const message of suffix.messages) {
      if (replacements.has(message.id) || removed.has(message.id)) continue;
      while (position < incoming.length && suffixOrders.get(incoming[position].id)! < suffixOrders.get(message.id)!) {
        messages.push(incoming[position++]);
      }
      messages.push(message);
    }
    messages.push(...incoming.slice(position));
    suffix.messages = messages;
    suffix.byId = new Map(messages.map((message, position) => [message.id, position]));
  }
  for (const [id, owner] of prefix.toolMsg) if (!suffix.toolMsg.has(id) || !owner) suffix.toolMsg.set(id, owner);
  for (const [id, task] of prefix.pendingTask) if (!suffix.pendingTask.has(id)) suffix.pendingTask.set(id, task);
  for (const id of prefix.askToolIds) suffix.askToolIds.add(id);
  for (const id of prefix.agentIds) suffix.agentIds.add(id);
  for (const [id, card] of prefix.subCard) suffix.subCard.set(id, card);
  for (const id of prefix.completed) suffix.completed.add(id);
  for (const [id, response] of prefix.responses) {
    const existing = suffix.responses.get(id);
    suffix.responses.set(id, existing === undefined || existing === response ? response : null);
  }
  for (const [id, response] of prefix.reasoning) if (!suffix.reasoning.has(id)) suffix.reasoning.set(id, response);
  if (prefix.responseOrder !== undefined && (suffix.responseOrder === undefined || prefix.responseOrder > suffix.responseOrder)) {
    suffix.responseOrder = prefix.responseOrder;
    suffix.activeResponse = prefix.activeResponse;
  }
  suffix.currentModelId ??= prefix.currentModelId;
  if (prefix.executionOrder !== undefined
    && (suffix.executionOrder === undefined || prefix.executionOrder > suffix.executionOrder)) {
    suffix.executionOrder = prefix.executionOrder;
  }
  return suffix;
}
