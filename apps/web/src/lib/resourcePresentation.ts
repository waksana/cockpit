import type { McpConnection } from '@cockpit/protocol';

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
