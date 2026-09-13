import { constants, lstatSync, unlinkSync } from 'node:fs';
import { link, lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { UploadedFile } from '@cockpit/protocol';
import { backendRequest, CockpitError, MAX_TRANSFER_BYTES, readBoundedBody, streamBoundedBody } from './cockpit.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip', '.html': 'text/html',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

const UploadMetadata = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string().min(1),
  url: z.string(),
  path: z.string().min(1),
  size: z.number().int().positive().max(MAX_TRANSFER_BYTES),
  mime: z.string().min(1),
  storedName: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).passthrough() satisfies z.ZodType<UploadedFile>;
export type UploadResult = UploadedFile;

export type DownloadResult = Omit<UploadedFile, 'storedName'>;

function within(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

function rootCandidates(direction: 'upload' | 'download'): string[] {
  // Preserve the existing artifact locations; this never reads session state itself.
  const defaults = direction === 'upload'
    ? [
      tmpdir(), '/tmp', '/var/tmp',
      join(homedir(), '.copilot', 'session-state'),
      join(homedir(), '.copilot', 'cockpit-uploads'),
    ]
    : [process.cwd()];
  const variable = direction === 'upload' ? 'COCKPIT_UPLOAD_DIRS' : 'COCKPIT_DOWNLOAD_DIRS';
  const extra = (process.env[variable] ?? '').split(delimiter).map((root) => root.trim()).filter(Boolean);
  if (extra.some((root) => !isAbsolute(root))) {
    throw new Error(`${variable} must contain only absolute directories separated by ${JSON.stringify(delimiter)}.`);
  }
  return [...new Set([...defaults, ...extra].map((root) => resolve(root)))];
}

function validateLocalPath(input: string): void {
  if (!isAbsolute(input)) throw new Error(`refusing ${input}: an absolute path is required.`);
  if (/[\u0000-\u001f\u007f]/.test(input) || input.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
    throw new Error(`refusing ${input}: traversal and control characters are not allowed.`);
  }
}

async function approvedRoot(input: string, direction: 'upload' | 'download'): Promise<{ lexical: string; real: string }> {
  const candidates = rootCandidates(direction);
  const lexicalRoot = candidates.filter((root) => within(input, root)).sort((a, b) => b.length - a.length)[0];
  if (!lexicalRoot) {
    throw new Error(`refusing ${input}: outside the allowed ${direction} directories. `
      + `Allowed roots: ${candidates.join(', ')}. Configure COCKPIT_${direction.toUpperCase()}_DIRS to allow another root.`);
  }
  const root = await realpath(lexicalRoot);
  if (!(await stat(root)).isDirectory()) throw new Error(`Allowed ${direction} root is not a directory: ${lexicalRoot}`);
  return { lexical: lexicalRoot, real: root };
}

async function uploadSource(input: string): Promise<{ path: string; root: string }> {
  validateLocalPath(input);
  const root = await approvedRoot(input, 'upload');
  let real: string;
  try {
    real = await realpath(input);
  } catch (error) {
    throw new Error(`cannot resolve ${input}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!within(real, root.real)) {
    throw new Error(`refusing ${input}: resolves outside the allowed upload directories.`);
  }
  if (!(await stat(real)).isFile()) throw new Error(`refusing ${input}: not a regular file.`);
  return { path: real, root: root.real };
}

export async function resolveUploadPath(input: string): Promise<string> {
  return (await uploadSource(input)).path;
}

function descriptorPath(directory: FileHandle): string {
  // Node has no openat binding. Descriptor paths pin ancestors against replacement
  // while O_NOFOLLOW protects each next component. Fail closed if unavailable.
  return `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${directory.fd}`;
}

async function pinnedParent(path: string, root: string): Promise<FileHandle> {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error('Secure file transfers require descriptor-relative directories and O_NOFOLLOW support.');
  }
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (await realpath(descriptorPath(directory)) !== root) {
      throw new Error('Allowed transfer root changed while opening; transfer refused.');
    }
    for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
      if (part === '..') throw new Error('Transfer parent is outside the allowed directories.');
      const next = await open(
        join(descriptorPath(directory), part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = next;
    }
    if (!within(await realpath(descriptorPath(directory)), root)) {
      throw new Error('Transfer parent moved outside the allowed directories.');
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

// Accept opaque managed and legacy basenames, not a particular naming scheme.
// MIME and display names come from backend metadata, never from this URL guard.
export function validateUploadUrl(url: string): void {
  if (!/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(url) || url.includes('..')) {
    throw new CockpitError('Expected a backend-relative /uploads/<safe-basename> URL, without query or fragment.', 'protocol');
  }
}

function safeDisplayName(name: string): string {
  if (!name || name.length > 200 || /[/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') {
    throw new Error('Display name must be a safe filename of 1–200 characters, without separators or control characters.');
  }
  return name;
}

function originalDownloadName(response: Response, fallback: string): string {
  const match = /(?:^|;)\s*filename\*=UTF-8''([^;]*)/i.exec(response.headers.get('content-disposition') ?? '');
  if (!match) return fallback;
  let name: string;
  try { name = decodeURIComponent(match[1]!.trim()); }
  catch { throw new CockpitError('Download returned an invalid encoded filename.', 'protocol'); }
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
    throw new CockpitError('Download returned an unsafe display filename.', 'protocol');
  }
  // This is display-only. The caller's separately fenced destination is unchanged.
  return name;
}

export async function uploadFile(
  input: string,
  options: { mime?: string; source?: 'mcp'; sessionId?: string; timeoutMs?: number } = {},
): Promise<UploadResult> {
  const { path: real, root } = await uploadSource(input);
  const parent = await pinnedParent(real, root);
  try {
    const source = await open(join(descriptorPath(parent), basename(real)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await source.stat();
      if (!info.isFile()) throw new Error(`refusing ${input}: not a regular file.`);
      if (!info.size) throw new Error(`File ${input} is empty.`);
      if (info.size > MAX_TRANSFER_BYTES) throw new Error(`File ${input} exceeds the ${MAX_TRANSFER_BYTES} byte upload limit.`);
      const hash = createHash('sha256');
      let digest: string | undefined;
      const stream = Readable.from((async function* () {
        let total = 0;
        while (total <= info.size) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, info.size + 1 - total));
          const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > info.size) throw new Error(`File ${input} changed size while reading; upload refused.`);
          const bytes = buffer.subarray(0, bytesRead);
          hash.update(bytes);
          yield bytes;
        }
        const after = await source.stat();
        if (total !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
          throw new Error(`File ${input} changed while reading; upload refused.`);
        }
        digest = hash.digest('hex');
      })(), { objectMode: false, highWaterMark: 64 * 1024 });
      const name = safeDisplayName(basename(input));
      const mime = options.mime || MIME_BY_EXT[extname(input).toLowerCase()] || 'application/octet-stream';
      if (/[\u0000-\u001f\u007f]/.test(mime)) throw new Error('MIME type cannot contain control characters.');
      const query = new URLSearchParams({ name, mime, source: options.source ?? 'mcp' });
      if (options.sessionId !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.sessionId)) throw new Error('Invalid upload session id.');
        query.set('sessionId', options.sessionId);
      }
      return await backendRequest(`/upload?${query}`, {
        method: 'POST',
        body: stream,
        headers: { 'content-type': 'application/octet-stream' },
        timeoutMs: options.timeoutMs,
      }, async (response) => {
        const text = new TextDecoder().decode(await readBoundedBody(response, 64 * 1024));
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch (error) {
          throw new CockpitError(`Upload returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, 'protocol');
        }
        const parsed = UploadMetadata.safeParse(data);
        if (!parsed.success) throw new CockpitError(`Upload returned invalid metadata: ${parsed.error.message}`, 'protocol');
        validateUploadUrl(parsed.data.url);
        if (!digest) throw new CockpitError('Upload returned before the source stream was verified.', 'protocol');
        if (parsed.data.size !== info.size) throw new CockpitError('Upload returned a mismatched file size.', 'protocol');
        if (parsed.data.sha256 && parsed.data.sha256 !== digest) throw new CockpitError('Upload returned a mismatched SHA-256.', 'protocol');
        return parsed.data;
      });
    } finally {
      await source.close();
    }
  } finally {
    await parent.close();
  }
}

async function downloadDestination(input: string): Promise<{ path: string; root: string; parent: FileHandle }> {
  validateLocalPath(input);
  safeDisplayName(basename(input));
  const root = await approvedRoot(input, 'download');
  const parent = await realpath(dirname(input));
  if (!within(parent, root.real)) throw new Error(`refusing ${input}: outside the allowed download directories.`);
  // Resolve the root once, but do not follow symlinks in its descendant directories.
  let current = root.real;
  for (const part of relative(root.lexical, dirname(input)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing ${input}: download parent must be an existing directory without symlinks.`);
    }
  }
  const path = join(parent, basename(input));
  return { path, root: root.real, parent: await pinnedParent(path, root.real) };
}

export async function downloadFile(
  url: string,
  destination: string,
  options: { name?: string; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  validateUploadUrl(url);
  const name = safeDisplayName(options.name ?? basename(url));
  const { path, root, parent } = await downloadDestination(destination);
  const entry = join(descriptorPath(parent), basename(path));
  const staging = join(descriptorPath(parent), `.cockpit-download-${randomUUID()}`);
  let file: FileHandle | undefined;
  let consumption: Promise<{ size: number; mime: string; name: string; sha256?: string }> | undefined;
  try {
    try {
      await lstat(entry);
      throw Object.assign(new Error(`refusing ${destination}: destination already exists; overwrite is not allowed.`), { code: 'EEXIST' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const output = file;
    const result = await backendRequest(url, { timeoutMs: options.timeoutMs }, (response) => {
      consumption = (async () => {
        if (response.status !== 200) throw new CockpitError('Download requires a complete HTTP 200 response.', 'protocol');
        const hash = createHash('sha256');
        let size = 0;
        for await (const bytes of streamBoundedBody(response)) {
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new Error('Download write made no progress.');
            offset += bytesWritten;
          }
          size += bytes.length;
        }
        const digest = hash.digest('hex');
        const etag = response.headers.get('etag');
        const expected = etag?.match(/^"(?:sha256-)?([a-f0-9]{64})"$/)?.[1];
        if (expected && expected !== digest) throw new CockpitError('Download SHA-256 integrity mismatch.', 'protocol');
        await output.sync();
        const mime = response.headers.get('content-type') || MIME_BY_EXT[extname(url).toLowerCase()] || 'application/octet-stream';
        return { size, mime, name: options.name ?? originalDownloadName(response, name),
          ...(expected ? { sha256: digest } : {}) };
      })();
      return consumption;
    });
    const currentParent = await realpath(descriptorPath(parent));
    if (currentParent !== dirname(path) || !within(currentParent, root)) {
      throw new Error('Download parent changed during the request; download refused.');
    }
    const created = await file.stat();
    const staged = await lstat(staging);
    if (created.dev !== staged.dev || created.ino !== staged.ino) {
      throw new Error('Download staging file changed; download refused.');
    }
    // Hard-link publication is atomic and cannot replace an existing destination.
    await link(staging, entry);
    await parent.sync();
    return {
      kind: result.mime.toLowerCase().startsWith('image/') ? 'image' : 'file',
      url, ...result, path,
    };
  } finally {
    try {
      await consumption?.catch(() => {});
      if (file) {
        try {
          const created = await file.stat();
          const current = lstatSync(staging);
          if (current.dev === created.dev && current.ino === created.ino) unlinkSync(staging);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        } finally {
          await file.close();
        }
      }
    } finally {
      await parent.close();
    }
  }
}
