import { Attachment, UploadedFile } from '@cockpit/protocol';
import { BASE_URL, uploadUrl } from './config';

const MAX_BYTES = 25 * 1024 * 1024;
const UNSAFE_TEXT = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?: *; *[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"(?:[^"\\]|\\.)*"))*$/i;

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !UNSAFE_TEXT.test(value);
}

export function attachmentHref(url: string, baseUrl: string = BASE_URL): string | undefined {
  if (!safeText(url) || url !== url.trim() || url.includes('\\')) return undefined;

  // Validate the raw path before URL parsing can normalize away traversal.
  const absolute = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/i.exec(url);
  const match = /^\/uploads\/([^/?#]+)$/.exec(absolute ? absolute[1] ?? '/' : url);
  if (!match) return undefined;

  try {
    const asset = decodeURIComponent(match[1]);
    if (!safeText(asset) || asset === '.' || asset === '..' || /[/\\?#]/.test(asset)
      // Nested escapes are ambiguous across proxies and repeated decoding.
      || /%[a-f0-9]{2}/i.test(asset)) return undefined;
    const path = `/uploads/${encodeURIComponent(asset)}`;
    const origin = baseUrl || (typeof location === 'undefined' ? undefined : location.origin);
    if (!origin) return absolute ? undefined : path;
    if (!safeText(origin) || origin !== origin.trim() || origin.includes('\\')
      || !/^https?:\/\//i.test(origin)) return undefined;

    const base = new URL(origin);
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) return undefined;
    if (absolute) {
      const target = new URL(url);
      if (target.origin !== base.origin || target.username || target.password) return undefined;
    }
    return baseUrl ? `${base.origin}${path}` : path;
  } catch {
    return undefined;
  }
}

export function validateUploadFile(file: File): void {
  if (file.webkitRelativePath) throw new Error('不支持上传目录，请选择单个或多个文件。');
  if (!file.size) throw new Error('不能上传空文件。');
  if (file.size > MAX_BYTES) throw new Error('文件过大（上限 25 MiB）');
}

export async function uploadFile(file: File, sessionId?: string, sourceId?: string): Promise<UploadedFile> {
  validateUploadFile(file);
  const mime = file.type || 'application/octet-stream';
  const res = await fetch(`${uploadUrl(file.name, mime)}&source=web${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    credentials: 'include',
    body: file,
  });
  if (!res.ok) throw new Error(`上传失败 (${res.status})`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('上传响应无效');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('上传响应无效');
  const { kind, name, url, path, size, mime: uploadedMime } = data as Record<string, unknown>;
  if ((kind !== 'image' && kind !== 'file') || !safeText(name) || !safeText(path)
    || typeof url !== 'string' || !attachmentHref(url)
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES
    || !safeText(uploadedMime) || uploadedMime.length > 512 || !MIME_PATTERN.test(uploadedMime)) {
    throw new Error('上传响应无效');
  }
  const parsed = UploadedFile.safeParse(data);
  if (!parsed.success) throw new Error('上传响应无效');
  return parsed.data;
}

export function uploadedAttachment(file: Attachment): Attachment {
  const parsed = Attachment.safeParse(file);
  if (!parsed.success) throw new Error('附件信息无效');
  const { kind, name, url, size, mime } = parsed.data;
  if (!safeText(name) || !attachmentHref(url)
    || (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES))
    || (mime !== undefined && (!safeText(mime) || mime.length > 512 || !MIME_PATTERN.test(mime)))) {
    throw new Error('附件信息无效');
  }
  return { kind, name, url, size, mime };
}
