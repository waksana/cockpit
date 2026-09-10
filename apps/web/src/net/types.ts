// App view-model types. The wire types (ChatMessage, SessionMeta, ServerEvent,
// intents) live in @cockpit/protocol — the single shared truth. Here we only
// add the client-local materialized view of a session (its loaded message
// window + per-tab flags) layered on top of the server's SessionMeta.

export type {
  ChatMessage, ToolCall, ChatRole, SessionMeta, SessionStatus, AgentStatus,
  ModelOption, QueuedItem, AskRequest, ServerEvent, TodoProgress,
  TodoItem, SessionPlan, SessionPanels, PanelItem, Attachment, DirEntry, DirListing,
  ExitPlanModeAction, UploadedFile,
} from '@cockpit/protocol';

import type { ChatMessage, SessionMeta } from '@cockpit/protocol';

// A session as the UI holds it: the server's authoritative meta plus this tab's
// materialized message window and view flags. The "needs you" signal (the sidebar
// dot + app-icon badge) is NOT here — it derives purely from the server's
// `attention`/`attnId`/`seenId` on SessionMeta, so it can't drift per-device.
export interface ChatSession extends SessionMeta {
  messages: ChatMessage[];
  materialized: boolean;
  historyStale: boolean;
  hasMore: boolean;
  loadingHistory: boolean;
  historyError?: string;
  partialHistory?: boolean;
  incompleteBoundary?: boolean;
}
