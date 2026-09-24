/** Request `_meta` key the host sets on every tool call to a module HTTP MCP server. */
export const MCP_INVOCATION_META_KEY = 'cockpit/invocation';

/**
 * Host-observed origin of one module MCP tool call. The host takes these values
 * from the native runtime, not from model-provided arguments; it only labels the
 * call and never allows or denies it.
 */
export interface McpInvocationMeta {
  /** Cockpit (native main) session that owns the MCP connection. */
  readonly sessionId: string;
  /** Native runtime session that issued the call; differs from `sessionId` for a subagent. */
  readonly runtimeSessionId: string;
  /** True when the call came from a subagent rather than the session's main agent. */
  readonly subagent: boolean;
  /** Native internal agent name of the subagent (for example `general-purpose`), when observed. */
  readonly agentName?: string;
}
