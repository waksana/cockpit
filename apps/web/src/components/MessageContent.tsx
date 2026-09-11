import { useMemo } from 'react';
import type { ChatMessage } from '@cockpit/protocol';
import { MessageBody } from './MessageBody';
import { ChatFileCard } from './FileCard';

export function MessageContent({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const partFiles = useMemo(() => message.parts?.flatMap(part => part.type === 'file' ? [part.attachment.url] : []), [message.parts]);
  const files = useMemo(() => message.attachments ?? (message.attachment ? [message.attachment] : []), [message.attachments, message.attachment]);
  const fileUrls = useMemo(() => files.map(file => file.url), [files]);
  if (message.parts) return <>{message.parts.map((part, index, parts) => {
    if (part.type === 'text') return <MessageBody key={index} body={part.text} sessionId={sessionId} files={partFiles} />;
    if (parts[index - 1]?.type === 'file') return null;
    const end = parts.findIndex((next, at) => at > index && next.type === 'text');
    return <span key={index} className="chat-attachment-grid">
      {parts.slice(index, end < 0 ? parts.length : end).map((next, offset) => next.type === 'file' && (
        <ChatFileCard key={`${next.attachment.url}:${offset}`} file={next.attachment} sessionId={sessionId}
          preview={!parts.slice(0, index + offset).some(previous => previous.type === 'file' && previous.attachment.url === next.attachment.url)} />
      ))}
    </span>;
  })}</>;
  return <>
    {files.length > 0 && <span className="chat-attachment-grid">
      {files.map((file, index) => <ChatFileCard key={`${file.url}:${index}`} file={file} sessionId={sessionId} preview={files.findIndex(item => item.url === file.url) === index} />)}
    </span>}
    {message.content && <MessageBody body={message.content} sessionId={sessionId} files={fileUrls} />}
  </>;
}
