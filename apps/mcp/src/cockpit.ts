import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { IntentBody, IntentName, IntentResult } from '@cockpit/protocol';
import { COCKPIT_API_TOKEN, COCKPIT_URL, requestTimeoutMs } from './config.js';

export const MAX_TRANSFER_BYTES = 25 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const INTENT_NAME = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

export class CockpitError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'connection' | 'backend' | 'protocol' = 'backend',
    readonly intentName?: string,
  ) {
    super(message);
    this.name = 'CockpitError';
  }
}

function validateBackendPath(path: string): void {
  const invalid = () => new CockpitError(`Invalid cockpit backend path: ${JSON.stringify(path)}`, 'protocol');
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(path)) {
    throw invalid();
  }
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=%/-]*$/.test(pathname) || pathname.includes('//')) throw invalid();
  try {
    for (const segment of pathname.split('/')) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || /[\\/?#%\u0000-\u001f\u007f]/.test(decoded)) {
        throw invalid();
      }
    }
    // Query values may contain encoded slashes (for example a MIME type), but
    // must not contain malformed escapes, control characters or backslashes.
    if (queryIndex >= 0 && /[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(path.slice(queryIndex + 1)))) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }
}

function requestContext(path: string): { name?: string; label: string } {
  const name = path.startsWith('/intent/') ? path.slice('/intent/'.length).split('?')[0] : undefined;
  return name && INTENT_NAME.test(name)
    ? { name, label: `cockpit intent "${name}"` }
    : { label: `cockpit request "${path}"` };
}

// Unlike fetch, node:http does not implicitly replay HTTP 421 responses.
function requestOnce(
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers: Headers;
    body?: Uint8Array;
    signal: AbortSignal;
    redirect: 'error';
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new CockpitError('COCKPIT_URL must use HTTP or HTTPS', 'protocol');
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(target, {
      method: options.method,
      headers: Object.fromEntries(options.headers),
      signal: options.signal,
      // A fresh connection also avoids stale pooled sockets and their retry semantics.
      agent: false,
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      if (options.redirect === 'error' && [301, 302, 303, 307, 308].includes(status) && incoming.headers.location) {
        incoming.destroy();
        reject(new TypeError('unexpected redirect'));
        return;
      }
      try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming, {
          strategy: {
            highWaterMark: incoming.readableHighWaterMark,
            size: (chunk: Uint8Array) => chunk.byteLength,
          },
        });
        if (body === null) incoming.resume();
        resolve(new Response(body, { status, headers, statusText: incoming.statusMessage }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

// Identity encoding makes the declared and measured lengths refer to the same
// bytes, including when this helper consumes a caller-provided fetch Response.
export async function* streamBoundedBody(
  response: Response,
  maxBytes: number = MAX_TRANSFER_BYTES,
): AsyncGenerator<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new CockpitError('Response byte limit must be a nonnegative safe integer', 'protocol');
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      throw new CockpitError('cockpit response has an unsafe Content-Encoding; expected identity', 'protocol');
    }
    const length = response.headers.get('content-length');
    const declared = length === null ? undefined : Number(length);
    if (declared !== undefined && (
      !/^\d+$/.test(length ?? '') || !Number.isSafeInteger(declared) || declared < 0
    )) {
      throw new CockpitError('cockpit response has an invalid Content-Length', 'protocol');
    }
    if (declared !== undefined && declared > maxBytes) {
      throw new CockpitError(`cockpit response exceeds the ${maxBytes} byte limit`, 'protocol');
    }

    reader = response.body?.getReader();
    let total = 0;
    while (reader) {
      const chunk = await reader.read().catch((error: unknown) => {
        throw new CockpitError(`Cannot read cockpit response body (${errorChain(error)})`, 'connection');
      });
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new CockpitError(`cockpit response exceeds the ${maxBytes} byte limit`, 'protocol');
      }
      if (declared !== undefined && total > declared) {
        throw new CockpitError('cockpit response body does not match Content-Length', 'protocol');
      }
      yield chunk.value;
    }
    if (declared !== undefined && total !== declared) {
      throw new CockpitError('cockpit response body does not match Content-Length', 'protocol');
    }
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response.body && !response.body.locked) {
      await response.body.cancel().catch(() => {});
    }
  }
}

export async function readBoundedBody(
  response: Response,
  maxBytes: number = MAX_TRANSFER_BYTES,
): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  let total = 0;
  for await (const chunk of streamBoundedBody(response, maxBytes)) {
    bytes ??= new Uint8Array(Number(response.headers.get('content-length') ?? maxBytes));
    bytes.set(chunk, total);
    total += chunk.byteLength;
  }
  return bytes?.subarray(0, total) ?? new Uint8Array();
}

export async function backendRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: Uint8Array;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  validateBackendPath(path);
  const { name, label } = requestContext(path);
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs(name ?? path);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new CockpitError('Request timeout must be a positive integer no greater than 2147483647ms', 'protocol', name);
  }
  if (options.body instanceof Uint8Array && options.body.byteLength > MAX_TRANSFER_BYTES) {
    throw new CockpitError(`cockpit request exceeds the ${MAX_TRANSFER_BYTES} byte limit`, 'protocol', name);
  }
  const headers = new Headers(options.headers);
  headers.set('accept-encoding', 'identity');
  if (COCKPIT_API_TOKEN) headers.set('authorization', `Bearer ${COCKPIT_API_TOKEN}`);
  const controller = new AbortController();
  const timeoutError = new CockpitError(
    `${label} timed out after ${timeoutMs}ms waiting for ${COCKPIT_URL}; `
      + 'the backend may still be processing it and no retry was attempted.',
    'timeout',
    name,
  );
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });

  const request = async (): Promise<T> => {
    let response: Response;
    try {
      response = await requestOnce(`${COCKPIT_URL.replace(/\/+$/, '')}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      throw new CockpitError(
        `Cannot connect to the cockpit backend at ${COCKPIT_URL} (${errorChain(error)}). `
          + 'Confirm the cockpit-server process is listening or set COCKPIT_URL / COCKPIT_PORT.',
        'connection',
        name,
      );
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const text = new TextDecoder().decode(await readBoundedBody(response, MAX_ERROR_BYTES));
        let detail = text;
        try {
          const data: unknown = JSON.parse(text);
          if (data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
            detail = data.error;
          }
        } catch {
          // A non-JSON error page is still a backend failure, not a JSON protocol error.
        }
        if (detail.trim()) message += `: ${detail.slice(0, 1024)}`;
      } catch (error) {
        if (!(error instanceof CockpitError) || error.kind !== 'protocol') throw error;
        message += `: ${error.message}`;
      }
      throw new CockpitError(`${label} failed: ${message}`, 'backend', name);
    }
    // Only network/body-read errors are translated; decoding errors retain identity.
    return consume(response);
  };

  try {
    return await Promise.race([request(), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (error instanceof CockpitError && name && error.intentName === undefined) {
      throw new CockpitError(error.message, error.kind, name);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function backendJson<T = unknown>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  return backendRequest(path, {
    method: options.method,
    body: options.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(options.body)),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    timeoutMs: options.timeoutMs,
  }, async (response) => {
    const text = new TextDecoder().decode(await readBoundedBody(response));
    try {
      return JSON.parse(text) as T;
    } catch {
      const { name, label } = requestContext(path);
      throw new CockpitError(`${label} returned invalid JSON (HTTP ${response.status})`, 'protocol', name);
    }
  });
}

export async function intent<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  if (!INTENT_NAME.test(name)) {
    throw new CockpitError(`Invalid cockpit intent name: ${JSON.stringify(name)}`, 'protocol', name);
  }
  return backendJson<T>(`/intent/${name}`, {
    method: 'POST',
    body,
    timeoutMs: options.timeoutMs ?? requestTimeoutMs(name),
  });
}

export function assertIntentSuccess<T>(result: T, name: string): T {
  if (result !== null && typeof result === 'object' && 'ok' in result && result.ok === false) {
    throw new CockpitError(`cockpit intent "${name}" did not succeed: ${JSON.stringify(result)}`, 'backend', name);
  }
  return result;
}

export async function protocolIntent<K extends IntentName>(
  name: K,
  ...args: {} extends IntentBody<K> ? [body?: IntentBody<K>] : [body: IntentBody<K>]
): Promise<IntentResult<K>> {
  return assertIntentSuccess(await intent<IntentResult<K>>(name, args[0]), name);
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ') || 'unknown connection error';
}
