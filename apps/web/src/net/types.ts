// App view-model types. The wire types (ChatMessage, SessionMeta, ServerEvent,
// intents) live in @cockpit/protocol — the single shared truth. Here we only
// add the client-local materialized view of a session (its loaded message
// window + per-tab flags) layered on top of the server's SessionMeta.

export type {
  ChatMessage, ToolCall, SessionMeta, SessionStatus,
  ModelOption, ServerEvent, NativeAttachment,
  ExitPlanModeAction,
} from '@cockpit/protocol';

import type { ChatMessage, SessionMeta } from '@cockpit/protocol';

// A session as the UI holds it: the server's authoritative meta plus this tab's
// materialized message window and view flags.
export interface ChatSession extends SessionMeta {
  controlsStale?: boolean;
  controlsDisplay?: NonNullable<SessionMeta['controls']>;
  controlsError?: string;
  activityDisplay?: import('@cockpit/module-api').SessionActivityDisplay;
  messages: ChatMessage[];
  materialized: boolean;
  historyStale: boolean;
  hasMore: boolean;
  loadingHistory: boolean;
  historyError?: string;
  partialHistory?: boolean;
  incompleteBoundary?: boolean;
}
