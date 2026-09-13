import type { NotificationPayload } from '@cockpit/protocol';

export interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export function reportNotificationFailure(operation: string): void {
  // Never log payloads, session IDs, URLs, or platform error messages.
  console.warn(`[cockpit:notifications] ${operation}`);
}

export function isNotificationCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Kept deliberately small for the worker. The parity test uses the actual wire
// schema, including its bounds, refinement, optional fields and key stripping.
export function parseNotificationPayload(value: unknown): NotificationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value instanceof Date || value instanceof Map || value instanceof Set) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.then === 'function' && typeof input.catch === 'function') return null;
  if (input.type !== 'notification' || !['ready', 'choice', 'test'].includes(input.kind as string)) return null;
  const text = (key: string, min: number, max: number) =>
    typeof input[key] === 'string' && input[key].length >= min && input[key].length <= max;
  if (!text('title', 1, 256) || !text('body', 0, 2048) || !text('tag', 1, 256) || !text('url', 1, 4096)) return null;
  if (input.sessionId !== undefined && !text('sessionId', 1, 256)) return null;
  if (input.kind !== 'test' && input.sessionId === undefined) return null;
  const result: Record<string, unknown> = {
    type: input.type, kind: input.kind, title: input.title, body: input.body, tag: input.tag, url: input.url,
  };
  if ('sessionId' in input) result.sessionId = input.sessionId;
  for (const key of ['attnId', 'inboxRevision', 'unreadCount', 'badge']) {
    if (input[key] !== undefined && !isNotificationCounter(input[key])) return null;
    if (key in input) result[key] = input[key];
  }
  return result as NotificationPayload;
}

interface AttentionOrder {
  attnId?: number;
  inboxRevision?: number;
}

export interface SessionAttentionObservation {
  sessionId: string;
  attnId?: number;
  seenId?: number;
  attention?: 'ready' | 'choice' | null;
}

export interface NotificationProjectionOptions {
  removedSessions?: readonly string[];
  removalRevision?: number;
  completeSnapshot?: boolean;
}

interface NotificationOrderingScope extends NotificationProjectionOptions {
  sessionId?: string;
  observedSessions?: readonly SessionAttentionObservation[];
  projectionRevision?: number;
}

export interface NotificationOrder {
  inboxRevision?: number;
  pageRevision?: number;
  snapshotRevision?: number;
  attention?: AttentionOrder;
  session?: Pick<SessionAttentionObservation, 'attnId' | 'seenId'> & {
    retiredAttnId?: number;
    removedRevision?: number;
    presentRevision?: number;
  };
}

interface NotificationOrderingWork {
  next: NotificationOrder;
  apply: () => Promise<void>;
}

export interface NotificationOrderingStore {
  run(tag: string | undefined, prepare: (previous: NotificationOrder) => NotificationOrderingWork,
    scope?: NotificationOrderingScope): Promise<void>;
}

const DATABASE = 'cockpit-notification-transport';
const STORE = 'ordering';

function openOrderingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('Notification ordering unavailable'));
    };
    const timeout = setTimeout(fail, 1500);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      clearTimeout(timeout);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

// The native lock covers BOTH the committed revision and the awaited platform
// effects across pages/workers. An IDB transaction alone releases its lock on
// abort, even while a badge call is still in flight. No effect starts before
// commit. Only high-water marks are stored, never counts, inbox items or work.
export const indexedDbNotificationOrdering: NotificationOrderingStore = {
  async run(tag, prepare, scope = {}) {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
      throw new Error('Notification ordering lock unavailable');
    }
    await navigator.locks.request(DATABASE, async () => {
      const db = await openOrderingDatabase();
      let work: NotificationOrderingWork;
      try {
        work = await new Promise<NotificationOrderingWork>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          const revision = store.get('inboxRevision');
          const pageRevision = store.get('pageRevision');
          const snapshotRevision = store.get('snapshotRevision');
          const attention = tag === undefined ? undefined : store.get(`tag:${tag}`);
          const session = scope.sessionId === undefined ? undefined : store.get(`session:${scope.sessionId}`);
          const removed = new Set(scope.removedSessions);
          const observations = [...(scope.observedSessions ?? []), ...[...removed].map((sessionId) => ({ sessionId }))]
            .map((observed: SessionAttentionObservation) => ({
              observed, request: store.get(`session:${observed.sessionId}`),
            }));
          let pending = 3 + Number(!!attention) + Number(!!session) + observations.length;
          let prepared: NotificationOrderingWork;
          const ready = () => {
            if (--pending !== 0) return;
            try {
              prepared = prepare({
                inboxRevision: revision.result, pageRevision: pageRevision.result, attention: attention?.result,
                ...(snapshotRevision.result !== undefined ? { snapshotRevision: snapshotRevision.result } : {}),
                ...(session ? { session: session.result } : {}),
              });
              if (prepared.next.inboxRevision !== undefined) store.put(prepared.next.inboxRevision, 'inboxRevision');
              if (prepared.next.pageRevision !== undefined) store.put(prepared.next.pageRevision, 'pageRevision');
              if (tag !== undefined && prepared.next.attention !== undefined) store.put(prepared.next.attention, `tag:${tag}`);
              if (scope.completeSnapshot && scope.projectionRevision !== undefined) {
                store.put(latest(snapshotRevision.result, scope.projectionRevision), 'snapshotRevision');
              }
              for (const { observed, request } of observations) {
                store.put({
                  attnId: latest(request.result?.attnId, observed.attnId),
                  seenId: latest(request.result?.seenId, observed.seenId),
                  presentRevision: latest(request.result?.presentRevision,
                    removed.has(observed.sessionId) ? undefined : scope.projectionRevision),
                  ...(observed.attention === null || request.result?.retiredAttnId !== undefined
                    ? { retiredAttnId: latest(request.result?.retiredAttnId,
                      observed.attention === null ? observed.attnId : undefined) } : {}),
                  ...(removed.has(observed.sessionId) || request.result?.removedRevision !== undefined
                    ? { removedRevision: latest(request.result?.removedRevision,
                      removed.has(observed.sessionId) ? scope.removalRevision : undefined) } : {}),
                }, `session:${observed.sessionId}`);
              }
            } catch {
              tx.abort();
            }
          };
          revision.onsuccess = ready;
          pageRevision.onsuccess = ready;
          snapshotRevision.onsuccess = ready;
          if (attention) attention.onsuccess = ready;
          if (session) session.onsuccess = ready;
          for (const { request } of observations) request.onsuccess = ready;
          tx.oncomplete = () => resolve(prepared);
          tx.onabort = () => reject(new Error('Notification ordering transaction aborted'));
          tx.onerror = () => { /* Request errors abort the transaction; no native effects have started. */ };
        });
      } finally {
        db.close();
      }
      try { await work.apply(); }
      catch { throw new Error('Notification transport failed'); }
    });
  },
};

function latest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function badgeIsCurrent(previous: NotificationOrder, revision: number | undefined): boolean {
  return previous.inboxRevision === undefined || (revision !== undefined && revision >= previous.inboxRevision);
}

function duplicateOrOlder(incoming: AttentionOrder, previous: AttentionOrder): boolean {
  return (previous.attnId !== undefined && (incoming.attnId === undefined || incoming.attnId <= previous.attnId))
    || (previous.inboxRevision !== undefined
      && (incoming.inboxRevision === undefined || incoming.inboxRevision <= previous.inboxRevision));
}

async function writeBadge(count: number, nav: BadgeNavigator): Promise<void> {
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else if (nav.clearAppBadge) await nav.clearAppBadge();
    else await nav.setAppBadge?.(0);
  } catch {
    reportNotificationFailure('Badge update failed');
  }
}

export async function updateNotificationBadge(
  count: number,
  inboxRevision: number | undefined,
  nav: BadgeNavigator,
  ordering: NotificationOrderingStore = indexedDbNotificationOrdering,
  observedSessions: readonly SessionAttentionObservation[] = [],
  projection: NotificationProjectionOptions = {},
): Promise<void> {
  if (!isNotificationCounter(count) || (inboxRevision !== undefined && !isNotificationCounter(inboxRevision))
    || observedSessions.some((s) => !s.sessionId
      || (s.attnId !== undefined && !isNotificationCounter(s.attnId))
      || (s.seenId !== undefined && !isNotificationCounter(s.seenId)))) {
    reportNotificationFailure('Invalid badge metadata');
    return;
  }
  try {
    await ordering.run(undefined, (previous) => ({
      next: {
        ...previous,
        inboxRevision: latest(previous.inboxRevision, inboxRevision),
        pageRevision: latest(previous.pageRevision, inboxRevision),
      },
      apply: async () => {
        if (badgeIsCurrent(previous, inboxRevision)) await writeBadge(count, nav);
      },
    }), {
      ...projection,
      observedSessions,
      projectionRevision: inboxRevision,
      removalRevision: projection.removalRevision ?? inboxRevision,
    });
  } catch {
    // Fail closed: without the shared high-water mark an old page could undo a
    // newer push. The next authoritative foreground projection retries.
    reportNotificationFailure('Badge ordering unavailable');
  }
}

type NotificationRegistration = Pick<ServiceWorkerRegistration, 'showNotification' | 'getNotifications'>;

async function show(
  payload: NotificationPayload, registration: NotificationRegistration, silent: boolean,
): Promise<void> {
  let display = payload;
  if (silent) {
    try {
      for (const notification of await registration.getNotifications({ tag: payload.tag })) {
        const existing = parseNotificationPayload({
          ...notification.data,
          title: notification.title,
          body: notification.body,
          tag: notification.tag,
        });
        if (existing && existing.tag === payload.tag && duplicateOrOlder(display, existing)) {
          const sameAttention = existing.sessionId === display.sessionId && existing.kind === display.kind
            && existing.attnId !== undefined && existing.attnId === display.attnId
            && (existing.inboxRevision === undefined || (display.inboxRevision !== undefined
              && display.inboxRevision >= existing.inboxRevision));
          // A current, equal-attention page can enrich an empty push body.
          display = sameAttention && !existing.body && display.body
            ? { ...existing, body: display.body, inboxRevision: display.inboxRevision ?? existing.inboxRevision }
            : existing;
        }
      }
    } catch {
      reportNotificationFailure('Notification replacement lookup failed');
    }
  }
  const choice = display.kind === 'choice';
  await registration.showNotification(display.title, {
    body: display.body,
    tag: display.tag,
    icon: '/icon-refined-r4-192.png',
    badge: '/badge-refined-r4-96.png',
    requireInteraction: choice && !silent,
    renotify: !silent,
    silent,
    ...(!silent ? { vibrate: choice ? [60, 40, 60, 40, 60] : [80] } : {}),
    data: display,
  } as NotificationOptions);
}

async function showFallback(payload: NotificationPayload, registration: NotificationRegistration): Promise<void> {
  let attempted = false;
  const display = async () => {
    attempted = true;
    await show(payload, registration, true);
  };
  if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
    try {
      // Even an aborted write must not race a newer banner between lookup and
      // replacement. This path only displays: it cannot change ordering/badges.
      await navigator.locks.request(DATABASE, display);
      return;
    } catch {
      if (attempted) throw new Error('Notification display failed');
    }
  }
  await display();
}

const invalidPayload: NotificationPayload = {
  type: 'notification', kind: 'test', title: 'cockpit',
  body: '收到通知，请打开应用查看。', tag: 'cockpit-invalid-push', url: '/',
};

// Also usable by a page with an actual NotificationPayload and SW registration;
// both transports then share tag/attention ordering. No visibility gate here.
export async function showPushNotification(
  value: unknown,
  registration: NotificationRegistration,
  nav: BadgeNavigator,
  ordering: NotificationOrderingStore = indexedDbNotificationOrdering,
): Promise<void> {
  const payload = parseNotificationPayload(value);
  if (!payload) reportNotificationFailure('Invalid push payload');
  let shown = false;
  try {
    if (!payload || payload.kind === 'test') {
      // Tests are display-only, even if a sender includes badge/revision fields.
      await show(payload ?? invalidPayload, registration, !payload);
      return;
    }
    await ordering.run(payload.tag, (previous) => {
      // Page revisions fence badge writes, not alerts. Only session waterlines
      // can prove this attention was seen or superseded by a newer attention.
      // A complete native snapshot also fences sessions absent on a cold page.
      // Presence is not a seen fact and a newer snapshot/restoration can advance it.
      const absentAtSnapshot = previous.snapshotRevision !== undefined
        && (previous.session?.presentRevision === undefined || previous.session.presentRevision < previous.snapshotRevision)
        && (payload.inboxRevision === undefined || payload.inboxRevision <= previous.snapshotRevision);
      const obsoleteSession = absentAtSnapshot || (previous.session?.removedRevision !== undefined
        && (payload.inboxRevision === undefined || payload.inboxRevision <= previous.session.removedRevision));
      const obsoleteAttention = obsoleteSession || (payload.attnId === undefined
        ? (previous.session?.attnId ?? 0) > 0 || (previous.session?.seenId ?? 0) > 0
          || (previous.session?.retiredAttnId ?? 0) > 0
        : (previous.session?.seenId !== undefined && payload.attnId <= previous.session.seenId)
          || (previous.session?.retiredAttnId !== undefined && payload.attnId <= previous.session.retiredAttnId)
          || (previous.session?.attnId !== undefined && payload.attnId < previous.session.attnId));
      const currentBadge = !obsoleteAttention && badgeIsCurrent(previous, payload.inboxRevision)
        && (previous.pageRevision === undefined
          || (payload.inboxRevision !== undefined && payload.inboxRevision > previous.pageRevision));
      const silent = obsoleteAttention || duplicateOrOlder(payload, previous.attention ?? {});
      return {
        next: {
          ...previous,
          inboxRevision: latest(previous.inboxRevision, payload.inboxRevision),
          attention: {
            attnId: latest(previous.attention?.attnId, payload.attnId),
            inboxRevision: latest(previous.attention?.inboxRevision, payload.inboxRevision),
          },
        },
        apply: async () => {
          const count = payload.unreadCount ?? payload.badge;
          if (currentBadge && count !== undefined) await writeBadge(count, nav);
          await show(payload, registration, silent);
          shown = true;
        },
      };
    }, { sessionId: payload.sessionId });
  } catch {
    reportNotificationFailure('Push transport failed');
    if (!shown) {
      try { await showFallback(payload ?? invalidPayload, registration); }
      catch { reportNotificationFailure('Notification display failed'); }
    }
  }
}
