export const SESSION_PANELS = ['info', 'mcp', 'skills'] as const;
export type SessionPanel = typeof SESSION_PANELS[number];
export const SESSION_PANEL_LABELS: Record<SessionPanel, string> = {
  info: '设置', mcp: 'MCP', skills: 'Skills',
};

export function sessionRoute(pathname: string): { sessionId: string | null; panel: SessionPanel | null } {
  const match = /^\/session\/([^/]+)(?:\/([^/]+))?\/?$/i.exec(pathname);
  if (!match) return { sessionId: null, panel: null };
  try {
    const sessionId = decodeURIComponent(match[1]);
    const panel = SESSION_PANELS.find(value => value === match[2]?.toLowerCase()) ?? null;
    if (match[2] && !panel) return { sessionId: null, panel: null };
    return { sessionId, panel };
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
