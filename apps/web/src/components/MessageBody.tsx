import { memo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';

const MarkdownLink: Components['a'] = ({ node: _node, ...props }) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);
// Preserve unsupported Markdown media as text; fetching and previewing it is
// not part of the native text renderer.
const MarkdownMedia: Components['img'] = ({ src, alt }) => <span>{`![${alt ?? ''}](${src ?? ''})`}</span>;

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
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const element = table.current;
      if (element && element.scrollWidth > element.clientWidth) {
        event.preventDefault();
        element.scrollLeft += event.key === 'ArrowRight' ? 80 : -80;
      }
    }}><table ref={table} data-chat-table {...props} /></div>;
};
const components: Components = {
  a: MarkdownLink, img: MarkdownMedia, pre: MarkdownCodeBlock, table: MarkdownTable,
};
export const MessageBody = memo(function MessageBody({ body }: { body: string }) {
  return <div className="message-body">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{body}</ReactMarkdown>
  </div>;
});
