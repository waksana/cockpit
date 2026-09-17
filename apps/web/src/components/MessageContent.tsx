import type { ChatMessage } from '@cockpit/protocol';
import type { Ref } from 'react';
import { MessageBody } from './MessageBody';
import { hasMessageContent } from '../lib/messageContent';
import { Attachment, MessagePresentation } from './ModuleComponents';
import type { MessageIdentity } from '@cockpit/module-api';

export function MessageContent({ message, elementRef }: { message: ChatMessage; elementRef?: Ref<HTMLDivElement> }) {
  if (!hasMessageContent(message)) return null;
  const identity: MessageIdentity | undefined = message.role === 'assistant' && message.origin ? {
    kind: 'message', role: message.role, sessionId: message.origin.sessionId, id: message.origin.messageId,
    ...(message.origin.agentId ? { agentId: message.origin.agentId } : {}),
  } : undefined;
  const hasText = !!message.content.trim();
  const attachments = message.attachments?.map((attachment, index) => {
    const target = 'path' in attachment ? attachment.path : attachment.type === 'selection' ? attachment.filePath : undefined;
    const label = attachment.displayName || target || '附件';
    const unavailable = attachment.type === 'blob' && (attachment.data === undefined || !!attachment.omittedReason);
    const reason = attachment.type === 'blob' && attachment.omittedReason === 'too_large' ? '超出大小限制' : '原生资源不可用';
    return <Attachment key={index} origin={message.origin} index={index} attachment={attachment} label={label}>
      <span className="message-attachment">{label}{unavailable && ` · 附件不可用（${reason}）`}</span>
    </Attachment>;
  });
  return <>
    {hasText && <MessageBody body={message.content} origin={message.origin} elementRef={elementRef} identity={identity} complete={!message.streaming} />}
    {!!attachments?.length && (identity && !hasText
      ? <MessagePresentation className="message-attachments" identity={identity} complete={!message.streaming} bodyRef={elementRef}>{attachments}</MessagePresentation>
      : <div className="message-attachments">{attachments}</div>)}
  </>;
}
