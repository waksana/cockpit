import { useId } from 'react';
import type { ToolCall } from '../net/types';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { CopyButton } from './CopyButton';
import { useClippedText } from '../lib/useClippedText';
import { toolStatusLabel } from '../lib/toolStatus';
import { Icon } from './Icon';
import { Button } from './Button';
import { toolPresentation } from '../lib/toolPresentation';

export function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  return <Icon className="tool-state-icon" data-status={status ?? 'unknown'} size={16}
    name={status === 'completed' ? 'success' : status === 'failed' ? 'error'
      : status === 'in_progress' ? 'loading' : status === 'pending' ? 'clock' : 'unknown'} />;
}

export function ToolCallRow({ tc, sessionId }: { tc: ToolCall; sessionId: string }) {
  const { open, toggle } = useDisclosureChoice(JSON.stringify([sessionId, 'tool', tc.toolCallId]), false);
  const name = tc.name || '缺少工具名称';
  const presentation = toolPresentation(tc.name);
  // MCP rows are tagged by their native server; the full tool name moves to details.
  // Without a native server name the full name stays as the tag rather than a guess.
  const server = presentation.builtin ? undefined : tc.mcpServerName || undefined;
  const tag = presentation.builtin ? '' : server ?? name;
  const description = tc.title && tc.title !== name ? tc.title : presentation.builtin ? presentation.label
    : server ? tc.title || tc.mcpToolName || name : '';
  const { ref: tagRef, clipped: tagClipped } = useClippedText(tag);
  const { ref: descriptionRef, clipped: descriptionClipped } = useClippedText(description);
  const contentId = useId();
  const status = toolStatusLabel(tc.status);
  const label = [name, description !== name && description, server && `服务器 ${server}`, status]
    .filter(Boolean).join(' · ');
  return <div className="msg-tool" data-status={tc.status ?? 'unknown'} data-open={open || undefined}>
    <Button className="activity-head tool-head tool-toggle" aria-expanded={open}
      aria-controls={contentId} aria-label={`${open ? '收起' : '展开'}细节：${label}`} title={label} onClick={toggle}>
      <span className="activity-icon"><Icon name={presentation.icon} size={16} /></span>
      <span className="tool-heading-content">
        {description && <span ref={descriptionRef} className="tool-description" data-clipped={descriptionClipped || undefined}>{description}</span>}
        {tag && <span ref={tagRef} className="tool-label" data-server={server ? '' : undefined}
          data-clipped={tagClipped || undefined}><bdi dir="ltr">{tag}</bdi></span>}
      </span>
      <ToolStatusIcon status={tc.status} />
    </Button>
    {open && <div id={contentId} className="activity-detail tool-detail">
      {(presentation.builtin || server || tagClipped) && <section><div className="tool-detail-label">工具名</div><div className="tool-full-name">{name}</div></section>}
      {server && <section><div className="tool-detail-label">MCP 服务器</div><div className="tool-full-name">{server}</div></section>}
      {server && tc.mcpToolName && tc.mcpToolName !== name && <section><div className="tool-detail-label">MCP 工具名</div>
        <div className="tool-full-name">{tc.mcpToolName}</div></section>}
      {descriptionClipped && description && <section><div className="tool-detail-label">说明</div><div>{description}</div></section>}
      {!tc.args && !tc.output && <div className="tool-detail-empty">暂无输入或输出记录。</div>}
      {tc.args && <section><div className="tool-detail-label">输入 <CopyButton text={tc.args} label="复制工具输入" /></div>
        <pre className="tool-args" tabIndex={0} aria-label="工具输入">{tc.args}</pre></section>}
      {tc.output && <section><div className="tool-detail-label">输出 <CopyButton text={tc.output} label="复制工具输出" /></div>
        <pre className="tool-output" tabIndex={0} aria-label="工具输出">{tc.output}</pre></section>}
    </div>}
  </div>;
}
