import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useCockpit } from '../../net/store';

// MCP owns one serial lane; skills own independent named lanes. Late writes
// must not launch reads after their session, connection or view is replaced.
export function useToggleRequests(
  sessionId: string, mutate: (sessionId: string, name: string, enabled: boolean) => Promise<void>,
  refresh: () => Promise<boolean>, exclusive: boolean,
) {
  const [pending, setPending] = useState<{ sessionId: string; generation: number; count: number } | null>(null);
  const owner = useRef<{ names: Set<string>; active: boolean }>({ names: new Set(), active: false });
  const generation = useCockpit(s => s.connectionGeneration);
  useLayoutEffect(() => {
    const current = { names: new Set<string>(), active: true };
    owner.current = current;
    return () => { current.active = false; };
  }, [sessionId, generation]);
  const run = useCallback(async (name: string, enabled: boolean) => {
    const current = owner.current;
    const state = useCockpit.getState();
    const session = state.sessions.find(s => s.sessionId === sessionId);
    if (!current.active || state.connState !== 'open' || !session?.loaded || session.closing) {
      throw new Error('会话当前不可操作，请先核对连接与加载状态');
    }
    if (current.names.has(name) || (exclusive && (current.names.size || (session.activeMcpOperations ?? 0) > 0))) {
      throw new Error('已有切换操作正在处理，请等待完成');
    }
    current.names.add(name);
    setPending({ sessionId, generation, count: current.names.size });
    let refreshed = false;
    try {
      try { await mutate(sessionId, name, enabled); }
      finally {
        if (current.active && owner.current === current) refreshed = await refresh();
      }
      if (current.active && !refreshed) throw new Error('操作已返回，但未能读取最新状态；请刷新核对，不要直接重试');
    } finally {
      current.names.delete(name);
      if (current.active && owner.current === current) setPending({ sessionId, generation, count: current.names.size });
    }
  }, [sessionId, generation, mutate, refresh, exclusive]);
  return { run, pending: pending?.sessionId === sessionId && pending.generation === generation && pending.count > 0 };
}
