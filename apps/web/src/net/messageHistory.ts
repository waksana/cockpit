import type { NativeChatPage, NativeChatRead } from '@cockpit/protocol';
import type { NativeWindow } from './nativeWindow';

export const HISTORY_BOUNDARY_PAGES = 32;

export async function readMessageHistory(
  window: NativeWindow, initial: NativeChatRead,
  read: (query: NativeChatRead, signal: AbortSignal) => Promise<NativeChatPage>,
  signal: AbortSignal, current: () => boolean,
): Promise<void> {
  const adoptingLive = initial.bootstrap && window.materialized;
  let hasMessage = false;
  let query = initial;
  for (let index = 0; index < HISTORY_BOUNDARY_PAGES; index++) {
    signal.throwIfAborted();
    if (!current()) throw new DOMException('Obsolete history read', 'AbortError');
    const page = await read(query, signal);
    signal.throwIfAborted();
    if (!current()) throw new DOMException('Obsolete history read', 'AbortError');
    const before = new Set(window.snapshot().messages.map(message => message.id));
    window.accept(page, query);
    hasMessage ||= window.snapshot().messages.some(message => !before.has(message.id));
    window.boundaryPending = window.hasMore && (window.unresolved || (!hasMessage && !adoptingLive));
    if (!window.boundaryPending || adoptingLive) return;
    if (!page.cursor || page.cursor === query.cursor) throw new Error('原生历史游标未前进，已停止加载。');
    query = { ...initial, ...window.older, bootstrap: false };
  }
}
