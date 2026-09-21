// Control SSE and view-owned chat SSE are separate. Native cursors and message
// projections remain in the browser; typed POSTs also serve older event pages.

import { ServerEvent, Intents, NativeChatStreamRequest } from '@cockpit/protocol';
import type { NativeAttachment, IntentName, IntentBody, IntentResult, ExitPlanModeAction, NativeChatPage } from '@cockpit/protocol';
import { EVENTS_URL, CHAT_STREAM_URL, intentUrl } from '../lib/config';
import { reportUxError, describeReason } from '../lib/errorReporter';
import { consumeChatStream } from './chatStream';
import type { NativeDraftRequest } from '../lib/draft';

// The client always actively (re)connects, so externally there are only two
// states the UI cares about: actively connecting/reconnecting, or connected.
export type ConnState = 'connecting' | 'open';

// A `fetch()` that fails at the transport layer (no HTTP response at all — the
// network dropped, the tab was backgrounded mid-request, or nginx returned a
// brief 502 during a server restart) rejects with a `TypeError` in every browser
// (WebKit surfaces it as "Load failed", Chrome as "Failed to fetch"). This is
// CONNECTIVITY, not an application bug: reconnect retains the browser's cursor
// and attempts native continuation without a whole-window refresh. We classify
// it so the self-reporting error pipeline never mistakes a blip for a bug.
export function isTransportError(e: unknown): boolean {
  return e instanceof TypeError;
}

export class IntentHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly sessionId?: string;

  constructor(message: string, status: number, code?: string, sessionId?: string) {
    super(message);
    this.name = 'IntentHttpError';
    this.status = status;
    this.code = code;
    this.sessionId = sessionId;
  }
}

export class SessionUnloadedError extends Error {
  constructor() {
    super('会话尚未加载，无法读取原生会话数据；请先显式恢复会话。');
    this.name = 'SessionUnloadedError';
  }
}

export function isSessionUnloadedError(e: unknown): e is SessionUnloadedError | IntentHttpError {
  return e instanceof SessionUnloadedError
    || (e instanceof IntentHttpError && e.status === 409 && e.code === 'SESSION_UNLOADED');
}

interface NetClientCallbacks {
  onEvent: (ev: ServerEvent) => void;
  onStateChange: (state: ConnState) => void;
  sessionTitle?: (sessionId: string) => string | undefined;
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
    this.closeEventSource();
    this.cb.onStateChange('connecting');
    // withCredentials so the auth cookie is sent on the SSE request.
    const es = new EventSource(EVENTS_URL, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      if (this.closedByUser || this.es !== es) return;
      this.backoffMs = 0;
      this.cb.onStateChange('open');
    };
    es.onerror = () => {
      if (this.closedByUser || this.es !== es) return;
      // EventSource only auto-reconnects on a transient network drop (readyState
      // stays CONNECTING). A non-2xx / non-event-stream response — e.g. nginx 502
      // while the backend restarts — puts it in CLOSED, where the browser gives up.
      // So we take over and reconnect with backoff; the user never needs to retry.
      if (es.readyState === EventSource.CLOSED) this.scheduleReconnect();
      else this.cb.onStateChange('connecting');
    };
    es.onmessage = (e) => {
      if (this.closedByUser || this.es !== es) return;
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

  private closeEventSource(): void {
    const es = this.es;
    this.es = null;
    try { es?.close(); } catch { /* ignore */ }
  }

  // Schedule a reconnect with exponential backoff (1s → 8s cap). Stays in the
  // 'connecting' state throughout so the UI reads as "reconnecting", not "failed".
  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    this.closeEventSource();
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
    this.closeEventSource();
  }

  // Fire an intent. Throws on transport/HTTP error; returns the typed result.
  async intent<K extends IntentName>(name: K, body: IntentBody<K>, signal?: AbortSignal): Promise<IntentResult<K>> {
    const sessionId = 'sessionId' in body && typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const target = sessionId ? `会话 ${this.cb.sessionTitle?.(sessionId) ?? sessionId} (${sessionId})` : undefined;
    const resource = name === 'fs/listDir'
      ? `目录 ${'path' in body && typeof body.path === 'string' ? body.path : '服务器主目录（未指定路径）'}`
      : 'name' in body && typeof body.name === 'string' ? body.name : undefined;
    const source = [target, resource].filter(Boolean).join(' · ');
    try {
      // Validate native prompt fields even when callers pass extra runtime properties.
      const payload = name === 'prompt' ? Intents.prompt.body.parse(body) : body;
      const expectedSessionId = 'sessionId' in payload ? payload.sessionId : undefined;
      const res = await fetch(intentUrl(name), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = json && typeof json === 'object' ? json as Record<string, unknown> : {};
        const message = typeof details.error === 'string' ? details.error
          : typeof details.message === 'string' ? details.message : `intent ${name} failed (${res.status})`;
        throw new IntentHttpError(message, res.status, typeof details.code === 'string' ? details.code : undefined,
          typeof details.sessionId === 'string' ? details.sessionId : undefined);
      }
      const result = Intents[name].result.parse(json);
      if (name === 'session/chat' && 'sessionId' in result && result.sessionId !== expectedSessionId) {
        throw new Error(`intent ${name} returned sessionId ${JSON.stringify(result.sessionId)} instead of ${JSON.stringify(expectedSessionId)}`);
      }
      return result as IntentResult<K>;
    } catch (e) {
      // Diagnostics stay local. Never execute a prompt or retry an uncertain POST.
      if (!signal?.aborted && !isSessionUnloadedError(e)
        && (name !== 'session/chat' || !isTransportError(e))) {
        reportUxError(`${source ? `${source}：` : ''}接口 ${name} 调用失败：${describeReason(e, false)}`, { deduplicate: false });
      }
      throw e;
    }
  }

  // --- typed intent helpers --------------------------------------------------
  newSession(cwd: string, roles?: IntentBody<'session/new'>['roles']) { return this.intent('session/new', { cwd, ...(roles ? { roles } : {}) }); }
  listRoles() { return this.intent('roles/list', {}); }
  addRoles(sessionId: string, roles: IntentBody<'roles/add'>['roles']) { return this.intent('roles/add', { sessionId, roles }); }
  roleReadiness(sessionId: string) { return this.intent('roles/readiness', { sessionId }); }
  chat(body: IntentBody<'session/chat'>, signal?: AbortSignal) { return this.intent('session/chat', body, signal); }
  async chatStream(
    body: NativeChatStreamRequest, receive: (page: NativeChatPage) => void, signal: AbortSignal,
  ): Promise<void> {
    const request = NativeChatStreamRequest.parse(body);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const response = await fetch(CHAT_STREAM_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(request), signal: controller.signal,
      });
      if ([502, 503, 504].includes(response.status)) throw new TypeError('聊天实时连接暂时不可用。');
      if (!response.ok) {
        const value: unknown = await response.json();
        const detail = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        throw new IntentHttpError(
          typeof detail.error === 'string' ? detail.error : `聊天实时请求失败 (${response.status})`,
          response.status, typeof detail.code === 'string' ? detail.code : undefined,
        );
      }
      await consumeChatStream(response, event => {
        if (event.type === 'error') throw new IntentHttpError(
          event.error, event.code === 'SESSION_UNLOADED' ? 409 : 500, event.code,
        );
        const page = event.page;
        if (page.sessionId !== request.sessionId || page.source !== 'live' || page.direction !== 'forward'
          || page.events.length > request.max) throw new Error('聊天实时页面与请求范围不匹配。');
        signal.throwIfAborted();
        receive(page);
      });
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  prompt(sessionId: string, text: string, attachments?: NativeAttachment[], mode?: 'enqueue' | 'immediate') {
    return this.intent('prompt', { sessionId, text,
      ...(attachments?.length ? { attachments } : {}), ...(mode ? { mode } : {}) });
  }
  sendDraft(request: NativeDraftRequest) {
    switch (request.intent) {
      case 'prompt': return this.intent('prompt', Intents.prompt.body.strict().parse(request.body));
      case 'respondAsk': return this.intent('respondAsk', Intents.respondAsk.body.strict().parse(request.body));
      case 'planSupersede': return this.intent('planSupersede', Intents.planSupersede.body.strict().parse(request.body));
      default: throw new Error('Unsupported native draft route');
    }
  }
  cancel(sessionId: string) { return this.intent('cancel', { sessionId }); }
  interrupt(sessionId: string) { return this.intent('session/interrupt', { sessionId }); }
  setModel(sessionId: string, modelId: string, opts?: { reasoningEffort?: string; contextTier?: 'default' | 'long_context' }) {
    return this.intent('setModel', { sessionId, modelId, ...opts });
  }
  deleteSession(sessionId: string) {
    return this.intent('session/delete', { sessionId });
  }
  loadSession(sessionId: string) { return this.intent('session/load', { sessionId }); }
  getResources(sessionId: string, resources: import('@cockpit/protocol').MetaResource[], signal?: AbortSignal) {
    return this.intent('session/resources', { sessionId, resources }, signal);
  }
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
  skillsGlobal(cwd?: string) { return this.intent('skills/global', cwd === undefined ? {} : { cwd }); }
  skillsRead(name: string, cwd?: string) { return this.intent('skills/read', { name, ...(cwd ? { cwd } : {}) }); }
  skillsSetGlobal(name: string, enabled: boolean, cwd?: string) {
    return this.intent('skills/global-toggle', { name, enabled, ...(cwd === undefined ? {} : { cwd }) });
  }
  skillsSession(sessionId: string) { return this.intent('skills/session', { sessionId }); }
  skillsToggleSession(sessionId: string, name: string, enabled: boolean) { return this.intent('skills/session-toggle', { sessionId, name, enabled }); }
  listDir(path?: string) { return this.intent('fs/listDir', path === undefined ? {} : { path }); }
}
