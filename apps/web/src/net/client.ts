// Cockpit transport client: SSE for server→client domain events, fetch POST for
// client→server intents. Replaces the old hand-rolled WebSocket JSON-RPC client.
//
// Why SSE + POST (not WS): our shape is one long-lived server push stream plus
// sparse client intents. EventSource gives free auto-reconnect + a fresh
// snapshot on (re)connect, cookie auth "just works", and intents are plain POSTs
// that return their typed result directly — no frame scanner, no request/
// response correlation, no heartbeat plumbing.

import { ServerEvent, Intents } from '@cockpit/protocol';
import type { IntentName, IntentBody, IntentResult, ExitPlanModeAction } from '@cockpit/protocol';
import { EVENTS_URL, intentUrl } from '../lib/config';
import { reportUxError, describeReason } from '../lib/errorReporter';

// The client always actively (re)connects, so externally there are only two
// states the UI cares about: actively connecting/reconnecting, or connected.
export type ConnState = 'connecting' | 'open';

// A `fetch()` that fails at the transport layer (no HTTP response at all — the
// network dropped, the tab was backgrounded mid-request, or nginx returned a
// brief 502 during a server restart) rejects with a `TypeError` in every browser
// (WebKit surfaces it as "Load failed", Chrome as "Failed to fetch"). This is
// CONNECTIVITY, not an application bug: the EventSource reconnect + snapshot
// re-materialize path already recovers from it with no user action. We classify
// it so the self-reporting error pipeline never mistakes a blip for a bug.
export function isTransportError(e: unknown): boolean {
  return e instanceof TypeError;
}

export interface NetClientCallbacks {
  onEvent: (ev: ServerEvent) => void;
  onStateChange: (state: ConnState) => void;
}

export class NetClient {
  private es: EventSource | null = null;
  private cb: NetClientCallbacks;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 0;
  private static readonly BACKOFF_BASE = 1000;
  private static readonly BACKOFF_MAX = 8000;

  constructor(cb: NetClientCallbacks) {
    this.cb = cb;
    // Reconnect instantly when the network returns or the tab becomes visible,
    // instead of waiting out the backoff delay (Telegram-like responsiveness).
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.kick);
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  get isOpen(): boolean { return this.es?.readyState === EventSource.OPEN; }
  get userClosed(): boolean { return this.closedByUser; }

  connect(): void {
    this.closedByUser = false;
    this.clearReconnectTimer();
    if (this.es) { try { this.es.close(); } catch { /* ignore */ } this.es = null; }
    this.cb.onStateChange('connecting');
    // withCredentials so the auth cookie is sent on the SSE request.
    const es = new EventSource(EVENTS_URL, { withCredentials: true });
    this.es = es;
    es.onopen = () => { this.backoffMs = 0; this.cb.onStateChange('open'); };
    es.onerror = () => {
      if (this.closedByUser) return;
      // EventSource only auto-reconnects on a transient network drop (readyState
      // stays CONNECTING). A non-2xx / non-event-stream response — e.g. nginx 502
      // while the backend restarts — puts it in CLOSED, where the browser gives up.
      // So we take over and reconnect with backoff; the user never needs to retry.
      if (es.readyState === EventSource.CLOSED) this.scheduleReconnect();
      else this.cb.onStateChange('connecting');
    };
    es.onmessage = (e) => {
      let parsed: unknown;
      try { parsed = JSON.parse(e.data); } catch { return; }
      const res = ServerEvent.safeParse(parsed);
      if (res.success) this.cb.onEvent(res.data);
      // The server validates inbound intents but not outbound events (compile-time
      // only), so a schema mismatch would otherwise drop a message silently. Warn
      // so it's diagnosable rather than an invisible gap. (L4)
      else console.warn('[cockpit] dropped unparseable server event:', res.error.issues[0]?.message, parsed);
    };
  }

  // Schedule a reconnect with exponential backoff (1s → 8s cap). Stays in the
  // 'connecting' state throughout so the UI reads as "reconnecting", not "failed".
  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    if (this.es) { try { this.es.close(); } catch { /* ignore */ } this.es = null; }
    this.cb.onStateChange('connecting');
    const delay = this.backoffMs || NetClient.BACKOFF_BASE;
    this.backoffMs = Math.min((this.backoffMs || NetClient.BACKOFF_BASE) * 1.7, NetClient.BACKOFF_MAX);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  // Reconnect immediately (reset backoff) unless already open or user-closed.
  private kick = (): void => {
    if (this.closedByUser || this.isOpen) return;
    this.backoffMs = 0;
    this.clearReconnectTimer();
    this.connect();
  };

  private onVisible = (): void => { if (document.visibilityState === 'visible') this.kick(); };

  disconnect(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.kick);
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    try { this.es?.close(); } catch { /* ignore */ }
    this.es = null;
  }

  // Fire an intent. Throws on transport/HTTP error; returns the typed result.
  async intent<K extends IntentName>(name: K, body: IntentBody<K>): Promise<IntentResult<K>> {
    try {
      const res = await fetch(intentUrl(name), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `intent ${name} failed (${res.status})`);
      return Intents[name].result.parse(json) as IntentResult<K>;
    } catch (e) {
      // Auto-report API failures to the current session — EXCEPT (a) the `prompt`
      // intent, because an error report IS a prompt; reporting its failure would
      // loop, (b) `speech/token`, which is a best-effort, self-healing warm-up
      // (voice silently falls back to the Web Speech API on any failure, and the
      // intent legitimately doesn't exist on an older backend during a deploy
      // window) — reporting it would spam sessions with benign noise, and (c)
      // transport-level failures (a dropped/blipped connection), because those are
      // connectivity, not application bugs — the reconnect path already heals them,
      // and reporting them spams the session with noise like "接口 session/history
      // 调用失败：Load failed" every time the tab backgrounds or the server
      // gracefully restarts. Genuine server errors (a real HTTP status) and schema
      // mismatches still report. Re-throw either way so callers handle it as before.
      if (name !== 'prompt' && name !== 'speech/token' && !isTransportError(e)) {
        reportUxError(`接口 ${name} 调用失败：${describeReason(e, false)}`);
      }
      throw e;
    }
  }

  // --- typed intent helpers --------------------------------------------------
  newSession(cwd: string) { return this.intent('session/new', { cwd }); }
  history(sessionId: string, opts?: { beforeMsgId?: string; afterMsgId?: string; limit?: number }) {
    return this.intent('session/history', { sessionId, ...opts });
  }
  peek(sessionId: string, opts?: { beforeMsgId?: string; limit?: number }) {
    return this.intent('session/peek', { sessionId, ...opts });
  }
  prompt(sessionId: string, text: string, mode?: 'enqueue' | 'immediate') {
    return this.intent('prompt', { sessionId, text, ...(mode ? { mode } : {}) });
  }
  cancel(sessionId: string) { return this.intent('cancel', { sessionId }); }
  setModel(sessionId: string, modelId: string, opts?: { reasoningEffort?: string; contextTier?: 'default' | 'long_context' }) {
    return this.intent('setModel', { sessionId, modelId, ...opts });
  }
  deleteSession(sessionId: string, reason?: string) { return this.intent('session/delete', { sessionId, ...(reason ? { reason } : {}) }); }
  restoreSession(sessionId: string) { return this.intent('session/restore', { sessionId }); }
  trashList() { return this.intent('session/trash-list', {}); }
  unloadSession(sessionId: string) { return this.intent('session/unload', { sessionId }); }
  reloadSession(sessionId: string) { return this.intent('session/reload', { sessionId }); }
  pinSession(sessionId: string, pinned: boolean) { return this.intent('session/pin', { sessionId, pinned }); }
  renameSession(sessionId: string, name: string) { return this.intent('session/rename', { sessionId, name }); }
  compactSession(sessionId: string, customInstructions?: string) { return this.intent('session/compact', { sessionId, ...(customInstructions ? { customInstructions } : {}) }); }
  rewindSession(sessionId: string, toMsgId: string, rollbackFiles?: boolean) { return this.intent('session/rewind', { sessionId, toMsgId, ...(rollbackFiles ? { rollbackFiles } : {}) }); }
  setMode(sessionId: string, mode: 'interactive' | 'plan' | 'autopilot') { return this.intent('setMode', { sessionId, mode }); }
  getPlan(sessionId: string) { return this.intent('session/plan', { sessionId }); }
  getPanels(sessionId: string) { return this.intent('session/panels', { sessionId }); }
  scheduleList(sessionId: string) { return this.intent('schedule/list', { sessionId }); }
  hookList(ownerSession?: string) { return this.intent('hook/list', ownerSession ? { ownerSession } : {}); }
  flowList() { return this.intent('flow/list', {}); }
  flowScheduleList() { return this.intent('flow-schedule/list', {}); }
  respondAsk(sessionId: string, requestId: string, answer: string, wasFreeform: boolean) {
    return this.intent('respondAsk', { sessionId, requestId, answer, wasFreeform });
  }
  respondPlan(sessionId: string, requestId: string, action: ExitPlanModeAction) {
    return this.intent('respondPlan', { sessionId, requestId, action });
  }
  planSupersede(sessionId: string, requestId: string, message: string) {
    return this.intent('planSupersede', { sessionId, requestId, message });
  }
  respondElicitation(sessionId: string, requestId: string, action: 'accept' | 'decline' | 'cancel') {
    return this.intent('respondElicitation', { sessionId, requestId, action });
  }
  removeQueued(sessionId: string, itemId: string) { return this.intent('queue/remove', { sessionId, itemId }); }
  refresh() { return this.intent('session/refresh', {}); }
  // MCP + Skills management
  mcpGlobal() { return this.intent('mcp/global', {}); }
  mcpSetDefault(name: string, on: boolean) { return this.intent('mcp/global-default', { name, on }); }
  mcpRefresh() { return this.intent('mcp/refresh', {}); }
  mcpSession(sessionId: string) { return this.intent('mcp/session', { sessionId }); }
  mcpToggleSession(sessionId: string, name: string, on: boolean) { return this.intent('mcp/session-toggle', { sessionId, name, on }); }
  skillsGlobal() { return this.intent('skills/global', {}); }
  skillsRead(name: string) { return this.intent('skills/read', { name }); }
  skillsSession(sessionId: string) { return this.intent('skills/session', { sessionId }); }
  skillsToggleSession(sessionId: string, name: string, enabled: boolean) { return this.intent('skills/session-toggle', { sessionId, name, enabled }); }
  listDir(path?: string) { return this.intent('fs/listDir', path ? { path } : {}); }
  subscribePush(subscription: PushSubscriptionJSON) {
    return this.intent('push/subscribe', { subscription: subscription as never });
  }
  inboxSeen(sessionId: string) { return this.intent('inbox/seen', { sessionId }); }
  speechToken() { return this.intent('speech/token', {}); }
}
