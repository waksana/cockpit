import type { ChatMessage } from '@cockpit/protocol';

export function hasMessageContent(message: ChatMessage): boolean {
  return !!message.content.trim();
}
