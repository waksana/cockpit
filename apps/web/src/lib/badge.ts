// App-icon badge (the number on the home-screen / dock icon) reflecting how many
// sessions are awaiting the user. This is notification bookkeeping, not the
// presentation layer — it never touches the DOM. No-ops where the Badging API is
// unavailable (most desktop browsers, non-installed contexts). On iOS the badge
// only shows for an installed PWA.

import { updateNotificationBadge, type BadgeNavigator, type SessionAttentionObservation, type NotificationProjectionOptions } from './notificationTransport';

function nav(): BadgeNavigator | null {
  if (typeof navigator === 'undefined') return null;
  const n = navigator as unknown as BadgeNavigator;
  return n.setAppBadge || (typeof indexedDB !== 'undefined' && typeof navigator.locks?.request === 'function') ? n : null;
}

export function badgeSupported(): boolean {
  return !!nav()?.setAppBadge;
}

// Invoke after every authoritative projection/reconnect, even at the same count.
// A missing revision is legacy and cannot overwrite a known versioned count.
export async function setBadge(
  count: number, inboxRevision?: number, observedSessions: readonly SessionAttentionObservation[] = [],
  projection: NotificationProjectionOptions = {},
): Promise<void> {
  const navigator = nav();
  if (navigator) await updateNotificationBadge(count, inboxRevision, navigator, undefined, observedSessions, projection);
}
