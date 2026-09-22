import { useLayoutEffect, useRef, useState } from 'react';
import { useCockpit } from '../../net/store';
import { useKeyedResource } from '../../lib/useKeyedResource';

export function useGlobalResources(section: 'mcp' | 'skills') {
  const controller = useGlobalResourceMutations(section);
  const mcpGlobal = useCockpit(s => s.mcpGlobal);
  const mcpCatalog = useKeyedResource('global:mcp', mcpGlobal, controller.refreshNonce, section === 'mcp');
  return { ...controller, mcpCatalog };
}

export function useGlobalResourceMutations(section: 'mcp' | 'skills') {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const mutate = useCockpit(s => section === 'mcp' ? s.mcpSetDefault : s.skillsSetGlobal);
  const connected = useCockpit(s => s.connState === 'open');
  const generation = useCockpit(s => s.connectionGeneration);
  const owner = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: true };
    owner.current = current;
    return () => { current.active = false; };
  }, [connected, generation]);
  const refresh = () => setRefreshNonce(n => n + 1);
  const onChange = async (name: string, enabled: boolean) => {
    const current = owner.current;
    try { await mutate(name, enabled); }
    finally {
      const state = useCockpit.getState();
      if (current.active && state.connState === 'open' && state.connectionGeneration === generation) refresh();
    }
  };
  return { refreshNonce, refresh, onChange };
}
