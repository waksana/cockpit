import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

async function configuration(base: string | null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: (key: string) => key === 'cockpit:base-url' ? base : null },
  });
  try {
    const url = new URL(`./config.ts?fixture=${randomUUID()}`, import.meta.url);
    const loaded: typeof import('./config') = await import(url.href);
    return loaded;
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('browser API defaults to the serving origin rather than a particular deployment', async () => {
  const config = await configuration(null);
  assert.equal(config.BASE_URL, '');
  assert.equal(config.EVENTS_URL, '/events');
  assert.equal(config.CHAT_STREAM_URL, '/chat/stream');
  assert.equal(config.intentUrl('system/status'), '/intent/system/status');
});

test('an explicit user-selected backend is still respected', async () => {
  const config = await configuration('https://operator.example');
  assert.equal(config.BASE_URL, 'https://operator.example');
  assert.equal(config.intentUrl('session/list'), 'https://operator.example/intent/session/list');
});
