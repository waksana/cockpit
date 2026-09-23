import { useId, useState, type ReactNode } from 'react';
import { useClippedText } from '../lib/useClippedText';

export function ResourceSummary({ name, source, badge }: { name: ReactNode; source?: ReactNode; badge?: ReactNode }) {
  return <span className="resource-summary manage-row-main">
    <span className="resource-name manage-row-name">{badge}<span>{name}</span></span>
    {source && <span className="resource-source manage-row-sub">{source}</span>}
  </span>;
}

// Native resource actions and their lifecycle stay with the caller.
export function ResourceRow({ name, source, badge, control, status, description, connection = false, title }: {
  name: string; source: ReactNode; control: ReactNode; status: ReactNode;
  badge?: ReactNode; description?: ReactNode; connection?: boolean; title?: string;
}) {
  const identity = <>
    <div className="resource-name manage-row-name">{badge}<span className="resource-title-text">{name}</span></div>
    {source && <div className="resource-source manage-row-source">{source}</div>}
    {description !== undefined && <div className="manage-row-description">{description}</div>}
  </>;
  return <div className="resource-row manage-row manage-session-row" data-mcp={connection || undefined}
    data-resource-name={name} title={title}>
    <div className="manage-resource-identity">{identity}</div>
    {control}
    {status}
  </div>;
}

// Dense reading disclosures keep their line-height target, separate from actions.
export function ResourceText({ text, label, lines = 1 }: { text: string; label: string; lines?: 1 | 2 }) {
  const id = useId();
  const { ref, clipped } = useClippedText(text, lines);
  const [expanded, setExpanded] = useState(false);
  const content = <span ref={ref} id={id} className="manage-row-text" data-lines={lines}
    data-expanded={expanded || undefined}>{text}</span>;
  return clipped || expanded
    ? <button type="button" className="manage-text-disclosure ck-button"
      aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(!expanded)}>{content}</button>
    : content;
}

export function ResourceError({ error, name }: { error: string; name: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <>
    <div className="manage-row-status" role="status">
      <button type="button" className="manage-error-disclosure ck-button"
        aria-label={`${expanded ? '收起' : '展开'}${name}错误详情`} aria-expanded={expanded} aria-controls={id}
        title={expanded ? '收起错误详情' : '查看错误详情'}
        onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '失败'}</button>
    </div>
    <div id={id} className="manage-row-error" hidden={!expanded}>未确认：{error}</div>
  </>;
}
