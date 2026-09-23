import type { CopilotSession } from '@github/copilot-sdk';
import type { ResourcePreparationResult } from '@cockpit/protocol';
import { RESOURCE_PREPARATION_ERROR_LIMIT, SessionResourcesPrepare } from '@cockpit/protocol';
import { SessionUnloadedError, conflict } from './errors.ts';
import { messageOf } from './async.ts';
import type { ResourceValues, SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';
import type { RoleService } from './role-service.ts';
import type { McpService } from './mcp-service.ts';

/** Explicit tool initialization and selected skill/MCP preparation on a loaded idle handle. */
export class ResourcePreparation {
  private readonly k: SessionKernel;
  private readonly roleService: RoleService;
  private readonly mcp: McpService;

  constructor(k: SessionKernel, roleService: RoleService, mcp: McpService) {
    this.k = k;
    this.roleService = roleService;
    this.mcp = mcp;
  }

  async initializeSessionTools(id: string): Promise<void> {
    const st = await this.k.state(id);
    if (!st.sdk) { this.k.release(st); throw new SessionUnloadedError(); }
    await this.k.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.initializeTools(st, sdk);
    });
  }

  private async initializeTools(st: SessionHandle, sdk: CopilotSession) {
    await this.k.withSession(st, sdk, () => sdk.rpc.tools.initializeAndValidate());
    // Configuration changes can invalidate the native table without removing tools.
    const metadata = await this.k.withSession(st, sdk, () => sdk.rpc.tools.getCurrentMetadata());
    if (!Array.isArray(metadata.tools)) throw new Error('Native tool initialization is unconfirmed; metadata is unavailable');
    return metadata.tools;
  }

  async prepareSessionResources(input: SessionResourcesPrepare): Promise<ResourcePreparationResult> {
    const selection = SessionResourcesPrepare.parse(input);
    const errorMessage = (error: unknown) => {
      const message = messageOf(error);
      const suffix = '... [truncated]';
      return message.length > RESOURCE_PREPARATION_ERROR_LIMIT
        ? message.slice(0, RESOURCE_PREPARATION_ERROR_LIMIT - suffix.length) + suffix : message;
    };
    const st = await this.k.state(selection.sessionId);
    if (!st.sdk) { this.k.release(st); throw new SessionUnloadedError(); }
    const result: ResourcePreparationResult = {
      sessionId: selection.sessionId, ok: false,
      skills: (selection.skills ?? []).map(name => ({ name, effect: 'not_attempted', enabled: null })),
      mcpServers: (selection.mcpServers ?? []).map(({ name }) =>
        ({ name, effect: 'not_attempted', enabled: null, status: null, tools: null })),
      tools: 'not_attempted',
    };
    let entered = false;
    try {
      return await this.k.transition(st, async () => {
        entered = true;
        const sdk = st.sdk;
        try {
          if (!sdk) throw new SessionUnloadedError();
          const roleState = this.roleService.roleState(st, await this.roleService.savedRoles(st.id));
          if (roleState.rolesNeedReload) {
            throw conflict('Saved roles differ from this native handle; explicitly reload when idle before resource preparation');
          }
          const applied = st.roleAssembly;
          if (roleState.roles.length || applied) {
            const provider = this.k.roles;
            if (!provider || !applied) throw new Error('Current role assembly is unconfirmed for resource preparation');
            const current = await this.k.withSession(st, sdk, () => provider.assemble(st.id, roleState.roles));
            if (current.fingerprint !== applied.fingerprint) {
              throw conflict('Current role resources differ from this native handle; resource preparation was not attempted');
            }
            if (this.roleService.roleState(st, await this.roleService.savedRoles(st.id)).rolesNeedReload || st.roleAssembly !== applied) {
              throw conflict('Roles changed during resource preparation preflight');
            }
          }
          const readSkills = () => this.k.withSession(st, sdk, () => sdk.rpc.skills.list());
          const readMcp = () => this.k.withSession(st, sdk, () => sdk.rpc.mcp.list());
          const observeSkill = (value: Awaited<ReturnType<typeof readSkills>>, item: ResourcePreparationResult['skills'][number]) => {
            const matches = value.skills.filter(skill => skill.name === item.name);
            if (matches.length !== 1 || typeof matches[0]!.enabled !== 'boolean') {
              throw new Error(`Native skill is unknown or unconfirmed: ${item.name}`);
            }
            item.enabled = matches[0]!.enabled;
          };
          const observeMcp = (value: ResourceValues['mcp'], item: ResourcePreparationResult['mcpServers'][number]) => {
            const matches = value.servers.filter(server => server.name === item.name);
            if (matches.length !== 1) throw new Error(`Native MCP is unknown or unconfirmed: ${item.name}`);
            Object.assign(item, this.mcp.mcpServerState(value, item.name, matches[0]));
            if (typeof value.host?.mcp3pEnabled !== 'boolean'
              || !Array.isArray(value.host.disabledServers) || !Array.isArray(value.host.filteredServers)) {
              throw new Error(`Native MCP host state is unconfirmed: ${item.name}`);
            }
          };
          const requireMcp = (value: ResourceValues['mcp'], item: ResourcePreparationResult['mcpServers'][number], preflight = false) => {
            if (!value.host!.mcp3pEnabled || value.host!.filteredServers.includes(item.name)) {
              throw new Error(`Native MCP is disabled by host policy or filtered: ${item.name}`);
            }
            if (item.status !== 'connected' && !(preflight && item.status === 'disabled')) {
              throw new Error(`Native MCP is ${item.status}: ${item.name}`);
            }
            if (!preflight && item.enabled !== true) throw new Error(`Native MCP enablement is unconfirmed: ${item.name}`);
          };

          // Resolve every selected identity and policy before the first mutation.
          if (result.skills.length) {
            const value = await readSkills();
            for (const item of result.skills) {
              observeSkill(value, item);
              if (item.enabled) item.effect = 'unchanged';
            }
          }
          if (result.mcpServers.length) {
            const value = await readMcp();
            for (const item of result.mcpServers) {
              observeMcp(value, item);
              if (item.enabled) item.effect = 'unchanged';
            }
            for (const item of result.mcpServers) requireMcp(value, item, true);
          }
          for (const item of result.skills) {
            if (item.enabled) continue;
            item.effect = 'unconfirmed'; item.enabled = null;
            await this.k.withSession(st, sdk, () => sdk.rpc.skills.enable({ name: item.name }));
            observeSkill(await readSkills(), item);
            if (!item.enabled) throw new Error(`Native skill enablement is unconfirmed: ${item.name}`);
            item.effect = 'enabled';
          }
          for (const item of result.mcpServers) {
            if (item.enabled) continue;
            item.effect = 'unconfirmed'; item.enabled = null; item.status = null;
            try {
              await this.k.withSession(st, sdk, () => sdk.rpc.mcp.enable({ serverName: item.name }));
            } catch (error) {
              // A rejected enable can leave a live connector. Observe once, never retry it.
              try {
                observeMcp(await readMcp(), item);
                if (item.enabled) item.effect = 'enabled';
              } catch (readError) {
                throw new Error(`${messageOf(error)}; MCP readback unconfirmed: ${messageOf(readError)}`, { cause: readError });
              }
              throw error;
            }
            const value = await readMcp();
            observeMcp(value, item);
            if (item.enabled) item.effect = 'enabled';
            requireMcp(value, item);
          }
          result.tools = 'unconfirmed';
          const metadata = await this.k.withSession(st, sdk, () => sdk.rpc.tools.getCurrentMetadata());
          // MCP enable can retain a non-null stale table; a confirmed change needs one rebuild too.
          const initialize = metadata.tools === null || result.skills.some(item => item.effect === 'enabled')
            || result.mcpServers.some(item => item.effect === 'enabled');
          const tools = initialize ? await this.initializeTools(st, sdk) : metadata.tools;
          if (!Array.isArray(tools)) throw new Error('Native tool metadata is unconfirmed');
          result.tools = initialize ? 'initialized' : 'unchanged';
          for (const [index, item] of result.mcpServers.entries()) {
            const requested = selection.mcpServers![index]!.tools;
            const offered = new Set<string>();
            for (const tool of tools.filter(tool => tool.mcpServerName === item.name)) {
              const name = tool.mcpToolName;
              if (typeof name !== 'string' || !name.trim() || name.length > 200) {
                throw new Error(`Native MCP tool identity is unconfirmed: ${item.name}`);
              }
              offered.add(name);
            }
            item.tools = requested?.length ? requested.filter(name => offered.has(name)) : [...offered].slice(0, 1);
          }
          if (result.skills.length) {
            const value = await readSkills();
            for (const item of result.skills) {
              observeSkill(value, item);
              if (!item.enabled) throw new Error(`Native skill is no longer enabled: ${item.name}`);
            }
          }
          if (result.mcpServers.length) {
            const value = await readMcp();
            for (const item of result.mcpServers) observeMcp(value, item);
            for (const [index, item] of result.mcpServers.entries()) {
              requireMcp(value, item);
              const requested = selection.mcpServers![index]!.tools;
              if (!item.tools?.length || (requested?.length && item.tools.length !== requested.length)) {
                throw new Error(`Selected native MCP tools are not currently offered: ${item.name}`);
              }
            }
          }
          result.ok = true;
        } catch (error) {
          result.error = errorMessage(error);
          this.k.patch(st, { error: result.error });
        } finally {
          this.k.invalidate(st, ['skills', 'mcp', 'usage']);
        }
        return result;
      });
    } catch (error) {
      if (!entered) throw error;
      result.ok = false;
      result.error = errorMessage(error);
      return result;
    }
  }
}
