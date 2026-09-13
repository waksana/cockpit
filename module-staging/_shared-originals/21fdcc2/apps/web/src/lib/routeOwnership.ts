import { notificationDestination, OPEN_SESSION_ACK_TYPE, OPEN_SESSION_MESSAGE_TYPE } from './notificationRouting';

export const SESSION_PANELS = ['info', 'mcp', 'skills', 'plan', 'context', 'schedules', 'runtime'] as const;
export type SessionPanel = typeof SESSION_PANELS[number];
export const SESSION_PANEL_LABELS: Record<SessionPanel, string> = {
  info: '设置', mcp: 'MCP', skills: 'Skills', plan: '计划与任务',
  schedules: '定时任务', context: '上下文资料', runtime: '运行维护',
};

export function sessionRoute(pathname: string): { sessionId: string | null; panel: SessionPanel | null } {
  const match = /^\/session\/([^/]+)(?:\/([^/]+))?\/?$/i.exec(pathname);
  if (!match) return { sessionId: null, panel: null };
  try {
    const sessionId = decodeURIComponent(match[1]);
    const panel = match[2] === 'automation' ? 'schedules' : match[2];
    return { sessionId, panel: SESSION_PANELS.includes(panel as SessionPanel) ? panel as SessionPanel : null };
  } catch {
    return { sessionId: null, panel: null };
  }
}

export function sessionPath(sessionId: string, panel?: SessionPanel): string {
  return `/session/${encodeURIComponent(sessionId)}${panel ? `/${panel}` : ''}`;
}

export function focusedSessionId(pathname: string, phone: boolean): string | null {
  const route = sessionRoute(pathname);
  return phone && route.panel !== null ? null : route.sessionId;
}

export function sessionNavigation(pathname: string, sessionId: string) {
  return { to: sessionPath(sessionId), replace: sessionRoute(pathname).sessionId !== null };
}

export function detailsNavigation(pathname: string, sessionId: string, panel: SessionPanel) {
  const route = sessionRoute(pathname);
  return {
    to: sessionPath(sessionId, panel),
    replace: route.panel !== null || (route.sessionId !== null && route.sessionId !== sessionId),
  };
}

// Both notification transports belong to the root, not the chat route's lifetime.
export function subscribeSessionNotifications(
  browser: EventTarget,
  serviceWorker: EventTarget | undefined,
  onOpen: (sessionId: string) => unknown,
): () => void {
  let subscribed = true;
  const warn = () => console.warn('[notifications] Session notification navigation was not accepted.');
  const open = (sessionId: string, target: string, port?: MessagePort) => {
    const accept = (result: unknown) => {
      if (!subscribed || result === false || !port) return;
      try {
        port.postMessage({ type: OPEN_SESSION_ACK_TYPE, target });
      } catch {
        warn();
      }
    };
    try {
      // Legacy void callbacks accept synchronously; promises defer acceptance, false refuses it.
      const result = onOpen(sessionId);
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && 'then' in result && typeof result.then === 'function') {
        void Promise.resolve(result).then(accept, warn);
      } else {
        accept(result);
      }
    } catch {
      warn();
    }
  };
  const onBrowser = (event: Event) => {
    try {
      const { sessionId, target } = notificationDestination((event as CustomEvent<unknown>).detail);
      if (sessionId !== null) open(sessionId, target);
    } catch {
      warn();
    }
  };
  const onWorker = (event: Event) => {
    try {
      const message = event as MessageEvent<unknown>;
      const data = message.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || !('type' in data) || data.type !== OPEN_SESSION_MESSAGE_TYPE) return;
      const { sessionId, target } = notificationDestination(data);
      if (sessionId === null || ('target' in data && data.target !== target)) return;
      open(sessionId, target, 'target' in data ? message.ports?.[0] : undefined);
    } catch {
      warn();
    }
  };
  browser.addEventListener('cockpit:open-session', onBrowser);
  serviceWorker?.addEventListener('message', onWorker);
  return () => {
    subscribed = false;
    browser.removeEventListener('cockpit:open-session', onBrowser);
    serviceWorker?.removeEventListener('message', onWorker);
  };
}

export function notificationStatus({ notifSupported, notifPermission, notifReady }: {
  notifSupported: boolean; notifPermission: NotificationPermission | 'unsupported'; notifReady: boolean;
}): { label: string; enabled: boolean } {
  if (!notifSupported || notifPermission === 'unsupported') {
    return { label: '通知：此浏览器不支持（可尝试添加到主屏）', enabled: false };
  }
  if (notifPermission === 'denied') return { label: '通知：已被系统拒绝（去设置开启）', enabled: false };
  if (notifReady) return { label: '通知：已就绪', enabled: false };
  if (notifPermission === 'granted') return { label: '通知：已授权，订阅未就绪（重试）', enabled: true };
  return { label: '开启通知', enabled: true };
}
