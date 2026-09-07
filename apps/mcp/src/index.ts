#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { COCKPIT_URL, SESSION_STORE, CHARACTER_LIMIT } from './config.js';
import { CockpitError, intent } from './cockpit.js';
import {
  ASSISTANT_VIEW_VALUES,
  StoreError,
  countTurns,
  getSessionRow,
  readTurns,
  hasEventLog,
  readEventTurns,
  readZeroTurnDiagnostic,
  stripSkillContext,
  type TurnRow,
} from './store.js';
import {
  ResponseFormat,
  ok,
  fail,
  capped,
  cappedJson,
  shrinkList,
  type ToolResult,
  type TrashEntry,
  type SessionBrief,
  McpSessionResult,
  McpToggleResult,
  type SkillSession,
  type ScheduleEntry,
} from './shared.js';
import { registerConversationTools } from './tools/conversation.js';
import { registerRespondTools } from './tools/respond.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerReadTools } from './tools/read.js';
import { registerGlobalTools } from './tools/global.js';
import { registerFileTools } from './tools/files.js';
import { registerHookTools } from './tools/hooks.js';
import { resolveAuthoritativeTitle, resolveSessionTitle } from './session-title.js';

const server = new McpServer({ name: 'cockpit-mcp-server', version: '0.1.0' });

// ── cockpit_list_sessions ──────────────────────────────────────────────────────
server.registerTool(
  'cockpit_list_sessions',
  {
    title: 'List cockpit sessions',
    description:
      'List the live (non-trashed) Copilot sessions known to cockpit (newest activity ' +
      'first), each with its title, working directory, status, and current model. Use this ' +
      'to find a session id before renaming it, toggling its MCP servers / skills, or reading ' +
      'its transcript. Authoritative: the same view the web sidebar shows. Trashed sessions ' +
      'are listed separately by cockpit_list_trash.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50).describe('Max sessions to return'),
      offset: z.number().int().min(0).default(0).describe('Sessions to skip (pagination)'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ limit, offset, response_format }): Promise<ToolResult> => {
    try {
      const { sessions } = await intent<{ sessions: SessionBrief[] }>('session/list');
      const page = sessions.slice(offset, offset + limit);
      const items = page.map((s) => ({
        sessionId: s.sessionId,
        title: s.title || '(untitled)',
        cwd: s.cwd,
        status: s.status,
        launchState: s.launchState ?? null,
        loaded: s.loaded,
        model: s.currentModelId ?? null,
        lastActivity: s.lastActivity,
      }));
      const structured = { sessions: items, count: items.length, total: sessions.length };
      if (response_format === 'json') return ok(cappedJson(structured), structured);
      if (items.length === 0) return ok('# Sessions\n\n_No live sessions._', structured);
      const lines = items.map((s) => {
        const model = s.model ? ` · ${s.model}` : '';
        const loaded = s.loaded ? '' : ' (unloaded)';
        const active = Number.isFinite(s.lastActivity) ? new Date(s.lastActivity).toLocaleString() : '—';
        const launch = s.launchState ? ` · ${s.launchState}` : '';
        return `- ${s.title}\n    id: ${s.sessionId}\n    status: ${s.status}${launch}${loaded}${model}\n    cwd: ${s.cwd}\n    active: ${active}`;
      });
      return ok(
        capped(`# Live sessions (${sessions.length})\n${lines.join('\n')}\n\n_Trashed sessions: use cockpit_list_trash._`),
        structured,
      );
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_list_trash ─────────────────────────────────────────────────────────
server.registerTool(
  'cockpit_list_trash',
  {
    title: 'List trashed sessions',
    description:
      'Enumerate sessions currently in cockpit\'s trash bin — the salvage queue. Each entry ' +
      'has the title, working directory, when it was trashed, and the reason it was condemned. ' +
      'Read this first, salvage anything reusable with cockpit_read_session, then purge. ' +
      'Authoritative: goes through cockpit (the same view the web Trash page shows).',
    inputSchema: { response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ response_format }): Promise<ToolResult> => {
    try {
      const { entries } = await intent<{ entries: TrashEntry[] }>('session/trash-list');
      const structured = { entries, count: entries.length };
      if (response_format === 'json')
        return ok(cappedJson(structured, shrinkList(entries, 'entries', { keep: ['sessionId', 'title', 'cwd', 'at'], clip: ['reason'] })), structured);
      if (entries.length === 0) return ok('# Trash\n\n_Trash is empty._', structured);
      const lines = entries.map(
        (e) =>
          `- ${e.title || '(untitled)'}\n    id: ${e.sessionId}\n    cwd: ${e.cwd}\n    trashed: ${e.at}${e.reason ? `\n    reason: ${e.reason}` : ''}`,
      );
      return ok(capped(`# Trash (${entries.length})\n${lines.join('\n')}`), structured);
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_read_session ───────────────────────────────────────────────────────
server.registerTool(
  'cockpit_read_session',
  {
    title: 'Read a session transcript',
    description:
      'Read the user/assistant turns of a session (read-only) so you can salvage reusable ' +
      'lessons before purging it. Works for both live and trashed sessions. Paginate with ' +
      'limit/offset over turns. Reads the session store directly. Set exclude_skill_context=true ' +
      'to drop the injected <skill-context>…</skill-context> blocks (each loaded skill\'s full ' +
      'SKILL.md, tens of KB) — recommended when reviewing a heavy-skill worker, whose transcript ' +
      'is otherwise mostly skill boilerplate. Set assistant_view="authoritative_text" to suppress ' +
      'reader-synthesized `【tool】` fallback lines and return only parent-session real ' +
      'assistant.message text plus parent session.task_complete summaries; child/sub-agent echoes ' +
      'are excluded. The default keeps the legacy tool-summary fallback for tool-only incomplete turns.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id (UUID) to read'),
      limit: z.number().int().min(1).max(200).default(40).describe('Max turns to return'),
      offset: z.number().int().min(0).default(0).describe('Turns to skip (pagination)'),
      assistant_view: z
        .enum(ASSISTANT_VIEW_VALUES)
        .default('default')
        .describe(
          'Assistant transcript view: default keeps the legacy synthesized `【tool】` fallback for tool-only event turns; authoritative_text returns only parent-session real assistant.message content plus parent session.task_complete summaries (no child/sub-agent echoes).',
        ),
      exclude_skill_context: z
        .boolean()
        .default(false)
        .describe('Drop injected <skill-context>…</skill-context> blocks (heavy-skill workers) so the real exchange is readable'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, limit, offset, assistant_view, exclude_skill_context, response_format }): Promise<ToolResult> => {
    try {
      const meta = getSessionRow(session_id);
      if (!meta) return fail(`session ${session_id} not found in the session store.`);
      // Authoritative: fold the event log when present (every prompt + reply); the
      // SQL `turns` table is a lossy fallback only for sessions with no event log.
      let total: number;
      let turns: TurnRow[];
      let source: 'events' | 'turns' | 'empty';
      let zeroTurnDiagnostic:
        | ReturnType<typeof readZeroTurnDiagnostic>
        | undefined;
      if (hasEventLog(session_id)) {
        const all = await readEventTurns(session_id, { assistantView: assistant_view });
        total = all.length;
        turns = all.slice(offset, offset + limit);
        if (all.length > 0) {
          source = 'events';
        } else {
          source = 'empty';
          zeroTurnDiagnostic = readZeroTurnDiagnostic(session_id);
        }
      } else {
        total = countTurns(session_id);
        if (total > 0) {
          turns = readTurns(session_id, limit, offset);
          source = 'turns';
        } else {
          turns = [];
          source = 'empty';
          zeroTurnDiagnostic = readZeroTurnDiagnostic(session_id);
        }
      }
      const authTitle = await resolveAuthoritativeTitle(session_id);
      const structured = {
        sessionId: meta.id,
        title: resolveSessionTitle(authTitle, meta.summary),
        cwd: meta.cwd ?? '',
        totalTurns: total,
        returned: turns.length,
        offset,
        assistantView: assistant_view,
        source,
        ...(zeroTurnDiagnostic ?? {}),
        turns: turns.map((t: TurnRow) => ({
          index: t.turn_index,
          user: exclude_skill_context ? stripSkillContext(t.user_message ?? '') : (t.user_message ?? ''),
          assistant: exclude_skill_context ? stripSkillContext(t.assistant_response ?? '') : (t.assistant_response ?? ''),
          at: t.timestamp ?? null,
        })),
      };
      if (response_format === 'json') {
        // Always emit VALID JSON within the budget. The full transcript may overflow
        // (a single turn can carry tens of KB), and a raw slice of JSON.stringify
        // corrupts it — the bug this fixes. Strategy: binary-search the largest
        // leading turn-prefix whose pretty-JSON fits, flag it `truncated`, and let the
        // caller page the rest with offset. If even the FIRST turn alone overflows,
        // we must still return it (otherwise that turn is unreadable in json) — so we
        // clip its text fields (JSON.stringify re-escapes the clip → still valid) and
        // point the caller at the markdown format for the full turn.
        const allTurns = structured.turns;
        const serialize = (keep: number, truncated: boolean): string =>
          JSON.stringify(
            truncated
              ? {
                  ...structured,
                  returned: keep,
                  truncated: true,
                  truncatedNote: `output exceeded the character budget — returned the first ${keep} of ${allTurns.length} fetched turns; page the rest with offset=${offset + keep}`,
                  turns: allTurns.slice(0, keep),
                }
              : structured,
            null,
            2,
          );
        const full = serialize(allTurns.length, false);
        let text: string;
        let jsonTruncated = false;
        if (full.length <= CHARACTER_LIMIT) {
          text = full;
        } else {
          jsonTruncated = true;
          let lo = 1, hi = allTurns.length - 1, best = 0;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (serialize(mid, true).length <= CHARACTER_LIMIT) { best = mid; lo = mid + 1; }
            else hi = mid - 1;
          }
          if (best >= 1) {
            text = serialize(best, true);
          } else {
            // The first turn alone overflows: return it with its text clipped so json
            // stays valid AND non-empty (the giant turn is otherwise unreadable here).
            const t0 = allTurns[0];
            const fieldBudget = Math.max(2000, Math.floor(CHARACTER_LIMIT / 3));
            const clip = (s: string): string =>
              s.length > fieldBudget
                ? s.slice(0, fieldBudget) + ` …[clipped ${s.length - fieldBudget} chars — read this turn with response_format="markdown"]`
                : s;
            text = cappedJson({
              ...structured,
              returned: 1,
              truncated: true,
              turnTextClipped: true,
              truncatedNote: `turn ${t0?.index} alone exceeds the character budget; its text was clipped — read the full turn with response_format="markdown", then continue paging with offset=${offset + 1}`,
              turns: t0 ? [{ ...t0, user: clip(t0.user), assistant: clip(t0.assistant) }] : [],
            });
          }
        }
        // When truncated, OMIT structuredContent. A ToolResult carries both the text
        // AND structuredContent; the CLI host materializes/serializes BOTH (it saved
        // them concatenated to one file). A FULL untruncated structuredContent would
        // (a) defeat the cap the text just applied and (b) make the saved file two
        // back-to-back JSON objects → json.loads() throws "Extra data". The capped
        // `text` is already complete, self-describing JSON, so it is the single
        // source when we truncate; only attach structuredContent when nothing was cut.
        return jsonTruncated ? ok(text) : ok(text, structured);
      }
      const head = `# ${structured.title}\nid: ${meta.id}\ncwd: ${structured.cwd}\nturns ${offset + 1}–${offset + turns.length} of ${total}\n`
        + (structured.source === 'empty'
          ? `source: empty\nreason: ${structured.zeroTurnReason ?? 'no_turns_persisted'}\n`
            + `eventLogExists: ${String(structured.eventLogExists ?? false)}\nsessionDbExists: ${String(structured.sessionDbExists ?? false)}\n`
            + (structured.launchState ? `launchState: ${structured.launchState}\n` : '')
            + (structured.error ? `error: ${structured.error}\n` : '')
          : '');
      // Build from structured.turns (already skill-context-stripped when requested),
      // NOT the raw `turns` rows — so exclude_skill_context applies to markdown too
      // (the primary reviewer-facing view), not just json.
      const body = structured.turns
        .map((t) => `\n## turn ${t.index}\n**user:** ${t.user}\n\n**assistant:** ${t.assistant}`)
        .join('\n');
      // Same rule for markdown: if the rendered doc overflows the budget, omit the
      // (full) structuredContent so the host doesn't file-save markdown + a big JSON.
      const md = head + body;
      return md.length <= CHARACTER_LIMIT ? ok(md, structured) : ok(capped(md));
    } catch (e) {
      return fail(e instanceof StoreError ? e.message : String(e));
    }
  },
);

// ── cockpit_restore_session ────────────────────────────────────────────────────
server.registerTool(
  'cockpit_restore_session',
  {
    title: 'Restore a session from trash',
    description:
      'Take a session back out of the trash bin so it returns to the normal session list. ' +
      'Non-destructive and idempotent. Goes through cockpit (the same path the web UI uses).',
    inputSchema: { session_id: z.string().min(1).describe('The trashed session id to restore') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id }): Promise<ToolResult> => {
    try {
      const res = await intent<{ ok: boolean }>('session/restore', { sessionId: session_id });
      if (!res.ok) return fail(`session ${session_id} was not in the trash (nothing to restore).`);
      return ok(`Restored ${session_id} — it is back in the normal session list.`, { sessionId: session_id, restored: true });
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_purge_session ──────────────────────────────────────────────────────
server.registerTool(
  'cockpit_purge_session',
  {
    title: 'Permanently delete a session',
    description:
      'IRREVERSIBLE. Permanently destroy a session via cockpit (the same code path as the ' +
      'web "delete forever" — it calls the SDK\'s real delete on session-store.db). Only run ' +
      'this AFTER you have salvaged anything reusable with cockpit_read_session. Requires ' +
      'confirm=true. Never hand-delete session-store.db rows; always purge through this tool.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id to permanently delete'),
      confirm: z
        .boolean()
        .default(false)
        .describe('Must be true to proceed — guards against accidental irreversible deletion'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, confirm }): Promise<ToolResult> => {
    if (!confirm) {
      return fail(
        `Refusing to purge ${session_id}: pass confirm=true to permanently delete. ` +
          `This is irreversible — salvage with cockpit_read_session first.`,
      );
    }
    try {
      await intent<{ ok: boolean }>('session/purge', { sessionId: session_id });
      return ok(`Purged ${session_id} permanently. The session is gone.`, { sessionId: session_id, purged: true });
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
      const res = await intent<{ ok: boolean; title?: string }>('session/rename', { sessionId: session_id, name });
      return ok(`Renamed ${session_id} → "${res.title ?? name}".`, { sessionId: session_id, title: res.title ?? name });
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
      'List every globally-configured MCP server together with one session\'s state: ' +
      'whether it is enabled for that session and, if so, its live connection status ' +
      '(connected | failed | needs-auth | pending | disabled | not_configured). An ' +
      'unloaded session is reported as unloaded without materializing it. MCP definitions ' +
      'are global; enablement is per-session. Call this before ' +
      'cockpit_set_session_mcp to get exact names and current on/off state.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, response_format }): Promise<ToolResult> => {
    try {
      const raw = await intent<unknown>('mcp/session', { sessionId: session_id });
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
          keep: ['name', 'enabled', 'status', 'error', 'operation'],
          clip: ['detail'],
        });
        return ok(cappedJson(structured, (attempt) => {
          const smaller = shrink(attempt);
          return smaller ? { loaded, ...smaller } : null;
        }), structured);
      }
      const loadNote = loaded
        ? ''
        : '\n\n_Session is unloaded; live MCP connection status is unavailable. This read did not load it._';
      if (servers.length === 0) return ok(`_No MCP servers are configured globally._${loadNote}`, structured);
      const lines = servers.map(
        (s) =>
          `- ${s.enabled ? '🟢' : '⚪'} ${s.name} — ${s.enabled ? `enabled (${s.status})` : 'disabled'}${s.error ? ` · error: ${s.error}` : ''}`
          + `${s.operation ? ` · toggle ${s.operation.id}=${s.operation.state}/${s.operation.status}${s.operation.error ? `: ${s.operation.error}` : ''}` : ''}\n    ${s.detail}`,
      );
      return ok(capped(`# MCP servers for ${session_id}${loadNote}\n${lines.join('\n')}`), structured);
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
      'live; disabling stops it. A successful live change persists across reloads and affects ' +
      'only the named session. Target failures return their status/error without persisting, ' +
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
      const raw = await intent<unknown>('mcp/session-toggle', { sessionId: session_id, name, on: enabled });
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
          + `(target=${res.status}, durable enabled=${res.enabled}, operation `
          + `${res.operation.id}=${res.operation.state}): ${res.error ?? 'target did not reach the requested state'}`,
        );
      }
      return ok(
        `MCP "${name}" ${enabled ? 'enabled' : 'disabled'} for ${session_id} `
          + `(target=${res.status}, applied=${res.applied}, durable enabled=${res.enabled}, operation `
          + `${res.operation.id}=${res.operation.state}).`,
        {
        sessionId: session_id,
        name,
        enabled: res.enabled,
        status: res.status,
        operation: res.operation,
        ok: res.ok,
        },
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
      "List every available skill with one session's enabled flag. Skills are global " +
      'definitions; each session can disable specific ones. Call this before ' +
      'cockpit_set_session_skill to get exact skill names and current on/off state.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, response_format }): Promise<ToolResult> => {
    try {
      const { skills } = await intent<{ skills: SkillSession[] }>('skills/session', { sessionId: session_id });
      const structured = { skills, count: skills.length };
      if (response_format === 'json')
        return ok(cappedJson(structured, shrinkList(skills, 'skills', { keep: ['name', 'enabled', 'source'], clip: ['description'] })), structured);
      if (skills.length === 0) return ok('_No skills are available._', structured);
      const lines = skills.map(
        (s) =>
          `- ${s.enabled ? '🟢' : '⚪'} ${s.name}${s.source ? ` (${s.source})` : ''}${s.description ? `\n    ${s.description}` : ''}`,
      );
      return ok(capped(`# Skills for ${session_id}\n${lines.join('\n')}`), structured);
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
      'Turn one skill on or off for a single session. The choice persists across reloads ' +
      'and applies live, affecting only the named session. Call cockpit_list_session_skills ' +
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
      const res = await intent<{ ok: boolean }>('skills/session-toggle', { sessionId: session_id, name, enabled });
      return ok(`Skill "${name}" ${enabled ? 'enabled' : 'disabled'} for ${session_id}.`, {
        sessionId: session_id,
        name,
        enabled,
        ok: res.ok,
      });
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_set_session_pin ────────────────────────────────────────────────────
server.registerTool(
  'cockpit_set_session_pin',
  {
    title: 'Pin (mark) or unpin a session',
    description:
      'Pin a session (pinned=true) to mark it / sort it to the top of the list, synced ' +
      'across devices, or release it (pinned=false). This is a pure UI mark — it does ' +
      'NOT keep the session loaded. KEEP-LOADED (exemption from LRU + heap-watchdog ' +
      'eviction, and reload on startup) is now driven automatically by whether the ' +
      'session has an active per-session schedule (cockpit_schedule_add): a session ' +
      'with >=1 schedule stays resident so its in-memory schedule keeps firing, with no ' +
      'manual pin needed. Returns the applied flag.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      pinned: z.boolean().describe('true to mark/pin-to-top, false to release (UI mark only — not keep-loaded)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, pinned }): Promise<ToolResult> => {
    try {
      const res = await intent<{ ok: boolean; pinned: boolean }>('session/pin', { sessionId: session_id, pinned });
      return ok(`Session ${session_id} ${res.pinned ? 'pinned (UI mark)' : 'unpinned'}.`, {
        sessionId: session_id,
        pinned: res.pinned,
        ok: res.ok,
      });
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── cockpit_refresh_skills ─────────────────────────────────────────────────────
server.registerTool(
  'cockpit_refresh_skills',
  {
    title: 'Refresh the on-disk skills (restart to pick up changes)',
    description:
      'Make cockpit pick up skills added/removed/edited in ~/.copilot/skills AFTER it ' +
      'started. cockpit (via the Copilot SDK) caches the skill directory scan at process ' +
      'start with no in-process way to invalidate it, so this arms a GRACEFUL self-restart: ' +
      'cockpit exits once every session is idle and systemd restarts it with a fresh scan. ' +
      'In-flight turns are never interrupted (it waits for idle). Use this after installing ' +
      'or deleting a skill so it becomes listable and enable-able on sessions. ' +
      'Returns { ok, willRestartWhenIdle } — willRestartWhenIdle is false when nothing was ' +
      'running and it restarts immediately.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (): Promise<ToolResult> => {
    try {
      const res = await intent<{ ok: boolean; willRestartWhenIdle: boolean }>('skills/refresh');
      const when = res.willRestartWhenIdle
        ? 'cockpit will restart automatically as soon as all sessions are idle, then re-scan skills.'
        : 'cockpit is restarting now (nothing was running) and will re-scan skills.';
      return ok(`Skill refresh armed. ${when}`, { ...res });
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
      '  - interval: a relative interval string — "10s" (min), "5m", "2h", "1d" (recurring by default)\n' +
      '  - cron: a 5-field cron expression (e.g. "0 9 * * *"), evaluated in tz (recurring)\n' +
      '  - at: an absolute epoch-MILLISECONDS fire time (one-shot by default)\n' +
      'The prompt can be plain text or a slash-command/skill the session understands. The ' +
      'target session must be loaded for ticks to fire (cockpit rehydrates schedules on ' +
      'reload). Use cockpit_list_sessions to get the session id.\n' +
      'Returns { ok, entry } with the created schedule (id used to stop it), or { ok:false, error }.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id to schedule the prompt on'),
      prompt: z.string().min(1).describe('The prompt text enqueued on every tick'),
      interval: z.string().optional().describe('Relative interval, e.g. "10s", "5m", "2h", "1d" (min 10s)'),
      cron: z.string().optional().describe('5-field cron expression, e.g. "0 9 * * *"'),
      at: z.number().optional().describe('One-shot absolute fire time, epoch MILLISECONDS'),
      recurring: z.boolean().optional().describe('Override re-arm: defaults true for interval/cron, false for at'),
      tz: z.string().optional().describe('IANA timezone for cron evaluation, e.g. "Asia/Shanghai"'),
      display_prompt: z.string().optional().describe('User-facing label shown instead of the raw prompt'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ session_id, prompt, interval, cron, at, recurring, tz, display_prompt }): Promise<ToolResult> => {
    const kinds = [interval, cron, at].filter((v) => v !== undefined).length;
    if (kinds !== 1) return fail('provide exactly one of interval, cron, or at.');
    try {
      const res = await intent<{ ok: boolean; entry?: ScheduleEntry; error?: string }>('schedule/add', {
        sessionId: session_id,
        prompt,
        ...(interval !== undefined ? { interval } : {}),
        ...(cron !== undefined ? { cron } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(recurring !== undefined ? { recurring } : {}),
        ...(tz !== undefined ? { tz } : {}),
        ...(display_prompt !== undefined ? { displayPrompt: display_prompt } : {}),
      });
      if (!res.ok || !res.entry) return fail(res.error ?? 'schedule was not created.');
      const e = res.entry;
      const cadence = e.cron ? `cron "${e.cron}"${e.tz ? ` (${e.tz})` : ''}` : e.intervalMs ? `every ${Math.round(e.intervalMs / 1000)}s` : e.at ? `once at ${new Date(e.at).toLocaleString()}` : 'unknown';
      return ok(`Scheduled #${e.id} on ${session_id}: ${cadence}${e.recurring ? ' (recurring)' : ' (one-shot)'}. Next: ${new Date(e.nextRunAt).toLocaleString()}.`, { ...res });
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
      'List the active scheduled prompts on a session (recurring and one-shot), with their ' +
      'id, cadence, next fire time, and prompt. Use this to find a schedule id before ' +
      'stopping it. Returns { entries: [{ id, prompt, recurring, nextRunAt, intervalMs?, cron?, tz?, at? }] }.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ session_id, response_format }): Promise<ToolResult> => {
    try {
      const { entries } = await intent<{ entries: ScheduleEntry[] }>('schedule/list', { sessionId: session_id });
      const structured = { entries, count: entries.length };
      if (response_format === 'json')
        return ok(cappedJson(structured, shrinkList(entries, 'entries', { keep: ['id', 'recurring', 'nextRunAt', 'intervalMs', 'cron', 'tz', 'at'], clip: ['prompt', 'displayPrompt'] })), structured);
      if (entries.length === 0) return ok(`_No schedules on ${session_id}._`, structured);
      const lines = entries.map((e) => {
        const cadence = e.cron ? `cron "${e.cron}"${e.tz ? ` (${e.tz})` : ''}` : e.intervalMs ? `every ${Math.round(e.intervalMs / 1000)}s` : e.at ? `once at ${new Date(e.at).toLocaleString()}` : '?';
        return `- #${e.id} · ${cadence}${e.recurring ? '' : ' (one-shot)'} · next ${new Date(e.nextRunAt).toLocaleString()}\n    ${e.displayPrompt ?? e.prompt}`;
      });
      return ok(capped(`# Schedules for ${session_id}\n${lines.join('\n')}`), structured);
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
      'Cancel one scheduled prompt by its id (from cockpit_list_schedules). Idempotent: ' +
      'returns ok:false if no such schedule exists. Returns { ok }.',
    inputSchema: {
      session_id: z.string().min(1).describe('The session id'),
      id: z.number().int().describe('The schedule id to stop (from cockpit_list_schedules)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ session_id, id }): Promise<ToolResult> => {
    try {
      const res = await intent<{ ok: boolean }>('schedule/stop', { sessionId: session_id, id });
      return res.ok
        ? ok(`Stopped schedule #${id} on ${session_id}.`, { ok: true })
        : fail(`No schedule #${id} on ${session_id} (already stopped?). Check cockpit_list_schedules.`);
    } catch (e) {
      return fail(e instanceof CockpitError ? e.message : String(e));
    }
  },
);

// ── Tool groups (split by concern into ./tools/*) ────────────────────────────
// The 15 tools above (trash bin, per-session metadata, schedules, refresh) plus
// these groups give the MCP parity with what a person can see/do in the UI.
registerConversationTools(server); // send_prompt, cancel_turn, remove_queued
registerRespondTools(server);      // respond_ask, respond_plan, respond_elicitation
registerSettingsTools(server);     // set_model, set_mode, compact_session, rewind_session
registerLifecycleTools(server);    // new/delete/unload/reload_session
registerReadTools(server);         // get_session, get_panels, get_plan
registerGlobalTools(server);       // list_global_mcp, set_global_mcp_default, refresh_mcp, list_global_skills
registerFileTools(server);         // upload_file, list_dir
registerHookTools(server);         // hook_add, hook_list, hook_stop, flow_list, flow_run (butler/flow trigger layer)

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cockpit-mcp-server up (cockpit=${COCKPIT_URL}, store=${SESSION_STORE})`);
}

main().catch((e) => {
  console.error('cockpit-mcp-server fatal:', e);
  process.exit(1);
});
