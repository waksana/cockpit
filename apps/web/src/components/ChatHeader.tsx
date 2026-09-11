import type { RefObject } from 'react';
import { Icon, type IconName } from './Icon';
import type { SessionMode } from './ModeMenu';

const LABELS: Record<SessionMode, string> = { interactive: '交互', plan: '计划', autopilot: '自动' };
const ICONS: Record<SessionMode, IconName> = {
  interactive: 'mode_interactive', plan: 'mode_plan', autopilot: 'mode_autopilot',
};

export function ChatHeader({ title, modelLabel, mode, modeRef, moreRef, modeOpen, moreOpen, onBack, onInfo, onMode, onMore }: {
  title: string; modelLabel: string; mode?: SessionMode | null;
  modeRef: RefObject<HTMLButtonElement | null>; moreRef: RefObject<HTMLButtonElement | null>;
  modeOpen: boolean; moreOpen: boolean;
  onBack: () => void; onInfo: () => void; onMode: () => void; onMore: () => void;
}) {
  return <header className="chat-topbar">
    <button className="chat-back btn-icon rp lg:hidden" type="button" aria-label="返回" onClick={onBack}>
      <Icon name="back" size={24} />
    </button>
    <button type="button" className="chat-topbar-content" aria-label="查看会话信息" onClick={onInfo}>
      <span className="chat-topbar-title" title={title}>{title}</span>
      {modelLabel && <span className="chat-topbar-subtitle"><span className="chat-topbar-model" title={modelLabel}>{modelLabel}</span></span>}
    </button>
    <button ref={modeRef} className="chat-topbar-mode btn-icon rp" type="button"
      aria-label={`模式：${mode ? LABELS[mode] : '未加载或未知'}，点击切换`}
      aria-haspopup="menu" aria-expanded={modeOpen} data-mode={mode ?? 'unknown'} onClick={onMode}>
      <Icon name={mode ? ICONS[mode] : 'more'} size={24} />
    </button>
    <button ref={moreRef} className="chat-topbar-more btn-icon rp" type="button" aria-label="更多操作"
      aria-haspopup="menu" aria-expanded={moreOpen} onClick={onMore}>
      <Icon name="more" size={24} />
    </button>
  </header>;
}
