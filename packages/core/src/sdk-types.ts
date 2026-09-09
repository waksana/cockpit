import type { SessionEvent } from '@github/copilot-sdk';

// The fold also accepts old synthetic journals and forward-compatible payloads.
// Native event, message, parent and task IDs are distinct; never rewrite them.
export interface SdkEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string | number;
  parentId?: string | null;
  agentId?: string;
  parentToolCallId?: string;
  ephemeral?: boolean;
}

export function normalizeEvent(event: SessionEvent | SdkEvent): SdkEvent {
  return { ...event, data: { ...event.data } };
}

export interface RuntimeAttachment {
  type: 'file';
  path: string;
  displayName?: string;
}
