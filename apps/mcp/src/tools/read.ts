// Read tools: surface the information a person sees in the UI but the MCP couldn't
// yet — a session's full live state (model/mode/queue/ask/plan/todo/…, with the
// ids the mutation tools need), its info panels, and its plan. cockpit_get_session
// is the foundation: other tools depend on the ids it returns.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import { ResponseFormat, ok, fail, capped, cappedJson, type ToolResult, type SessionMetaFull } from '../shared.js';

interface PanelItem {
  label: string;
  detail?: string;
  status?: string;
}
interface SessionPanels {
  skills: PanelItem[];
  mcpServers: PanelItem[];
  tasks: PanelItem[];
  instructionSources: PanelItem[];
  schedules: PanelItem[];
}

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
        '(cockpit_respond_*). Returns meta:null if the id is not a known live session.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ session_id, response_format }): Promise<ToolResult> => {
      try {
        const { meta } = await intent<{ meta: SessionMetaFull | null }>('session/get', { sessionId: session_id });
        if (!meta) return fail(`No live session ${session_id} (trashed or unknown). Try cockpit_list_sessions.`);
        const structured = meta as unknown as Record<string, unknown>;
        if (response_format === 'json') return ok(cappedJson(meta), structured);
        const lines: string[] = [
          `# ${meta.title || '(untitled)'}`,
          `id: ${meta.sessionId}`,
          `status: ${meta.status}${meta.launchState ? ` · ${meta.launchState}` : ''}${meta.loaded ? '' : ' (unloaded)'}${meta.pinned ? ' · pinned' : ''}`,
          `cwd: ${meta.cwd}`,
          `model: ${meta.currentModelId ?? '—'}${meta.currentReasoningEffort ? ` (${meta.currentReasoningEffort})` : ''}` +
            `${meta.currentContextTier ? ` · ${meta.currentContextTier}` : ''}`,
          `mode: ${meta.currentMode ?? '—'}`,
        ];
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
          (meta.todo.currentTitle ? ` · now: ${meta.todo.currentTitle}` : ''));
        if (meta.error) lines.push(`error: ${meta.error}`);
        return ok(capped(lines.join('\n')), structured);
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
        'skills (loaded), mcpServers (with status), tasks (sub-agents/tools), instructionSources ' +
        '(AGENTS.md and friends in effect), and schedules. A read-only situational overview.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ session_id, response_format }): Promise<ToolResult> => {
      try {
        const panels = await intent<SessionPanels>('session/panels', { sessionId: session_id });
        const structured = panels as unknown as Record<string, unknown>;
        if (response_format === 'json') return ok(cappedJson(panels), structured);
        const sect = (name: string, items: PanelItem[]) => {
          if (!items || !items.length) return `## ${name}\n_none_`;
          return `## ${name}\n` + items.map((i) => `- ${i.label}${i.status ? ` · ${i.status}` : ''}${i.detail ? `\n    ${i.detail}` : ''}`).join('\n');
        };
        const md = [
          `# Panels for ${session_id}`,
          sect('Skills', panels.skills),
          sect('MCP servers', panels.mcpServers),
          sect('Tasks', panels.tasks),
          sect('Instruction sources', panels.instructionSources),
          sect('Schedules', panels.schedules),
        ].join('\n\n');
        return ok(capped(md), structured);
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
        "Read a session's current plan/todo board (the plan panel in the UI): the list of todo " +
        'items with their status. Useful to see what an autonomous or working session is doing ' +
        'without reading the whole transcript.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ session_id, response_format }): Promise<ToolResult> => {
      try {
        const plan = await intent<Record<string, unknown>>('session/plan', { sessionId: session_id });
        if (response_format === 'json') return ok(cappedJson(plan), plan);
        const items = (plan.items as { id: string; title: string; status: string }[] | undefined) ?? [];
        if (!items.length) return ok(`# Plan for ${session_id}\n\n_No plan items._`, plan);
        const md = `# Plan for ${session_id} (${items.length})\n` +
          items.map((i) => `- [${i.status}] ${i.title}`).join('\n');
        return ok(capped(md), plan);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
