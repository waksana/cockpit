import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useClippedText } from '../lib/useClippedText';
import { resourceErrorSummary } from '../lib/resourcePresentation';
import { Icon } from './Icon';
import { Badge } from './UI';
import { Button } from './Button';

// One row for session and global resource lists: badge + name, an optional
// one-line summary, then status and control on one centered line. Native
// actions and their lifecycle stay with the caller. A link makes the identity
// a selectable master item; the control always stays outside it.
export function ResourceRow({ name, summary, badge, control, status, feedback, title, link, connection = false }: {
  name: string; control: ReactNode;
  summary?: ReactNode; badge?: ReactNode; status?: ReactNode; feedback?: ReactNode; title?: string;
  link?: { to: string; replace?: boolean; selected: boolean }; connection?: boolean;
}) {
  const identity = <>
    <span className="resource-name manage-row-name">{badge}<span className="resource-title-text">{name}</span></span>
    {summary && <span className="resource-source manage-row-source">{summary}</span>}
  </>;
  return <div className="resource-row manage-row" data-mcp={connection || undefined}
    data-selectable={link ? true : undefined} data-selected={link?.selected || undefined}
    data-resource-name={name} title={title}>
    {link
      ? <Link className="manage-resource-identity ck-button" to={link.to} replace={link.replace}
        aria-current={link.selected ? 'page' : undefined}>{identity}</Link>
      : <div className="manage-resource-identity">{identity}</div>}
    <div className="manage-resource-controls">
      {status && <div className="manage-row-status" role="status">{status}</div>}
      {control}
    </div>
    {feedback}
  </div>;
}

export function ResourceList({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return <>
    {hint && <p className="manage-list-hint">{hint}</p>}
    <div className="manage-list">{children}</div>
  </>;
}

export function ResourceProgress({ children }: { children: ReactNode }) {
  return <Badge className="mcp-status mcp-operation-status" tone="pending" appearance="text">
    <Icon name="loading" className="spinner" size={10} />{children}
  </Badge>;
}

// A single-line summary. Inside navigation it cannot own a disclosure, so the
// full text is kept in the title and in the selected detail.
export function ResourceText({ text, label, lines = 1, disclosure = true }: {
  text: string; label: string; lines?: 1 | 2; disclosure?: boolean;
}) {
  const id = useId();
  const { ref, clipped } = useClippedText(text, lines);
  const [expanded, setExpanded] = useState(false);
  const content = <span ref={ref} id={id} className="manage-row-text" data-lines={lines}
    data-expanded={expanded || undefined} title={disclosure ? undefined : text}>{text}</span>;
  return disclosure && (clipped || expanded)
    ? <Button className="manage-text-disclosure"
      aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(!expanded)}>{content}</Button>
    : content;
}

export function ResourceError({ error, name, label = '操作未确认' }: { error: string; name: string; label?: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <div className="manage-row-error">
    <div id={`${id}-summary`} className="manage-error-summary" role="status">{label}：{resourceErrorSummary(error)}</div>
    <Button className="manage-error-disclosure"
      aria-label={`${expanded ? '收起' : '展开'}${name}错误详情`} aria-expanded={expanded} aria-controls={id}
      aria-describedby={`${id}-summary`}
      onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '查看错误详情'}</Button>
    <div id={id} className="manage-error-full" hidden={!expanded}>{error}</div>
  </div>;
}
