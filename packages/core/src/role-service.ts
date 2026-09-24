import type { RoleAdditionResult, RoleReadiness, RoleSelection, SessionRole } from '@cockpit/protocol';
import { CockpitError, invalid, transition, unavailable } from './errors.ts';
import { messageOf, settled } from './async.ts';
import type { SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';

/** Saved module-role selection, its comparison with the applied handle assembly and readiness checks. */
export class RoleService {
  private readonly k: SessionKernel;
  private readonly roleWrites = new Map<string, Promise<void>>();

  constructor(k: SessionKernel) {
    this.k = k;
  }

  listRoles() { return this.k.roles?.list() ?? []; }

  async listRoleResources() { return await this.k.roles?.resources?.() ?? []; }

  async readRoleSkill(moduleId: string, resourceId: string) {
    if (!this.k.roles?.readSkill) throw unavailable('Module role Skills are unavailable');
    return await this.k.roles.readSkill(moduleId, resourceId);
  }

  async savedRoles(id: string): Promise<SessionRole[]> {
    return await this.k.roles?.read(id) ?? [];
  }

  roleState(st: SessionHandle | undefined, roles: SessionRole[]) {
    const appliedRoles = st?.sdk ? st.roleAssembly?.roles ?? [] : [];
    const rolesNeedReload = !!st?.sdk && (roles.length !== appliedRoles.length
      || roles.some(role => !appliedRoles.some(applied =>
        applied.moduleId === role.moduleId && applied.roleId === role.roleId)));
    return { roles, appliedRoles, rolesNeedReload };
  }

  async roleReadiness(id: string, requested?: RoleSelection[]): Promise<RoleReadiness> {
    let roles = await this.savedRoles(id);
    const st = this.k.sessions.get(id);
    const result: RoleReadiness = { sessionId: id, roles, appliedRoles: [], rolesNeedReload: false, loaded: false, ready: false, reasons: [] };
    try {
      if (!await this.k.untilFatal(() => this.k.runtime.getSessionMetadata(id)) && !st?.sdk) {
        result.reasons.push('Session does not exist'); return result;
      }
      const sdk = st && await this.k.liveSession(st);
      result.loaded = !!sdk;
      roles = await this.savedRoles(id);
      Object.assign(result, this.roleState(st, roles));
      if (!sdk || !st) { result.reasons.push('Session is unloaded'); return result; }
      if (st.closing || st.load) { result.reasons.push('Session is loading or closing'); return result; }
      if (result.rolesNeedReload) {
        result.reasons.push('Saved roles differ from this native handle; explicitly reload when idle to apply them');
        return result;
      }
      const selected = requested ?? roles;
      if (!selected.length) result.reasons.push('No roles selected');
      for (const role of selected) {
        if (!roles.some(value => value.moduleId === role.moduleId && value.roleId === role.roleId)) {
          result.reasons.push(`Role not selected: ${role.moduleId}/${role.roleId}`);
        }
      }
      const applied = st.roleAssembly;
      if (!this.k.roles || !applied) result.reasons.push('Role assembly was not applied to this native handle');
      if (result.reasons.length) return result;
      const assembly = await this.k.roles!.assemble(id, roles);
      if (assembly.fingerprint !== applied!.fingerprint) result.reasons.push('Current role resources differ from this native handle');
      const required = await this.k.roles!.assemble(id, selected);
      const [skills, mcp, tools] = await this.k.withSession(st, sdk, () => settled([
        sdk.rpc.skills.list(), sdk.rpc.mcp.list(), sdk.rpc.tools.getCurrentMetadata(),
      ] as const));
      if (tools.tools === null) {
        result.reasons.push('Native tool metadata is uninitialized; explicitly call session/tools-initialize when idle, then check readiness again');
      }
      for (const skill of required.skills) {
        const expected = applied!.skills.find(value => value.path === skill.path);
        if (!skills.skills.some(value => value.name === expected?.name && value.enabled && value.path === skill.path)) {
          result.reasons.push(`Role skill is unavailable or disabled: ${expected?.name ?? skill.name}`);
        }
      }
      for (const [name, config] of Object.entries(required.config.mcpServers ?? {})) {
        const server = mcp.servers.find(value => value.name === name);
        if (!server || server.status !== 'connected' || !mcp.host?.mcp3pEnabled
          || mcp.host.disabledServers.includes(name) || mcp.host.filteredServers.includes(name)) {
          result.reasons.push(`Role MCP is not connected: ${name}`);
        }
        if (tools.tools === null) continue;
        const offered = tools.tools.filter(tool => tool.mcpServerName === name);
        for (const tool of config.tools ?? []) {
          if (tool === '*' ? !offered.length : !offered.some(value => value.mcpToolName === tool)) {
            result.reasons.push(`Role MCP tool is not currently offered: ${name}/${tool}`);
          }
        }
      }
      const current = await this.k.liveSession(st);
      result.loaded = !!current;
      Object.assign(result, this.roleState(st, await this.savedRoles(id)));
      if (result.rolesNeedReload) result.reasons.push('Saved roles changed during readiness; reload is required');
      if (current !== sdk || st.closing || st.roleAssembly !== applied) {
        result.reasons.push('Native session changed or is closing');
      }
    } catch (error) {
      result.loaded = !!st?.sdk;
      Object.assign(result, this.roleState(st, roles));
      result.reasons.push(`Readiness unconfirmed: ${messageOf(error)}`);
    }
    result.ready = result.reasons.length === 0;
    return result;
  }

  // Serialize each session's read/union/write so concurrent additions cannot drop one another.
  async addRoles(id: string, additions: RoleSelection[]): Promise<RoleAdditionResult> {
    const previous = this.roleWrites.get(id) ?? Promise.resolve();
    const run = previous.then(() => this.saveRoleAdditions(id, additions));
    const tail = run.then(() => {}, () => {});
    this.roleWrites.set(id, tail);
    try { return await run; }
    finally { if (this.roleWrites.get(id) === tail) this.roleWrites.delete(id); }
  }

  private async saveRoleAdditions(id: string, additions: RoleSelection[]): Promise<RoleAdditionResult> {
    if (!this.k.roles) throw unavailable('Module roles are unavailable');
    if (!additions.length) throw invalid('At least one additional role is required');
    const st = await this.k.state(id);
    this.k.assertAdmission(st);
    if (st.load) throw transition('Session is loading; save roles after the lifecycle transition completes');
    try {
      let selected = await this.k.roles.read(id);
      const catalog = this.k.roles.list();
      const combined = new Map(selected.map(role => [`${role.moduleId}/${role.roleId}`, role]));
      for (const addition of additions) {
        const role = catalog.find(value => value.moduleId === addition.moduleId && value.roleId === addition.roleId);
        if (!role) throw new CockpitError('ROLE_NOT_FOUND', `Unknown module role: ${addition.moduleId}/${addition.roleId}`);
        combined.set(`${role.moduleId}/${role.roleId}`, {
          moduleId: role.moduleId, roleId: role.roleId, moduleName: role.moduleName, name: role.name,
        });
      }
      if (combined.size > 64) throw invalid('A session can select at most 64 roles');
      if (combined.size === selected.length) {
        return { sessionId: id, status: 'unchanged', loaded: !!st.sdk, ...this.roleState(st, selected) };
      }
      try {
        this.k.roles.save(id, [...combined.values()]);
        selected = await this.k.roles.read(id);
        if (selected.length !== combined.size || selected.some(role => !combined.has(`${role.moduleId}/${role.roleId}`))) {
          throw new Error('Saved role selection did not confirm the requested additions');
        }
      } catch (error) {
        this.k.invalidate(st, ['identity']);
        try { selected = await this.k.roles.read(id); }
        catch (readError) {
          throw new AggregateError([error, readError],
            'Role persistence outcome and saved selection are unconfirmed; inspect session/get before explicitly retrying. No reload, rollback or retry was performed.',
            { cause: readError });
        }
        return { sessionId: id, status: 'uncertain', loaded: !!st.sdk, ...this.roleState(st, selected),
          error: messageOf(error),
          recovery: 'Inspect session/get for saved roles before explicitly retrying. No reload, rollback or retry was performed.' };
      }
      const fields = this.roleState(st, selected);
      this.k.patch(st, fields);
      this.k.invalidate(st, ['identity']);
      return { sessionId: id, status: 'saved', loaded: !!st.sdk, ...fields };
    } finally {
      this.k.release(st);
    }
  }
}
