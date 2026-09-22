import { createContext, memo, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@cockpit/ui';
import { Copy, Check } from 'lucide-react';
import type { MessageIdentity, MessageOrigin } from '@cockpit/module-api';
import type { ChatMessage } from '../../net/types';
import { copyText } from '../../lib/copyText';
import { ORIGINAL_MARKDOWN_TARGET, originalMarkdownTarget, remarkOriginalMarkdownTargets } from '../../lib/messageContent';
import { Attachment, MarkdownReplacement, MessagePresentation } from '../modules';

const Origin = createContext<MessageOrigin | undefined>(undefined);
const InsideLink = createContext(false);
function label(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(label).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = children.props as { children?: ReactNode; alt?: string };
    return props.alt ?? label(props.children);
  }
  return '';
}

export function CopyText({ text, label: name = '复制' }: { text: string; label?: string }) {
  const [result, setResult] = useState<{ text: string; copied: boolean }>();
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const inFlight = useRef(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const copied = result?.text === text && result.copied;
  return <><Button type="button" variant="ghost" size="sm" aria-label={name} aria-busy={pending} aria-disabled={pending || undefined}
    onClick={async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      try { await copyText(text); if (active.current) setResult({ text, copied: true }); }
      catch { if (active.current) setResult({ text, copied: false }); }
      finally { inFlight.current = false; if (active.current) setPending(false); }
    }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? '已复制' : name}</Button>
    {result?.text === text && !result.copied && <span role="alert">复制失败，请手动选择文字复制。</span>}</>;
}

const Link: Components['a'] = ({ node, href, children, ...props }) => {
  const origin = useContext(Origin);
  const { [ORIGINAL_MARKDOWN_TARGET]: _original, ...rest } = props as typeof props & { [ORIGINAL_MARKDOWN_TARGET]?: string };
  const fallback = <InsideLink.Provider value={true}><a {...rest} href={href ? defaultUrlTransform(href) : undefined}
    target="_blank" rel="noopener noreferrer">{children}</a></InsideLink.Provider>;
  const target = originalMarkdownTarget(node, href);
  return origin && target !== undefined
    ? <MarkdownReplacement node={{ kind: 'link', origin, target, label: label(children) }} fallback={fallback} /> : fallback;
};
const Media: Components['img'] = ({ node, src, alt }) => {
  const origin = useContext(Origin);
  const insideLink = useContext(InsideLink);
  const source = typeof src === 'string' ? src : '';
  const target = originalMarkdownTarget(node, source);
  const fallback = <span>{`![${alt ?? ''}](${source})`}</span>;
  return origin && !insideLink && target !== undefined
    ? <MarkdownReplacement node={{ kind: 'image', origin, target, label: alt ?? '' }} fallback={fallback} /> : fallback;
};
const Pre: Components['pre'] = ({ node, children }) => {
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  const text = code?.type === 'element' ? code.children.filter(child => child.type === 'text').map(child => child.value).join('') : '';
  return <div className="next-code"><CopyText text={text} label="复制代码" /><pre tabIndex={0}>{children}</pre></div>;
};
const Table: Components['table'] = ({ node: _node, ...props }) =>
  <div className="next-table" role="region" tabIndex={0} aria-label="表格（可横向滚动）"><table {...props} /></div>;
const components: Components = { a: Link, img: Media, pre: Pre, table: Table };

export const Markdown = memo(function Markdown({ body, origin, identity, complete = true }: {
  body: string; origin?: MessageOrigin; identity?: MessageIdentity; complete?: boolean;
}) {
  const prose = <ReactMarkdown remarkPlugins={[remarkGfm, remarkOriginalMarkdownTargets]}
    components={components} urlTransform={url => url}>{body}</ReactMarkdown>;
  return <Origin.Provider value={origin}>{identity
    ? <MessagePresentation className="next-prose" identity={identity} complete={complete}>{prose}</MessagePresentation>
    : <div className="next-prose">{prose}</div>}</Origin.Provider>;
});

export function MessageContent({ message }: { message: ChatMessage }) {
  const identity: MessageIdentity | undefined = message.origin ? {
    kind: 'message', role: message.role, sessionId: message.origin.sessionId, id: message.origin.messageId,
    ...(message.origin.agentId ? { agentId: message.origin.agentId } : {}),
  } : undefined;
  const attachments = message.attachments?.map((attachment, index) => {
    const target = 'path' in attachment ? attachment.path : attachment.type === 'selection' ? attachment.filePath : undefined;
    const name = attachment.displayName || target || '附件';
    const unavailable = attachment.type === 'blob' && (attachment.data === undefined || !!attachment.omittedReason);
    return <Attachment key={index} origin={message.origin} index={index} attachment={attachment} label={name}>
      <span>{name}{unavailable && ` · 附件不可用（${attachment.omittedReason === 'too_large' ? '超出大小限制' : '原生资源不可用'}）`}</span>
    </Attachment>;
  });
  return <>
    {!!message.content.trim() && <Markdown body={message.content} origin={message.origin} identity={identity} complete={!message.streaming} />}
    {!!attachments?.length && (identity && !message.content.trim()
      ? <MessagePresentation className="next-attachments" identity={identity} complete={!message.streaming}>{attachments}</MessagePresentation>
      : <div className="next-attachments">{attachments}</div>)}
  </>;
}
