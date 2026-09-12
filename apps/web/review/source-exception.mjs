// The sole explicitly authorized exception to the pinned 9eaf348 presentation.
// Remove source JSX, not CSS-hide a hint or alter its surrounding callbacks.
export function stripInterruptHint(source) {
  const lines = [
    '                aria-describedby={`interrupt-help-${session.sessionId}`}\n',
    '              <span id={`interrupt-help-${session.sessionId}`}>只打断主回合，保留队列；后台任务继续，可能延后处理。</span>\n',
  ];
  for (const line of lines) {
    if (source.split(line).length !== 2) throw new Error('Pinned interrupt-hint exception no longer matches exactly once.');
    source = source.replace(line, '');
  }
  return source;
}
