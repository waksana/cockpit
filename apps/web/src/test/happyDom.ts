import { after } from 'node:test';
import { GlobalWindow, PropertySymbol } from 'happy-dom';

// Side-effect module: registers a real happy-dom document as this test process's
// browser globals. Import it (normally via `./dom`) before anything that reads
// `window` or `document` at import time. Each test file runs in its own process.
//
// Node keeps its own timers, network, streams and platform APIs so that
// `t.mock.method(globalThis, 'fetch')`, `t.mock.timers`, `Response.json` and
// React's scheduler behave exactly as in the rest of the suite.
const KEEP_NODE = new Set([
  'constructor', 'undefined', 'NaN', 'global', 'globalThis', 'console', 'process',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'performance', 'crypto',
  'fetch', 'Request', 'Response', 'Headers', 'AbortController', 'AbortSignal',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream',
  'TransformStream', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'WebSocket',
]);

export const DOM_URL = 'http://127.0.0.1:47831/';
export const window = new GlobalWindow({
  url: DOM_URL, width: 1000, height: 800, console: globalThis.console,
  settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true },
});

const restore: [PropertyKey, PropertyDescriptor | undefined][] = [];
const descriptors = Object.getOwnPropertyDescriptors(window) as Record<PropertyKey, PropertyDescriptor>;
for (const key of [...Object.keys(descriptors), ...Object.getOwnPropertySymbols(descriptors)]) {
  if (typeof key === 'string' && KEEP_NODE.has(key)) continue;
  const descriptor = descriptors[key as keyof typeof descriptors];
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  if (previous && previous.value !== undefined && previous.value === descriptor.value) continue;
  // Self references (`window`, `self`, `top`, …) become the global object itself.
  if (descriptor.value === window) descriptor.value = globalThis;
  restore.push([key, previous]);
  Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
}
(window.document as unknown as Record<symbol, unknown>)[PropertySymbol.defaultView] = globalThis;
// Direct createRoot/act users get React's act environment too, not only Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

after(async () => {
  for (const [key, previous] of restore.reverse()) {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});
