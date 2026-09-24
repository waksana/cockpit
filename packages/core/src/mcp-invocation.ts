import type { SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { MCP_INVOCATION_META_KEY, type McpInvocationMeta } from '@cockpit/protocol';

type PreMcpToolCallHandler = NonNullable<NonNullable<SessionConfig['hooks']>['onPreMcpToolCall']>;

/** Native subagent instance IDs (the subagent's runtime session ID) mapped to their agent names. */
export class SubagentNames {
  private readonly names = new Map<string, string>();

  observe(event: SessionEvent): void {
    const agentId = (event as { agentId?: unknown }).agentId;
    if (typeof agentId !== 'string' || !agentId) return;
    if (event.type === 'subagent.started') {
      if (typeof event.data.agentName === 'string' && event.data.agentName) this.names.set(agentId, event.data.agentName);
    } else if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      this.names.delete(agentId);
    }
  }

  get(agentId: string): string | undefined {
    return this.names.get(agentId);
  }
}

/**
 * Labels calls to module-registered MCP servers with their native origin under
 * one namespaced `_meta` key, preserving any other request metadata. Other
 * servers keep their request `_meta` untouched.
 */
export function moduleMcpInvocationHook(moduleServers: ReadonlySet<string>, names?: SubagentNames): PreMcpToolCallHandler {
  return (input, invocation) => {
    if (!moduleServers.has(input.serverName)) return undefined;
    const subagent = input.sessionId !== invocation.sessionId;
    const agentName = subagent ? names?.get(input.sessionId) : undefined;
    const meta: McpInvocationMeta = {
      sessionId: invocation.sessionId, runtimeSessionId: input.sessionId, subagent,
      ...(agentName ? { agentName } : {}),
    };
    return { metaToUse: { ...input._meta, [MCP_INVOCATION_META_KEY]: meta } };
  };
}
