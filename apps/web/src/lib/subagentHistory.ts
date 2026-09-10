import type { NativeChatRead, NativeChatPage, SubagentInfo } from '@cockpit/protocol';
import { NativeWindow, NATIVE_PAGE } from '../net/nativeWindow';
import { createKeyedAsync, type ResourceConnection } from './keyedAsync';
import { readMessageHistory } from '../net/messageHistory';

export type ReadChildHistory = (query: NativeChatRead, signal?: AbortSignal) => Promise<NativeChatPage>;

export function createSubagentHistory(
  sessionId: string, summary: Pick<SubagentInfo, 'agentId' | 'toolCallId'>, read: ReadChildHistory, connection: () => ResourceConnection,
) {
  const agentIds = [...new Set([summary.agentId, summary.toolCallId].filter((id): id is string => !!id))];
  let window = new NativeWindow(agentIds);
  const task = createKeyedAsync<ReturnType<NativeWindow['snapshot']>>(JSON.stringify([sessionId, agentIds]), connection);
  let failedOlder = false;
  const run = (older: boolean) => {
    if (task.getSnapshot().pending) return Promise.resolve(false);
    failedOlder = older;
    if (!older) window = new NativeWindow(agentIds);
    const view = window;
    return task.run(async signal => {
      const generation = connection().connectionGeneration;
      if (!agentIds.length) throw new Error('此记录未提供原生子代理标识。');
      const query: NativeChatRead = {
        ...(older ? view.older : {}), sessionId, source: 'live', direction: 'backward',
        agentIds, max: NATIVE_PAGE, waitMs: 0, bootstrap: false,
      };
      await readMessageHistory(view, query, (next, abort) => read(next, abort), signal,
        () => connection().connState === 'open' && connection().connectionGeneration === generation);
      return view.snapshot();
    });
  };
  return {
    subscribe: task.subscribe,
    getSnapshot: task.getSnapshot,
    activate: task.activate,
    deactivate(release = false) { if (release) task.release(); else task.deactivate(); },
    refresh: () => run(false),
    requiresResync: () => window.invalid,
    retry: () => run(window.invalid ? false : failedOlder),
    loadOlder: () => window.hasMore ? run(true) : Promise.resolve(false),
  };
}
