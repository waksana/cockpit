import { memo, useMemo, type ComponentProps } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../net/store';
import { Thread } from './Thread';

export const ConnectedThread = memo(function ConnectedThread({ sessionId }: { sessionId: string }) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const active = useCockpit(s => s.activeId === sessionId);
  const actions = useCockpit(useShallow((s) => ({
    sendPrompt: s.sendPrompt, respondAsk: s.respondAsk, respondPlan: s.respondPlan,
    planSupersede: s.planSupersede, respondElicitation: s.respondElicitation,
    removeQueued: s.removeQueued, cancel: s.cancel, interrupt: s.interrupt, loadMore: s.loadMore, retryHistory: s.retryHistory,
    observeAttention: s.observeAttention,
  })));
  const callbacks = useMemo<Omit<ComponentProps<typeof Thread>, 'session'>>(() => ({
    onSend: (text, attachment, attachments) => actions.sendPrompt(sessionId, text, attachment, attachments),
    onRespondAsk: (rid, answer, freeform) => actions.respondAsk(sessionId, rid, answer, freeform),
    onRespondPlan: (rid, action) => actions.respondPlan(sessionId, rid, action),
    onPlanSupersede: (rid, message) => actions.planSupersede(sessionId, rid, message),
    onRespondElicitation: (rid, action) => actions.respondElicitation(sessionId, rid, action),
    onRemoveQueued: (itemId) => actions.removeQueued(sessionId, itemId),
    onCancel: () => actions.cancel(sessionId),
    onInterrupt: () => actions.interrupt(sessionId),
    onLoadMore: () => actions.loadMore(sessionId),
    onRetryHistory: () => actions.retryHistory(sessionId),
    onAttentionVisible: (attnId, visible) => actions.observeAttention(sessionId, attnId, visible),
  }), [actions, sessionId]);

  return active && session ? <Thread key={sessionId} session={session} {...callbacks} /> : null;
});
