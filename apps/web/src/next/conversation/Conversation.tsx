import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../../net/store';
import { ConversationView, type ConversationViewProps } from './ConversationView';
import type { ModuleBootstrap } from './Composer';
import './styles.css';

export function Conversation({ sessionId, moduleBootstrap }: { sessionId: string; moduleBootstrap: ModuleBootstrap }) {
  const session = useCockpit(state => state.sessions.find(item => item.sessionId === sessionId));
  const active = useCockpit(state => state.activeId === sessionId);
  const actions = useCockpit(useShallow(state => ({
    sendDraft: state.sendDraft, respondAsk: state.respondAsk, respondPlan: state.respondPlan,
    respondElicitation: state.respondElicitation, removeQueued: state.removeQueued, cancel: state.cancel,
    interrupt: state.interrupt, loadMore: state.loadMore, retryHistory: state.retryHistory,
  })));
  const callbacks = useMemo<Omit<ConversationViewProps, 'session' | 'moduleBootstrap'>>(() => ({
    onSend: request => {
      if (request.body.sessionId !== sessionId) throw new Error('Native draft session changed');
      return actions.sendDraft(request);
    },
    onRespondAsk: (request, answer, freeform) => actions.respondAsk(sessionId, request, answer, freeform),
    onRespondPlan: (request, action) => actions.respondPlan(sessionId, request, action),
    onRespondElicitation: (request, action) => actions.respondElicitation(sessionId, request, action),
    onRemoveQueued: item => actions.removeQueued(sessionId, item),
    onCancel: () => actions.cancel(sessionId),
    onInterrupt: () => actions.interrupt(sessionId),
    onLoadMore: () => { void actions.loadMore(sessionId); },
    onRetryHistory: () => { void actions.retryHistory(sessionId); },
  }), [sessionId, actions]);
  return active && session ? <ConversationView key={sessionId} session={session} moduleBootstrap={moduleBootstrap} {...callbacks} /> : null;
}
