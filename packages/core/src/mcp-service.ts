import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { CopilotSession } from '@github/copilot-sdk';
import type { McpServerGlobal, McpServerSession, McpToggleOperation, McpToggleResult } from '@cockpit/protocol';
import { CockpitError, SessionUnloadedError, busy } from './errors.ts';
import { messageOf, settled } from './async.ts';
import { describeMcpServer, mcpConnection, redactMcpConfig } from './mcp-config.ts';
import type { ResourceValues, SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';

/** Native global MCP configuration and per-session MCP connections. */
export class McpService {
  private readonly k: SessionKernel;

  constructor(k: SessionKernel) {
    this.k = k;
  }

  private patchMcpPending(st: SessionHandle): void {
    this.k.invalidate(st, ['control', 'mcp']);
  }

  async listGlobalMcp(): Promise<McpServerGlobal[]> {
    const [definitions, discovered] = await this.k.untilFatal(() => settled([
      this.k.runtime.rpc.mcp.config.list(), this.k.runtime.rpc.mcp.discover({ workingDirectory: homedir() }),
    ] as const));
    const byName = new Map(discovered.servers.filter(server => server.source === 'user').map(server => [server.name, server]));
    return Object.entries(definitions.servers).map(([name, config]) => {
      const server = byName.get(name);
      if (!server || typeof server.enabled !== 'boolean') {
        throw new Error(`Native global MCP state is unconfirmed for ${name}`);
      }
      const modules = this.k.roles?.globalMcpSources?.(config);
      return { name, detail: describeMcpServer(config), connection: mcpConnection(config),
        defaultOn: server.enabled, config: redactMcpConfig(config),
        ...(modules?.length ? { modules } : {}) };
    });
  }

  async setMcpDefault(name: string, on: boolean): Promise<void> {
    if (!(await this.listGlobalMcp()).some(server => server.name === name)) throw new CockpitError('MCP_NOT_FOUND', 'Unknown global MCP server');
    await this.k.untilFatal(() => this.k.runtime.rpc.mcp.config[on ? 'enable' : 'disable']({ names: [name] }));
    const server = (await this.listGlobalMcp()).find(server => server.name === name);
    if (!server || server.defaultOn !== on) throw new Error('Native global MCP state did not confirm the requested change');
  }

  async listSessionMcp(id: string): Promise<{ loaded: boolean; servers: McpServerSession[] }> {
    const st = await this.k.state(id);
    if (!st.sdk) { this.k.release(st); return { loaded: false, servers: [] }; }
    try {
      return await this.k.operation(id, async (sdk, st) => {
        const result = await this.k.withSession(st, sdk, () => sdk.rpc.mcp.list());
        const disabled = new Set(result.host?.disabledServers);
        const sources = st.roleAssembly?.mcpSources;
        return { loaded: true, servers: result.servers.map(server => ({
          name: server.name, detail: server.sourcePlugin ?? server.source ?? 'native',
          ...(sources && Object.hasOwn(sources, server.name) ? { module: sources[server.name] } : {}),
          ...this.mcpServerState(result, server.name, server, disabled), error: server.error,
        })) };
      }, 'read');
    } catch (error) {
      if (error instanceof SessionUnloadedError) return { loaded: false, servers: [] };
      throw error;
    }
  }

  mcpServerState(
    result: ResourceValues['mcp'], name: string,
    server: ResourceValues['mcp']['servers'][number] | undefined,
    disabled?: ReadonlySet<string>,
  ): Pick<McpServerSession, 'status' | 'enabled'> {
    if (!server || !result.host) throw new Error(`Native MCP state is unconfirmed for ${name}`);
    const status = server.status;
    switch (status) {
      case 'connected':
      case 'failed':
      case 'needs-auth':
      case 'pending':
      case 'disabled':
      case 'stopped':
      case 'not_configured':
        // Enablement is not connectivity: preserve native status even when the
        // host separately records an explicit disable or policy stops a server.
        return { status, enabled: status !== 'disabled' && status !== 'not_configured'
          && !(disabled ? disabled.has(name) : result.host.disabledServers.includes(name)) };
      default: {
        const unexpected: never = status;
        throw new Error(`Native MCP state is unconfirmed for ${name}: unknown status ${JSON.stringify(unexpected)}`);
      }
    }
  }

  async toggleSessionMcp(id: string, name: string, enabled: boolean): Promise<McpToggleResult> {
    return this.k.operation(id, async (sdk, st) => {
      if (st.mcpOperations) throw busy('MCP mutation is already in progress');
      const operation: McpToggleOperation = { id: randomUUID(), desiredEnabled: enabled,
        state: 'running', startedAt: Date.now(), status: 'pending' };
      st.mcpOperations++;
      this.patchMcpPending(st);
      let applied = false;
      let submitted = false;
      try {
        const before = await this.k.withSession(st, sdk, () => sdk.rpc.mcp.list());
        if (before.host?.pendingConnections.length) throw busy('MCP connections are still settling');
        const previous = before.servers.find(server => server.name === name);
        if (!previous) throw new CockpitError('MCP_NOT_FOUND', `Unknown native MCP server: ${name}`);
        this.mcpServerState(before, name, previous);
        submitted = true;
        await this.k.withSession(st, sdk, () => sdk.rpc.mcp[enabled ? 'enable' : 'disable']({ serverName: name }));
        const result = await this.k.readResource(st, sdk, 'mcp');
        const server = result.servers.find(server => server.name === name);
        const actual = this.mcpServerState(result, name, server);
        operation.status = actual.status;
        applied = actual.enabled === enabled && actual.status !== 'not_configured'
          && (!enabled || actual.status === 'connected');
        if (!applied) throw new Error(server?.error ?? 'Native MCP state did not confirm the requested change');
        operation.state = 'succeeded';
        return { ok: true, applied, sessionId: id, name, enabled, status: operation.status, operation };
      } catch (error) {
        this.k.assertAvailable();
        if (!submitted || st.sdk !== sdk) throw error;
        operation.state = 'failed';
        operation.error = messageOf(error);
        this.k.patch(st, { error: operation.error });
        // Enable may reject while a native connector is still alive. A failed
        // read-back is unknown, not evidence that the connector is disabled.
        let result: Awaited<ReturnType<CopilotSession['rpc']['mcp']['list']>>;
        let actual: Pick<McpServerSession, 'status' | 'enabled'>;
        try {
          result = await this.k.readResource(st, sdk, 'mcp');
          actual = this.mcpServerState(result, name, result.servers.find(server => server.name === name));
        }
        catch (readError) {
          this.k.assertAvailable();
          throw new Error(`${operation.error}; MCP state is unknown: ${messageOf(readError)}`, { cause: readError });
        }
        operation.status = actual.status;
        if (result.host?.pendingConnections.length) operation.state = 'settling';
        return { ok: false, applied, sessionId: id, name,
          enabled: actual.enabled, status: operation.status, error: operation.error, operation };
      } finally {
        operation.completedAt = Date.now();
        st.mcpOperations--;
        this.patchMcpPending(st);
      }
    });
  }

  async refreshMcp(): Promise<void> {
    await this.k.untilFatal(() => this.k.runtime.rpc.mcp.config.reload());
    await this.listGlobalMcp();
  }

  async reloadSessionMcp(id: string): Promise<{ reconnected: number }> {
    const st = await this.k.state(id);
    if (!st.sdk) { this.k.release(st); throw new SessionUnloadedError(); }
    return this.k.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.k.untilFatal(() => this.k.runtime.rpc.mcp.config.reload());
      st.mcpOperations++;
      this.patchMcpPending(st);
      try {
        // Native reload also reapplies global MCP choices; session overrides
        // are intentionally not restored by Cockpit.
        await this.k.withSession(st, sdk, () => sdk.rpc.mcp.reload());
        const result = await this.k.readResource(st, sdk, 'mcp');
        const disabled = new Set(result.host?.disabledServers);
        const failed = result.servers.filter(server => {
          const { status, enabled } = this.mcpServerState(result, server.name, server, disabled);
          return status === 'not_configured' || (enabled && status !== 'connected');
        });
        if (failed.length || result.host?.pendingConnections.length) throw new Error(`MCP connections not confirmed: ${failed.map(server => server.name).join(', ') || 'pending'}`);
        return { reconnected: result.servers.filter(server => server.status === 'connected').length };
      } finally {
        st.mcpOperations--;
        this.patchMcpPending(st);
      }
    });
  }
}
