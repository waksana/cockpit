import type { ChatMessage, UploadedFile } from '@cockpit/protocol';
import type { ChatSession } from '../net/types';

const timestamp = new Date('2026-09-11T09:40:00').getTime();
export const labFiles: UploadedFile[] = [
  { kind: 'image', name: 'reading-layout.svg', url: '/uploads/lab-layout.svg', size: 1360, mime: 'image/svg+xml', path: '/synthetic/reading-layout.svg', source: 'web' },
  { kind: 'file', name: 'interaction-demo.webm', url: '/uploads/lab-video.webm', size: 20480, mime: 'video/webm', path: '/synthetic/interaction-demo.webm', source: 'mcp' },
  { kind: 'file', name: 'component-review-with-a-deliberately-long-name.txt', url: '/uploads/lab-notes.txt', size: 2048, mime: 'text/plain', path: '/synthetic/component-review.txt', source: 'web' },
  { kind: 'image', name: 'missing-preview.png', url: '/uploads/lab-missing.png', size: 35000, mime: 'image/png', path: '/synthetic/missing.png' },
  { kind: 'image', name: 'slow-preview.svg', url: '/uploads/lab-slow.svg', size: 1360, mime: 'image/svg+xml', path: '/synthetic/slow.svg' },
  { kind: 'file', name: 'unknown-format.bin', url: '/uploads/lab-unknown.bin', size: 1024, mime: 'application/octet-stream', path: '/synthetic/unknown.bin' },
];

function message(id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, timestamp, ...extra };
}

export const readingMessages: ChatMessage[] = [
  message('brief', 'user', '请整理这次 Chat 设计评审。保留原生语义，让结果易读、过程可查，操作有明确反馈。'),
  message('reading', 'assistant', `# 阅读优先，过程有序

好的聊天界面不需要不断强调自己。**答案是主角**，过程按需展开；状态必须真实，不能靠颜色猜测。

## 一致的阅读节奏

这是普通段落，包含 **重点**、*补充说明*、~~不再采用的方案~~ 与 [公开的设计参考](https://primer.style/product/components/button/accessibility/)。
这是一处普通软换行。中文与 English、路径 \`src/components/Thread.tsx\` 应当自然混排。

### 交互原则

1. 保留单一的阅读滚动控制。
2. 上翻阅读时，不强制跳到最新消息。
3. 文件加载失败时，保留稳定占位与明确操作。

- 已有能力不变
  - 子代理只报告已记录的生命周期
  - 原生请求的结果不作成功猜测
- 视觉层统一

> 不用装饰掩盖信息层级。先让内容清楚，再让细节精致。

#### 状态对照

| 组件 | 主要内容 | 操作与反馈 |
| :--- | :--- | :--- |
| 工具 | 标题、原生名称、状态 | 展开参数与输出 |
| 附件 | 名称、格式、体积 | 预览、下载、明确重试 |
| 输入区 | 当前草稿 | 暂存与发送分开 |

| 组件标识 | 已加载的记录 | 当前状态 | 阅读位置 | 可用操作 | 结果说明 |
| --- | --- | --- | --- | --- | --- |
| wide-table | bounded-page | unknown | retained-anchor | explicit-read | 不从空值推断完成 |

##### 检查清单

- [x] 正文与辅助信息分层
- [x] 保留文件预览框
- [ ] 逐项完成键盘审视

###### 代码与边界

行内代码 \`const retained = true\` 不应该冒充按钮。

\`\`\`ts
type Outcome = 'accepted' | 'unknown';

export function describe(outcome: Outcome) {
  return outcome === 'accepted'
    ? '已受理，不代表完成'
    : '结果未知，请先核对';
}
\`\`\`

\`\`\`diff
- assumeSuccess();
+ reportActualOutcome();
\`\`\`

---

终端长行保留横向阅读，不挤破聊天列：

\`\`\`sh
printf '%s\\n' 'This_is_a_deliberately_long_terminal_argument_that_must_remain_on_one_line_without_widening_the_chat_column_012345678901234567890123456789'
\`\`\`

极端连续文本：${'Unbroken_identifier_'.repeat(12)}

## 下一步

逐组件查看展开、聚焦、失败与窄屏状态，再决定改动或保留。`),
  message('reply', 'user', '优先保证清晰和稳定。', { subtype: 'ask-reply' }),
  message('followup', 'assistant', '收到。保留现有 Solarized 色彩与文档式助手回复，不重做全站风格。'),
];

export const processMessages: ChatMessage[] = [
  message('process-brief', 'user', '请检查组件状态与展开交互。'),
  message('skill', 'system', 'service-development', { subtype: 'skill' }),
  message('tools', 'assistant', '已检查现有实现。下面保留不同结果，而不是把所有状态都画成成功。', {
    thought: '先确定真实组件边界，再观察视觉与键盘操作。\n将阅读、过程和决策分别处理；不对原生生命周期作额外推断。',
    toolCalls: [
      { toolCallId: 'done', title: '读取组件源码', name: 'view', status: 'completed', args: '{ "path": "src/components/Thread.tsx" }', output: 'Read completed.\nFound message, tool, thought and agent surfaces.' },
      { toolCallId: 'running', title: '检查长内容在窄屏上的布局与超长工具名称', name: `functions.long_tool_name_${'segment_'.repeat(8)}`, status: 'in_progress', args: '{ "viewport": "390x844" }' },
      { toolCallId: 'failed', title: '读取已失效的资源', name: 'web_fetch', status: 'failed', output: 'HTTP 404: Resource not found.\nThis is a synthetic error. No retry was attempted.' },
      { toolCallId: 'pending', title: '等待执行', name: 'task', status: 'pending' },
      { toolCallId: 'unknown', title: '缺少状态的工具记录', name: 'unknown_tool', args: '{ "status": "not supplied" }' },
      { toolCallId: 'no-name', title: '未提供工具名称的记录', status: 'completed', output: 'The disclosure stays in its assigned column.' },
    ],
  }),
  ...(['running', 'activity', 'completed', 'failed', 'cancelled', 'unknown'] as const).map((status, index) => message(`agent-${status}`, 'assistant', '', {
    subtype: 'subagent',
    subagent: {
      toolCallId: `task-${status}`, name: 'explore', displayName: index === 1 ? '窄屏与极端长名称的子代理组件审视' : `组件研究 · ${status}`,
      status, description: '查看折叠摘要与详细过程；此处状态只表示已加载事件。',
      prompt: '检查真实组件的布局、可读性与操作反馈。**不要修改业务语义。**',
      ...(status === 'failed' ? { error: '读取失败：合成资源不存在。结果没有被静默替换。' } : {}),
    },
    subMessages: status === 'unknown' ? [] : [
      message(`child-${status}`, 'assistant', '### 观察\n先保留正确行为，再调整信息密度。', {
        thought: '对比展开前后的阅读顺序。',
        toolCalls: [{ toolCallId: `child-tool-${status}`, title: '检查交互', name: 'view', status: status === 'failed' ? 'failed' : 'completed', output: 'Keyboard target and overflow review.' }],
      }),
    ],
  })),
  message('info', 'system', '会话上下文已更新。'),
  message('warning', 'system', '部分临时片段可能不完整，以完整消息为准。', { level: 'warning' }),
  message('error', 'system', '连接中断，未自动重发请求。', { level: 'error' }),
];

export const attachmentMessages: ChatMessage[] = [
  message('upload', 'user', '请看这些附件。图片、视频、文档必须具有稳定的占位与明确的打开方式。', { attachments: labFiles.slice(0, 3) }),
  message('files', 'assistant', `## 附件与正文

![布局预览](/uploads/lab-layout.svg)
[再次引用同一图片（应为普通链接）](/uploads/lab-layout.svg)

[视频演示](/uploads/lab-video.webm)
[普通文档](/uploads/lab-notes.txt)

### 故障与加载状态

![预览失败](/uploads/lab-missing.png)
![延迟图片加载](/uploads/lab-slow.svg)
[未知格式](/uploads/lab-unknown.bin)
[元数据读取失败](/uploads/lab-error.txt)
[元数据等待](/uploads/lab-pending.txt)

### 普通相对图片与外部图片

![本地预览](/src/dev/lab-layout.svg)
![外部图片不自动读取](https://example.com/blocked-image.png)`),
  message('ordered', 'assistant', '', { parts: [
    { type: 'text', text: '### 有序的文字与文件\n文件前的说明。' },
    { type: 'file', attachment: labFiles[0] },
    { type: 'file', attachment: labFiles[2] },
    { type: 'text', text: '文件后的说明。重复附件不再加载预览。' },
    { type: 'file', attachment: labFiles[0] },
  ] }),
  message('legacy-file', 'user', '单附件兼容入口。', { attachment: labFiles[2] }),
  message('invalid-file', 'assistant', '无效地址明确显示，不导致整条消息崩溃。', { attachment: { kind: 'file', name: 'invalid.txt', url: 'invalid-address', mime: 'text/plain' } }),
];

export const scenarios = [
  ['all', '完整组件对话'],
  ['reading', '正文 / Markdown / 代码'],
  ['user-time', '用户时间 / 短长文本 / 附件'],
  ['process', '思考 / 工具 / 子代理'],
  ['attachments', '图片 / 视频 / 文件'],
  ['streaming', '流式 / 队列 / 停止'],
  ['cancelling', '停止请求中'],
  ['ask', '选择 / 自由回答'],
  ['choice-only', '仅选项回答'],
  ['freeform', '自由输入提问'],
  ['plan', '计划 / 完整计划 / 新指令'],
  ['elicitation', '同意 / 拒绝 / 取消'],
  ['empty', '空对话'],
  ['loading', '首次加载'],
  ['history', '历史分页 / 阅读锚点'],
  ['history-error', '历史失败 / 不完整片段'],
  ['stale', '历史过期 / 显式重读'],
  ['error', '会话错误'],
  ['compacting', '压缩 / 禁用输入'],
  ['auto-compacting', '回合内自动压缩'],
  ['unloaded', '未加载 / 保留历史'],
  ['readonly', '现存只读分支'],
] as const;
export type Scenario = typeof scenarios[number][0];

export function fixtureSession(scenario: Scenario): ChatSession {
  const session: ChatSession = {
    sessionId: `chat-lab-${scenario}`, title: 'Chat 组件审视', cwd: '/synthetic/design-review',
    lastActivity: timestamp, status: 'idle', loaded: true, ask: null, error: null,
    queue: [], materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
    messages: [...readingMessages],
  };
  if (scenario === 'all') session.messages = [...readingMessages, ...processMessages, ...attachmentMessages];
  if (scenario === 'process') session.messages = [...processMessages];
  if (scenario === 'user-time') session.messages = [
    message('time-short', 'user', '收到。'),
    message('time-long', 'user', '这是一段合成的多行用户消息。\n请把时间放在气泡外，并紧贴对应气泡。\n保留文字、附件、复制操作和时间的自然归属。'),
    message('time-file', 'user', '普通文件说明。', { attachments: [labFiles[2]] }),
    message('time-image', 'user', '', { attachment: labFiles[0] }),
    message('time-reply', 'user', '选择已确认。', { subtype: 'ask-reply' }),
    message('time-assistant', 'assistant', '助手的时间来源与展示分组保持不变。'),
  ];
  if (scenario === 'attachments') session.messages = [...attachmentMessages];
  if (scenario === 'streaming' || scenario === 'cancelling') Object.assign(session, {
    status: 'running', nativeProcessing: true, intent: '正在整理组件观察…',
    messages: [...processMessages, message('stream', 'assistant', '## 正在形成答案\n\n先让内容', { thought: '流式思考默认展开；结束后回归折叠。' })],
    queue: [{ id: 'queue-1', text: '然后检查窄屏布局。' }, { id: 'queue-2', text: '保留这条长的排队消息，不要因为主回合打断而把它丢弃。'.repeat(5) }],
  });
  if (scenario === 'cancelling') session.cancelling = true;
  if (['ask', 'choice-only', 'freeform'].includes(scenario)) session.ask = {
    requestId: 'lab-ask', question: '这次精修先聚焦哪一组组件？所有操作只影响当前隔离场景。',
    allowFreeform: scenario !== 'choice-only',
    ...(scenario !== 'freeform' ? { choices: ['阅读层级与代码（推荐）', '思考、工具与子代理', '附件与输入反馈：覆盖长名称、加载失败和不可预览格式'] } : {}),
  };
  if (scenario === 'plan') session.planRequest = {
    requestId: 'lab-plan', summary: '## 组件精修计划\n\n保留薄原生适配，优先调整展示层。\n\n1. 统一阅读节奏。\n2. 明确工具与子代理状态。\n3. 覆盖附件与输入的完整反馈。\n\n> 按钮只呈现原生提供的操作；推荐不代表自动执行。',
    planContent: Array.from({ length: 24 }, (_, i) => `${i + 1}. 检查组件展开、聚焦、长内容与错误反馈；不更改原生语义。`).join('\n'),
    actions: ['interactive', 'autopilot', 'autopilot_fleet', 'exit_only'], recommendedAction: 'interactive',
  };
  if (scenario === 'elicitation') session.elicitation = { requestId: 'lab-elicitation', message: '此工具请求你的确认。是否允许读取选定目录？这是隔离组件场景，不会调用真实工具。', actions: ['accept', 'decline', 'cancel'] };
  if (scenario === 'empty' || scenario === 'loading') session.messages = [];
  if (scenario === 'loading') Object.assign(session, { materialized: false, loadingHistory: true, hasMore: true });
  if (scenario === 'history') session.hasMore = true;
  if (scenario === 'history-error') Object.assign(session, { historyError: '合成读取失败：连接已断开', partialHistory: true, incompleteBoundary: true });
  if (scenario === 'stale') Object.assign(session, { historyStale: true, historyError: '游标已过期，请显式重新同步。' });
  if (scenario === 'error') Object.assign(session, { status: 'error', error: '发送结果尚未确认；请先核对会话，不要直接重发。' });
  if (scenario === 'compacting') session.compacting = true;
  if (scenario === 'auto-compacting') Object.assign(session, { compacting: true, status: 'running' });
  if (scenario === 'unloaded') Object.assign(session, { status: 'unloaded', loaded: false });
  return session;
}
