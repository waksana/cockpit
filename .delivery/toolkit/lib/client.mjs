import { readFile, lstat } from 'node:fs/promises';
export async function connection(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077) throw Error('Credential must be a private regular file');
  const value = JSON.parse(await readFile(path, 'utf8'));
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || typeof value.token !== 'string') throw Error('Expected local authenticated runner credential');
  return value;
}
export async function call(credential, path, body, { timeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw Error('Invalid bounded transport timeout');
  const { url, token } = await connection(credential);
  let response;
  try {
    response = await fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw Error('Runner response unknown; lookup the original request ID. Do not retry or mint another ID.');
  }
  let value;
  try { value = await response.json(); }
  catch { throw Error('Runner response unknown; lookup the original request ID. Do not retry or mint another ID.'); }
  if (!response.ok) throw Object.assign(Error(value.error ?? `Runner HTTP ${response.status}`), { code: value.code });
  return value;
}
