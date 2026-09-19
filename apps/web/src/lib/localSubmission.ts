type SubmissionView = { sessionId: string; onAccepted(): void };
const views = new Set<SubmissionView>();

export function observeLocalSubmissions(sessionId: string, onAccepted: () => void): () => void {
  const view = { sessionId, onAccepted };
  views.add(view);
  return () => { views.delete(view); };
}

// Capture at dispatch, not ACK: leaving and reopening the same session creates
// a different view lifetime and must not inherit an earlier send's effects.
export function captureLocalSubmission(sessionId: string): () => void {
  const targets = [...views].filter(view => view.sessionId === sessionId);
  return () => {
    for (const view of targets) if (views.has(view)) view.onAccepted();
  };
}
