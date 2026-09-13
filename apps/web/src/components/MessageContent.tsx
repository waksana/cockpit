import type { ChatMessage } from '@cockpit/protocol';
import { MessageBody } from './MessageBody';
import { hasMessageContent } from '../lib/messageContent';

export function MessageContent({ message }: { message: ChatMessage; sessionId: string }) {
  return hasMessageContent(message) ? <MessageBody body={message.content} /> : null;
}
