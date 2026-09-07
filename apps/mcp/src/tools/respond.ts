// Respond tools: answer the requests a session raises and pauses on — an
// ask_user question, an exit-plan-mode approval, or an elicitation. This is what
// lets an agent/orchestrator unblock another session that is waiting on a human.
// Get the requestId from cockpit_get_session (ask / planRequest / elicitation).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import { ok, fail, type ToolResult } from '../shared.js';

export function registerRespondTools(server: McpServer): void {
  // ── cockpit_respond_ask ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_respond_ask',
    {
      title: 'Answer an ask_user question',
      description:
        'Answer a session that is paused on an ask_user question (the choice card a session shows ' +
        'when the agent calls ask_user). Get the requestId and the question/choices from ' +
        'cockpit_get_session → ask. Pass the chosen text as answer; set was_freeform=true if it is ' +
        'free text rather than one of the offered choices. This unblocks the waiting session.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        request_id: z.string().min(1).describe('The ask requestId (from cockpit_get_session → ask.requestId)'),
        answer: z.string().describe('The answer text (one of ask.choices, or free text)'),
        was_freeform: z.boolean().default(false).describe('true if answer is free text, not an offered choice'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, request_id, answer, was_freeform }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('respondAsk', {
          sessionId: session_id,
          requestId: request_id,
          answer,
          wasFreeform: was_freeform,
        });
        return ok(`Answered ask ${request_id} on ${session_id}.`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_respond_plan ─────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_respond_plan',
    {
      title: 'Approve/handle an exit-plan-mode request',
      description:
        'Respond to a session paused on an exit_plan_mode request (the agent finished planning and ' +
        'asks how to proceed). Get the requestId and the offered actions from cockpit_get_session → ' +
        'planRequest. action is one of: exit_only (just leave plan mode), interactive (proceed ' +
        'interactively), autopilot (proceed autonomously), autopilot_fleet.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        request_id: z.string().min(1).describe('The plan requestId (from cockpit_get_session → planRequest.requestId)'),
        action: z
          .enum(['exit_only', 'interactive', 'autopilot', 'autopilot_fleet'])
          .describe('How to proceed out of plan mode'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, request_id, action }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('respondPlan', {
          sessionId: session_id,
          requestId: request_id,
          action,
        });
        return ok(`Responded to plan ${request_id} on ${session_id} with "${action}".`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_plan_supersede ───────────────────────────────────────────────────
  server.registerTool(
    'cockpit_plan_supersede',
    {
      title: 'Redirect a pending plan with a new instruction',
      description:
        'Supersede a session paused on an exit_plan_mode request by typing a NEW instruction instead ' +
        'of picking one of the plan actions. This is distinct from cockpit_respond_plan: it does NOT ' +
        'execute the proposed plan. Instead it dismisses the pending plan (exit_only, so the plan is ' +
        'discarded, not run), runs `message` as a one-off direct instruction, then automatically ' +
        'returns the session to plan mode once that turn finishes. Use this to change course while a ' +
        'plan is pending — e.g. "forget that, just do X". (Note: plainly enqueuing a prompt via ' +
        'cockpit_send_prompt while a plan is pending only queues it behind the still-blocking request; ' +
        'use this tool to actually redirect.) Get the requestId from cockpit_get_session → planRequest.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        request_id: z.string().min(1).describe('The pending plan requestId (from cockpit_get_session → planRequest.requestId)'),
        message: z.string().min(1).describe('The new instruction to run instead of the plan (the plan is discarded, not executed)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, request_id, message }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('planSupersede', {
          sessionId: session_id,
          requestId: request_id,
          message,
        });
        return ok(`Superseded plan ${request_id} on ${session_id} with a new instruction (plan discarded, message run, session returns to plan mode).`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_respond_elicitation ──────────────────────────────────────────────
  server.registerTool(
    'cockpit_respond_elicitation',
    {
      title: 'Respond to an elicitation request',
      description:
        'Respond to a session paused on an MCP elicitation request (a tool asking the user to ' +
        'accept/decline/cancel). Get the requestId and message from cockpit_get_session → ' +
        'elicitation. action is one of: accept, decline, cancel.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        request_id: z.string().min(1).describe('The elicitation requestId (from cockpit_get_session → elicitation.requestId)'),
        action: z.enum(['accept', 'decline', 'cancel']).describe('The response to the elicitation'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, request_id, action }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('respondElicitation', {
          sessionId: session_id,
          requestId: request_id,
          action,
        });
        return ok(`Responded to elicitation ${request_id} on ${session_id} with "${action}".`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
