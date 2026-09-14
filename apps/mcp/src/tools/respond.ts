// Respond tools: answer the requests a session raises and pauses on — an
// ask_user question, an exit-plan-mode approval, or an elicitation. This is what
// lets an agent/orchestrator unblock another session that is waiting on a human.
// Get the requestId from cockpit_get_session (ask / planRequest / elicitation).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
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
        await intent('respondAsk', {
          sessionId: session_id,
          requestId: request_id,
          answer,
          wasFreeform: was_freeform,
        });
        return ok(`Answered ask ${request_id} on ${session_id}.`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_respond_plan ─────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_respond_plan',
    {
      title: 'Handle an exit-plan-mode request',
      description:
        'Respond to a session paused on an exit_plan_mode request (the agent finished planning and ' +
        'asks how to proceed). Get the requestId and the offered actions from cockpit_get_session with response_format:"json" → ' +
        'planRequest. action is one of: exit_only (just leave plan mode), interactive (proceed ' +
        'interactively), autopilot (proceed autonomously), autopilot_fleet. This selects interaction ' +
        'behavior, not tool permissions; permissionPolicy remains allow-all (always auto-approve).',
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
        await intent('respondPlan', {
          sessionId: session_id,
          requestId: request_id,
          action,
        });
        return ok(`Responded to plan ${request_id} on ${session_id} with "${action}".`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_plan_supersede ───────────────────────────────────────────────────
  server.registerTool(
    'cockpit_plan_supersede',
    {
      title: 'Submit feedback on a pending plan',
      description:
        'Respond to a pending exit_plan_mode request with native approved:false and feedback:message, ' +
        'rather than approving one of its offered actions. Cockpit resolves the native callback only: ' +
        'it sends no separate prompt or mode change. The native runtime controls subsequent behavior. ' +
        'Plainly enqueuing cockpit_send_prompt does not answer the pending request. ' +
        'Get the requestId from cockpit_get_session → planRequest.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        request_id: z.string().min(1).describe('The pending plan requestId (from cockpit_get_session → planRequest.requestId)'),
        message: z.string().min(1).describe('Feedback to return to the native pending plan request'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, request_id, message }): Promise<ToolResult> => {
      try {
        await intent('planSupersede', {
          sessionId: session_id,
          requestId: request_id,
          message,
        });
        return ok(`Submitted native plan feedback for ${request_id} on ${session_id}. Subsequent behavior is controlled by the native runtime.`);
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
        await intent('respondElicitation', {
          sessionId: session_id,
          requestId: request_id,
          action,
        });
        return ok(`Responded to elicitation ${request_id} on ${session_id} with "${action}".`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
