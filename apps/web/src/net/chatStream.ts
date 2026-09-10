import { NativeChatStreamEvent } from '@cockpit/protocol';

/** Consume one connection; the view owns its cursor and reconnection policy. */
export async function consumeChatStream(
  response: Response,
  receive: (event: NativeChatStreamEvent) => void,
): Promise<never> {
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    throw new Error('聊天实时接口未返回 SSE 数据流。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new TypeError('聊天实时连接已断开。');
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (!line) {
          if (data.length) {
            const event = NativeChatStreamEvent.parse(JSON.parse(data.join('\n')));
            data = [];
            receive(event);
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
