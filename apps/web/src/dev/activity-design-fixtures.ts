import type { ChatMessage } from '@cockpit/protocol';
import type { ChatSession } from '../net/types';
import { builtinToolPresentation } from '../lib/toolPresentation';
import { activityFixture } from './activity-fixtures';
import { fixtureSession } from './chat-fixtures';

const timestamp = 1_790_000_000_000;
const descriptions: Record<string, string> = {
  view: '读取 Thread.tsx', rg: '搜索停止请求的反馈文案', glob: '查找工具行相关测试',
  apply_patch: '修改活动状态展示', bash: '运行前端构建', read_bash: '读取构建输出',
  stop_bash: '停止临时预览服务', skill: '加载 github-coding',
  read_agent: '读取独立审查结果', write_agent: '补充审查要求',
};
const toolMessage: ChatMessage = {
  id: 'design-tools', role: 'assistant', timestamp, content: '',
  toolCalls: [
    ...Object.entries(builtinToolPresentation)
      .filter(([name]) => !['task', 'ask_user', 'exit_plan_mode'].includes(name))
      .map(([name, entry]) => ({
        toolCallId: `design-${name}`, name, title: descriptions[name] ?? entry.label,
        status: name === 'bash' ? 'in_progress' as const : name === 'web_fetch' ? 'failed' as const : 'completed' as const,
        args: JSON.stringify({ fixture: true, tool: name }),
        output: name === 'web_fetch' ? 'Synthetic HTTP 404. No network request was made.' : 'Synthetic tool output.',
      })),
    { toolCallId: 'design-mcp', name: 'chrome-devtools-evaluate_script', title: '检查工具行的布局',
      status: 'completed', output: 'Synthetic browser output.' },
    { toolCallId: 'design-pending', name: 'cockpit-task-task_read', title: '读取任务要求', status: 'pending' },
    { toolCallId: 'design-unknown', name: 'custom_extension_tool', title: '缺少执行结果的扩展调用' },
  ],
};
const agentMessage: ChatMessage = {
  id: 'design-agent', role: 'assistant', timestamp, content: '', subtype: 'subagent',
  subagent: { toolCallId: 'design-agent-task', agentId: 'synthetic-reviewer',
    name: 'code-review', displayName: '独立代码审查', status: 'running',
    description: '独立消息卡片，不是工具行。展开可看这个 agent 的合成过程。',
    prompt: '只读审查活动图标和工具行布局。' },
  subMessages: [{ id: 'design-agent-read', role: 'assistant', timestamp,
    content: '正在检查组件的真实状态来源和布局。',
    toolCalls: [{ toolCallId: 'design-agent-view', name: 'view', title: '读取活动状态组件',
      status: 'completed', output: 'Synthetic component source.' }] }],
};

export const designMessages: ChatMessage[] = [
  { id: 'design-request', role: 'user', timestamp, content: '请展示工具图标、独立 subagent 卡片和活动状态。' },
  { id: 'design-intro', role: 'assistant', timestamp,
    content: '以下都是合成记录。内置工具使用动作图标，扩展工具保留扳手和完整名称；每一行右侧仅表示执行结果。' },
  toolMessage, agentMessage,
];

export function activityDesignSessions(): ChatSession[] {
  const base = { ...fixtureSession('reading'), messages: designMessages, queue: [],
    status: 'idle' as const, activity: activityFixture(), error: null };
  const make = (id: string, title: string, patch: Partial<ChatSession> = {}): ChatSession =>
    ({ ...base, sessionId: `design-${id}`, title, ...patch });
  const running = { status: 'running' as const, nativeProcessing: true };
  const shell = { activeAgents: 0, activeShells: 1, unknown: 0 };
  const agent = { activeAgents: 2, activeShells: 0, unknown: 0 };
  return [
    make('processing', '仅正在处理：转圈', { ...running, activity: activityFixture({ processing: true, hasActiveWork: true, abortable: true }) }),
    make('ask', '等待回答：只显示问号', { ...running, activity: activityFixture({ processing: true, abortable: true }),
      ask: { requestId: 'design-question', question: '你希望采用这组工具图标吗？', choices: ['采用', '继续调整'], allowFreeform: true } }),
    make('mixed', '问号 + shell + agent：不转圈', { ...running,
      ask: { requestId: 'design-mixed-question', question: '后台任务仍在运行，现在继续吗？', choices: ['继续', '暂停'] },
      activity: activityFixture({ processing: true, hasActiveWork: true, abortable: true,
        tasks: { ...shell, activeAgents: 2 } }) }),
    make('shell', '后台 shell：不转圈', { ...running, activity: activityFixture({ processing: true, hasActiveWork: true, abortable: true, tasks: shell }) }),
    make('agent', '后台 agent：不转圈', { ...running, activity: activityFixture({ processing: true, hasActiveWork: true, abortable: true, tasks: agent }) }),
    make('queue', '队列：不转圈', { ...running, queue: [{ id: 'design-queued', text: '接着检查窄屏布局' }],
      activity: activityFixture({ processing: true, abortable: true, queue: { pendingCount: 1, steeringCount: 2, inFlightSteeringCount: 1 } }) }),
    make('mcp', 'MCP 等待：不转圈', { ...running,
      activity: activityFixture({ processing: true, mcp: { pendingConnectionCount: 1 } }) }),
    make('plan', '计划确认：只显示问号', { ...running, activity: activityFixture({ processing: true }),
      planRequest: { requestId: 'design-plan', summary: '只调整经典版显示，不改变原生任务执行。', actions: ['interactive', 'exit_only'] } }),
    make('elicitation', '工具确认：只显示问号', { ...running, activity: activityFixture({ processing: true }),
      elicitation: { requestId: 'design-confirm', message: '允许合成工具继续吗？' } }),
    make('compact', '正在压缩：转圈', { compacting: true, activity: activityFixture({ processing: true, hasActiveWork: true }) }),
    make('unknown', '首次没有数据：兜底转圈', { ...running, activity: null }),
    make('unclassified', '无法分类：兜底转圈', { ...running, activity: activityFixture({ hasActiveWork: true }) }),
    make('unknown-tasks', '任务状态未知：兜底转圈', { ...running,
      activity: activityFixture({ tasks: { activeAgents: 0, activeShells: 0, unknown: 1 } }) }),
    make('error', '真正失败：错误图标', { status: 'error', error: '合成状态读取失败；没有隐藏错误。', activity: null }),
    make('idle', '已确认空闲：没有图标'),
    make('unloaded', '未加载：只置灰', { loaded: false, status: 'unloaded', activity: null }),
  ];
}
