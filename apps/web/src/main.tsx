import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/index.scss'
import './components/UxErrorNotifications.scss'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UxErrorNotifications } from './components/UxErrorNotifications'
import { installWindowErrorReporting } from './lib/windowErrors'
import { installHostLeaveProtection } from './lib/hostLeave'
import { moduleRuntime } from './lib/moduleRuntime'
import { BASE_URL } from './lib/config'

if (!(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true)) {
  void moduleRuntime.start(BASE_URL)
}

const removeErrorReporting = installWindowErrorReporting()
const removeLeaveProtection = installHostLeaveProtection(window)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    moduleRuntime.stop()
    removeErrorReporting()
    removeLeaveProtection()
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
