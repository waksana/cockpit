export const OPEN_SESSION_MESSAGE_TYPE = 'open-session';
export const OPEN_SESSION_ACK_TYPE = 'open-session-ack';

export interface NotificationDestination {
  sessionId: string | null;
  target: string;
}

// Notification data is untrusted; encode the ID once and never use its supplied URL.
export function notificationDestination(info: unknown): NotificationDestination {
  try {
    if (info && typeof info === 'object' && !Array.isArray(info) && 'sessionId' in info) {
      const id = info.sessionId;
      if (typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && !/\p{Cc}/u.test(id)) {
        return { sessionId: id, target: `/session/${encodeURIComponent(id)}` };
      }
    }
  } catch {
    // encodeURIComponent rejects unpaired Unicode surrogates.
  }
  return { sessionId: null, target: '/' };
}

// Structural interfaces keep this helper usable from both worker and DOM tests.
export interface NotificationWindowClient {
  readonly id?: string;
  readonly url: string;
  readonly focused?: boolean;
  readonly visibilityState?: string;
  focus?(): Promise<NotificationWindowClient | null>;
  navigate?(url: string): Promise<NotificationWindowClient | null>;
  postMessage?(message: unknown, transfer: Transferable[]): void;
}

export interface NotificationClients {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly NotificationWindowClient[]>;
  openWindow?(url: string): Promise<NotificationWindowClient | null>;
}

export interface NotificationRoutingOptions {
  /** Defaults to 1000ms; finite overrides are clamped to 0–5000ms. */
  ackTimeoutMs?: number;
  createMessageChannel?: () => MessageChannel;
}

function routingWarning() {
  console.warn('[notifications] Notification click routing could not complete an operation.');
}

function requestSessionOpen(
  client: NotificationWindowClient,
  destination: NotificationDestination,
  options: NotificationRoutingOptions,
): Promise<boolean> {
  if (!client.postMessage) return Promise.resolve(false);
  const timeout = options.ackTimeoutMs;
  const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout)
    ? Math.max(0, Math.min(timeout, 5000)) : 1000;
  return new Promise((resolve) => {
    let channel: MessageChannel | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (channel) {
        for (const port of [channel.port1, channel.port2]) {
          try {
            port.onmessage = null;
            port.onmessageerror = null;
            port.close();
          } catch {
            routingWarning();
          }
        }
      }
      resolve(accepted);
    };
    try {
      channel = options.createMessageChannel ? options.createMessageChannel() : new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        finish(!!data && typeof data === 'object' && !Array.isArray(data)
          && 'type' in data && data.type === OPEN_SESSION_ACK_TYPE
          && 'target' in data && data.target === destination.target);
      };
      channel.port1.onmessageerror = () => finish(false);
      timer = setTimeout(() => finish(false), timeoutMs);
      client.postMessage?.({
        type: OPEN_SESSION_MESSAGE_TYPE,
        sessionId: destination.sessionId,
        target: destination.target,
      }, [channel.port2]);
    } catch {
      routingWarning();
      finish(false);
    }
  });
}

/** Pass notification.data as info and use the returned promise with event.waitUntil. */
export async function routeNotificationClick(
  clients: NotificationClients,
  origin: string,
  info: unknown,
  options: NotificationRoutingOptions = {},
): Promise<void> {
  let appOrigin: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    appOrigin = url.origin;
  } catch {
    routingWarning();
    return;
  }
  const destination = notificationDestination(info);
  const targetUrl = new URL(destination.target, appOrigin).href;
  const sameOrigin = (client: NotificationWindowClient) => {
    try {
      const url = new URL(client.url);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === appOrigin;
    } catch {
      return false;
    }
  };
  const atTarget = (client: NotificationWindowClient | null) => {
    try {
      return client !== null && new URL(client.url).href === targetUrl;
    } catch {
      return false;
    }
  };
  const focus = async (client: NotificationWindowClient, requireTarget = false): Promise<boolean> => {
    if (!sameOrigin(client)) return false;
    if (!client.focus) return client.focused === true && (!requireTarget || atTarget(client));
    try {
      const focused = await client.focus();
      return focused !== null && sameOrigin(focused) && (!requireTarget || atTarget(focused));
    } catch {
      routingWarning();
      return false;
    }
  };
  const windows = async (includeUncontrolled: boolean) => {
    try {
      return await clients.matchAll({ type: 'window', includeUncontrolled });
    } catch {
      routingWarning();
      return [];
    }
  };
  const [all, controlled] = await Promise.all([windows(true), windows(false)]);
  const controlledIds = new Set(controlled.map((client) => client.id).filter((id) => id !== undefined));
  const isControlled = (client: NotificationWindowClient) =>
    controlled.includes(client) || (client.id !== undefined && controlledIds.has(client.id));
  const rank = (client: NotificationWindowClient) =>
    (isControlled(client) ? 4 : 0)
    + (client.focused ? 2 : 0) + (client.visibilityState === 'visible' ? 1 : 0);
  const candidates = [...all, ...controlled.filter((client) =>
    !all.some((other) => other === client || (client.id !== undefined && other.id === client.id)))];
  candidates.sort((a, b) => rank(b) - rank(a));
  for (const client of candidates.filter(sameOrigin)) {
    const focused = await focus(client);
    if (focused && isControlled(client) && destination.sessionId !== null
      && await requestSessionOpen(client, destination, options)) return;
    if (!client.navigate) continue;
    try {
      const navigated = await client.navigate(destination.target);
      // Authentication redirects and stale clients must not count as reaching the session.
      if (navigated && atTarget(navigated) && await focus(navigated, true)) return;
    } catch {
      routingWarning();
    }
  }
  if (!clients.openWindow) return;
  try {
    const opened = await clients.openWindow(destination.target);
    if (opened && atTarget(opened)) await focus(opened, true);
    else routingWarning();
  } catch {
    routingWarning();
  }
}
