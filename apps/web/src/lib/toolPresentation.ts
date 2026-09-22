import type { IconName } from '../components/Icon';

export const builtinToolPresentation = {
  view: { icon: 'read_file', label: '读取文件' },
  rg: { icon: 'search', label: '搜索文本' },
  glob: { icon: 'find_file', label: '查找文件' },
  apply_patch: { icon: 'edit_file', label: '修改文件' },
  edit: { icon: 'edit_file', label: '编辑文件' },
  create: { icon: 'edit_file', label: '创建文件' },
  bash: { icon: 'shell', label: '执行命令' },
  powershell: { icon: 'shell', label: '执行 PowerShell 命令' },
  read_bash: { icon: 'shell_output', label: '读取命令输出' },
  stop_bash: { icon: 'stop', label: '停止命令' },
  list_bash: { icon: 'shell_list', label: '查看命令列表' },
  task: { icon: 'agent', label: '启动子 agent' },
  read_agent: { icon: 'agent_result', label: '读取 agent 结果' },
  write_agent: { icon: 'agent_message', label: '发送 agent 消息' },
  list_agents: { icon: 'agent_list', label: '查看 agent 列表' },
  skill: { icon: 'skills', label: '加载 Skill' },
  sql: { icon: 'database', label: '执行数据库查询' },
  web_fetch: { icon: 'web', label: '读取网页' },
  web_search: { icon: 'web_search', label: '搜索网页' },
  ask_user: { icon: 'decision', label: '询问用户' },
  exit_plan_mode: { icon: 'decision', label: '请求确认计划' },
  manage_schedule: { icon: 'schedule', label: '管理定时任务' },
} satisfies Record<string, { icon: IconName; label: string }>;

export function toolPresentation(name?: string): { icon: IconName; label: string; builtin: boolean } {
  const key = name?.replace(/^functions\./, '');
  const entry = Object.entries(builtinToolPresentation).find(([tool]) => tool === key)?.[1];
  return entry ? { ...entry, builtin: true } : { icon: 'tool', label: name || '缺少工具名称', builtin: false };
}
