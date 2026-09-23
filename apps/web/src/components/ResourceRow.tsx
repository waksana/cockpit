import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { resourceErrorSummary } from '../lib/resourcePresentation';
import { copy } from '../lib/copy';
import { operationErrorState } from '../lib/operationErrors';
import { Icon } from './Icon';
import { Badge } from './UI';
import { TextClamp } from './Disclosure';
import { OperationResult } from './OperationResult';

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

// A clamped summary. Inside navigation it cannot own a disclosure, so the
// full text is kept in the title and in the selected detail.
export function ResourceText({ text, label, lines = 1, disclosure = true }: {
  text: string; label: string; lines?: 1 | 2; disclosure?: boolean;
}) {
  return <TextClamp className="manage-row-text" text={text} label={label} lines={lines} expandable={disclosure} />;
}

// A row's operation or connection result. `label` names a current state (such
// as a connection error) rather than a failed operation.
export function ResourceError({ error, name, cause, action = '操作', label }: {
  error: string; name: string; cause?: unknown; action?: string; label?: string;
}) {
  const summary = resourceErrorSummary(error);
  const state = label ? 'failed' : operationErrorState(cause);
  const sentence = label ? `${label}：${summary}` : state === 'unknown' ? copy.unknown(summary) : copy.failed(action, summary);
  return <OperationResult className="manage-row-error" state={state} name={`${name}${label ? '' : '错误'}`}
    details={error.trim() !== summary ? error : null}>{sentence}</OperationResult>;
}
