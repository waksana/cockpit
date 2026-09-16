import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/index.scss'
import './components/UxErrorNotifications.scss'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UxErrorNotifications } from './components/UxErrorNotifications'
import { reportUxError, describeReason } from './lib/errorReporter'
import { moduleRuntime } from './lib/moduleRuntime'
import { BASE_URL } from './lib/config'

if (!(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true)) {
  void moduleRuntime.start(BASE_URL)
}

// Uncaught script errors (skip resource-load errors, which have no message).
function onError(e: ErrorEvent) {
  if (!e.message) return
  // Cross-origin scripts (browser extensions, injected or third-party code) are
  // sanitized by the browser to a bare "Script error." with no filename and no
  // Error object — zero actionable detail, and almost never cockpit's own bundle
  // (same-origin errors arrive with full message/line/stack). Skip notices with
  // no actionable detail.
  if (!e.filename && !e.error) return
  const loc = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''
  reportUxError(`${e.message}${loc}${e.error?.stack ? `\n${String(e.error.stack).split('\n').slice(0, 4).join('\n')}` : ''}`)
}

function onUnhandledRejection(e: PromiseRejectionEvent) {
  reportUxError(`未处理的异步错误：${describeReason(e.reason)}`)
}

window.addEventListener('error', onError)
window.addEventListener('unhandledrejection', onUnhandledRejection)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    moduleRuntime.stop()
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
    <UxErrorNotifications />
  </StrictMode>,
)
