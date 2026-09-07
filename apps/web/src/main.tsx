import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/index.scss'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useCockpit } from './net/store'
import { reportUxError, setErrorReportSink, describeReason } from './lib/errorReporter'
import { isTransportError } from './net/client'

// The reporter sends to the CURRENT session via the store's own sendPrompt (which
// the engine auto-queues when the session is busy). Returns false when there's no
// active/connected session so the reporter can stay quiet rather than spin.
setErrorReportSink((text) => {
  const st = useCockpit.getState()
  if (!st.activeId || st.connState !== 'open') return false
  return st.sendPrompt(st.activeId, text)
})

// Uncaught script errors (skip resource-load errors, which have no message).
window.addEventListener('error', (e) => {
  if (!e.message) return
  // Cross-origin scripts (browser extensions, injected or third-party code) are
  // sanitized by the browser to a bare "Script error." with no filename and no
  // Error object — zero actionable detail, and almost never cockpit's own bundle
  // (same-origin errors arrive with full message/line/stack). Reporting it just
  // injects unactionable noise into the session, so skip it — same rationale as
  // skipping transport errors below.
  if (!e.filename && !e.error) return
  const loc = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''
  reportUxError(`${e.message}${loc}${e.error?.stack ? `\n${String(e.error.stack).split('\n').slice(0, 4).join('\n')}` : ''}`)
})

// Unhandled promise rejections. Skip transport-level fetch failures (a dropped/
// backgrounded connection or a server-restart 502) — those are connectivity, not
// bugs, and the reconnect path recovers from them; reporting them would spam the
// session with "未处理的异步错误：Load failed" noise.
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  if (isTransportError(r)) return
  reportUxError(`未处理的异步错误：${describeReason(r)}`)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
)
