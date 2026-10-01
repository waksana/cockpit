import { AsyncLocalStorage } from 'node:async_hooks';
import type { PromptAccepted } from '@cockpit/protocol';

export const promptOrigin = new AsyncLocalStorage<PromptAccepted['origin']>();

/** The normal browser ingress, within the Host's existing same-origin/same-user trust boundary. */
export function browserPromptOrigin(headers: Record<string, string | string[] | undefined>, allowed: boolean): PromptAccepted['origin'] {
  return allowed && typeof headers.origin === 'string' && headers['sec-fetch-site'] === 'same-origin' ? 'user' : 'api';
}
