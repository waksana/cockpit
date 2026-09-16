import type { ChatMessage } from '@cockpit/protocol';
import { MessageBody } from './MessageBody';
import { hasMessageContent } from '../lib/messageContent';
import { ModuleRenderNode } from './ModuleContributions';

export function MessageContent({ message }: { message: ChatMessage }) {
  if (!hasMessageContent(message)) return null;
  return <>
    {!!message.content.trim() && <MessageBody body={message.content} origin={message.origin} />}
    {!!message.attachments?.length && <div className="message-attachments">
      {message.attachments.map((attachment, index) => {
        const target = 'path' in attachment ? attachment.path : attachment.type === 'selection' ? attachment.filePath : undefined;
        const label = attachment.displayName || target || '附件';
        const unavailable = attachment.type === 'blob' && (attachment.data === undefined || !!attachment.omittedReason);
        const reason = attachment.type === 'blob' && attachment.omittedReason === 'too_large' ? '超出大小限制' : '原生资源不可用';
        const fallback = <span className="message-attachment">{label}{unavailable && ` · 附件不可用（${reason}）`}</span>;
        return message.origin ? <ModuleRenderNode key={index}
          node={{ kind: 'attachment', origin: message.origin, target, label, attachment }} fallback={fallback} />
          : <span key={index}>{fallback}</span>;
      })}
    </div>}
  </>;
}
