import type { ChatMessage } from '@cockpit/protocol';

export function hasNewTranscriptContent(previous: ChatMessage[], next: ChatMessage[]): boolean {
  if (!previous.length) return false;
  const oldTail = next.findIndex(message => message.id === previous.at(-1)?.id);
  if (oldTail >= 0 && oldTail < next.length - 1) return true;
  const byId = new Map(previous.map(message => [message.id, message]));
  return next.some(message => {
    const old = byId.get(message.id);
    if (!old || old === message) return false;
    if (old.content !== message.content || old.thought !== message.thought
      || old.subagent?.status !== message.subagent?.status) return true;
    const tools = new Map(old.toolCalls?.map(tool => [tool.toolCallId, tool]));
    if (message.toolCalls?.some(tool => {
      const previousTool = tools.get(tool.toolCallId);
      return previousTool && (previousTool.status !== tool.status || previousTool.output !== tool.output);
    })) return true;
    return hasNewTranscriptContent(old.subMessages ?? [], message.subMessages ?? []);
  });
}
