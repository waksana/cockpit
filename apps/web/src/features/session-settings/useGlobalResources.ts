import { useLayoutEffect, useRef, useState } from 'react';
import { useCockpit } from '../../net/store';
import { cockpitApi } from '../../net/api';

export function useGlobalResourceMutations(section: 'mcp' | 'skills') {
  const [refreshNonce, setRefreshNonce] = useState(0);
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
    try { await (section === 'mcp' ? cockpitApi.mcpSetDefault(name, enabled) : cockpitApi.skillsSetGlobal(name, enabled)); }
    finally {
      const state = useCockpit.getState();
      if (current.active && state.connState === 'open' && state.connectionGeneration === generation) refresh();
    }
  };
  return { refreshNonce, refresh, onChange };
}
