import { memo, useEffect, useMemo, type ComponentProps } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../net/store';
import { Thread } from './Thread';

export const ConnectedThread = memo(function ConnectedThread({ sessionId }: { sessionId: string }) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const active = useCockpit(s => s.activeId === sessionId);
  const watchControls = useCockpit(s => s.watchControls);
  useEffect(() => {
    if (active && session?.loaded) return watchControls(sessionId);
  }, [active, session?.loaded, sessionId, watchControls]);
  const actions = useCockpit(useShallow((s) => ({
    sendDraft: s.sendDraft, respondAsk: s.respondAsk, respondPlan: s.respondPlan,
    respondElicitation: s.respondElicitation,
    removeQueued: s.removeQueued, cancel: s.cancel, interrupt: s.interrupt, loadMore: s.loadMore, retryHistory: s.retryHistory,
    sessionControlAction: s.sessionControlAction,
    refreshControls: s.refreshControls,
  })));
  const callbacks = useMemo<Omit<ComponentProps<typeof Thread>, 'session'>>(() => ({
    onSend: request => {
      if (request.body.sessionId !== sessionId) throw new Error('Native draft session changed');
      return actions.sendDraft(request);
    },
    onRespondAsk: (rid, answer, freeform) => actions.respondAsk(sessionId, rid, answer, freeform),
    onRespondPlan: (rid, action) => actions.respondPlan(sessionId, rid, action),
    onRespondElicitation: (rid, action) => actions.respondElicitation(sessionId, rid, action),
    onRemoveQueued: (itemId) => actions.removeQueued(sessionId, itemId),
    onCancel: () => actions.cancel(sessionId),
    onInterrupt: () => actions.interrupt(sessionId),
    onLoadMore: () => actions.loadMore(sessionId),
    onRetryHistory: () => actions.retryHistory(sessionId),
    onControlAction: actions.sessionControlAction ? action => actions.sessionControlAction!(sessionId, action) : undefined,
    onRetryControls: () => actions.refreshControls(sessionId),
  }), [actions, sessionId]);

  return active && session ? <Thread key={sessionId} session={session} {...callbacks} /> : null;
});
