import { isAbsolute } from 'node:path';
import type { SessionEvent } from '@github/copilot-sdk';
import type { NativeChatEvent, SessionMeta } from '@cockpit/protocol';
import { cleanSessionTitle } from '@cockpit/protocol';
import { normalizeEvent } from './sdk-types.ts';
import { messageOf } from './async.ts';
import type { SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';
import type { DecisionBroker } from './decisions.ts';

export interface NativeObservation {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly workspacePath?: string | null;
  readonly event: NativeChatEvent;
}

const controlEvents = new Set([
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort',
  'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
]);

/**
 * Applies live native events to a session handle: read-only observer fan-out,
 * turn/interrupt bookkeeping and resource invalidation hints.
 */
export class NativeEvents {
  private readonly k: SessionKernel;
  private readonly decisions: DecisionBroker;
  private readonly nativeObservers = new Map<(event: NativeObservation) => void | Promise<void>, ReadonlySet<string> | undefined>();

  constructor(k: SessionKernel, decisions: DecisionBroker) {
    this.k = k;
    this.decisions = decisions;
  }

  /** Live notifications only; optional types are matched before copying event payloads. */
  onNativeEvent(handler: (event: NativeObservation) => void | Promise<void>, options?: { types: readonly string[] }): () => void {
    this.nativeObservers.set(handler, options ? new Set(options.types) : undefined);
    return () => { this.nativeObservers.delete(handler); };
  }

  observeNative(st: SessionHandle, native: SessionEvent): void {
    if (native.type === 'session.context_changed') {
      const { data, agentId, parentToolCallId } = normalizeEvent(native);
      if (!agentId && !parentToolCallId && !data.agentId && !data.parentToolCallId) {
        if (typeof data.cwd === 'string' && isAbsolute(data.cwd) && !data.cwd.includes('\0')) {
          st.observedCwd = data.cwd;
          if (st.eventOwner) st.eventOwner.contextChanged = true;
        }
        else {
          try { this.k.log('native observer ignored invalid working directory', { sessionId: st.id }); }
          catch { /* Observer diagnostics cannot affect native control state. */ }
        }
      }
    }
    let interested = false;
    for (const types of this.nativeObservers.values()) {
      if (!types || types.has(native.type)) { interested = true; break; }
    }
    if (!interested) return;
    const report = (error: unknown) => {
      try { this.k.log('native observer failed', { sessionId: st.id, error: messageOf(error) }); }
      catch { /* Observers and their reporters cannot affect native control state. */ }
    };
    let workspacePath: string | null | undefined;
    try {
      if (st.sdk) {
        const path = st.sdk.workspacePath;
        if (path == null || (typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))) {
          workspacePath = path ?? null;
        } else report(new Error('Invalid native workspace path'));
      }
    } catch (error) { report(error); }
    try {
      const clean = (value: unknown): unknown => {
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
        if (Array.isArray(value)) return Object.freeze(value.map(clean));
        if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'binaryResultsForLlm').map(([key, item]) => [key, clean(item)]),
        ));
        return value;
      };
      const event = clean(normalizeEvent(native)) as NativeChatEvent;
      const observation = Object.freeze({
        sessionId: st.id, cwd: st.observedCwd ?? null,
        ...(workspacePath !== undefined ? { workspacePath } : {}), event,
      });
      for (const [observer, types] of this.nativeObservers) {
        if (types && !types.has(native.type)) continue;
        try { void Promise.resolve(observer(observation)).catch(report); }
        catch (error) { report(error); }
      }
    } catch (error) { report(error); }
  }

  onLive(st: SessionHandle, native: SessionEvent): void {
    if ((!st.sdk && !st.eventOwner) || this.k.failure
      || (!native.type.startsWith('session.') && native.type !== 'pending_messages.modified' && !controlEvents.has(native.type))) return;
    const event = normalizeEvent(native);
    st.revision++;
    const data = event.data;
    const root = !event.agentId && !event.parentToolCallId && !data.parentToolCallId && !data.agentId;
    if (root && event.type === 'user.message') {
      for (const id of [native.id, data.messageId]) {
        if (typeof id !== 'string') continue;
        st.accepted.delete(id);
        st.steeringAccepted.delete(id);
        if (st.sends) st.sendReceipts.add(id);
      }
      this.k.patch(st, { lastActivity: Date.now(), lastActivitySource: 'host-event-receipt' });
    }
    if (root && event.type !== 'user.message' && typeof data.interactionId === 'string'
      && st.interactionId && data.interactionId !== st.interactionId
      && (event.type.startsWith('assistant.') || event.type === 'session.error')) return;
    if (root && ((event.type === 'user.message' && data.delivery !== 'steering') || event.type === 'assistant.turn_start')) {
      st.turnEpoch++;
      st.interruptedEpoch = undefined;
      st.interactionId = typeof data.interactionId === 'string' ? data.interactionId : undefined;
    }
    if (root && event.type === 'session.idle' && !st.interruptTurn) st.interactionId = undefined;
    // Late lifecycle effects from an interrupted interaction must not erase the
    // queued turn's reply/decision state; its transcript remains native history.
    if (root && event.type.startsWith('assistant.') && st.interruptedEpoch === st.turnEpoch) return;
    if (root && st.interruptTurn && (event.type === 'abort'
      || (event.type === 'assistant.turn_start' && typeof data.interactionId === 'string'
        && st.interruptTurn.interactionId && data.interactionId !== st.interruptTurn.interactionId))) {
      this.decisions.clearInterruptedTurn(st, st.interruptTurn);
      st.interruptTurn = undefined;
    }
    if (event.type === 'session.shutdown'
      || (event.type === 'session.connection_state_changed' && ['reconnecting', 'disconnected'].includes(String(data.state)))) {
      st.activityRevision++;
      this.k.patch(st, { activity: null, controls: null });
      this.k.probe(st);
      return;
    }
    if (event.type === 'session.connection_state_changed' && data.state === 'connected') {
      this.k.invalidate(st, ['control']);
      return;
    }
    if (root && ['user.message', 'abort', 'session.compaction_start'].includes(event.type)) {
      this.k.invalidate(st, ['control', 'queue']);
    }
    if (native.type === 'tool.execution_complete') {
      this.k.scheduleSync(st);
    }
    if (root && event.type === 'tool.execution_start' && data.toolName === 'report_intent') {
      const args = data.arguments as { intent?: string } | undefined;
      if (typeof args?.intent === 'string') this.k.patch(st, { intent: args.intent });
    }
    if (root && event.type === 'assistant.turn_start') {
      this.k.patch(st, { status: 'running', nativeProcessing: true, error: null });
      this.k.invalidate(st, ['control', 'queue']);
    }
    if (root && event.type === 'assistant.turn_end') {
      this.k.scheduleSync(st, ['identity', 'control', 'queue', 'usage']);
    }
    if (event.type === 'session.error') {
      this.k.patch(st, { status: 'error', error: String(data.message ?? 'Native turn failed') });
    }
    if (event.type === 'session.title_changed' && typeof data.title === 'string') this.k.patch(st, { title: cleanSessionTitle(data.title) });
    if (event.type === 'session.mode_changed' && ['interactive', 'plan', 'autopilot'].includes(String(data.newMode))) {
      this.k.patch(st, { currentMode: data.newMode as SessionMeta['currentMode'] });
    }
    if (root && event.type === 'session.compaction_start') {
      st.observedCompaction = true;
      this.k.patch(st, { compacting: true });
    }
    if (root && event.type === 'session.compaction_complete') {
      st.observedCompaction = false;
      this.k.patch(st, { compacting: false });
    }
    switch (native.type) {
      case 'session.idle':
      case 'session.error':
      case 'pending_messages.modified':
        this.k.scheduleSync(st);
        break;
      case 'session.background_tasks_changed':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
        this.k.scheduleSync(st, ['control', 'tasks']);
        break;
      case 'session.compaction_complete':
        this.k.scheduleSync(st, ['control', 'usage']);
        break;
      case 'session.context_changed':
        this.k.invalidate(st, ['identity', 'instructions', 'usage']);
        break;
      case 'session.context_cleared':
        this.k.invalidate(st, ['identity', 'control', 'queue', 'plan', 'todo', 'tasks', 'instructions', 'usage']);
        break;
      case 'session.plan_changed':
        this.k.invalidate(st, ['plan']);
        break;
      case 'session.skills_loaded':
        this.k.invalidate(st, ['skills', 'usage']);
        break;
      case 'session.tools_updated':
        this.k.invalidate(st, ['usage']);
        break;
      case 'session.schedule_created':
      case 'session.schedule_cancelled':
      case 'session.schedule_rearmed':
        this.k.invalidate(st, ['schedule']);
        break;
      case 'session.todos_changed':
        this.k.invalidate(st, ['todo', 'plan']);
        break;
      case 'session.model_change':
        this.k.invalidate(st, ['model', 'models', 'usage']);
        break;
      case 'session.usage_info':
      case 'session.usage_checkpoint':
        this.k.invalidate(st, ['usage']);
        break;
      case 'session.mcp_servers_loaded':
      case 'session.mcp_server_removed':
      case 'session.mcp_server_status_changed':
        this.k.scheduleSync(st, ['control', 'mcp', 'usage']);
        break;
    }
  }
}
