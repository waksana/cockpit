import type { ChatMessage } from '@cockpit/protocol';
import { MessageBody } from './MessageBody';
import { FileCard } from './FileCard';

export function MessageContent({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const partFiles = message.parts?.flatMap(part => part.type === 'file' ? [part.attachment.url] : []);
  if (message.parts) return <>{message.parts.map((part, index) => part.type === 'text'
    ? <MessageBody key={index} body={part.text} sessionId={sessionId} files={partFiles} />
    : <FileCard key={index} file={part.attachment} sessionId={sessionId}
      preview={!message.parts!.slice(0, index).some(previous => previous.type === 'file' && previous.attachment.url === part.attachment.url)} />)}</>;
  const files = message.attachments ?? (message.attachment ? [message.attachment] : []);
  return <>
    {files.map((file, index) => <FileCard key={`${file.url}:${index}`} file={file} sessionId={sessionId} preview={files.findIndex(item => item.url === file.url) === index} />)}
    {message.content && <MessageBody body={message.content} sessionId={sessionId} files={files.map(file => file.url)} />}
  </>;
}
