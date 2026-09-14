import type { ToolCall } from '@cockpit/protocol';

export const toolStatusLabel = (status: ToolCall['status']) => status ? ({
  completed: '已完成', failed: '失败', in_progress: '执行中', pending: '待执行',
})[status] : '状态未知';
