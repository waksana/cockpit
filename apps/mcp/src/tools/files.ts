// File + filesystem tools: upload a local file into cockpit's shared upload area
// (so it can be delivered into chat as an attachment), and browse directories
// (to pick a cwd for cockpit_new_session). Download/list/delete are intentionally
// omitted: the agent runs on the cockpit host and can view/ls/rm the upload dir
// directly (~/.copilot/cockpit-uploads/); only upload needs the HTTP endpoint
// (it mints the safe stored name + the /uploads URL the chat card requires).
import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep, delimiter } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { COCKPIT_URL, cockpitHome } from '../config.js';
import { CockpitError, intent } from '../cockpit.js';
import { ResponseFormat, ok, fail, capped, cappedJson, shrinkList, type ToolResult } from '../shared.js';

// ── Upload read-side path fence ───────────────────────────────────────────────
// cockpit_upload_file mints a web-reachable /uploads/<rand> URL from whatever local
// path it is given. Without confinement that is a one-call "host secret → externally
// fetchable URL" exfiltration primitive (a bare readFile follows symlinks and reads
// e.g. ~/.ssh/id_rsa, ~/.copilot/session-store.db, cockpit-prefs.json). So before
// reading, canonicalize the path (realpath, which collapses `..` AND resolves every
// symlink) and refuse anything that does not land inside an allowlisted upload root.
// This is a stat-then-refuse fence; the 25 MB size cap is enforced authoritatively by
// the server bodyLimit and is intentionally NOT duplicated here.
//
// Roots default to the conventional agent-artifact locations (system temp + cockpit's
// own session-state / uploads dirs) and can be EXTENDED via COCKPIT_UPLOAD_DIRS
// (a ':'-separated list of absolute dirs) without a code change.
function uploadRootCandidates(): string[] {
  const base = cockpitHome();
  const defaults = [
    tmpdir(),
    '/tmp',
    '/var/tmp',
    join(base, 'session-state'),
    join(base, 'cockpit-uploads'),
  ];
  const extra = (process.env.COCKPIT_UPLOAD_DIRS ?? '')
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set([...defaults, ...extra].map((d) => resolve(d))));
}

// Canonicalize each root (realpath-if-it-exists, lexical otherwise) so the containment
// test compares like-for-like even when a root itself is a symlink (e.g. /tmp).
async function canonicalUploadRoots(): Promise<string[]> {
  const out: string[] = [];
  for (const r of uploadRootCandidates()) {
    try {
      out.push(await realpath(r));
    } catch {
      out.push(r);
    }
  }
  return Array.from(new Set(out));
}

function isWithin(child: string, root: string): boolean {
  if (child === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(base);
}

class UploadFenceError extends Error {}

// Resolve `inputPath` to its real, fence-approved absolute path or throw an
// UploadFenceError explaining the refusal. Returns the canonical path so the caller
// reads the already-resolved target (no second symlink resolution).
export async function resolveUploadPath(inputPath: string): Promise<string> {
  if (!isAbsolute(inputPath)) {
    throw new UploadFenceError(`refusing ${inputPath}: an absolute path is required.`);
  }
  let real: string;
  try {
    real = await realpath(inputPath);
  } catch (e) {
    throw new UploadFenceError(`cannot resolve ${inputPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const st = await stat(real);
  if (!st.isFile()) {
    throw new UploadFenceError(`refusing ${inputPath}: not a regular file.`);
  }
  const roots = await canonicalUploadRoots();
  if (!roots.some((r) => isWithin(real, r))) {
    throw new UploadFenceError(
      `refusing to upload ${inputPath}: it resolves to ${real}, which is outside the allowed ` +
        `upload directories. Allowed roots: ${roots.join(', ')}. Move the file into one of these, ` +
        `or extend the allowlist via COCKPIT_UPLOAD_DIRS, and retry.`,
    );
  }
  return real;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.zip': 'application/zip', '.html': 'text/html',
};

interface UploadResponse {
  kind: 'image' | 'file';
  name: string;
  url: string;
  path: string;
  size: number;
  mime: string;
}

interface DirEntry { name: string; isDir: boolean }
interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

export function registerFileTools(server: McpServer): void {
  // ── cockpit_upload_file ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_upload_file',
    {
      title: 'Upload a file to the cockpit shared area',
      description:
        "Publish a local file into cockpit's fixed upload folder and get back the /uploads/<name> " +
        'URL (and its stored path). This is the first half of delivering a file/image into a cockpit ' +
        'chat: after uploading, emit a <cockpit-attachment> marker in your reply to render it as an ' +
        'inline image or download card (see the cockpit-multimedia skill for the marker). The upload ' +
        'survives session deletion. mime is inferred from the extension if omitted; pass it ' +
        'explicitly for correct inline rendering. Max ~25 MB. SECURITY: the minted /uploads URL is ' +
        'web-reachable, so this turns a local file into externally fetchable content; reads are ' +
        'therefore fenced to the conventional upload roots (system temp, ~/.copilot/session-state, ' +
        '~/.copilot/cockpit-uploads, plus any COCKPIT_UPLOAD_DIRS) — paths outside them, symlinks ' +
        'escaping them, and traversal are refused.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Absolute path of the local file to upload. Must resolve inside an allowed upload root ' +
              '(system temp, ~/.copilot/session-state, ~/.copilot/cockpit-uploads, or COCKPIT_UPLOAD_DIRS).',
          ),
        mime: z.string().optional().describe('MIME type (inferred from extension if omitted)'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, mime, response_format }): Promise<ToolResult> => {
      let real: string;
      try {
        real = await resolveUploadPath(path);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      let buf: Buffer;
      try {
        buf = await readFile(real);
      } catch (e) {
        return fail(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (buf.length === 0) return fail(`File ${path} is empty.`);
      const name = basename(path);
      const resolvedMime = mime || MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
      const url = `${COCKPIT_URL}/upload?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(resolvedMime)}`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array(buf),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          return fail(`Upload failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
        }
        const r = (await res.json()) as UploadResponse;
        const marker =
          `<cockpit-attachment kind="${r.kind}" name="${encodeURIComponent(r.name)}" ` +
          `url="${encodeURIComponent(r.url)}" size="${r.size}" mime="${encodeURIComponent(r.mime)}"/>`;
        const structured = { ...r, marker };
        if (response_format === 'json') return ok(cappedJson(structured), structured);
        return ok(
          capped(
            `Uploaded **${r.name}** (${r.kind}, ${r.size} bytes)\n- url: ${r.url}\n- path: ${r.path}\n\n` +
              `To show it in chat, put this marker in your reply:\n${marker}`,
          ),
          structured,
        );
      } catch (e) {
        return fail(
          e instanceof Error
            ? `Cannot reach the cockpit upload endpoint at ${COCKPIT_URL} (${e.message}). Is cockpit-server up?`
            : String(e),
        );
      }
    },
  );

  // ── cockpit_list_dir ─────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_list_dir',
    {
      title: 'Browse a directory',
      description:
        'List a directory (dirs first, then files) the way the new-session folder picker does — ' +
        'useful for choosing a valid cwd to pass to cockpit_new_session. Omit path to list the home ' +
        'directory; the result includes the parent so you can walk up.',
      inputSchema: {
        path: z.string().optional().describe('Absolute directory to list (defaults to home)'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, response_format }): Promise<ToolResult> => {
      try {
        const listing = await intent<DirListing>('fs/listDir', path ? { path } : {});
        const structured = listing as unknown as Record<string, unknown>;
        if (response_format === 'json')
          return ok(cappedJson(listing, shrinkList(listing.entries, 'entries', { keep: ['name', 'isDir'], clip: [] })), structured);
        const lines = listing.entries.map((e) => `${e.isDir ? '📁' : '📄'} ${e.name}`);
        const head = `# ${listing.path}` + (listing.parent ? `\n_parent: ${listing.parent}_` : '');
        return ok(capped(`${head}\n${lines.join('\n') || '_empty_'}`), structured);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
