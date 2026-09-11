import { attachmentMarkdown, UploadUrl, type Attachment, type ChatMessage } from '@cockpit/protocol';

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('浏览器不支持剪贴板，请选择文字后复制。');
  await navigator.clipboard.writeText(text);
}

export function messageCopyText(message: ChatMessage): string {
  const fileText = (file: Attachment) => UploadUrl.safeParse(file.url).success
    ? attachmentMarkdown(file) : `${file.name}（文件地址无效）`;
  if (message.parts) return message.parts.map(part => part.type === 'text'
    ? part.text : fileText(part.attachment)).join('\n\n');
  const files = message.attachments ?? (message.attachment ? [message.attachment] : []);
  return [...files.map(fileText), message.content].filter(Boolean).join('\n\n');
}
