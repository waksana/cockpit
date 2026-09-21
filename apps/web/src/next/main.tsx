import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@cockpit/ui/styles.css';
import App from './App';
import { EntryBoundary, EntryFailure } from './entryBoundary';
import { nextUi } from './ui';
import { BASE_URL } from '../lib/config';
import { describeReason, reportUxError } from '../lib/errorReporter';
import { installWindowErrorReporting } from '../lib/windowErrors';
import { installHostLeaveProtection } from '../lib/hostLeave';
import { moduleRuntime } from '../lib/moduleRuntime';

const container = document.getElementById('root');
if (!container) throw new Error('The new UI root is missing');
const root = createRoot(container);
const removeErrorReporting = installWindowErrorReporting();
const removeLeaveProtection = installHostLeaveProtection(window);
let disposed = false;

function render(moduleBootstrap: 'loading' | 'settled') {
  root.render(
    <StrictMode>
      <BrowserRouter basename="/next">
        <EntryBoundary>
          <App moduleBootstrap={moduleBootstrap} />
        </EntryBoundary>
      </BrowserRouter>
    </StrictMode>,
  );
}

render('loading');
const bootstrap = moduleRuntime.start(BASE_URL, nextUi);
void bootstrap.then(() => {
  if (!disposed) render('settled');
}, error => {
  if (disposed) return;
  const reason = describeReason(error);
  reportUxError(`新界面启动失败：${reason}`);
  root.render(<EntryFailure reason={reason} />);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    root.unmount();
    moduleRuntime.stop();
    removeErrorReporting();
    removeLeaveProtection();
  });
}
