import type { ChatMessage } from '@cockpit/protocol';

export function hasMessageContent(message: ChatMessage): boolean {
  return message.parts
    ? message.parts.some(part => part.type === 'file' || !!part.text.trim())
    : !!(message.content.trim() || message.attachments?.length || message.attachment);
}
