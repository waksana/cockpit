#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Intents } from '@cockpit/protocol';
import { COCKPIT_URL } from './config.js';
import { CockpitError, intent as rawIntent, protocolIntent as intent } from './cockpit.js';
import {
  ResponseFormat,
  ok,
  fail,
  capped,
  cappedJson,
  roleSummary,
  activitySummary,
  shrinkList,
  type ToolResult,
  McpSessionResult,
  McpToggleResult,
} from './shared.js';
import { registerConversationTools } from './tools/conversation.js';
import { registerRespondTools } from './tools/respond.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerReadTools } from './tools/read.js';
import { registerGlobalTools } from './tools/global.js';
import { registerDirectoryTools } from './tools/directory.js';
import { registerFoundationTools } from './tools/foundation.js';
import { registerTranscriptTools } from './tools/transcript.js';
import { registerRoleTools } from './tools/roles.js';

export function createMcpServer(): McpServer {
const server = new McpServer({ name: 'cockpit-mcp-server', version: '0.3.1' });
registerRoleTools(server);

// ── cockpit_list_sessions ──────────────────────────────────────────────────────
server.registerTool(
  'cockpit_list_sessions',
  {
    title: 'List cockpit sessions',
    description:
      'List Copilot sessions known to cockpit (newest activity ' +
      'first), each with its title, working directory, legacy aggregate status, sampled native activity flags/counts, current model, saved/applied roles and reload state. Processing means a turn or background continuation, not necessarily generation. Null activity is unavailable, not idle. Use this ' +
      'to find a session id before renaming it, toggling its MCP servers / skills, or reading ' +
      'its transcript. Authoritative: the same view the web sidebar shows.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50).describe('Max sessions to return'),
      offset: z.number().int().min(0).default(0).describe('Sessions to skip (pagination)'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ limit, offset, response_format }): Promise<ToolResult> => {
    try {
      const { sessions } = await intent('session/list');
      const page = sessions.slice(offset, offset + limit);
      const items = page.map((s) => ({
        sessionId: s.sessionId,
        title: s.title || '(untitled)',
        cwd: s.cwd,
        status: s.status,
        loaded: s.loaded,
        ...(s.activity === undefined ? {} : { activity: s.activity }),
        model: s.currentModelId ?? null,
        lastActivity: s.lastActivity,
        roles: s.roles ?? [],
        ...(s.appliedRoles === undefined ? {} : { appliedRoles: s.appliedRoles }),
        ...(s.rolesNeedReload === undefined ? {} : { rolesNeedReload: s.rolesNeedReload }),
      }));
      const structured = { sessions: items, count: items.length, total: sessions.length };
      if (response_format === 'json') return ok(cappedJson(structured));
      if (items.length === 0) return ok('# Sessions\n\n_No live sessions._');
      const lines = items.map((s) => {
        const model = s.model ? ` · ${s.model}` : '';
        const loaded = s.loaded ? '' : ' (unloaded)';
        const active = Number.isFinite(s.lastActivity) ? new Date(s.lastActivity).toLocaleString() : '—';
        return `- ${s.title}\n    id: ${s.sessionId}\n    status: ${s.status}${loaded}${model}\n    cwd: ${s.cwd}\n    active: ${active}\n    ${[...activitySummary(s.activity), ...roleSummary(s)].join('\n    ')}`;
      });
      return ok(
        capped(`# Sessions (${sessions.length})\n${lines.join('\n')}`)
      );
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_rename_session ─────────────────────────────────────────────────────
server.registerTool(
  'cockpit_rename_session',
  {
    title: 'Rename a session',
    description:
      "Set a session's title — the name shown in the cockpit sidebar (same as the CLI " +
      '/rename). Use this to give a session a clear, descriptive name, e.g. after reading ' +
      'it with cockpit_read_session. Applies live; cockpit echoes back the authoritative title.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id to rename'),
      name: z.string().min(1).max(120).describe('The new title (trimmed/clamped by cockpit)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, name }): Promise<ToolResult> => {
    try {
      const res = await intent('session/rename', { sessionId: session_id, name });
      return ok(`Renamed ${session_id} → "${res.title ?? name}".`);
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_list_session_mcp ───────────────────────────────────────────────────
server.registerTool(
  'cockpit_list_session_mcp',
  {
    title: "List a session's MCP servers",
    description:
      'Read the native MCP servers visible to a loaded session: ' +
      'its configured/not-disabled flag and native connection status ' +
      '(connected | failed | needs-auth | pending | disabled | stopped | not_configured). ' +
      'Enabled does not imply connected. Stopped includes policy quarantine and does not imply restart is allowed. ' +
      'Optional module/roles identify actual handle configuration contributors, not all selected roles or live connection identity; later same-name native replacements cannot be verified. ' +
      'Unknown native state fails explicitly rather than claiming not_configured. An ' +
      'unloaded session returns loaded:false and no claimed per-session enablement; explicitly ' +
      'resume it for live details or use cockpit_list_global_mcp for global defaults. Call this before ' +
      'cockpit_set_session_mcp to get exact names and current on/off state.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, response_format }): Promise<ToolResult> => {
    try {
      const raw = await intent('mcp/session', { sessionId: session_id });
      const parsed = McpSessionResult.safeParse(raw);
      if (!parsed.success) {
        throw new CockpitError(
          `cockpit intent "mcp/session" returned an invalid result: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
          'protocol',
          'mcp/session',
        );
      }
      const { loaded, servers } = parsed.data;
      const structured = { loaded, servers, count: servers.length };
      if (response_format === 'json') {
        const shrink = shrinkList(servers, 'servers', {
          keep: ['name', 'module', 'enabled', 'status', 'error', 'operation'],
          clip: ['detail'],
        });
        return ok(cappedJson(structured, (attempt) => {
          const smaller = shrink(attempt);
          return smaller ? { loaded, ...smaller } : null;
        }));
      }
      const loadNote = loaded
        ? ''
        : '\n\n_Session is unloaded; live MCP connection status is unavailable. This read did not load it._';
      if (!loaded) return ok(`# MCP servers for ${session_id}${loadNote}\nUse the global catalog for native defaults, or explicitly resume for session settings.`);
      if (servers.length === 0) return ok('_No MCP servers are present in this native session._');
      const lines = servers.map(
        (s) =>
          `- ${s.enabled ? '🟢' : '⚪'} ${s.name} — enabled=${s.enabled} (${s.status})${s.error ? ` · error: ${s.error}` : ''}`
          + `${s.module ? ` · role-configured module: ${s.module.name} (${s.module.id}; not live connection identity)` : ''}`
          + `${s.module?.roles?.length ? ` · contributing roles: ${s.module.roles.map(role => `${role.name} (${role.id})`).join(', ')}` : ''}`
          + `${s.operation ? ` · toggle ${s.operation.id}=${s.operation.state}/${s.operation.status}${s.operation.error ? `: ${s.operation.error}` : ''}` : ''}\n    ${s.detail}`,
      );
      return ok(capped(`# MCP servers for ${session_id}${loadNote}\n${lines.join('\n')}`));
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_set_session_mcp ────────────────────────────────────────────────────
server.registerTool(
  'cockpit_set_session_mcp',
  {
    title: 'Enable/disable an MCP server for a session',
    description:
      'Turn one MCP server on or off for a single session. Enabling connects/spawns it ' +
      'live; disabling stops it. Copilot owns the setting and its cold-resume semantics; Cockpit ' +
      'does not save or replay native switch overrides. Cold resume uses native global defaults. ' +
      'Target failures return their status/error, ' +
      'and a still-settling SDK operation remains visible by operation id. Call ' +
      'cockpit_list_session_mcp first to get the exact server name.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      name: z.string().min(1).describe('The MCP server name (exact, from cockpit_list_session_mcp)'),
      enabled: z.boolean().describe('true to enable, false to disable'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, name, enabled }): Promise<ToolResult> => {
    try {
      const raw = await rawIntent('mcp/session-toggle', { sessionId: session_id, name, on: enabled });
      const parsed = McpToggleResult.safeParse(raw);
      if (!parsed.success) {
        throw new CockpitError(
          `cockpit intent "mcp/session-toggle" returned an invalid result: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
          'protocol',
          'mcp/session-toggle',
        );
      }
      const res = parsed.data;
      if (!res.ok) {
        return fail(
          `MCP "${name}" was not ${enabled ? 'enabled' : 'disabled'} `
          + `(target=${res.status}, native enabled=${res.enabled}, operation `
          + `${res.operation.id}=${res.operation.state}): ${res.error ?? 'target did not reach the requested state'}`,
        );
      }
      return ok(
        `MCP "${name}" ${enabled ? 'enabled' : 'disabled'} for ${session_id} `
          + `(target=${res.status}, applied=${res.applied}, durable enabled=${res.enabled}, operation `
          + `${res.operation.id}=${res.operation.state}).`,
      );
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_list_session_skills ────────────────────────────────────────────────
server.registerTool(
  'cockpit_list_session_skills',
  {
    title: "List a session's skills",
    description:
      "List every available skill with one session's enabled flag. Optional module/roles identify actual " +
      'handle contributors verified against the native skill name and path, not all selected roles or readiness. ' +
      'Missing role provenance remains module-only. Each session can disable specific skills. Call this before ' +
      'cockpit_set_session_skill to get exact skill names and current on/off state.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, response_format }): Promise<ToolResult> => {
    try {
      const { skills } = await intent('skills/session', { sessionId: session_id });
      const structured = { skills, count: skills.length };
      if (response_format === 'json')
        return ok(cappedJson(structured, shrinkList(skills, 'skills', { keep: ['name', 'module', 'enabled', 'source'], clip: ['description'] })));
      if (skills.length === 0) return ok('_No skills are available._');
      const lines = skills.map(
        (s) =>
          `- ${s.enabled ? '🟢' : '⚪'} ${s.name}${s.source ? ` (${s.source})` : ''}`
          + `${s.module ? ` · module: ${s.module.name} (${s.module.id})` : ''}`
          + `${s.module?.roles?.length ? ` · contributing roles: ${s.module.roles.map(role => `${role.name} (${role.id})`).join(', ')}` : ''}`
          + `${s.description ? `\n    ${s.description}` : ''}`,
      );
      return ok(capped(`# Skills for ${session_id}\n${lines.join('\n')}`));
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_set_session_skill ──────────────────────────────────────────────────
server.registerTool(
  'cockpit_set_session_skill',
  {
    title: 'Enable/disable a skill for a session',
    description:
      'Turn one skill on or off through its native session API, without a Cockpit stored override. ' +
      'The session choice is temporary; cold resume uses native global configuration. ' +
      'Use skills/global-toggle via cockpit_call_intent for persistent native global configuration. ' +
      'Call cockpit_list_session_skills ' +
      'first to get the exact skill name.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      name: z.string().min(1).describe('The skill name (exact, from cockpit_list_session_skills)'),
      enabled: z.boolean().describe('true to enable, false to disable'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, name, enabled }): Promise<ToolResult> => {
    try {
      await intent('skills/session-toggle', { sessionId: session_id, name, enabled });
      return ok(`Skill "${name}" ${enabled ? 'enabled' : 'disabled'} for ${session_id}.`);
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_refresh_skills ─────────────────────────────────────────────────────
server.registerTool(
  'cockpit_refresh_skills',
  {
    title: 'Reload native skill definitions',
    description:
      'Reload skills added, removed or edited on disk through the native SDK. ' +
      'Cockpit is not restarted. Existing per-session enablement remains a separate setting.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (): Promise<ToolResult> => {
    try {
      await intent('skills/refresh');
      return ok('Native skill definitions reloaded without restarting Cockpit.');
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_schedule_add ───────────────────────────────────────────────────────
server.registerTool(
  'cockpit_schedule_add',
  {
    title: 'Schedule a recurring or one-shot prompt on a session',
    description:
      'Register a scheduled prompt that fires into a session as a queued user message. ' +
      'Provide EXACTLY ONE timing kind:\n' +
      '  - interval: a relative interval such as "10s", "5m", "2h", "1d" (recurring by default)\n' +
      '  - at: an absolute epoch-MILLISECONDS fire time (one-shot)\n' +
      'Delays must be 1 second to 24 hours. Cron, timezone, labels and recurring-at are not supported. ' +
      'No self-paced creation or rearming is exposed. Schedules do not keep the target loaded. ' +
      'The prompt must be single-line plain text, without command flags or a leading slash. The ' +
      'target session must be loaded for ticks to fire. Native idle cleanup pauses schedules; ' +
      'relative delays restart on resume. This is not an always-on scheduler. ' +
      'Use cockpit_list_sessions to get the session id.\n' +
      'Returns the complete native-backed outcome. A returned entry establishes creation even alongside an error; ' +
      'possiblyCreated:true means acknowledgement/readback was inconclusive. Missing entry is not proof that nothing was created. ' +
      'Never automatically retry an uncertain result.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id to schedule the prompt on'),
      prompt: z.string().min(1).describe('The prompt text enqueued on every tick'),
      interval: z.string().optional().describe('Relative interval in s/m/h/d; from 1 second through 24 hours'),
      at: z.number().optional().describe('One-shot absolute fire time, epoch MILLISECONDS'),
      recurring: z.boolean().optional().describe('Defaults true for interval; must be false or omitted for at'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ session_id, prompt, interval, at, recurring }): Promise<ToolResult> => {
    const kinds = [interval, at].filter((v) => v !== undefined).length;
    if (kinds !== 1) return fail('provide exactly one of interval or at.');
    try {
      const res = await intent('schedule/add', {
        sessionId: session_id,
        prompt,
        ...(interval !== undefined ? { interval } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(recurring !== undefined ? { recurring } : {}),
      });
      return ok(JSON.stringify(res, null, 2));
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_list_schedules ─────────────────────────────────────────────────────
server.registerTool(
  'cockpit_list_schedules',
  {
    title: "List a session's scheduled prompts",
    description:
      'List the active scheduled prompts on a session (recurring, one-shot and self-paced), with their ' +
      'id, cadence, next fire time, and prompt. Use this to find a schedule id before ' +
      'stopping it. Requires a loaded session; use cockpit_reload_session explicitly if unloaded. ' +
      'Self-paced entries have no fixed cadence: the model controls each next run. ' +
      'Reading or stopping them does not expose self-paced creation or rearming. Schedules do not keep sessions loaded. ' +
      'Returns { entries: [{ id, prompt, recurring, nextRunAt, selfPaced?, intervalMs?, cron?, tz?, at? }] }.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, response_format }): Promise<ToolResult> => {
    try {
      const { entries } = await intent('schedule/list', { sessionId: session_id });
      const structured = { entries, count: entries.length };
      if (response_format === 'json')
        return ok(cappedJson(structured, shrinkList(entries, 'entries', { keep: ['id', 'recurring', 'selfPaced', 'nextRunAt', 'intervalMs', 'cron', 'tz', 'at'], clip: ['prompt', 'displayPrompt'] })));
      if (entries.length === 0) return ok(`_No schedules on ${session_id}._`);
      const lines = entries.map((e) => {
        const cadence = e.selfPaced ? 'self-paced (model-controlled; no fixed cadence)'
          : e.cron ? `cron "${e.cron}"${e.tz ? ` (${e.tz})` : ''}` : e.intervalMs ? `every ${Math.round(e.intervalMs / 1000)}s` : e.at ? `once at ${new Date(e.at).toLocaleString()}` : '?';
        return `- #${e.id} · ${cadence}${e.recurring || e.selfPaced ? '' : ' (one-shot)'} · next ${new Date(e.nextRunAt).toLocaleString()}\n    ${e.displayPrompt ?? e.prompt}`;
      });
      return ok(capped(`# Schedules for ${session_id}\n${lines.join('\n')}`));
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_stop_schedule ──────────────────────────────────────────────────────
server.registerTool(
  'cockpit_stop_schedule',
  {
    title: 'Stop a scheduled prompt',
    description:
      'Cancel one scheduled prompt by its known id (use cockpit_list_schedules if the id is unknown). ' +
      'The backend uses the native stop result, not a list read to infer success. ' +
      'Idempotent: the API returns {ok:false} when native returns no stopped entry; this tool reports that as an error. ' +
      'Native failures propagate. Does not rearm or replace the schedule.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      id: z.number().int().describe('The schedule id to stop (from cockpit_list_schedules)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, id }): Promise<ToolResult> => {
    try {
      const res = Intents['schedule/stop'].result.parse(await rawIntent('schedule/stop', { sessionId: session_id, id }));
      return res.ok
        ? ok(`Stopped schedule #${id} on ${session_id}.`)
        : fail(`No schedule #${id} on ${session_id} (already stopped?). Check cockpit_list_schedules.`);
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── Tool groups (split by concern into ./tools/*) ────────────────────────────
// Semantic tools independently consume the backend's selected native API subset.
registerConversationTools(server); // send_prompt, cancel_turn, remove_queued
registerRespondTools(server);      // respond_ask, respond_plan, respond_elicitation
registerSettingsTools(server);     // set_model, set_mode, compact_session, rewind_session
registerLifecycleTools(server);    // new/delete/unload/reload_session
registerReadTools(server);         // get_session, get_panels, get_plan
registerGlobalTools(server);       // list_global_mcp, set_global_mcp_default, refresh_mcp, list_global_skills
registerDirectoryTools(server);
registerTranscriptTools(server);
registerFoundationTools(server);
return server;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  console.error(`cockpit-mcp-server up (cockpit=${COCKPIT_URL})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error('cockpit-mcp-server fatal:', e);
    process.exit(1);
  });
}
