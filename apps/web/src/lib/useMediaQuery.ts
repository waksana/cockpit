import { useCallback, useSyncExternalStore } from 'react';

const serverSnapshot = () => false;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const media = window.matchMedia?.(query);
    media?.addEventListener('change', listener);
    return () => media?.removeEventListener('change', listener);
  }, [query]);
  const snapshot = useCallback(() => window.matchMedia?.(query).matches ?? false, [query]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
