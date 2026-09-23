export function fixtureStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

// The loopback CSP permits same-origin connections (including /intent). Block
// application transports before importing App, without blocking Vite's HMR socket
// or module/style loading. Never read or clear the user's browser storage.
export function isolateLab(target: object): void {
  const local = fixtureStorage();
  const session = fixtureStorage();
  const blocked = () => { throw new Error('Synthetic lab: application transport is disabled.'); };
  Object.defineProperties(target, {
    fetch: { configurable: true, value: async () => blocked() },
    XMLHttpRequest: { configurable: true, value: class { constructor() { blocked(); } } },
    EventSource: { configurable: true, value: class { constructor() { blocked(); } } },
    localStorage: { configurable: true, get: () => local },
    sessionStorage: { configurable: true, get: () => session },
  });
}
