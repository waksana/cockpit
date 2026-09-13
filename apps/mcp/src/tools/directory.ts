import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, ok, fail, capped, cappedJson, shrinkList, type ToolResult } from '../shared.js';

export function registerDirectoryTools(server: McpServer): void {
  server.registerTool('cockpit_list_dir', {
    title: 'Browse a directory',
    description: 'List a backend directory (directories first) for choosing a native session working directory. '
      + 'Omit path for the server home. Explicit empty, missing, non-directory or inaccessible paths fail; '
      + 'there is no home-directory fallback, upload or download.',
    inputSchema: {
      path: z.string().optional().describe('Absolute directory to list; omitted means server home'),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path, response_format }): Promise<ToolResult> => {
    try {
      const listing = await intent('fs/listDir', path === undefined ? {} : { path });
      if (response_format === 'json') {
        return ok(cappedJson(listing, shrinkList(listing.entries, 'entries', { keep: ['name', 'isDir'], clip: [] })));
      }
      const lines = listing.entries.map(entry => `${entry.isDir ? '[dir]' : '[file]'} ${entry.name}`);
      const head = `# ${listing.path}` + (listing.parent ? `\n_parent: ${listing.parent}_` : '');
      return ok(capped(`${head}\n${lines.join('\n') || '_empty_'}`));
    } catch (error) { return fail(error instanceof CockpitError ? error.message : String(error)); }
  });
}
