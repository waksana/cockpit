import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function requestGracefulRestart({
  baseUrl,
  dryRun = false,
  token,
  fetchImpl = fetch,
}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Cockpit URL must be an HTTP(S) backend URL without embedded credentials, query or fragment.');
  }
  const endpoint = dryRun ? '/status' : '/admin/restart';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${base.href.replace(/\/+$/, '')}${endpoint}`, {
    method: dryRun ? 'GET' : 'POST',
    headers,
    ...(dryRun ? {} : { body: JSON.stringify({ pending: true }) }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Cockpit ${endpoint} failed: HTTP ${response.status}. No direct restart attempted.`);
  const result = await response.json();
  if (!result || typeof result.restartPending !== 'boolean' || !Number.isSafeInteger(result.busy) || result.busy < 0) {
    throw new Error('Cockpit returned invalid restart status. No direct restart attempted.');
  }
  if (!dryRun && !result.restartPending) throw new Error('Cockpit did not arm the requested restart.');
  return { restartPending: result.restartPending, busy: result.busy, dryRun };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 2) {
      throw new Error('This helper accepts no command-line options, including --wait. It only requests restart and exits; use DRY_RUN=1 for status.');
    }
    const result = await requestGracefulRestart({
      baseUrl: process.env.COCKPIT_URL ?? `http://127.0.0.1:${process.env.COCKPIT_PORT ?? process.env.PORT ?? '8771'}`,
      dryRun: process.env.DRY_RUN === '1',
      token: process.env.COCKPIT_API_TOKEN,
    });
    console.log(JSON.stringify(result));
    if (!result.dryRun) {
      console.log('Restart armed; the backend will exit when safe. Its supervisor must restart it.');
      console.log('End the calling turn. Do not keep a session-owned background tool waiting for this restart: it remains busy and prevents the restart.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
