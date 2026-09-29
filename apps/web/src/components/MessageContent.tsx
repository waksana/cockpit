import type { ChatMessage } from '@cockpit/protocol';
import type { Ref } from 'react';
import { MessageBody } from './MessageBody';
import { Attachment, MessagePresentation } from './ModuleComponents';
import type { ChatMessageProps, MessageIdentity } from '@cockpit/module-api/frontend';

export function MessageContent({ message, elementRef }: { message: ChatMessage; elementRef?: Ref<HTMLDivElement> }) {
  const identity: MessageIdentity = {
    owner: message.origin ? 'native' : 'presentation', id: message.id, kind: 'message', role: message.role,
  };
  return <MessageContentPresentation identity={identity} origin={message.origin} complete={!message.streaming}
    bodyRef={elementRef} body={message.content} attachments={message.attachments} />;
}

export function MessageContentPresentation({ identity, origin, complete, bodyRef, body, attachments: descriptors, decisionOrigin }:
  Pick<ChatMessageProps, 'identity' | 'origin' | 'complete' | 'bodyRef' | 'body' | 'attachments' | 'decisionOrigin'>) {
  const hasText = !!body.trim();
  if (!hasText && !descriptors?.length) return null;
  const attachments = descriptors?.map((attachment, index) => {
    const target = 'path' in attachment ? attachment.path : attachment.type === 'selection' ? attachment.filePath : undefined;
    const label = attachment.displayName || target || '附件';
    const unavailable = attachment.type === 'blob' && (attachment.data === undefined || !!attachment.omittedReason);
    const reason = attachment.type === 'blob' && attachment.omittedReason === 'too_large' ? '超出大小限制' : '资源不可用';
    return <Attachment key={index} origin={origin} index={index} attachment={attachment} label={label}>
      <span className="message-attachment">{label}{unavailable && ` · 附件不可用（${reason}）`}</span>
    </Attachment>;
  });
  return <>
    {hasText && <MessageBody body={body} origin={origin} elementRef={bodyRef} identity={identity}
      complete={complete} decisionOrigin={decisionOrigin} />}
    {!!attachments?.length && (!hasText
      ? <MessagePresentation className="message-attachments" identity={identity} origin={origin} decisionOrigin={decisionOrigin}
        complete={complete} bodyRef={bodyRef}>{attachments}</MessagePresentation>
      : <div className="message-attachments">{attachments}</div>)}
  </>;
}
