import { createContext, useContext, useState } from 'react';

interface Choices {
  values: ReadonlyMap<string, boolean>;
  set: (key: string, open: boolean) => void;
}
export const DisclosureContext = createContext<Choices | null>(null);

export function useDisclosureChoice(key: string, defaultOpen: boolean) {
  const context = useContext(DisclosureContext);
  const [local, setLocal] = useState<boolean | null>(null);
  const override = context ? context.values.get(key) : local;
  const open = override ?? defaultOpen;
  return { open, toggle: () => context ? context.set(key, !open) : setLocal(!open) };
}
