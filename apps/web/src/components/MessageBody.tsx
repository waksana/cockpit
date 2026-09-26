import { createContext, memo, useContext, useRef, type ReactNode, type Ref } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';
import { MarkdownReplacement, MessagePresentation } from './ModuleComponents';
import type { MessageIdentity, MessageOrigin } from '@cockpit/module-api/frontend';
import { ORIGINAL_MARKDOWN_TARGET, originalMarkdownTarget, remarkOriginalMarkdownTargets } from '../lib/messageContent';

const OriginContext = createContext<MessageOrigin | undefined>(undefined);
const LinkContext = createContext(false);
function labelOf(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(labelOf).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = children.props as { children?: ReactNode; alt?: string };
    return props.alt ?? labelOf(props.children);
  }
  return '';
}
const MarkdownLink: Components['a'] = ({ node, href, children, ...props }) => {
  const origin = useContext(OriginContext);
  const { [ORIGINAL_MARKDOWN_TARGET]: _original, ...linkProps } = props as typeof props & { [ORIGINAL_MARKDOWN_TARGET]?: string };
  const fallback = <LinkContext.Provider value={true}>
    <a {...linkProps} href={href ? defaultUrlTransform(href) : undefined} target="_blank" rel="noopener noreferrer">{children}</a>
  </LinkContext.Provider>;
  const target = originalMarkdownTarget(node, href);
  return origin && target !== undefined ? <MarkdownReplacement node={{ kind: 'link', origin, target, label: labelOf(children) }} fallback={fallback} /> : fallback;
};
// Preserve unsupported Markdown media as text; fetching and previewing it is
// not part of the native text renderer.
const MarkdownMedia: Components['img'] = ({ node, src, alt }) => {
  const origin = useContext(OriginContext);
  const insideLink = useContext(LinkContext);
  const source = typeof src === 'string' ? src : undefined;
  const target = originalMarkdownTarget(node, source);
  const fallback = <span>{`![${alt ?? ''}](${source ?? ''})`}</span>;
  return origin && !insideLink && target !== undefined ? <MarkdownReplacement node={{ kind: 'image', origin, target, label: alt ?? '' }} fallback={fallback} /> : fallback;
};
const MarkdownParagraph: Components['p'] = ({ node: _node, ...props }) => <p className="markdown-paragraph" {...props} />;

const MarkdownCodeBlock: Components['pre'] = ({ node, children }) => {
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  const text = code?.type === 'element'
    ? code.children.filter(child => child.type === 'text').map(child => child.value).join('') : '';
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = Array.isArray(classes) ? String(classes.find(name => String(name).startsWith('language-')) ?? '').slice(9) : '';
  return <div className="chat-code-block">
    <div className="chat-code-head"><span>{language || '代码'}</span><CopyButton text={text} label="复制代码" /></div>
    <pre tabIndex={0} aria-label={`${language || '代码'}代码块`}>{children}</pre>
  </div>;
};
const MarkdownTable: Components['table'] = ({ node: _node, ...props }) => {
  const table = useRef<HTMLTableElement | null>(null);
  return <div className="chat-table-scroll" role="region" aria-label="表格（可横向滚动）" tabIndex={0}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const element = table.current;
      if (element && element.scrollWidth > element.clientWidth) {
        event.preventDefault();
        element.scrollLeft += event.key === 'ArrowRight' ? 80 : -80;
      }
    }}><table ref={table} data-chat-table {...props} /></div>;
};
const components: Components = {
  a: MarkdownLink, img: MarkdownMedia, p: MarkdownParagraph, pre: MarkdownCodeBlock, table: MarkdownTable,
};
const markdownPlugins = [remarkGfm, remarkOriginalMarkdownTargets];

const LabelBlock = ({ children }: { children?: ReactNode }) => <span className="markdown-label-block">{children}</span>;
const LabelHeading = ({ children }: { children?: ReactNode }) => <strong className="markdown-label-block">{children}</strong>;
const LabelCell = ({ children }: { children?: ReactNode }) => <span>{children}{' '}</span>;
const labelComponents: Components = {
  p: LabelBlock, pre: LabelBlock, blockquote: LabelBlock, li: LabelBlock,
  h1: LabelHeading, h2: LabelHeading, h3: LabelHeading, h4: LabelHeading, h5: LabelHeading, h6: LabelHeading,
  tr: ({ children }) => <span className="markdown-label-row">{children}</span>,
  th: LabelCell, td: LabelCell,
  img: ({ src, alt }) => <span>{`![${alt ?? ''}](${typeof src === 'string' ? src : ''})`}</span>,
  input: ({ checked }) => <span>{checked ? '[x]' : '[ ]'}</span>,
  hr: () => <LabelBlock>---</LabelBlock>,
};
const labelElements = [...Object.keys(labelComponents), 'strong', 'em', 'del', 'code', 'br', 'sup'];

// Button labels retain phrasing only, without links, module replacements or focusable block controls.
export const MarkdownLabel = memo(function MarkdownLabel({ body }: { body: string }) {
  return <span className="message-body markdown-label">
    <ReactMarkdown remarkPlugins={markdownPlugins} components={labelComponents}
      allowedElements={labelElements} unwrapDisallowed>{body}</ReactMarkdown>
  </span>;
});

export const MessageBody = memo(function MessageBody({ body, origin, elementRef, identity, complete = true }: {
  body: string; origin?: MessageOrigin; elementRef?: Ref<HTMLDivElement>; identity?: MessageIdentity; complete?: boolean;
}) {
  const children = <ReactMarkdown remarkPlugins={markdownPlugins} components={components} urlTransform={url => url}>{body}</ReactMarkdown>;
  return <OriginContext.Provider value={origin}>
    {identity ? <MessagePresentation className="message-body" identity={identity} complete={complete} bodyRef={elementRef}>{children}</MessagePresentation>
      : <div className="message-body" ref={elementRef}>{children}</div>}
  </OriginContext.Provider>;
});
