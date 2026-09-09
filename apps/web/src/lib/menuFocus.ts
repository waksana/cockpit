// undefined preserves focus; null keeps keyboard focus on an empty menu.
export function menuFocusTarget<T>(
  initialized: boolean,
  previous: T | null,
  enabledItems: readonly T[],
): T | null | undefined {
  if (!initialized || (previous !== null && !enabledItems.includes(previous))) {
    return enabledItems[0] ?? null;
  }
  return undefined;
}
