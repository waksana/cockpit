import type { installSyntheticSpeech } from './next-lab-speech';

type Speech = ReturnType<typeof installSyntheticSpeech>;
export interface ModuleLabControls {
  readonly speech: Speech;
  readonly fetch: typeof fetch;
  files(hold: boolean, fail?: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export function moduleLabFetch(nativeFetch: typeof fetch, page: string, session: () => Response): typeof fetch {
  const origin = new URL(page);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Module lab requires loopback');
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    (init?.signal ?? (input instanceof Request ? input.signal : undefined))?.throwIfAborted();
    if (url.origin !== origin.origin || url.username || url.password) throw new Error('Synthetic lab blocked external transport');
    if (/^\/_modules\/cockpit-speech\/[a-f0-9]{64}\/api\/session$/.test(url.pathname) && method === 'POST') {
      return session();
    }
    const bootstrap = url.pathname === '/_modules' && method === 'GET';
    const file = /^\/_modules\/cockpit-file\/[a-f0-9]{64}\/api\/(?:upload|uploads\/[a-zA-Z0-9_-]+|files\/f_[a-f0-9]{64}\/body|messages\/[a-zA-Z0-9_-]+)$/.test(url.pathname)
      && ['GET', 'HEAD', 'POST', 'DELETE'].includes(method);
    const control = url.pathname === '/__next_lab__/files' && method === 'POST';
    if (!bootstrap && !file && !control) throw new Error(`Synthetic lab blocked transport: ${method} ${url.pathname}`);
    return nativeFetch(input instanceof Request ? input : url, { ...init, redirect: 'error' });
  };
}

export function createModuleLab(nativeFetch: typeof fetch, page: string, speech: Speech): ModuleLabControls {
  const request = moduleLabFetch(nativeFetch, page, () => speech.sessionResponse());
  return {
    speech,
    fetch: request,
    async files(hold, fail = false) {
      const response = await request('/__next_lab__/files', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hold, fail }),
      });
      if (!response.ok) throw new Error(`Synthetic file control failed: HTTP ${response.status}`);
    },
    dispose: () => speech.dispose(),
  };
}
