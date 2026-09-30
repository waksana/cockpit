import type { ConversationFrameProps, ConversationHeaderProps, ConversationTranscriptProps } from '@cockpit/module-api/frontend';
import { Button } from './Button';
import { ComposerSurface } from './ComposerSurface';
import { MessageList } from './ModuleComponents';
import { PaneHeader } from './PaneHeader';

export function ConversationFrameBase({ header, notices, composer, children, className, ...props }: ConversationFrameProps) {
  return <>{header}<main {...props} className={['chat', className].filter(Boolean).join(' ')}>
    {children}
    <ComposerSurface>
      <div className="chat-input-notices">{notices}</div>
      {composer}
    </ComposerSurface>
  </main></>;
}

export function ConversationHeaderBase({ className, ...props }: ConversationHeaderProps) {
  return <PaneHeader {...props} className={['chat-topbar', className].filter(Boolean).join(' ')} />;
}

export function ConversationTranscriptBase({ awayFromBottom, hasNewContent, onFollow, followContent, ...props }: ConversationTranscriptProps) {
  return <div className="chat-transcript">
    <MessageList {...props} />
    {awayFromBottom && <Button className="new-msg-badge" data-decision={!!followContent || undefined} onClick={onFollow}>
      {followContent ?? (hasNewContent ? '有新内容 · 回到最新' : '回到最新')}
    </Button>}
  </div>;
}
