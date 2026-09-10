import { z } from 'zod';

export const CHAT_EVENT_TYPES: [string, ...string[]] = [
  'session.model_change', 'session.error', 'session.warning',
  'user.message', 'user_input.requested', 'skill.invoked',
  'assistant.turn_start', 'assistant.turn_end', 'assistant.idle', 'session.idle', 'abort',
  'assistant.reasoning', 'assistant.reasoning_delta', 'assistant.message_start',
  'assistant.message_delta', 'assistant.message',
  'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed', 'subagent.configured',
];

export const NativeChatEvent = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  parentId: z.string().nullable().optional(),
  agentId: z.string().optional(),
  parentToolCallId: z.string().optional(),
  ephemeral: z.boolean().optional(),
  data: z.record(z.unknown()),
});
export type NativeChatEvent = z.infer<typeof NativeChatEvent>;

export const NativeChatRead = z.object({
  sessionId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  source: z.enum(['persisted', 'live']).default('persisted'),
  direction: z.enum(['forward', 'backward']).default('backward'),
  cursor: z.string().min(1).max(16384).optional(),
  max: z.number().int().min(1).max(256).default(64),
  waitMs: z.number().int().min(0).max(30000).default(0),
  includeEphemeral: z.boolean().optional(),
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  agentScope: z.enum(['primary', 'all']).optional(),
  types: z.array(z.string().min(1).max(200)).min(1).max(64).optional(),
  bootstrap: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.source === 'persisted' && (value.waitMs || value.agentIds || value.types || value.agentScope === 'primary')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Passive native history does not support waiting or event/agent filters.' });
  }
  if (value.direction === 'backward' && value.waitMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Backward history does not wait for new events.' });
  }
  if (value.includeEphemeral && (value.source !== 'live' || value.direction !== 'forward')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only live forward reads can include ephemeral events.' });
  }
  if (value.bootstrap && (value.direction !== 'backward' || value.cursor)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Bootstrap requires a fresh backward page.' });
  }
});
export type NativeChatRead = z.infer<typeof NativeChatRead>;

export const NativeChatPage = z.object({
  sessionId: z.string(),
  source: z.enum(['persisted', 'live']),
  direction: z.enum(['forward', 'backward']),
  events: z.array(NativeChatEvent),
  cursor: z.string(),
  cursorStatus: z.enum(['ok', 'expired']),
  hasMore: z.boolean(),
  liveCursor: z.string().optional(),
  read: z.object({ rpc: z.number().int().nonnegative(), events: z.number().int().nonnegative() }),
});
export type NativeChatPage = z.infer<typeof NativeChatPage>;

// The empty native tail sentinel is explicit; omitting a cursor must not turn a
// reconnect into an implicit read from the beginning of history.
export const NativeChatStreamRequest = z.object({
  sessionId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  cursor: z.string().max(16384),
  max: z.number().int().min(1).max(64).default(64),
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  agentScope: z.enum(['primary', 'all']).optional(),
  types: z.array(z.string().min(1).max(200)).min(1).max(64).optional(),
}).strict();
export type NativeChatStreamRequest = z.infer<typeof NativeChatStreamRequest>;

export const NativeChatStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), page: NativeChatPage }),
  z.object({ type: z.literal('error'), error: z.string(), code: z.string().optional() }),
]);
export type NativeChatStreamEvent = z.infer<typeof NativeChatStreamEvent>;
