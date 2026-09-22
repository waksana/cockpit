import type { ChatMessage, NativeChatEvent } from '@cockpit/protocol';
import type { ChatSession } from '../net/types';
import { activityFixture } from './activity-fixtures';
import { activityDesignSessions } from './activity-design-fixtures';
import type { SessionControlAction } from '../lib/sessionControls';

export const controlScenes = [
  ['mixed', '主回合 + shell + agent + 队列'],
  ['main', '只有主回合'],
  ['background', '只有后台任务，不能立即发送'],
  ['ask', '待回答 + 后台任务'],
  ['plan', '计划确认'],
  ['elicitation', '工具确认'],
  ['manual', '手动压缩'],
  ['auto', '自动后台压缩'],
  ['idle', '空闲输入框'],
  ['tool-loading', '最底部工具 loading'],
] as const;
export type ControlScene = typeof controlScenes[number][0];
export interface PreviewTask {
  id: string;
  kind: 'shell' | 'agent';
  title: string;
  status: 'running' | 'cancelled';
  messageId?: string;
}
interface PreviewQueued { id: string; text: string }
export interface ControlDesignState {
  session: ChatSession;
  main: boolean;
  compaction: 'manual' | 'auto' | null;
  tasks: PreviewTask[];
  queue: PreviewQueued[];
  steering: PreviewQueued[];
  events: NativeChatEvent[];
}
export type ControlAction = SessionControlAction
  | { type: 'stop-main' | 'finish-compaction' | 'consume' | 'finish-tool' }
  | { type: 'question'; id: string }
  | { type: 'send'; id: string; text: string }
  | { type: 'answer'; id: string; text: string; kind: 'ask' | 'plan' | 'elicitation'; requestId: string; resume?: boolean; record?: boolean };

export function controlDesignState(scene: ControlScene, identity: string = scene): ControlDesignState {
  const source = activityDesignSessions().find(value => value.sessionId === `design-${
    ['ask', 'plan', 'elicitation'].includes(scene) ? scene : 'idle'
  }`)!;
  const tasks: PreviewTask[] = ['mixed', 'background', 'ask'].includes(scene) ? [
    { id: 'preview-build', kind: 'shell', title: '构建项目', status: 'running' },
    { id: 'preview-check', kind: 'shell', title: '运行测试', status: 'running' },
    { id: 'preview-agent', kind: 'agent', title: '独立代码审查', status: 'running', messageId: 'design-agent' },
  ] : [];
  const messages: ChatMessage[] = [
    { id: 'control-request', role: 'user', content: '请修改界面，并让后台任务继续运行。', timestamp: 1_790_000_000_000 },
    { id: 'control-response', role: 'assistant', timestamp: 1_790_000_001_000,
      content: '这里展示真实聊天组件，但所有任务、消息和操作都是合成的，不会调用原生 SDK。' },
    ...(tasks.length ? [{
      id: 'control-shells', role: 'assistant' as const, content: '', timestamp: 1_790_000_002_000,
      toolCalls: tasks.filter(task => task.kind === 'shell').map(task => ({
        toolCallId: task.id, name: 'bash', title: task.title, status: 'completed' as const,
        output: `合成命令已转入后台：${task.id}。这是启动记录，不代表后台任务已经结束。`,
      })),
    }, ...source.messages.filter(message => message.subtype === 'subagent')] : []),
  ];
  if (scene === 'tool-loading') {
    messages.push(...Array.from({ length: 24 }, (_, index): ChatMessage => ({
      id: `loading-history-${index}`, role: index % 2 ? 'assistant' : 'user',
      timestamp: 1_790_000_010_000 + index * 1000,
      content: index % 2 ? '这段是静止的合成历史，用于产生真实滚动距离。没有流式更新或轮询。' : `历史问题 ${index / 2 + 1}`,
    })), { id: 'loading-last-tool', role: 'assistant', content: '', timestamp: 1_790_000_040_000,
      toolCalls: [{ toolCallId: 'loading-last-call', name: 'bash', title: '等待合成工具返回（持续 loading）',
        status: 'in_progress' }] });
  }
  return {
    session: { ...source, sessionId: `control-design-${identity}`, title: '会话控制区设计',
      messages, queue: [], compacting: false, ask: source.ask, planRequest: source.planRequest,
      elicitation: source.elicitation },
    main: ['mixed', 'main', 'ask', 'plan', 'elicitation', 'tool-loading'].includes(scene),
    compaction: scene === 'manual' || scene === 'auto' ? scene : null,
    tasks, queue: ['mixed', 'background', 'ask'].includes(scene)
      ? [{ id: 'preview-q1', text: '先不要提交' }, { id: 'preview-q2', text: '再检查移动端布局，并保留现有输入草稿和阅读位置。' }] : [],
    steering: [], events: [],
  };
}

export function controlSession(state: ControlDesignState): ChatSession {
  const running = state.tasks.filter(task => task.status === 'running');
  const active = state.main || running.length > 0 || !!state.compaction;
  return { ...state.session, status: state.main || running.length ? 'running' : 'idle', nativeProcessing: state.main,
    compacting: !!state.compaction, queue: state.queue,
    activity: activityFixture({ processing: state.main, hasActiveWork: active, abortable: state.main,
      tasks: { activeShells: running.filter(task => task.kind === 'shell').length,
        activeAgents: running.filter(task => task.kind === 'agent').length, unknown: 0 },
      queue: { pendingCount: state.queue.length, steeringCount: state.steering.length, inFlightSteeringCount: 0 },
    }),
  };
}

export function canSteer(state: ControlDesignState): boolean {
  return state.main && !state.compaction && !state.session.ask && !state.session.planRequest && !state.session.elicitation;
}

function appendUser(state: ControlDesignState, item: PreviewQueued, delivery: 'idle' | 'steering'): ControlDesignState {
  const timestamp = new Date().toISOString();
  const event: NativeChatEvent = { id: `event-${item.id}`, type: 'user.message', timestamp,
    data: { content: item.text, messageId: item.id, delivery } };
  return { ...state, events: [...state.events, event],
    session: { ...state.session, messages: [...state.session.messages, {
      id: event.id, role: 'user', content: item.text, timestamp: Date.parse(timestamp),
    }] },
  };
}

// This is a deterministic UI scenario, not an implementation of the SDK methods.
export function applyControlAction(state: ControlDesignState, action: ControlAction): ControlDesignState {
  switch (action.type) {
    case 'clear-tasks': {
      const ids = new Set(action.ids);
      if (!ids.size || ids.size !== action.ids.length || action.ids.some(id =>
        !state.tasks.some(task => task.id === id && task.kind === action.kind && task.status === 'running'))) {
        throw new Error('任务列表已变化，请核对后再清空。');
      }
      let next = state;
      for (const id of ids) next = applyControlAction(next, { type: 'stop-task', id });
      return { ...next, tasks: next.tasks.filter(task => !ids.has(task.id)) };
    }
    case 'cancel-decision': {
      const current = action.kind === 'ask' ? state.session.ask
        : action.kind === 'plan' ? state.session.planRequest : state.session.elicitation;
      if (current?.requestId !== action.requestId) throw new Error('原问题已结束或被替换，未取消新的问题。');
      if (action.kind === 'ask') return applyControlAction(state, { type: 'stop-main' });
      return applyControlAction(state, { type: 'answer', kind: action.kind, requestId: action.requestId,
        id: `cancel-${action.requestId}`, text: 'cancel', record: false, resume: action.kind === 'elicitation' });
    }
    case 'clear-decisions': {
      const current = [
        ...(state.session.ask ? [{ kind: 'ask', requestId: state.session.ask.requestId }] : []),
        ...(state.session.planRequest ? [{ kind: 'plan', requestId: state.session.planRequest.requestId }] : []),
        ...(state.session.elicitation ? [{ kind: 'elicitation', requestId: state.session.elicitation.requestId }] : []),
      ];
      if (!current.length || current.length !== action.requests.length
        || current.some(request => !action.requests.some(value => value.kind === request.kind && value.requestId === request.requestId))) {
        throw new Error('待回答内容已变化，未中断新的回合。');
      }
      return applyControlAction(state, { type: 'stop-main' });
    }
    case 'question':
      return { ...state, main: true, session: { ...state.session, ask: {
        requestId: action.id, question: '是否继续调整这个界面？也可以在下面补充具体要求。',
        choices: ['继续', '保持当前方案'], allowFreeform: true,
      } } };
    case 'stop-all': {
      let next = applyControlAction(state, { type: 'stop-main' });
      for (const task of state.tasks) if (task.status === 'running') next = applyControlAction(next, { type: 'stop-task', id: task.id });
      return { ...next, compaction: null, queue: [], steering: [],
        session: { ...next.session, messages: next.session.messages.map(message =>
          message.toolCalls?.some(tool => tool.status === 'in_progress' || tool.status === 'pending')
            ? { ...message, toolCalls: message.toolCalls.map(tool =>
              tool.status === 'in_progress' || tool.status === 'pending'
                ? { ...tool, status: 'failed', output: [tool.output, '合成执行已停止。'].filter(Boolean).join('\n') } : tool) }
            : message) },
      };
    }
    case 'prune-tasks':
      return { ...state, tasks: state.tasks.filter(task => task.status === 'running') };
    case 'remove-task':
      if (state.tasks.some(task => task.id === action.id && task.status === 'running')) throw new Error('运行中的任务只能停止，不能移除。');
      return { ...state, tasks: state.tasks.filter(task => task.id !== action.id) };
    case 'finish-tool':
      return { ...state, main: false, session: { ...state.session, messages: state.session.messages.map(message =>
        message.id === 'loading-last-tool' ? { ...message, toolCalls: message.toolCalls?.map(tool =>
          ({ ...tool, status: 'completed', output: '合成执行已结束。' })) } : message) } };
    case 'stop-main':
      return { ...state, main: false, session: { ...state.session, ask: null, planRequest: null, elicitation: null } };
    case 'clear-queue':
      return { ...state, queue: [], steering: [] };
    case 'cancel-compaction':
      if (state.compaction !== 'manual') throw new Error('当前不是可取消的手动压缩。');
      return { ...state, compaction: null };
    case 'finish-compaction':
      return { ...state, compaction: null };
    case 'stop-task': {
      const target = state.tasks.find(task => task.id === action.id && task.status === 'running');
      if (!target) throw new Error('任务已不在运行，请核对状态。');
      return { ...state, tasks: state.tasks.map(task => task === target ? { ...task, status: 'cancelled' } : task),
        session: { ...state.session, messages: state.session.messages.map(message =>
          message.id === target.messageId && message.subagent
            ? { ...message, subagent: { ...message.subagent, status: 'cancelled' } } : message) },
      };
    }
    case 'remove':
    case 'steer': {
      const item = state.queue.find(value => value.id === action.id);
      if (!item) throw new Error('这条消息已不在待发送队列。');
      if (action.type === 'steer' && !canSteer(state)) throw new Error('没有可接收补充消息的主回合；原消息未移除。');
      return { ...state, queue: state.queue.filter(value => value !== item),
        steering: action.type === 'steer' ? [...state.steering, item] : state.steering };
    }
    case 'consume':
      if (!canSteer(state)) throw new Error('当前无法纳入回合；消息仍留在等待区域。');
      return state.steering.reduce((next, item) => appendUser(next, item, 'steering'), { ...state, steering: [] });
    case 'send':
      if (state.compaction) throw new Error('正在压缩上下文，请等待压缩结束。');
      return state.main ? { ...state, queue: [...state.queue, { id: action.id, text: action.text }] }
        : { ...appendUser(state, action, 'idle'), main: true };
    case 'answer': {
      const request = action.kind === 'ask' ? state.session.ask
        : action.kind === 'plan' ? state.session.planRequest : state.session.elicitation;
      if (request?.requestId !== action.requestId) throw new Error('原问题已结束或已被替换；未提交旧回答。');
      return { ...state, main: action.resume ?? true, session: { ...state.session,
        ask: action.kind === 'ask' ? null : state.session.ask,
        planRequest: action.kind === 'plan' ? null : state.session.planRequest,
        elicitation: action.kind === 'elicitation' ? null : state.session.elicitation,
        messages: action.record === false ? state.session.messages : [...state.session.messages, { id: action.id, role: 'user', content: action.text,
          timestamp: Date.now(), ...(state.session.ask ? { subtype: 'ask-reply', replyQuestion: state.session.ask.question } : {}) }],
      } };
    }
  }
}
