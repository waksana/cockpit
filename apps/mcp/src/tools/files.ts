// File transfers cross the client/backend boundary; directory browsing is remote.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { attachmentMarkdown, type Attachment } from '@cockpit/protocol';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { downloadFile, uploadFile } from '../file-client.js';
import { ResponseFormat, ok, fail, capped, cappedJson, shrinkList, type ToolResult } from '../shared.js';

export { resolveUploadPath } from '../file-client.js';

export function registerFileTools(server: McpServer): void {
  // ── cockpit_upload_file ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_upload_file',
    {
      title: 'Upload a file to the cockpit shared area',
      description:
        'Publish a local file and return a working /uploads URL, ready-to-use markdown, and attachment JSON. ' +
        'To show an image or file to the user, copy the returned markdown into your reply; do not link local /home paths, ' +
        'file: URLs or sandbox: URLs. For multiple images include each returned markdown. No extra skill is required. ' +
        'To send it as input to another session, pass attachment JSON to cockpit_send_prompt. The upload ' +
        'survives session deletion without automatic expiry. MIME is hinted by extension or mime; the backend verifies actual media. ' +
        'Max 25 MiB, streamed without base64. source defaults to mcp; session_id optionally associates the retained file. ' +
        'Use files/list and files/get via cockpit_call_intent to select retained files. SECURITY: public-host downloads require ' +
        'passkey authentication; /uploads is backend-relative, not an anonymously public URL. The internal backend uses its configured ' +
        'authentication boundary. Reads are ' +
        'therefore fenced to local artifact roots (system temp, /tmp, /var/tmp, ' +
        '~/.copilot/session-state and ~/.copilot/cockpit-uploads, ' +
        'plus any absolute COCKPIT_UPLOAD_DIRS, separated by the platform path delimiter) — paths outside them, symlinks ' +
        'escaping them, and traversal are refused.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Absolute path of the local file to upload. Must resolve inside an allowed upload root ' +
              '(system temp, session-state, cockpit-uploads or COCKPIT_UPLOAD_DIRS).',
          ),
        mime: z.string().optional().describe('MIME type (inferred from extension if omitted)'),
        source: z.literal('mcp').optional().describe('File source metadata (defaults to mcp)'),
        session_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Optional session association; does not send the file'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, mime, source, session_id, response_format }): Promise<ToolResult> => {
      try {
        const r = await uploadFile(path, { mime, source, sessionId: session_id });
        const attachment: Attachment = { kind: r.kind, name: r.name, url: r.url, size: r.size, mime: r.mime };
        const markdown = attachmentMarkdown(attachment);
        const structured = { ...r, attachment, markdown };
        if (response_format === 'json') return ok(cappedJson(structured));
        return ok(
          capped(
            `Uploaded **${r.name}** (${r.kind}, ${r.size} bytes)\n\n` +
              `Copy this into your reply to display it:\n${markdown}\n\n` +
              `Only when sending input to another session, use cockpit_send_prompt attachment:\n${JSON.stringify(attachment)}`,
          )
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'cockpit_download_file',
    {
      title: 'Download a cockpit file to this client',
      description:
        'Download only a backend-relative /uploads/<safe-basename> URL to an absolute local path. ' +
        'The existing parent directory must be under the client working directory or an absolute ' +
        'COCKPIT_DOWNLOAD_DIRS root (platform path-delimited). Never overwrites existing files or ' +
        'follows destination symlinks. Rejects arbitrary URLs, redirects, traversal and files over 25 MiB. ' +
        'Streams into a private staged file, verifies size and SHA-256 ETag when supplied, then atomically publishes without overwrite. ' +
        'Select URLs using files/list via cockpit_call_intent; no automatic expiry. Public-host downloads require passkey authentication, ' +
        'while this client accesses the configured internal backend. Returns metadata and the local path; name is display metadata only.',
      inputSchema: {
        url: z.string().min(1).describe('Backend-relative /uploads/<safe-basename> URL only; no query or fragment'),
        path: z.string().min(1).describe('Absolute new local file path under an allowed existing download directory'),
        name: z.string().min(1).max(200).optional().describe('Optional safe display filename; does not affect the destination'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ url, path, name, response_format }): Promise<ToolResult> => {
      try {
        const r = await downloadFile(url, path, { name });
        const structured = { ...r };
        if (response_format === 'json') return ok(cappedJson(structured));
        return ok(capped(`Downloaded **${r.name}** (${r.kind}, ${r.size} bytes)\n- url: ${r.url}\n- path: ${r.path}\n- mime: ${r.mime}`));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
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
        'directory; the result includes the parent so you can walk up. Explicit empty, missing, non-directory ' +
        'or inaccessible paths return an error, never a home-directory fallback.',
      inputSchema: {
        path: z.string().optional().describe('Absolute directory to list (defaults to home)'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, response_format }): Promise<ToolResult> => {
      try {
        const listing = await intent('fs/listDir', path === undefined ? {} : { path });
        if (response_format === 'json')
          return ok(cappedJson(listing, shrinkList(listing.entries, 'entries', { keep: ['name', 'isDir'], clip: [] })));
        const lines = listing.entries.map((e) => `${e.isDir ? '📁' : '📄'} ${e.name}`);
        const head = `# ${listing.path}` + (listing.parent ? `\n_parent: ${listing.parent}_` : '');
        return ok(capped(`${head}\n${lines.join('\n') || '_empty_'}`));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
