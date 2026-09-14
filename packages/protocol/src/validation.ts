// Folded-message validators for tests and diagnostics, separate from the native wire.
import { z } from 'zod';

export const ToolCall = z.object({
  toolCallId: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
  // `title` comes from the native execution start; `name` is the raw
  // tool (bash/edit/view…) shown as a small badge; `args` + `output` are the
  // collapsible detail (formatted + capped). Detail is shown only when present.
  name: z.string().optional(),
  args: z.string().optional(),
  output: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ChatRole = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof ChatRole>;

// A sub-agent (spawned via the `task` tool) surfaced as one collapsible card.
// Its full internal work (tools + reasoning + messages) lives in the owning
// message's `subMessages`, folded by the SAME fold on a nested state.
export const SubagentInfo = z.object({
  toolCallId: z.string().optional(),
  agentId: z.string().optional(),
  name: z.string(),          // internal agent_type (general-purpose/explore/…)
  displayName: z.string(),   // human-readable
  description: z.string().optional(),
  model: z.string().optional(),
  // Last observed execution evidence, not a task-registry current-state snapshot.
  status: z.enum(['running', 'activity', 'completed', 'failed', 'cancelled', 'unknown']),
  toolCount: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string().optional(), // what the sub-agent was asked to do
});
export type SubagentInfo = z.infer<typeof SubagentInfo>;

// ChatMessage is recursive: a sub-agent card holds its inner conversation in
// `subMessages` (each itself a ChatMessage, possibly with its own sub-agents).
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thought?: string;
  // Native response-parent event ID keeps thought disclosure stable before messageId arrives.
  thoughtKey?: string;
  timestamp: number;
  // A bounded native window can retain content without a supported response link.
  incomplete?: string;
  toolCalls?: ToolCall[];
  // 'ask-reply' = the user's answer to an ask_user tool; 'subagent' = a sub-agent
  // card; 'skill' = a compact skill-activation pill.
  subtype?: 'ask-reply' | 'subagent' | 'skill';
  // Severity for system messages (runtime errors/warnings folded into the thread).
  level?: 'info' | 'warning' | 'error';
  subagent?: SubagentInfo;
  subMessages?: ChatMessage[];
}
export const ChatMessage: z.ZodType<ChatMessage> = z.lazy(() => z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  thought: z.string().optional(),
  thoughtKey: z.string().optional(),
  timestamp: z.number(),
  incomplete: z.string().optional(),
  toolCalls: z.array(ToolCall).optional(),
  subtype: z.enum(['ask-reply', 'subagent', 'skill']).optional(),
  level: z.enum(['info', 'warning', 'error']).optional(),
  subagent: SubagentInfo.optional(),
  subMessages: z.array(ChatMessage).optional(),
}));
