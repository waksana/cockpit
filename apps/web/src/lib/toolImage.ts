import { MAX_TOOL_IMAGE_BYTES, ToolImageResult, type ToolImageRead } from '@cockpit/protocol';
import { intentUrl } from './config';

export async function loadToolImage(request: ToolImageRead, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(intentUrl('session/tool-image'), {
    method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('图片响应没有内容。');
  // JSON framing is small; the bytes themselves are bounded by native's 10 MB limit.
  const max = 4 * Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) + 16384;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('图片响应超过原生预览上限。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const text = await new Blob(chunks).text();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('图片接口返回了无效响应，请确认登录状态。'); }
  if (!response.ok) {
    const error = raw && typeof raw === 'object' && 'error' in raw ? raw.error : undefined;
    throw new Error(typeof error === 'string' ? error : `图片读取失败（HTTP ${response.status}）。`);
  }
  const image = ToolImageResult.parse(raw);
  if (image.sessionId !== request.sessionId || image.eventId !== request.image.eventId
    || image.toolCallId !== request.image.toolCallId || image.part !== request.image.part) {
    throw new Error('图片来源与当前工具结果不匹配。');
  }
  const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0));
  if (bytes.length !== image.byteLength || !bytes.length) throw new Error('图片数据长度不一致。');
  signal.throwIfAborted();
  return new Blob([bytes], { type: image.mime });
}
