// Read tools: surface the information a person sees in the UI but the MCP couldn't
// yet — a session's full live state (model/mode/queue/ask/plan/todo/…, with the
// ids the mutation tools need), its info panels, and its plan. cockpit_get_session
// is the foundation: other tools depend on the ids it returns.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, ok, fail, capped, cappedJson, type ToolResult, type PanelItem } from '../shared.js';

export function registerReadTools(server: McpServer): void {
  // ── cockpit_get_session ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_get_session',
    {
      title: 'Get a session full state',
      description:
        'Read one live session\'s full authoritative state — the same object the web UI renders: ' +
        'status, loaded, current model/reasoning/context tier/mode, availableModels, pin, schedule ' +
        'count, the pending queue (each {id,text}), any open ask / plan / elicitation request (with ' +
        'its requestId), and todo progress. This is the tool that gives you the IDS the action tools ' +
        'need: queue item id (cockpit_remove_queued), ask/plan/elicitation requestId ' +
        '(cockpit_respond_*). Unknown sessions return an error. Interaction mode is separate from the ' +
        'runtime permissionPolicy: allow-all (always auto-approve), shown by cockpit_get_snapshot.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ session_id, response_format }): Promise<ToolResult> => {
      try {
        const { meta } = await intent('session/get', { sessionId: session_id });
        if (!meta) return fail(`Unknown session ${session_id}. Try cockpit_list_sessions.`);
        if (response_format === 'json') return ok(cappedJson(meta));
        const lines: string[] = [
          `# ${meta.title || '(untitled)'}`,
          `id: ${meta.sessionId}`,
          `status: ${meta.status}${meta.loaded ? '' : ' (unloaded)'}${meta.pinned ? ' · pinned' : ''}`,
          `cwd: ${meta.cwd || 'unknown (not provided by native metadata)'}`,
          `model: ${meta.currentModelId ?? '—'}${meta.currentReasoningEffort ? ` (${meta.currentReasoningEffort})` : ''}` +
            `${meta.currentContextTier ? ` · ${meta.currentContextTier}` : ''}`,
          `interaction mode: ${meta.currentMode ?? '—'} (not a permission policy)`,
        ];
        if (!meta.loaded) lines.push('Native runtime fields (model, mode, queue, tasks, schedules, MCP) are unavailable while unloaded; no previous values or global defaults are substituted.');
        const operations = ['loading', 'closing', 'cancelling'] as const;
        for (const operation of operations) if (meta[operation]) lines.push(`${operation}: true`);
        if (meta.scheduleCount) lines.push(`schedules: ${meta.scheduleCount}`);
        if (meta.queue && meta.queue.length) {
          lines.push(`queue (${meta.queue.length}):`);
          for (const q of meta.queue) lines.push(`  - [${q.id}] ${q.text.slice(0, 80)}`);
        }
        if (meta.ask) lines.push(`ASK pending (requestId ${meta.ask.requestId}): ${meta.ask.question}` +
          (meta.ask.choices ? `\n  choices: ${meta.ask.choices.join(' | ')}` : ''));
        if (meta.planRequest) lines.push(`PLAN pending (requestId ${meta.planRequest.requestId}): ${meta.planRequest.summary}`);
        if (meta.elicitation) lines.push(`ELICITATION pending (requestId ${meta.elicitation.requestId}): ${meta.elicitation.message}`);
        if (meta.todo) lines.push(`todo: ${meta.todo.done}/${meta.todo.total} done` +
          (meta.todo.intent ? ` · now: ${meta.todo.intent}` : ''));
        if (meta.intent) lines.push(`intent: ${meta.intent}`);
        if (meta.autoNaming) lines.push('automatic naming: in progress (not a chat turn)');
        if (meta.autoNameError) lines.push(`naming error: ${meta.autoNameError}`);
        if (meta.error) lines.push(`error: ${meta.error}`);
        return ok(capped(lines.join('\n')));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_get_panels ───────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_get_panels',
    {
      title: 'Get a session info panels',
      description:
        "Read a session's info-panel contents — the same five panels the UI's info panel shows: " +
        'skills, mcpServers, tasks (sub-agents/tools), instructionSources ' +
        '(AGENTS.md and friends in effect), and schedules, preserving each label, sublabel and enabled flag. ' +
        'Requires a loaded session; explicitly use cockpit_reload_session if unloaded.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ session_id, response_format }): Promise<ToolResult> => {
      try {
        const panels = await intent('session/panels', { sessionId: session_id });
        if (response_format === 'json') return ok(cappedJson(panels));
        const sect = (name: string, items: PanelItem[]) => {
          if (!items || !items.length) return `## ${name}\n_none_`;
          return `## ${name}\n` + items.map((i) => `- ${i.label}${i.enabled === undefined ? '' : i.enabled ? ' · enabled' : ' · disabled'}${i.sublabel ? `\n    ${i.sublabel}` : ''}`).join('\n');
        };
        const md = [
          `# Panels for ${session_id}`,
          sect('Skills', panels.skills),
          sect('MCP servers', panels.mcpServers),
          sect('Tasks', panels.tasks),
          sect('Instruction sources', panels.instructionSources),
          sect('Schedules', panels.schedules),
        ].join('\n\n');
        return ok(capped(md));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_get_plan ─────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_get_plan',
    {
      title: 'Get a session plan',
      description:
        "Read a session's current plan/todo board (the plan panel in the UI): planMarkdown and todo " +
        'items with their status. Useful to see what an autonomous or working session is doing ' +
        'without reading the whole transcript. Requires a loaded session; explicitly use ' +
        'cockpit_reload_session if unloaded.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ session_id, response_format }): Promise<ToolResult> => {
      try {
        const plan = await intent('session/plan', { sessionId: session_id });
        if (response_format === 'json') return ok(cappedJson(plan));
        const sections = [
          `# Plan for ${session_id}`,
          plan.planMarkdown ?? '_No plan narrative._',
          `## Todos (${plan.todos.length})\n` + (plan.todos.map((i) =>
            `- [${i.status}] ${i.title} (${i.id})${i.description ? `\n    ${i.description}` : ''}`,
          ).join('\n') || '_No todos._'),
        ];
        return ok(capped(sections.join('\n\n')));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
