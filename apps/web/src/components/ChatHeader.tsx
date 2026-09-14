import type { RefObject } from 'react';
import { Icon } from './Icon';

export function ChatHeader({ title, modelLabel, moreRef, moreOpen, onBack, onInfo, onMore }: {
  title: string; modelLabel: string;
  moreRef: RefObject<HTMLButtonElement | null>;
  moreOpen: boolean;
  onBack: () => void; onInfo: () => void; onMore: () => void;
}) {
  return <header className="chat-topbar">
    <button className="chat-back btn-icon rp lg:hidden" type="button" aria-label="返回" onClick={onBack}>
      <Icon name="back" size={24} />
    </button>
    <button type="button" className="chat-topbar-content" aria-label="查看会话信息" onClick={onInfo}>
      <span className="chat-topbar-title" title={title}>{title}</span>
      {modelLabel && <span className="chat-topbar-subtitle"><span className="chat-topbar-model" title={modelLabel}>{modelLabel}</span></span>}
    </button>
    <button ref={moreRef} className="chat-topbar-more btn-icon rp" type="button" aria-label="更多操作"
      aria-haspopup="menu" aria-expanded={moreOpen} onClick={onMore}>
      <Icon name="more" size={24} />
    </button>
  </header>;
}
