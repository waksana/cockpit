import type { McpConnection, ModuleRoleResources, ModuleSkillSource, ModuleSource } from '@cockpit/protocol';

export function mcpConnectionLabel(connection?: McpConnection): string {
  if (!connection || connection.method === 'unknown') return '未知方式';
  const method = { http: 'HTTP', sse: 'SSE', stdio: '本地进程' }[connection.method];
  return connection.target ? `${method} · ${connection.target}` : method;
}

// Only metadata is translated; resource names, descriptions and bodies stay literal.
export function skillSourceLabel(source?: string): string | undefined {
  switch (source) {
    case 'personal-copilot':
    case 'personal-agents': return '个人';
    case 'project': return '项目';
    case 'inherited': return '上级目录';
    case 'plugin': return '插件';
    default: return undefined;
  }
}

// Skill rows summarize provenance and description in one line.
export function skillSummary(source?: string, description?: string): string | undefined {
  return [skillSourceLabel(source), description].filter(Boolean).join(' · ') || undefined;
}

export function resourceErrorSummary(error: string): string {
  const firstLine = error.trim().split(/\r?\n/, 1)[0];
  const characters = [...firstLine];
  return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : firstLine;
}

export interface ModuleProvidedRow {
  key: string;
  resourceId?: string;
  name: string;
  summary?: string;
  module: ModuleSource;
}

// Module role resources for a global page. The badge names contributing roles
// unless every role of the module declares the resource. Rows already present
// in native global configuration with the same verified module stay there only.
export function moduleProvidedRows(modules: ModuleRoleResources[], kind: 'mcp' | 'skills',
  native: ReadonlyArray<{ name: string; modules?: ModuleSkillSource[] }> = []): ModuleProvidedRow[] {
  return modules.flatMap(module => {
    const resources: Array<{ id?: string; name: string; roles: string[]; summary?: string }> = kind === 'mcp'
      ? module.mcpServers.map(server => ({ ...server,
        summary: server.tools.includes('*') ? '全部工具' : `工具：${server.tools.join('、')}` }))
      : module.skills.map(skill => ({ ...skill, summary: skill.description }));
    return resources.filter(resource => !native.some(row => row.name === resource.name
      && row.modules?.some(source => source.id === module.id && source.resourceId === resource.id))).map(resource => {
      const all = module.roles.every(role => resource.roles.includes(role.id));
      const roles = module.roles.filter(role => resource.roles.includes(role.id));
      return {
        key: JSON.stringify([module.id, resource.id ?? resource.name]),
        ...(resource.id ? { resourceId: resource.id } : {}),
        name: resource.name,
        ...(resource.summary ? { summary: resource.summary } : {}),
        module: { id: module.id, name: module.name, ...(all ? {} : { roles }) },
      };
    });
  });
}
