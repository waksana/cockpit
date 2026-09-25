import type { ModuleHostIntentMap, SessionMeta } from './wire.ts';

export { MAX_MODULE_EVENT_BYTES, MCP_INVOCATION_META_KEY } from '../runtime.js';
export type * from './wire.ts';
export type * from './manifest.ts';

/** Module-owned JSON data, never a host event envelope or a live resource. */
export type ModuleEventPayload =
  | null | boolean | number | string
  | readonly ModuleEventPayload[]
  | { readonly [key: string]: ModuleEventPayload };

/** Host-observed origin, not model-provided arguments or an authorization decision. */
export interface McpInvocationMeta {
  readonly sessionId: string;
  readonly runtimeSessionId: string;
  readonly subagent: boolean;
  readonly agentName?: string;
}

export type PublicSessionMeta = SessionMeta;
export type ModuleHostIntent = keyof ModuleHostIntentMap;
export type ModuleHostIntentBody<Name extends ModuleHostIntent> = ModuleHostIntentMap[Name]['body'];
export type ModuleHostIntentResult<Name extends ModuleHostIntent> = ModuleHostIntentMap[Name]['result'];
