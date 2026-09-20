import type { McpServerSession, SessionRole, SkillSession } from '@cockpit/protocol';
import type { createCockpitStore } from '../net/store';
import { installWorkspaceFixture, workspaceSessionId } from './workspace-fixtures';

export function installResourceFixture(store: ReturnType<typeof createCockpitStore>, longNames = false) {
  installWorkspaceFixture(store);
  const module = { id: 'cockpit-task', name: longNames ? 'Original_module-name-with-a-very-long-unbroken-identifier' : 'Task' };
  const roles = [
    { moduleId: module.id, moduleName: module.name, roleId: 'owner', name: 'Owner',
      description: '协调独立任务，分配执行者并关注最新进展。' },
    { moduleId: module.id, moduleName: module.name, roleId: 'executor',
      name: longNames ? 'Original_executor-role-with-a-very-long-unbroken-identifier' : 'Executor',
      description: '完整负责承接的任务，同步要求并报告结果。' },
  ];
  const roleSummary = ({ moduleId, moduleName, roleId, name }: SessionRole): SessionRole =>
    ({ moduleId, moduleName, roleId, name });
  let mcp: McpServerSession[] = [
    { name: 'cockpit-task', module, detail: 'native', enabled: true, status: 'connected' },
    { name: 'module_cockpit-task__unrelated', detail: 'native', enabled: false, status: 'disabled' },
  ];
  let skills: SkillSession[] = [
    { name: 'cockpit-task-owner', module, source: 'custom', enabled: true, description: roles[0].description },
    { name: 'cockpit-task-executor', module, source: 'custom', enabled: true, description: roles[1].description },
    { name: 'cockpit-task-unrelated', source: 'personal-copilot', enabled: false, description: '合成的非模块资源，不应从名称推断来源。' },
  ];
  const find = (id: string) => {
    const session = store.getState().sessions.find(row => row.sessionId === id);
    if (!session) throw new Error(`Unknown synthetic session: ${id}`);
    return session;
  };
  store.setState(state => ({
    sessions: state.sessions.map((session, index) => ({
      ...session, roles: index === 0 ? roles.map(roleSummary) : index === 1 ? [roleSummary(roles[0])] : [],
      ...(index === 0 ? { title: '模块角色与资源（合成）', status: 'idle' as const, nativeProcessing: false, intent: null } : {}),
    })),
    listRoles: async () => roles,
    listDir: async (path = '/workspace') => {
      if (path !== '/workspace' && path !== '/workspace/cockpit') throw new Error(`Unknown synthetic directory: ${path}`);
      return { path, parent: path === '/workspace' ? null : '/workspace',
        entries: path === '/workspace' ? [{ name: 'cockpit', isDir: true }] : [] };
    },
    newSession: async (cwd, selected = []) => {
      if (!['/workspace', '/workspace/cockpit'].includes(cwd)) throw new Error('Unknown synthetic directory');
      const selectedRoles: SessionRole[] = selected.map(selection => {
        const role = roles.find(role => role.moduleId === selection.moduleId && role.roleId === selection.roleId);
        if (!role) throw new Error('Unknown synthetic role');
        return roleSummary(role);
      });
      const sessionId = `synthetic-role-session-${store.getState().sessions.length}`;
      const session = { ...find(workspaceSessionId), sessionId, title: '新建角色会话（合成）', cwd,
        roles: selectedRoles, messages: [], lastActivity: Date.now() };
      store.setState(state => ({ sessions: [session, ...state.sessions] }));
      return sessionId;
    },
    mcpSession: async id => { find(id); return mcp; },
    skillsSession: async id => { find(id); return skills; },
    mcpToggleSession: async (id, name, enabled) => {
      find(id);
      if (!mcp.some(server => server.name === name)) throw new Error('Unknown synthetic MCP server');
      mcp = mcp.map(server => server.name === name ? { ...server, enabled, status: enabled ? 'connected' : 'disabled' } : server);
    },
    skillsToggleSession: async (id, name, enabled) => {
      find(id);
      if (!skills.some(skill => skill.name === name)) throw new Error('Unknown synthetic skill');
      skills = skills.map(skill => skill.name === name ? { ...skill, enabled } : skill);
    },
  }));
}
