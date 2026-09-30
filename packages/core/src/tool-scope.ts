import { ToolSet, type CopilotSession, type SessionConfig } from '@github/copilot-sdk';
import type { ToolScope } from '@cockpit/protocol';
import { messageOf, settled } from './async.ts';
import type { SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';

type ToolMetadata = Awaited<ReturnType<CopilotSession['rpc']['tools']['getCurrentMetadata']>>['tools'];
type PreToolUseHandler = NonNullable<NonNullable<SessionConfig['hooks']>['onPreToolUse']>;

/** Source-qualified native filters; supported MCP raw names do not need normalization. */
export function nativeToolScope(scope: ToolScope): ToolSet {
  const tools = new ToolSet().addBuiltIn(scope.builtins);
  for (const server of scope.mcpServers) {
    for (const tool of server.tools) tools.addMcp(`${server.name}-${tool}`);
  }
  return tools;
}

export function assertScopeServerIdentities(scope: ToolScope, names: Iterable<string>): void {
  const servers = new Set(names);
  if (scope.mcpServers.some(server => server.tools.length)) {
    for (const name of servers) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`Unsupported MCP namespace for tool scope: ${name}; native name normalization cannot prove exact server identity`);
      }
    }
  }
  for (const server of scope.mcpServers) {
    if (!servers.has(server.name)) throw new Error(`Tool scope MCP server is not configured: ${server.name}`);
    for (const tool of server.tools) {
      const wire = `${server.name}-${tool}`;
      // A shorter server namespace could advertise this wire under a different
      // raw tool name. Reject it even when that server is currently disabled.
      for (const name of servers) {
        if (name !== server.name && wire.startsWith(`${name}-`)) {
          throw new Error(`Conflicting tool scope MCP namespace: ${server.name}/${tool} and ${name}`);
        }
      }
    }
  }
}

export function assertScopeToolMetadata(scope: ToolScope, tools: ToolMetadata): void {
  if (tools === null) throw new Error('Tool scope is unconfirmed: native tool metadata is uninitialized');
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Tool scope is unconfirmed: duplicate native tool identity ${tool.name}`);
    names.add(tool.name);
    if (tool.mcpServerName !== undefined || tool.mcpToolName !== undefined) {
      const server = scope.mcpServers.find(server => server.name === tool.mcpServerName);
      if (!tool.mcpToolName || !server?.tools.includes(tool.mcpToolName)
        || tool.name !== `${tool.mcpServerName}-${tool.mcpToolName}`
        || (tool.namespacedName !== undefined && tool.namespacedName !== `${tool.mcpServerName}/${tool.mcpToolName}`)) {
        throw new Error(`Tool scope violation: native tool ${tool.name} belongs to ${tool.mcpServerName}/${tool.mcpToolName}`);
      }
    } else if (!scope.builtins.includes(tool.name)) {
      throw new Error(`Tool scope violation: undeclared native tool ${tool.name}`);
    }
  }
}

/** Native deny, not a permission prompt or an exception-dependent MCP hook. */
export function toolScopeHook(
  scope: ToolScope, session: () => CopilotSession | undefined, previous?: PreToolUseHandler,
): PreToolUseHandler {
  return async (input, context) => {
    try {
      const sdk = session();
      if (!sdk || sdk.sessionId !== context.sessionId || sdk.sessionId !== input.sessionId) {
        throw new Error('Tool scope invocation session is unconfirmed; scoped subagent tools are unsupported');
      }
      const { tools } = await sdk.rpc.tools.getCurrentMetadata();
      assertScopeToolMetadata(scope, tools);
      if (tools?.filter(tool => tool.name === input.toolName).length !== 1) {
        throw new Error(`Tool scope invocation is not currently offered: ${input.toolName}`);
      }
    } catch (error) {
      return { permissionDecision: 'deny', permissionDecisionReason: messageOf(error) };
    }
    return previous?.(input, context);
  };
}

export async function assertSessionScopeNamespaces(k: SessionKernel, st: SessionHandle, sdk: CopilotSession): Promise<void> {
  if (!st.toolScope) return;
  const [configured, discovered, current] = await k.withSession(st, sdk, () => settled([
    k.runtime.rpc.mcp.config.list(),
    k.runtime.rpc.mcp.discover({ workingDirectory: st.observedCwd ?? undefined }),
    sdk.rpc.mcp.list(),
  ] as const));
  for (const name of Object.keys(st.roleAssembly?.config.mcpServers ?? {})) {
    if (Object.hasOwn(configured.servers, name) || discovered.servers.some(server => server.name === name)) {
      throw new Error(`Role MCP conflicts with native configuration: ${name}`);
    }
  }
  assertScopeServerIdentities(st.toolScope, [
    ...Object.keys(configured.servers), ...discovered.servers.map(server => server.name),
    ...current.servers.map(server => server.name),
  ]);
}
