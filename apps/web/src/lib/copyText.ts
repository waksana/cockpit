import type { ChatMessage } from '@cockpit/protocol';

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('浏览器不支持剪贴板，请选择文字后复制。');
  await navigator.clipboard.writeText(text);
}

export function messageCopyText(message: ChatMessage): string {
  return message.content;
}
