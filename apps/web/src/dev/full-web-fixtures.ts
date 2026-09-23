import { SessionProjection, type McpServerSession, type SkillSession } from '@cockpit/protocol';
import type { createCockpitStore } from '../net/store';
import { cockpitApi } from '../net/api';
import type { ChatSession } from '../net/types';
import { retireDraftSession } from '../lib/draftSelection';
import type { AgentTaskDetails } from '../lib/sessionControls';
import { installResourceFixture } from './resource-fixtures';
import { workspaceSessionId } from './workspace-fixtures';
import { applyControlAction, canSteer, controlDesignState, controlScenes, controlSession,
  type ControlAction, type ControlDesignState, type ControlScene } from './control-design-state';

const titles: Record<ControlScene, string> = {
  mixed: '聊天布局调整', main: '整理安装文档', background: '构建与独立审查',
  ask: '确认实现范围', plan: '实施计划', elicitation: '工具请求确认',
  manual: '压缩上下文', auto: '后台压缩', idle: '接口设计笔记', 'tool-loading': '检查运行包',
};

// The real App, routes and components consume this replacement data source.
// The optional controls are rendered by Thread itself, not by a preview shell.
export function installFullWebFixture(store: ReturnType<typeof createCockpitStore>, selected = 'mixed') {
  installResourceFixture(store);
  const resources = store.getState();
  const api = { ...cockpitApi };
  const template = resources.sessions[0];
  const models = new Map<string, ControlDesignState>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let active = true;
  let serial = 0;
  const find = (id: string) => {
    const session = store.getState().sessions.find(value => value.sessionId === id);
    if (!session) throw new Error(`Unknown synthetic session: ${id}`);
    return session;
  };
  const project = (model: ControlDesignState): ChatSession => model.session.loaded
    ? { ...controlSession(model), controls: {
      token: `synthetic:${model.session.sessionId}`, sampledAt: Date.now(),
      main: model.main, compaction: model.compaction, tasks: model.tasks.filter(task => task.status === 'running'), steering: model.steering,
    } }
    : { ...model.session, controls: undefined, status: 'unloaded', activity: null, nativeProcessing: false };
  for (const [scene] of controlScenes) {
    const model = controlDesignState(scene);
    const sessionId = scene === 'mixed' ? workspaceSessionId : model.session.sessionId;
    model.session = { ...template, ...model.session, sessionId, title: titles[scene], cwd: '/workspace/cockpit',
      availableModels: template.availableModels, currentModelId: template.currentModelId,
      currentReasoningEffort: template.currentReasoningEffort, currentContextTier: template.currentContextTier,
      currentMode: 'interactive', lastActivity: Date.now() - models.size * 60_000,
    };
    models.set(sessionId, model);
  }
  const unloaded = controlDesignState('idle', 'unloaded');
  unloaded.session = { ...unloaded.session, title: '归档中的调研', cwd: '/workspace/cockpit',
    loaded: false, status: 'unloaded', activity: null, lastActivity: Date.now() - 86_400_000 };
  models.set(unloaded.session.sessionId, unloaded);
  const outsideWindow = controlDesignState('background', 'agent-unloaded');
  outsideWindow.session = { ...template, ...outsideWindow.session, title: 'Agent 记录未载入聊天窗口',
    messages: outsideWindow.session.messages.filter(message => message.subtype !== 'subagent'),
    lastActivity: Date.now() - 10 * 60_000, cwd: '/workspace/cockpit' };
  models.set(outsideWindow.session.sessionId, outsideWindow);
  const agentDetails = new Map<string, Omit<AgentTaskDetails, 'status'>>();
  for (const [sessionId, model] of models) {
    for (const task of model.tasks.filter(task => task.kind === 'agent')) {
      agentDetails.set(JSON.stringify([sessionId, task.id]), {
        sessionId, taskId: task.id, title: task.title,
        description: `独立复核「${model.session.title}」，任务详情不依赖主会话已加载的消息。`,
        prompt: '只读检查组件状态、任务归属和窄屏布局，报告有证据的问题。',
        model: 'GPT-5.4',
        recentActivity: [
          { message: '读取会话状态组件', timestamp: '2026-09-22T08:00:00.000Z' },
          { message: '核对后台任务与消息窗口的独立生命周期', timestamp: '2026-09-22T08:01:00.000Z' },
        ],
        latestResponse: '已读取相关组件。任务 ID 与会话 ID 用于关联详情；聊天窗口是否加载过启动消息不影响读取。',
      });
    }
  }
  const publish = (id: string, model: ControlDesignState) => {
    models.set(id, model);
    store.setState(state => ({ sessions: state.sessions.map(session => session.sessionId === id ? project(model) : session) }));
  };
  const current = (id: string) => {
    const session = find(id);
    const model = models.get(id);
    if (!model) throw new Error(`Missing synthetic model: ${id}`);
    return { ...model, session };
  };
  const change = (id: string, action: ControlAction) => {
    const model = current(id);
    if (!model.session.loaded) throw new Error('合成会话尚未加载。');
    publish(id, applyControlAction(model, action));
  };
  const mcpBySession = new Map<string, McpServerSession[]>();
  const skillsBySession = new Map<string, SkillSession[]>();
  const mcp = async (id: string) => {
    find(id);
    if (!mcpBySession.has(id)) mcpBySession.set(id, structuredClone(await resources.mcpSession(id)));
    return mcpBySession.get(id)!;
  };
  const skills = async (id: string) => {
    find(id);
    if (!skillsBySession.has(id)) skillsBySession.set(id, structuredClone(await resources.skillsSession(id)));
    return skillsBySession.get(id)!;
  };
  const activeId = [...models].find(([, model]) => model.session.sessionId === `control-design-${selected}`)?.[0] ?? workspaceSessionId;
  store.setState({
    sessions: [...models.values()].map(project), activeId,
    watchControls: () => () => {},
    init: () => {
      active = true;
      return () => { active = false; for (const timer of timers) clearTimeout(timer); timers.clear(); };
    },
    readAgentTaskDetails: async (sessionId, taskId, signal) => {
      signal.throwIfAborted();
      if (!active || store.getState().connState !== 'open' || !store.getState().snapshotReady) throw new Error('合成会话连接已失效。');
      const model = current(sessionId);
      if (!model.session.loaded) throw new Error('合成会话尚未加载，不能读取任务详情。');
      const task = model.tasks.find(value => value.id === taskId && value.kind === 'agent');
      if (!task) return null;
      const detail = agentDetails.get(JSON.stringify([sessionId, taskId]));
      if (!detail) throw new Error('这个合成任务没有独立详情记录。');
      return { ...detail, title: task.title, status: task.status,
        latestIntent: task.status === 'running' ? '核对状态与交互边界' : undefined };
    },
    sessionControlAction: async (id, action) => {
      if (!active || store.getState().connState !== 'open' || !store.getState().snapshotReady) throw new Error('合成会话连接已失效。');
      change(id, action);
      if (action.type === 'steer') {
        const timer = setTimeout(() => {
          timers.delete(timer);
          const model = models.get(id);
          if (!active || !model || !store.getState().sessions.some(session => session.sessionId === id)) return;
          const live = current(id);
          if (!live.steering.some(item => item.id === action.id) || !canSteer(live)) return;
          // Simulate a native consumption event after acceptance, not a UI success bubble.
          const item = live.steering.find(item => item.id === action.id)!;
          const consumed = applyControlAction({ ...live, steering: [item] }, { type: 'consume' });
          publish(id, { ...consumed, steering: live.steering.filter(value => value.id !== item.id) });
        }, 700);
        timers.add(timer);
      }
    },
    canSendDraft: draft => {
      const session = store.getState().sessions.find(value => value.sessionId === draft.sessionId);
      if (!session || session.compacting || !store.getState().snapshotReady) return 'unavailable';
      if (draft.getSnapshot().retired) return 'retired';
      if (draft.purpose.kind === 'prompt') return;
      if (!session.loaded) return 'unavailable';
      if (draft.purpose.kind === 'elicitation') return 'unsupported';
      if (draft.purpose.kind === 'ask') {
        if (session.ask?.requestId !== draft.purpose.requestId) return 'decision-changed';
        if (session.ask.allowFreeform === false) return 'unsupported';
      }
      if (draft.purpose.kind === 'plan' && session.planRequest?.requestId !== draft.purpose.requestId) return 'decision-changed';
    },
    getResources: async id => SessionProjection.parse(find(id)),
    sendDraft: async request => {
      const id = request.body.sessionId;
      if (request.intent === 'prompt') {
        if (request.body.attachments?.length) throw new Error('合成预览不处理真实附件。');
        const model = current(id);
        if (!model.session.loaded) publish(id, { ...model, session: { ...model.session, loaded: true } });
        change(id, { type: 'send', id: `synthetic-message-${++serial}`, text: request.body.text });
      } else {
        change(id, { type: 'answer', kind: request.intent === 'respondAsk' ? 'ask' : 'plan',
          requestId: request.body.requestId, id: `synthetic-answer-${++serial}`,
          text: request.intent === 'respondAsk' ? request.body.answer : request.body.message });
      }
      return true;
    },
    respondAsk: async (id, requestId, answer) => {
      change(id, { type: 'answer', kind: 'ask', requestId, id: `synthetic-answer-${++serial}`, text: answer });
      return true;
    },
    respondPlan: async (id, requestId, action) => {
      change(id, { type: 'answer', kind: 'plan', requestId, id: `synthetic-plan-${++serial}`,
        text: action, record: false, resume: action !== 'exit_only' });
      return true;
    },
    planSupersede: async (id, requestId, text) => {
      change(id, { type: 'answer', kind: 'plan', requestId, id: `synthetic-plan-${++serial}`, text });
      return true;
    },
    respondElicitation: async (id, requestId, action) => {
      change(id, { type: 'answer', kind: 'elicitation', requestId, id: `synthetic-confirm-${++serial}`, text: action, record: false });
      return true;
    },
    removeQueued: async (id, itemId) => { change(id, { type: 'remove', id: itemId }); },
    cancel: async id => {
      const model = current(id);
      const stopped = applyControlAction(model, { type: model.tasks.some(task => task.status === 'running') ? 'stop-main' : 'stop-all' });
      publish(id, applyControlAction(stopped, { type: 'clear-queue' }));
    },
    interrupt: async id => {
      const model = current(id);
      if (!model.main) return { ok: true, interrupted: false };
      const stopped = applyControlAction(model, { type: 'stop-main' });
      const item = stopped.queue[0];
      publish(id, item ? applyControlAction({ ...stopped, queue: stopped.queue.slice(1) }, { type: 'send', ...item }) : stopped);
      return { ok: true, interrupted: true };
    },
    loadSession: async id => {
      const model = current(id);
      publish(id, { ...model, session: { ...model.session, loaded: true } });
    },
    reloadSession: async id => {
      const model = current(id);
      if (model.main || model.tasks.some(task => task.status === 'running') || model.compaction) throw new Error('合成会话仍有活动，不能重新加载。');
      publish(id, { ...model, session: { ...model.session, loaded: true, appliedRoles: model.session.roles ?? [], rolesNeedReload: false } });
    },
    deleteSession: async id => {
      const model = current(id);
      if (model.main || model.tasks.some(task => task.status === 'running') || model.compaction) throw new Error('合成会话仍有活动，不能删除。');
      retireDraftSession(id);
      models.delete(id); mcpBySession.delete(id); skillsBySession.delete(id);
      store.setState(state => ({ sessions: state.sessions.filter(session => session.sessionId !== id) }));
    },
    newSession: async (cwd, selectedRoles = []) => {
      await api.listDir(cwd);
      const catalog = await api.listRoles();
      const roles = selectedRoles.map(selection => {
        const role = catalog.find(value => value.moduleId === selection.moduleId && value.roleId === selection.roleId);
        if (!role) throw new Error('Unknown synthetic role');
        return role;
      });
      const id = `synthetic-new-${++serial}`;
      const model = controlDesignState('idle', id);
      model.session = { ...template, ...model.session, sessionId: id, title: '新会话', cwd, roles,
        appliedRoles: roles, rolesNeedReload: false, messages: [], lastActivity: Date.now(),
        availableModels: template.availableModels, currentModelId: template.currentModelId };
      models.set(id, model);
      store.setState(state => ({ sessions: [project(model), ...state.sessions] }));
      return id;
    },
    mcpSession: mcp,
    skillsSession: skills,
    mcpToggleSession: async (id, name, enabled) => {
      const list = await mcp(id);
      if (!list.some(value => value.name === name)) throw new Error('Unknown synthetic MCP');
      mcpBySession.set(id, list.map(value => value.name === name ? { ...value, enabled, status: enabled ? 'connected' : 'disabled' } : value));
    },
    skillsToggleSession: async (id, name, enabled) => {
      const list = await skills(id);
      if (!list.some(value => value.name === name)) throw new Error('Unknown synthetic skill');
      skillsBySession.set(id, list.map(value => value.name === name ? { ...value, enabled } : value));
    },
    refreshList: async () => {},
  });
  cockpitApi.setModel = async (id, model, options) => {
    const result = await api.setModel(id, model, options);
    store.setState(state => ({ resourceRevisions: { ...state.resourceRevisions,
      [id]: { ...state.resourceRevisions[id], model: (state.resourceRevisions[id]?.model ?? 0) + 1 },
    } }));
    return result;
  };
  return activeId;
}
