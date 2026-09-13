import { useState, type ReactNode } from 'react';
import { DisclosureContext } from '../lib/disclosureChoice';

export function DisclosureChoices({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  return <DisclosureContext.Provider value={{ values, set: (key, open) => setValues(previous => new Map(previous).set(key, open)) }}>
    {children}
  </DisclosureContext.Provider>;
}
