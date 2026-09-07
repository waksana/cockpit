// File upload helper. Uploads a File to the backend's fixed folder, then builds
// the message to send to the session: a <cockpit-attachment> marker (carrying
// display metadata the fold turns into a card) followed by a fixed guidance prompt
// that points the agent at the absolute path. The marker is hidden from display;
// the guidance is what the agent reads.

import { uploadUrl } from './config';

export interface UploadedFile {
  kind: 'image' | 'file';
  name: string;
  url: string;
  path: string;
  size: number;
  mime: string;
}

const MAX_BYTES = 25 * 1024 * 1024;

export async function uploadFile(file: File): Promise<UploadedFile> {
  if (file.size > MAX_BYTES) throw new Error(`文件过大（上限 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB）`);
  const mime = file.type || 'application/octet-stream';
  const res = await fetch(uploadUrl(file.name, mime), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    credentials: 'include',
    body: file,
  });
  if (!res.ok) throw new Error(`上传失败 (${res.status})`);
  return res.json() as Promise<UploadedFile>;
}

// Build the message text: the marker (parsed + hidden by the fold) + a fixed
// guidance prompt the agent reads to locate and inspect the file.
export function buildAttachmentMessage(f: UploadedFile): string {
  const enc = encodeURIComponent;
  const marker = `<cockpit-attachment kind="${f.kind}" name="${enc(f.name)}" url="${enc(f.url)}" size="${f.size}" mime="${enc(f.mime)}"></cockpit-attachment>`;
  const guidance = f.kind === 'image'
    ? `我上传了一张图片「${f.name}」，已保存到服务器路径：\n${f.path}\n请读取该路径查看图片内容。`
    : `我上传了一个文件「${f.name}」，已保存到服务器路径：\n${f.path}\n请读取该路径查看文件内容。`;
  return `${marker}\n${guidance}`;
}
