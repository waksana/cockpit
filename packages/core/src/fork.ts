import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { invalid } from './errors.ts';

// Keep this filter aligned with the safety reducer below, not the chat display
// filter. Required user/tool events still carry their native bodies.
const FORK_HISTORY_TYPES: [SessionEvent['type'], ...SessionEvent['type'][]] = [
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'abort',
  'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
  'session.schedule_created',
];

// Native fork replays schedule creation on cold resume. Reject even stopped
// schedules rather than rewriting the inherited journal or racing a timer.
export async function validateForkHistory(
  read: CopilotSession['rpc']['eventLog']['read'], toEventId?: string,
): Promise<void> {
  let cursor: string | undefined;
  let turn = false;
  let messages = 0;
  const tools = new Set<string>();
  const agents = new Set<string>();
  const settled = () => {
    if (turn || tools.size || agents.size) throw invalid('Fork boundary contains unfinished work; choose a later settled user-message boundary');
    if (!messages) throw invalid('Fork requires existing conversation history before the boundary');
  };
  for (;;) {
    const page = await read({ cursor, direction: 'forward', max: 1000, types: FORK_HISTORY_TYPES, agentScope: 'all', includeEphemeral: false });
    if (page.cursorStatus !== 'ok') throw new Error('Fork history cursor expired; no fork was dispatched');
    for (const event of page.events) {
      const root = !event.agentId && !('agentId' in event.data && event.data.agentId)
        && !('parentToolCallId' in event.data && event.data.parentToolCallId);
      if (event.id === toEventId) {
        if (event.type !== 'user.message' || !root) throw invalid('toEventId must identify a root user.message event (exclusive boundary)');
        settled();
        return;
      }
      if (event.type === 'session.schedule_created') {
        throw invalid('Fork history contains a schedule; choose a boundary before its creation or create a new session instead');
      }
      if (event.type === 'user.message' && root) messages++;
      if (event.type === 'assistant.turn_start' && root) turn = true;
      if ((event.type === 'assistant.turn_end' || event.type === 'abort') && root) turn = false;
      if (event.type === 'tool.execution_start') tools.add(event.data.toolCallId);
      if (event.type === 'tool.execution_complete') tools.delete(event.data.toolCallId);
      if (event.type === 'subagent.started') agents.add(event.data.toolCallId);
      if (event.type === 'subagent.completed' || event.type === 'subagent.failed') agents.delete(event.data.toolCallId);
    }
    if (!page.hasMore) {
      if (toEventId) throw invalid('Fork boundary was not found in the source session');
      settled();
      return;
    }
    if (!page.cursor || page.cursor === cursor) throw new Error('Fork history cursor did not advance; no fork was dispatched');
    cursor = page.cursor;
  }
}
