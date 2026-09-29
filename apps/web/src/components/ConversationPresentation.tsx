import { memo, useContext } from 'react';
import type { ChatMessageProps, MessageListProps } from '@cockpit/module-api/frontend';
import { ChatMessageFrameContext } from '../lib/publicComponentContext';
import { conversationGap, messageClock, messageDateLabel, sameMessageDay } from '../lib/messagePresentation';
import { MessageContentPresentation } from './MessageContent';

export const MessageTimestamp = memo(function MessageTimestamp({ timestamp, className }: { timestamp: number; className?: string }) {
  const date = new Date(timestamp);
  const full = date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
  return <time className={className} dateTime={date.toISOString()} title={full} aria-label={full}>{messageClock(timestamp)}</time>;
});

export function MessageListBase({ viewportRef, contentRef, before, children, className, ...props }: MessageListProps) {
  return <div tabIndex={0} aria-label="对话消息" {...props} ref={viewportRef}
    className={['chat-messages', className].filter(Boolean).join(' ')}>
    <div ref={contentRef} className="chat-message-content">
      {before}
      <div className="chat-message-rows">{children}</div>
    </div>
  </div>;
}

export function ChatMessageBase({ identity, origin, decisionOrigin, complete, bodyRef, rowRef, role, timestamp, body, attachments,
  previous, showTimestamp, today = new Date().setHours(0, 0, 0, 0), children, className, ...props }: ChatMessageProps) {
  const embedded = useContext(ChatMessageFrameContext);
  const hasContent = !!body.trim() || !!attachments?.length;
  const newDay = !previous || !sameMessageDay(previous.timestamp, timestamp);
  const showTime = showTimestamp ?? (role === 'user' || newDay || previous?.role !== 'assistant');
  const content = <>
    <MessageContentPresentation identity={identity} origin={origin} decisionOrigin={decisionOrigin} complete={complete}
      bodyRef={bodyRef} body={body} attachments={attachments} />
    {children && <div className="chat-message-actions">{children}</div>}
  </>;
  const row = role === 'user' ? <div className="user-message">
    <div className="message is-out" data-message-id={embedded?.anchorId}>{content}</div>
    {showTime && <div className="user-message-meta"><MessageTimestamp className="message-time" timestamp={timestamp} /></div>}
  </div> : <article className="message is-doc">
    {showTime && hasContent && <header className="doc-byline"><MessageTimestamp className="doc-time" timestamp={timestamp} /></header>}
    <div className="message-speech" data-message-id={embedded?.anchorId}>{content}</div>
  </article>;
  if (embedded) return row;
  return <div {...props} ref={rowRef} className={['msg-group', 'chat-conversation-message', className].filter(Boolean).join(' ')}
    data-gap={newDay ? 'none' : conversationGap(previous?.role, role)}
    data-assistant-message={role === 'assistant' && hasContent || undefined}>
    {newDay && hasContent && <div className="date-separator" aria-hidden="true">{messageDateLabel(timestamp, today)}</div>}
    {row}
  </div>;
}
