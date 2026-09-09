import type { CopilotSession } from '@github/copilot-sdk';

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
    if (turn || tools.size || agents.size) throw new Error('Fork boundary contains unfinished work; choose a later settled user-message boundary');
    if (!messages) throw new Error('Fork requires existing conversation history before the boundary');
  };
  for (;;) {
    const page = await read({ cursor, direction: 'forward', max: 1000, types: '*', agentScope: 'all', includeEphemeral: false });
    if (page.cursorStatus !== 'ok') throw new Error('Fork history cursor expired; no fork was dispatched');
    for (const event of page.events) {
      const root = !event.agentId && !('agentId' in event.data && event.data.agentId)
        && !('parentToolCallId' in event.data && event.data.parentToolCallId);
      if (event.id === toEventId) {
        if (event.type !== 'user.message' || !root) throw new Error('toEventId must identify a root user.message event (exclusive boundary)');
        settled();
        return;
      }
      if (event.type === 'session.schedule_created') {
        throw new Error('Fork history contains a schedule; choose a boundary before its creation or create a new session instead');
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
      if (toEventId) throw new Error('Fork boundary was not found in the source session');
      settled();
      return;
    }
    if (!page.cursor || page.cursor === cursor) throw new Error('Fork history cursor did not advance; no fork was dispatched');
    cursor = page.cursor;
  }
}
