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

import { Intents, type IntentBody } from '@cockpit/protocol';
import type { DraftNativeFields, DraftReference } from '@cockpit/module-api';

type DraftIntent = 'prompt' | 'respondAsk' | 'planSupersede';
export type NativeDraftRequest = {
  [Name in DraftIntent]: { readonly intent: Name; readonly body: IntentBody<Name> };
}[DraftIntent];
export const CORE_DRAFT_FIELDS = new Set([
  'sessionId', 'text', 'mode', 'requestId', 'answer', 'message', 'wasFreeform', 'action',
]);

export function nativeDraftRequest(draft: DraftReference, text: string, fields: DraftNativeFields): NativeDraftRequest {
  for (const key of Object.keys(fields)) {
    if (CORE_DRAFT_FIELDS.has(key)) throw new Error(`Draft schema cannot overwrite native field ${key}`);
  }
  const { sessionId, purpose } = draft;
  switch (purpose.kind) {
    case 'prompt':
      return { intent: 'prompt', body: Intents.prompt.body.strict().parse({ ...fields, sessionId, text }) };
    case 'ask':
      return { intent: 'respondAsk', body: Intents.respondAsk.body.strict().parse({
        ...fields, sessionId, requestId: purpose.requestId, answer: text, wasFreeform: true,
      }) };
    case 'plan':
      return { intent: 'planSupersede', body: Intents.planSupersede.body.strict().parse({
        ...fields, sessionId, requestId: purpose.requestId, message: text,
      }) };
    case 'elicitation':
      throw new Error('This native decision does not accept a text submission');
  }
}
