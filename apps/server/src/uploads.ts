// File uploads. Saved to a FIXED folder outside session-state so they survive
// session deletion (~/.copilot/cockpit-uploads/). The upload endpoint takes a raw
// binary body (the browser sends the File as application/octet-stream with name +
// mime in the query); we never trust the client's path. Serving streams the file
// back through the backend (runs as the operator), avoiding nginx file-permission
// coupling and keeping one canonical path.

import { writeFileSync, createReadStream, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { copilotPath } from '@cockpit/core';

export const UPLOAD_DIR = process.env.COCKPIT_UPLOAD_DIR
  ? process.env.COCKPIT_UPLOAD_DIR
  : copilotPath('cockpit-uploads');

export interface UploadResult {
  kind: 'image' | 'file';
  name: string;     // original (display) filename
  storedName: string;
  url: string;      // /uploads/<storedName> — for the browser
  path: string;     // absolute server path — for the agent's guidance
  size: number;
  mime: string;
}

// A safe stored filename: <timestamp>-<rand><ext>, keeping only the extension from
// the original name (the display name is preserved separately). No user-controlled
// characters reach the filesystem path.
function makeStoredName(originalName: string): string {
  const ext = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  return `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
}

function kindFromMime(mime: string): 'image' | 'file' {
  return mime.startsWith('image/') ? 'image' : 'file';
}

// Persist a raw upload buffer; returns the metadata the client needs to render a
// card + build the agent guidance prompt.
export function saveUpload(buffer: Buffer, originalName: string, mime: string): UploadResult {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const safeName = (originalName || 'file').replace(/[\r\n\t]/g, ' ').slice(0, 200);
  const storedName = makeStoredName(safeName);
  const path = join(UPLOAD_DIR, storedName);
  writeFileSync(path, buffer);
  return {
    kind: kindFromMime(mime),
    name: safeName,
    storedName,
    url: `/uploads/${storedName}`,
    path,
    size: buffer.length,
    mime: mime || 'application/octet-stream',
  };
}

// Resolve a stored upload for serving. Rejects anything that isn't a plain
// basename living directly in UPLOAD_DIR (defends against path traversal).
export function resolveUpload(storedName: string): { path: string; size: number } | null {
  if (!storedName || storedName.includes('/') || storedName.includes('\\') || storedName.includes('..')) return null;
  const path = join(UPLOAD_DIR, storedName);
  if (!existsSync(path)) return null;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { path, size: st.size };
  } catch { return null; }
}

export function openUpload(path: string): Readable {
  return createReadStream(path);
}

// Best-effort MIME from the stored file's extension, so the browser renders
// images inline and downloads others sensibly.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
};
export function mimeForStored(storedName: string): string {
  return MIME_BY_EXT[extname(storedName).toLowerCase()] ?? 'application/octet-stream';
}
