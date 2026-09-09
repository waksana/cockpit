import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { deserialize, serialize } from 'node:v8';
import { deflateSync, inflateSync } from 'node:zlib';
import type { CopilotClient } from '@github/copilot-sdk';
import { summarizeMessage, type ChatMessage, type HistoryDetails, type HistoryPage, type HistoryResume, type HistoryResumeResult, type SubagentHistoryPage } from '@cockpit/protocol';
import {
  cleanSessionTitle, foldEvent, isFoldContentVisible, newFoldState, toolArgsOf, toolOutputOf,
  type FoldHistoryScope, type FoldProjection, type FoldState,
} from './fold.ts';
import { normalizeEvent, type SdkEvent } from './sdk-types.ts';
import { toolImagesOf } from './tool-image.ts';

export const DEFAULT_HISTORY_LIMIT = 30;
export const MAX_HISTORY_LIMIT = 200;

type ReadPersistedEvents = CopilotClient['rpc']['sessions']['readPersistedEvents'];
type ReadParams = Parameters<ReadPersistedEvents>[0];
type ReadResult = Awaited<ReturnType<ReadPersistedEvents>>;
interface HistoryEvent extends SdkEvent { projection?: FoldProjection; source?: { cursor: string } }
type HistoryBatch = Omit<ReadResult, 'events'> & {
  events: HistoryEvent[]; readCount: number; stopped?: boolean; lastId?: string;
};

export interface HistoryReaderOptions {
  readPersistedEvents: ReadPersistedEvents;
  maxEntries?: number;
  maxBytes?: number;
  maxMessages?: number;
  /** Native batches are 1..1000 events; independent of the UI message limit. */
  batchSize?: number;
  /** Maximum events per native batch, not a limit on valid history length. */
  maxEvents?: number;
  /** Projected byte target used to size subsequent native batches. */
  maxReadBytes?: number;
}

export interface HistoryMetadata {
  title: string;
  cwd: string;
}

export type HistoryPageWithMetadata = HistoryPage & HistoryMetadata;

interface Projection {
  state: FoldState;
  messages: ChatMessage[];
  origins: Map<string, number>;
  unresolved: Set<string>;
  unknownAnswers: number[];
  resumeUpdates?: { changed: Set<string>; uncertain: boolean };
}

interface Window {
  details: HistoryDetails;
  events: HistoryEvent[];
  prefixLength: number;
  cursor: string;
  hasMore: boolean;
  tailCursor: string;
  tailEventId?: string;
  tailDigest: string;
  atTail: boolean;
  projection: Projection;
  metadata?: HistoryMetadata;
}

interface CachedWindow {
  data: Buffer;
  messages: number;
  sessionId: string;
  scope: FoldHistoryScope;
  resume?: ResumeScan;
}

type Snapshot = Omit<Window, 'projection'>;

interface Checkpoint {
  sessionId: string;
  details: HistoryDetails;
  epoch: number;
  firstMsgId: string;
  floorId: string;
  limitId: string;
  floorCursor: string;
  tailCursor: string;
  tailId: string;
}

interface ResumeScan {
  token: string;
  checkpoint: Checkpoint;
  reached: boolean;
  delivered: number;
}

interface ChildSnapshot {
  direction: 'forward' | 'backward';
  events: HistoryEvent[];
  headCursor: string;
  headId?: string;
  tailCursor: string;
  tailEventId?: string;
}

interface ChildSeed {
  cursor: string;
  tailCursor: string;
  tailEventId?: string;
  untilId: string;
  state: FoldState;
}

interface ReadBudget { events: number; bytes: number }

const displayEvents = new Set([
  'session.start', 'session.title_changed', 'session.model_change', 'session.error', 'session.warning',
  'user.message', 'user_input.requested', 'skill.invoked',
  'assistant.turn_start', 'assistant.turn_end', 'assistant.idle', 'session.idle', 'abort',
  'assistant.reasoning', 'assistant.reasoning_delta', 'assistant.message_start',
  'assistant.message_delta', 'assistant.message',
  'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed', 'subagent.configured',
]);

function historyEvent(
  raw: ReadResult['events'][number] | HistoryEvent, scope: FoldHistoryScope = { details: 'full' },
  visible?: boolean,
): HistoryEvent {
  if (!displayEvents.has(raw.type)) {
    // Keep cursor identity, not invisible hook/permission payloads or ownership.
    return { type: raw.type, id: raw.id, timestamp: raw.timestamp, data: {} };
  }
  const event: HistoryEvent = normalizeEvent(raw);
  const previous = 'projection' in raw ? raw.projection : undefined;
  visible ??= scope.details === 'full' || !ownerOf(event);
  if (!visible && !event.type.startsWith('subagent.')) {
    event.data = {
      parentToolCallId: event.data.parentToolCallId, toolCallId: event.data.toolCallId,
      turnId: event.data.turnId,
      ...(Array.isArray(event.data.toolRequests) ? { toolRequests: event.data.toolRequests } : {}),
    };
  }
  if (event.type === 'assistant.message') {
    delete event.data.encryptedContent;
    delete event.data.reasoningOpaque;
    delete event.data.reasoningBlocks;
    if (Array.isArray(event.data.toolRequests)) {
      const toolArgs = new Map<string, string>();
      event.data.toolRequests = event.data.toolRequests.map((value: unknown) => {
        if (!value || typeof value !== 'object') return value;
        const request = value as Record<string, unknown>;
        if (typeof request.toolCallId !== 'string') return request;
        if (request.name === 'task') {
          const args = request.arguments as Record<string, unknown> | undefined;
          const keys = ['description', 'agent_type'];
          if ((visible && scope.details === 'full') || request.toolCallId === scope.toolCallId) keys.push('prompt');
          return {
            toolCallId: request.toolCallId, name: request.name,
            arguments: Object.fromEntries(keys.flatMap(key => typeof args?.[key] === 'string' ? [[key, args[key]]] : [])),
          };
        }
        if (!visible) return { toolCallId: request.toolCallId, name: request.name };
        toolArgs.set(request.toolCallId, previous?.toolArgs?.get(request.toolCallId) ?? toolArgsOf(
          typeof request.name === 'string' ? request.name : undefined, request.arguments,
        ));
        const args = request.arguments as { path?: unknown } | undefined;
        return { ...request, arguments: args && typeof args === 'object' ? { path: args.path } : undefined };
      });
      event.projection = { toolArgs };
    }
  } else if (event.type === 'tool.execution_complete') {
    event.projection = {
      toolOutput: (visible ? previous?.toolOutput : undefined) ?? toolOutputOf(event.data.result, event.data.error),
      toolImages: visible ? previous?.toolImages ?? toolImagesOf(event) : [],
    };
    const result = event.data.result as Record<string, unknown> | undefined;
    // Generic details already have the canonical fold's cap. Ask answers remain
    // whole and are still classified by the shared fold, never guessed as replies.
    event.data.result = result && typeof result === 'object' ? {
      ...Object.fromEntries(['content', 'detailedContent'].flatMap(key => {
        const value = result[key];
        return typeof value === 'string' && /^User (?:responded|selected):/.test(value.trim()) ? [[key, value]] : [];
      })),
      dismissed: result.dismissed, isError: result.isError, success: result.success,
      error: result.error != null ? true : undefined,
    } : undefined;
    if (event.data.error != null) event.data.error = true;
  } else if (event.type === 'tool.execution_start') {
    delete event.data.arguments;
  }
  return event;
}

function scopedEvent(
  raw: ReadResult['events'][number] | HistoryEvent, scope: FoldHistoryScope, state: FoldState, routingOnly = false,
): HistoryEvent | undefined {
  const visible = displayEvents.has(raw.type) && isFoldContentVisible(state, normalizeEvent(raw), scope);
  const event = historyEvent(raw, scope, visible);
  delete event.source;
  if (!routingOnly) foldEvent(state, event, { ...event.projection, scope });
  if (!visible && !event.type.startsWith('subagent.') && !requests(event).length
    && !(event.agentId && (event.parentToolCallId || event.data.parentToolCallId))) return undefined;
  return event;
}

function budget(value: number | undefined, fallback: number, minimum = 0): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new Error(`History budgets must be safe integers at least ${minimum}`);
  }
  return result;
}

function validatePage(beforeMsgId: string | undefined, limit: number, afterMsgId: string | undefined): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new Error(`History limit must be a positive integer at most ${MAX_HISTORY_LIMIT}`);
  }
  for (const anchor of [beforeMsgId, afterMsgId]) {
    if (anchor !== undefined && (typeof anchor !== 'string' || anchor.length === 0)) {
      throw new Error('History anchors must be non-empty message IDs');
    }
  }
  if (beforeMsgId !== undefined && afterMsgId !== undefined) {
    throw new Error('History beforeMsgId and afterMsgId are mutually exclusive');
  }
}

export function pageHistory(
  sessionId: string, messages: ChatMessage[], beforeMsgId?: string,
  limit = DEFAULT_HISTORY_LIMIT, afterMsgId?: string,
): HistoryPage {
  validatePage(beforeMsgId, limit, afterMsgId);
  if (afterMsgId !== undefined) {
    const anchor = messages.findIndex((message) => message.id === afterMsgId);
    if (anchor >= 0 && messages.length - anchor - 1 <= limit) {
      return { sessionId, messages: structuredClone(messages.slice(anchor)), hasMore: false, append: true };
    }
  } else if (beforeMsgId !== undefined) {
    const end = messages.findIndex((message) => message.id === beforeMsgId);
    if (end >= 0) {
      const start = Math.max(0, end - limit);
      return { sessionId, messages: structuredClone(messages.slice(start, end)), hasMore: start > 0 };
    }
  }
  const start = Math.max(0, messages.length - limit);
  return { sessionId, messages: structuredClone(messages.slice(start)), hasMore: start > 0, latest: true };
}

function ownerOf(event: SdkEvent): unknown {
  return event.agentId ?? event.parentToolCallId ?? event.data.parentToolCallId;
}

function rootUser(event: SdkEvent): boolean {
  return event.type === 'user.message' && !ownerOf(event) && typeof event.data.content === 'string'
    && event.data.content.length > 0
    && !(typeof event.data.source === 'string' && event.data.source.startsWith('skill-'));
}

function rootBoundary(event: SdkEvent): boolean {
  return rootUser(event) || (!ownerOf(event) && event.type === 'assistant.turn_start');
}

function requests(event: SdkEvent): string[] {
  if (!Array.isArray(event.data.toolRequests)) return [];
  return event.data.toolRequests.flatMap((request: unknown) => {
    const id = request && typeof request === 'object' && 'toolCallId' in request ? request.toolCallId : undefined;
    return typeof id === 'string' ? [id] : [];
  });
}

function project(
  events: HistoryEvent[], hasMore: boolean, prefixLength = events.length, details: HistoryDetails = 'full',
  afterEventId?: string,
): Projection {
  const start = hasMore ? events.findIndex(rootBoundary) : 0;
  if (start < 0) return {
    state: newFoldState(), messages: [], origins: new Map(), unresolved: new Set(), unknownAnswers: [],
  };
  const fold = newFoldState();
  const origins = new Map<string, number>();
  const requested = new Set<string>();
  const startedTools = new Set<string>();
  const unresolved = new Set<string>();
  const unknownAnswers: number[] = [];
  const resumeUpdates = afterEventId ? { changed: new Set<string>(), uncertain: false } : undefined;
  let after = false;
  let turn = start;
  for (let i = start; i < events.length; i++) {
    const event = events[i]!;
    if (rootBoundary(event)) turn = i;
    const toolRequests = requests(event);
    const owner = ownerOf(event);
    if (toolRequests.length) {
      const pending = [fold];
      let known = !owner;
      while (!known && pending.length) {
        const state = pending.pop()!;
        known = typeof owner === 'string' && state.agentIds.has(owner);
        pending.push(...state.subFolds.values());
      }
      if (known) for (const id of toolRequests) requested.add(id);
    }
    if (event.type === 'tool.execution_start' && typeof event.data.toolCallId === 'string') {
      startedTools.add(event.data.toolCallId);
    }
    if (after && resumeUpdates && displayEvents.has(event.type)
      && (!isFoldContentVisible(fold, event, { details: 'full' })
        || (event.type.startsWith('tool.execution_') && !requested.has(String(event.data.toolCallId))))) {
      resumeUpdates.uncertain = true;
    }
    const changed = foldEvent(fold, event, { ...event.projection, scope: { details } }).changed;
    if (after && resumeUpdates) for (const id of changed) resumeUpdates.changed.add(id);
    if (event.id === afterEventId) after = true;
    if (hasMore && event.type === 'subagent.started' && !requested.has(String(event.data.toolCallId))) {
      for (const id of changed) unresolved.add(id);
    }
    if (hasMore && !ownerOf(event) && event.type === 'tool.execution_complete'
      && !requested.has(String(event.data.toolCallId)) && !startedTools.has(String(event.data.toolCallId))) {
      const result = event.data.result as { content?: unknown; detailedContent?: unknown } | undefined;
      if ([result?.content, result?.detailedContent].some(value =>
        typeof value === 'string' && /^User (?:responded|selected):/.test(value.trim()))) unknownAnswers.push(i);
    }
    for (const id of changed) {
      if (i < prefixLength && !origins.has(id)) origins.set(id, turn);
    }
  }
  return {
    state: fold,
    messages: details === 'summary' ? fold.messages.map(summarizeMessage) : fold.messages,
    origins, unresolved, unknownAnswers,
    ...(resumeUpdates ? { resumeUpdates: { ...resumeUpdates, uncertain: resumeUpdates.uncertain || !after } } : {}),
  };
}

function eventBytes(events: readonly unknown[]): number {
  return events.reduce<number>((bytes, event) => bytes + serialize(event).byteLength, 0);
}

function digest(events: SdkEvent[]): string {
  return createHash('sha256').update(serialize(events)).digest('hex');
}

function messageCount(messages: ChatMessage[]): number {
  let count = 0;
  const pending = [messages];
  while (pending.length) {
    for (const message of pending.pop()!) {
      count++;
      if (message.subMessages?.length) pending.push(message.subMessages);
    }
  }
  return count;
}

function childOf(state: FoldState, toolCallId: string): { card: ChatMessage; state: FoldState } | undefined {
  const child = state.subFolds.get(toolCallId);
  const cardId = state.subCard.get(toolCallId);
  const index = cardId === undefined ? undefined : state.byId.get(cardId);
  const card = index === undefined ? undefined : state.messages[index];
  if (child && card) return { card, state: child };
  for (const sub of state.subFolds.values()) {
    const result = childOf(sub, toolCallId);
    if (result) return result;
  }
  return undefined;
}

function metadataOf(sessionId: string, events: SdkEvent[], previous?: HistoryMetadata): HistoryMetadata {
  let cwd = previous?.cwd ?? homedir();
  let title = previous?.title ?? '';
  for (const event of events) {
    if (ownerOf(event)) continue;
    if (event.type === 'session.start') {
      const context = event.data.context as { workingDirectory?: unknown; cwd?: unknown } | undefined;
      const directory = context?.workingDirectory ?? context?.cwd;
      if (typeof directory === 'string' && directory) cwd = directory;
    } else if (event.type === 'session.title_changed' && typeof event.data.title === 'string') {
      title = cleanSessionTitle(event.data.title).slice(0, 60) || title;
    } else if (!title && rootUser(event)) {
      title = cleanSessionTitle(event.data.content as string).slice(0, 60);
    }
  }
  return { cwd, title: title || sessionId.slice(0, 8) };
}

/**
 * Passive native journal reads only: no resume, subscriptions, flush or timers.
 * Before pages continue a bounded snapshot; clear after mutations/rewind/delete.
 * Only dependencies of the requested messages extend a page. Off-page tool/agent
 * updates travel backward until their owner is reached. Native batches and the
 * cache stay bounded; large valid messages are never rejected by a work budget.
 */
export class SessionHistoryReader {
  private readonly readPersistedEvents: ReadPersistedEvents;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxMessages: number;
  private readonly batchSize: number;
  private readonly maxEvents: number;
  private readonly maxReadBytes: number;
  private readonly cache = new Map<string, CachedWindow>();
  private cachedBytes = 0;
  private cachedMessages = 0;
  private epoch = 0;
  private readonly resumeKey = randomBytes(32);

  constructor(options: HistoryReaderOptions) {
    if (typeof options?.readPersistedEvents !== 'function') {
      throw new Error('History requires the passive readPersistedEvents RPC');
    }
    this.readPersistedEvents = options.readPersistedEvents;
    this.maxEntries = budget(options.maxEntries, 3);
    this.maxBytes = budget(options.maxBytes, 8 * 1024 * 1024);
    this.maxMessages = budget(options.maxMessages, 10_000);
    this.batchSize = budget(options.batchSize, 1000, 1);
    if (this.batchSize > 1000) throw new Error('History batchSize must be at most 1000');
    this.maxEvents = budget(options.maxEvents, 10_000, 1);
    this.maxReadBytes = budget(options.maxReadBytes, 16 * 1024 * 1024, 1);
  }

  async read(
    sessionId: string, beforeMsgId?: string, limit = DEFAULT_HISTORY_LIMIT, afterMsgId?: string,
    details: HistoryDetails = 'full',
  ): Promise<HistoryPage> {
    return (await this.load(sessionId, beforeMsgId, limit, afterMsgId, false, details)).page;
  }

  async readResume(
    sessionId: string, resume: HistoryResume, limit = DEFAULT_HISTORY_LIMIT, details: HistoryDetails = 'full',
  ): Promise<HistoryPage> {
    validatePage(undefined, limit, undefined);
    if (!sessionId || (details !== 'full' && details !== 'summary')) throw new Error('Invalid history resume scope');
    const unavailable = (reason: Extract<HistoryResumeResult, { status: 'unavailable' }>['reason']): HistoryPage =>
      ({ sessionId, messages: [], hasMore: false, resume: { status: 'unavailable', reason } });
    const key = details === 'full' ? sessionId : JSON.stringify([sessionId, details]);
    const epoch = this.epoch;
    const spent: ReadBudget = { events: 0, bytes: 0 };
    const boundary = async (cursor: string) => (await this.batch({
      sessionId, direction: 'backward', cursor, max: 1,
    }, spent, undefined, { details })).cursorStatus === 'ok';
    if (resume.token === undefined) {
      const { page, window, epoch: loadedEpoch } = await this.load(sessionId, undefined, limit, undefined, false, details);
      if (loadedEpoch !== this.epoch) return unavailable('changed');
      const checkpoint = this.checkpoint(sessionId, window, page.messages);
      if (checkpoint && (!await boundary(checkpoint.floorCursor) || !await boundary(checkpoint.tailCursor))) {
        return unavailable('expired');
      }
      if (loadedEpoch !== this.epoch) return unavailable('changed');
      return { ...page, resume: { status: 'ready', ...(checkpoint ? { token: this.signCheckpoint(checkpoint) } : {}) } };
    }
    const cached = this.cache.get(key);
    const pending = cached?.resume?.token === resume.token ? cached.resume : undefined;
    const checkpoint = pending?.checkpoint ?? this.readCheckpoint(resume.token);
    if (!checkpoint) return unavailable('locator');
    if (checkpoint.sessionId !== sessionId || checkpoint.details !== details) {
      throw new Error('History resume locator belongs to a different session or detail scope');
    }
    if (checkpoint.epoch !== epoch) return unavailable('changed');
    // A concurrent passive read can replace the cache without changing history.
    // This request owns its captured snapshot; epochs and native fences validate it.
    const current = () => epoch === this.epoch;
    if (!await boundary(checkpoint.floorCursor) || !await boundary(checkpoint.tailCursor)) return unavailable('expired');
    if (!current()) return unavailable('changed');
    const snapshot = pending && cached ? deserialize(inflateSync(cached.data)) as Snapshot : undefined;
    let window: Window = snapshot ? {
      ...snapshot, projection: project(snapshot.events, snapshot.hasMore, snapshot.prefixLength, details, checkpoint.tailId),
    } : this.window(await this.batch({ sessionId, direction: 'backward', max: 1 }, spent, undefined, { details }), details);
    let reached = pending?.reached ?? window.events.some(event => event.id === checkpoint.floorId);
    // Fixed native work per request, independent of the UI page size. Every next
    // batch starts at this captured range's cursor, never at a newer moving tail.
    for (let reads = 0; !reached && window.hasMore && reads < 4; reads++) {
      const older = await this.batch({
        sessionId, direction: 'backward', cursor: window.cursor, max: Math.min(200, this.batchSize),
      }, spent, undefined, { details });
      if (older.cursorStatus === 'expired') return unavailable('expired');
      if (older.hasMore && (!older.readCount || older.cursor === window.cursor)) {
        throw new Error('History resume cursor did not advance');
      }
      const events = [...older.events, ...window.events];
      reached = older.events.some(event => event.id === checkpoint.floorId);
      if (!reached && older.events.some(event => event.id === checkpoint.limitId)) return unavailable('boundary');
      window = {
        ...window, events, cursor: older.cursor, hasMore: older.hasMore,
        prefixLength: events.length, projection: project(events, older.hasMore, events.length, details, checkpoint.tailId),
      };
    }
    if (!reached && !window.hasMore) return unavailable('boundary');
    if (!await boundary(checkpoint.floorCursor) || !await boundary(checkpoint.tailCursor)
      || !await boundary(window.tailCursor)) return unavailable('expired');
    if (!current()) return unavailable('changed');
    const first = window.projection.messages.findIndex(message => message.id === checkpoint.firstMsgId);
    const messages = reached && first >= 0 ? window.projection.messages.slice(first) : [];
    const updates = window.projection.resumeUpdates;
    const prefixChanged = updates && window.projection.messages.slice(0, Math.max(0, first))
      .some(message => updates.changed.has(message.id));
    if (reached && (first < 0 || messages.some(message => window.projection.unresolved.has(message.id))
      || window.projection.unknownAnswers.length || updates?.uncertain || prefixChanged)) return unavailable('boundary');
    const delivered = pending?.delivered ?? 0;
    const part = messages.slice(delivered, delivered + limit);
    if (reached && delivered + part.length === messages.length) {
      const next = this.checkpoint(sessionId, window, messages.slice(-limit));
      if (!next) return unavailable('boundary');
      this.retain(sessionId, key, window, messages.at(-limit)?.id);
      return {
        sessionId, messages: part, hasMore: window.hasMore, append: true,
        resume: { status: 'ready', token: this.signCheckpoint(next) },
      };
    }
    const { projection, ...retained } = window;
    const token = `p.${randomUUID()}`;
    this.store(sessionId, key, deflateSync(serialize(retained)), messageCount(projection.messages), { details });
    const stored = this.cache.get(key);
    if (!stored) return unavailable('capacity');
    stored.resume = { token, checkpoint, reached, delivered: delivered + part.length };
    return { sessionId, messages: part, hasMore: window.hasMore, resume: { status: 'pending', token } };
  }

  private checkpoint(sessionId: string, window: Window, messages: ChatMessage[]): Checkpoint | undefined {
    const first = messages[0];
    if (!first) return undefined;
    const origins = messages.map(message => window.projection.origins.get(message.id));
    if (origins.some(origin => origin === undefined)) return undefined;
    const floor = Math.min(...origins.filter(origin => origin !== undefined));
    const floorId = window.events[floor]?.id;
    const limitId = window.events[0]?.id;
    if (!floorId || !limitId || !window.tailEventId) return undefined;
    return {
      sessionId, details: window.details, epoch: this.epoch, firstMsgId: first.id,
      floorId, limitId, floorCursor: window.cursor, tailCursor: window.tailCursor, tailId: window.tailEventId,
    };
  }

  private signCheckpoint(checkpoint: Checkpoint): string {
    const body = Buffer.from(JSON.stringify(checkpoint)).toString('base64url');
    return `c.${body}.${createHmac('sha256', this.resumeKey).update(body).digest('base64url')}`;
  }

  private readCheckpoint(token: string): Checkpoint | undefined {
    const [kind, body, signature, extra] = token.split('.');
    if (kind !== 'c' || !body || !signature || extra !== undefined || token.length > 8192) return undefined;
    const expected = createHmac('sha256', this.resumeKey).update(body).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
    const value: unknown = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!value || typeof value !== 'object'
      || !('sessionId' in value) || typeof value.sessionId !== 'string'
      || !('details' in value) || (value.details !== 'full' && value.details !== 'summary')
      || !('epoch' in value) || typeof value.epoch !== 'number'
      || !('firstMsgId' in value) || typeof value.firstMsgId !== 'string'
      || !('floorId' in value) || typeof value.floorId !== 'string'
      || !('limitId' in value) || typeof value.limitId !== 'string'
      || !('floorCursor' in value) || typeof value.floorCursor !== 'string'
      || !('tailCursor' in value) || typeof value.tailCursor !== 'string') return undefined;
    if (!('tailId' in value) || typeof value.tailId !== 'string') return undefined;
    return {
      sessionId: value.sessionId, details: value.details, epoch: value.epoch, firstMsgId: value.firstMsgId,
      floorId: value.floorId, limitId: value.limitId, floorCursor: value.floorCursor, tailCursor: value.tailCursor, tailId: value.tailId,
    };
  }

  async readWithMetadata(
    sessionId: string, beforeMsgId?: string, limit = DEFAULT_HISTORY_LIMIT, afterMsgId?: string,
    details: HistoryDetails = 'full',
  ): Promise<HistoryPageWithMetadata> {
    const result = await this.load(sessionId, beforeMsgId, limit, afterMsgId, true, details);
    return { ...result.page, ...result.metadata };
  }

  async readSubagent(
    sessionId: string, toolCallId: string, beforeMsgId?: string, limit = DEFAULT_HISTORY_LIMIT,
    afterMsgId?: string, details: HistoryDetails = 'summary',
  ): Promise<SubagentHistoryPage> {
    validatePage(beforeMsgId, limit, afterMsgId);
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('History requires a non-empty session ID');
    if (typeof toolCallId !== 'string' || !toolCallId) throw new Error('History requires a non-empty tool call ID');
    if (details !== 'full' && details !== 'summary') throw new Error('Invalid history details');
    const scope = { details, toolCallId };
    const key = JSON.stringify([sessionId, details, toolCallId]);
    const epoch = this.epoch;
    const spent: ReadBudget = { events: 0, bytes: 0 };
    const cached = this.cache.get(key);
    let snapshot = cached ? deserialize(inflateSync(cached.data)) as ChildSnapshot : undefined;
    let resets = 0;
    const invalidate = () => {
      this.clear(sessionId);
      snapshot = undefined;
      beforeMsgId = undefined;
      afterMsgId = undefined;
      if (++resets > 1) throw new Error('History changed repeatedly during pagination');
    };
    let state = newFoldState();
    while (true) {
      state = newFoldState();
      if (snapshot) {
        const validation = await this.batch({
          sessionId, direction: snapshot.direction, cursor: snapshot.headCursor, max: 1,
        }, spent);
        if (validation.cursorStatus === 'expired') { invalidate(); continue; }
        for (const event of snapshot.events) foldEvent(state, event, { ...event.projection, scope });
        const anchored = beforeMsgId && childOf(state, toolCallId)?.state.messages.some(message => message.id === beforeMsgId);
        if (anchored) {
          const tail = await this.batch({
            sessionId, direction: snapshot.direction, cursor: snapshot.tailCursor, max: 1,
          }, spent);
          if (tail.cursorStatus === 'expired') { invalidate(); continue; }
        } else {
          if (snapshot.direction === 'forward') {
            const update = await this.scanForwardChild(sessionId, scope, state, snapshot.events, spent, snapshot.tailCursor);
            if (!update) { invalidate(); continue; }
            snapshot.tailCursor = update.cursor;
          } else if (!await this.refreshBackwardChild(sessionId, scope, state, snapshot, spent)) {
            invalidate(); continue;
          }
        }
        break;
      }

      const seed = this.childSeed(sessionId, toolCallId);
      if (seed) {
        const tail = await this.batch({
          sessionId, direction: 'backward', cursor: seed.tailCursor, max: 1,
        }, spent);
        if (tail.cursorStatus === 'expired') { invalidate(); continue; }
        snapshot = await this.seedBackwardChild(sessionId, scope, seed, spent);
        if (!snapshot) { invalidate(); continue; }
        continue;
      }
      const events: HistoryEvent[] = [];
      const initial = await this.scanForwardChild(sessionId, scope, state, events, spent, undefined, true);
      if (!initial) { invalidate(); continue; }
      snapshot = { direction: 'forward', events, headCursor: initial.headCursor, tailCursor: initial.cursor };
      break;
    }
    const child = childOf(state, toolCallId);
    if (!child?.card.subagent) {
      throw Object.assign(new Error(`Subagent not found: ${toolCallId}`), {
        code: 'SUBAGENT_NOT_FOUND', status: 404, statusCode: 404,
      });
    }
    const messages = details === 'summary' ? child.state.messages.map(summarizeMessage) : child.state.messages;
    const page = pageHistory(sessionId, messages, beforeMsgId, limit, afterMsgId);
    if (epoch === this.epoch && this.maxEntries && this.maxBytes && this.maxMessages) {
      this.store(sessionId, key, deflateSync(serialize(snapshot)), messageCount(messages), scope);
    }
    return { ...page, toolCallId, subagent: structuredClone({ ...child.card.subagent, toolCallId }) };
  }

  private childSeed(sessionId: string, toolCallId: string): ChildSeed | undefined {
    const candidates = [...this.cache.values()].reverse().filter(cached => cached.sessionId === sessionId && !cached.resume);
    for (const cached of candidates.filter(value => !value.scope.toolCallId)) {
      const snapshot = deserialize(inflateSync(cached.data)) as Snapshot;
      const projection = project(snapshot.events, snapshot.hasMore, snapshot.prefixLength, snapshot.details);
      const target = childOf(projection.state, toolCallId);
      if (!target) continue;
      const root = [...projection.state.subFolds].find(([id, sub]) => id === toolCallId || childOf(sub, toolCallId));
      const rootId = root && projection.state.subCard.get(root[0]);
      if (!root || !rootId || projection.unresolved.has(rootId) || !projection.origins.has(rootId)) continue;
      const last = snapshot.events.findLast(event =>
        requests(event).includes(toolCallId)
        || (event.type.startsWith('subagent.') && (event.data.toolCallId === toolCallId
          || (!event.data.toolCallId && !!event.agentId && target.state.agentIds.has(event.agentId))))
        || isFoldContentVisible(projection.state, event, { details: 'full', toolCallId }));
      const first = snapshot.events.find(event => requests(event).includes(root[0])
        || (event.type === 'subagent.started' && (event.data.toolCallId ?? event.agentId) === root[0]));
      const headId = first?.id;
      // Re-read only the native span from the spawning ancestor through the last
      // known child update. Later unrelated turns were already seen by this page.
      if (last?.id && headId) return {
        cursor: last.source?.cursor ?? snapshot.tailCursor,
        tailCursor: snapshot.tailCursor,
        tailEventId: last.source ? snapshot.tailEventId : undefined,
        untilId: headId, state: projection.state,
      };
    }
    for (const cached of candidates.filter(value => !!value.scope.toolCallId)) {
      const snapshot = deserialize(inflateSync(cached.data)) as ChildSnapshot;
      if (snapshot.direction !== 'backward' || !snapshot.headId) continue;
      const state = newFoldState();
      for (const event of snapshot.events) foldEvent(state, event, { ...event.projection, scope: cached.scope });
      if (childOf(state, toolCallId)) {
        // A scoped summary omits descendant content, so it cannot prove their
        // last event. Reuse its ancestor boundary, but read from the current tail.
        return { cursor: snapshot.tailCursor, tailCursor: snapshot.tailCursor, untilId: snapshot.headId, state };
      }
    }
    return undefined;
  }

  private async scanForwardChild(
    sessionId: string, scope: FoldHistoryScope, state: FoldState, events: HistoryEvent[], spent: ReadBudget,
    cursor?: string, firstEvent = false,
  ): Promise<{ cursor: string; headCursor: string } | undefined> {
    let headCursor: string | undefined;
    while (true) {
      const result = await this.batch({
        sessionId, direction: 'forward', cursor, ...(firstEvent && !headCursor ? { max: 1 } : {}),
      }, spent, undefined, scope, state);
      if (result.cursorStatus === 'expired') return undefined;
      headCursor ??= result.cursor;
      events.push(...result.events);
      if (result.hasMore && (!result.readCount || result.cursor === cursor)) throw new Error('History cursor did not advance');
      // Empty forward pages need not preserve their incoming native boundary.
      // Keep the last nonempty cursor so a later append never starts at the head.
      cursor = result.readCount ? result.cursor : cursor ?? result.cursor;
      if (!result.hasMore) return { cursor, headCursor };
    }
  }

  private async seedBackwardChild(
    sessionId: string, scope: FoldHistoryScope, seed: ChildSeed, spent: ReadBudget,
  ): Promise<ChildSnapshot | undefined> {
    const chunks: HistoryEvent[][] = [];
    let cursor = seed.cursor;
    let tailEventId = seed.tailEventId;
    while (true) {
      const result = await this.batch({
        sessionId, direction: 'backward', cursor,
      }, spent, undefined, scope, seed.state, seed.untilId, true);
      if (result.cursorStatus === 'expired') return undefined;
      tailEventId ??= result.lastId;
      chunks.push(result.events);
      if (result.stopped) return {
        direction: 'backward', events: chunks.reverse().flat(),
        headCursor: result.cursor, headId: seed.untilId, tailCursor: seed.tailCursor, tailEventId,
      };
      if (!result.hasMore) return undefined;
      if (!result.readCount || result.cursor === cursor) throw new Error('History cursor did not advance');
      cursor = result.cursor;
    }
  }

  private async refreshBackwardChild(
    sessionId: string, scope: FoldHistoryScope, state: FoldState, snapshot: ChildSnapshot, spent: ReadBudget,
  ): Promise<boolean> {
    const tail = await this.batch({ sessionId, direction: 'backward', max: 1 }, spent);
    if (tail.lastId === snapshot.tailEventId) { snapshot.tailCursor = tail.cursor; return true; }
    if (!snapshot.tailEventId || !tail.readCount) return false;
    const chunks = [tail.events];
    let cursor = tail.cursor;
    while (true) {
      const result = await this.batch({
        sessionId, direction: 'backward', cursor, max: Math.min(200, this.batchSize),
      }, spent, undefined, undefined, undefined, snapshot.tailEventId);
      if (result.cursorStatus === 'expired') return false;
      chunks.push(result.events.filter(event => event.id !== snapshot.tailEventId));
      if (result.stopped) break;
      if (!result.hasMore) return false;
      if (!result.readCount || result.cursor === cursor) throw new Error('History cursor did not advance');
      cursor = result.cursor;
    }
    // Native cursors are direction-specific. Backward-seeded scopes discover a
    // bounded new suffix backward, then fold only that suffix chronologically.
    for (const raw of chunks.reverse().flat()) {
      const event = scopedEvent(raw, scope, state);
      if (event) snapshot.events.push(event);
    }
    snapshot.tailCursor = tail.cursor;
    snapshot.tailEventId = tail.lastId;
    return true;
  }

  clear(sessionId: string): void {
    // A global epoch also bounds invalidation state for sessions never cached.
    this.epoch++;
    for (const [key, cached] of this.cache) if (cached.sessionId === sessionId) this.remove(key);
  }

  private async batch(
    params: ReadParams, spent: ReadBudget, expired?: () => void,
    scope: FoldHistoryScope = { details: 'full' }, state?: FoldState, untilId?: string, routingOnly = false,
  ): Promise<HistoryBatch> {
    const average = spent.events ? spent.bytes / spent.events : 0;
    const max = Math.min(params.max ?? this.batchSize, this.maxEvents,
      average ? Math.max(1, Math.floor(this.maxReadBytes / average)) : this.batchSize);
    const result = await this.readPersistedEvents({ ...params, max });
    if (result.cursorStatus === 'expired') expired?.();
    const stop = untilId ? result.events.findIndex(event => event.id === untilId) : -1;
    const selected = stop < 0 ? result.events
      : params.direction === 'backward' ? result.events.slice(stop) : result.events.slice(0, stop + 1);
    const source = !state && params.direction === 'backward' && params.cursor ? { cursor: params.cursor } : undefined;
    const events = selected.flatMap(raw => {
      // Capture lightweight provenance before the shared fold drops binary data.
      let projected: typeof raw | HistoryEvent = raw;
      if (raw.type === 'tool.execution_complete' && params.direction === 'backward' && params.cursor) {
        const count = result.events.length - result.events.indexOf(raw);
        const images = toolImagesOf(normalizeEvent(raw)).map(image => ({ ...image, cursor: params.cursor, count }));
        projected = { ...raw, projection: { toolImages: images } };
      }
      const event = state ? scopedEvent(projected, scope, state, routingOnly) : historyEvent(projected, scope);
      if (!event) return [];
      if (source) event.source = source;
      return [event];
    });
    spent.events += result.events.length;
    spent.bytes += eventBytes(events);
    return {
      ...result, events, readCount: result.events.length, stopped: stop >= 0,
      lastId: result.events.at(-1)?.id,
    };
  }

  private window(result: HistoryBatch, details: HistoryDetails): Window {
    const events = result.events;
    return {
      details, events, prefixLength: events.length, cursor: result.cursor, hasMore: result.hasMore,
      tailCursor: result.cursor, tailEventId: result.lastId, tailDigest: digest(events), atTail: true,
      projection: project(events, result.hasMore, events.length, details),
    };
  }

  private async load(
    sessionId: string, before: string | undefined, limit: number, after: string | undefined, withMetadata: boolean,
    details: HistoryDetails,
  ): Promise<{ page: HistoryPage; metadata: HistoryMetadata; window: Window; epoch: number }> {
    validatePage(before, limit, after);
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('History requires a non-empty session ID');
    if (details !== 'full' && details !== 'summary') throw new Error('Invalid history details');
    const key = details === 'full' ? sessionId : JSON.stringify([sessionId, details]);
    const batch = (params: ReadParams, expired?: () => void) => this.batch(params, spent, expired, { details });
    const epoch = this.epoch;
    let loadedEpoch = epoch;
    const spent: ReadBudget = { events: 0, bytes: 0 };
    const cached = this.cache.get(key);
    const snapshot = cached && !cached.resume ? deserialize(inflateSync(cached.data)) as Snapshot : undefined;
    let prior = snapshot ? {
      ...snapshot, projection: project(snapshot.events, snapshot.hasMore, snapshot.prefixLength, details),
    } : undefined;
    let window: Window | undefined;
    let fallback: Window | undefined;
    const invalidate = () => {
      // An obsolete read cannot clear a newer generation. Only discarding its
      // old cache before fresh paging is a normal, adoptable recovery.
      if (loadedEpoch === this.epoch) {
        this.clear(sessionId);
        if (prior !== undefined && window === undefined) loadedEpoch = this.epoch;
      }
      prior = undefined;
      fallback = undefined;
      before = undefined;
      after = undefined;
    };
    if (before && prior?.projection.origins.has(before)) {
      const validation = await batch({
        sessionId, direction: 'backward', cursor: prior.tailCursor, max: 1,
      }, invalidate);
      if (validation.cursorStatus === 'ok' && prior) {
        const boundary = await batch({
          sessionId, direction: 'backward', cursor: prior.cursor, max: 1,
        }, invalidate);
        if (boundary.cursorStatus === 'ok' && prior) window = this.trim(prior, before!);
      }
    }
    if (!window) {
      const tail = await batch({ sessionId, direction: 'backward', max: 1 });
      let fresh = this.window(tail, details);
      if (prior?.atTail && prior.tailDigest === fresh.tailDigest) {
        const validation = await batch({
          sessionId, direction: 'backward', cursor: prior.cursor, max: 1,
        }, invalidate);
        if (validation.cursorStatus === 'expired') {
          fresh = this.window(await batch({ sessionId, direction: 'backward', max: 1 }), details);
        }
      } else prior = undefined;
      window = prior ?? fresh;
      if (window === fresh) window.metadata = prior?.metadata;
    }
    let resets = 0;
    while (true) {
      const projection = window.projection;
      const anchor = before ? projection.messages.findIndex((message) => message.id === before) : -1;
      const enough = before && anchor >= 0 ? anchor > limit : projection.messages.length > limit;
      const end = anchor >= 0 ? anchor : projection.messages.length;
      const selected = projection.messages.slice(Math.max(0, end - limit), end);
      const origin = selected[0] ? projection.origins.get(selected[0].id) ?? 0 : 0;
      const prefixLength = window.prefixLength;
      const complete = !selected.some(message => projection.unresolved.has(message.id))
        && !projection.unknownAnswers.some(index => index >= origin && index < prefixLength);
      if (complete && (!window.hasMore || enough)) {
        if (!before || anchor >= 0) break;
        fallback ??= structuredClone(window);
        if (!window.hasMore) { window = fallback; before = undefined; break; }
        const oldest = projection.messages.find(message => projection.origins.has(message.id));
        if (oldest) window = this.trim(window, oldest.id);
      }
      if (!window.hasMore) break;
      const older = await batch({ sessionId, direction: 'backward', cursor: window.cursor }, invalidate);
      if (older.cursorStatus === 'expired') {
        if (++resets > 1) throw new Error('History changed repeatedly during pagination');
        // A backward expired cursor returns a new tail, not an older continuation.
        const tail = await batch({ sessionId, direction: 'backward', max: 1 });
        window = this.window(tail, details);
        continue;
      }
      if (older.hasMore && (!older.events.length || older.cursor === window.cursor)) {
        throw new Error('History cursor did not advance');
      }
      const events: HistoryEvent[] = [...older.events, ...window.events];
      window = {
        ...window, events, cursor: older.cursor, hasMore: older.hasMore,
        prefixLength: window.prefixLength + older.events.length,
        projection: project(events, older.hasMore, window.prefixLength + older.events.length, details),
      };
    }
    let page = pageHistory(sessionId, window.projection.messages, before, limit, after);
    if (page.latest && !window.atTail) {
      // Only a true tail window may produce a local reset.
      return this.load(sessionId, undefined, limit, undefined, withMetadata, details);
    }
    if (!page.append) page = { ...page, hasMore: page.hasMore || window.hasMore };
    if (withMetadata && !window.metadata) {
      // One bounded head batch, never a walk through the log for metadata.
      const head = await batch({ sessionId, direction: 'forward', max: this.batchSize });
      window.metadata = metadataOf(sessionId, head.events);
    }
    const metadata = metadataOf(sessionId, window.events, window.metadata);
    if (withMetadata) window.metadata = metadata;
    if (epoch === this.epoch) this.retain(sessionId, key, window, page.messages[0]?.id);
    return { page, metadata, window, epoch: loadedEpoch };
  }

  private trim(window: Window, anchor: string): Window {
    const origin = window.projection.origins.get(anchor)!;
    const end = window.events.findIndex((event, index) => index > origin && rootBoundary(event));
    if (end < 0) return window;
    const removed = window.events.slice(end);
    const retainedTools = new Set(window.events.slice(0, end).flatMap(requests));
    const removedTurns = new Set<string>();
    for (const event of window.events.slice(end, window.prefixLength)) {
      if (event.type === 'assistant.turn_start' && !ownerOf(event) && typeof event.data.turnId === 'string') {
        removedTurns.add(event.data.turnId);
      }
    }
    const removedTools = new Set<string>();
    const removedAgents = new Set<string>();
    for (const event of removed) {
      const owner = ownerOf(event);
      if (!owner || (typeof owner === 'string' && removedAgents.has(owner))) {
        for (const id of requests(event)) removedTools.add(id);
        // A start's position (or journal parentId) cannot prove ownership.
        // Native turn IDs are agent-scoped; only root turn starts prove removal here.
        if (!owner && event.type.startsWith('tool.execution_') && typeof event.data.toolCallId === 'string'
          && typeof event.data.turnId === 'string' && removedTurns.has(event.data.turnId)
          && !retainedTools.has(event.data.toolCallId)) removedTools.add(event.data.toolCallId);
      } else {
        for (const id of requests(event)) retainedTools.add(id);
      }
      if (event.type !== 'subagent.started'
        || (!removedTools.has(String(event.data.toolCallId)) && !removedAgents.has(String(owner)))) continue;
      for (const id of [event.data.toolCallId, event.agentId, event.data.agentId]) {
        if (typeof id === 'string') removedAgents.add(id);
      }
    }
    // Preserve later updates belonging to earlier tasks, including owners not
    // fetched yet. Ordinary completed turns roll out as the user pages backward.
    // Ambiguous updates cannot be discarded just because their owner is older.
    const carry = removed.filter((event) => {
      const owner = ownerOf(event);
      if (typeof owner === 'string') return !removedAgents.has(owner);
      if (event.type.startsWith('subagent.') || event.type.startsWith('tool.execution_')) {
        return !removedTools.has(String(event.data.toolCallId));
      }
      return false;
    });
    const events = [...window.events.slice(0, end), ...carry];
    return {
      ...window, events, prefixLength: end, atTail: false,
      projection: project(events, window.hasMore, end, window.details),
    };
  }

  private retain(sessionId: string, key: string, window: Window, anchor?: string): void {
    this.remove(key);
    if (!this.maxEntries || !this.maxBytes || !this.maxMessages) return;
    const encode = (value: Window) => {
      const { projection, ...snapshot } = value;
      return { data: deflateSync(serialize(snapshot)), messages: messageCount(projection.messages) };
    };
    let { data, messages } = encode(window);
    if ((messages > this.maxMessages || data.byteLength > this.maxBytes) && anchor
      && window.projection.origins.has(anchor)) {
      ({ data, messages } = encode(this.trim(window, anchor)));
    }
    if (messages > this.maxMessages || data.byteLength > this.maxBytes) return;
    this.store(sessionId, key, data, messages, { details: window.details });
  }

  private store(sessionId: string, key: string, data: Buffer, messages: number, scope: FoldHistoryScope): void {
    this.remove(key);
    if (!this.maxEntries || !this.maxBytes || !this.maxMessages
      || messages > this.maxMessages || data.byteLength > this.maxBytes) return;
    this.cache.set(key, { sessionId, data, messages, scope });
    this.cachedBytes += data.byteLength;
    this.cachedMessages += messages;
    while (this.cache.size > this.maxEntries || this.cachedBytes > this.maxBytes || this.cachedMessages > this.maxMessages) {
      this.remove(this.cache.keys().next().value!);
    }
  }

  private remove(sessionId: string): void {
    const cached = this.cache.get(sessionId);
    if (!cached) return;
    this.cachedBytes -= cached.data.byteLength;
    this.cachedMessages -= cached.messages;
    this.cache.delete(sessionId);
  }
}
