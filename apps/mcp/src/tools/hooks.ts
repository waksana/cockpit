// Hook tools: the Butler/Flow event-hook trigger layer — schedule's sibling.
// A schedule fires on TIME; a hook fires on an ECOSYSTEM EVENT (v1:
// session.first-turn-complete) and delivers a prompt into the owner (butler)
// session, carrying the source event's context. Hooks are engine-global and
// cross-session: one butler session reacts to events anywhere in the fleet.
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import { cockpitHome } from '../config.js';
import { ok, fail, cappedJson, shrinkList, ResponseFormat, type Flow, type FlowScheduleEntry, type HookEntry, type ToolResult } from '../shared.js';

const EVENTS = ['session.first-turn-complete', 'session.error', 'session.trashed', 'engine.boot-complete'] as const;

// ── gate.script confinement ───────────────────────────────────────────────────
// A flow's gate.script is spawned verbatim by the engine as the operator (exit 0=go).
// cockpit_flow_write_gate already confines its *writes* to ~/.copilot/flows/ via a
// safe-basename guard, but the gate_script *path* a flow stores is otherwise free to
// point at any executable on disk (e.g. /usr/bin/curl). That asymmetry is the
// unconfined-arbitrary-executable-spawn primitive flagged in the security review. As
// defense-in-depth at the tool layer, require gate_script to be a safe-basename file
// living directly in the flows dir — exactly what cockpit_flow_write_gate returns — so
// the executed surface matches the confined write surface. (The authoritative fence
// belongs in core's FlowRegistry.write so the raw loopback intent inherits it too; see
// docs/review/fixes/fx-mcp.md — that file is out of this change's edit scope.)
const FLOWS_DIR = (): string => resolve(process.env.COCKPIT_FLOWS_DIR ?? join(cockpitHome(), 'flows'));

function isSafeBasename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

// Returns an error string if `p` is not a confined gate-script path, else null.
export async function gateScriptRejection(p: string): Promise<string | null> {
  const flowsDir = FLOWS_DIR();
  const lexical = resolve(p);
  const hint =
    'Write it with cockpit_flow_write_gate first and pass back the path it returns.';
  if (resolve(dirname(lexical)) !== flowsDir || !isSafeBasename(basename(lexical))) {
    return `gate_script must be a gate file inside the flows dir (${flowsDir}); got ${p}. ${hint}`;
  }
  // If it exists, resolve symlinks too so a symlink planted in the flows dir cannot
  // redirect the spawn to an executable outside it.
  if (existsSync(lexical)) {
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (e) {
      return `cannot resolve gate_script ${p}: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (resolve(dirname(real)) !== flowsDir) {
      return `gate_script ${p} resolves to ${real}, which escapes the flows dir (${flowsDir}). ${hint}`;
    }
  }
  return null;
}

export function registerHookTools(server: McpServer): void {
  // ── cockpit_hook_add ─────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_hook_add',
    {
      title: 'Register an event hook (butler trigger)',
      description:
        'Register an event hook — the sibling of cockpit_schedule_add, but fired by a fleet ' +
        'EVENT instead of by time. When the event fires on any (real, non-worker) session, the ' +
        'hook drives either a Flow (flow_id → gate, then spawn a born-configured worker or ' +
        'prompt an existing session — the canonical path) OR, as a fallback, delivers an ' +
        'interpolated prompt_template straight into the OWNER (butler) session. Provide exactly ' +
        'one of flow_id / prompt_template. Events: "session.first-turn-complete" (a real ' +
        'session finished its first turn with content — the welcome trigger; source-keyed), ' +
        '"session.error" (a real session\'s turn ended in error — the triage trigger; source-keyed, ' +
        'the {event.summary} token carries the error message; R1 + a 60s per-source rate-limit ' +
        'mean a spawned worker never fires it and a flapping session can\'t storm it), ' +
        '"session.trashed" (a session was moved to the trash bin — soft-delete, reversible, NOT purge; ' +
        'source-keyed, carries the trashed session\'s cwd/title; fires for EVERY trashed session including ' +
        'spawned workers, so the consumer\'s gate must collapse bursts — used to salvage a corpse the ' +
        'instant it\'s binned), and ' +
        '"engine.boot-complete" (the engine finished starting — a fresh boot or a restart; GLOBAL, ' +
        'source-less). The boot event lets a session re-drive itself precisely when the server comes ' +
        'back — e.g. a daemon verifying its OWN deploy restart — with no polling; pair it with ' +
        'once=true and the hook auto-removes after its single post-restart firing. Tokens ' +
        '{event.sessionId}, {event.cwd}, {event.title}, {event.summary} (and bare {sessionId}/{cwd}/' +
        '{title}/{summary}) are substituted from the event (empty for the boot event). A spawnedBy ' +
        'worker is a non-trigger-source (R1) so its lifecycle never fires hooks. Returns { ok, entry } (entry.id is used to stop it).',
      inputSchema: {
        owner_session: z.string().min(1).describe('The session that RECEIVES the delivery (the butler)'),
        event: z.enum(EVENTS).describe('Which fleet event to subscribe to'),
        flow_id: z.string().optional().describe('Drive this Flow (from cockpit_flow_list) — the canonical TRIGGER→FLOW→ACTION path'),
        prompt_template: z
          .string()
          .optional()
          .describe('Fallback: prompt enqueued into the owner; supports {event.sessionId}/{event.cwd}/{event.title}/{event.summary}'),
        cwd_prefix: z.string().optional().describe('Filter: only sources whose cwd starts with this. Ignored / must be omitted for engine.boot-complete (it has no source)'),
        source_session: z.string().optional().describe('Filter: only this exact source session id. Ignored / must be omitted for engine.boot-complete (it has no source)'),
        once: z.boolean().optional().describe('Operative only for the GLOBAL event (engine.boot-complete): fire on the next boot then auto-remove. For session.first-turn-complete dedup is the persisted welcomed-bit, so once is effectively a no-op there (still fires at most once per source)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ owner_session, event, flow_id, prompt_template, cwd_prefix, source_session, once }): Promise<ToolResult> => {
      if (!flow_id && !prompt_template) return fail('provide exactly one of flow_id or prompt_template.');
      // Fail loud (Finding 1): the global engine.boot-complete event is source-less,
      // so a cwd_prefix/source_session filter can never match — the hook would be
      // silently dead. Reject it here too (the engine enforces the same at addHook).
      if (event === 'engine.boot-complete' && (cwd_prefix !== undefined || source_session !== undefined)) {
        return fail("source filters (cwd_prefix/source_session) don't apply to the global engine.boot-complete event (it has no source); omit them.");
      }
      try {
        const filter =
          cwd_prefix !== undefined || source_session !== undefined
            ? {
                ...(cwd_prefix !== undefined ? { cwdPrefix: cwd_prefix } : {}),
                ...(source_session !== undefined ? { sessionId: source_session } : {}),
              }
            : undefined;
        const res = await intent<{ ok: boolean; entry?: HookEntry; error?: string }>('hook/add', {
          ownerSession: owner_session,
          event,
          ...(flow_id !== undefined ? { flowId: flow_id } : {}),
          ...(prompt_template !== undefined ? { promptTemplate: prompt_template } : {}),
          ...(filter ? { filter } : {}),
          ...(once !== undefined ? { once } : {}),
        });
        if (!res.ok || !res.entry) return fail(res.error ?? 'hook was not created.');
        const e = res.entry;
        const action = e.flowId ? `run flow ${e.flowId}` : 'deliver to butler';
        return ok(
          `Hook ${e.id} on ${owner_session}: when ${e.event}` +
            `${e.filter?.cwdPrefix ? ` (cwd ${e.filter.cwdPrefix})` : ''}` +
            `${e.filter?.sessionId ? ` (source ${e.filter.sessionId})` : ''} → ${action}.`,
          { ...res },
        );
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_hook_list ────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_hook_list',
    {
      title: 'List event hooks',
      description:
        'List event hooks (engine-global), optionally narrowed to one owner (butler) session. ' +
        'Shows each hook id, event, owner, filter, and action (promptTemplate or flowId). Use ' +
        'this to find a hook id before stopping it. Returns { entries: [...] }.',
      inputSchema: {
        owner_session: z.string().optional().describe('Narrow to hooks owned by this session'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ owner_session, response_format }): Promise<ToolResult> => {
      try {
        const { entries } = await intent<{ entries: HookEntry[] }>('hook/list', {
          ...(owner_session !== undefined ? { ownerSession: owner_session } : {}),
        });
        const structured = { entries, count: entries.length };
        if (response_format === 'json')
          return ok(
            cappedJson(
              structured,
              shrinkList(entries, 'entries', {
                keep: ['id', 'ownerSession', 'event', 'flowId', 'filter', 'once', 'createdAt'],
                clip: ['promptTemplate'],
              }),
            ),
            structured,
          );
        if (entries.length === 0) return ok('_No hooks registered._', structured);
        const lines = entries.map((e) => {
          const action = e.flowId ? `flow ${e.flowId}` : e.promptTemplate ? `prompt "${e.promptTemplate}"` : '(inert)';
          const filt = [
            e.filter?.cwdPrefix ? `cwd^${e.filter.cwdPrefix}` : '',
            e.filter?.sessionId ? `src=${e.filter.sessionId}` : '',
          ].filter(Boolean).join(' ');
          return `- ${e.id} · ${e.event} → ${e.ownerSession} · ${action}${filt ? ` · ${filt}` : ''}`;
        });
        return ok(`# Hooks\n${lines.join('\n')}`, structured);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_hook_stop ────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_hook_stop',
    {
      title: 'Stop an event hook',
      description:
        'Cancel one event hook by its id (from cockpit_hook_list). Idempotent: returns ok:false ' +
        'if no such hook exists. Returns { ok }.',
      inputSchema: {
        id: z.string().min(1).describe('The hook id to stop (from cockpit_hook_list)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('hook/stop', { id });
        return res.ok
          ? ok(`Stopped hook ${id}.`, { ok: true })
          : fail(`No hook ${id} (already stopped?). Check cockpit_hook_list.`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_list ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_list',
    {
      title: 'List flows',
      description:
        'List the Flow definitions cockpit loaded from ~/.copilot/flows/*.json. A Flow is the ' +
        'reusable TRIGGER → FLOW → ACTION middle layer: an optional cheap gate script plus an ' +
        'action (spawn-session = born-configured worker, or prompt-existing). Returns { flows }.',
      inputSchema: {
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const { flows } = await intent<{ flows: Flow[] }>('flow/list', {});
        const structured = { flows, count: flows.length };
        if (response_format === 'json') {
          const flat = flows.map((f) => ({
            id: f.id,
            name: f.name ?? null,
            gate: f.gate?.script ?? null,
            kind: f.action.kind,
            target: f.action.kind === 'spawn-session' ? f.action.template.cwd : f.action.sessionId,
            model: f.action.kind === 'spawn-session' ? (f.action.template.model ?? null) : null,
            mode: f.action.kind === 'spawn-session' ? (f.action.template.mode ?? null) : null,
            prompt: f.action.kind === 'spawn-session' ? f.action.template.prompt : f.action.prompt,
          }));
          return ok(
            cappedJson(
              structured,
              shrinkList(flat, 'flows', { keep: ['id', 'name', 'gate', 'kind', 'target', 'model', 'mode'], clip: ['prompt'] }),
            ),
            structured,
          );
        }
        if (flows.length === 0) return ok('_No flows defined (~/.copilot/flows/*.json)._', structured);
        const lines = flows.map((f) => {
          const a = f.action.kind === 'spawn-session'
            ? `spawn-session (cwd ${f.action.template.cwd})`
            : `prompt-existing → ${f.action.sessionId}`;
          return `- ${f.id}${f.name ? ` · ${f.name}` : ''} · ${f.gate ? 'gated' : 'no gate'} · ${a}`;
        });
        return ok(`# Flows\n${lines.join('\n')}`, structured);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_run ───────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_run',
    {
      title: 'Run a flow now (summon/debug)',
      description:
        'Manually trigger a Flow by id: run its gate (if any), then its action. Useful to ' +
        'summon or debug a flow without waiting for its event/schedule. Optionally pass an event ' +
        'context (source session id/cwd/title) for interpolation. Returns { ok, skipped?, ' +
        'sessionId? } — skipped=true when the gate declined; sessionId is a spawned worker id.',
      inputSchema: {
        flow_id: z.string().min(1).describe('The flow id (from cockpit_flow_list)'),
        source_session: z.string().optional().describe('Event context: the source session id'),
        source_cwd: z.string().optional().describe('Event context: the source cwd'),
        source_title: z.string().optional().describe('Event context: the source title'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ flow_id, source_session, source_cwd, source_title }): Promise<ToolResult> => {
      try {
        const ctx = source_session
          ? { event: 'session.first-turn-complete', sessionId: source_session, cwd: source_cwd ?? '', title: source_title ?? '' }
          : undefined;
        const res = await intent<{ ok: boolean; skipped?: boolean; sessionId?: string; error?: string }>('flow/run', {
          flowId: flow_id,
          ...(ctx ? { ctx } : {}),
        });
        if (!res.ok) return fail(res.error ?? 'flow run failed.');
        if (res.skipped) return ok(`Flow ${flow_id} ran but its gate declined (skipped).`, { ...res });
        return ok(
          res.sessionId ? `Flow ${flow_id} ran → ${res.sessionId}.` : `Flow ${flow_id} ran.`,
          { ...res },
        );
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_add ───────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_add',
    {
      title: 'Author (create/overwrite) a flow definition',
      description:
        'Write a Flow definition to ~/.copilot/flows/<id>.json so it can be triggered by hooks or ' +
        'schedules. The id must be a safe basename (no path traversal). Choose an action: ' +
        '"spawn-session" (a born-configured one-shot worker — set cwd + prompt, optionally skills/' +
        'mcps/model/mode; skills=[] disables all, mcps=[] connects none) or "prompt-existing" ' +
        '(deliver a prompt into target_session). Optionally attach a gate (a cheap cost-gate ' +
        'script run before the action: exit 0=go, non-zero/timeout=skip). Write the gate script ' +
        'itself with cockpit_flow_write_gate first, then pass its path as gate_script. Prompt/cwd ' +
        'may contain {event.sessionId}/{event.cwd}/{event.title} and {gate.<key>} tokens. ' +
        'Overwrites an existing flow of the same id. Returns { ok, flow }.',
      inputSchema: {
        id: z.string().min(1).describe('Flow id = the JSON filename stem (safe basename)'),
        name: z.string().optional().describe('Human label'),
        action_kind: z.enum(['spawn-session', 'prompt-existing']).describe('What the flow does'),
        // spawn-session
        cwd: z.string().optional().describe('spawn-session: working dir (supports {event.cwd})'),
        prompt: z.string().min(1).describe('The prompt (spawn-session: worker first turn; prompt-existing: delivered)'),
        worker_title: z.string().optional().describe('spawn-session: the worker session title (supports {event.*}/{gate.*}); sticks, not derived from the prompt'),
        skills: z.array(z.string()).optional().describe('spawn-session: the ONLY skills kept enabled ([] = all disabled)'),
        mcps: z.array(z.string()).optional().describe('spawn-session: MCP servers enabled at birth ([] = none)'),
        model: z.string().optional().describe('spawn-session: model id'),
        mode: z.enum(['interactive', 'plan', 'autopilot']).optional().describe('spawn-session: agent mode'),
        // prompt-existing
        target_session: z.string().optional().describe('prompt-existing: the session to deliver into'),
        // gate
        gate_script: z
          .string()
          .optional()
          .describe(
            'Path to a gate script. Must live directly in the flows dir (~/.copilot/flows/) — write ' +
              'it with cockpit_flow_write_gate and pass back the path it returns; arbitrary executables ' +
              'outside the flows dir are refused. NOTE: a gate is spawned as the operator with the ' +
              "server's full environment, so flows are an intended (gated) execution surface.",
          ),
        gate_timeout_ms: z.number().optional().describe('Gate kill deadline in ms (default 30000); a hang = skip'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a): Promise<ToolResult> => {
      try {
        if (a.gate_script) {
          const rej = await gateScriptRejection(a.gate_script);
          if (rej) return fail(rej);
        }
        const gate = a.gate_script ? { script: a.gate_script, ...(a.gate_timeout_ms !== undefined ? { timeoutMs: a.gate_timeout_ms } : {}) } : undefined;
        let action: Flow['action'];
        if (a.action_kind === 'spawn-session') {
          if (!a.cwd) return fail('spawn-session needs cwd.');
          action = {
            kind: 'spawn-session',
            template: {
              cwd: a.cwd, prompt: a.prompt,
              ...(a.worker_title !== undefined ? { title: a.worker_title } : {}),
              ...(a.skills !== undefined ? { skills: a.skills } : {}),
              ...(a.mcps !== undefined ? { mcps: a.mcps } : {}),
              ...(a.model !== undefined ? { model: a.model } : {}),
              ...(a.mode !== undefined ? { mode: a.mode } : {}),
            },
          };
        } else {
          if (!a.target_session) return fail('prompt-existing needs target_session.');
          action = { kind: 'prompt-existing', sessionId: a.target_session, prompt: a.prompt };
        }
        const flow: Flow = { id: a.id, ...(a.name ? { name: a.name } : {}), ...(gate ? { gate } : {}), action };
        const res = await intent<{ ok: boolean; flow?: Flow; error?: string }>('flow/add', flow as unknown as Record<string, unknown>);
        if (!res.ok) return fail(res.error ?? 'flow was not written.');
        return ok(`Flow "${a.id}" written (~/.copilot/flows/${a.id}.json). Bind a trigger with cockpit_hook_add or cockpit_flow_schedule_add.`, { ...res });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_write_gate ────────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_write_gate',
    {
      title: 'Write a gate script for a flow',
      description:
        'Write a gate script into ~/.copilot/flows/<name> (made executable where supported) and ' +
        'return its absolute path, to pass as cockpit_flow_add gate_script. A gate is the cheap, ' +
        'no-LLM cost gate run BEFORE a flow\'s action: it receives the event context on env ' +
        'COCKPIT_EVENT + stdin (JSON); exit 0 = go, non-zero/timeout = skip; stdout JSON becomes ' +
        '{gate.<key>} params for the downstream prompt. The gate is launched by FILE EXTENSION, not ' +
        'shebang: .js/.mjs/.cjs run on Node (cross-platform, no extra runtime — RECOMMENDED), .py on ' +
        'Python (COCKPIT_PYTHON), and .sh/extension-less are spawned directly (POSIX-only — fails on ' +
        'Windows). The name must be a safe basename (path-traversal rejected). Returns { ok, path }.',
      inputSchema: {
        name: z.string().min(1).describe('Script filename (safe basename); prefer a .js gate (Node, cross-platform), e.g. "welcome-gate.js"'),
        script: z.string().min(1).describe('The full script body. For a .js gate, read JSON from process.env.COCKPIT_EVENT/stdin and process.exit(0) to go'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, script }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean; path?: string; error?: string }>('flow/write-gate', { name, script });
        if (!res.ok || !res.path) return fail(res.error ?? 'gate script was not written.');
        return ok(`Gate script written → ${res.path}. Reference it as gate_script in cockpit_flow_add.`, { ...res });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_remove ────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_remove',
    {
      title: 'Delete a flow definition',
      description:
        'Delete a flow definition (~/.copilot/flows/<id>.json). Also stops any server-level flow ' +
        'schedules pointing at it (a schedule firing a missing flow is a no-op); event hooks ' +
        'pointing at it are left (inert + visible). Returns { ok }. Does not delete its gate script.',
      inputSchema: {
        id: z.string().min(1).describe('The flow id to delete (from cockpit_flow_list)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean; error?: string }>('flow/remove', { id });
        return res.ok ? ok(`Flow "${id}" deleted.`, { ok: true }) : fail(res.error ?? `No flow "${id}".`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_schedule_add ──────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_schedule_add',
    {
      title: 'Schedule a flow OR an inline prompt on a server-level time trigger',
      description:
        'Register a SERVER-LEVEL time trigger — the UNIFIED, only scheduling mechanism in cockpit. ' +
        'It fires even with ZERO sessions loaded (it runs in the always-on cockpit-server). ' +
        'Provide EXACTLY ONE ACTION:\n' +
        '  - flow_id: run a Flow (gate → action) each tick; the flow must exist (cockpit_flow_list).\n' +
        '  - target_session + target_prompt: deliver a prompt into an existing session each tick ' +
        '(no flow file needed). The session is woken (ensureLoaded) if unloaded — this replaces the ' +
        'old per-session schedule + keep-loaded pin.\n' +
        'And EXACTLY ONE TIMING kind:\n' +
        '  - interval: a relative interval string — "10s" (min), "5m", "2h", "1d" (recurring)\n' +
        '  - cron: a 5-field cron expression (e.g. "0 9 * * *"), evaluated in tz (recurring)\n' +
        '  - at: an absolute epoch-MILLISECONDS fire time (one-shot)\n' +
        'Returns { ok, entry } (entry.id is used to stop it).',
      inputSchema: {
        flow_id: z.string().optional().describe('Action: the flow id to run each tick (one-of with target_session)'),
        target_session: z.string().optional().describe('Action: deliver a prompt into this session each tick (inline, one-of with flow_id)'),
        target_prompt: z.string().optional().describe('Inline action: the prompt text delivered into target_session'),
        display_prompt: z.string().optional().describe('Inline action: user-facing label when target_prompt is a slash-command'),
        interval: z.string().optional().describe('Relative interval, e.g. "10s", "5m", "2h", "1d" (min 10s)'),
        cron: z.string().optional().describe('5-field cron expression, e.g. "0 9 * * *"'),
        at: z.number().optional().describe('One-shot absolute fire time, epoch MILLISECONDS'),
        recurring: z.boolean().optional().describe('Override re-arm: defaults true for interval/cron, false for at'),
        tz: z.string().optional().describe('IANA timezone for cron evaluation, e.g. "Asia/Shanghai"'),
        label: z.string().optional().describe('Optional human label for the schedule'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ flow_id, target_session, target_prompt, display_prompt, interval, cron, at, recurring, tz, label }): Promise<ToolResult> => {
      const kinds = [interval, cron, at].filter((v) => v !== undefined).length;
      if (kinds !== 1) return fail('provide exactly one of interval, cron, or at.');
      const actions = [flow_id, target_session].filter((v) => v !== undefined).length;
      if (actions !== 1) return fail('provide exactly one of flow_id or target_session.');
      if (target_session && !target_prompt) return fail('target_session needs target_prompt.');
      try {
        const target = target_session
          ? { kind: 'prompt-existing' as const, sessionId: target_session, prompt: target_prompt!, ...(display_prompt !== undefined ? { displayPrompt: display_prompt } : {}) }
          : undefined;
        const res = await intent<{ ok: boolean; entry?: FlowScheduleEntry; error?: string }>('flow-schedule/add', {
          ...(flow_id !== undefined ? { flowId: flow_id } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(interval !== undefined ? { interval } : {}),
          ...(cron !== undefined ? { cron } : {}),
          ...(at !== undefined ? { at } : {}),
          ...(recurring !== undefined ? { recurring } : {}),
          ...(tz !== undefined ? { tz } : {}),
          ...(label !== undefined ? { label } : {}),
        });
        if (!res.ok || !res.entry) return fail(res.error ?? 'flow schedule was not created.');
        const e = res.entry;
        const cadence = e.cron ? `cron "${e.cron}"${e.tz ? ` (${e.tz})` : ''}` : e.intervalMs ? `every ${Math.round(e.intervalMs / 1000)}s` : e.at ? `once at ${new Date(e.at).toLocaleString()}` : 'unknown';
        const action = e.flowId ? `flow ${e.flowId}` : e.target ? `prompt → ${e.target.sessionId}` : '?';
        return ok(`Flow schedule #${e.id}: ${action} · ${cadence}${e.recurring ? ' (recurring)' : ' (one-shot)'}. Next: ${new Date(e.nextRunAt).toLocaleString()}.`, { ...res });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_schedule_list ─────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_schedule_list',
    {
      title: 'List server-level flow schedules',
      description:
        'List the server-level flow schedules (engine-global time triggers that fire a flow even ' +
        'with no sessions loaded), with their id, target flow, cadence, and next fire time. Use ' +
        'this to find a schedule id before stopping it. Returns { entries: [...] }.',
      inputSchema: {
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const { entries } = await intent<{ entries: FlowScheduleEntry[] }>('flow-schedule/list', {});
        const structured = { entries, count: entries.length };
        if (response_format === 'json') {
          const flat = entries.map((e) => ({
            id: e.id,
            flowId: e.flowId ?? null,
            targetSession: e.target?.sessionId ?? null,
            recurring: e.recurring,
            nextRunAt: e.nextRunAt,
            intervalMs: e.intervalMs ?? null,
            cron: e.cron ?? null,
            tz: e.tz ?? null,
            at: e.at ?? null,
            label: e.label ?? null,
            prompt: e.target?.prompt ?? null,
          }));
          return ok(
            cappedJson(
              structured,
              shrinkList(flat, 'entries', {
                keep: ['id', 'flowId', 'targetSession', 'recurring', 'nextRunAt', 'intervalMs', 'cron', 'tz', 'at', 'label'],
                clip: ['prompt'],
              }),
            ),
            structured,
          );
        }
        if (entries.length === 0) return ok('_No flow schedules._', structured);
        const lines = entries.map((e) => {
          const cadence = e.cron ? `cron "${e.cron}"${e.tz ? ` (${e.tz})` : ''}` : e.intervalMs ? `every ${Math.round(e.intervalMs / 1000)}s` : e.at ? `once at ${new Date(e.at).toLocaleString()}` : '?';
          return `- #${e.id} · ${e.flowId ? `flow ${e.flowId}` : e.target ? `prompt → ${e.target.sessionId}` : '?'} · ${cadence}${e.recurring ? '' : ' (one-shot)'} · next ${new Date(e.nextRunAt).toLocaleString()}`;
        });
        return ok(`# Flow schedules\n${lines.join('\n')}`, structured);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_flow_schedule_stop ─────────────────────────────────────────────
  server.registerTool(
    'cockpit_flow_schedule_stop',
    {
      title: 'Stop a server-level flow schedule',
      description:
        'Cancel one server-level flow schedule by its id (from cockpit_flow_schedule_list). ' +
        'Idempotent: returns ok:false if no such schedule exists. Returns { ok }.',
      inputSchema: {
        id: z.number().int().describe('The flow schedule id to stop (from cockpit_flow_schedule_list)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('flow-schedule/stop', { id });
        return res.ok
          ? ok(`Stopped flow schedule #${id}.`, { ok: true })
          : fail(`No flow schedule #${id} (already stopped?). Check cockpit_flow_schedule_list.`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
