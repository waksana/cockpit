// App-icon badge (the number on the home-screen / dock icon) reflecting how many
// sessions are awaiting the user. This is notification bookkeeping, not the
// presentation layer — it never touches the DOM. No-ops where the Badging API is
// unavailable (most desktop browsers, non-installed contexts). On iOS the badge
// only shows for an installed PWA.

interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

function nav(): BadgeNavigator | null {
  if (typeof navigator === 'undefined') return null;
  const n = navigator as unknown as BadgeNavigator;
  return n.setAppBadge ? n : null;
}

export function badgeSupported(): boolean {
  return nav() !== null;
}

// Set the badge to `count` (clears it at 0). Best-effort; failures are swallowed.
export function setBadge(count: number): void {
  const n = nav();
  if (!n) return;
  try {
    if (count > 0) void n.setAppBadge?.(count);
    else void n.clearAppBadge?.();
  } catch { /* best-effort */ }
}
