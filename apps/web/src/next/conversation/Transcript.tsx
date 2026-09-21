import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@cockpit/ui';
import { ChevronDown, Lightbulb, Wrench, BookOpen } from 'lucide-react';
import type { ChatMessage, ToolCall } from '../../net/types';
import { useCockpit } from '../../net/store';
import { DisclosureContext, useDisclosureChoice } from '../../lib/disclosureChoice';
import { groupTranscript, transcriptGap, type ProcessItem } from '../../lib/transcriptRows';
import { toolStatusLabel } from '../../lib/toolStatus';
import { createMessageLayout, canSkipMessageLayout } from '../../components/messageLayout';
import { READING_ACTIVITY_EVENT } from '../../components/threadScroll';
import { CopyText, Markdown, MessageContent } from './Markdown';

export function Disclosures({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const context = useMemo(() => ({ values, set: (key: string, open: boolean) =>
    setValues(previous => new Map(previous).set(key, open)) }), [values]);
  return <DisclosureContext.Provider value={context}>{children}</DisclosureContext.Provider>;
}

function Disclosure({ identity, defaultOpen = false, title, children }: {
  identity: string; defaultOpen?: boolean; title: ReactNode; children: ReactNode;
}) {
  const { open, toggle } = useDisclosureChoice(identity, defaultOpen);
  return <Collapsible open={open} onOpenChange={toggle} className="next-disclosure">
    <CollapsibleTrigger asChild><Button variant="ghost" className="next-disclosure-trigger">
      <ChevronDown aria-hidden="true" data-open={open} />{title}
    </Button></CollapsibleTrigger>
    <CollapsibleContent className="next-disclosure-body">{children}</CollapsibleContent>
  </Collapsible>;
}

function Tool({ tool, scope }: { tool: ToolCall; scope: string }) {
  return <Disclosure identity={JSON.stringify([scope, 'tool', tool.toolCallId])}
    title={<><Wrench aria-hidden="true" /><span>{tool.title || tool.name || '缺少工具名称'}</span>
      {tool.title && tool.title !== tool.name && <code>{tool.name}</code>}
      <span className="next-recorded-status">{toolStatusLabel(tool.status)}</span></>}>
    {tool.args && <section><header>输入 <CopyText text={tool.args} label="复制工具输入" /></header><pre tabIndex={0}>{tool.args}</pre></section>}
    {tool.output && <section><header>输出 <CopyText text={tool.output} label="复制工具输出" /></header><pre tabIndex={0}>{tool.output}</pre></section>}
    {!tool.args && !tool.output && <p>暂无输入或输出记录。</p>}
  </Disclosure>;
}

function Process({ items, scope, identity, latest, latestItem }: {
  items: ProcessItem[]; scope: string; identity: string; latest: boolean; latestItem?: string;
}) {
  const tools = items.flatMap(item => item.kind === 'tool' ? [item.tool] : []);
  const thoughts = items.filter(item => item.kind === 'thought');
  const skills = items.filter(item => item.kind === 'skill');
  const states = (['failed', 'in_progress', 'pending', undefined] as const)
    .map(status => ({ status, count: tools.filter(tool => tool.status === status).length })).filter(value => value.count);
  const title = [tools.length && `${tools.length} 次工具调用`, thoughts.length && `${thoughts.length} 次思考`,
    skills.length && `${skills.length} 次 Skill 使用`].filter(Boolean).join(' · ');
  return <div data-message-id={JSON.stringify([scope, identity])}>
    <Disclosure identity={JSON.stringify([scope, 'process', identity])} defaultOpen={latest}
      title={<><span>{title}</span>{states.map(({ status, count }) =>
        <span key={status ?? 'unknown'} className="next-recorded-status">{count} 项{toolStatusLabel(status)}</span>)}
        {thoughts.some(item => item.message.incomplete) && <span>思考归属未确认</span>}
        <time className="next-recorded-status" dateTime={new Date(items[0].message.timestamp).toISOString()}>
          {new Date(items[0].message.timestamp).toLocaleTimeString()}
        </time></>}>
      <div data-child-history>{items.map(item => <div key={item.key} data-child-message-frame={item.key}>
        <div data-message-id={JSON.stringify([scope, item.key])}>
          {item.kind === 'tool' ? <Tool tool={item.tool} scope={scope} /> : item.kind === 'skill'
            ? <div className="next-skill"><BookOpen aria-hidden="true" />Skill · {item.message.content}</div>
            : <Disclosure identity={JSON.stringify([scope, 'thought', item.message.thoughtKey ?? item.message.id])}
              defaultOpen={item.key === latestItem} title={<><Lightbulb aria-hidden="true" />思考过程</>}>
              {item.message.incomplete && <p role="status">{item.message.incomplete}</p>}
              <Markdown body={item.message.thought ?? ''} />
            </Disclosure>}
        </div>
      </div>)}</div>
    </Disclosure>
  </div>;
}

function ChildTranscript({ message, scope }: { message: ChatMessage; scope: string }) {
  const content = useRef<HTMLDivElement>(null);
  const [head, setHead] = useState<string | null>(null);
  const messages = useMemo(() => message.subMessages ?? [], [message.subMessages]);
  useLayoutEffect(() => {
    const viewport = content.current?.closest('.chat-messages');
    if (!viewport) return;
    const activity = (event: Event) => setHead((event as CustomEvent<boolean>).detail ? messages[0]?.id ?? null : null);
    viewport.addEventListener(READING_ACTIVITY_EVENT, activity);
    return () => viewport.removeEventListener(READING_ACTIVITY_EVENT, activity);
  }, [messages]);
  const start = head ? messages.findIndex(value => value.id === head) : -1;
  return <>
    {message.subagent?.prompt && <section><h4>任务</h4><Markdown body={message.subagent.prompt} /></section>}
    {message.subagent?.error && <p role="alert">{message.subagent.error}</p>}
    <div ref={content} data-child-history><Transcript messages={start > 0 ? messages.slice(start) : messages} scope={scope} nested /></div>
    {!messages.length && <p>当前阅读窗口内暂无子代理消息。</p>}
  </>;
}

function Subagent({ message, scope }: { message: ChatMessage; scope: string }) {
  const connected = useCockpit(state => state.connState === 'open');
  const agent = message.subagent!;
  const status = { running: '已启动', activity: '有后续活动', completed: '本次执行已结束',
    failed: '失败', cancelled: '已取消', unknown: '未知' }[agent.status] ?? '未知';
  return <Disclosure identity={JSON.stringify([scope, 'agent', agent.toolCallId ?? message.id])}
    title={<><span>{agent.displayName}</span><span className="next-recorded-status">记录：{status}{!connected && ' · 待同步'}</span></>}>
    {agent.description && <p>{agent.description}</p>}
    <p className="next-muted">仅为已加载事件的执行记录，不代表当前仍在运行或任务目标已完成。</p>
    <ChildTranscript message={message} scope={JSON.stringify([scope, agent.toolCallId ?? message.id])} />
  </Disclosure>;
}

const Message = memo(function Message({ message, scope, nested, layout, live }: {
  message: ChatMessage; scope: string; nested: boolean; layout: ReturnType<typeof createMessageLayout>; live: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (frame.current && canSkipMessageLayout(message, live)) return layout.observe(frame.current);
  }, [message, live, layout]);
  return <div ref={frame} className={`next-message next-message-${message.role}`}
    data-level={message.level}
    data-message-id={nested ? JSON.stringify([scope, message.id]) : message.id}>
    {message.subtype === 'subagent' && message.subagent ? <Subagent message={message} scope={scope} /> : <>
      {message.subtype === 'ask-reply' && <blockquote aria-label="回答的问题">{message.replyQuestion || '原问题记录不可用'}</blockquote>}
      {message.role === 'system' && message.level === 'error' && <strong>错误</strong>}
      <MessageContent message={message} />
      {message.incomplete && <p role="status">{message.incomplete}</p>}
      <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleString()}</time>
    </>}
  </div>;
});

export const Transcript = memo(function Transcript({ messages, scope, nested = false, liveId }: {
  messages: ChatMessage[]; scope: string; nested?: boolean; liveId?: string;
}) {
  const layout = useMemo(() => createMessageLayout(), []);
  useLayoutEffect(() => () => layout.dispose(), [layout]);
  const [grouped, setGrouped] = useState(() => ({ source: messages, rows: groupTranscript(messages) }));
  let rows = grouped.rows;
  if (grouped.source !== messages) {
    rows = groupTranscript(messages, grouped.rows);
    setGrouped({ source: messages, rows });
  }
  const lastProcess = rows.findLast(row => row.kind === 'process');
  const last = rows.at(-1);
  const latestItem = last?.kind === 'process' ? last.items.at(-1)?.key : last?.message.id;
  return rows.map((row, index) => {
    const first = row.kind === 'process' ? row.items[0].message : row.message;
    return <div key={row.key} className="next-message-frame" data-gap={transcriptGap(rows[index - 1], row)}
      data-window-item-id={first.id} data-message-frame={nested ? undefined : row.key}
      data-child-message-frame={nested ? row.key : undefined}>
      {row.kind === 'process'
        ? <Process items={row.items} identity={row.key} scope={scope} latest={row === lastProcess} latestItem={latestItem} />
        : <Message message={row.message} scope={scope} nested={nested} layout={layout} live={row.message.id === liveId} />}
    </div>;
  });
});
