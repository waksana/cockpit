import { useId } from 'react';
import type { ToolCall } from '../net/types';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { CopyButton } from './CopyButton';
import { useClippedText } from '../lib/useClippedText';
import { toolStatusLabel } from '../lib/toolStatus';

export function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  return <svg className="tool-state-icon" data-status={status ?? 'unknown'} width="16" height="16"
    viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {status === 'completed' ? <path d="m4 10 4 4 8-9" />
      : status === 'failed' ? <><circle cx="10" cy="10" r="7.5" /><path d="M10 5.5v5M10 14h.01" /></>
        : status === 'in_progress' ? <path d="m6 3 10 7-10 7Z" />
          : status === 'pending' ? <><circle cx="10" cy="10" r="7.5" /><path d="M10 5v5l3 2" /></>
            : <><circle cx="10" cy="10" r="7.5" /><path d="M7.5 7a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M10 14h.01" /></>}
  </svg>;
}

export function ToolCallRow({ tc, sessionId }: { tc: ToolCall; sessionId: string }) {
  const { open, toggle } = useDisclosureChoice(JSON.stringify([sessionId, 'tool', tc.toolCallId]), false);
  const name = tc.name || '缺少工具名称';
  const description = tc.title !== name ? tc.title : '';
  const { ref: nameRef, clipped: nameClipped } = useClippedText(name);
  const { ref: descriptionRef, clipped: descriptionClipped } = useClippedText(description);
  const contentId = useId();
  const status = toolStatusLabel(tc.status);
  const label = [name, description, status].filter(Boolean).join(' · ');
  return <div className="msg-tool" data-status={tc.status ?? 'unknown'} data-open={open || undefined}>
    <button type="button" className="activity-head tool-head tool-toggle" aria-expanded={open}
      aria-controls={contentId} aria-label={`${open ? '收起' : '展开'}细节：${label}`} title={label} onClick={toggle}>
      <span className="activity-icon"><ToolStatusIcon status={tc.status} /></span>
      <span className="tool-heading-content">
        <span ref={nameRef} className="tool-label" data-clipped={nameClipped || undefined}><bdi dir="ltr">{name}</bdi></span>
        {description && <><span className="tool-heading-separator" aria-hidden="true">·</span>
          <span ref={descriptionRef} className="tool-description" data-clipped={descriptionClipped || undefined}>{description}</span></>}
      </span>
    </button>
    {open && <div id={contentId} className="activity-detail tool-detail">
      {nameClipped && <section><div className="tool-detail-label">工具名</div><div className="tool-full-name">{name}</div></section>}
      {descriptionClipped && description && <section><div className="tool-detail-label">说明</div><div>{description}</div></section>}
      {!tc.args && !tc.output && <div className="tool-detail-empty">暂无输入或输出记录。</div>}
      {tc.args && <section><div className="tool-detail-label">输入 <CopyButton text={tc.args} label="复制工具输入" /></div>
        <pre className="tool-args" tabIndex={0} aria-label="工具输入">{tc.args}</pre></section>}
      {tc.output && <section><div className="tool-detail-label">输出 <CopyButton text={tc.output} label="复制工具输出" /></div>
        <pre className="tool-output" tabIndex={0} aria-label="工具输出">{tc.output}</pre></section>}
    </div>}
  </div>;
}
