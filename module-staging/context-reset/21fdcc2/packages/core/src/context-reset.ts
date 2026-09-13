import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defineTool, type CopilotSession, type SessionEvent, type ToolResultObject } from '@github/copilot-sdk';

export const CONTEXT_RESET_TOOL = 'self_clear_context';
const success: ToolResultObject = { resultType: 'success', textResultForLlm: 'Context cleared. The native runtime will deliver the recovery prompt.' };

/** A session-bound native tool, not a cross-session RPC endpoint or memory policy. */
export function createContextReset(options: {
  session: () => CopilotSession | null;
  assertReady: () => void;
}) {
  let soleCall: string | undefined;
  let runningCall: string | undefined;
  let requestedCall: string | undefined;
  let compacting = false;
  let busy = false;
  let attempted = false;
  let uncertain = false;
  let revision = 0;

  const observe = (event: SessionEvent) => {
    if (['user.message', 'pending_messages.modified', 'subagent.started', 'session.background_tasks_changed',
      'session.compaction_start', 'session.schedule_created', 'session.shutdown'].includes(event.type)) revision++;
    if (event.type === 'external_tool.requested' && event.data.toolName === CONTEXT_RESET_TOOL) {
      requestedCall = !event.agentId && event.data.sessionId === options.session()?.sessionId
        ? event.data.toolCallId : undefined;
    }
    if (event.agentId) return;
    if (event.type === 'assistant.message') {
      const calls = event.data.toolRequests;
      soleCall = calls?.length === 1 && calls[0]?.name === CONTEXT_RESET_TOOL ? calls[0].toolCallId : undefined;
    }
    if (event.type === 'tool.execution_start' && event.data.toolName === CONTEXT_RESET_TOOL
      && !event.data.parentToolCallId) runningCall = event.data.toolCallId;
    if (event.type === 'tool.execution_complete' && event.data.toolCallId === runningCall) {
      runningCall = undefined;
      requestedCall = undefined;
      busy = false;
    }
    if (event.type === 'session.compaction_start') compacting = true;
    if (event.type === 'session.compaction_complete') compacting = false;
    // Native recovery seeds have empty content; they must not re-arm this tool.
    if (event.type === 'user.message' && event.data.content?.trim() && !busy && !uncertain) attempted = false;
    if (event.type === 'session.idle' || event.type === 'session.shutdown') {
      soleCall = undefined;
      runningCall = undefined;
      requestedCall = undefined;
      busy = false;
    }
  };

  const tool = defineTool(CONTEXT_RESET_TOOL, {
    description: 'Clear ONLY your own model context, preserving session ID and event log. First use the self-context-reset skill: persist and reread your own local handoff files, resolve gaps, then call this tool ALONE with a short recovery prompt. Never retry an uncertain result. No other session can invoke this on your behalf.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'Short first user message for the fresh window: exact continuing goal, local files to read, authorization limits and actions not to replay.' },
        handoffFiles: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Absolute local files you have already persisted and reread. Content/format remain your responsibility; nothing is uploaded.' },
      },
      required: ['prompt', 'handoffFiles'],
    },
    isTerminal: true,
    defer: 'never',
    handler: async (args: unknown, invocation): Promise<ToolResultObject> => {
      // SDK starts handlers before forwarding external_tool.requested to onEvent.
      await Promise.resolve();
      if (!args || typeof args !== 'object' || !('prompt' in args) || typeof args.prompt !== 'string'
        || !args.prompt.trim() || !('handoffFiles' in args) || !Array.isArray(args.handoffFiles)
        || !args.handoffFiles.length || !args.handoffFiles.every((path: unknown) => typeof path === 'string' && isAbsolute(path))
        || Object.keys(args).some(key => key !== 'prompt' && key !== 'handoffFiles')) {
        throw new Error('Provide a non-empty recovery prompt and absolute handoffFiles, with no sessionId or other fields.');
      }
      const session = options.session();
      if (!session || invocation.sessionId !== session.sessionId || invocation.toolName !== CONTEXT_RESET_TOOL
        || invocation.toolCallId !== soleCall || invocation.toolCallId !== runningCall
        || invocation.toolCallId !== requestedCall) {
        throw new Error('Context clear requires the bound main session to request this as its only tool call.');
      }
      if (busy || attempted || uncertain) throw new Error('Context clear already attempted in this interaction; do not retry an uncertain result.');
      if (compacting) throw new Error('Context compaction is in progress; wait for it to settle before preparing a clear.');
      options.assertReady();
      busy = true;
      const before = revision;
      let submitted = false;
      try {
        for (const path of args.handoffFiles) {
          const file = await stat(path);
          if (!file.isFile() || file.size === 0) throw new Error(`Handoff must be a non-empty regular file: ${path}`);
          await access(path, constants.R_OK);
        }
        const [queue, tasks, schedules, metadata, permissions] = await Promise.all([
          session.rpc.queue.pendingItems(), session.rpc.tasks.list(), session.rpc.schedule.list(),
          session.rpc.metadata.snapshot(), session.rpc.permissions.pendingRequests(),
        ]);
        if (metadata.isRemote || queue.items.length || queue.steeringMessages.length || queue.inFlightSteeringCount
          || schedules.entries.length || permissions.items.length
          || tasks.tasks.some(task => !['idle', 'completed', 'failed', 'cancelled'].includes(task.status))) {
          throw new Error('Context clear requires a local session with no pending messages, decisions, background tasks or schedules. Finish existing work first; nothing was cancelled.');
        }
        if (options.session() !== session || compacting || invocation.signal?.aborted || before !== revision
          || soleCall !== invocation.toolCallId || runningCall !== invocation.toolCallId || requestedCall !== invocation.toolCallId) {
          throw new Error('Session state changed while preparing context clear; context was not cleared.');
        }
        attempted = true;
        submitted = true;
        await session.rpc.history.clearContext({ prompt: args.prompt });
        // No fallible work after commit: terminality is applied by the runtime on success.
        return success;
      } catch (error) {
        busy = false;
        if (submitted) {
          uncertain = true;
          throw new Error('Context clear outcome is uncertain; do not retry. Inspect native context-cleared/tool-completion events before continuing.', { cause: error });
        }
        throw error;
      }
    },
  });
  return { tool, observe, get busy() { return busy; } };
}
