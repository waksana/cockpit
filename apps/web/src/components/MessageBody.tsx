import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isMessageImageSrcAllowed } from '../lib/messageImage'
import { fileDownloadUrl, managedFileMentions, managedUploadPath } from '../lib/managedFile'
import { ManagedFileMention } from './FileCard'

// Chat-message markdown renderer. GFM enables tables, strikethrough, task lists,
// and autolinks. Links open in a new tab; code/diff fences render as standard
// <pre><code>. memo'd because body is stable per message — without it every
// composer keystroke would re-run the remark pipeline for every message.
export const MessageBody = memo(function MessageBody({ body, sessionId, files }: { body: string; sessionId?: string; files?: string[] }) {
  return (
    <div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [managedFileMentions, { files }]]}
        components={{
          a: ({ node, href, children, ...props }) => {
            const url = managedUploadPath(href);
            if (url && node?.properties['data-managed-preview'] === 'yes') {
              return <ManagedFileMention url={url} name={typeof children === 'string' ? children : decodeURIComponent(url.split('/').pop()!)} sessionId={sessionId} />
            }
            if (node?.children.some(child => child.type === 'element' && child.tagName === 'img'
              && typeof child.properties.src === 'string' && managedUploadPath(child.properties.src))) {
              return <span>{children}<a {...props} href={url ? fileDownloadUrl(url) : href} target="_blank" rel="noopener noreferrer">打开链接</a></span>
            }
            return <a {...props} href={url ? fileDownloadUrl(url) : href} target="_blank" rel="noopener noreferrer">{children}</a>
          },
          table: ({ node: _node, ...props }: { node?: unknown }) => (
            <table data-chat-table {...props} />
          ),
          img: ({ node, src, alt, ...rest }) => {
            const url = managedUploadPath(src);
            if (url) {
              return node?.properties['data-managed-preview'] === 'yes'
                ? <ManagedFileMention url={url} name={alt || decodeURIComponent(url.split('/').pop()!)} sessionId={sessionId} />
                : <a href={fileDownloadUrl(url)} download>{alt || '下载原文件'}</a>
            }
            if (isMessageImageSrcAllowed(src)) {
              return <img src={src} alt={alt ?? ''} {...rest} />
            }
            return (
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                data-img-blocked
                title="external/unrecognized image src blocked by sanitizer; click to open in new tab"
              >
                [image blocked: {alt || src || 'no src'}]
              </a>
            )
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
})
