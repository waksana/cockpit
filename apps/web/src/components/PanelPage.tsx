// The shell for a per-session detail sub-page rendered in the info-panel slot:
// the same header (close + title) and scrollable body as SessionInfoPanel.
import type { ReactNode } from 'react';
import { useMediaQuery } from '../lib/useMediaQuery';
import { PHONE_QUERY } from '../lib/layout';
import { IconButton } from './Button';
import { PaneBody, PaneHeader } from './PaneHeader';
import { StateNotice } from './StateNotice';

export function PanelCloseButton({ onClose }: { onClose: () => void }) {
  const phone = useMediaQuery(PHONE_QUERY);
  return <IconButton icon={phone ? 'back' : 'close'} label={phone ? '返回对话' : '关闭'} onClick={onClose} />;
}

export function PanelPageShell({ title, onClose, loading, children, bodyClassName = '' }: {
  title: string;
  onClose: () => void;
  loading?: boolean;
  children?: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <>
      <PaneHeader leading={<PanelCloseButton onClose={onClose} />}
        title={<span className="pane-title" title={title}>{title}</span>} />
      <PaneBody className={`info-panel-body ${bodyClassName}`.trim()}>
        {loading
          ? <StateNotice kind="loading" placement="pane">加载中…</StateNotice>
          : children}
      </PaneBody>
    </>
  );
}
