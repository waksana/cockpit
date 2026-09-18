import type { ChatWindowMessage, ChatWindowSnapshot } from '@cockpit/module-api';
import type { ChatMessage, ChatSession } from '../net/types';

const NO_MESSAGES: readonly ChatWindowMessage[] = Object.freeze([]);
export const EMPTY_CHAT_WINDOW: ChatWindowSnapshot = Object.freeze({
  sessionId: null, status: 'unavailable', hasMore: false, partial: false, messages: NO_MESSAGES,
});

export type WindowSource = Pick<ChatSession, 'sessionId' | 'messages' | 'materialized' | 'historyStale'
  | 'loadingHistory' | 'hasMore' | 'partialHistory' | 'incompleteBoundary' | 'historyError'>;

interface WindowInput {
  sessionId: string | null;
  status: ChatWindowSnapshot['status'];
  hasMore: boolean;
  partial: boolean;
  error?: string;
  messages?: readonly ChatMessage[];
}

/** Lazy projection: tabs with no consumers do not copy message metadata on each delta. */
export class ModuleChatWindow {
  private input: WindowInput = { sessionId: null, status: 'unavailable', hasMore: false, partial: false };
  private snapshot: ChatWindowSnapshot | undefined = EMPTY_CHAT_WINDOW;
  private readonly projected = new WeakMap<ChatMessage, ChatWindowMessage>();
  private readonly arrays = new WeakMap<readonly ChatMessage[], readonly ChatWindowMessage[]>();

  update(sessionId: string | null, session: WindowSource | undefined, connected: boolean): boolean {
    const current = session?.sessionId === sessionId ? session : undefined;
    const status = !current ? 'unavailable' : current.historyError ? 'error'
      : current.historyStale || (current.materialized && !connected) ? 'stale'
        : current.materialized ? 'ready' : current.loadingHistory ? 'loading' : 'unavailable';
    const next: WindowInput = {
      sessionId, status, hasMore: current?.hasMore ?? false,
      partial: !!(current?.partialHistory || current?.incompleteBoundary),
      ...(current?.historyError ? { error: current.historyError } : {}),
      ...(current ? { messages: current.messages } : {}),
    };
    const previous = this.input;
    if (next.sessionId === previous.sessionId && next.status === previous.status
      && next.hasMore === previous.hasMore && next.partial === previous.partial
      && next.error === previous.error && next.messages === previous.messages) return false;
    this.input = next;
    this.snapshot = undefined;
    return true;
  }

  getSnapshot = (): ChatWindowSnapshot => {
    if (!this.snapshot) {
      const { messages, ...state } = this.input;
      this.snapshot = Object.freeze({ ...state, messages: this.messages(messages) });
    }
    return this.snapshot;
  };

  private messages(source?: readonly ChatMessage[]): readonly ChatWindowMessage[] {
    if (!source?.length) return NO_MESSAGES;
    let result = this.arrays.get(source);
    if (!result) {
      result = Object.freeze(source.map(message => {
        let projected = this.projected.get(message);
        if (!projected) {
          projected = Object.freeze({
            id: message.id, origin: message.origin ? Object.freeze({ ...message.origin }) : null,
            role: message.role, text: message.content, complete: !message.streaming && !message.incomplete,
            ...(message.subtype ? { subtype: message.subtype } : {}),
            children: this.messages(message.subMessages),
          });
          this.projected.set(message, projected);
        }
        return projected;
      }));
      this.arrays.set(source, result);
    }
    return result;
  }
}
