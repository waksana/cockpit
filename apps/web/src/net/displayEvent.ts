import type { NativeChatEvent } from '@cockpit/protocol';
import { askAnswerOf, nativeToolTitle, toolArgsOf, toolOutputOf } from '@cockpit/protocol/chat';

export type DisplayEvent = NativeChatEvent & {
  display?: { toolOutput?: string; toolArgs?: string; askAnswer?: string; askQuestion?: string };
};

// Retain only details the browser can display. HTTP/MCP still receive the native
// text; paging older events must not keep a second, unbounded copy of tool output.
export function displayEvent(event: NativeChatEvent): DisplayEvent {
  if (event.type === 'tool.execution_start') {
    const { arguments: args, ...data } = event.data;
    const task = data.toolName === 'task' && args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown> : undefined;
    const question = data.toolName === 'ask_user' && args && typeof args === 'object' && 'question' in args
      && typeof args.question === 'string' ? args.question : undefined;
    return { ...event, data: { ...data, ...(task ? { arguments: {
      description: task.description, agent_type: task.agent_type,
    } } : {}) }, display: {
      toolArgs: toolArgsOf(typeof data.toolName === 'string' ? data.toolName : undefined, args),
      ...(question ? { askQuestion: question } : {}),
    } };
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
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.toolCallId !== 'string') return [];
      const args = value.arguments;
      const title = nativeToolTitle(value);
      const task = value.name === 'task';
      const ask = value.name === 'ask_user';
      if (!title && !task && !ask) return [];
      return [{ ...(typeof value.name === 'string' ? { name: value.name } : {}), toolCallId: value.toolCallId,
        ...(title ? { intentionSummary: title } : {}),
        ...(args && typeof args === 'object' ? task
          ? { arguments: { description: args.description, agent_type: args.agent_type } }
          : ask && typeof args.question === 'string' ? { arguments: { question: args.question } } : {} : {}) }];
    });
    return { ...event, data: { ...event.data, toolRequests } };
  }
  if (event.type === 'user.message' && typeof event.data.source === 'string'
    && event.data.source.startsWith('skill-')) {
    return { ...event, data: { source: event.data.source } };
  }
  return event;
}
