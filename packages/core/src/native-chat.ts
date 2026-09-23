import type { CopilotClient, CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { CHAT_EVENT_TYPES, NativeChatRead, type NativeChatEvent, type NativeChatPage } from '@cockpit/protocol';
import { normalizeEvent } from './sdk-types.ts';
import { CockpitError } from './errors.ts';

type PassiveRead = CopilotClient['rpc']['sessions']['readPersistedEvents'];
type LiveRead = CopilotSession['rpc']['eventLog']['read'];

export { CHAT_EVENT_TYPES } from '@cockpit/protocol';

export function liveChatParams(query: NativeChatRead): Parameters<LiveRead>[0] {
  const [first, ...rest] = query.agentIds ?? [];
  const agentIds: [string, ...string[]] | undefined = first ? [first, ...rest] : undefined;
  const [firstType, ...otherTypes] = query.types ?? [];
  const types: [string, ...string[]] = firstType ? [firstType, ...otherTypes] : CHAT_EVENT_TYPES;
  return {
    cursor: query.cursor, max: query.max, direction: query.direction,
    waitMs: query.waitMs, includeEphemeral: query.direction === 'forward' && query.includeEphemeral !== false,
    types, agentScope: query.agentScope ?? 'all',
    ...(agentIds ? { agentIds } : {}),
  };
}

function displayEvent(event: SessionEvent): NativeChatEvent {
  const normalized = normalizeEvent(event);
  const data = normalized.data;
  const result = data.result;
  if (result && typeof result === 'object' && !Array.isArray(result) && 'binaryResultsForLlm' in result) {
    const { binaryResultsForLlm: _binary, ...textResult } = result;
    data.result = textResult;
  }
  return {
    ...normalized, id: event.id, data,
  };
}

export async function readNativeChat(
  query: NativeChatRead,
  readers: { persisted: PassiveRead; live?: CopilotSession['rpc']['eventLog'] },
  signal?: AbortSignal,
): Promise<NativeChatPage> {
  query = NativeChatRead.parse(query);
  signal?.throwIfAborted();
  let rpc = 0;
  let liveCursor: string | undefined;
  if (query.source === 'live' && !readers.live) {
    throw new CockpitError('SESSION_UNLOADED', 'Native session is unloaded; this cursor requires an active session.');
  }
  if (query.bootstrap && readers.live && query.source === 'live') {
    liveCursor = (await readers.live.tail()).cursor;
    rpc++;
    signal?.throwIfAborted();
  }
  const page = query.source === 'live'
    ? await readers.live!.read(liveChatParams(query))
    : await readers.persisted({
      sessionId: query.sessionId, cursor: query.cursor, max: query.max, direction: query.direction,
    });
  rpc++;
  signal?.throwIfAborted();
  if (page.events.length > query.max
    || (page.cursorStatus === 'ok' && page.hasMore && (page.cursor || undefined) === query.cursor)) {
    throw new Error('Native event page exceeded its bound or did not advance.');
  }
  return {
    sessionId: query.sessionId, source: query.source, direction: query.direction,
    events: page.events.map(displayEvent),
    cursor: page.cursor, cursorStatus: page.cursorStatus, hasMore: page.hasMore,
    ...(liveCursor !== undefined ? { liveCursor } : {}),
    read: { rpc, events: page.events.length },
  };
}
