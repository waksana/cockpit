import type { ChatMessage, ChatSession, ModelOption } from '../net/types';
import type { createCockpitStore } from '../net/store';

export const workspaceSessionId = 'demo-cockpit-install';
export const workspaceDraft = '再补上首次认证和数据目录的说明。';
const models: ModelOption[] = [
  { modelId: 'gpt-5.4', name: 'GPT-5.4', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    supportsLongContext: true },
  { modelId: 'gpt-5.4-mini', name: 'GPT-5.4 mini', supportedReasoningEfforts: ['low', 'medium', 'high'] },
];

export function workspaceSessions(now = Date.now()): ChatSession[] {
  const message = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id, role, content, timestamp: now - 120_000, ...extra });
  const messages: ChatMessage[] = [
    message('request', 'user', '梳理这个项目的安装流程。保留聊天体验，请子 agent 独立复核文档。'),
    message('intro', 'assistant', '我先核对服务入口、依赖和数据目录，再汇总文档复核结果。'),
    message('earlier', 'assistant', '', {
      thought: '先确认运行包的边界，再检查安装文档是否与实际入口一致。',
      toolCalls: [
        { toolCallId: 'read-entry', name: 'view', title: '读取服务入口', status: 'completed',
          args: '{ "path": "apps/server/src/index.ts" }', output: '合成记录：服务统一提供 Web 和 HTTP API。' },
        { toolCallId: 'read-package', name: 'view', title: '核对生产依赖', status: 'completed',
          args: '{ "path": "apps/server/package.json" }', output: '合成记录：生产 loader 已声明。' },
      ],
    }),
    message('boundary', 'assistant', '运行包与用户数据应当分开。会话仍由 **Copilot** 管理，Cockpit 不保存第二份历史。'),
    message('followup', 'user', '重点看首次启动，也检查最终运行包能否独立运行。'),
    message('agent', 'assistant', '', {
      subtype: 'subagent',
      subagent: {
        toolCallId: 'documentation-agent', name: 'explore', displayName: '安装文档复核',
        status: 'completed', description: '独立核对安装步骤、认证说明和服务启动边界。',
        prompt: '对照安装文档与当前入口，只报告有证据的差异。',
      },
      subMessages: [
        message('agent-read', 'assistant', '', { toolCalls: [
          { toolCallId: 'agent-docs', name: 'view', title: '读取安装指南', status: 'completed',
            args: '{ "path": "docs/DEPLOY-PORTABLE.md" }', output: '合成文档复核记录。' },
        ] }),
        message('agent-result', 'assistant', '安装步骤清晰。建议补充 **冷启动后的认证确认**，并明确用户数据不随换包删除。'),
      ],
    }),
    message('latest-intro', 'assistant', '文档复核已返回。现在核对包内入口与资源，保留每次工具调用的输入和输出。'),
    message('latest-tools', 'assistant', '', { timestamp: now, toolCalls: [
      { toolCallId: 'archive-check', name: 'bash', title: '检查运行包入口与静态资源', status: 'completed',
        args: '{ "command": "node --test scripts/package-runtime.test.mjs" }',
        output: 'Synthetic fixture output\nServer entry and Web assets: OK\nProduction dependency closure: OK' },
      { toolCallId: 'startup-check', name: 'bash', title: '核对首次启动与退出行为', status: 'in_progress',
        args: '{ "command": "node --import tsx --test apps/server/src/entry.test.ts" }' },
    ] }),
  ];
  const active: ChatSession = {
    sessionId: workspaceSessionId, title: '安装流程与运行包复核', cwd: '/workspace/cockpit',
    createdAt: now - 3_600_000, lastActivity: now, status: 'running', loaded: true,
    nativeProcessing: true, intent: '核对首次启动与退出行为', ask: null, error: null, queue: [],
    currentModelId: models[0].modelId, currentReasoningEffort: 'high', currentContextTier: 'long_context',
    availableModels: models, messages, materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
  };
  return [
    active,
    ...[
      ['chat', '聊天界面与交互细节', '/workspace/cockpit'],
      ['api', 'API 参数与错误反馈', '/workspace/cockpit'],
      ['docs', '整理项目文档', '/workspace/docs-site'],
      ['tests', '补充组件测试', '/workspace/cockpit'],
      ['release', '准备版本发行', '/workspace/cockpit'],
    ].map(([id, title, cwd], index): ChatSession => ({
      ...active, sessionId: `demo-${id}`, title, cwd, lastActivity: now - (index + 1) * 720_000,
      status: 'idle', nativeProcessing: false, intent: null,
      messages: [message(`summary-${id}`, 'assistant', '这是用于界面演示的合成会话，没有连接原生运行时。')],
    })),
  ];
}

// The real App consumes this store, but never starts a transport. Unsupported
// actions retain the disconnected store's explicit error instead of reaching a backend.
export function installWorkspaceFixture(store: ReturnType<typeof createCockpitStore>, now = Date.now()) {
  const sessions = workspaceSessions(now);
  const find = (id: string) => {
    const session = store.getState().sessions.find(item => item.sessionId === id);
    if (!session) throw new Error(`Unknown synthetic session: ${id}`);
    return session;
  };
  store.setState({
    connState: 'open', snapshotReady: true, sessions, activeId: workspaceSessionId,
    sessionControlAction: undefined,
    watchControls: () => () => {},
    globalModels: models,
    init: () => () => {},
    setActiveId: activeId => { store.setState({ activeId }); },
    getResources: async id => {
      const session = find(id);
      return { sessionId: id, loaded: session.loaded, currentModelId: session.currentModelId,
        currentReasoningEffort: session.currentReasoningEffort, currentContextTier: session.currentContextTier,
        availableModels: session.availableModels };
    },
    setModel: async (id, modelId, options) => {
      const session = find(id);
      if (!session.availableModels?.some(model => model.modelId === modelId)) throw new Error('Unknown synthetic model');
      store.setState(state => ({ sessions: state.sessions.map(item => item.sessionId === id
        ? { ...item, currentModelId: modelId, currentReasoningEffort: options?.reasoningEffort,
          currentContextTier: options?.contextTier } : item) }));
      return { ok: true, result: { modelId, status: 'applied' } };
    },
    sendDraft: async request => {
      if (request.intent !== 'prompt') throw new Error('Unsupported synthetic draft route');
      const { sessionId: id, text } = request.body;
      find(id);
      store.setState(state => ({ sessions: state.sessions.map(item => item.sessionId === id
        ? { ...item, messages: [...item.messages, {
          id: `demo-input-${item.messages.length}`, role: 'user', content: text, timestamp: now,
        }] } : item) }));
      return true;
    },
    cancel: async id => {
      find(id);
      store.setState(state => ({ sessions: state.sessions.map(item => item.sessionId === id
        ? { ...item, status: 'idle', nativeProcessing: false, intent: null, queue: [] } : item) }));
    },
  });
}
