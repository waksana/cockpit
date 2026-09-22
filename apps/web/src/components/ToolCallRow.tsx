import { useId } from 'react';
import type { ToolCall } from '../net/types';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { CopyButton } from './CopyButton';
import { useClippedText } from '../lib/useClippedText';
import { toolStatusLabel } from '../lib/toolStatus';
import { Icon, type IconName } from './Icon';

function toolIcon(name?: string): IconName {
  switch (name?.replace(/^functions\./, '')) {
    case 'bash': case 'powershell': case 'read_bash': case 'stop_bash': case 'list_bash': return 'shell';
    case 'task': case 'read_agent': case 'write_agent': case 'list_agents': return 'agent';
    case 'ask_user': case 'exit_plan_mode': return 'decision';
    default: return 'tool';
  }
}

export function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  return <Icon className="tool-state-icon" data-status={status ?? 'unknown'} size={16}
    name={status === 'completed' ? 'success' : status === 'failed' ? 'error'
      : status === 'in_progress' ? 'loading' : status === 'pending' ? 'clock' : 'unknown'} />;
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
    <button type="button" className="activity-head tool-head tool-toggle ck-button" aria-expanded={open}
      aria-controls={contentId} aria-label={`${open ? '收起' : '展开'}细节：${label}`} title={label} onClick={toggle}>
      <span className="activity-icon"><Icon name={toolIcon(tc.name)} size={16} /></span>
      <span className="tool-heading-content">
        {description && <span ref={descriptionRef} className="tool-description" data-clipped={descriptionClipped || undefined}>{description}</span>}
        <span ref={nameRef} className="tool-label" data-clipped={nameClipped || undefined}><bdi dir="ltr">{name}</bdi></span>
      </span>
      <ToolStatusIcon status={tc.status} />
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
