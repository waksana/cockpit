// One vocabulary for operation feedback (docs/frontend-guidelines.md#operation-feedback).
// Every in-place result sentence is built here so wording never drifts per page.

export type OperationState = 'busy' | 'done' | 'failed' | 'unknown';

const trimReason = (reason: string) => reason.trim().replace(/[。.；;，,\s]+$/u, '');

export const copy = {
  busy: (action: string) => `正在${action}…`,
  done: (action: string) => `已${action}`,
  failed: (action: string, reason: string) => trimReason(reason) ? `${action}失败：${trimReason(reason)}` : `${action}失败`,
  unknown: (reason: string) => `结果未知：${trimReason(reason) || '未收到确认'}。刷新后确认，不会自动重试。`,
};

export function operationSentence(state: OperationState, action: string, reason = ''): string {
  switch (state) {
    case 'busy': return copy.busy(action);
    case 'done': return copy.done(action);
    case 'failed': return copy.failed(action, reason);
    case 'unknown': return copy.unknown(reason);
  }
}
