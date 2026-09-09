import type { SubagentHistoryPage } from '@cockpit/protocol';
import { createKeyedAsync, type ResourceConnection } from './keyedAsync';

export type ChildHistoryOptions = { beforeMsgId?: string; afterMsgId?: string; limit?: number };
export type ReadChildHistory = (
  sessionId: string, toolCallId: string, options: ChildHistoryOptions, signal: AbortSignal,
) => Promise<SubagentHistoryPage>;

export function mergeSubagentHistory(
  previous: SubagentHistoryPage | undefined, page: SubagentHistoryPage, options: ChildHistoryOptions,
): SubagentHistoryPage {
  if (page.append) {
    if (!previous || !options.afterMsgId || !page.messages.some((m) => m.id === options.afterMsgId)) {
      throw new Error('子代理历史缺少请求的续读位置，请刷新重试。');
    }
    const boundary = previous.messages.findIndex((m) => m.id === options.afterMsgId);
    if (boundary < 0) throw new Error('子代理历史续读位置已失效。');
    return { ...page, messages: [...previous.messages.slice(0, boundary), ...page.messages], hasMore: previous.hasMore };
  }
  if (!previous || page.latest || !options.beforeMsgId) return page;
  const have = new Set(previous.messages.map((m) => m.id));
  return { ...page, messages: [...page.messages.filter((m) => !have.has(m.id)), ...previous.messages] };
}

// Owned only by one expanded card; no closed-card cache or background polling.
export function createSubagentHistory(
  sessionId: string, toolCallId: string, read: ReadChildHistory, connection: () => ResourceConnection,
) {
  const task = createKeyedAsync<SubagentHistoryPage>(JSON.stringify([sessionId, toolCallId]), connection);
  let pending: Promise<boolean> | undefined;
  let queuedRefresh = false;
  let failedOptions: ChildHistoryOptions | undefined;
  let epoch = 0;
  const refreshOptions = (): ChildHistoryOptions => {
    const afterMsgId = task.getSnapshot().data?.messages.at(-1)?.id;
    return { ...(afterMsgId ? { afterMsgId } : {}), limit: 30 };
  };
  const run = (options: ChildHistoryOptions): Promise<boolean> => {
    if (pending) return pending;
    const started = epoch;
    failedOptions = options;
    const result = task.run(async (signal) => {
      const page = await read(sessionId, toolCallId, options, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (page.sessionId !== sessionId || page.toolCallId !== toolCallId) throw new Error('子代理历史标识不匹配。');
      return mergeSubagentHistory(task.getSnapshot().data, page, options);
    });
    pending = result;
    void result.then((ok) => {
      if (started !== epoch || pending !== result) return;
      pending = undefined;
      if (ok) failedOptions = undefined;
      const refresh = queuedRefresh;
      queuedRefresh = false;
      // An error always waits for an explicit retry; it must not retry itself.
      if (ok && refresh) void run(refreshOptions());
    });
    return result;
  };
  return {
    subscribe: task.subscribe,
    getSnapshot: task.getSnapshot,
    activate: task.activate,
    deactivate(release = false) {
      epoch++;
      pending = undefined;
      queuedRefresh = false;
      failedOptions = undefined;
      if (release) task.release();
      else task.deactivate();
    },
    refresh() {
      if (pending) { queuedRefresh = true; return pending; }
      return run(refreshOptions());
    },
    retry() { return run(failedOptions ?? refreshOptions()); },
    loadOlder() {
      const data = task.getSnapshot().data;
      const beforeMsgId = data?.messages[0]?.id;
      if (!data?.hasMore || !beforeMsgId) return Promise.resolve(false);
      return run({ beforeMsgId, limit: 30 });
    },
  };
}
