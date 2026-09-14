import type { NativeChatEvent } from '@cockpit/protocol';
import { askAnswerOf, toolArgsOf, toolOutputOf } from '@cockpit/protocol/chat';

export type DisplayEvent = NativeChatEvent & {
  display?: { toolOutput?: string; toolArgs?: string; askAnswer?: string };
};

// Retain only details the browser can display. HTTP/MCP still receive the native
// text; paging older events must not keep a second, unbounded copy of tool output.
export function displayEvent(event: NativeChatEvent): DisplayEvent {
  if (event.type === 'tool.execution_start') {
    const { arguments: args, ...data } = event.data;
    const task = data.toolName === 'task' && args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown> : undefined;
    return { ...event, data: { ...data, ...(task ? { arguments: {
      description: task.description, agent_type: task.agent_type,
    } } : {}) }, display: { toolArgs: toolArgsOf(typeof data.toolName === 'string' ? data.toolName : undefined, args) } };
  }
  if (event.type === 'tool.execution_complete') {
    const { result, error, toolTelemetry: _telemetry, ...data } = event.data;
    return {
      ...event, data: { ...data, ...(error != null ? { error: true } : {}) },
      display: { toolOutput: toolOutputOf(result, error), askAnswer: askAnswerOf(event.data) },
    };
  }
  if (event.type === 'assistant.message' && Array.isArray(event.data.toolRequests)) {
    const toolRequests = event.data.toolRequests.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== 'task') return [];
      const args = value.arguments;
      return [{ name: 'task', toolCallId: value.toolCallId,
        ...(args && typeof args === 'object' ? { arguments: { description: args.description, agent_type: args.agent_type } } : {}) }];
    });
    return { ...event, data: { ...event.data, toolRequests } };
  }
  if (event.type === 'user.message' && typeof event.data.source === 'string'
    && event.data.source.startsWith('skill-')) {
    return { ...event, data: { source: event.data.source } };
  }
  return event;
}
