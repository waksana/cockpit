import { createContext, memo, useContext, useRef } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isMessageImageSrcAllowed } from '../lib/messageImage'
import { fileDownloadUrl, managedFileMentions, managedUploadPath } from '../lib/managedFile'
import { ManagedFileMention, PreviewImage } from './FileCard'
import { CopyButton } from './CopyButton'

const MessageSession = createContext<string | undefined>(undefined)

function containsImage(node: ExtraProps['node']): boolean {
  return node?.children.some(child => child.type === 'element'
    && (child.tagName === 'img' || containsImage(child))) ?? false
}

const MarkdownLink: Components['a'] = ({ node, href, children, ...props }) => {
  const sessionId = useContext(MessageSession)
  const url = managedUploadPath(href)
  if (url && node?.properties['data-managed-preview'] === 'yes') {
    return <ManagedFileMention url={url} name={typeof children === 'string' ? children : decodeURIComponent(url.split('/').pop()!)} sessionId={sessionId} />
  }
  if (containsImage(node)) {
    return <span>{children}<a {...props} href={url ? fileDownloadUrl(url) : href} target="_blank" rel="noopener noreferrer">打开链接</a></span>
  }
  return <a {...props} href={url ? fileDownloadUrl(url) : href} target="_blank" rel="noopener noreferrer">{children}</a>
}

const MarkdownImage: Components['img'] = ({ node, src, alt, title }) => {
  const sessionId = useContext(MessageSession)
  const url = managedUploadPath(src)
  if (url) {
    return node?.properties['data-managed-preview'] === 'yes'
      ? <ManagedFileMention url={url} name={alt || decodeURIComponent(url.split('/').pop()!)} sessionId={sessionId} />
      : <a href={fileDownloadUrl(url)} download>{alt || '下载原文件'}</a>
  }
  if (typeof src === 'string' && isMessageImageSrcAllowed(src)) {
    return <a className="chat-inline-image" href={src} target="_blank" rel="noopener noreferrer" aria-label={`查看图片：${alt || '原图'}（新页面）`}>
      <PreviewImage key={src} src={src} name={alt ?? ''} title={title} />
      <span className="chat-inline-image-caption" title={alt}>{alt || '查看原图'} ↗</span>
    </a>
  }
  return <a href={src} target="_blank" rel="noopener noreferrer" data-img-blocked
    title="external/unrecognized image src blocked by sanitizer; click to open in new tab">
    [image blocked: {alt || src || 'no src'}]
  </a>
}

const MarkdownParagraph: Components['p'] = ({ node, children }) => {
  const filesOnly = node?.children.some(child => child.type === 'element')
    && node.children.every(child => child.type === 'text' ? !child.value.trim()
      : child.type === 'element' && ['a', 'img'].includes(child.tagName)
        && child.properties['data-managed-preview'] === 'yes')
  return <p className={filesOnly ? 'chat-attachment-grid' : undefined}>{children}</p>
}

const MarkdownCodeBlock: Components['pre'] = ({ node, children }) => {
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
  const text = code?.type === 'element'
    ? code.children.filter(child => child.type === 'text').map(child => child.value).join('') : ''
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const language = Array.isArray(classes) ? String(classes.find(name => String(name).startsWith('language-')) ?? '').slice(9) : ''
  return <div className="chat-code-block">
    <div className="chat-code-head"><span>{language || '代码'}</span><CopyButton text={text} label="复制代码" /></div>
    <pre tabIndex={0} aria-label={`${language || '代码'}代码块`}>{children}</pre>
  </div>
}

const MarkdownTable: Components['table'] = ({ node: _node, ...props }) => {
  const table = useRef<HTMLTableElement | null>(null)
  return <div className="chat-table-scroll" role="region" aria-label="表格（可横向滚动）" tabIndex={0}
    onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const el = table.current
      if (el && el.scrollWidth > el.clientWidth) {
        event.preventDefault()
        el.scrollLeft += event.key === 'ArrowRight' ? 80 : -80
      }
    }}><table ref={table} data-chat-table {...props} /></div>
}

// Component types must outlive body updates; a new type remounts file resources.
const markdownComponents: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  p: MarkdownParagraph,
  pre: MarkdownCodeBlock,
  table: MarkdownTable,
}

// Chat-message markdown renderer. GFM enables tables, strikethrough, task lists,
// and autolinks. Links open in a new tab; code/diff fences render as standard
// <pre><code>. memo'd because body is stable per message — without it every
// composer keystroke would re-run the remark pipeline for every message.
export const MessageBody = memo(function MessageBody({ body, sessionId, files }: { body: string; sessionId?: string; files?: string[] }) {
  return (
    <MessageSession.Provider value={sessionId}><div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [managedFileMentions, { files }]]}
        components={markdownComponents}
      >
        {body}
      </ReactMarkdown>
    </div></MessageSession.Provider>
  )
}, (previous, next) => previous.body === next.body && previous.sessionId === next.sessionId
  && (previous.files?.length ?? 0) === (next.files?.length ?? 0)
  && (previous.files?.every((url, index) => url === next.files?.[index]) ?? true))
