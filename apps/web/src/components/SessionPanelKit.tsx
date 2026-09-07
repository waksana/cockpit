// Shared building blocks for the session detail surfaces — the info panel and the
// per-session detail sub-pages (Automation / Context) that the kebab opens into the
// info-panel slot. Extracted so the panel and the pages render identical section
// cards instead of transcribing them twice.

import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

// The shared collapsible primitive for every detail section: a toggle header
// (title + optional count + chevron) over a body that mounts only when open.
// Self-manages its open state — callers unmount it while data reloads, so it
// resets to closed on session switch with no extra plumbing.
export function CollapsibleSection({ title, count, bodyClassName, children }: {
  title: ReactNode;
  count?: number;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="info-section">
      <button className="info-section-name info-section-toggle rp" type="button" onClick={() => setOpen((v) => !v)}>
        {title}
        <span className="info-section-name-right">
          {count != null && count}
          <Icon name={open ? 'up' : 'down'} size={20} />
        </span>
      </button>
      {open && (
        <div className={bodyClassName ? `info-section-content ${bodyClassName}` : 'info-section-content'}>
          {children}
        </div>
      )}
    </section>
  );
}

// The shell for a per-session detail sub-page rendered in the info-panel slot:
// the same header (close + title) and scrollable body as SessionInfoPanel, so a
// moved-out section looks identical to where it used to live. Shows a loading or
// empty placeholder in place of the body when asked.
export function PanelPageShell({ title, onClose, loading, empty, children }: {
  title: string;
  onClose: () => void;
  loading?: boolean;
  empty?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <header className="info-panel-header">
        <button className="btn-icon rp" type="button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={24} />
        </button>
        <span className="info-panel-title">{title}</span>
      </header>
      <div className="info-panel-body scrollable">
        {loading
          ? <div className="info-loading"><span className="spinner" /> 加载中…</div>
          : empty != null
            ? <div className="info-empty">{empty}</div>
            : children}
      </div>
    </>
  );
}
