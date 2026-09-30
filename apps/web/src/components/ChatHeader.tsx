import type { RefObject } from 'react';
import { Button, IconButton } from './Button';
import { ConversationHeader } from './ModuleComponents';

export function ChatHeader({ title, modelLabel, moreRef, moreOpen, onBack, onInfo, onMore }: {
  title: string; modelLabel: string;
  moreRef: RefObject<HTMLButtonElement | null>;
  moreOpen: boolean;
  onBack: () => void; onInfo: () => void; onMore: () => void;
}) {
  return <ConversationHeader
    leading={<IconButton className="chat-back lg:hidden" icon="back" label="返回" onClick={onBack} />}
    title={<Button className="chat-topbar-content" aria-label={`查看会话信息：${title}`} onClick={onInfo}>
      <span className="pane-title chat-topbar-title ck-text-primary" title={title}>{title}</span>
      {modelLabel && <span className="chat-topbar-subtitle ck-text-secondary"><span className="chat-topbar-model" title={modelLabel}>{modelLabel}</span></span>}
    </Button>}
    actions={<IconButton ref={moreRef} className="chat-topbar-more" icon="more" label="更多操作"
      aria-haspopup="menu" aria-expanded={moreOpen} onClick={onMore} />} />;
}
