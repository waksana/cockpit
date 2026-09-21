import { describeReason, reportUxError } from './errorReporter';

export function installWindowErrorReporting(): () => void {
  function onError(event: ErrorEvent) {
    // Resource failures and sanitized cross-origin errors contain no actionable script detail.
    if (!event.message || (!event.filename && !event.error)) return;
    const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    const stack = event.error?.stack ? `\n${String(event.error.stack).split('\n').slice(0, 4).join('\n')}` : '';
    reportUxError(`${event.message}${location}${stack}`);
  }

  function onUnhandledRejection(event: PromiseRejectionEvent) {
    reportUxError(`未处理的异步错误：${describeReason(event.reason)}`);
  }

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
