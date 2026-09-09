import type { CopilotClient } from '@github/copilot-sdk';
import { MAX_TOOL_IMAGE_BYTES, ToolImageRead, type ToolImage } from '@cockpit/protocol';
import { normalizeEvent, type SdkEvent } from './sdk-types.ts';

type ReadEvents = CopilotClient['rpc']['sessions']['readPersistedEvents'];
const supported = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

function parts(event: SdkEvent): unknown[] {
  const binary = record(event.data.result).binaryResultsForLlm;
  return Array.isArray(binary) ? binary : [];
}

export function toolImagesOf(event: SdkEvent): ToolImage[] {
  if (event.type !== 'tool.execution_complete' || !event.id || typeof event.data.toolCallId !== 'string') return [];
  return parts(event).flatMap((value, part) => {
    const item = record(value);
    if (item.type !== 'image' && !(typeof item.mimeType === 'string' && item.mimeType.startsWith('image/'))) return [];
    const mime = typeof item.mimeType === 'string' && item.mimeType.length <= 512 ? item.mimeType : '';
    const data = typeof item.data === 'string' ? item.data : undefined;
    const byteLength = typeof item.byteLength === 'number' && Number.isSafeInteger(item.byteLength) && item.byteLength >= 0
      ? item.byteLength : data ? Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : undefined;
    const unavailable = item.omittedReason === 'too_large' || (byteLength ?? 0) > MAX_TOOL_IMAGE_BYTES
      ? '原生图片超过 10 MB 预览上限或未被原生历史保存。'
      : item.omittedReason ? '原生历史省略了图片字节。'
      : !supported.has(mime) ? `不支持安全预览此图片格式：${mime || '未知 MIME'}`
      : !data ? '原生历史没有可读取的图片字节。' : undefined;
    return [{ eventId: event.id!, toolCallId: String(event.data.toolCallId), part, mime, byteLength, unavailable }];
  });
}

export class ToolImageError extends Error {
  constructor(message: string, readonly statusCode = 410) { super(message); }
}

function signature(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function imageResult(event: SdkEvent, request: ToolImageRead) {
  const ref = request.image;
  if (event.type !== 'tool.execution_complete' || event.data.toolCallId !== ref.toolCallId) {
    throw new ToolImageError('图片与此工具结果不匹配。', 404);
  }
  const descriptor = toolImagesOf(event).find(image => image.part === ref.part);
  if (!descriptor) throw new ToolImageError('此工具结果没有该图片。', 404);
  if (descriptor.unavailable) throw new ToolImageError(descriptor.unavailable, 422);
  const data = record(parts(event)[ref.part]).data;
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(MAX_TOOL_IMAGE_BYTES / 3)) {
    throw new ToolImageError('图片字节缺失或超过 10 MB 预览上限。', 413);
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_TOOL_IMAGE_BYTES || bytes.toString('base64') !== data) {
    throw new ToolImageError('原生图片编码损坏或过大。', 422);
  }
  const mime = signature(bytes);
  if (!mime || mime !== descriptor.mime) throw new ToolImageError('图片内容与 MIME 不一致或数据损坏。', 422);
  return { sessionId: request.sessionId, eventId: event.id!, toolCallId: ref.toolCallId,
    part: ref.part, mime, byteLength: bytes.length, data };
}

// Cursor hints are native locators, never paths, URLs, or authorization tokens.
// Always re-read the requested session and verify the immutable event/tool IDs.
export async function readToolImage(read: ReadEvents, request: ToolImageRead, signal?: AbortSignal) {
  request = ToolImageRead.parse(request);
  let cursor = request.image.cursor;
  let remaining = cursor ? request.image.count ?? 1 : Infinity;
  do {
    signal?.throwIfAborted();
    const page = await read({ sessionId: request.sessionId, direction: 'backward', cursor,
      max: 1 });
    signal?.throwIfAborted();
    if (page.cursorStatus === 'expired') throw new ToolImageError('图片历史定位已失效，请刷新此工具的历史后重试。');
    const event = page.events.find(event => event.id === request.image.eventId);
    if (event) return imageResult(normalizeEvent(event), request);
    if (--remaining <= 0 || !page.hasMore) break;
    if (page.cursor === cursor) throw new ToolImageError('原生图片历史读取未前进。');
    cursor = page.cursor;
  } while (true);
  throw new ToolImageError('图片尚未保存、已删除或已随原生历史失效；请刷新历史后重试。');
}
