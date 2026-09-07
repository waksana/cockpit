import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Image sanitizer allowlist:
//   - same-origin paths only: starts with `/`, `./`, `../`
// Everything else (external http(s), protocol-relative, javascript:, file:,
// data: URIs, other schemes) is blocked and rendered as a click-through link so
// content isn't silently lost. Note: react-markdown's defaultUrlTransform already
// strips any non-(https?|ircs?|mailto|xmpp) `src` to '' before this renderer runs,
// so e.g. `data:`/`javascript:` srcs arrive here empty and fail the `!src` guard.
function isImgSrcAllowed(src: string | undefined): boolean {
  if (!src) return false
  if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) return true
  return false
}

// Chat-message markdown renderer. GFM enables tables, strikethrough, task lists,
// and autolinks. Links open in a new tab; code/diff fences render as standard
// <pre><code>. memo'd because body is stable per message — without it every
// composer keystroke would re-run the remark pipeline for every message.
export const MessageBody = memo(function MessageBody({ body }: { body: string }) {
  return (
    <div className="message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          table: ({ node: _node, ...props }: { node?: unknown }) => (
            <table data-chat-table {...props} />
          ),
          img: ({ node: _node, src, alt, ...rest }: {
            node?: unknown
            src?: string
            alt?: string
          }) => {
            if (isImgSrcAllowed(src)) {
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
