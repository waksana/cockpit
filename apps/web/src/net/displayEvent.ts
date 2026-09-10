import type { NativeChatEvent } from '@cockpit/protocol';
import { askAnswerOf, toolArgsOf, toolOutputOf } from '@cockpit/protocol/chat';

export type DisplayEvent = NativeChatEvent & {
  display?: { toolOutput?: string; toolArgs?: [string, string][]; askAnswer?: string };
};

// Retain only details the browser can display. HTTP/MCP still receive the native
// text; paging older events must not keep a second, unbounded copy of tool output.
export function displayEvent(event: NativeChatEvent): DisplayEvent {
  if (event.type === 'tool.execution_complete') {
    const { result, error, toolTelemetry: _telemetry, ...data } = event.data;
    return {
      ...event, data: { ...data, ...(error != null ? { error: true } : {}) },
      display: { toolOutput: toolOutputOf(result, error), askAnswer: askAnswerOf(event.data) },
    };
  }
  if (event.type === 'assistant.message' && Array.isArray(event.data.toolRequests)) {
    const toolArgs: [string, string][] = [];
    const toolRequests = event.data.toolRequests.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { arguments: args, ...request } = value;
      if (typeof request.toolCallId === 'string') {
        toolArgs.push([request.toolCallId, toolArgsOf(request.name, args)]);
      }
      const task = request.name === 'task' && args && typeof args === 'object' && !Array.isArray(args)
        ? { description: args.description, agent_type: args.agent_type } : undefined;
      return { ...request, ...(task ? { arguments: task } : {}) };
    });
    return { ...event, data: { ...event.data, toolRequests }, display: { toolArgs } };
  }
  if (event.type === 'user.message' && typeof event.data.source === 'string'
    && event.data.source.startsWith('skill-')) {
    return { ...event, data: { source: event.data.source } };
  }
  return event;
}
