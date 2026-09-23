import type { McpServerGlobal, McpServerSession, SessionRole, SkillGlobal, SkillSession } from '@cockpit/protocol';
import { SKILL_NOT_FOUND } from '@cockpit/protocol';
import { IntentHttpError } from '../net/client';
import type { createCockpitStore } from '../net/store';
import { cockpitApi, type CockpitApi } from '../net/api';
import { installWorkspaceFixture, workspaceSessionId } from './workspace-fixtures';

export interface ResourceFixtureOptions {
  empty?: boolean;
  fail?: boolean;
  failMutations?: boolean;
  designCases?: boolean;
  beforeRequest?: () => Promise<void>;
}

export function installResourceFixture(store: ReturnType<typeof createCockpitStore>, longNames = false, options: ResourceFixtureOptions = {}) {
  installWorkspaceFixture(store);
  const workspace = store.getState();
  const workspaceApi = { ...cockpitApi };
  const request = async () => {
    await options.beforeRequest?.();
    if (options.fail) throw new Error('Synthetic resource failure; no backend request was sent.');
  };
  const mutation = async () => {
    await request();
    if (options.failMutations) throw new Error('Synthetic mutation failure; no backend request was sent.');
  };
  const module = { id: 'cockpit-task', name: longNames ? 'Original_module-name-with-a-very-long-unbroken-identifier' : 'Task' };
  const roles = [
    { moduleId: module.id, moduleName: module.name, roleId: 'owner', name: 'Owner',
      description: '协调独立任务，分配执行者并关注最新进展。' },
    { moduleId: module.id, moduleName: module.name, roleId: 'executor',
      name: longNames ? 'Original_executor-role-with-a-very-long-unbroken-identifier' : 'Executor',
      description: '完整负责承接的任务，同步要求并报告结果。' },
  ];
  const additionalRole = { moduleId: 'fixture-notes', moduleName: 'Notes', roleId: 'reviewer',
    name: 'Reviewer', description: '合成追加角色：保留原有会话 ID、历史和工作目录。' };
  const catalog = [...roles, additionalRole];
  if (longNames) {
    for (const role of catalog) role.description += ' LongUnbrokenRoleDescriptionForWrapping'.repeat(6);
  }
  const roleSummary = ({ moduleId, moduleName, roleId, name }: SessionRole): SessionRole =>
    ({ moduleId, moduleName, roleId, name });
  const source = (contributors: typeof roles) => ({ ...module,
    roles: contributors.map(role => ({ id: role.roleId, name: role.name })).sort((a, b) => a.id.localeCompare(b.id)) });
  let mcp: McpServerSession[] = [
    { name: 'cockpit-task', module: source(roles), detail: 'native', enabled: true, status: 'connected' },
    { name: 'module_cockpit-task__unrelated', detail: 'native', enabled: false, status: 'disabled' },
    { name: 'module-only', module, detail: 'native', enabled: false, status: 'disabled' },
  ];
  let skills: SkillSession[] = [
    { name: 'cockpit-task-owner', module: source([roles[0]]), source: 'custom', enabled: true, description: roles[0].description },
    { name: 'cockpit-task-executor', module: source([roles[1]]), source: 'custom', enabled: true, description: roles[1].description },
    { name: 'cockpit-task-unrelated', source: 'personal-copilot', enabled: false, description: '合成的非模块资源，不应从名称推断来源。' },
    { name: 'shared-skill', module: source(roles), source: 'custom', enabled: true },
    { name: 'module-only-skill', module, source: 'custom', enabled: false },
  ];
  // Explicit synthetic catalog attribution is presentation evidence only.
  let globalMcp: McpServerGlobal[] = mcp.map(({ name, detail, enabled, module }) => ({
    name, detail, defaultOn: enabled, modules: module ? [module] : undefined,
    connection: { method: 'stdio', target: 'synthetic-command' },
    config: { command: 'synthetic-command', args: ['fixture-only'], env: { TOKEN: '[REDACTED]' } },
  }));
  let globalSkills: SkillGlobal[] = skills.map(({ name, source, description, enabled, module }) => ({
    name, source, description, enabled, userInvocable: true, modules: module ? [module] : undefined,
  }));
  globalSkills.push({ name: 'unknown-default', source: 'personal-copilot', description: 'Synthetic unavailable global enabled state.' });
  if (options.designCases) {
    const stack = '\n    at synthetic.connect (fixture:42)'.repeat(12);
    mcp.push(
      { name: 'refused-connection', detail: 'builtin', enabled: true, status: 'failed',
        error: `Connection refused by synthetic host${stack}` },
      { name: 'authentication-required', detail: 'native', enabled: true, status: 'needs-auth' },
      { name: 'stopped-connection', detail: 'builtin', enabled: true, status: 'stopped' },
      { name: 'unconfigured', detail: 'native', enabled: false, status: 'not_configured' },
    );
    globalMcp.push(
      { name: 'http-long-endpoint', detail: 'https://fixture.example/a/long/endpoint?token=[REDACTED]',
        defaultOn: true, connection: { method: 'http', target: 'fixture.example' },
        config: { type: 'http', url: `https://fixture.example/${'long-path/'.repeat(15)}?token=[REDACTED]`,
          headers: { Authorization: '[REDACTED]' } } },
      { name: 'local-long-command', detail: '/synthetic/long/path/node fixture arguments', defaultOn: false,
        connection: { method: 'stdio', target: 'node' },
        config: { command: '/synthetic/long/path/node', args: ['--token', '[REDACTED]', 'long-argument'.repeat(20)] } },
      { name: 'sse-endpoint', detail: 'https://fixture.example/sse', defaultOn: true,
        connection: { method: 'sse', target: 'fixture.example' }, config: { type: 'sse', url: 'https://fixture.example/sse' } },
      { name: 'custom-transport', detail: 'custom', defaultOn: false, connection: { method: 'unknown' },
        config: { type: 'custom', url: 'https://not-http.example/native' } },
      { name: 'missing-config', detail: 'builtin', defaultOn: false },
    );
    for (const source of ['native', 'builtin', 'custom', 'personal-copilot', 'personal-agents', 'project', 'inherited', 'plugin']) {
      const row = { name: `source-${source}`, source, enabled: true };
      skills.push(row);
      globalSkills.push(row);
    }
  }
  if (options.empty) { mcp = []; skills = []; globalMcp = []; globalSkills = []; }
  const find = (id: string) => {
    const session = store.getState().sessions.find(row => row.sessionId === id);
    if (!session) throw new Error(`Unknown synthetic session: ${id}`);
    return session;
  };
  store.setState(state => ({
    sessions: state.sessions.map((session, index) => ({
      ...session, roles: index === 0 ? roles.map(roleSummary) : index === 1 ? [roleSummary(roles[0])] : [],
      appliedRoles: session.loaded ? index === 0 ? roles.map(roleSummary) : index === 1 ? [roleSummary(roles[0])] : [] : [],
      rolesNeedReload: false,
      ...(index === 0 ? { title: '模块角色与资源（合成）', status: 'idle' as const, nativeProcessing: false, intent: null } : {}),
    })),
    getResources: async (id, resources, signal) => { await request(); return workspace.getResources(id, resources, signal); },
    refreshRoles: async id => {
      await request();
      const session = find(id);
      return { sessionId: id, roles: session.roles, appliedRoles: session.appliedRoles,
        rolesNeedReload: session.rolesNeedReload, loaded: session.loaded };
    },
    newSession: async (cwd, selected = []) => {
      await request();
      if (!['/workspace', '/workspace/cockpit'].includes(cwd)) throw new Error('Unknown synthetic directory');
      const selectedRoles: SessionRole[] = selected.map(selection => {
        const role = catalog.find(role => role.moduleId === selection.moduleId && role.roleId === selection.roleId);
        if (!role) throw new Error('Unknown synthetic role');
        return roleSummary(role);
      });
      const sessionId = `synthetic-role-session-${store.getState().sessions.length}`;
      const session = { ...find(workspaceSessionId), sessionId, title: '新建角色会话（合成）', cwd,
        roles: selectedRoles, appliedRoles: selectedRoles, rolesNeedReload: false, loaded: true,
        messages: [], lastActivity: Date.now() };
      store.setState(state => ({ sessions: [session, ...state.sessions] }));
      return sessionId;
    },
    mcpSession: async id => { await request(); find(id); return mcp; },
    skillsSession: async id => { await request(); find(id); return skills; },
    mcpToggleSession: async (id, name, enabled) => {
      await mutation();
      find(id);
      if (!mcp.some(server => server.name === name)) throw new Error('Unknown synthetic MCP server');
      mcp = mcp.map(server => server.name === name ? { ...server, enabled, status: enabled ? 'connected' : 'disabled' } : server);
    },
    skillsToggleSession: async (id, name, enabled) => {
      await mutation();
      find(id);
      if (!skills.some(skill => skill.name === name)) throw new Error('Unknown synthetic skill');
      skills = skills.map(skill => skill.name === name ? { ...skill, enabled } : skill);
    },
  }));
  Object.assign(cockpitApi, {
    setModel: async (id, model, settings) => { await request(); return workspaceApi.setModel(id, model, settings); },
    listRoles: async () => { await request(); return options.empty ? [] : catalog; },
    roleReadiness: async id => {
      const session = find(id);
      return { sessionId: id, roles: session.roles ?? [], appliedRoles: session.appliedRoles ?? [],
        rolesNeedReload: session.rolesNeedReload, loaded: session.loaded,
        ready: session.loaded && !session.rolesNeedReload,
        reasons: !session.loaded ? ['Synthetic session is unloaded'] : session.rolesNeedReload ? ['Saved roles need reload'] : [] };
    },
    addRoles: async (id, selected) => {
      await request();
      const original = find(id);
      if (original.loading || original.closing) throw new Error('Synthetic session is transitioning');
      const added = selected.map(selection => {
        const role = catalog.find(role => role.moduleId === selection.moduleId && role.roleId === selection.roleId);
        if (!role) throw new Error('Unknown synthetic role');
        return roleSummary(role);
      });
      const combined = [...original.roles ?? []];
      for (const role of added) {
        if (!combined.some(saved => saved.moduleId === role.moduleId && saved.roleId === role.roleId)) combined.push(role);
      }
      const appliedRoles = original.appliedRoles ?? [];
      const rolesNeedReload = original.loaded && (combined.length !== appliedRoles.length
        || combined.some(role => !appliedRoles.some(applied => role.moduleId === applied.moduleId && role.roleId === applied.roleId)));
      store.setState(state => ({ sessions: state.sessions.map(session => session.sessionId === id
        ? { ...session, roles: combined, rolesNeedReload } : session) }));
      return { sessionId: id, status: combined.length === (original.roles?.length ?? 0) ? 'unchanged' : 'saved',
        roles: combined, appliedRoles, loaded: original.loaded, rolesNeedReload };
    },
    listDir: async (path = '/workspace') => {
      await request();
      if (path !== '/workspace' && path !== '/workspace/cockpit') throw new Error(`Unknown synthetic directory: ${path}`);
      return { path, parent: path === '/workspace' ? null : '/workspace',
        entries: path === '/workspace' ? [{ name: 'cockpit', isDir: true }] : [] };
    },
    mcpGlobal: async () => { await request(); return globalMcp; },
    mcpRefresh: async () => { await request(); },
    mcpSetDefault: async (name, defaultOn) => {
      await mutation();
      if (!globalMcp.some(row => row.name === name)) throw new Error('Unknown synthetic global MCP');
      globalMcp = globalMcp.map(row => row.name === name ? { ...row, defaultOn } : row);
    },
    skillsGlobal: async () => { await request(); return globalSkills; },
    skillsRead: async name => {
      await request();
      const row = globalSkills.find(row => row.name === name);
      if (!row) throw new IntentHttpError('Unknown synthetic global skill', 404, SKILL_NOT_FOUND);
      const frontmatter = `---\nname: ${row.name}\ndescription: ${row.description ?? ''}\n---\n`;
      return { ...row, body: `${frontmatter}# ${row.name}\n\nSynthetic skill body, not an installed skill.\n\n---\n\n${'Long content remains readable. '.repeat(60)}` };
    },
    skillsSetGlobal: async (name, enabled) => {
      await mutation();
      if (!globalSkills.some(row => row.name === name)) throw new Error('Unknown synthetic global skill');
      globalSkills = globalSkills.map(row => row.name === name ? { ...row, enabled } : row);
    },
  } satisfies Partial<CockpitApi>);
}
