// Uploads outlive sessions. Sidecars, not filenames or client attachment fields,
// are authoritative for new uploads; untracked legacy files remain read-only.
import fs from 'node:fs';
import { basename, join, extname, resolve, parse, sep, dirname } from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { copilotPath } from '@cockpit/core';
import type { Attachment, UploadedFile } from '@cockpit/protocol';

export const UPLOAD_DIR = process.env.COCKPIT_UPLOAD_DIR
  ? process.env.COCKPIT_UPLOAD_DIR
  : copilotPath('cockpit-uploads');

export type UploadResult = UploadedFile & { storedName: string };
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ROOT = resolve(UPLOAD_DIR);
const METADATA_DIR = join(ROOT, '.metadata');
const MAX_METADATA_BYTES = 4096;
// Missing metadata must never downgrade a crashed/new upload to legacy MIME.
const STORED_PREFIX = 'upload-v1-';
const MIME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*(?: *; *[a-zA-Z0-9!#$&^_.+-]+=(?:[a-zA-Z0-9!#$&^_.+-]+|"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"))*(?![\s\S])/;

export class UploadError extends Error {
  constructor(message: string, public readonly statusCode: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'UploadError';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function storageError(error: unknown): UploadError {
  if (hasCode(error, 'ENOSPC') || hasCode(error, 'EDQUOT')) {
    return new UploadError('File storage is full; upload refused. Existing files were not deleted.', 507, error);
  }
  return error instanceof UploadError ? error : new UploadError('Upload storage failed', 500, error);
}

function safeStoredName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}(?![\s\S])/.test(name)
    && !name.includes('..');
}

export function validateUploadInput(originalName: unknown, mime: unknown): { name: string; mime: string } {
  if (typeof originalName !== 'string' || typeof mime !== 'string') {
    throw new UploadError('Upload name and MIME must be strings', 400);
  }
  if (mime.length > 512 || (mime !== '' && !MIME_PATTERN.test(mime))) {
    throw new UploadError('Invalid upload MIME', 400);
  }
  // Preserve literal percent signs and display-only path characters. Never decode
  // the name: the HTTP framework already decoded the query parameter.
  const name = originalName.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
    .slice(0, 200).replace(/[\uD800-\uDBFF]$/, '').trim() || 'file';
  return { name, mime: mime || 'application/octet-stream' };
}

function syncDirectory(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDirectory(path: string, create: boolean): boolean {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      if (!create) return false;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        syncDirectory(dirname(current));
      } catch (mkdirError) {
        if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new UploadError('Upload directory must be a real directory, not a symlink', 500);
    }
    if (current === path && ((stat.mode & 0o022) !== 0
      || (process.getuid && stat.uid !== process.getuid()))) {
      throw new UploadError('Upload directory has unsafe ownership or permissions', 500);
    }
  }
  return true;
}

function openRegular(path: string, limit: number): { fd: number; size: number } | null {
  let fd: number;
  try {
    // NONBLOCK avoids hanging on a planted FIFO; NOFOLLOW rejects even dangling
    // symlinks. Stream the checked descriptor rather than reopening the path.
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new UploadError('Upload storage contains an unsafe file', 500);
    }
    if (stat.size > limit) throw new UploadError('Stored upload exceeds its size limit', 500);
    return { fd, size: stat.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

interface Metadata {
  version: 1;
  storedName: string;
  name: string;
  mime: string;
  size: number;
  createdAt?: number;
  sha256?: string;
  source?: 'web' | 'mcp' | 'weixin' | 'tool-image';
  sessionId?: string;
  sourceId?: string;
}

function readMetadata(storedName: string, size: number): Metadata | null {
  if (!ensureDirectory(METADATA_DIR, false)) return null;
  const file = openRegular(join(METADATA_DIR, `${storedName}.json`), MAX_METADATA_BYTES);
  if (!file) return null;
  let value: unknown;
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(file.fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_METADATA_BYTES) throw new Error('Oversized metadata');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } catch (error) {
    throw new UploadError('Corrupt upload metadata', 500, error);
  } finally {
    fs.closeSync(file.fd);
  }
  if (!value || typeof value !== 'object') throw new UploadError('Corrupt upload metadata', 500);
  const data = value as Partial<Metadata>;
  try {
    const input = validateUploadInput(data.name, data.mime);
    if (data.version !== 1 || data.storedName !== storedName || data.size !== size
      || !Number.isSafeInteger(data.size) || data.name !== input.name || data.mime !== input.mime) {
      throw new Error('Metadata does not match the stored file');
    }
    if (data.sha256 !== undefined && (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256))) throw new Error('Invalid digest');
    if (data.createdAt !== undefined && (!Number.isSafeInteger(data.createdAt) || data.createdAt < 0)) throw new Error('Invalid creation time');
    validateUploadContext(data);
  } catch (error) {
    throw new UploadError('Corrupt upload metadata', 500, error);
  }
  return data as Metadata;
}

function kindFromMime(mime: string): 'image' | 'file' {
  return mime.toLowerCase().startsWith('image/') ? 'image' : 'file';
}

function result(storedName: string, name: string, mime: string, size: number): UploadResult {
  return { kind: kindFromMime(mime), name, storedName, url: `/uploads/${storedName}`,
    path: join(ROOT, storedName), size, mime };
}

export function saveUpload(buffer: Buffer, originalName: string, mime: string): UploadResult {
  const input = validateUploadInput(originalName, mime);
  if (!Buffer.isBuffer(buffer)) throw new UploadError('Upload body must be a buffer', 400);
  if (buffer.length > MAX_UPLOAD_BYTES) throw new UploadError('Upload exceeds 25 MB', 413);
  try {
    ensureDirectory(ROOT, true);
    ensureDirectory(METADATA_DIR, true);
    const ext = extname(input.name).toLowerCase();
    for (let attempt = 0; attempt < 5; attempt++) {
      const storedName = `${STORED_PREFIX}${Date.now()}-${crypto.randomBytes(16).toString('hex')}`
        + (/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '');
      const upload = result(storedName, input.name, input.mime, buffer.length);
      const metadata: Metadata = { version: 1, storedName, ...input, size: buffer.length };
      const finalPath = join(METADATA_DIR, `${storedName}.json`);
      // An orphaned sidecar must not momentarily describe a new, partial file.
      try {
        fs.lstatSync(finalPath);
        continue;
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      const pendingPath = join(METADATA_DIR, `.pending-${crypto.randomBytes(16).toString('hex')}`);
      const owned = new Set<string>();
      const writeExclusive = (path: string, bytes: Buffer | string) => {
        const fd = fs.openSync(path,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        owned.add(path);
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      };
      try {
        writeExclusive(upload.path, buffer);
        syncDirectory(ROOT);
        writeExclusive(pendingPath, JSON.stringify(metadata));
        // A hard link publishes the complete, fsynced sidecar atomically without
        // rename's overwrite behavior. Reserved names fail closed before this.
        fs.linkSync(pendingPath, finalPath);
        owned.add(finalPath);
        fs.unlinkSync(pendingPath);
        owned.delete(pendingPath);
        syncDirectory(METADATA_DIR);
        return upload;
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        for (const path of [...owned].reverse()) {
          try { fs.unlinkSync(path); } catch (cleanupError) {
            if (!hasCode(cleanupError, 'ENOENT')) cleanupErrors.push(cleanupError);
          }
        }
        if (owned.size) {
          for (const path of [METADATA_DIR, ROOT]) {
            try { syncDirectory(path); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
          }
        }
        if (cleanupErrors.length) {
          throw new UploadError('Upload storage rollback failed', 500,
            new AggregateError([error, ...cleanupErrors]));
        }
        if (!hasCode(error, 'EEXIST')) throw error;
      }
    }
    throw new UploadError('Could not allocate an exclusive upload name', 500);
  } catch (error) {
    throw storageError(error);
  }
}

export function resolveUpload(storedName: string): UploadResult | null {
  if (!safeStoredName(storedName)) return null;
  try {
    if (!ensureDirectory(ROOT, false)) return null;
    const file = openRegular(join(ROOT, storedName), MAX_UPLOAD_BYTES);
    if (!file) return null;
    let prefix: Buffer;
    try {
      const bytes = Buffer.alloc(Math.min(4096, file.size));
      const count = fs.readSync(file.fd, bytes, 0, bytes.length, 0);
      prefix = bytes.subarray(0, count);
    } finally { fs.closeSync(file.fd); }
    const metadata = readMetadata(storedName, file.size);
    if (metadata) {
      return { ...result(storedName, metadata.name, metadata.mime, metadata.size),
        ...validateUploadContext(metadata),
        ...(metadata.createdAt === undefined ? {} : { createdAt: metadata.createdAt }),
        ...(metadata.sha256 === undefined ? {} : { sha256: metadata.sha256 }) };
    }
    if (storedName.startsWith(STORED_PREFIX)) throw new UploadError('Upload metadata is missing', 500);
    return result(storedName, storedName, detectedMime(prefix, mimeForStored(storedName)), file.size);
  } catch (error) {
    throw storageError(error);
  }
}

export function resolveStoredAttachment(attachment: Attachment): UploadResult {
  const url = attachment?.url;
  // Do not URL-parse or decode: only the literal local upload URL is accepted.
  if (typeof url !== 'string' || !url.startsWith('/uploads/') || !safeStoredName(url.slice(9))) {
    throw new UploadError('Attachment URL must be /uploads/<safe-basename>', 400);
  }
  const upload = resolveUpload(url.slice(9));
  if (!upload) throw new UploadError('Attachment upload was not found', 404);
  return upload;
}

const verifiedFiles = new Map<string, { stamp: string; sha256: string }>();

function verifyDescriptor(fd: number, upload: UploadResult): void {
  if (!upload.sha256) return; // Legacy files have no recorded original digest.
  const stamp = () => {
    const stat = fs.fstatSync(fd, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  const before = stamp();
  const cached = verifiedFiles.get(upload.path);
  if (cached?.stamp === before && cached.sha256 === upload.sha256) return;
  const hash = crypto.createHash('sha256');
  const bytes = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const count = fs.readSync(fd, bytes, 0, bytes.length, position);
    if (!count) break;
    position += count;
    if (position > upload.size) throw new UploadError('Stored upload changed during integrity checking', 500);
    hash.update(bytes.subarray(0, count));
  }
  if (position !== upload.size || stamp() !== before || hash.digest('hex') !== upload.sha256) {
    throw new UploadError('Stored upload integrity check failed; original bytes have changed', 500);
  }
  // Cache only verified descriptor identity/timestamps, never media bytes. Seeking
  // unchanged video does not re-read its entire original for every range request.
  if (verifiedFiles.size >= 256) verifiedFiles.delete(verifiedFiles.keys().next().value!);
  verifiedFiles.set(upload.path, { stamp: before, sha256: upload.sha256 });
}

export function verifyUpload(upload: UploadResult): UploadResult {
  if (!safeStoredName(upload.storedName) || upload.path !== join(ROOT, upload.storedName)) {
    throw new UploadError('Invalid managed file path', 400);
  }
  try {
    const file = openRegular(upload.path, MAX_UPLOAD_BYTES);
    if (!file) throw new UploadError('Upload was not found', 404);
    try { verifyDescriptor(file.fd, upload); }
    finally { fs.closeSync(file.fd); }
    return upload;
  } catch (error) { throw storageError(error); }
}

export function openUpload(path: string, range?: { start: number; end: number }): Readable {
  if (typeof path !== 'string' || !safeStoredName(basename(path)) || path !== join(ROOT, basename(path))) {
    throw new UploadError('Invalid upload path', 400);
  }
  try {
    const upload = resolveUpload(basename(path));
    if (!upload) throw new UploadError('Upload was not found', 404);
    const file = openRegular(path, MAX_UPLOAD_BYTES);
    if (!file) throw new UploadError('Upload was not found', 404);
    if (file.size !== upload.size) {
      fs.closeSync(file.fd);
      throw new UploadError('Upload changed while opening', 500);
    }
    try { verifyDescriptor(file.fd, upload); }
    catch (error) { fs.closeSync(file.fd); throw error; }
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end >= file.size)) {
      fs.closeSync(file.fd);
      throw new UploadError('Invalid upload byte range', 416);
    }
    if (file.size === 0) {
      fs.closeSync(file.fd);
      return Readable.from([]);
    }
    try {
      return fs.createReadStream(path, { fd: file.fd, autoClose: true,
        start: range?.start ?? 0, end: range?.end ?? file.size - 1 });
    } catch (error) {
      fs.closeSync(file.fd);
      throw error;
    }
  } catch (error) {
    throw storageError(error);
  }
}

export interface UploadContext {
  source?: Metadata['source'];
  sessionId?: string;
  sourceId?: string;
}

export function validateUploadContext(context: UploadContext): UploadContext {
  if (context.source !== undefined && !['web', 'mcp', 'weixin', 'tool-image'].includes(context.source)) {
    throw new UploadError('Invalid file source', 400);
  }
  if (context.sessionId !== undefined && (typeof context.sessionId !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/.test(context.sessionId))) {
    throw new UploadError('Invalid file session', 400);
  }
  if (context.sourceId !== undefined && (typeof context.sourceId !== 'string'
    || !context.sourceId.length || context.sourceId.length > 512 || /[\x00-\x1f]/.test(context.sourceId)
    || !context.source || !context.sessionId)) {
    throw new UploadError('File sourceId requires source and sessionId', 400);
  }
  return { ...(context.source ? { source: context.source } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}) };
}

// Signatures choose preview eligibility. A name or browser-declared image/video
// MIME never turns arbitrary bytes into an active same-origin document.
export function detectedMime(bytes: Buffer, declared: string): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'mif1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (['isom', 'iso2', 'iso5', 'iso6', 'iso8', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash'].includes(brand)) return 'video/mp4';
  }
  if (bytes.subarray(0, 4).toString('hex') === '1a45dfa3' && bytes.includes(Buffer.from('webm'))) return 'video/webm';
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 4).toString('hex') === '504b0304') return 'application/zip';
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); }
  catch { return 'application/octet-stream'; }
  if (text.includes('\0')) return 'application/octet-stream';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return 'image/svg+xml';
  const mime = declared.split(';')[0]!.toLowerCase();
  if (['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(mime)) return mime;
  return 'application/octet-stream';
}

const sourceWrites = new Map<string, Promise<UploadResult>>();

function sourceStoredName(key: string): string | undefined {
  if (!ensureDirectory(ROOT, false)) return undefined;
  const prefix = `${STORED_PREFIX}source-${key}`;
  const names = fs.readdirSync(ROOT).filter(name => name === prefix
    || (name.startsWith(`${prefix}.`) && /^\.[a-z0-9]{1,10}$/.test(name.slice(prefix.length))));
  if (names.length > 1) throw new UploadError('Retained source has conflicting stored identities', 409);
  return names[0];
}

export function retainedSource(context: UploadContext): UploadResult | null {
  const valid = validateUploadContext(context);
  if (!valid.sourceId) return null;
  const key = crypto.createHash('sha256').update(JSON.stringify([valid.source, valid.sessionId, valid.sourceId])).digest('hex');
  const storedName = sourceStoredName(key);
  return storedName ? resolveUpload(storedName) : null;
}

function nativeExtension(mime: string, name: string): string {
  const extensions: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/heic': '.heic',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'application/pdf': '.pdf',
    'application/zip': '.zip', 'text/plain': '.txt', 'text/markdown': '.md',
    'text/csv': '.csv', 'application/json': '.json',
  };
  // Native view dispatches images by extension. Only byte-recognized formats get
  // image/video suffixes; the original user filename remains display metadata.
  if (extensions[mime]) return extensions[mime]!;
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) && !mimeForStored(`file${ext}`).startsWith('image/')
    && !['.mp4', '.webm', '.mov', '.mkv', '.html', '.htm', '.svg', '.js'].includes(ext) ? ext : '.bin';
}

export async function saveUploadStream(
  stream: AsyncIterable<Uint8Array>, originalName: string, mime: string, context: UploadContext = {},
): Promise<UploadResult> {
  const input = validateUploadInput(originalName, mime);
  const origin = validateUploadContext(context);
  const key = origin.sourceId
    ? crypto.createHash('sha256').update(JSON.stringify([origin.source, origin.sessionId, origin.sourceId])).digest('hex')
    : crypto.randomBytes(16).toString('hex');
  // Serialize a repeated stable source inside this process; never race publication.
  const previous = sourceWrites.get(key);
  const operation = (async () => {
    if (previous) {
      try { await previous; }
      catch (error) {
        // The preceding caller owns its failure. A new request waits for release,
        // then validates its own complete bytes rather than inheriting a timeout.
        if (!(error instanceof UploadError)) throw error;
      }
    }
    return writeUploadStream(stream, input, origin, key);
  })();
  sourceWrites.set(key, operation);
  try { return await operation; }
  finally { if (sourceWrites.get(key) === operation) sourceWrites.delete(key); }
}

async function writeUploadStream(
  stream: AsyncIterable<Uint8Array>, input: { name: string; mime: string }, origin: UploadContext, key: string,
): Promise<UploadResult> {
  const owned = new Set<string>();
  let fd: number | undefined;
  let retained: UploadResult | undefined;
  try {
    ensureDirectory(ROOT, true);
    ensureDirectory(METADATA_DIR, true);
    const pending = join(ROOT, `.pending-${crypto.randomBytes(16).toString('hex')}`);
    fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    owned.add(pending);
    let size = 0;
    let prefix = Buffer.alloc(0);
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new UploadError('Invalid binary upload stream', 400);
      size += chunk.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new UploadError('Upload exceeds 25 MiB', 413);
      if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
      hash.update(chunk);
      fs.writeFileSync(fd, chunk);
    }
    if (size === 0) throw new UploadError('Empty upload body', 400);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const sha256 = hash.digest('hex');
    const detected = detectedMime(prefix, input.mime);
    const ext = nativeExtension(detected, input.name);
    const storedName = origin.sourceId ? sourceStoredName(key) ?? `${STORED_PREFIX}source-${key}${ext}`
      : `${STORED_PREFIX}${Date.now()}-${key}${ext}`;
    let existing: UploadResult | null;
    let resumeUnpublished = false;
    try { existing = resolveUpload(storedName); }
    catch (error) {
      if (!origin.sourceId || !(error instanceof UploadError) || error.message !== 'Upload metadata is missing') throw error;
      const orphan = openRegular(join(ROOT, storedName), MAX_UPLOAD_BYTES);
      if (!orphan) throw error;
      const digest = crypto.createHash('sha256');
      try {
        const chunk = Buffer.alloc(64 * 1024);
        let count: number;
        let total = 0;
        while ((count = fs.readSync(orphan.fd, chunk, 0, chunk.length, null)) > 0) {
          total += count;
          if (total > size) throw new UploadError('Interrupted source changed during recovery', 409);
          digest.update(chunk.subarray(0, count));
        }
      } finally { fs.closeSync(orphan.fd); }
      if (orphan.size !== size || digest.digest('hex') !== sha256) {
        throw new UploadError('Interrupted retained source has different bytes; not overwritten', 409);
      }
      // A crash can leave the durable data link before its metadata publication.
      // Only a byte-identical retry of the same explicit source can complete it.
      existing = null;
      resumeUnpublished = true;
    }
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== size
        || existing.source !== origin.source || existing.sessionId !== origin.sessionId || existing.sourceId !== origin.sourceId) {
        throw new UploadError('Retained source already exists with different bytes; not overwritten', 409);
      }
      fs.unlinkSync(pending);
      owned.delete(pending);
      return verifyUpload(existing);
    }
    const metadata: Metadata = { version: 1, storedName, name: input.name,
      mime: detected, size, sha256, createdAt: Date.now(), ...origin };
    const metadataJson = JSON.stringify(metadata);
    if (Buffer.byteLength(metadataJson) > MAX_METADATA_BYTES) throw new UploadError('File metadata exceeds the supported size', 400);
    const upload: UploadResult = { ...result(storedName, metadata.name, metadata.mime, size),
      sha256, createdAt: metadata.createdAt, ...origin };
    const metadataPending = join(METADATA_DIR, `.pending-${key}-${crypto.randomBytes(8).toString('hex')}`);
    const metadataPath = join(METADATA_DIR, `${storedName}.json`);
    fd = fs.openSync(metadataPending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    owned.add(metadataPending);
    fs.writeFileSync(fd, metadataJson);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!resumeUnpublished) {
      fs.linkSync(pending, upload.path);
      owned.add(upload.path);
    }
    syncDirectory(ROOT);
    fs.linkSync(metadataPending, metadataPath);
    owned.add(metadataPath);
    syncDirectory(METADATA_DIR);
    retained = upload;
    owned.delete(upload.path);
    owned.delete(metadataPath);
    fs.unlinkSync(pending);
    owned.delete(pending);
    fs.unlinkSync(metadataPending);
    owned.delete(metadataPending);
    owned.clear();
    return upload;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    const failures: unknown[] = [];
    for (const path of [...owned].reverse()) {
      try { fs.unlinkSync(path); }
      catch (cleanup) { if (!hasCode(cleanup, 'ENOENT')) failures.push(cleanup); }
    }
    if (retained) throw new UploadError(`Original retained at ${retained.url}; upload temporary-link cleanup failed`, 500,
      new AggregateError([error, ...failures]));
    if (failures.length) throw new UploadError('Upload failed and temporary-file cleanup failed', 500,
      new AggregateError([error, ...failures]));
    throw storageError(error);
  }
}

export function associateUpload(url: string, sessionId: string): UploadResult {
  validateUploadContext({ sessionId });
  const file = verifyUpload(resolveStoredAttachment({ kind: 'file', name: '', url }));
  try {
    const dir = join(ROOT, '.associations', sessionId);
    ensureDirectory(dir, true);
    const path = join(dir, basename(file.url));
    let fd: number;
    try { fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const existing = openRegular(path, 0);
      if (!existing) throw new Error('File association disappeared');
      fs.closeSync(existing.fd);
      return file;
    }
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(dir);
    return file;
  } catch (error) { throw storageError(error); }
}

export function uploadDetails(url: string): UploadResult {
  const upload = verifyUpload(resolveStoredAttachment({ kind: 'file', name: '', url }));
  const sessions = new Set(upload.sessionId ? [upload.sessionId] : []);
  try {
    const directory = join(ROOT, '.associations');
    if (ensureDirectory(directory, false)) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        validateUploadContext({ sessionId: entry.name });
        if (!entry.isDirectory() || !ensureDirectory(join(directory, entry.name), false)) {
          throw new UploadError('File association directory is unsafe', 500);
        }
        const marker = openRegular(join(directory, entry.name, upload.storedName), 0);
        if (marker) {
          fs.closeSync(marker.fd);
          sessions.add(entry.name);
        }
      }
    }
    return { ...upload, sessions: [...sessions].sort() };
  } catch (error) { throw storageError(error); }
}

export function listUploads(options: { query?: string; sessionId?: string; limit?: number; offset?: number }) {
  try {
    if (!ensureDirectory(ROOT, false)) return { files: [], hasMore: false };
    if (options.sessionId) validateUploadContext({ sessionId: options.sessionId });
    const query = (options.query ?? '').toLocaleLowerCase();
    const dir = options.sessionId ? join(ROOT, '.associations', options.sessionId) : undefined;
    const associated = new Set(dir && ensureDirectory(dir, false) ? fs.readdirSync(dir) : []);
    const files: UploadResult[] = [];
    const errors: { url: string; error: string }[] = [];
    // This is only the existing managed directory. Hidden pending/metadata entries
    // are not library files, and legacy originals are not moved or rewritten.
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!safeStoredName(entry.name)) continue;
      if (!entry.isFile()) throw new UploadError('Managed directory contains an unsafe entry', 500);
      let file: UploadResult | null;
      try { file = resolveUpload(entry.name); }
      catch (error) {
        if (!(error instanceof UploadError)) throw error;
        errors.push({ url: `/uploads/${entry.name}`, error: error.message });
        continue;
      }
      if (!file) throw new UploadError('File disappeared while listing; retry the listing', 409);
      if (options.sessionId && file.sessionId !== options.sessionId && !associated.has(entry.name)) continue;
      if (query && !`${file.name} ${file.mime} ${file.source ?? ''}`.toLocaleLowerCase().includes(query)) continue;
      files.push(file);
    }
    files.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.url.localeCompare(b.url));
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const hasMore = offset + limit < files.length + errors.length;
    const pageErrors = errors.slice(Math.max(0, offset - files.length), Math.max(0, offset + limit - files.length));
    return { files: files.slice(offset, offset + limit), hasMore,
      ...(pageErrors.length ? { errors: pageErrors } : {}),
      ...(hasMore ? { nextOffset: offset + limit } : {}) };
  } catch (error) { throw storageError(error); }
}

// Legacy extensions provide only an inert text hint; media still need signatures.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
};
export function mimeForStored(storedName: string): string {
  return MIME_BY_EXT[extname(storedName).toLowerCase()] ?? 'application/octet-stream';
}
