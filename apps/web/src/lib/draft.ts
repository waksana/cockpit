export async function acknowledge(send: () => Promise<boolean> | undefined): Promise<boolean> {
  try { return (await send()) === true; } catch { return false; }
}

export async function acknowledgeInView(
  scope: { active: boolean },
  send: () => Promise<boolean>,
  callbacks: { scrollRevision: () => number; onAccepted: () => void },
): Promise<boolean> {
  if (!scope.active) return false;
  const revision = callbacks.scrollRevision();
  const sent = await acknowledge(send);
  if (sent && scope.active && callbacks.scrollRevision() === revision) callbacks.onAccepted();
  return sent;
}

export interface DraftSendHandlers {
  askRequestId?: string;
  planRequestId?: string;
  onSend?: (text: string, attachments?: NativeAttachment[]) => Promise<boolean>;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  onPlanSupersede?: (requestId: string, message: string) => Promise<boolean>;
}

export function sendThreadDraft(text: string, handlers: DraftSendHandlers, attachments?: NativeAttachment[]): Promise<boolean> {
  if (attachments?.length && (handlers.askRequestId !== undefined || handlers.planRequestId !== undefined)) {
    reportUxError('当前回答或计划反馈不接受附件，请先移除附件；草稿已保留。');
    return Promise.resolve(false);
  }
  return acknowledge(() => {
    if (handlers.askRequestId !== undefined) {
      return handlers.onRespondAsk?.(handlers.askRequestId, text, true);
    }
    if (handlers.planRequestId !== undefined) {
      return handlers.onPlanSupersede?.(handlers.planRequestId, text);
    }
    return attachments?.length ? handlers.onSend?.(text, attachments) : handlers.onSend?.(text);
  });
}
import type { NativeAttachment } from '@cockpit/protocol';
import { reportUxError } from './errorReporter';
