import type { NativeChatEvent, NativeChatRead } from '@cockpit/protocol';
import { NativeWindow } from '../net/nativeWindow';

const timestamp = '2026-09-13T15:30:00.000Z';
const event = (id: string, type: string, data: Record<string, unknown>): NativeChatEvent =>
  ({ id, type, timestamp, data });

export const orderedEvents: NativeChatEvent[] = [
  event('z-user', 'user.message', { content: '按事件顺序展示，过程连续收纳。' }),
  event('y-thought', 'assistant.reasoning', { reasoningId: 'r-before', content: '先读记录，再决定如何展示。' }),
  event('x-request', 'assistant.message', { messageId: 'first-request', content: '', toolRequests: [
    { toolCallId: 'read', name: 'view', intentionSummary: '读取事件记录', arguments: { path: '/synthetic/events' } },
  ] }),
  event('w-start', 'tool.execution_start', { toolCallId: 'read', toolName: 'view' }),
  event('v-result', 'tool.execution_complete', { toolCallId: 'read', success: true, result: { content: '合成记录读取完毕。' } }),
  event('u-thought', 'assistant.reasoning', { reasoningId: 'r-middle', content: '已有记录可以按事件先后展示，不必重新推测顺序。' }),
  event('t-answer', 'assistant.message', { messageId: 'answer-between', content: '这段正文在下一次工具执行之前出现。', toolRequests: [
    { toolCallId: 'inspect', name: 'bash', intentionSummary: '检查布局', arguments: { command: 'inspect synthetic-layout' } },
  ] }),
  event('s-start', 'tool.execution_start', { toolCallId: 'inspect', toolName: 'bash' }),
  event('r-result', 'tool.execution_complete', { toolCallId: 'inspect', success: false, error: { message: 'Synthetic layout error; no retry.' } }),
  event('q-thought', 'assistant.reasoning', { reasoningId: 'r-latest', content: '最新思考默认展开，旧思考只在手动选择后保持展开。' }),
  event('p-request', 'assistant.message', { messageId: 'final-request', content: '', toolRequests: [
    { toolCallId: 'unknown', name: 'view', intentionSummary: '等待读取示例', arguments: { path: '/synthetic/next' } },
  ] }),
];

export function orderedFixture() {
  const window = new NativeWindow(undefined, true);
  let cursor = 0;
  let count = 0;
  let durable = [...orderedEvents];
  const apply = (events: NativeChatEvent[], backward = false) => {
    const query: NativeChatRead = {
      sessionId: 'chat-lab-ordered-events', source: 'live', direction: backward ? 'backward' : 'forward',
      max: 64, waitMs: 0, bootstrap: false,
    };
    window.accept({
      sessionId: query.sessionId, source: query.source, direction: query.direction,
      events, cursor: `fixture-${++cursor}`, cursorStatus: 'ok', hasMore: false,
      read: { rpc: 1, events: events.length },
    }, query);
    return window.snapshot();
  };
  apply(orderedEvents, true);
  apply([]);
  const append = (events: NativeChatEvent[]) => {
    durable.push(...events.filter(item => !item.ephemeral));
    return apply(events);
  };
  return {
    snapshot: () => window.snapshot(),
    thought: () => append([event(`next-thought-${++count}`, 'assistant.reasoning', {
      reasoningId: `r-next-${count}`, content: `新思考 ${count}：自动展开只跟随最后一条。`,
    })]),
    body: () => append([event(`next-body-${++count}`, 'assistant.message', {
      messageId: `body-${count}`, content: `新的正文边界 ${count}，不跨过这段正文合并过程。`,
    })]),
    tool: () => append([event(`next-tool-${++count}`, 'assistant.message', {
      messageId: `tool-owner-${count}`, content: '',
      toolRequests: [{ toolCallId: `tool-${count}`, name: 'view', intentionSummary: `后续工具 ${count}` }],
    })]),
    older: () => {
      const events = [
        event(`older-thought-${++count}`, 'assistant.reasoning', { reasoningId: `r-older-${count}`, content: '早期思考：补历史不改变当前选择。' }),
        event(`older-answer-${count}`, 'assistant.message', { messageId: `older-${count}`, content: '更早的合成正文。' }),
      ];
      durable = [...events, ...durable];
      return apply(events, true);
    },
    duplicate: () => apply(durable.slice(-3)),
    reconnect: () => {
      const messageId = `reconnect-${++count}`;
      append([
        { ...event(`stream-start-${count}`, 'assistant.message_start', { messageId }), ephemeral: true },
        { ...event(`stream-delta-${count}`, 'assistant.message_delta', { messageId, deltaContent: '暂存的前半段' }), ephemeral: true },
      ]);
      window.disconnect();
      apply([]);
      append([{ ...event(`stream-tail-${count}`, 'assistant.message_delta', { messageId, deltaContent: '缺失前缀的后半段' }), ephemeral: true }]);
      return append([event(`stream-final-${count}`, 'assistant.message', { messageId, content: '断线后的完整持久正文。' })]);
    },
    cold: () => {
      const cold = new NativeWindow(undefined, true);
      const query: NativeChatRead = { sessionId: 'chat-lab-ordered-events', source: 'persisted', direction: 'backward', max: 256, waitMs: 0, bootstrap: false };
      cold.accept({ sessionId: query.sessionId, source: 'persisted', direction: 'backward', events: durable,
        cursor: 'cold', cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: durable.length } }, query);
      return cold.snapshot();
    },
  };
}
